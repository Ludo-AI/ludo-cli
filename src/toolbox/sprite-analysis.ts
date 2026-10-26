// `ludo toolbox sprite metrics|collide|events|compare`: what an agent needs to wire a
// sheet in (pivot, ground, colliders, event frames), measured from its pixels.
//
// These tools only measure. They never change a sheet: what they write is
// derived data (numbers, engine snippets, an overlay to check them by eye).
// The geometry and the measures are pure functions below; the tools at the
// end read the sheet, call them and print.
//
// Coordinates are pixels from the frame's top-left corner, x right, y down,
// with pixel (x, y) covering x..x+1 and y..y+1, so a pivot under the lowest
// row of pixels sits at that row + 1. A sheet trimmed by `ludo toolbox image
// trim` is measured in its untrimmed frames, the size engines see it at.

import path from "node:path";
import { CliError, EXIT } from "../errors.js";
import { printJson, type Ctx } from "../generate.js";
import type { Image } from "../tty/png.js";
import type { Grid } from "../tty/preview.js";
import { calculateAnimationCharacterHeight } from "./packMath.js";
import { backgroundOf } from "./grid.js";
import { baseOf, freeName, loadImageFile, shown, writePng, type Loaded } from "./io.js";
import { analyseLoop, frameDifferences, VISIBLE } from "./loop.js";
import { pad } from "./pixels.js";
import { crop, sliceSheet } from "./sheet.js";
import { resolveGrid } from "./sprite.js";
import { gridFlag, positiveNumber, textFlag } from "./flags.js";
import { hint, TOOLS, type ToolCall, type ToolFlag } from "./registry.js";

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

// ---- Sheet metrics ----

export type PivotKind = "feet" | "mass" | "flag";
export type PivotChoice = { kind: "feet" | "mass" } | { kind: "flag"; at: Point };

export interface SheetMetrics {
  frame_width: number;
  frame_height: number;
  frames: FrameMeasure[];
  union: Box;
  ground: { row: number; frames_on_it: number; share: number };
  body: { width: number; height: number }; // median frame bounds
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
  const frames = masks.map(m => measureFrame(m, fw, fh));
  const solid = frames.filter(f => f.bounds);
  const union = unionBox(frames.map(f => f.bounds));
  if (!union || !solid.length) return undefined;
  const body = { width: median(solid.map(f => f.bounds!.w)), height: median(solid.map(f => f.bounds!.h)) };

  // The ground: the row most frames bottom out on, within a tolerance; on a
  // tie, the lower one.
  const tol = Math.max(1, Math.round(0.02 * body.height));
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

  const coms = solid.map(f => f.centre_of_mass!);
  const meanCom: Point = [coms.reduce((a, c) => a + c[0], 0) / coms.length, coms.reduce((a, c) => a + c[1], 0) / coms.length];
  let pivot: SheetMetrics["pivot"];
  const pct = Math.round(share * 100);
  if (choice.kind === "flag") pivot = { x: choice.at[0], y: choice.at[1], kind: "flag", why: "given with --pivot" };
  else if (choice.kind === "feet" && character) {
    // Under the body, not under the union: a sword held out would pull the
    // union's centre off the body, and the art would jump when flipped.
    pivot = { x: Math.round(median(coms.map(c => c[0]))), y: ground.row + 1, kind: "feet", why: `${pct}% of frames stand on row ${ground.row}: on the ground line, under the body's centre (the median centre of mass)` };
  } else {
    const why = choice.kind === "mass" ? "asked with --pivot mass" : share < GROUNDED_SHARE ? `no ground line: only ${pct}% of frames bottom out on one row` : `its lowest row (${ground.row}) is in the top two thirds of the frame, so it does not stand on it`;
    pivot = { x: Math.round(meanCom[0]), y: Math.round(meanCom[1]), kind: "mass", why: `${why}: the centre of mass, averaged over frames` };
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
  // Travel under a tenth of the body's size is sway, not travel.
  const moves = [Math.abs(dx) >= 0.1 * body.width ? `${dx > 0 ? "right" : "left"} ${Math.round(Math.abs(dx))} px` : "", Math.abs(dy) >= 0.1 * body.height ? `${dy > 0 ? "down" : "up"} ${Math.round(Math.abs(dy))} px` : ""].filter(Boolean);
  const verdict = moves.length ? `moves ${moves.join(" and ")} over the clip: the motion is in the art (root motion), not only in place` : "in place";

  return {
    frame_width: fw,
    frame_height: fh,
    frames,
    union,
    ground: { row: ground.row, frames_on_it: ground.frames_on_it, share: r2(share) },
    body,
    character,
    pivot,
    drift: { x: r2(dx), y: r2(dy), per_frame: [r2(fx.slope), r2(fy.slope)], sway: [r2(fx.sway), r2(fy.sway)], verdict }
  };
}

// A suggested Unity pixels-per-unit: the character about 2 units tall, a
// size Unity's 2D physics handles well. Any value works if every sprite of
// a game shares it.
export const suggestedPpu = (bodyHeight: number) => Math.max(1, Math.round(bodyHeight / 2));
const UNITY_EXPORT_PPU = 100; // what `sprite export --engine unity` writes

export function engineValues(s: SheetMetrics, trim?: Loaded["trim"]) {
  const { frame_width: fw, frame_height: fh, pivot: p } = s;
  // Unity pivots each sprite in its own rect: for a trimmed sheet, the
  // trimmed rect (as `sprite export --engine unity` slices it).
  const unityPivot: Point = trim ? [r4((p.x - trim.x) / trim.w), r4((trim.y + trim.h - p.y) / trim.h)] : [r4(p.x / fw), r4(1 - p.y / fh)];
  const ppu = suggestedPpu(s.body.height);
  return {
    godot: {
      // Sprite2D / AnimatedSprite2D: with `centered` on (Godot's default),
      // `offset` moves the art from the node's origin; this puts the pivot there.
      centered: true,
      offset: [fw / 2 - p.x, fh / 2 - p.y] as Point,
      uncentered: { centered: false, offset: [-p.x, -p.y] as Point }
    },
    unity: {
      pivot: unityPivot,
      ...(trim ? { pivot_of: "each sprite's trimmed rect" } : {}),
      pixels_per_unit: ppu,
      ppu_why: `the character's ${s.body.height} px about 2 units tall; ${UNITY_EXPORT_PPU} is what \`sprite export --engine unity\` writes`
    },
    phaser: { origin: [r4(p.x / fw), r4(p.y / fh)] as Point }
  };
}

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

// The smallest circle holding every point (Welzl 1991, incremental form).
export function enclosingCircle(points: Point[]): { x: number; y: number; r: number } {
  const inC = (c: { x: number; y: number; r: number }, p: Point) => Math.hypot(p[0] - c.x, p[1] - c.y) <= c.r + 1e-9;
  const two = (a: Point, b: Point) => ({ x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2, r: Math.hypot(a[0] - b[0], a[1] - b[1]) / 2 });
  const three = (a: Point, b: Point, c: Point) => {
    const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
    if (!d) return two(a, b);
    const sq = (p: Point) => p[0] ** 2 + p[1] ** 2;
    const x = (sq(a) * (b[1] - c[1]) + sq(b) * (c[1] - a[1]) + sq(c) * (a[1] - b[1])) / d;
    const y = (sq(a) * (c[0] - b[0]) + sq(b) * (a[0] - c[0]) + sq(c) * (b[0] - a[0])) / d;
    return { x, y, r: Math.hypot(a[0] - x, a[1] - y) };
  };
  let c = { x: points[0][0], y: points[0][1], r: 0 };
  for (let i = 1; i < points.length; i++) {
    if (inC(c, points[i])) continue;
    c = { x: points[i][0], y: points[i][1], r: 0 };
    for (let j = 0; j < i; j++) {
      if (inC(c, points[j])) continue;
      c = two(points[i], points[j]);
      for (let k = 0; k < j; k++) if (!inC(c, points[k])) c = three(points[i], points[j], points[k]);
    }
  }
  return c;
}

// Erosion by `n` pixels: Borgefors' 3-4 chamfer distance to the nearest
// empty pixel (past the frame's edge counts as empty), kept when over 3n.
export function erode(m: Uint8Array, w: number, h: number, n: number): Uint8Array {
  if (n <= 0) return m;
  const d = new Int32Array(w * h);
  for (let p = 0; p < d.length; p++) d[p] = m[p] ? 1 << 29 : 0;
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : d[y * w + x]);
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
  return Uint8Array.from(d, v => (v > 3 * n ? 1 : 0));
}

