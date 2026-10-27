// `ludo toolbox sprite metrics|collide|compare`: what an agent needs to wire a
// sheet in (pivot, ground, body size, colliders, one pixels-per-unit for a
// character), measured from its pixels.
//
// These tools only measure. They never change a sheet: what they write is
// derived data (numbers, engine snippets, a picture to check them by eye).
// The geometry and the measures are pure functions below; the tools at the
// end read the sheet, call them and print.
//
// Coordinates are pixels from the frame's top-left corner, x right, y down,
// with pixel (x, y) covering x..x+1 and y..y+1, so a pivot under the lowest
// row of pixels sits at that row + 1. A sheet trimmed by `ludo toolbox image
// trim` is measured in its untrimmed frames, the size engines see it at.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { findAsset, LOG_NAME, readAssets, type AssetEntry } from "../assets.js";
import { CliError, EXIT } from "../errors.js";
import { printJson, type Ctx } from "../generate.js";
import type { Image } from "../tty/png.js";
import type { Grid } from "../tty/preview.js";
import { characterOf } from "./asset.js";
import { canvas, checkerboard, cross as drawCross, dot, drawImage, fillRect, fitText, line, scaled, strokeRect, text, textHeight, textWidth, type Rgba } from "./draw.js";
import { backgroundOf } from "./grid.js";
import { baseOf, freeName, loadImageFile, shown, writePng, type Loaded } from "./io.js";
import { pad } from "./pixels.js";
import { crop, sliceSheet } from "./sheet.js";
import { resolveGrid } from "./sprite.js";
import { gridFlag, positiveInt, positiveNumber, textFlag } from "./flags.js";
import { hint, shellArg, TOOLS, type ToolCall, type ToolFlag } from "./registry.js";

export type Point = [number, number];

// ---- Masks ----

// Which pixels are solid: alpha at or above the threshold (the `sprite gif`
// rule), or on a sheet with no transparency, pixels unlike its border colour
// (backgroundOf, as grid detection sees them).
export function solidMasks(frames: Image[], sheet: Image, threshold: number): Uint8Array[] {
  let clear = 0;
  for (let i = 3; i < sheet.rgba.length; i += 4) if (sheet.rgba[i] < 16) clear++;
  const transparent = clear > (sheet.width * sheet.height) / 200;
  const bg = backgroundOf(sheet);
  return frames.map(f => {
    const m = new Uint8Array(f.width * f.height);
    for (let p = 0; p < m.length; p++) m[p] = transparent ? (f.rgba[p * 4 + 3] >= threshold ? 1 : 0) : bg.isInk(f.rgba, p * 4) ? 1 : 0;
    return m;
  });
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FrameMeasure {
  area: number; // solid pixels
  bounds: Box | null;
  ground_row: number | null; // the lowest solid row
  centre_of_mass: Point | null;
}

export function measureFrame(m: Uint8Array, w: number, h: number): FrameMeasure {
  let [x0, y0, x1, y1, n, sx, sy] = [w, h, -1, -1, 0, 0, 0];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!m[y * w + x]) continue;
      n++;
      sx += x + 0.5;
      sy += y + 0.5;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      y1 = y;
    }
  }
  if (!n) return { area: 0, bounds: null, ground_row: null, centre_of_mass: null };
  return { area: n, bounds: { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }, ground_row: y1, centre_of_mass: [r2(sx / n), r2(sy / n)] };
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const r4 = (v: number) => Math.round(v * 10000) / 10000;
const median = (vs: number[]) => {
  const s = [...vs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};

export function unionBox(boxes: (Box | null)[]): Box | null {
  const bs = boxes.filter((b): b is Box => !!b);
  if (!bs.length) return null;
  const x0 = Math.min(...bs.map(b => b.x));
  const y0 = Math.min(...bs.map(b => b.y));
  return { x: x0, y: y0, w: Math.max(...bs.map(b => b.x + b.w)) - x0, h: Math.max(...bs.map(b => b.y + b.h)) - y0 };
}

// ---- Erosion, dilation, opening ----

// Borgefors' 3-4 chamfer distance from each pixel that is `v` to the nearest
// one that is not; past the frame's edge counts as not `v` when `edge` is
// false, and as nothing at all when it is true.
function chamfer(m: Uint8Array, w: number, h: number, v: 0 | 1, edge: boolean): Int32Array {
  const d = new Int32Array(w * h);
  for (let p = 0; p < d.length; p++) d[p] = m[p] === v ? 1 << 29 : 0;
  const out = edge ? 1 << 29 : 0;
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? out : d[y * w + x]);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (d[p]) d[p] = Math.min(d[p], at(x - 1, y) + 3, at(x, y - 1) + 3, at(x - 1, y - 1) + 4, at(x + 1, y - 1) + 4);
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const p = y * w + x;
      if (d[p]) d[p] = Math.min(d[p], at(x + 1, y) + 3, at(x, y + 1) + 3, at(x + 1, y + 1) + 4, at(x - 1, y + 1) + 4);
    }
  }
  return d;
}

// Erosion by `n` pixels: kept when the nearest empty pixel (past the frame's
// edge counts as empty) is over n away.
export function erode(m: Uint8Array, w: number, h: number, n: number): Uint8Array {
  if (n <= 0) return m;
  return Uint8Array.from(chamfer(m, w, h, 1, false), v => (v > 3 * n ? 1 : 0));
}

// Dilation by `n` pixels: solid when a solid pixel is n or less away.
export function dilate(m: Uint8Array, w: number, h: number, n: number): Uint8Array {
  if (n <= 0) return m;
  return Uint8Array.from(chamfer(m, w, h, 0, true), v => (v > 3 * n ? 0 : 1));
}

// Opening: erode, then dilate back. What is thinner than about 2n + 1 pixels
// goes; what is thicker keeps its shape, corners a little rounded.
export const opening = (m: Uint8Array, w: number, h: number, n: number) => (n <= 0 ? m : dilate(erode(m, w, h, n), w, h, n));

// ---- The body: the art without what sticks out thinly ----

// The opening's radius: 35% of the radius of the thickest part of the art
// (the largest disc that fits in it, the torso or the head as a rule),
// median over frames. So what is under about a third of the body's
// thickness across goes (a blade, a spear, a staff, a slash trail's edge,
// a tail tip), and limbs, a plume or a shield arm, thicker than that, stay.
// Under 34 px tall it is 0: in small pixel art a limb is a pixel or two.
export const BODY_OPENING = 0.35;
const SMALL_ART = 34;

export function bodyRadius(masks: Uint8Array[], w: number, h: number, artHeight: number): number {
  if (artHeight < SMALL_ART) return 0;
  const radii = masks.map(m => chamfer(m, w, h, 1, false).reduce((a, v) => Math.max(a, v), 0) / 3).filter(v => v > 0);
  return Math.floor(BODY_OPENING * median(radii));
}

// 8-connected pieces of a mask (pixel art's diagonal steps hold together):
// each pixel's piece, -1 for none.
function pieces(m: Uint8Array, w: number, h: number): { labels: Int32Array; count: number } {
  const labels = new Int32Array(w * h).fill(-1);
  const stack: number[] = [];
  let count = 0;
  for (let s = 0; s < m.length; s++) {
    if (!m[s] || labels[s] >= 0) continue;
    labels[s] = count;
    stack.push(s);
    while (stack.length) {
      const p = stack.pop()!;
      const [x, y] = [p % w, (p / w) | 0];
      for (let ny = Math.max(0, y - 1); ny <= Math.min(h - 1, y + 1); ny++) {
        for (let nx = Math.max(0, x - 1); nx <= Math.min(w - 1, x + 1); nx++) {
          const q = ny * w + nx;
          if (m[q] && labels[q] < 0) (labels[q] = count), stack.push(q);
        }
      }
    }
    count++;
  }
  return { labels, count };
}

// The body of one frame: the art opened by `r` (what is thinner than about
// 2r + 1 pixels goes), within the one piece of the art that most of it is
// in, to its bounds. So a sword or a spear held out, and a staff held
// beside the body, are left out, and so is whatever does not touch the
// character (a pole behind it, a spark); a plume, a shield arm or a head on
// a thin neck are kept. Its bottom is the art's own lowest row (feet are
// never a protrusion), but no lower than `floor` when given (a blade
// hanging below the feet). Art all thinner than the opening is its own body.
export function bodyBox(m: Uint8Array, w: number, h: number, r: number, floor?: number): Box | null {
  const art = measureFrame(m, w, h).bounds;
  if (!art) return null;
  const { labels, count } = pieces(m, w, h);
  const opened = opening(m, w, h, r);
  const kept = new Int32Array(count);
  for (let p = 0; p < m.length; p++) if (opened[p] && labels[p] >= 0) kept[labels[p]]++;
  // The piece most of the opened art is in; with nothing left open, the largest.
  const left = kept.some(v => v > 0);
  if (!left) for (let p = 0; p < m.length; p++) if (labels[p] >= 0) kept[labels[p]]++;
  const body = kept.indexOf(Math.max(...kept));
  let [x0, y0, x1, y1] = [w, h, -1, -1];
  for (let p = 0; p < m.length; p++) {
    if (labels[p] !== body || (left && !opened[p])) continue;
    const [x, y] = [p % w, (p / w) | 0];
    (x0 = Math.min(x0, x)), (x1 = Math.max(x1, x)), (y0 = Math.min(y0, y)), (y1 = Math.max(y1, y));
  }
  const bottom = Math.max(y0, Math.min(art.y + art.h - 1, floor ?? Infinity));
  return { x: x0, y: y0, w: x1 + 1 - x0, h: bottom + 1 - y0 };
}

// ---- Sheet metrics ----

export type PivotKind = "feet" | "mass" | "flag";
// `asked`: --pivot feet was given, so a sheet that is not a character
// still gets its feet, from the frames that touch its lowest row.
export type PivotChoice = { kind: "feet"; asked?: boolean } | { kind: "mass" } | { kind: "flag"; at: Point };

export interface SheetMetrics {
  frame_width: number;
  frame_height: number;
  frames: (FrameMeasure & { body: Box | null })[];
  union: Box;
  ground: { row: number; frames_on_it: number; share: number; above_bottom: number };
  art: { width: number; height: number }; // median frame bounds
  body: { width: number; height: number }; // median body box
  character: boolean; // stands on a ground line
  pivot: { x: number; y: number; kind: PivotKind; why: string };
  drift: { x: number; y: number; per_frame: Point; sway: Point; verdict: string };
}

// A character stands on a ground line: at least half its frames bottom out
// on the same row (within 2% of its height), in the lower third of the frame.
// Effects and projectiles do not, so they pivot on their centre of mass.
const GROUNDED_SHARE = 0.5;
const LOW_IN_FRAME = 2 / 3;