export interface Shapes {
  box: { x: number; y: number; w: number; h: number };
  circle: { x: number; y: number; r: number };
  // Axis-aligned along its long side; height is end to end, caps included.
  capsule: { x: number; y: number; radius: number; height: number; direction: "vertical" | "horizontal" };
  hull: Point[];
  polygons: Point[][]; // one per piece, largest first
  specks: number; // pieces too small to keep
}

// A piece smaller than this share of the largest is a speck (a stray pixel,
// a spark), left out of every shape.
const SPECK = 0.02;

// Collision shapes of a mask, in frame pixels (x right, y down).
export function shapesOf(m: Uint8Array, w: number, h: number, tolerance: number): Shapes | undefined {
  const { labels, areas } = components(m, w, h);
  if (!areas.length) return undefined;
  const big = Math.max(...areas);
  const kept = areas.map((a, k) => (a >= Math.max(1, SPECK * big) ? k : -1)).filter(k => k >= 0).sort((a, b) => areas[b] - areas[a]);
  const keep = new Uint8Array(areas.length);
  kept.forEach(k => (keep[k] = 1));

  // Per row (and per column) the outermost kept pixels: enough for the box,
  // the hull (their outer corners) and the capsule's body width.
  const rowL = new Int32Array(h).fill(-1);
  const rowR = new Int32Array(h).fill(-1);
  const colT = new Int32Array(w).fill(-1);
  const colB = new Int32Array(w).fill(-1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = labels[y * w + x];
      if (k < 0 || !keep[k]) continue;
      if (rowL[y] < 0) rowL[y] = x;
      rowR[y] = x;
      if (colT[x] < 0) colT[x] = y;
      colB[x] = y;
    }
  }
  const rows = [...rowL.keys()].filter(y => rowL[y] >= 0);
  const cols = [...colT.keys()].filter(x => colT[x] >= 0);
  const box = { x: Math.min(...rows.map(y => rowL[y])), y: rows[0], w: 0, h: rows[rows.length - 1] + 1 - rows[0] };
  box.w = Math.max(...rows.map(y => rowR[y])) + 1 - box.x;
  const corners: Point[] = rows.flatMap(y => [[rowL[y], y], [rowL[y], y + 1], [rowR[y] + 1, y], [rowR[y] + 1, y + 1]] as Point[]);
  const hull = convexHull(corners);
  const c = enclosingCircle(hull);
  // The capsule follows the body, not the whole box: its radius is half the
  // median row width (column height, lying down), so a sword or a cape held
  // out in a few rows stays outside it.
  const vertical = box.h >= box.w;
  const spans = vertical ? rows.map(y => [rowL[y], rowR[y] + 1]) : cols.map(x => [colT[x], colB[x] + 1]);
  const radius = Math.min(median(spans.map(([a, b]) => (b - a) / 2)), (vertical ? box.w : box.h) / 2);
  const mid = median(spans.map(([a, b]) => (a + b) / 2));
  const length = Math.max(vertical ? box.h : box.w, 2 * radius);
  const capsule = vertical
    ? { x: mid, y: box.y + box.h / 2, radius, height: length, direction: "vertical" as const }
    : { x: box.x + box.w / 2, y: mid, radius, height: length, direction: "horizontal" as const };
  const polygons = kept.map(k => simplifyClosed(traceOutline(labels, w, h, k), tolerance)).filter(p => p.length >= 3);
  return { box, circle: c, capsule, hull, polygons, specks: areas.length - kept.length };
}

// The same shapes with their coordinates relative to a point (the pivot).
export function shapesFrom(s: Shapes, [px, py]: Point): Shapes {
  const at = (p: Point): Point => [r2(p[0] - px), r2(p[1] - py)];
  return {
    box: { x: s.box.x - px, y: s.box.y - py, w: s.box.w, h: s.box.h },
    circle: { x: r2(s.circle.x - px), y: r2(s.circle.y - py), r: r2(s.circle.r) },
    capsule: { ...s.capsule, x: r2(s.capsule.x - px), y: r2(s.capsule.y - py), radius: r2(s.capsule.radius), height: r2(s.capsule.height) },
    hull: s.hull.map(at),
    polygons: s.polygons.map(p => p.map(at)),
    specks: s.specks
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
  const { box, circle, capsule, hull, polygons } = rel;
  const boxCentre: Point = [box.x + box.w / 2, box.y + box.h / 2];
  const main = polygons[0] ?? hull;
  const u = (v: number) => r4(v / s.ppu);
  const up = (p: Point): Point => [u(p[0]), u(-p[1])];

  const godot = {
    box: { position: boxCentre, size: [box.w, box.h] as Point },
    circle: { position: [circle.x, circle.y] as Point, radius: circle.r },
    capsule: { position: [capsule.x, capsule.y] as Point, radius: capsule.radius, height: capsule.height, rotation_degrees: capsule.direction === "vertical" ? 0 : 90 },
    hull: { points: hull },
    polygons,
    ...(s.snippets
      ? {
          tres: {
            box: tres("RectangleShape2D", [`size = Vector2(${box.w}, ${box.h})`]),
            circle: tres("CircleShape2D", [`radius = ${num(circle.r)}`]),
            capsule: tres("CapsuleShape2D", [`radius = ${num(capsule.radius)}`, `height = ${num(capsule.height)}`]),
            hull: tres("ConvexPolygonShape2D", [`points = ${vec2s(hull)}`])
          },
          polygon_node: polygons
            .map((p, i) => [`[node name="CollisionPolygon2D${i ? i + 1 : ""}" type="CollisionPolygon2D" parent="."]`, `polygon = ${vec2s(p)}`, ""].join("\n"))
            .join("\n")
        }
      : {})
  };

  const unity = {
    pixels_per_unit: s.ppu,
    box: { offset: up(boxCentre), size: [u(box.w), u(box.h)] as Point },
    circle: { offset: up([circle.x, circle.y]), radius: u(circle.r) },
    capsule: { offset: up([capsule.x, capsule.y]), size: capsule.direction === "vertical" ? [u(2 * capsule.radius), u(capsule.height)] : [u(capsule.height), u(2 * capsule.radius)], direction: capsule.direction === "vertical" ? "Vertical" : "Horizontal" },
    // PolygonCollider2D: one path per piece, set with SetPath(i, points).
    polygon_paths: polygons.map(p => ccwUp(p).map(q => [u(q[0]), u(q[1])] as Point))
  };

  // Matter recentres a body on its polygon's centre of mass, and Phaser lines
  // the art up by the polygon's bounds, which are not the frame's: so the
  // vertices are in frame pixels and the origin is set to that centre.
  const absMain = abs.polygons[0] ?? abs.hull;
  const cm = centroid(absMain);
  const origin = (p: Point): Point => [r4(p[0] / s.fw), r4(p[1] / s.fh)];
  const verts = absMain.map(p => ({ x: r2(p[0]), y: r2(p[1]) }));
  const phaser = {
    polygon: { verts, origin: origin(cm), pivot_from_body: [r2(s.pivot[0] - cm[0]), r2(s.pivot[1] - cm[1])] as Point },
    box: { width: box.w, height: box.h, origin: origin([abs.box.x + box.w / 2, abs.box.y + box.h / 2]) },
    circle: { radius: circle.r, origin: origin([abs.circle.x, abs.circle.y]) },
    ...(s.snippets
      ? {
          snippet: [
            `const verts = ${JSON.stringify(verts)};`,
            `const sprite = this.matter.add.sprite(x, y, "<texture>", 0, { shape: { type: "fromVerts", verts } });`,
            `// Matter centres the body on the polygon's centre of mass: put that point of the frame on it.`,
            `sprite.setOrigin(${origin(cm).join(", ")});`
          ].join("\n")
        }
      : {})
  };

  // Box2D: metres (pixels / ppu), y up, from the body's origin at the pivot.
  // A polygon has 8 corners at most, so the hull is cut down to 8; the
  // outline goes in as a chain loop (one-sided, counter-clockwise).
  const hull8 = reduceConvex(ccwUp(hull), 8).map(q => [u(q[0]), u(q[1])] as Point);
  const chain = ccwUp(main).map(q => [u(q[0]), u(q[1])] as Point);
  const capEnds: [Point, Point] =
    capsule.direction === "vertical"
      ? [up([capsule.x, capsule.y - capsule.height / 2 + capsule.radius]), up([capsule.x, capsule.y + capsule.height / 2 - capsule.radius])]
      : [up([capsule.x - capsule.height / 2 + capsule.radius, capsule.y]), up([capsule.x + capsule.height / 2 - capsule.radius, capsule.y])];
  const v = (p: Point) => `{${p[0]}f, ${p[1]}f}`;
  const box2d = {
    pixels_per_metre: s.ppu,
    box: { centre: up(boxCentre), half_width: u(box.w / 2), half_height: u(box.h / 2) },
    circle: { centre: up([circle.x, circle.y]), radius: u(circle.r) },
    capsule: { centre1: capEnds[0], centre2: capEnds[1], radius: u(capsule.radius) },
    hull: hull8,
    chain,
    ...(s.snippets
      ? {
          snippet: [
            `// Box2D v3. Metres, y up, from the body's origin at the sprite's pivot.`,
            `b2Vec2 hullPoints[${hull8.length}] = {${hull8.map(v).join(", ")}};`,
            `b2Hull hull = b2ComputeHull(hullPoints, ${hull8.length});`,
            `b2Polygon polygon = b2MakePolygon(&hull, 0.0f);`,
            `b2ShapeDef shapeDef = b2DefaultShapeDef();`,
            `b2CreatePolygonShape(bodyId, &shapeDef, &polygon);`,
            `b2Capsule capsule = {${v(capEnds[0])}, ${v(capEnds[1])}, ${u(capsule.radius)}f};`,
            `b2Circle circle = {${v(up([circle.x, circle.y]))}, ${u(circle.r)}f};`
          ].join("\n")
        }
      : {})
  };
  return { godot, unity, phaser, box2d };
}

// ---- Events ----

export interface FrameMotion {
  frame: number;
  time_ms: number;
  motion: number; // pixels changed since the frame before, over the art's area
  reach: number; // farthest solid pixel left or right of the pivot
  extent: { w: number; h: number };
  lift: number; // how far the lowest pixel is above the ground line
  centre_of_mass: Point | null;
  contacts: Point[]; // [from, to) columns touching the ground
}

export interface AnimEvent {
  type: "foot_contact" | "impact" | "jump_apex" | "settle";
  frame: number; // 1-based
  time_ms: number;
  confidence: number;
  suggestion: true;
  side?: "left" | "right";
  active?: { start: number; end: number; start_ms: number; end_ms: number };
  takeoff?: number;
  landing?: number;
  why: string;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

// Frame-to-frame change: solid pixels that appeared or went, and pixels solid
// in both whose colour moved by more than 48 (of 765), over the mean area.
function motionOf(a: Image, ma: Uint8Array, b: Image, mb: Uint8Array): number {
  let changed = 0;
  let area = 0;
  for (let p = 0; p < ma.length; p++) {
    area += ma[p] + mb[p];
    if (ma[p] !== mb[p]) changed++;
    else if (ma[p]) {
      const i = p * 4;
      if (Math.abs(a.rgba[i] - b.rgba[i]) + Math.abs(a.rgba[i + 1] - b.rgba[i + 1]) + Math.abs(a.rgba[i + 2] - b.rgba[i + 2]) > 48) changed++;
    }
  }
  return area ? r4(changed / (area / 2)) : 0;
}

export function animationEvents(frames: Image[], masks: Uint8Array[], s: SheetMetrics, fps: number, looping: boolean): { frames: FrameMotion[]; events: AnimEvent[] } {
  const { frame_width: fw, frame_height: fh, pivot } = s;
  const n = frames.length;
  const ms = (i: number) => Math.round((i * 1000) / fps);
  const G = s.ground.row;
  // A foot that lifts by one art pixel is in the air: the band is 1% of the body's height.
  const tol = Math.max(1, Math.round(0.01 * s.body.height));
  const near = Math.max(2, Math.round(0.04 * s.body.width));

  const rows: FrameMotion[] = frames.map((f, i) => {
    const m = masks[i];
    const meas = s.frames[i];
    // Sideways, as side-view attacks strike: an arm raised overhead, or a
    // blade swung low and diagonal, reaches less far than the thrust.
    const reach = meas.bounds ? Math.max(meas.bounds.x + meas.bounds.w - pivot.x, pivot.x - meas.bounds.x) : 0;
    // Columns with a solid pixel within `tol` of the ground line, as runs;
    // runs a few pixels apart are one foot.
    const contacts: Point[] = [];
    if (s.character) {
      let runStart = -1;
      for (let x = 0; x <= fw; x++) {
        let touch = false;
        for (let y = Math.max(0, G - tol); x < fw && y <= Math.min(fh - 1, G + tol) && !touch; y++) touch = !!m[y * fw + x];
        if (touch && runStart < 0) runStart = x;
        if (!touch && runStart >= 0) {
          const last = contacts[contacts.length - 1];
          if (last && runStart - last[1] < near) last[1] = x;
          else contacts.push([runStart, x]);
          runStart = -1;
        }
      }
    }
    const prev = i > 0 ? i - 1 : looping ? n - 1 : -1;
    return {
      frame: i + 1,
      time_ms: ms(i),
      motion: prev >= 0 && prev !== i ? motionOf(frames[prev], masks[prev], f, m) : 0,
      reach: r2(reach),
      extent: { w: meas.bounds?.w ?? 0, h: meas.bounds?.h ?? 0 },
      lift: meas.ground_row === null ? 0 : Math.max(0, G - meas.ground_row),
      centre_of_mass: meas.centre_of_mass,
      contacts
    };
  });
  const events: AnimEvent[] = [];
  const at = (i: number) => (i + n) % n;
  const before = (i: number) => (i > 0 ? i - 1 : looping ? n - 1 : -1);

  // Foot contacts: a ground patch where the frame before touched nothing
  // nearby (a planted foot slides back a little in an in-place cycle, so a
  // patch within 4% of the body's width of an old one is the same foot).
  const minFoot = Math.max(2, Math.round(0.02 * s.body.width));
  if (s.character) {
    for (let i = 0; i < n; i++) {
      const p = before(i);
      if (p < 0) continue;
      for (const [a, b] of rows[i].contacts) {
        if (b - a < minFoot) continue; // a toe tip or a stray pixel
        const was = rows[p].contacts.some(([c, d]) => c < b + near && d > a - near);
        if (was) continue;
        // How clearly it was in the air: the lowest pixel over these columns
        // the frame before, against the ground line.
        let low = -1;
        for (let x = a; x < b; x++) for (let y = fh - 1; y > low; y--) if (masks[p][y * fw + x]) low = y;
        const lifted = low < 0 ? 1 : clamp01((G - low) / (3 * tol));
        const next = i + 1 < n || looping ? at(i + 1) : -1;
        const stays = next >= 0 && rows[next].contacts.some(([c, d]) => c < b + near && d > a - near);
        const cx = (a + b) / 2;
        events.push({
          type: "foot_contact",
          frame: i + 1,
          time_ms: ms(i),
          side: cx < pivot.x ? "left" : "right",
          // A foot stays planted; a blade tip that grazes the ground does not.
          confidence: r2(0.35 + 0.35 * (stays ? 1 : 0) + 0.3 * lifted),
          suggestion: true,
          why: `pixels reach the ground line at x ${a}-${b} where frame ${p + 1} had none${stays ? `, and stay down in frame ${next + 1}` : ""}`
        });
      }
    }
  }

  // Jump: frames whose lowest pixel leaves the ground line by over 6% of the
  // body's height, a tenth at the top: less is a run's flight phase.
  const airborne = rows.map(r => s.character && r.lift > Math.max(3, 0.06 * s.body.height));
  for (let i = 0; i < n; i++) {
    if (!airborne[i] || (i > 0 && airborne[i - 1])) continue;
    let j = i;
    while (j + 1 < n && airborne[j + 1]) j++;
    const run = rows.slice(i, j + 1);
    const top = Math.max(...run.map(r => r.lift));
    if (top >= 0.1 * s.body.height && i > 0) {
      const apex = run.reduce((best, r) => ((r.centre_of_mass?.[1] ?? Infinity) < (best.centre_of_mass?.[1] ?? Infinity) ? r : best));
      // Takeoff and landing: where the feet leave and touch the ground line
      // itself, a little wider than the frames clearly in the air.
      let [up, down] = [i, j + 1];
      while (up > 1 && rows[up - 1].lift > tol) up--;
      while (down < n - 1 && rows[down].lift > tol) down++;
      events.push({
        type: "jump_apex",
        frame: apex.frame,
        time_ms: apex.time_ms,
        takeoff: up + 1,
        landing: Math.min(n, down + 1),
        confidence: r2(clamp01(top / (0.25 * s.body.height)) * (run.length >= 2 ? 1 : 0.7)),
        suggestion: true,
        why: `off the ground from frame ${up + 1} to ${down} (up to ${top} px); the centre of mass is highest in frame ${apex.frame}`
      });
    }
    i = j;
  }

  // Impact: the frame of greatest reach, when it stands out (5% of the body's
  // height over the median). In a clip that does not loop, every stretch of
  // frames near the peak is a strike (a thrust, then a slash); in a loop, two
  // similar peaks are a cycle (strides, swings), so it takes one clear peak.
  const reach = rows.map(r => r.reach);
  const base = median(reach);
  const peak = Math.max(...reach);
  const prominence = (peak - base) / s.body.height;
  const windows = (vals: number[], cut: number) => {
    const out: { start: number; end: number; peak: number }[] = [];
    for (let i = 0; i < n; i++) {
      if (vals[i] < cut || (i > 0 && vals[i - 1] >= cut)) continue;
      let j = i;
      while (j + 1 < n && vals[j + 1] >= cut) j++;
      out.push({ start: i, end: j, peak: Math.max(...vals.slice(i, j + 1)) });
      i = j;
    }
    // A loop's last and first stretches are one.
    if (looping && out.length > 1 && out[0].start === 0 && out[out.length - 1].end === n - 1) {
      const last = out.pop()!;
      out[0] = { start: last.start, end: out[0].end, peak: Math.max(last.peak, out[0].peak) };
    }
    return out;
  };
  const strike = (vals: number[], what: string, enough: boolean) => {
    if (!enough) return false;
    const top = Math.max(...vals);
    const cut = median(vals) + 0.5 * (top - median(vals));
    const med = median(vals);
    const ws = windows(vals, cut).sort((a, b) => b.peak - a.peak);
    const rival = ws[1] && ws[1].peak >= med + 0.8 * (top - med);
    if (!ws.length || (looping && rival)) return false;
    for (const w of (looping ? ws.slice(0, 1) : ws.slice(0, 3))) {
      const span = Array.from({ length: ((w.end - w.start + n) % n) + 1 }, (_, k) => (w.start + k) % n);
      const f = span.reduce((a, b) => (vals[b] > vals[a] ? b : a));
      const strength = (vals[f] - med) / (top - med);
      events.push({
        type: "impact",
        frame: f + 1,
        time_ms: ms(f),
        active: { start: w.start + 1, end: w.end + 1, start_ms: ms(w.start), end_ms: ms(w.end + 1) },
        confidence: r2(Math.min(0.95, what === "reach" ? 0.4 + 2 * prominence : 0.5) * strength * (span.length > n / 2 ? 0.6 : 1)),
        suggestion: true,
        why:
          what === "reach"
            ? `the art reaches ${Math.round(vals[f])} px sideways from the pivot in frame ${f + 1}, against a median ${Math.round(med)} px${ws.length > 1 ? ` (one of ${Math.min(3, ws.length)} strikes)` : ""}`
            : `the biggest change between frames is into frame ${f + 1}`
      });
    }
    return true;
  };
  const motions = rows.map(r => r.motion);
  const medMotion = median(motions);
  // The biggest change stands in only on a clip that does not loop: in a
  // loop (an idle's blink, a breath) it is not a strike.
  if (!strike(reach, "reach", prominence >= 0.05)) strike(motions, "motion", !looping && Math.max(...motions) >= Math.max(0.05, 2 * medMotion) && !events.some(e => e.type === "jump_apex"));

  // Settle: motion falls under a quarter of the clip's median and stays
  // there (two frames, or to the end), within 3 frames of ordinary motion.
  const still = motions.map(v => v < 0.25 * medMotion);
  for (let i = 1; i < n; i++) {
    if (!still[i] || still[i - 1] || Math.max(...motions.slice(Math.max(0, i - 3), i)) < medMotion) continue;
    if (!(i + 1 >= n || still[i + 1])) continue;
    let j = i;
    while (j + 1 < n && still[j + 1]) j++;
    if (looping && j === n - 1 && i > 0 && n - i < 2) continue;
    events.push({
      type: "settle",
      frame: i + 1,
      time_ms: ms(i),
      confidence: r2(clamp01(0.5 + 0.15 * (j - i + 1)) * (1 - clamp01(motions[i] / (0.25 * medMotion)) * 0.3)),
      suggestion: true,
      why: `motion drops to ${motions[i]} (the clip's median is ${r2(medMotion)}) and stays near zero to frame ${j + 1}`
    });
    i = j;
  }
  events.sort((a, b) => a.frame - b.frame || a.type.localeCompare(b.type));
  return { frames: rows, events };
}

// What each event calls in the engine: a method on the node (Godot), a
// function on a script on the object (Unity).
const CALLS: Record<string, { godot: string; unity: string }> = {
  foot_contact: { godot: "_on_foot_contact", unity: "OnFootContact" },
  impact: { godot: "_on_attack_impact", unity: "OnAttackImpact" },
  active_start: { godot: "_on_attack_active_start", unity: "OnAttackActiveStart" },
  active_end: { godot: "_on_attack_active_end", unity: "OnAttackActiveEnd" },
  takeoff: { godot: "_on_jump_takeoff", unity: "OnJumpTakeoff" },
  jump_apex: { godot: "_on_jump_apex", unity: "OnJumpApex" },
  landing: { godot: "_on_jump_landing", unity: "OnJumpLanding" },
  settle: { godot: "_on_settle", unity: "OnSettle" }
};

// The calls in time order: an impact also opens and closes its active
// window, a jump also takes off and lands.
export function eventCalls(events: AnimEvent[], fps: number): { time: number; call: string; arg?: string }[] {
  const t = (frame: number) => r4((frame - 1) / fps);
  const out: { time: number; call: string; arg?: string }[] = [];
  for (const e of events) {
    if (e.type === "impact" && e.active) out.push({ time: t(e.active.start), call: "active_start" }, { time: t(e.active.end + 1), call: "active_end" });
    if (e.type === "jump_apex") out.push({ time: t(e.takeoff!), call: "takeoff" }, { time: t(e.landing!), call: "landing" });
    out.push({ time: t(e.frame), call: e.type, ...(e.side ? { arg: e.side } : {}) });
  }
  out.sort((a, b) => a.time - b.time);
  // Godot keeps one key per time on a track: a second call at the same
  // moment (a landing and its foot contact) goes a millisecond later.
  for (let i = 1; i < out.length; i++) if (out[i].time <= out[i - 1].time) out[i].time = r4(out[i - 1].time + 0.001);
  return out;
}

export function godotMethodTrack(name: string, calls: ReturnType<typeof eventCalls>, length: number, looping: boolean): string {
  return [
    `[gd_resource type="Animation" format=3]`,
    ``,
    `[resource]`,
    `resource_name = "${name.replace(/"/g, "")}"`,
    `length = ${num(length)}`,
    ...(looping ? [`loop_mode = 1`] : []),
    `tracks/0/type = "method"`,
    `tracks/0/imported = false`,
    `tracks/0/enabled = true`,
    `tracks/0/path = NodePath(".")`,
    `tracks/0/interp = 1`,
    `tracks/0/loop_wrap = true`,
    `tracks/0/keys = {`,
    `"times": PackedFloat32Array(${calls.map(c => num(c.time)).join(", ")}),`,
    `"transitions": PackedFloat32Array(${calls.map(() => "1").join(", ")}),`,
    `"values": [${calls.map(c => `{\n"args": [${c.arg ? `"${c.arg}"` : ""}],\n"method": &"${CALLS[c.call].godot}"\n}`).join(", ")}]`,
    `}`,
    ``
  ].join("\n");
}

export function unityEvents(calls: ReturnType<typeof eventCalls>) {
  const list = calls.map(c => ({ time: c.time, functionName: CALLS[c.call].unity, stringParameter: c.arg ?? "" }));
  const yaml = [
    "  m_Events:",
    ...list.flatMap(e => [
      `  - time: ${e.time}`,
      `    functionName: ${e.functionName}`,
      `    data: ${e.stringParameter}`,
      `    objectReferenceParameter: {fileID: 0}`,
      `    floatParameter: 0`,
      `    intParameter: 0`,
      `    messageOptions: 0`
    ])
  ].join("\n");
  return { events: list, anim_yaml: yaml };
}

// ---- Overlays: the numbers drawn on the sheet, to check them by eye ----

type Rgb = [number, number, number];
const COLOURS = {
  bounds: [0, 200, 255] as Rgb,
  union: [255, 210, 0] as Rgb,
  ground: [255, 0, 200] as Rgb,
  pivot: [255, 40, 40] as Rgb,
  mass: [60, 255, 90] as Rgb,
  sort: [255, 140, 0] as Rgb,
  polygon: [60, 255, 90] as Rgb,
  hull: [0, 200, 255] as Rgb,
  box: [255, 210, 0] as Rgb,
  circle: [255, 140, 0] as Rgb,
  capsule: [255, 0, 200] as Rgb
};

class Canvas {
  constructor(
    readonly img: Image,
    readonly thick: number
  ) {}
  dot(x: number, y: number, c: Rgb) {
    const t = this.thick;
    for (let yy = Math.round(y - t / 2); yy < Math.round(y - t / 2) + t; yy++) {
      for (let xx = Math.round(x - t / 2); xx < Math.round(x - t / 2) + t; xx++) {
        if (xx < 0 || yy < 0 || xx >= this.img.width || yy >= this.img.height) continue;
        this.img.rgba.set([...c, 255], (yy * this.img.width + xx) * 4);
      }
    }
  }
  line(a: Point, b: Point, c: Rgb, dash = 0) {
    const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1])));
    for (let i = 0; i <= steps; i++) if (!dash || Math.floor(i / dash) % 2 === 0) this.dot(a[0] + ((b[0] - a[0]) * i) / steps, a[1] + ((b[1] - a[1]) * i) / steps, c);
  }
  ring(pts: Point[], c: Rgb, dash = 0) {
    pts.forEach((p, i) => this.line(p, pts[(i + 1) % pts.length], c, dash));
  }
  rect(x: number, y: number, w: number, h: number, c: Rgb, dash = 0) {
    this.ring([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], c, dash);
  }
  circle(x: number, y: number, r: number, c: Rgb) {
    const n = Math.max(16, Math.ceil(r * 2));
    this.ring(Array.from({ length: n }, (_, i) => [x + r * Math.cos((2 * Math.PI * i) / n), y + r * Math.sin((2 * Math.PI * i) / n)] as Point), c);
  }
  cross(x: number, y: number, size: number, c: Rgb) {
    this.line([x - size, y], [x + size, y], c);
    this.line([x, y - size], [x, y + size], c);
  }
}