export function sheetMetrics(masks: Uint8Array[], fw: number, fh: number, choice: PivotChoice = { kind: "feet" }): SheetMetrics | undefined {
  const measures = masks.map(m => measureFrame(m, fw, fh));
  const solid = measures.filter(f => f.bounds);
  const union = unionBox(measures.map(f => f.bounds));
  if (!union || !solid.length) return undefined;
  const art = { width: median(solid.map(f => f.bounds!.w)), height: median(solid.map(f => f.bounds!.h)) };

  // The ground: the row most frames bottom out on, within a tolerance; on a
  // tie, the lower one.
  const tol = Math.max(1, Math.round(0.02 * art.height));
  const rows = solid.map(f => f.ground_row!);
  let ground = { row: rows[0], frames_on_it: 0 };
  for (const g of new Set(rows)) {
    const on = rows.filter(r => Math.abs(r - g) <= tol).length;
    if (on > ground.frames_on_it || (on === ground.frames_on_it && g > ground.row)) ground = { row: g, frames_on_it: on };
  }
  // The row is the median of the frames on it: a leg pushing off below the
  // stance for a frame or two does not pull the line down.
  ground.row = Math.round(median(rows.filter(r => Math.abs(r - ground.row) <= tol)));
  const share = ground.frames_on_it / solid.length;
  const character = share >= GROUNDED_SHARE && ground.row + 1 >= fh * LOW_IN_FRAME;

  const r = bodyRadius(masks, fw, fh, art.height);
  const frames = measures.map((f, i) => ({ ...f, body: f.bounds ? bodyBox(masks[i], fw, fh, r, character ? ground.row + tol : undefined) : null }));
  const bodies = frames.map(f => f.body).filter((b): b is Box => !!b);
  const body = { width: median(bodies.map(b => b.w)), height: median(bodies.map(b => b.h)) };

  const coms = solid.map(f => f.centre_of_mass!);
  const meanCom: Point = [coms.reduce((a, c) => a + c[0], 0) / coms.length, coms.reduce((a, c) => a + c[1], 0) / coms.length];
  let pivot: SheetMetrics["pivot"];
  const pct = Math.round(share * 100);
  // Asked for the feet of a sheet that is not a character (a jump spends
  // most frames in the air): the frames that reach its lowest row, within
  // the tolerance, stand on the ground.
  const lowest = Math.max(...rows);
  const landed = rows.filter(r => lowest - r <= tol);
  const landedRow = Math.round(median(landed));
  const why = share < GROUNDED_SHARE ? `no ground line: only ${pct}% of frames bottom out on one row` : `its lowest row (${ground.row}) is in the top two thirds of the frame, so it does not stand on it`;
  if (choice.kind === "flag") pivot = { x: choice.at[0], y: choice.at[1], kind: "flag", why: "given with --pivot" };
  else if (choice.kind === "feet" && character) {
    pivot = { x: feetCentre(masks, frames, fw, ground.row, tol), y: ground.row + 1, kind: "feet", why: `${pct}% of frames stand on row ${ground.row}: on the ground line, between the feet (the middle of what touches the ground under the body, median over those frames)` };
  } else if (choice.kind === "feet" && choice.asked && landedRow + 1 >= fh * LOW_IN_FRAME) {
    pivot = { x: feetCentre(masks, frames, fw, landedRow, tol), y: landedRow + 1, kind: "feet", why: `${why}, so the feet are taken from the ${landed.length} of ${solid.length} frames that reach its lowest row (${landedRow}): between the feet there, median over those frames` };
  } else {
    const asked = choice.kind === "feet" && choice.asked ? `--pivot feet asked, but no frame touches a ground line in the lower third of the frame (the lowest row is ${lowest}), so there are no feet to pivot on: ` : "";
    pivot = { x: Math.round(meanCom[0]), y: Math.round(meanCom[1]), kind: "mass", why: `${asked}${choice.kind === "mass" ? "asked with --pivot mass" : why}: the centre of mass, averaged over frames${asked ? "; pass --pivot X,Y with the feet's point in frame pixels (an idle sheet's feet pivot, from `sprite metrics`, if the frames line up)" : ""}` };
  }

  // Drift: the least-squares line through each frame's centre of mass. Its
  // rise over the clip is how far the art travels; what is left, the sway.
  const n = frames.length;
  const idx = frames.map((f, i) => (f.centre_of_mass ? i : -1)).filter(i => i >= 0);
  const fit = (k: 0 | 1) => {
    if (idx.length < 2) return { slope: 0, sway: 0 };
    const mi = idx.reduce((a, b) => a + b, 0) / idx.length;
    const mv = idx.reduce((a, i) => a + frames[i].centre_of_mass![k], 0) / idx.length;
    let [num, den] = [0, 0];
    for (const i of idx) (num += (i - mi) * (frames[i].centre_of_mass![k] - mv)), (den += (i - mi) ** 2);
    const slope = den ? num / den : 0;
    const left = idx.map(i => frames[i].centre_of_mass![k] - (mv + slope * (i - mi)));
    return { slope, sway: Math.max(...left) - Math.min(...left) };
  };
  const [fx, fy] = [fit(0), fit(1)];
  const [dx, dy] = [fx.slope * (n - 1), fy.slope * (n - 1)];
  // Travel under a tenth of the art's size is sway, not travel.
  const moves = [Math.abs(dx) >= 0.1 * art.width ? `${dx > 0 ? "right" : "left"} ${Math.round(Math.abs(dx))} px` : "", Math.abs(dy) >= 0.1 * art.height ? `${dy > 0 ? "down" : "up"} ${Math.round(Math.abs(dy))} px` : ""].filter(Boolean);
  const verdict = moves.length ? `moves ${moves.join(" and ")} over the clip: the motion is in the art (root motion), not only in place` : "in place";

  return {
    frame_width: fw,
    frame_height: fh,
    frames,
    union,
    ground: { row: ground.row, frames_on_it: ground.frames_on_it, share: r2(share), above_bottom: fh - (ground.row + 1) },
    art,
    body,
    character,
    pivot,
    drift: { x: r2(dx), y: r2(dy), per_frame: [r2(fx.slope), r2(fy.slope)], sway: [r2(fx.sway), r2(fy.sway)], verdict }
  };
}

// Between the feet: in each frame standing on the ground line, the middle of
// the solid pixels within the body's columns and `tol` rows of its lowest
// one (from the back of the rear foot to the toe of the front one); the
// median over those frames. The centre of mass leans with the body (a
// lunge, a crouch, a big head) and the union's centre follows a sword; a
// spear or a staff planted beside the feet is outside the body's columns.
// The feet are what stands: a pivot between them keeps them in place when
// the sprite is flipped.
function feetCentre(masks: Uint8Array[], frames: SheetMetrics["frames"], fw: number, groundRow: number, tol: number): number {
  const mids: number[] = [];
  frames.forEach((f, i) => {
    if (f.ground_row === null || !f.body || Math.abs(f.ground_row - groundRow) > tol) return;
    const [x0, x1] = [f.body.x, f.body.x + f.body.w];
    let [lo, hi, low] = [fw, -1, -1];
    for (let y = f.ground_row; y >= 0 && low < 0; y--) for (let x = x0; x < x1; x++) if (masks[i][y * fw + x]) low = y;
    for (let y = Math.max(0, low - tol); y <= low; y++) for (let x = x0; x < x1; x++) if (masks[i][y * fw + x]) (lo = Math.min(lo, x)), (hi = Math.max(hi, x));
    if (hi >= 0) mids.push((lo + hi + 1) / 2);
  });
  return Math.round(median(mids));
}

export const UNITY_PPU = 100; // Unity's default, what `sprite export --engine unity` writes without --ppu

export function engineValues(s: SheetMetrics, trim?: Loaded["trim"]) {
  const { frame_width: fw, frame_height: fh, pivot: p } = s;
  return {
    godot: {
      // Sprite2D / AnimatedSprite2D: with `centered` on (Godot's default),
      // `offset` moves the art from the node's origin; this puts the pivot there.
      centered: true,
      offset: [fw / 2 - p.x, fh / 2 - p.y] as Point,
      uncentered: { centered: false, offset: [-p.x, -p.y] as Point }
    },
    unity: { pivot: unityPivot([p.x, p.y], fw, fh, trim), ...(trim ? { pivot_of: "each sprite's trimmed rect" } : {}) },
    phaser: { origin: [r4(p.x / fw), r4(p.y / fh)] as Point }
  };
}

// Unity pivots each sprite in its own rect, from its bottom-left: for a
// trimmed sheet, the trimmed rect (as `sprite export --engine unity` slices it).
export const unityPivot = (p: Point, fw: number, fh: number, trim?: Loaded["trim"]): Point => (trim ? [r4((p[0] - trim.x) / trim.w), r4((trim.y + trim.h - p[1]) / trim.h)] : [r4(p[0] / fw), r4(1 - p[1] / fh)]);

// The Y-sort origin for top-down games: the point whose height decides what
// draws in front. A character's is its feet, where it meets the floor; for
// anything else, the bottom of its art under its pivot.
export function sortPoint(s: SheetMetrics) {
  const { pivot: p } = s;
  const y = s.character && p.kind === "feet" ? p.y : s.union.y + s.union.h;
  return {
    x: p.x,
    y,
    from_pivot: [0, y - p.y] as Point,
    // Godot's y_sort orders by the node's origin; Unity's Sprite Sort Point: Pivot by the sprite's pivot.
    ...(y === p.y ? {} : { godot_offset: [s.frame_width / 2 - p.x, s.frame_height / 2 - y] as Point, unity_pivot: [r4(p.x / s.frame_width), r4(1 - y / s.frame_height)] as Point }),
    why:
      y === p.y
        ? "the feet, which is the pivot: Godot's y_sort uses the node's origin, Unity's Sprite Sort Point: Pivot the sprite's pivot"
        : "the bottom of the art, under the pivot: to Y-sort by it, put the node's origin there (godot_offset, with centered on) or the sprite's pivot (unity_pivot, with Sprite Sort Point: Pivot)"
  };
}

// Where the feet are against the frame's bottom edge, said plainly.
export const feetText = (s: SheetMetrics) =>
  !s.character ? "it does not stand on a ground line" : s.ground.above_bottom === 0 ? "the feet are already at the frame's bottom edge" : `the feet are ${s.ground.above_bottom} px above the frame's bottom edge`;

// ---- Shapes from a mask ----

// 4-connected components, largest first.
export function components(m: Uint8Array, w: number, h: number): { labels: Int32Array; areas: number[] } {
  const labels = new Int32Array(w * h).fill(-1);
  const areas: number[] = [];
  const stack: number[] = [];
  for (let s = 0; s < m.length; s++) {
    if (!m[s] || labels[s] >= 0) continue;
    const k = areas.length;
    let area = 0;
    labels[s] = k;
    stack.push(s);
    while (stack.length) {
      const p = stack.pop()!;
      area++;
      const [x, y] = [p % w, (p / w) | 0];
      const near = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1];
      for (const q of near) if (q >= 0 && m[q] && labels[q] < 0) (labels[q] = k), stack.push(q);
    }
    areas.push(area);
  }
  return { labels, areas };
}

// The outer boundary of one component along pixel edges, its corners in
// order, clockwise on screen (y down). Holes are left out: a collider fills
// them. At a corner where two pixels touch only diagonally the walk turns
// away, the 4-connected reading the components use.
export function traceOutline(labels: Int32Array, w: number, h: number, k: number): Point[] {
  const start = labels.indexOf(k);
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && labels[y * w + x] === k;
  const [sx, sy] = [start % w, (start / w) | 0];
  let [x, y, dx, dy] = [sx, sy, 1, 0];
  const out: Point[] = [];
  for (let guard = 0; guard < 4 * (w + 1) * (h + 1); guard++) {
    x += dx;
    y += dy;
    // The two pixels ahead, either side of the next edge: right is (-dy, dx).
    const [rx, ry] = [-dy, dx];
    const aheadRight = inside(Math.floor((2 * x + dx + rx) / 2), Math.floor((2 * y + dy + ry) / 2));
    const aheadLeft = inside(Math.floor((2 * x + dx - rx) / 2), Math.floor((2 * y + dy - ry) / 2));
    const [nx, ny] = !aheadRight ? [rx, ry] : aheadLeft ? [dy, -dx] : [dx, dy];
    if (nx !== dx || ny !== dy) out.push([x, y]);
    [dx, dy] = [nx, ny];
    if (x === sx && y === sy && dx === 1 && dy === 0) break;
  }
  return out;
}

const distToSegment = (p: Point, a: Point, b: Point) => {
  const [vx, vy] = [b[0] - a[0], b[1] - a[1]];
  const len = vx * vx + vy * vy;
  const t = len ? Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len)) : 0;
  return Math.hypot(p[0] - a[0] - t * vx, p[1] - a[1] - t * vy);
};

// Douglas-Peucker (1973) on a closed outline: split at the corner farthest
// from the first, simplify both halves, keep every corner further than
// `tolerance` pixels from the simplified line.
export function simplifyClosed(pts: Point[], tolerance: number): Point[] {
  if (pts.length <= 4) return pts;
  let far = 0;
  pts.forEach((p, i) => {
    if (Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1]) > Math.hypot(pts[far][0] - pts[0][0], pts[far][1] - pts[0][1])) far = i;
  });
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[far] = 1;
  const ring = [...pts, pts[0]];
  const stack: [number, number][] = [
    [0, far],
    [far, pts.length]
  ];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let [best, at] = [-1, -1];
    for (let i = a + 1; i < b; i++) {
      const d = distToSegment(ring[i], ring[a], ring[b]);
      if (d > best) [best, at] = [d, i];
    }
    if (at >= 0 && best > tolerance) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

const cross = (o: Point, a: Point, b: Point) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