// The frames on a dark backdrop, laid out as the sheet, each drawn on by `draw`.
function overlaySheet(frames: Image[], grid: Grid, draw: (cv: Canvas, i: number, ox: number, oy: number) => void): Image {
  const { width: fw, height: fh } = frames[0];
  const width = fw * grid.cols;
  const height = fh * Math.ceil(frames.length / grid.cols);
  const rgba = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p++) rgba.set([34, 34, 46, 255], p * 4);
  const img = { width, height, rgba };
  frames.forEach((f, i) => {
    const [ox, oy] = [(i % grid.cols) * fw, Math.floor(i / grid.cols) * fh];
    for (let y = 0; y < fh; y++) {
      for (let x = 0; x < fw; x++) {
        const s = (y * fw + x) * 4;
        const a = f.rgba[s + 3] / 255;
        const d = ((oy + y) * width + ox + x) * 4;
        for (let k = 0; k < 3; k++) rgba[d + k] = Math.round(f.rgba[s + k] * a + rgba[d + k] * (1 - a));
      }
    }
  });
  const cv = new Canvas(img, Math.max(1, Math.round(Math.max(fw, fh) / 150)));
  frames.forEach((_, i) => {
    const [ox, oy] = [(i % grid.cols) * fw, Math.floor(i / grid.cols) * fh];
    cv.rect(ox, oy, fw, fh, [70, 70, 90]);
    draw(cv, i, ox, oy);
  });
  return img;
}

export function metricsOverlay(frames: Image[], grid: Grid, s: SheetMetrics): Image {
  return overlaySheet(frames, grid, (cv, i, ox, oy) => {
    const f = s.frames[i];
    const u = s.union;
    cv.rect(ox + u.x, oy + u.y, u.w, u.h, COLOURS.union, 6);
    cv.line([ox, oy + s.ground.row + 1], [ox + s.frame_width, oy + s.ground.row + 1], COLOURS.ground, 4);
    if (f.bounds) cv.rect(ox + f.bounds.x, oy + f.bounds.y, f.bounds.w, f.bounds.h, COLOURS.bounds);
    if (f.centre_of_mass) cv.dot(ox + f.centre_of_mass[0], oy + f.centre_of_mass[1], COLOURS.mass), cv.circle(ox + f.centre_of_mass[0], oy + f.centre_of_mass[1], cv.thick * 2, COLOURS.mass);
    cv.cross(ox + s.pivot.x, oy + s.pivot.y, Math.max(6, s.frame_width / 10), COLOURS.pivot);
  });
}

export function collideOverlay(frames: Image[], grid: Grid, shapes: (Shapes | undefined)[], pivot: Point): Image {
  return overlaySheet(frames, grid, (cv, i, ox, oy) => {
    const s = shapes.length === 1 ? shapes[0] : shapes[i];
    if (!s) return;
    const at = (p: Point): Point => [ox + p[0], oy + p[1]];
    cv.rect(ox + s.box.x, oy + s.box.y, s.box.w, s.box.h, COLOURS.box, 6);
    cv.circle(ox + s.circle.x, oy + s.circle.y, s.circle.r, COLOURS.circle);
    const c = s.capsule;
    const [hw, hh] = c.direction === "vertical" ? [c.radius, c.height / 2] : [c.height / 2, c.radius];
    const n = 48;
    const cap: Point[] = Array.from({ length: n }, (_, k) => {
      // A stadium: the box of the capsule with its short sides rounded.
      const t = (2 * Math.PI * k) / n;
      const [ex, ey] = [Math.cos(t), Math.sin(t)];
      return c.direction === "vertical"
        ? [ox + c.x + c.radius * ex, oy + c.y + (ey >= 0 ? hh - c.radius : -(hh - c.radius)) + c.radius * ey]
        : [ox + c.x + (ex >= 0 ? hw - c.radius : -(hw - c.radius)) + c.radius * ex, oy + c.y + c.radius * ey];
    });
    cv.ring(cap, COLOURS.capsule);
    cv.ring(s.hull.map(at), COLOURS.hull, 5);
    s.polygons.forEach(p => cv.ring(p.map(at), COLOURS.polygon));
    cv.cross(ox + pivot[0], oy + pivot[1], Math.max(6, frames[0].width / 10), COLOURS.pivot);
  });
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
const PIVOT: ToolFlag = { flag: "--pivot", value: "feet|mass|X,Y", description: "The pivot: on the ground line under the body, the centre of mass, or a point (default: feet for a character, else mass)" };

function alphaThreshold(call: ToolCall): number {
  const raw = call.flags.get("--alpha-threshold");
  if (raw === undefined) return 128;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 255) throw new CliError("--alpha-threshold must be a whole number from 1 to 255", EXIT.USAGE);
  return n;
}