// Andrew's monotone chain. Returns the hull clockwise on screen (y down).
export function convexHull(points: Point[]): Point[] {
  const ps = [...new Map(points.map(p => [`${p[0]},${p[1]}`, p])).values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (ps.length < 3) return ps;
  const half = (list: Point[]) => {
    const out: Point[] = [];
    for (const p of list) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  const hull = [...half(ps), ...half([...ps].reverse())];
  return signedArea(hull) >= 0 ? hull : hull.reverse();
}

// Positive when clockwise on screen (y down).
export const signedArea = (pts: Point[]) => pts.reduce((a, p, i) => a + p[0] * pts[(i + 1) % pts.length][1] - pts[(i + 1) % pts.length][0] * p[1], 0) / 2;

export function centroid(pts: Point[]): Point {
  const a = signedArea(pts);
  if (!a) return [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
  let [cx, cy] = [0, 0];
  pts.forEach((p, i) => {
    const q = pts[(i + 1) % pts.length];
    const c = p[0] * q[1] - q[0] * p[1];
    cx += (p[0] + q[0]) * c;
    cy += (p[1] + q[1]) * c;
  });
  return [cx / (6 * a), cy / (6 * a)];
}

// A convex polygon down to `max` corners, dropping each time the corner whose
// triangle with its neighbours is smallest (Visvalingam-Whyatt): it stays
// convex, and loses the least area. Box2D takes 8 at most.
export function reduceConvex(hull: Point[], max: number): Point[] {
  const pts = [...hull];
  while (pts.length > max) {
    let [best, at] = [Infinity, 0];
    pts.forEach((p, i) => {
      const t = Math.abs(cross(pts[(i + pts.length - 1) % pts.length], p, pts[(i + 1) % pts.length]));
      if (t < best) [best, at] = [t, i];
    });
    pts.splice(at, 1);
  }
  return pts;
}

// Axis-aligned along its long side; height is end to end, caps included.
export interface Capsule {
  x: number;
  y: number;
  radius: number;
  height: number;
  direction: "vertical" | "horizontal";
}

// The capsule that fills a box: as wide as its short side, as long as its long one.
export function capsuleOf(b: Box): Capsule {
  const vertical = b.h >= b.w;
  return { x: b.x + b.w / 2, y: b.y + b.h / 2, radius: (vertical ? b.w : b.h) / 2, height: vertical ? b.h : b.w, direction: vertical ? "vertical" : "horizontal" };
}

export interface Outline {
  hull: Point[];
  polygons: Point[][]; // one per piece, largest first
  specks: number; // pieces too small to keep
}

// A piece smaller than this share of the largest is a speck (a stray pixel,
// a spark), left out of the hull and the polygons.
const SPECK = 0.02;

// The art's convex hull and outline polygons, in frame pixels (x right, y down).
export function outlineOf(m: Uint8Array, w: number, h: number, tolerance: number): Outline | undefined {
  const { labels, areas } = components(m, w, h);
  if (!areas.length) return undefined;
  const big = Math.max(...areas);
  const kept = areas.map((a, k) => (a >= Math.max(1, SPECK * big) ? k : -1)).filter(k => k >= 0).sort((a, b) => areas[b] - areas[a]);
  const keep = new Uint8Array(areas.length);
  kept.forEach(k => (keep[k] = 1));
  // The outer corners of each row's outermost kept pixels make the hull.
  const corners: Point[] = [];
  for (let y = 0; y < h; y++) {
    let [l, r] = [-1, -1];
    for (let x = 0; x < w; x++) {
      const k = labels[y * w + x];
      if (k >= 0 && keep[k]) (l < 0 ? (l = x) : 0), (r = x);
    }
    if (l >= 0) corners.push([l, y], [l, y + 1], [r + 1, y], [r + 1, y + 1]);
  }
  const polygons = kept.map(k => simplifyClosed(traceOutline(labels, w, h, k), tolerance)).filter(p => p.length >= 3);
  return { hull: convexHull(corners), polygons, specks: areas.length - kept.length };
}

export interface Shapes {
  box: Box;
  capsule: Capsule;
  hull?: Point[];
  polygons?: Point[][];
  specks?: number;
}

// The same shapes with their coordinates relative to a point (the pivot).
export function shapesFrom(s: Shapes, [px, py]: Point): Shapes {
  const at = (p: Point): Point => [r2(p[0] - px), r2(p[1] - py)];
  return {
    box: { x: s.box.x - px, y: s.box.y - py, w: s.box.w, h: s.box.h },
    capsule: { ...s.capsule, x: r2(s.capsule.x - px), y: r2(s.capsule.y - py), radius: r2(s.capsule.radius), height: r2(s.capsule.height) },
    ...(s.hull ? { hull: s.hull.map(at) } : {}),
    ...(s.polygons ? { polygons: s.polygons.map(p => p.map(at)), specks: s.specks } : {})
  };
}

// ---- Engine snippets for colliders ----

const num = (v: number) => String(r4(v));
const vec2s = (pts: Point[]) => `PackedVector2Array(${pts.map(p => `${num(p[0])}, ${num(p[1])}`).join(", ")})`;
const tres = (type: string, lines: string[]) => [`[gd_resource type="${type}" format=3]`, "", "[resource]", ...lines, ""].join("\n");
const ccwUp = (pts: Point[]): Point[] => {
  // y flipped: a screen-clockwise ring becomes clockwise in y-up, so reverse it.
  const up = pts.map(p => [p[0], -p[1]] as Point);
  return signedArea(up) > 0 ? up : up.reverse();
};

// `rel` is in pixels from the pivot, y down; `abs` in frame pixels.
export function colliderEngines(rel: Shapes, abs: Shapes, s: { fw: number; fh: number; ppu: number; pivot: Point; snippets: boolean }) {
  const { box, capsule, hull, polygons } = rel;
  const boxCentre: Point = [box.x + box.w / 2, box.y + box.h / 2];
  const u = (v: number) => r4(v / s.ppu);
  const up = (p: Point): Point => [u(p[0]), u(-p[1])];
  const snip = <T>(v: T) => (s.snippets ? v : undefined);

  const godot = {
    box: { position: boxCentre, size: [box.w, box.h] as Point },
    capsule: { position: [capsule.x, capsule.y] as Point, radius: capsule.radius, height: capsule.height, rotation_degrees: capsule.direction === "vertical" ? 0 : 90 },
    ...(hull ? { hull: { points: hull } } : {}),
    ...(polygons ? { polygons } : {}),
    tres: snip({
      box: tres("RectangleShape2D", [`size = Vector2(${box.w}, ${box.h})`]),
      capsule: tres("CapsuleShape2D", [`radius = ${num(capsule.radius)}`, `height = ${num(capsule.height)}`]),
      ...(hull ? { hull: tres("ConvexPolygonShape2D", [`points = ${vec2s(hull)}`]) } : {})
    }),
    polygon_node: snip(polygons?.map((p, i) => [`[node name="CollisionPolygon2D${i ? i + 1 : ""}" type="CollisionPolygon2D" parent="."]`, `polygon = ${vec2s(p)}`, ""].join("\n")).join("\n"))
  };

  const unity = {
    pixels_per_unit: s.ppu,
    box: { offset: up(boxCentre), size: [u(box.w), u(box.h)] as Point },
    capsule: { offset: up([capsule.x, capsule.y]), size: capsule.direction === "vertical" ? [u(2 * capsule.radius), u(capsule.height)] : [u(capsule.height), u(2 * capsule.radius)], direction: capsule.direction === "vertical" ? "Vertical" : "Horizontal" },
    // PolygonCollider2D: one path per piece, set with SetPath(i, points).
    ...(polygons ? { polygon_paths: polygons.map(p => ccwUp(p).map(q => [u(q[0]), u(q[1])] as Point)) } : {})
  };

  // Arcade bodies are boxes whose offset counts from the frame's top-left,
  // whatever the origin: Body.position = x + scaleX * (offset.x - displayOriginX).
  const origin = (p: Point): Point => [r4(p[0] / s.fw), r4(p[1] / s.fh)];
  const arcade = {
    size: [abs.box.w, abs.box.h] as Point,
    offset: [abs.box.x, abs.box.y] as Point,
    origin: origin(s.pivot),
    snippet: snip(
      [
        `const sprite = this.physics.add.sprite(x, y, "<texture>").setOrigin(${origin(s.pivot).join(", ")});`,
        `sprite.body.setSize(${abs.box.w}, ${abs.box.h}, false).setOffset(${abs.box.x}, ${abs.box.y});`
      ].join("\n")
    )
  };
  // Matter recentres a body on its polygon's centre of mass, and Phaser lines
  // the art up by the polygon's bounds, which are not the frame's: so the
  // vertices are in frame pixels and the origin is set to that centre.
  const absMain = abs.polygons?.[0] ?? abs.hull;
  let matter: Record<string, unknown> | undefined;
  if (absMain) {
    const cm = centroid(absMain);
    const verts = absMain.map(p => ({ x: r2(p[0]), y: r2(p[1]) }));
    matter = {
      verts,
      origin: origin(cm),
      pivot_from_body: [r2(s.pivot[0] - cm[0]), r2(s.pivot[1] - cm[1])] as Point,
      snippet: snip(
        [
          `const verts = ${JSON.stringify(verts)};`,
          `const sprite = this.matter.add.sprite(x, y, "<texture>", 0, { shape: { type: "fromVerts", verts } });`,
          `// Matter centres the body on the polygon's centre of mass: put that point of the frame on it.`,
          `sprite.setOrigin(${origin(cm).join(", ")});`
        ].join("\n")
      )
    };
  }
  const phaser = { arcade, ...(matter ? { matter } : {}) };

  // Box2D: metres (pixels / ppu), y up, from the body's origin at the pivot.
  // A polygon has 8 corners at most, so the hull is cut down to 8; the
  // outline goes in as a chain loop (one-sided, counter-clockwise).
  const capEnds: [Point, Point] =
    capsule.direction === "vertical"
      ? [up([capsule.x, capsule.y - capsule.height / 2 + capsule.radius]), up([capsule.x, capsule.y + capsule.height / 2 - capsule.radius])]
      : [up([capsule.x - capsule.height / 2 + capsule.radius, capsule.y]), up([capsule.x + capsule.height / 2 - capsule.radius, capsule.y])];
  const v = (p: Point) => `{${p[0]}f, ${p[1]}f}`;
  const hull8 = hull && reduceConvex(ccwUp(hull), 8).map(q => [u(q[0]), u(q[1])] as Point);
  const chain = polygons?.[0] && ccwUp(polygons[0]).map(q => [u(q[0]), u(q[1])] as Point);
  const box2d = {
    pixels_per_metre: s.ppu,
    box: { centre: up(boxCentre), half_width: u(box.w / 2), half_height: u(box.h / 2) },
    capsule: { centre1: capEnds[0], centre2: capEnds[1], radius: u(capsule.radius) },
    ...(hull8 ? { hull: hull8 } : {}),
    ...(chain ? { chain } : {}),
    snippet: snip(
      [
        `// Box2D v3. Metres, y up, from the body's origin at the sprite's pivot.`,
        `b2ShapeDef shapeDef = b2DefaultShapeDef();`,
        `b2Polygon box = b2MakeOffsetBox(${u(box.w / 2)}f, ${u(box.h / 2)}f, (b2Vec2)${v(up(boxCentre))}, b2Rot_identity);`,
        `b2Capsule capsule = {${v(capEnds[0])}, ${v(capEnds[1])}, ${u(capsule.radius)}f};`,
        ...(hull8 ? [`b2Vec2 hullPoints[${hull8.length}] = {${hull8.map(v).join(", ")}};`, `b2Hull hull = b2ComputeHull(hullPoints, ${hull8.length});`, `b2Polygon polygon = b2MakePolygon(&hull, 0.0f);`] : []),
        `b2CreatePolygonShape(bodyId, &shapeDef, &box); // or b2CreateCapsuleShape(bodyId, &shapeDef, &capsule)`
      ].join("\n")
    )
  };
  return { godot, unity, phaser, box2d };
}

// ---- Pictures: the numbers drawn on the frames, to check them by eye ----

type Rgb = [number, number, number];
const rgba = (c: Rgb): Rgba => [c[0], c[1], c[2], 255];
const COLOURS = {
  bounds: [0, 200, 255] as Rgb,
  body: [255, 210, 0] as Rgb,
  ground: [255, 0, 200] as Rgb,
  pivot: [255, 40, 40] as Rgb,
  mass: [60, 255, 90] as Rgb,
  polygon: [60, 255, 90] as Rgb,
  hull: [0, 200, 255] as Rgb,
  box: [255, 210, 0] as Rgb,
  capsule: [255, 0, 200] as Rgb
};
const hexOf = (c: Rgb) => "#" + c.map(v => v.toString(16).padStart(2, "0")).join("");

const BG: Rgba = [22, 22, 29, 255];
const STRIP: Rgba = [40, 40, 52, 255];
const INK: Rgba = [232, 232, 240, 255];
const FONT = 2; // font pixels: 2 keeps labels readable after a viewer shrinks the picture
export const MAX_SIDE = 2048;
const MIN_CELL = 48; // px on a cell's longest side, under which --every steps in
const MAX_CELL = 320; // tiny sprites are enlarged up to this, no further
const M = 12; // margin
const GAP = 6; // between cells
const STRIP_H = textHeight(FONT) + 6; // a cell's number strip
const HEADER_H = M + 2 * (textHeight(FONT) + 8) + 4;

export interface FramesLayout {
  cols: number;
  rows: number;
  scale: number; // picture pixels per frame pixel
  cellW: number;
  cellH: number;
  width: number;
  height: number;
  gridX: number; // the first frame's top-left
  gridY: number;
  pitchX: number; // from one frame to the next
  pitchY: number;
}

function layoutAt(fw: number, fh: number, count: number, cols: number, scale: number, minWidth: number): FramesLayout {
  const rows = Math.ceil(count / cols);
  const cellW = Math.max(1, Math.round(fw * scale));
  const cellH = Math.max(1, Math.round(fh * scale));
  const width = 2 * M + Math.max(cols * cellW + (cols - 1) * GAP, minWidth);
  const pitchY = STRIP_H + cellH + GAP;
  const gridY = HEADER_H + STRIP_H;
  return { cols, rows, scale, cellW, cellH, width, height: gridY + (rows - 1) * pitchY + cellH + M, gridX: M, gridY, pitchX: cellW + GAP, pitchY };
}

// The biggest scale that keeps the picture within `maxSide`, over every
// column count; whole factors when enlarging, so pixel art keeps its
// pixels, up to MAX_CELL on a cell's longest side. Within 8% of the biggest,
// fewer empty cells win (4x4 for 16 frames, not 7, 7 and 2), then the
// squarer picture.
export function framesLayout(fw: number, fh: number, count: number, maxSide = MAX_SIDE, minWidth = 0): FramesLayout {
  const fits = (l: FramesLayout) => l.width <= maxSide && l.height <= maxSide;
  const options: FramesLayout[] = [];
  for (let cols = 1; cols <= count; cols++) {
    let [lo, hi] = [0, Math.max(1, MAX_CELL / Math.max(fw, fh))];
    if (fits(layoutAt(fw, fh, count, cols, hi, minWidth))) lo = hi;
    else for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (fits(layoutAt(fw, fh, count, cols, mid, minWidth))) lo = mid;
      else hi = mid;
    }
    let s = lo >= 1 ? Math.floor(lo) : Math.floor(lo * 1000) / 1000;
    while (s > 0.001 && !fits(layoutAt(fw, fh, count, cols, s, minWidth))) s = Math.floor(s * 999) / 1000;
    if (s > 0) options.push(layoutAt(fw, fh, count, cols, s, minWidth));
  }
  const top = Math.max(...options.map(o => o.scale));
  const empty = (x: FramesLayout) => x.cols * x.rows - count;
  const squareness = (x: FramesLayout) => Math.min(x.width, x.height) / Math.max(x.width, x.height);
  const best = options.filter(o => o.scale >= top * 0.92).sort((a, b) => empty(a) - empty(b) || b.scale - a.scale || squareness(b) - squareness(a))[0];
  if (!best) throw new CliError(`${count} frames do not fit a ${maxSide} px picture`, EXIT.USAGE, "Show fewer with --every.");
  return best;
}

// Drawing in one frame's cell, in frame pixels.
class Pen {
  constructor(
    readonly img: Image,
    readonly x: number,
    readonly y: number,
    readonly s: number,
    readonly t: number,
    readonly w: number
  ) {}
  X = (v: number) => Math.round(this.x + v * this.s);
  Y = (v: number) => Math.round(this.y + v * this.s);
  rect(b: Box, c: Rgb) {
    strokeRect(this.img, this.X(b.x), this.Y(b.y), Math.max(2 * this.t, Math.round(b.w * this.s)), Math.max(2 * this.t, Math.round(b.h * this.s)), rgba(c), this.t);
  }
  row(v: number, c: Rgb) {
    fillRect(this.img, this.x, this.Y(v) - Math.floor(this.t / 2), this.w, this.t, rgba(c));
  }
  ring(pts: Point[], c: Rgb, dash = 0) {
    for (let k = 0; k < this.t; k++) {
      pts.forEach((p, i) => {
        const q = pts[(i + 1) % pts.length];
        line(this.img, this.X(p[0]) + k, this.Y(p[1]), this.X(q[0]) + k, this.Y(q[1]), rgba(c), dash);
      });
    }
  }
  cross(p: Point, c: Rgb) {
    drawCross(this.img, this.X(p[0]), this.Y(p[1]), Math.max(4, Math.round(this.w / 12)), rgba(c), this.t);
  }
  dot(p: Point, c: Rgb) {
    dot(this.img, this.X(p[0]), this.Y(p[1]), this.t + 1, rgba(c));
  }
}

export interface Picture {
  image: Image;
  layout: FramesLayout;
  every: number;
  shown: number[]; // frame numbers, from 1
}

// The frames shown (every nth), each under its number on a checkerboard,
// with `draw` marking them; a title and a colour key on top. Without
// `every`, the fewest frames are dropped that leave cells big enough to see.
export function framesPicture(frames: Image[], title: string, legend: [Rgb, string][], draw: (pen: Pen, frame: number) => void, every?: number, maxSide = MAX_SIDE): Picture {
  const { width: fw, height: fh } = frames[0];
  const pick = (n: number) => frames.map((_, i) => i).filter(i => i % n === 0);
  const keyWidth = legend.reduce((a, [, name]) => a + 18 + textWidth(name, FONT) + 20, -20);
  const minWidth = Math.min(maxSide - 2 * M, Math.max(keyWidth, 360));
  let n = every ?? 1;
  if (every === undefined) {
    while (n < frames.length) {
      const l = framesLayout(fw, fh, pick(n).length, maxSide, minWidth);
      if (Math.max(l.cellW, l.cellH) >= Math.min(MIN_CELL, Math.max(fw, fh))) break;
      n++;
    }
  }
  if (n > frames.length) throw new CliError(`--every ${n} is more than the ${frames.length} frames`, EXIT.USAGE);
  const shownFrames = pick(n);
  const l = framesLayout(fw, fh, shownFrames.length, maxSide, minWidth);
  const img = canvas(l.width, l.height, BG);
  text(img, M, M, fitText(n > 1 ? `${title} · every ${n}: ${shownFrames.length} shown` : title, l.width - 2 * M, FONT), INK, FONT);
  let at = M;
  for (const [c, name] of legend) {
    fillRect(img, at, M + textHeight(FONT) + 10, 12, 12, rgba(c));
    text(img, at + 18, M + textHeight(FONT) + 8, name, INK, FONT);
    at += 18 + textWidth(name, FONT) + 20;
  }
  const t = l.cellW >= 160 ? 2 : 1; // 1 px lines vanish when a viewer shrinks a big picture
  shownFrames.forEach((frame, k) => {
    const x = l.gridX + (k % l.cols) * l.pitchX;
    const y = l.gridY + Math.floor(k / l.cols) * l.pitchY;
    fillRect(img, x, y - STRIP_H, l.cellW, STRIP_H, STRIP);
    text(img, x + 3, y - STRIP_H + 3, fitText(String(frame + 1), l.cellW - 6, FONT), INK, FONT);
    checkerboard(img, x, y, l.cellW, l.cellH);
    drawImage(img, scaled(frames[frame], l.scale), x, y);
    draw(new Pen(img, x, y, l.scale, t, l.cellW), frame);
  });
  return { image: img, layout: l, every: n, shown: shownFrames.map(i => i + 1) };
}

const pictureJson = (p: Picture, file: string, legend: Record<string, string>) => ({
  image: shown(file),
  width: p.layout.width,
  height: p.layout.height,
  every: p.every,
  shown: p.shown,
  // Frame k (from 0 among those shown) is at first_cell + (k % cols, floor(k / cols)) * pitch, at scale.
  layout: { cols: p.layout.cols, rows: p.layout.rows, scale: r4(p.layout.scale), first_cell: { x: p.layout.gridX, y: p.layout.gridY }, pitch: { x: p.layout.pitchX, y: p.layout.pitchY } },
  legend: { number: "the frame's number, from 1, as `sprite frames` counts", checkerboard: "transparent pixels", ...legend }
});

const METRICS_KEY: [Rgb, string][] = [
  [COLOURS.bounds, "bounds"],
  [COLOURS.body, "body"],
  [COLOURS.ground, "ground"],
  [COLOURS.pivot, "pivot"],
  [COLOURS.mass, "centre of mass"]
];

export function metricsPicture(frames: Image[], title: string, s: SheetMetrics, every?: number): Picture {
  return framesPicture(
    frames,
    title,
    METRICS_KEY,
    (pen, i) => {
      const f = s.frames[i];
      pen.row(s.ground.row + 1, COLOURS.ground);
      if (f.bounds) pen.rect(f.bounds, COLOURS.bounds);
      if (f.body) pen.rect(f.body, COLOURS.body);
      if (f.centre_of_mass) pen.dot(f.centre_of_mass, COLOURS.mass);
      pen.cross([s.pivot.x, s.pivot.y], COLOURS.pivot);
    },
    every
  );
}

export function collidePicture(frames: Image[], title: string, shapes: (Shapes | undefined)[], pivot: Point, every?: number): Picture {
  const key: [Rgb, string][] = [
    [COLOURS.box, "box"],
    [COLOURS.capsule, "capsule"],
    ...(shapes.some(s => s?.hull) ? [[COLOURS.hull, "hull"] as [Rgb, string]] : []),
    ...(shapes.some(s => s?.polygons) ? [[COLOURS.polygon, "polygon"] as [Rgb, string]] : []),
    [COLOURS.pivot, "pivot"]
  ];
  return framesPicture(
    frames,
    title,
    key,
    (pen, i) => {
      const s = shapes.length === 1 ? shapes[0] : shapes[i];
      if (!s) return;
      pen.rect(s.box, COLOURS.box);
      const c = s.capsule;
      const ends = c.height / 2 - c.radius;
      // A stadium: the capsule's box with its short sides rounded.
      const cap: Point[] = Array.from({ length: 48 }, (_, k) => {
        const a = (2 * Math.PI * k) / 48;
        const [ex, ey] = [Math.cos(a), Math.sin(a)];
        return c.direction === "vertical" ? [c.x + c.radius * ex, c.y + (ey >= 0 ? ends : -ends) + c.radius * ey] : [c.x + (ex >= 0 ? ends : -ends) + c.radius * ex, c.y + c.radius * ey];
      });
      pen.ring(cap, COLOURS.capsule);
      if (s.hull) pen.ring(s.hull, COLOURS.hull, 5);
      s.polygons?.forEach(p => pen.ring(p, COLOURS.polygon));
      pen.cross(pivot, COLOURS.pivot);
    },
    every
  );
}

// ---- Reading a sheet ----

interface Sheet {
  src: Loaded;
  grid: Grid;
  from: string;
  frames: Image[]; // untrimmed, without extrusion
  masks: Uint8Array[];
  fw: number;
  fh: number;
}

const ALPHA: ToolFlag = { flag: "--alpha-threshold", value: "n", description: "Alpha from this up is solid, 1-255 (default 128)" };
const GRID: ToolFlag = { flag: "--grid", value: "CxR", description: "The sheet's grid, when it has no Ludo stamp and detection is unsure" };
export const PIVOT_FLAG: ToolFlag = { flag: "--pivot", value: "feet|mass|X,Y", description: "The pivot: on the ground line between the feet, the centre of mass, or a point in frame pixels (default: feet for a character, else mass)" };
const EVERY: ToolFlag = { flag: "--every", value: "n", description: `With --overlay, draw every nth frame (default 1, or more when the cells would be under ${MIN_CELL} px)` };

export function alphaThreshold(call: ToolCall): number {
  const raw = call.flags.get("--alpha-threshold");
  if (raw === undefined) return 128;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 255) throw new CliError("--alpha-threshold must be a whole number from 1 to 255", EXIT.USAGE);
  return n;
}

export function pivotChoice(call: ToolCall): PivotChoice {
  const raw = textFlag(call, "--pivot");
  if (call.flags.get("--pivot") === true) throw new CliError("--pivot needs a value: feet, mass or X,Y", EXIT.USAGE);
  if (raw === undefined) return { kind: "feet" };
  if (raw === "feet") return { kind: "feet", asked: true };
  if (raw === "mass") return { kind: "mass" };
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(raw);
  if (!m) throw new CliError(`--pivot takes feet, mass or X,Y in frame pixels, like 64,120 (got "${raw}")`, EXIT.USAGE);
  return { kind: "flag", at: [Number(m[1]), Number(m[2])] };
}

// A sheet's frames as engines see them (untrimmed, without the extruded
// border) and their solid pixels.
export function sheetFrames(src: Loaded, grid: Grid, threshold: number) {
  const e = src.extrude ?? 0;
  const t = src.trim;
  const frames = sliceSheet(src.image, grid.cols, grid.rows, grid.frames).map(img => {
    const cut = e ? crop(img, { x: e, y: e, w: img.width - 2 * e, h: img.height - 2 * e }) : img;
    // A trimmed sheet's frames back at their untrimmed size and place.
    return t && cut.width === t.w && cut.height === t.h ? pad(cut, { left: t.x, top: t.y, right: t.source_w - t.x - t.w, bottom: t.source_h - t.y - t.h }) : cut;
  });
  return { frames, masks: solidMasks(frames, src.image, threshold), fw: frames[0].width, fh: frames[0].height };
}

function readSheet(call: ToolCall, file: string, threshold: number): Sheet {
  const src = loadImageFile(file);
  const { grid, from } = resolveGrid(src, gridFlag(call));
  return { src, grid, from, ...sheetFrames(src, grid, threshold) };
}

export function metricsOrFail(masks: Uint8Array[], fw: number, fh: number, choice: PivotChoice, file: string, threshold: number): SheetMetrics {
  const s = sheetMetrics(masks, fw, fh, choice);
  if (!s) throw new CliError(`${shown(file)} has no solid pixels (alpha ${threshold} and up)`, EXIT.BAD_INPUT, "Try a lower --alpha-threshold.");
  return s;
}

const metricsOf = (sheet: Sheet, call: ToolCall, threshold: number) => metricsOrFail(sheet.masks, sheet.fw, sheet.fh, pivotChoice(call), sheet.src.file, threshold);

const gridJson = (sh: Sheet) => ({ cols: sh.grid.cols, rows: sh.grid.rows, frames: sh.grid.frames, frame_width: sh.fw, frame_height: sh.fh, fps: sh.grid.fps });
const howGrid = (from: string) => (from === "stamp" ? "from its Ludo stamp" : from === "gif" ? "the GIF's frames" : from === "webp" ? "the WebP's frames" : from === "flag" ? "from --grid" : "detected");
const pt = (p: Point) => `${r2(p[0])}, ${r2(p[1])}`;
const titleOf = (sh: Sheet) => `${path.basename(sh.src.file)} · ${sh.grid.frames} frames of ${sh.fw}x${sh.fh} · ${sh.grid.cols}x${sh.grid.rows} · ${sh.grid.fps} fps`;

function savePicture(ctx: Ctx, sheet: Sheet, img: Image, what: string): string {
  const file = freeName(ctx.outDir, `${ctx.globals.name || baseOf(sheet.src.file)}-${what}`, ".png");
  writePng(file, img);
  return file;
}

const OVERLAY: ToolFlag = { flag: "--overlay", description: "Also save a picture of the frames with the result drawn on them, to check it by eye" };

function everyFlag(call: ToolCall): number | undefined {
  const every = positiveInt(call, "--every");
  if (every !== undefined && !call.flags.has("--overlay")) throw new CliError("--every is for the --overlay picture: add --overlay", EXIT.USAGE);
  return every;
}

TOOLS.push({
  group: "sprite",
  name: "metrics",
  args: "<sheet>",
  summary: "Measure each frame (bounds, body, ground line, centre of mass) and suggest a pivot, with engine values",
  details: [
    "Per frame: the solid pixels' bounds, the body, the ground row (the lowest solid row) and the centre",
    "of mass. For the sheet: the union of the bounds, the ground line most frames stand on and how far",
    "it is above the frame's bottom edge, a pivot, and drift: whether the art travels across the frame",
    "over the clip or stays in place (its sway is listed).",
    "",
    "The body (`sprite collide` and `sprite compare` use it too) is the box around the art once parts",
    "under about a third of its thickness across are taken off: a morphological opening whose radius is",
    "35% of the radius of the widest disc that fits in the art (the torso or the head), median over",
    "frames. Of what is left, only what lies in the piece of art holding most of it counts. So a blade,",
    "a spear or a staff held out or beside the body, a slash trail's thin edge, and anything not touching",
    "the character are left out; a plume, a shield arm, the helmet and the legs stay. Its bottom is the",
    "frame's lowest solid row (on a character, no lower than just under the ground line). Under 34 px",
    "tall nothing is taken off: in small pixel art the body is the whole piece. A weapon or a cape as",
    "thick as a limb counts as body.",
    "",
    "A sheet is a character when at least half its frames bottom out on one row in the lower third of",
    "the frame: its pivot is on that ground line, between the feet (the middle of the solid pixels at",
    "the ground within the body's columns, median over the frames standing on it), so it stays put when",
    "the sprite is flipped and a spear or staff planted beside the feet does not move it. Anything else",
    "pivots on its centre of mass, unless --pivot feet is given: then the feet are taken from the frames",
    "that reach the sheet's lowest row (a jump's take-off and landing), or, when none is in the lower",
    "third of the frame, it says so and keeps the centre of mass. The output says which, and why.",
    "",
    "Coordinates are frame pixels from the top-left, y down; the pivot sits on pixel edges, so feet on",
    "row 120 put it at y 121. Engine values put the pivot at the node's origin: Godot's Sprite2D offset",
    "(centered on, and off), Unity's normalised sprite pivot, Phaser's setOrigin; `sprite export",
    "--pivot` writes them into the engine files. Unity's pixels per unit is one number for a whole",
    "character: `sprite compare` gives it. sort_point is the Y-sort origin for top-down games.",
    "--overlay draws it all on the frames, each under its number. It only measures: nothing is moved."
  ],
  flags: [PIVOT_FLAG, OVERLAY, EVERY, ALPHA, GRID],
  async run(ctx: Ctx, call: ToolCall) {
    if (call.args.length !== 1) throw new CliError("Usage: ludo toolbox sprite metrics <sheet>", EXIT.USAGE);
    const threshold = alphaThreshold(call);
    const every = everyFlag(call);
    const sheet = readSheet(call, call.args[0], threshold);
    const s = metricsOf(sheet, call, threshold);
    const engines = engineValues(s, sheet.src.trim);
    const sort = sortPoint(s);
    const picture = call.flags.has("--overlay") ? metricsPicture(sheet.frames, titleOf(sheet), s, every) : undefined;
    const overlay = picture && savePicture(ctx, sheet, picture.image, "metrics");
    const sheetArg = shown(sheet.src.file);
    const next = hint("Write the engine files with this pivot", `ludo toolbox sprite export ${shellArg(sheetArg)} --engine unity --pivot ${s.pivot.kind === "flag" ? `${s.pivot.x},${s.pivot.y}` : s.pivot.kind}`);
    if (ctx.jsonOut) {
      printJson(
        {
          sheet: sheetArg,
          grid: gridJson(sheet),
          grid_from: sheet.from,
          alpha_threshold: threshold,
          frames: s.frames.map((f, i) => ({ frame: i + 1, ...f })),
          union: s.union,
          ground: { ...s.ground, feet: feetText(s) },
          art: s.art,
          body: s.body,
          character: s.character,
          pivot: s.pivot,
          drift: s.drift,
          ...engines,
          pixels_per_unit: "one for the whole character, shared by its sheets: `ludo toolbox sprite compare <its sheets>` gives it",
          sort_point: sort,
          ...(picture && overlay
            ? {
                overlay: pictureJson(picture, overlay, {
                  bounds: `${hexOf(COLOURS.bounds)} box: the frame's solid pixels`,
                  body: `${hexOf(COLOURS.body)} box: the body, without what is under a third of its thickness across (a blade, a spear, a staff)`,
                  ground: `${hexOf(COLOURS.ground)} line: the ground line (under row ${s.ground.row})`,
                  pivot: `${hexOf(COLOURS.pivot)} cross: the pivot`,
                  centre_of_mass: `${hexOf(COLOURS.mass)} dot: the frame's centre of mass`
                })
              }
            : {}),
          ...(ctx.globals.quiet ? {} : { hint: next })
        },
        false
      );
    } else {
      const out = (line: string) => process.stdout.write(line + "\n");
      const u = s.union;
      out(`${sheet.grid.frames} frames of ${sheet.fw}x${sheet.fh} (${sheet.grid.cols}x${sheet.grid.rows} grid, ${howGrid(sheet.from)})`);
      out(`Art in ${u.w}x${u.h} at ${u.x},${u.y} over all frames; body ${s.body.width}x${s.body.height} (median frame, without what is under a third of its thickness across)`);
      out(`Ground line: row ${s.ground.row} (${s.ground.frames_on_it} of ${s.frames.length} frames)${s.character ? `: ${feetText(s)}` : ", not a character"}`);
      out(`Pivot ${s.pivot.x}, ${s.pivot.y} (${s.pivot.kind}): ${s.pivot.why}`);
      out(`Drift: ${s.drift.verdict} (sway ${pt(s.drift.sway)} px)`);
      out(`Godot   centered, offset = Vector2(${pt(engines.godot.offset)})`);
      out(`Unity   pivot ${pt(engines.unity.pivot)}; pixels per unit: one per character, from \`ludo toolbox sprite compare\``);
      out(`Phaser  setOrigin(${engines.phaser.origin.join(", ")})`);
      out(`Y-sort  ${sort.x}, ${sort.y}${sort.from_pivot[1] ? ` (${sort.from_pivot[1]} px below the pivot)` : " (the pivot)"}`);
      if (overlay) out(`Saved ${shown(overlay)}`);
      if (!ctx.globals.quiet) process.stderr.write(`Next: ${next.text}: ${next.command}\n`);
    }
    return EXIT.OK;
  }
});

const SHAPES = ["box", "capsule", "hull", "polygon"] as const;

TOOLS.push({
  group: "sprite",
  name: "collide",
  args: "<sheet>",
  summary: "Collision shapes for a sprite's body: box and capsule, and on request the hull and outline, for each engine",
  details: [
    "Shapes are measured on all frames together (one collider for the animation: the box holding every",
    "frame's body), or on each frame with --per-frame. The box and the capsule cover the body as `sprite",
    "metrics` measures and draws it: the art without what is under about a third of its thickness across",
    "and without what does not touch the character, so a sword or spear held out or raised, or a staff",
    "beside it, is left out of them; a weapon as thick as a limb is not.",
    "",
    "  box      the body's box (the default, with the capsule)",
    "  capsule  the capsule filling the box, along its long side",
    "  hull     the art's convex hull (with --shapes)",
    "  polygon  the art's outline, simplified with Douglas-Peucker to within --tolerance pixels, one per",
    "           piece; pieces under 2% of the largest are left out, holes are filled (with --shapes)",
    "",
    "Coordinates are pixels from the pivot of `ludo toolbox sprite metrics` (or --pivot), y down. Engine",
    "values follow each engine's convention: Godot (pixels, y down, .tres shapes and a CollisionPolygon2D",
    "node), Unity (units at --ppu, y up: Box/Capsule/PolygonCollider2D), Phaser Arcade (body.setSize and",
    "setOffset from the frame's top-left) and Matter (a polygon, with the origin that lines the art up),",
    "Box2D v3 (metres at --ppu, y up). Use the --ppu the sprite is imported at: `sprite compare` gives",
    "one per character, and `sprite export --engine unity --ppu` writes it. --per-frame prints each",
    "frame's box and capsule, one line a frame, and saves the full shapes and engine values per frame to",
    "a JSON file."
  ],
  flags: [
    { flag: "--shapes", value: "list", description: `Which shapes, from ${SHAPES.join(", ")} (default box,capsule)` },
    { flag: "--per-frame", description: "One set of shapes per frame instead of one for the whole animation" },
    { flag: "--ppu", value: "n", description: `Pixels per unit (Unity) or per metre (Box2D) (default ${UNITY_PPU}, what \`sprite export --engine unity\` writes without --ppu)` },
    { flag: "--tolerance", value: "px", description: "How far the simplified outline may stray from the art (default: 1% of its larger side, at least 1)" },
    { flag: "--inset", value: "px", description: "Shrink the art by this many pixels before measuring (default 0)" },
    PIVOT_FLAG,
    OVERLAY,
    EVERY,
    ALPHA,
    GRID
  ],
  async run(ctx: Ctx, call: ToolCall) {
    if (call.args.length !== 1) throw new CliError("Usage: ludo toolbox sprite collide <sheet> [--per-frame]", EXIT.USAGE);
    const threshold = alphaThreshold(call);
    const every = everyFlag(call);
    const rawInset = call.flags.get("--inset");
    const inset = rawInset === undefined ? 0 : Number(rawInset);
    if (!Number.isInteger(inset) || inset < 0) throw new CliError("--inset must be a whole number of pixels, 0 or more", EXIT.USAGE);
    const ppu = positiveNumber(call, "--ppu") ?? UNITY_PPU;
    const wanted = (textFlag(call, "--shapes") ?? "box,capsule").split(",").map(x => x.trim()).filter(Boolean);
    const bad = wanted.find(x => !(SHAPES as readonly string[]).includes(x));
    if (bad || !wanted.length) throw new CliError(`--shapes takes a list from ${SHAPES.join(", ")} (got "${bad ?? ""}")`, EXIT.USAGE);
    const outline = wanted.includes("hull") || wanted.includes("polygon");
    const sheet = readSheet(call, call.args[0], threshold);
    const s = metricsOf(sheet, call, threshold);
    const pivot: Point = [s.pivot.x, s.pivot.y];
    const tolerance = positiveNumber(call, "--tolerance") ?? Math.max(1, r2(0.01 * Math.max(s.union.w, s.union.h)));
    const perFrame = call.flags.has("--per-frame");
    const { fw, fh } = sheet;

    // The body of each frame (as metrics measures it, after the inset), and
    // for the whole animation the box holding them all.
    const masks = sheet.masks.map(m => erode(m, fw, fh, inset));
    const floor = s.character ? s.ground.row + Math.max(1, Math.round(0.02 * s.art.height)) : undefined;
    const radius = bodyRadius(sheet.masks, fw, fh, s.art.height);
    const bodies = masks.map(m => bodyBox(m, fw, fh, radius, floor));
    if (bodies.every(b => !b)) throw new CliError(`Nothing is left of ${shown(sheet.src.file)} after an inset of ${inset} px`, EXIT.USAGE, "Use a smaller --inset.");
    const union = new Uint8Array(fw * fh);
    for (const m of masks) for (let p = 0; p < m.length; p++) union[p] |= m[p];
    const shapeOf = (box: Box | null, m: Uint8Array): Shapes | undefined => {
      if (!box) return undefined;
      const o = outline ? outlineOf(m, fw, fh, tolerance) : undefined;
      return {
        box,
        capsule: capsuleOf(box),
        ...(o && wanted.includes("hull") ? { hull: o.hull } : {}),
        ...(o && wanted.includes("polygon") ? { polygons: o.polygons, specks: o.specks } : {})
      };
    };
    const shapes = perFrame ? bodies.map((b, i) => shapeOf(b, masks[i])) : [shapeOf(unionBox(bodies), union)];
    const result = shapes.map(abs => {
      if (!abs) return null;
      const rel = shapesFrom(abs, pivot);
      return { shapes: rel, engines: colliderEngines(rel, abs, { fw, fh, ppu, pivot, snippets: !perFrame }) };
    });
    const picture = call.flags.has("--overlay") ? collidePicture(sheet.frames, titleOf(sheet), shapes, pivot, every) : undefined;
    const overlay = picture && savePicture(ctx, sheet, picture.image, "collide");
    // Per frame, the full shapes and engine values go to a file: on a long
    // sheet they run to hundreds of kilobytes.
    let full: string | undefined;
    if (perFrame) {
      full = freeName(ctx.outDir, `${ctx.globals.name || baseOf(sheet.src.file)}-collide-frames`, ".json");
      writeJson(full, { sheet: shown(sheet.src.file), pivot: s.pivot, ppu, coordinates: "pixels from the pivot, x right, y down", frames: result.map((r, i) => ({ frame: i + 1, ...(r ?? { shapes: null }) })) });
    }
    const sheetArg = shown(sheet.src.file);
    const next = hint("Import the sprite with the same pivot and pixels per unit", `ludo toolbox sprite export ${shellArg(sheetArg)} --engine unity --pivot ${s.pivot.kind === "flag" ? `${s.pivot.x},${s.pivot.y}` : s.pivot.kind} --ppu ${ppu}`);

    if (ctx.jsonOut) {
      printJson(
        {
          sheet: sheetArg,
          grid: gridJson(sheet),
          grid_from: sheet.from,
          alpha_threshold: threshold,
          inset,
          ...(outline ? { tolerance } : {}),
          pivot: s.pivot,
          sprite_offset: engineValues(s, sheet.src.trim).godot,
          coordinates: "pixels from the pivot, x right, y down",
          ...(perFrame
            ? {
                frames: result.map((r, i) => ({
                  frame: i + 1,
                  ...(r ? { box: r.shapes.box, capsule: r.shapes.capsule, phaser_arcade: { size: r.engines.phaser.arcade.size, offset: r.engines.phaser.arcade.offset } } : { box: null })
                })),
                full: shown(full!)
              }
            : result[0]!),
          ...(picture && overlay
            ? {
                overlay: pictureJson(picture, overlay, {
                  box: `${hexOf(COLOURS.box)} box`,
                  capsule: `${hexOf(COLOURS.capsule)} capsule`,
                  ...(wanted.includes("hull") ? { hull: `${hexOf(COLOURS.hull)} dashed: the convex hull` } : {}),
                  ...(wanted.includes("polygon") ? { polygon: `${hexOf(COLOURS.polygon)}: the outline polygons` } : {}),
                  pivot: `${hexOf(COLOURS.pivot)} cross: the pivot`
                })
              }
            : {}),
          ...(ctx.globals.quiet ? {} : { hint: next })
        },
        false
      );
    } else {
      const out = (line: string) => process.stdout.write(line + "\n");
      out(`${sheet.grid.frames} frames of ${fw}x${fh}; shapes ${perFrame ? "per frame" : "for all frames together"}, from the pivot ${pivot.join(", ")} (${s.pivot.kind})`);
      const r = result.find(x => x);
      if (r && !perFrame) {
        const { box, capsule, hull, polygons, specks } = r.shapes;
        out(`  box      ${box.w}x${box.h} at ${box.x}, ${box.y}`);
        out(`  capsule  ${capsule.direction}, radius ${capsule.radius}, height ${capsule.height} at ${capsule.x}, ${capsule.y}`);
        if (hull) out(`  hull     ${hull.length} points`);
        if (polygons) out(`  polygon  ${polygons.map(p => p.length).join(" + ")} points (within ${tolerance} px)${specks ? `; ${specks} specks left out` : ""}`);
        out("Engine values and snippets (Godot, Unity, Phaser, Box2D) are in the JSON: add --json.");
      } else {
        result.forEach((x, i) => {
          if (!x) return out(`  frame ${String(i + 1).padStart(3)}  no solid pixels`);
          const { box, capsule } = x.shapes;
          out(`  frame ${String(i + 1).padStart(3)}  box ${box.w}x${box.h} at ${box.x}, ${box.y}; capsule ${capsule.direction}, radius ${capsule.radius}, height ${capsule.height} at ${capsule.x}, ${capsule.y}`);
        });
        out(`Saved ${shown(full!)} (every frame's shapes and engine values)`);
      }
      if (overlay) out(`Saved ${shown(overlay)}`);
      if (!ctx.globals.quiet) process.stderr.write(`Next: ${next.text}: ${next.command}\n`);
    }
    return EXIT.OK;
  }
});

function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value) + "\n");
}