function pivotChoice(call: ToolCall): PivotChoice {
  const raw = textFlag(call, "--pivot");
  if (call.flags.get("--pivot") === true) throw new CliError("--pivot needs a value: feet, mass or X,Y", EXIT.USAGE);
  if (raw === undefined || raw === "feet") return { kind: "feet" };
  if (raw === "mass") return { kind: "mass" };
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(raw);
  if (!m) throw new CliError(`--pivot takes feet, mass or X,Y in frame pixels, like 64,120 (got "${raw}")`, EXIT.USAGE);
  return { kind: "flag", at: [Number(m[1]), Number(m[2])] };
}

function readSheet(call: ToolCall, file: string, threshold: number): Sheet {
  const src = loadImageFile(file);
  const { grid, from } = resolveGrid(src, gridFlag(call));
  const e = src.extrude ?? 0;
  const t = src.trim;
  const frames = sliceSheet(src.image, grid.cols, grid.rows, grid.frames).map(img => {
    const cut = e ? crop(img, { x: e, y: e, w: img.width - 2 * e, h: img.height - 2 * e }) : img;
    // A trimmed sheet's frames back at their untrimmed size and place.
    return t && cut.width === t.w && cut.height === t.h ? pad(cut, { left: t.x, top: t.y, right: t.source_w - t.x - t.w, bottom: t.source_h - t.y - t.h }) : cut;
  });
  const masks = solidMasks(frames, src.image, threshold);
  return { src, grid, from, frames, masks, fw: frames[0].width, fh: frames[0].height };
}

function metricsOf(sheet: Sheet, call: ToolCall, threshold: number): SheetMetrics {
  const s = sheetMetrics(sheet.masks, sheet.fw, sheet.fh, pivotChoice(call));
  if (!s) throw new CliError(`${shown(sheet.src.file)} has no solid pixels (alpha ${threshold} and up)`, EXIT.BAD_INPUT, "Try a lower --alpha-threshold.");
  return s;
}

const gridJson = (sh: Sheet) => ({ cols: sh.grid.cols, rows: sh.grid.rows, frames: sh.grid.frames, frame_width: sh.fw, frame_height: sh.fh, fps: sh.grid.fps });
const howGrid = (from: string) => (from === "stamp" ? "from its Ludo stamp" : from === "gif" ? "the GIF's frames" : from === "webp" ? "the WebP's frames" : from === "flag" ? "from --grid" : "detected");
const pt = (p: Point) => `${r2(p[0])}, ${r2(p[1])}`;

function saveOverlay(ctx: Ctx, sheet: Sheet, img: Image, what: string): string {
  const file = freeName(ctx.outDir, `${ctx.globals.name || baseOf(sheet.src.file)}-${what}`, ".png");
  writePng(file, img);
  return file;
}

const OVERLAY: ToolFlag = { flag: "--overlay", description: "Also save the sheet with the result drawn on it, to check it by eye" };

TOOLS.push({
  group: "sprite",
  name: "metrics",
  args: "<sheet>",
  summary: "Measure each frame (bounds, ground line, centre of mass) and suggest a pivot, with engine values",
  details: [
    "Per frame: the solid pixels' bounds, the ground row (the lowest solid row) and the centre of mass.",
    "For the sheet: the union of the bounds, the ground line most frames stand on, a pivot, and drift:",
    "whether the art travels across the frame over the clip or stays in place (its sway is listed).",
    "",
    "A sheet is a character when at least half its frames bottom out on one row in the lower third of",
    "the frame: its pivot is on that ground line, under the body's centre (the median centre of mass,",
    "so a sword held out does not pull it off the body). Anything else pivots on its centre of mass.",
    "The output says which, and why; --pivot overrides it.",
    "",
    "Coordinates are frame pixels from the top-left, y down; the pivot sits on pixel edges, so feet on",
    "row 120 put it at y 121. Engine values put the pivot at the node's origin: Godot's Sprite2D offset",
    "(centered on, and off), Unity's normalised sprite pivot and a pixels-per-unit suggestion, Phaser's",
    "setOrigin. sort_point is the Y-sort origin for top-down games. It only measures: nothing is moved."
  ],
  flags: [PIVOT, ALPHA, OVERLAY, GRID],
  async run(ctx: Ctx, call: ToolCall) {
    if (call.args.length !== 1) throw new CliError("Usage: ludo toolbox sprite metrics <sheet>", EXIT.USAGE);
    const threshold = alphaThreshold(call);
    const sheet = readSheet(call, call.args[0], threshold);
    const s = metricsOf(sheet, call, threshold);
    const engines = engineValues(s, sheet.src.trim);
    const sort = sortPoint(s);
    const overlay = call.flags.has("--overlay") ? saveOverlay(ctx, sheet, metricsOverlay(sheet.frames, sheet.grid, s), "metrics") : undefined;
    const sheetArg = shown(sheet.src.file);
    const next = hint("Collision shapes from the same pivot", `ludo toolbox sprite collide ${sheetArg}`);
    if (ctx.jsonOut) {
      printJson(
        {
          sheet: sheetArg,
          grid: gridJson(sheet),
          grid_from: sheet.from,
          alpha_threshold: threshold,
          frames: s.frames.map((f, i) => ({ frame: i + 1, ...f })),
          union: s.union,
          ground: s.ground,
          body: s.body,
          character: s.character,
          pivot: s.pivot,
          drift: s.drift,
          ...engines,
          sort_point: sort,
          ...(overlay ? { overlay: shown(overlay) } : {}),
          ...(ctx.globals.quiet ? {} : { hint: next })
        },
        false
      );
    } else {
      const out = (line: string) => process.stdout.write(line + "\n");
      const u = s.union;
      out(`${sheet.grid.frames} frames of ${sheet.fw}x${sheet.fh} (${sheet.grid.cols}x${sheet.grid.rows} grid, ${howGrid(sheet.from)})`);
      out(`Art in ${u.w}x${u.h} at ${u.x},${u.y} over all frames; body ${s.body.width}x${s.body.height} (median frame)`);
      out(`Ground line: row ${s.ground.row} (${s.ground.frames_on_it} of ${s.frames.length} frames)${s.character ? "" : ", not a character"}`);
      out(`Pivot ${s.pivot.x}, ${s.pivot.y} (${s.pivot.kind}): ${s.pivot.why}`);
      out(`Drift: ${s.drift.verdict} (sway ${pt(s.drift.sway)} px)`);
      out(`Godot   centered, offset = Vector2(${pt(engines.godot.offset)})`);
      out(`Unity   pivot ${pt(engines.unity.pivot)}, pixels per unit ${engines.unity.pixels_per_unit} (suggested)`);
      out(`Phaser  setOrigin(${engines.phaser.origin.join(", ")})`);
      out(`Y-sort  ${sort.x}, ${sort.y}${sort.from_pivot[1] ? ` (${sort.from_pivot[1]} px below the pivot)` : " (the pivot)"}`);
      if (overlay) out(`Saved ${shown(overlay)}`);
      if (!ctx.globals.quiet) process.stderr.write(`Next: ${next.text}: ${next.command}\n`);
    }
    return EXIT.OK;
  }
});

TOOLS.push({
  group: "sprite",
  name: "collide",
  args: "<sheet>",
  summary: "Collision shapes from the art's alpha: box, circle, capsule, convex hull and outline polygon, for each engine",
  details: [
    "Shapes are measured on the union of all frames (one collider for the animation), or on each frame",
    "with --per-frame. Solid is alpha from --alpha-threshold up; pieces under 2% of the largest are specks",
    "and left out, and holes are filled. --inset shrinks the art by that many pixels first.",
    "",
    "  box      the bounds",
    "  circle   the smallest circle holding the art",
    "  capsule  along the long side, as wide as the median row: a sword held out stays outside it",
    "  hull     the convex hull",
    "  polygon  the outline, simplified with Douglas-Peucker to within --tolerance pixels (one per piece)",
    "",
    "Coordinates are pixels from the pivot of `ludo toolbox sprite metrics` (or --pivot), y down. Engine",
    "values follow each engine's convention: Godot (pixels, y down, .tres shapes and a CollisionPolygon2D",
    "node), Unity (units at --ppu, y up: Box/Circle/Capsule/PolygonCollider2D), Phaser Matter (frame",
    "pixels, with the origin that lines the art up on the body), Box2D v3 (metres at --ppu, y up, the",
    "hull cut to 8 corners and the outline as a chain loop). Snippets come with the union only."
  ],
  flags: [
    { flag: "--per-frame", description: "One set of shapes per frame instead of one for the whole animation" },
    { flag: "--tolerance", value: "px", description: "How far the simplified outline may stray from the art (default: 1% of its larger side, at least 1)" },
    { flag: "--inset", value: "px", description: "Shrink the art by this many pixels before measuring (default 0)" },
    { flag: "--ppu", value: "n", description: `Pixels per unit (Unity) or per metre (Box2D) (default ${UNITY_EXPORT_PPU}, what \`sprite export --engine unity\` writes)` },
    PIVOT,
    ALPHA,
    OVERLAY,
    GRID
  ],
  async run(ctx: Ctx, call: ToolCall) {
    if (call.args.length !== 1) throw new CliError("Usage: ludo toolbox sprite collide <sheet> [--per-frame]", EXIT.USAGE);
    const threshold = alphaThreshold(call);
    const rawInset = call.flags.get("--inset");
    const inset = rawInset === undefined ? 0 : Number(rawInset);
    if (!Number.isInteger(inset) || inset < 0) throw new CliError("--inset must be a whole number of pixels, 0 or more", EXIT.USAGE);
    const ppu = positiveNumber(call, "--ppu") ?? UNITY_EXPORT_PPU;
    const sheet = readSheet(call, call.args[0], threshold);
    const s = metricsOf(sheet, call, threshold);
    const pivot: Point = [s.pivot.x, s.pivot.y];
    const tolerance = positiveNumber(call, "--tolerance") ?? Math.max(1, r2(0.01 * Math.max(s.union.w, s.union.h)));
    const perFrame = call.flags.has("--per-frame");
    const { fw, fh } = sheet;

    const union = new Uint8Array(fw * fh);
    for (const m of sheet.masks) for (let p = 0; p < m.length; p++) union[p] |= m[p];
    const masks = perFrame ? sheet.masks : [union];
    const shapes = masks.map(m => shapesOf(erode(m, fw, fh, inset), fw, fh, tolerance));
    if (shapes.every(x => !x)) throw new CliError(`Nothing is left of ${shown(sheet.src.file)} after an inset of ${inset} px`, EXIT.USAGE, "Use a smaller --inset.");
    const result = shapes.map(abs => {
      if (!abs) return null;
      const rel = shapesFrom(abs, pivot);
      return { shapes: rel, engines: colliderEngines(rel, abs, { fw, fh, ppu, pivot, snippets: !perFrame }) };
    });
    const overlay = call.flags.has("--overlay") ? saveOverlay(ctx, sheet, collideOverlay(sheet.frames, sheet.grid, shapes, pivot), "collide") : undefined;
    const sheetArg = shown(sheet.src.file);
    const next = hint("Event frames (footsteps, impact) for the same sheet", `ludo toolbox sprite events ${sheetArg}`);

    if (ctx.jsonOut) {
      printJson(
        {
          sheet: sheetArg,
          grid: gridJson(sheet),
          grid_from: sheet.from,
          alpha_threshold: threshold,
          inset,
          tolerance,
          pivot: s.pivot,
          sprite_offset: engineValues(s, sheet.src.trim).godot,
          coordinates: "pixels from the pivot, x right, y down",
          ...(perFrame ? { frames: result.map((r, i) => ({ frame: i + 1, ...(r ?? { shapes: null }) })) } : result[0]!),
          ...(overlay ? { overlay: shown(overlay) } : {}),
          ...(ctx.globals.quiet ? {} : { hint: next })
        },
        false
      );
    } else {
      const out = (line: string) => process.stdout.write(line + "\n");
      out(`${sheet.grid.frames} frames of ${fw}x${fh}; shapes ${perFrame ? "per frame" : "for all frames together"}, from the pivot ${pivot.join(", ")} (${s.pivot.kind})`);
      const r = result.find(x => x);
      if (r && !perFrame) {
        const { box, circle, capsule, hull, polygons, specks } = r.shapes;
        out(`  box      ${box.w}x${box.h} at ${box.x}, ${box.y}`);
        out(`  circle   radius ${circle.r} at ${circle.x}, ${circle.y}`);
        out(`  capsule  ${capsule.direction}, radius ${capsule.radius}, height ${capsule.height} at ${capsule.x}, ${capsule.y}`);
        out(`  hull     ${hull.length} points`);
        out(`  polygon  ${polygons.map(p => p.length).join(" + ")} points (within ${tolerance} px)${specks ? `; ${specks} specks left out` : ""}`);
      } else out(`  ${result.filter(x => x).length} frames with shapes`);
      out("Engine values and snippets (Godot, Unity, Phaser, Box2D) are in the JSON: add --json.");
      if (overlay) out(`Saved ${shown(overlay)}`);
      if (!ctx.globals.quiet) process.stderr.write(`Next: ${next.text}: ${next.command}\n`);
    }
    return EXIT.OK;
  }
});

TOOLS.push({
  group: "sprite",
  name: "events",
  args: "<sheet>",
  summary: "Suggest animation event frames: foot contacts, attack impact, jump apex, settle",
  details: [
    "Every event is a suggestion read from the pixels, with a confidence from 0 to 1: check it in a",
    "preview before wiring it in.",
    "",
    "  foot_contact  pixels reach the ground line where the frame before had none: a foot planting,",
    "                left or right of the pivot by x (in a side view, front and back are not told apart)",
    "  impact        the frame where the art reaches farthest from the body, when one stretch of frames",
    "                stands out (else the biggest change), with its active window; two similar peaks",
    "                are a cycle, not a strike, and give none",
    "  jump_apex     the highest centre of mass while off the ground, with takeoff and landing frames",
    "  settle        motion drops near zero and stays there",
    "",
    "Per frame: motion (pixels changed since the frame before, over the art's area), reach, extent,",
    "lift off the ground line and the time in ms at the sheet's fps. A sheet that loops (`ludo toolbox",
    "sprite loop` scores it 0.5 or more) wraps from its last frame to its first. The calls come as a",
    "Godot Animation .tres with a method track and as Unity AnimationEvent entries (an .anim's m_Events)."
  ],
  flags: [
    { flag: "--fps", value: "n", description: "Frame rate for the times (default: the sheet's, else 10)" },
    { flag: "--animation", value: "name", description: "The animation's name in the Godot track (default: the file's name)" },
    PIVOT,
    ALPHA,
    GRID
  ],
  async run(ctx: Ctx, call: ToolCall) {
    if (call.args.length !== 1) throw new CliError("Usage: ludo toolbox sprite events <sheet>", EXIT.USAGE);
    const threshold = alphaThreshold(call);
    const sheet = readSheet(call, call.args[0], threshold);
    if (sheet.frames.length < 2) throw new CliError(`${shown(sheet.src.file)} has a single frame; there are no events in it`, EXIT.BAD_INPUT);
    const s = metricsOf(sheet, call, threshold);
    const fps = positiveNumber(call, "--fps") ?? sheet.grid.fps;
    const loop = analyseLoop(frameDifferences(sheet.frames, backgroundOf(sheet.src.image)));
    const looping = loop.quality !== null && loop.quality >= VISIBLE;
    const { frames, events } = animationEvents(sheet.frames, sheet.masks, s, fps, looping);
    const calls = eventCalls(events, fps);
    const name = textFlag(call, "--animation") ?? baseOf(sheet.src.file);
    const length = r4(sheet.frames.length / fps);
    const sheetArg = shown(sheet.src.file);
    const next = hint("Watch it play to check the suggestions", `ludo preview ${sheetArg}`);
    if (ctx.jsonOut) {
      printJson(
        {
          sheet: sheetArg,
          grid: gridJson(sheet),
          grid_from: sheet.from,
          fps,
          frame_ms: r2(1000 / fps),
          length_s: length,
          looping,
          pivot: s.pivot,
          ground_row: s.ground.row,
          note: "Every event is a suggestion read from the pixels: check it in a preview",
          events,
          frames,
          godot: { animation_tres: godotMethodTrack(name, calls, length, looping) },
          unity: unityEvents(calls),
          ...(ctx.globals.quiet ? {} : { hint: next })
        },
        false
      );
    } else {
      const out = (line: string) => process.stdout.write(line + "\n");
      out(`${sheet.grid.frames} frames at ${fps} fps (${r2(1000 / fps)} ms each)${looping ? ", looping" : ""}. Suggested events, to check in a preview:`);
      if (!events.length) out("  none stand out");
      for (const e of events) {
        const what = e.type === "foot_contact" ? `foot contact (${e.side})` : e.type === "impact" ? `impact, active frames ${e.active!.start}-${e.active!.end}` : e.type === "jump_apex" ? `jump apex (takeoff ${e.takeoff}, landing ${e.landing})` : "settle";
        out(`  frame ${String(e.frame).padStart(3)}  ${String(e.time_ms).padStart(5)} ms  ${what}  confidence ${e.confidence.toFixed(2)}`);
      }
      out("The Godot method track and Unity AnimationEvents are in the JSON: add --json.");
      if (!ctx.globals.quiet) process.stderr.write(`Next: ${next.text}: ${next.command}\n`);
    }
    return EXIT.OK;
  }
});