// ---- One character's sheets: how big each is drawn, and one pixels per unit ----

// A sheet whose body is over 5% taller or shorter than the reference's is
// drawn at another size: at one pixels per unit it would grow or shrink
// between moves. Breathing, a crouch or a lean move a body's median height
// by 2-3% at most on Ludo's own sheets.
export const SIZE_TOLERANCE = 0.05;
// Without --reference, the reference sheet's body is taken as 2 units tall,
// a size Unity's 2D physics handles well.
const ASSUMED_HEIGHT = 2;

// "1.8m", "180cm", "1800mm" or "2u" (engine units, which Unity and Godot
// take as metres), in metres.
export function parseHeight(spec: string, where: string): number {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(m|cm|mm|u)?\s*$/i.exec(spec);
  if (!m || !Number(m[1])) throw new CliError(`${where} takes a height like 1.8m, 180cm or 2u (got "${spec}")`, EXIT.USAGE);
  const unit = (m[2] ?? "m").toLowerCase();
  return Number(m[1]) / (unit === "cm" ? 100 : unit === "mm" ? 1000 : 1);
}

// Folder words that say where files are kept, not whose they are: the CLI's
// own ludo-output, sprites/, assets/characters/.
const PLACE_WORDS = new Set(
  (
    "ludo output outputs out assets asset art arts sprites sprite sheets spritesheets spritesheet anim anims animation animations images image img imgs " +
    "gfx graphics textures texture characters character chars res resources export exports exported build dist public static src game games data media " +
    "files tmp temp downloads download desktop documents project projects new old final"
  ).split(" ")
);