// Distinct solid colours, as 24-bit keys.
function paletteOf(frames: Image[], masks: Uint8Array[]): Set<number> {
  const set = new Set<number>();
  frames.forEach((f, i) => {
    for (let p = 0; p < masks[i].length; p++) if (masks[i][p]) set.add((f.rgba[p * 4] << 16) | (f.rgba[p * 4 + 1] << 8) | f.rgba[p * 4 + 2]);
  });
  return set;
}

TOOLS.push({
  group: "sprite",
  name: "compare",
  args: "<sheet> <sheet>...",
  summary: "Put several animations of one character side by side: frame size, body height, ground, pivot, fps, palette",
  details: [
    "Each sheet is one animation of the same character (idle, walk, attack...). For each: frame size,",
    "body height (frame 1's art, as `ludo toolbox sprite pack` measures it), ground line (pixels above",
    "the frame's bottom), pivot (as `ludo toolbox sprite metrics` picks it, also as a share of the frame),",
    "fps and palette size. Then whether they agree: frame sizes equal, body heights within 5%, ground",
    "lines within 1% of the frame height (2 px at least), pivots within 2% of the frame. Different fps",
    "can be on purpose and are only listed. Palettes are compared when every sheet has 256 colours or",
    "fewer (pixel art): the share of each sheet's pixels in colours the others use too.",
    "",
    "When they disagree, `ludo toolbox sprite pack` brings them to one height, ground line and frame",
    "size; the output gives the scale it would apply to each (to the shortest). It only reports."
  ],
  flags: [{ flag: "--grid", value: "[anim=]CxR", description: "A sheet's grid, when it has no Ludo stamp and detection is unsure (as for sprite pack)" }, ALPHA],
  async run(ctx: Ctx, call: ToolCall) {
    if (call.args.length < 2) throw new CliError("Usage: ludo toolbox sprite compare <sheet> <sheet>...", EXIT.USAGE);
    const threshold = alphaThreshold(call);
    const grids = perSheetGrid(call, call.args);
    const rows = call.args.map((file, i) => {
      const sheet = readSheet({ ...call, flags: new Map([...call.flags].filter(([k]) => k !== "--grid").concat(grids[i] ? [["--grid", grids[i]!]] : [])) }, file, threshold);
      const s = metricsOf(sheet, { ...call, flags: new Map() }, threshold);
      const height = calculateAnimationCharacterHeight({ frames: [{ data: sheet.frames[0].rgba, width: sheet.fw, height: sheet.fh }] });
      return { sheet, s, height, palette: paletteOf(sheet.frames, sheet.masks) };
    });
    const minH = Math.min(...rows.map(r => r.height));
    const sameSize = rows.every(r => r.sheet.fw === rows[0].sheet.fw && r.sheet.fh === rows[0].sheet.fh);
    const spread = (vs: number[]) => Math.max(...vs) - Math.min(...vs);
    const heightRatio = Math.max(...rows.map(r => r.height)) / minH;
    const groundUp = rows.map(r => r.sheet.fh - (r.s.ground.row + 1));
    const groundTol = Math.max(2, 0.01 * Math.max(...rows.map(r => r.sheet.fh)));
    const px = rows.map(r => r.s.pivot.x / r.sheet.fw);
    const py = rows.map(r => r.s.pivot.y / r.sheet.fh);
    const pixelArt = rows.every(r => r.palette.size <= 256);
    const shared = pixelArt
      ? rows.map((r, i) => {
          const others = new Set(rows.flatMap((o, j) => (j === i ? [] : [...o.palette])));
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
    const checks = {
      frame_size: { consistent: sameSize, values: rows.map(r => `${r.sheet.fw}x${r.sheet.fh}`) },
      body_height: { consistent: heightRatio <= 1.05, values: rows.map(r => r.height), ratio: r2(heightRatio) },
      ground: { consistent: spread(groundUp) <= groundTol, values: groundUp, spread: spread(groundUp) },
      pivot: { consistent: spread(px) <= 0.02 && spread(py) <= 0.02, values: rows.map((r, i) => ({ x: r.s.pivot.x, y: r.s.pivot.y, kind: r.s.pivot.kind, share: [r4(px[i]), r4(py[i])] })) },
      fps: { consistent: rows.every(r => r.sheet.grid.fps === rows[0].sheet.grid.fps), values: rows.map(r => r.sheet.grid.fps), note: "different fps can be on purpose" },
      palette: { values: rows.map(r => r.palette.size), ...(shared ? { consistent: shared.every(v => v >= 0.9), pixels_in_shared_colours: shared } : { note: "more than 256 colours: painted art, palettes not compared" }) }
    };
    const consistent = checks.frame_size.consistent && checks.body_height.consistent && checks.ground.consistent && checks.pivot.consistent;
    const names = rows.map(r => shown(r.sheet.src.file));
    const next = consistent ? undefined : hint("Bring them to one height, ground line and frame size", `ludo toolbox sprite pack ${names.join(" ")}`);
    const sheets = rows.map((r, i) => ({
      sheet: names[i],
      frames: r.sheet.grid.frames,
      frame_width: r.sheet.fw,
      frame_height: r.sheet.fh,
      body_height: r.height,
      ground_above_bottom: groundUp[i],
      pivot: { x: r.s.pivot.x, y: r.s.pivot.y, kind: r.s.pivot.kind },
      fps: r.sheet.grid.fps,
      palette_size: r.palette.size,
      pack_scale: r4(minH / r.height)
    }));
    if (ctx.jsonOut) {
      printJson({ sheets, checks, consistent, ...(ctx.globals.quiet || !next ? {} : { hint: next }) }, false);
    } else {
      const out = (line: string) => process.stdout.write(line + "\n");
      const width = Math.max(...names.map(n => n.length));
      out(`${"".padEnd(width)}  frame      body  ground  pivot          fps    colours  pack scale`);
      sheets.forEach(r =>
        out(
          `${r.sheet.padEnd(width)}  ${`${r.frame_width}x${r.frame_height}`.padEnd(9)}  ${String(r.body_height).padStart(4)}  ${String(r.ground_above_bottom).padStart(6)}  ${`${r.pivot.x},${r.pivot.y} ${r.pivot.kind}`.padEnd(13)}  ${String(r.fps).padEnd(5)}  ${String(r.palette_size).padStart(7)}  ${r.pack_scale}`
        )
      );
      const bad = Object.entries(checks)
        .filter(([, c]) => "consistent" in c && c.consistent === false)
        .map(([k]) => k.replace("_", " "));
      out(consistent ? `Consistent${bad.length ? ` in size, height, ground and pivot (differ: ${bad.join(", ")})` : ""}.` : `Not consistent: ${bad.join(", ")} differ.`);
      if (!ctx.globals.quiet && next) process.stderr.write(`Next: ${next.text}: ${next.command}\n`);
    }
    return EXIT.OK;
  }
});

// --grid for compare, as sprite pack takes it: CxR for all, or anim=CxR by
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
    const value = raw.slice(eq + 1);
    const byPos = Number(key);
    const i = Number.isInteger(byPos) && byPos >= 1 && byPos <= files.length ? byPos - 1 : files.findIndex(f => baseOf(f) === key || path.basename(f) === key);
    if (i < 0) throw new CliError(`--grid ${raw}: no sheet called ${key}`, EXIT.USAGE, `Name a sheet by its file name or position (1-${files.length}).`);
    out[i] = value;
  }
  return out;
}