// How the CLI names a download (animateSprite-29402c81-1.png): the
// operation, the job, the file's number. It says nothing of the character.
const LUDO_DOWNLOAD = /^[a-z][A-Za-z0-9]*-[0-9a-f]{8}-\d+$/;

// The character a sheet shows, from its file name, else its folder's when
// that names one: knight_walk.png and knight/idle.png are "knight", Ludo's
// fp_hero_walk2/animateSprite-61b55cee-1.png is "fp_hero". "" when neither
// says (ludo-output/animateSprite-....png, sprites/walk.png).
export function characterName(file: string): string {
  const own = LUDO_DOWNLOAD.test(baseOf(file)) ? "" : characterOf(path.basename(file)).character;
  if (own) return own;
  const folder = path.basename(path.dirname(path.resolve(file)));
  const words = folder.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (words.every(w => PLACE_WORDS.has(w) || /^\d+$/.test(w))) return "";
  return characterOf(folder).character;
}

// ---- Where a Ludo sheet came from: the asset log beside it ----

// Adjust re-cuts spritesheets made in the last 7 days (its --spritesheet-url help).
const ADJUST_DAYS = 7;

export interface Origin {
  job?: string;
  made?: string; // created_at of the generation the animation comes from
  image?: string; // its initial image: a path (absolute) or a URL
  motion_prompt?: string;
  model?: string;
  true_size?: boolean; // exported with --frame-size -9
  url?: string; // a spritesheet_url that re-cuts the same animation, when one is on record
  log: string;
}

const md5s = new Map<string, string | undefined>();
function md5Of(file: string): string | undefined {
  if (!md5s.has(file)) {
    try {
      md5s.set(file, crypto.createHash("md5").update(fs.readFileSync(file)).digest("hex"));
    } catch {
      md5s.set(file, undefined);
    }
  }
  return md5s.get(file);
}

const isUrl = (v: string) => /^(https?:|data:)/i.test(v);

// The asset logs that may know a sheet: in its folder and every folder above
// it (a project keeps one at its root), and in its folder's siblings (one
// --out per generation, as fp_hero_walk/ and fp_hero_walk_ts/).
class AssetLogs {
  private read = new Map<string, AssetEntry[]>();
  private entries(log: string): AssetEntry[] {
    if (!this.read.has(log)) {
      let list: AssetEntry[] = [];
      try {
        list = readAssets(log);
      } catch {
        // An unreadable log says nothing.
      }
      this.read.set(log, list);
    }
    return this.read.get(log)!;
  }
  private logsFor(file: string): string[] {
    const out: string[] = [];
    for (let dir = path.dirname(path.resolve(file)); ; dir = path.dirname(dir)) {
      out.push(path.join(dir, LOG_NAME));
      if (path.dirname(dir) === dir) break;
    }
    const parent = path.dirname(path.dirname(path.resolve(file)));
    try {
      for (const d of fs.readdirSync(parent, { withFileTypes: true })) if (d.isDirectory()) out.push(path.join(parent, d.name, LOG_NAME));
    } catch {
      // No siblings to read.
    }
    return [...new Set(out)];
  }
  private entryOf(file: string): { entry: AssetEntry; dir: string } | undefined {
    for (const log of this.logsFor(file)) {
      const dir = path.dirname(log);
      if (path.relative(dir, path.resolve(file)).startsWith("..")) continue;
      const entry = findAsset(this.entries(log), file, dir);
      if (entry) return { entry, dir };
    }
    return undefined;
  }
  // The logged generation whose sheet a spritesheet_url names: Ludo's
  // sheet URLs end in the sheet's MD5, so the saved WebP whose MD5 it is.
  private bySheetUrl(url: string, near: string): { entry: AssetEntry; dir: string } | undefined {
    const id = /([0-9a-f]{32})\.\w+$/i.exec(url.split("?")[0])?.[1]?.toLowerCase();
    if (!id) return undefined;
    for (const log of this.logsFor(near)) {
      const dir = path.dirname(log);
      for (const e of this.entries(log)) if (/\.webp$/i.test(e.file) && md5Of(path.resolve(dir, e.file)) === id) return { entry: e, dir };
    }
    return undefined;
  }
  // A spritesheet_url on record (in a later adjust or edit) for this saved sheet.
  private urlOf(entry: AssetEntry, dir: string, near: string): string | undefined {
    const sums = new Set(
      this.entries(path.join(dir, LOG_NAME))
        .filter(e => e.job_id === entry.job_id && /\.webp$/i.test(e.file))
        .map(e => md5Of(path.resolve(dir, e.file)))
        .filter(Boolean)
    );
    for (const log of this.logsFor(near)) {
      for (const e of this.entries(log)) {
        const u = e.body?.spritesheet_url;
        const id = typeof u === "string" ? /([0-9a-f]{32})\.\w+$/i.exec(u.split("?")[0])?.[1]?.toLowerCase() : undefined;
        if (id && sums.has(id)) return u as string;
      }
    }
    return undefined;
  }
  origin(file: string): Origin | undefined {
    const own = this.entryOf(file);
    if (!own) return undefined;
    const out: Origin = { job: own.entry.job_id, log: path.join(own.dir, LOG_NAME) };
    let at: { entry: AssetEntry; dir: string } | undefined = own;
    for (let hop = 0; at && hop < 8; hop++) {
      const b = at.entry.body ?? {};
      if (out.true_size === undefined && typeof b.frame_size === "number") out.true_size = b.frame_size === -9;
      const image = typeof b.initial_image === "string" ? b.initial_image : typeof b.image === "string" ? b.image : undefined;
      if (image) {
        out.image = isUrl(image) ? image : path.resolve(at.dir, image);
        out.motion_prompt = typeof b.motion_prompt === "string" ? b.motion_prompt : undefined;
        out.model = typeof b.model === "string" ? b.model : undefined;
        out.made = at.entry.created_at;
        if (!out.url) out.url = this.urlOf(at.entry, at.dir, file);
        break;
      }
      const src = typeof b.spritesheet_url === "string" ? b.spritesheet_url : undefined;
      if (!src) break;
      // An adjust re-cuts its source: the source's URL re-cuts this sheet's animation too.
      if (hop === 0 && at.entry.operation_id === "adjustSpritesheet") out.url = src;
      at = this.bySheetUrl(src, file);
    }
    return out;
  }
}

const sameImage = (a?: string, b?: string) => !!a && !!b && (a === b || (!isUrl(a) && !isUrl(b) && !!md5Of(a) && md5Of(a) === md5Of(b)));
const ageDays = (iso?: string) => (iso && !Number.isNaN(Date.parse(iso)) ? (Date.now() - Date.parse(iso)) / 86_400_000 : undefined);
const animateCommand = (o: Origin, image: string, trueSize: boolean) =>
  [`ludo sprite animate --initial-image ${shellArg(isUrl(image) ? image : shown(image))}`, `--motion-prompt ${JSON.stringify(o.motion_prompt ?? "<what it does>")}`, o.model ? `--model ${o.model}` : "", trueSize ? "--frame-size -9" : ""]
    .filter(Boolean)
    .join(" ");

// Distinct solid colours, as 24-bit keys.
function paletteOf(frames: Image[], masks: Uint8Array[]): Set<number> {
  const set = new Set<number>();
  frames.forEach((f, i) => {
    for (let p = 0; p < masks[i].length; p++) if (masks[i][p]) set.add((f.rgba[p * 4] << 16) | (f.rgba[p * 4 + 1] << 8) | f.rgba[p * 4 + 2]);
  });
  return set;
}

// Which given sheet an argument names: its path, its file name (with or
// without the extension) or its position from 1.
function sheetIndex(key: string, files: string[]): number {
  const byPos = Number(key);
  if (Number.isInteger(byPos) && byPos >= 1 && byPos <= files.length) return byPos - 1;
  return files.findIndex(f => path.resolve(f) === path.resolve(key) || baseOf(f) === key || path.basename(f) === key);
}

type Cause = "scale" | "input_image" | "pose_or_image" | "pose";

TOOLS.push({
  group: "sprite",
  name: "compare",
  args: "<sheet>...",
  summary: "One character's sheets side by side: how big each is drawn, one pixels per unit for all, frame size, ground, pivot, fps",
  details: [
    "Sheets are grouped by character: from their file names (knight_walk.png, FrogIdle.png), else their",
    "folders' (knight/idle.png; Ludo's fp_hero_walk2/animateSprite-....png is fp_hero) unless the folder",
    "only says where files are kept (ludo-output, sprites, assets), else the input image the asset log",
    "(ludo-assets.json, beside the sheet or above it) says they were animated from. Sheets none of these",
    "names are not compared for size: pass --character to take them as one. Sheets of different",
    "characters are never compared with each other.",
    "",
    "Within a character each sheet's body height is measured as `sprite metrics` does: the median frame's",
    "body, the art without parts under about a third of its thickness across (a blade, a spear, a staff,",
    "a slash trail), from its top to the feet. The reference is the sheet given with --reference, else the",
    "one of median height (among those animated from the input image most of them share, when the asset",
    `logs say). A sheet more than ${SIZE_TOLERANCE * 100}% taller or shorter than the reference is flagged, with`,
    "the likely cause: a different input image (when the asset logs say so), the export's scale (frame",
    "sizes or ground lines differ), or, when the frame size and ground line match the reference's (as",
    "True Size sheets of one input image do), the pose or the input image, not the scale. A thick weapon",
    "held against the body counts as body, so a raised one can hide or fake a difference. For the",
    "export's scale there are two ways to one size: re-export Ludo's sheets at True Size (each frame at",
    "its input image's size), or keep them and scale them to one body height with `sprite pack`.",
    "",
    "Pixels per unit: one number for the character, the reference's body height over its height in the",
    "game (--reference walk.png=1.8m, or cm, mm, u), else over 2 units. For Unity, pass it to `sprite",
    "export --engine unity --ppu` for every sheet of the character, and to `sprite collide --ppu` (Unity",
    "and Box2D). Godot 2D draws one pixel per unit, so it takes none; a Sprite3D takes its inverse as",
    "pixel_size (listed). Also listed, without deciding: frame sizes, the ground line (pixels",
    "above the frame's bottom, under the feet pivot; within 1% of the frame height, 2 px at least, counts",
    "as the same), pivots (within 2% of the frame), fps, and for pixel art (256 colours or fewer) the share",
    "of pixels in colours the others use. Different frame sizes and ground lines line up once each sheet",
    "has its feet pivot (`sprite export --pivot feet`). It only reports."
  ],
  flags: [
    { flag: "--reference", value: "sheet=height", description: "A sheet and its character's height in the game: walk.png=1.8m (one per character)" },
    { flag: "--character", value: "name", description: "Take every sheet as this one character, whatever their names" },
    { flag: "--grid", value: "[sheet=]CxR", description: "A sheet's grid, when it has no Ludo stamp and detection is unsure (as for sprite pack)" },
    ALPHA
  ],
  async run(ctx: Ctx, call: ToolCall) {
    if (!call.args.length) throw new CliError("Usage: ludo toolbox sprite compare <sheet>... [--reference walk.png=1.8m]", EXIT.USAGE);
    const threshold = alphaThreshold(call);
    const files = call.args;
    const grids = perSheetGrid(call, files);
    const refs = new Map<number, number>();
    for (const raw of call.lists.get("--reference") ?? []) {
      const at = raw.lastIndexOf("=");
      if (at <= 0) throw new CliError(`--reference takes sheet=height, like walk.png=1.8m (got "${raw}")`, EXIT.USAGE);
      const i = sheetIndex(raw.slice(0, at), files);
      if (i < 0) throw new CliError(`--reference ${raw}: ${raw.slice(0, at)} is not one of the sheets`, EXIT.USAGE, "Name one of the sheets given, by its path, file name or position.");
      refs.set(i, parseHeight(raw.slice(at + 1), "--reference"));
    }
    const named = textFlag(call, "--character");
    const logs = new AssetLogs();
    const rows = files.map((file, i) => {
      const sheet = readSheet({ ...call, flags: new Map([...call.flags].filter(([k]) => k !== "--grid").concat(grids[i] ? [["--grid", grids[i]!]] : [])) }, file, threshold);
      const s = metricsOrFail(sheet.masks, sheet.fw, sheet.fh, { kind: "feet", asked: true }, sheet.src.file, threshold);
      const origin = logs.origin(file);
      const byName = named ?? characterName(file);
      const byImage = !byName && origin?.image ? baseOf(origin.image) : "";
      return {
        i,
        sheet,
        s,
        origin,
        height: s.body.height,
        // Above the frame's bottom, under the feet pivot (the ground line a jump lands on).
        groundUp: s.pivot.kind === "feet" ? sheet.fh - s.pivot.y : s.ground.above_bottom,
        character: byName || (byImage ? `${byImage} (input image)` : ""),
        character_from: named !== undefined ? "--character" : byName ? "name" : byImage ? "asset log: the input image" : "nothing",
        palette: paletteOf(sheet.frames, sheet.masks)
      };
    });
    const groups = new Map<string, typeof rows>();
    for (const r of rows) groups.set(r.character, [...(groups.get(r.character) ?? []), r]);

    const spread = (vs: number[]) => Math.max(...vs) - Math.min(...vs);
    const sheetInfo = (r: (typeof rows)[number]) => ({
      sheet: shown(r.sheet.src.file),
      frames: r.sheet.grid.frames,
      frame_width: r.sheet.fw,
      frame_height: r.sheet.fh,
      body_height: r.height,
      art_height: r.s.art.height,
      ground_above_bottom: r.groundUp,
      pivot: { x: r.s.pivot.x, y: r.s.pivot.y, kind: r.s.pivot.kind },
      fps: r.sheet.grid.fps,
      palette_size: r.palette.size,
      character_from: r.character_from,
      ...(r.origin
        ? {
            asset_log: {
              log: shown(r.origin.log),
              ...(r.origin.image ? { input_image: isUrl(r.origin.image) ? r.origin.image : shown(r.origin.image) } : {}),
              ...(r.origin.true_size !== undefined ? { true_size: r.origin.true_size } : {}),
              ...(r.origin.made ? { made: r.origin.made } : {}),
              ...(r.origin.url ? { spritesheet_url: r.origin.url } : {}),
              ...(r.origin.job ? { job_id: r.origin.job } : {})
            }
          }
        : {})
    });

    const characters = [...groups].map(([character, list]) => {
      // Nothing says which character these are: their sizes are not compared.
      if (!character) {
        return {
          character: null,
          sheets: list.map(sheetInfo),
          note: "nothing says which character these are (their names, their folders' or an asset log's input image): their sizes are not compared. Pass --character <name> to take them as one character."
        };
      }
      const given = list.filter(r => refs.has(r.i));
      if (given.length > 1) throw new CliError(`--reference names ${given.length} sheets of ${character}: give one per character`, EXIT.USAGE);
      // Without --reference: the sheet of median height among those animated
      // from the input image most of them share, when the asset logs say.
      const kin = (r: (typeof list)[number]) => list.filter(o => sameImage(o.origin?.image, r.origin?.image));
      const most = Math.max(...list.map(r => kin(r).length));
      const pool = most > 1 ? list.filter(r => kin(r).length === most && sameImage(r.origin?.image, list.find(o => kin(o).length === most)!.origin?.image)) : list;
      const ref = given[0] ?? [...pool].sort((a, b) => a.height - b.height)[Math.floor((pool.length - 1) / 2)];
      const metres = refs.get(ref.i) ?? ASSUMED_HEIGHT;
      const groundUp = list.map(r => r.groundUp);
      const groundTol = Math.max(2, 0.01 * Math.max(...list.map(r => r.sheet.fh)));
      const px = list.map(r => r.s.pivot.x / r.sheet.fw);
      const py = list.map(r => r.s.pivot.y / r.sheet.fh);
      const pixelArt = list.every(r => r.palette.size <= 256);
      const refTs = ref.origin?.true_size ?? false;
      // Godot's offset for the feet pivot, the same for every sheet?
      const lineUp = list.every(r => r.sheet.fw === list[0].sheet.fw && r.sheet.fh === list[0].sheet.fh && r.s.pivot.x === list[0].s.pivot.x && r.s.pivot.y === list[0].s.pivot.y);
      // True Size draws every sheet at its input image's size, which can be
      // smaller than the art wants: scaling the sheets to one body height is
      // the other way to one size.
      const pack = `ludo toolbox sprite pack ${list.map(r => shellArg(shown(r.sheet.src.file))).join(" ")}${character ? ` --name ${character}` : ""}`;
      const sheets = list.map(r => {
        const size = r4(r.height / ref.height);
        const info = { ...sheetInfo(r), size_vs_reference: size, ...(r === ref ? { reference: true } : {}) };
        if (Math.abs(size - 1) <= SIZE_TOLERANCE) return info;
        const pct = `${Math.round(Math.abs(size - 1) * 100)}% ${size > 1 ? "larger" : "smaller"}`;
        const o = r.origin;
        const framed = r.sheet.fw === ref.sheet.fw && r.sheet.fh === ref.sheet.fh && (Math.abs(r.groundUp - ref.groundUp) <= groundTol || (!!o?.true_size && refTs));
        let cause: Cause;
        let why: string;
        let fix: string | undefined;
        if (o?.image && ref.origin?.image && !sameImage(o.image, ref.origin.image)) {
          cause = "input_image";
          why = `its body is ${pct} than the reference's, and it was animated from another input image (${isUrl(o.image) ? o.image : shown(o.image)}; the reference from ${isUrl(ref.origin.image) ? ref.origin.image : shown(ref.origin.image)}), which draws the character at its own size: re-exporting it does not change that, animating this move again from the reference's image does`;
          fix = animateCommand(o, ref.origin.image, refTs);
        } else if (framed) {
          const same = sameImage(o?.image, ref.origin?.image);
          cause = same ? "pose" : "pose_or_image";
          why = `its body is ${pct} than the reference's at the same frame size and ground line${o?.true_size && refTs ? " (both True Size)" : ""}, so the export did not scale it: ${same ? "both come from the same input image, so it is the pose (a crouch, a lunge, a bow)" : "it is the pose (a crouch, a lunge) or a different input image; the asset log beside a Ludo sheet would say which image it was animated from"}`;
        } else {
          cause = "scale";
          const age = ageDays(o?.made);
          if (o?.image && age !== undefined && age > ADJUST_DAYS) {
            why = `drawn ${pct} than the reference: at one pixels per unit the character ${size > 1 ? "grows" : "shrinks"} in this animation. Exported at True Size, every sheet of the character keeps the size and place of its input image, but \`ludo sprite adjust\` only takes spritesheets made in the last ${ADJUST_DAYS} days and this one is from ${o.made!.slice(0, 10)}: animate the move again at True Size (it costs credits), and the character's other sheets too unless they are True Size already`;
            fix = animateCommand(o, o.image, true);
          } else {
            why = `drawn ${pct} than the reference: at one pixels per unit the character ${size > 1 ? "grows" : "shrinks"} in this animation. If Ludo made the character's sheets, re-export each at True Size (free): every frame keeps the size and place of its input image${r.sheet.fw === ref.sheet.fw && r.sheet.fh === ref.sheet.fh ? ". Its frame size is the reference's but its ground line is not: if both are True Size already, the cause is the input image or the pose, and re-exporting changes nothing" : ""}`;
            fix = o?.url
              ? `ludo sprite adjust --spritesheet-url ${o.url} --frame-size -9`
              : `ludo sprite adjust --spritesheet-url <its spritesheet_url${o?.job ? `, from \`ludo jobs get ${o.job}\`` : ""}> --frame-size -9`;
          }
        }
        if (cause === "scale") why += `. Or keep the sheets as they are and scale them to one body height and ground line, free and offline: ${pack}`;
        return { ...info, outlier: why, cause, ...(fix ? { fix } : {}), ...(cause === "scale" ? { alternative: pack } : {}) };
      });
      const shared = pixelArt
        ? list.map((r, i) => {
            const others = new Set(list.flatMap((o, j) => (j === i ? [] : [...o.palette])));
            let [inOthers, total] = [0, 0];
            r.sheet.frames.forEach((f, k) => {
              for (let p = 0; p < r.sheet.masks[k].length; p++) {
                if (!r.sheet.masks[k][p]) continue;
                total++;
                if (others.has((f.rgba[p * 4] << 16) | (f.rgba[p * 4 + 1] << 8) | f.rgba[p * 4 + 2])) inOthers++;
              }
            });
            return total ? r2(inOthers / total) : 1;
          })
        : undefined;
      // The same input image in another pose is not a size to fix.
      const outliers = sheets.filter(x => "cause" in x && x.cause !== "pose").map(x => x.sheet);
      return {
        character,
        reference: { sheet: shown(ref.sheet.src.file), body_height: ref.height, height_m: metres, ...(refs.has(ref.i) ? {} : { assumed: `${ASSUMED_HEIGHT} units: pass --reference <sheet>=<height> for its real height` }) },
        pixels_per_unit: r2(ref.height / metres),
        godot: {
          pixel_size: r4(metres / ref.height),
          ...(list.length > 1 && !lineUp
            ? { one_node: "the frame sizes or feet pivots differ, so the sheets need different offsets: on one AnimatedSprite2D (one offset for all its animations) they do not line up. Keep one node per sheet (each `sprite export --engine godot --pivot feet` scene), or change its offset with the animation" }
            : {})
        },
        sheets,
        ...(list.length > 1
          ? {
              consistent: !outliers.length,
              outliers,
              checks: {
                body_height: { consistent: !outliers.length, tolerance: SIZE_TOLERANCE, values: list.map(r => r.height) },
                frame_size: { same: list.every(r => r.sheet.fw === list[0].sheet.fw && r.sheet.fh === list[0].sheet.fh), values: list.map(r => `${r.sheet.fw}x${r.sheet.fh}`) },
                ground: { same: spread(groundUp) <= groundTol, values: groundUp, spread: spread(groundUp) },
                pivot: { same: spread(px) <= 0.02 && spread(py) <= 0.02, values: list.map((_, i) => [r4(px[i]), r4(py[i])]) },
                fps: { same: list.every(r => r.sheet.grid.fps === list[0].sheet.grid.fps), values: list.map(r => r.sheet.grid.fps), note: "different fps can be on purpose" },
                palette: shared ? { same: shared.every(v => v >= 0.9), pixels_in_shared_colours: shared } : { note: "more than 256 colours: painted art, palettes not compared" }
              },
              note: "frame sizes, ground lines and pivots may differ: each sheet's feet pivot (sprite export --pivot feet) lines them up"
            }
          : {})
      };
    });

    const judged = characters.filter((c): c is Extract<(typeof characters)[number], { reference: unknown }> => c.character !== null);
    const toFix = judged.flatMap(c => c.sheets).find(x => "fix" in x && x.fix && x.cause !== "pose") as { fix: string; cause: Cause; alternative?: string } | undefined;
    const first = judged[0];
    // A sheet drawn at another scale: one size by scaling the sheets works
    // on any of them now, so it is the hint; True Size is in the outlier.
    const next = toFix
      ? toFix.alternative
        ? hint("Bring the character's sheets to one size and ground line (or see the outlier for True Size)", toFix.alternative)
        : hint(toFix.cause === "input_image" ? "Animate the move again from the reference's input image" : "Animate the move again at True Size", toFix.fix)
      : first
        ? hint("Write each sheet's engine files with its feet pivot and the character's pixels per unit", `ludo toolbox sprite export ${shellArg(first.reference.sheet)} --engine unity --pivot feet --ppu ${first.pixels_per_unit}`)
        : hint("Name the character to compare these sheets", `ludo toolbox sprite compare ${files.map(f => shellArg(shown(f))).join(" ")} --character <name>`);
    const consistent = judged.every(c => c.consistent !== false);
    if (ctx.jsonOut) {
      printJson({ characters, consistent, ...(ctx.globals.quiet ? {} : { hint: next }) }, false);
    } else {
      const out = (line: string) => process.stdout.write(line + "\n");
      for (const c of characters) {
        out(`${c.character ?? "(no character)"}: ${c.sheets.length} sheet${c.sheets.length > 1 ? "s" : ""}`);
        const width = Math.max(...c.sheets.map(r => r.sheet.length));
        out(`  ${"".padEnd(width)}  frame      body  ground  pivot          fps    size`);
        for (const r of c.sheets) {
          const size = "size_vs_reference" in r ? `${r.size_vs_reference}${"reference" in r ? " (reference)" : ""}` : "-";
          out(`  ${r.sheet.padEnd(width)}  ${`${r.frame_width}x${r.frame_height}`.padEnd(9)}  ${String(r.body_height).padStart(4)}  ${String(r.ground_above_bottom).padStart(6)}  ${`${r.pivot.x},${r.pivot.y} ${r.pivot.kind}`.padEnd(13)}  ${String(r.fps).padEnd(5)}  ${size}`);
          if ("outlier" in r) out(`    ${r.outlier}.${r.fix ? `\n    Fix: ${r.fix}` : ""}`);
        }
        if (!("reference" in c)) {
          out(`  ${c.note}`);
          continue;
        }
        const ref = c.reference;
        out(`  Pixels per unit ${c.pixels_per_unit} for every sheet (Godot Sprite3D pixel_size ${c.godot.pixel_size}): the reference's ${ref.body_height} px body as ${ref.height_m} ${ref.assumed ? "units, assumed" : "m"}`);
        if (c.godot.one_node) out(`  Godot: ${c.godot.one_node}.`);
        if (c.consistent !== undefined) out(c.consistent ? `  Drawn at one size (bodies within ${SIZE_TOLERANCE * 100}%, or the same input image in another pose).` : `  Not drawn at one size: ${c.outliers!.join(", ")}.`);
      }
      if (!ctx.globals.quiet) process.stderr.write(`Next: ${next.text}: ${next.command}\n`);
    }
    return EXIT.OK;
  }
});

// --grid for compare, as sprite pack takes it: CxR for all, or sheet=CxR by
// file name or position.
function perSheetGrid(call: ToolCall, files: string[]): (string | undefined)[] {
  const out: (string | undefined)[] = files.map(() => undefined);
  for (const raw of call.lists.get("--grid") ?? []) {
    const eq = raw.indexOf("=");
    if (eq < 0) {
      out.fill(raw);
      continue;
    }
    const key = raw.slice(0, eq);
    const i = sheetIndex(key, files);
    if (i < 0) throw new CliError(`--grid ${raw}: no sheet called ${key}`, EXIT.USAGE, `Name a sheet by its file name or position (1-${files.length}).`);
    out[i] = raw.slice(eq + 1);
  }
  return out;
}
