import fs from "node:fs";
import path from "node:path";
import { CliError, EXIT } from "../errors.js";
import { printJson, type Ctx } from "../generate.js";
import type { Image } from "../tty/png.js";
import { findGodotProject } from "../tty/godot.js";
import { baseOf, freeName, loadImageFile, shown, writePng, type Loaded } from "./io.js";
import { crop, sliceSheet } from "./sheet.js";
import { hexColour, positiveNumber, textFlag } from "./flags.js";
import { contentBox } from "./pixels.js";
import { resizeSmooth } from "./resample.js";
import { isEmpty as isEmptyTile, sizeFlag, tiledTsx, tileLayout, tileRects, type TileLayout, type TileRect } from "./tiles.js";
import { hint, TOOLS, type Hint, type ToolCall } from "./registry.js";
import { CONFIDENT } from "./grid.js";
import { noteFact } from "../telemetry.js";

// `ludo toolbox image nineslice|adjacency|contrast` and `video info`: tools
// that measure and report, or write the engine metadata for what they
// measured. None of them changes a pixel of the art or fills in art that is
// not there (a missing autotile case is listed, never drawn); the overlays
// they can save are separate pictures of the measurement.

const usage = (message: string) => new CliError(message, EXIT.USAGE);

const hex = (r: number, g: number, b: number) => `#${[r, g, b].map(v => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("")}`;

const round = (v: number, places = 2) => Math.round(v * 10 ** places) / 10 ** places;

// Premultiplied copy (c * a / 255, rounded): a transparent pixel is 0 0 0 0
// whatever colour it hides, so two clear pixels always compare equal.
function premultiplied(img: Image): Uint8Array {
  const out = new Uint8Array(img.rgba.length);
  for (let i = 0; i < out.length; i += 4) {
    const a = img.rgba[i + 3];
    out[i] = Math.round((img.rgba[i] * a) / 255);
    out[i + 1] = Math.round((img.rgba[i + 1] * a) / 255);
    out[i + 2] = Math.round((img.rgba[i + 2] * a) / 255);
    out[i + 3] = a;
  }
  return out;
}

// `colour` at `alpha` (0-1) over the pixels of a box, in place: the overlays'
// only drawing primitive.
function shade(img: Image, x0: number, y0: number, w: number, h: number, colour: [number, number, number], alpha: number) {
  for (let y = Math.max(0, y0); y < Math.min(img.height, y0 + h); y++) {
    for (let x = Math.max(0, x0); x < Math.min(img.width, x0 + w); x++) {
      const i = (y * img.width + x) * 4;
      const a = img.rgba[i + 3] / 255;
      const outA = alpha + a * (1 - alpha);
      for (let c = 0; c < 3; c++) img.rgba[i + c] = Math.round((colour[c] * alpha + img.rgba[i + c] * a * (1 - alpha)) / outA);
      img.rgba[i + 3] = Math.round(outA * 255);
    }
  }
}

const copy = (img: Image): Image => ({ width: img.width, height: img.height, rgba: Uint8Array.from(img.rgba) });

// Overlays are drawn on a checkerboard, so the art's transparent parts read
// as transparent and the guides show on them.
function onChecker(img: Image, cell = Math.max(4, Math.round(Math.max(img.width, img.height) / 48))): Image {
  const out = copy(img);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      const a = img.rgba[i + 3] / 255;
      const bg = ((Math.floor(x / cell) + Math.floor(y / cell)) & 1) === 0 ? 204 : 236;
      for (let c = 0; c < 3; c++) out.rgba[i + c] = Math.round(img.rgba[i + c] * a + bg * (1 - a));
      out.rgba[i + 3] = 255;
    }
  }
  return out;
}

const printHint = (ctx: Ctx, next: Hint | undefined) => {
  if (next && !ctx.globals.quiet) process.stderr.write(`Next: ${next.text}: ${next.command}\n`);
};

const hintJson = (ctx: Ctx, next: Hint | undefined) => (next && !ctx.globals.quiet ? { hint: next } : {});

function tolerance(call: ToolCall, fallback: number): number {
  const raw = textFlag(call, "--tolerance");
  if (raw === undefined) return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 0 || v > 255) throw usage(`--tolerance takes 0 to 255 colour levels (got "${raw}")`);
  return v;
}

// ---------------------------------------------------------------------------
// 9-slice: where a panel's corners end and the part that can stretch begins.
//
// Stretching a 9-slice repeats or scales the columns between the left and
// right margins (over the panel's whole height: top edge, centre and bottom
// edge alike), and the rows between the top and bottom margins. So the
// margins are where the columns stop being copies of each other: the longest
// run of columns that all match one column of it, within the tolerance,
// is the horizontal band; the same for rows. Matching one reference column,
// and not each its neighbour, keeps a slow drift (wood grain, a painted
// wash) from passing as uniform: painted art then finds no long band, and
// the tool says so instead of guessing.
//
// A band can also repeat with a period (a brick or rope border): columns
// match the column a whole number of periods away. Engines tile such a band
// instead of stretching it (Godot TILE_FIT, Unity Tiled, CSS round).
//
// Two lines match when at most 1 % of their pixels differ by more than the
// tolerance (the largest channel difference, premultiplied, alpha
// included): AI art's grain and WebP noise sit within a few levels, while a
// rivet or a gem covering a few pixels breaks the match.
// ---------------------------------------------------------------------------

type Axis = "x" | "y";

export interface Band {
  from: number; // first line of the band (inclusive)
  to: number; // last line (inclusive)
  period: number; // 1: every line alike (stretch); more: repeats every `period` lines (tile)
  confidence: number; // 0..1
  residual: number; // mean difference of the band's pixels from their reference line, in levels
  split?: { from: number; to: number }; // a second band almost as long: the stretch is in two places
}

export interface NineSlice {
  width: number;
  height: number;
  horizontal?: Band; // undefined: the columns never repeat long enough to stretch
  vertical?: Band;
  ink: { left: number; top: number; right: number; bottom: number }; // the transparent border around the art
  centre?: { fill: "solid" | "tile" | "stretch"; color: string; alpha: number };
}

class Lines {
  readonly pm: Uint8Array;
  readonly inked: { x: Uint8Array; y: Uint8Array };
  constructor(readonly img: Image) {
    this.pm = premultiplied(img);
    const { width: w, height: h, rgba } = img;
    const x = new Uint8Array(w);
    const y = new Uint8Array(h);
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) if (rgba[(yy * w + xx) * 4 + 3] >= 128) (x[xx] = 1), (y[yy] = 1);
    this.inked = { x, y };
  }
  count(axis: Axis) {
    return axis === "x" ? this.img.width : this.img.height;
  }
  // The largest channel difference of each pixel pair along lines a and b,
  // calling `each` until it returns false.
  private walk(axis: Axis, a: number, b: number, each: (d: number) => boolean) {
    const { width: w, height: h } = this.img;
    const pm = this.pm;
    const n = axis === "x" ? h : w;
    const step = axis === "x" ? w * 4 : 4;
    let i = axis === "x" ? a * 4 : a * w * 4;
    let j = axis === "x" ? b * 4 : b * w * 4;
    for (let k = 0; k < n; k++, i += step, j += step) {
      const d = Math.max(Math.abs(pm[i] - pm[j]), Math.abs(pm[i + 1] - pm[j + 1]), Math.abs(pm[i + 2] - pm[j + 2]), Math.abs(pm[i + 3] - pm[j + 3]));
      if (!each(d)) return;
    }
  }
  matches(axis: Axis, a: number, b: number, tol: number): boolean {
    if (a === b) return true;
    const allowed = Math.floor((axis === "x" ? this.img.height : this.img.width) / 100);
    let over = 0;
    this.walk(axis, a, b, d => (d > tol ? ++over <= allowed : true));
    return over <= allowed;
  }
  // The mean difference of two lines' pixels, for the residual: how close
  // a band's lines really are (noise only, or near the tolerance).
  distance(axis: Axis, a: number, b: number): number {
    let [sum, n] = [0, 0];
    this.walk(axis, a, b, d => ((sum += d), ++n, true));
    return n ? sum / n : 0;
  }
}

const mod = (a: number, p: number) => ((a % p) + p) % p;

// The longest stretch of inked lines around `ref` that each match their
// partner: `ref` itself for a uniform band, the line a whole number of
// periods away for a repeating one.
function bandAround(lines: Lines, axis: Axis, ref: number, p: number, tol: number): [number, number] {
  const inked = lines.inked[axis];
  const n = lines.count(axis);
  const ok = (x: number) => x >= 0 && x < n && inked[x] === 1 && lines.matches(axis, x, ref + mod(x - ref, p), tol);
  let a = ref;
  let b = ref;
  while (ok(a - 1)) a--;
  while (ok(b + 1)) b++;
  return [a, b];
}

function findBand(lines: Lines, axis: Axis, tol: number): Band | undefined {
  const inked = lines.inked[axis];
  const n = lines.count(axis);
  const first = inked.indexOf(1);
  if (first < 0) return undefined;
  const last = inked.lastIndexOf(1);
  const extent = last - first + 1;
  // Shorter than this is no band to stretch: a few matching lines happen
  // anywhere (inside a corner's flat part, say).
  const minLength = Math.max(3, Math.round(extent * 0.04));

  // Uniform: grow a band around reference lines spread over the art.
  const found: [number, number][] = [];
  const step = Math.max(1, Math.floor(extent / 64));
  for (let ref = first; ref <= last; ref += step) if (inked[ref]) found.push(bandAround(lines, axis, ref, 1, tol));
  found.sort((u, v) => v[1] - v[0] - (u[1] - u[0]));
  let best: [number, number] | undefined = found[0];
  let period = 1;
  const len = (r: [number, number] | undefined) => (r ? r[1] - r[0] + 1 : 0);

  // Repeating: only worth the search when no uniform band already covers
  // half the art. For each period, the longest run of lines matching the
  // line one period on; the shortest period whose run is near the longest
  // (a pattern repeating every 8 also repeats every 16), then grown as a
  // band around that run's start, so it holds against one reference period.
  if (len(best) < extent / 2) {
    const maxPeriod = Math.min(256, Math.floor(extent / 2));
    const runs: { p: number; start: number; length: number }[] = [];
    for (let p = 2; p <= maxPeriod; p++) {
      let [run, top, start] = [0, 0, 0];
      for (let x = first; x + p <= last; x++) {
        if (inked[x] && inked[x + p] && lines.matches(axis, x, x + p, tol)) {
          if (++run > top) [top, start] = [run, x - run + 1];
        } else run = 0;
      }
      // `top` lines match the line a period on, so top + p lines repeat.
      if (top >= p) runs.push({ p, start, length: top + p });
    }
    const longest = Math.max(0, ...runs.map(r => r.length));
    const pick = runs.find(r => r.length >= longest * 0.9);
    if (pick) {
      const band = bandAround(lines, axis, pick.start, pick.p, tol);
      // Whole periods only, trimmed evenly: a band that is not a whole
      // number of periods shows a jump at every repeat.
      const spare = len(band) % pick.p;
      const snapped: [number, number] = [band[0] + Math.floor(spare / 2), band[1] - Math.ceil(spare / 2)];
      if (len(snapped) >= 2 * pick.p && len(snapped) >= 1.5 * len(best)) {
        best = snapped;
        period = pick.p;
      }
    }
  }
  if (!best || len(best) < minLength) return undefined;

  const [from, to] = best;
  const ref = from;
  let residual = 0;
  for (let x = from; x <= to; x++) residual += lines.distance(axis, x, ref + mod(x - ref, period));
  residual /= len(best);
  const second = period === 1 ? found.find(r => r[1] < from || r[0] > to) : undefined;
  const split = second && len(second) >= Math.max(minLength, len(best) * 0.4) ? { from: second[0], to: second[1] } : undefined;
  // Full marks for a band of a fifth of the art or more; less for a narrow
  // one, for one that only just matches (residual near the tolerance), and
  // half for a band in two places (a centre ornament: 9-slice stretches one).
  const size = Math.min(1, len(best) / (0.2 * extent));
  const clean = 1 - 0.5 * Math.min(1, residual / Math.max(1, tol));
  const confidence = round(size * clean * (split ? 0.5 : 1));
  return { from, to, period, confidence, residual: round(residual, 1), ...(split ? { split } : {}) };
}

export function nineSlice(img: Image, tol = 8): NineSlice {
  const lines = new Lines(img);
  const horizontal = findBand(lines, "x", tol);
  const vertical = findBand(lines, "y", tol);
  const ix = lines.inked.x;
  const iy = lines.inked.y;
  const ink = ix.indexOf(1) < 0 ? { left: 0, top: 0, right: 0, bottom: 0 } : { left: ix.indexOf(1), top: iy.indexOf(1), right: img.width - 1 - ix.lastIndexOf(1), bottom: img.height - 1 - iy.lastIndexOf(1) };
  let centre: NineSlice["centre"];
  if (horizontal && vertical) {
    let [r, g, b, a, n] = [0, 0, 0, 0, 0];
    const pm = lines.pm;
    for (let y = vertical.from; y <= vertical.to; y++) {
      for (let x = horizontal.from; x <= horizontal.to; x++) {
        const i = (y * img.width + x) * 4;
        (r += pm[i]), (g += pm[i + 1]), (b += pm[i + 2]), (a += pm[i + 3]), n++;
      }
    }
    const k = a ? 255 / a : 0;
    // Both bands uniform make the centre one colour (each of its columns
    // matches one column, each row one row); a band that repeats makes it
    // a tile. "stretch" is a centre that is neither within the tolerance.
    let off = 0;
    const mean = [r / n, g / n, b / n, a / n];
    for (let y = vertical.from; y <= vertical.to; y++) {
      for (let x = horizontal.from; x <= horizontal.to; x++) {
        const i = (y * img.width + x) * 4;
        if ([0, 1, 2, 3].some(c => Math.abs(pm[i + c] - mean[c]) > 2 * tol)) off++;
      }
    }
    const fill = horizontal.period > 1 || vertical.period > 1 ? "tile" : off <= n * 0.01 ? "solid" : "stretch";
    centre = { fill, color: hex(r * k, g * k, b * k), alpha: round(a / n / 255) };
  }
  return { width: img.width, height: img.height, horizontal, vertical, ink, centre };
}

export interface Margins {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

// An axis that does not stretch gets margins of 0 and 0: shown at the
// texture's own size on that axis, the whole of it draws unscaled.
export const marginsOf = (s: NineSlice): Margins => ({
  left: s.horizontal ? s.horizontal.from : 0,
  right: s.horizontal ? s.width - 1 - s.horizontal.to : 0,
  top: s.vertical ? s.vertical.from : 0,
  bottom: s.vertical ? s.height - 1 - s.vertical.to : 0
});

// The settings each engine takes, from the margins.
//   Godot 4 NinePatchRect: patch_margin_*, axis_stretch_* (0 STRETCH, 1
//     TILE, 2 TILE_FIT): https://docs.godotengine.org/en/stable/classes/class_ninepatchrect.html
//   Unity: the sprite's border, a Vector4 of left, bottom, right, top
//     (TextureImporter.spriteBorder, the .meta's `spriteBorder`), with the
//     Image or SpriteRenderer drawn Sliced or Tiled:
//     https://docs.unity3d.com/ScriptReference/Sprite-border.html
//   CSS border-image-slice: top right bottom left, unitless = image pixels;
//     `fill` keeps the centre: https://developer.mozilla.org/en-US/docs/Web/CSS/border-image-slice
//   Phaser 3.60+: scene.add.nineslice(x, y, texture, frame, width, height,
//     leftWidth, rightWidth, topHeight, bottomHeight); it stretches only:
//     https://docs.phaser.io/api-documentation/class/gameobjects-nineslice
export function nineSliceExports(s: NineSlice, name: string, file: string) {
  const m = marginsOf(s);
  const tiles = (b?: Band) => !!b && b.period > 1;
  const cssRepeat = (b?: Band) => (tiles(b) ? "round" : "stretch");
  return {
    godot: {
      node: "NinePatchRect",
      patch_margin_left: m.left,
      patch_margin_top: m.top,
      patch_margin_right: m.right,
      patch_margin_bottom: m.bottom,
      axis_stretch_horizontal: tiles(s.horizontal) ? 2 : 0,
      axis_stretch_vertical: tiles(s.vertical) ? 2 : 0
    },
    unity: {
      sprite_border: { x: m.left, y: m.bottom, z: m.right, w: m.top },
      meta: `spriteBorder: {x: ${m.left}, y: ${m.bottom}, z: ${m.right}, w: ${m.top}}`,
      draw_mode: tiles(s.horizontal) || tiles(s.vertical) ? "Tiled" : "Sliced"
    },
    css: [
      `border-style: solid;`,
      `border-width: ${m.top}px ${m.right}px ${m.bottom}px ${m.left}px;`,
      `border-image-source: url("${file.replace(/"/g, '\\"')}");`,
      `border-image-slice: ${m.top} ${m.right} ${m.bottom} ${m.left} fill;`,
      `border-image-repeat: ${cssRepeat(s.horizontal)} ${cssRepeat(s.vertical)};`
    ].join(" "),
    phaser: `this.add.nineslice(x, y, ${JSON.stringify(name)}, undefined, width, height, ${m.left}, ${m.right}, ${m.top}, ${m.bottom})`
  };
}

function nineSliceOverlay(img: Image, s: NineSlice): Image {
  const out = onChecker(img);
  const m = marginsOf(s);
  const t = Math.max(1, Math.round(Math.max(img.width, img.height) / 256));
  // The stretch bands in cyan, the guides at the margins in magenta.
  if (s.horizontal) shade(out, s.horizontal.from, 0, s.horizontal.to - s.horizontal.from + 1, img.height, [0, 200, 255], 0.12);
  if (s.vertical) shade(out, 0, s.vertical.from, img.width, s.vertical.to - s.vertical.from + 1, [0, 200, 255], 0.12);
  if (s.horizontal) {
    shade(out, m.left - t, 0, t, img.height, [255, 0, 200], 0.9);
    shade(out, img.width - m.right, 0, t, img.height, [255, 0, 200], 0.9);
  }
  if (s.vertical) {
    shade(out, 0, m.top - t, img.width, t, [255, 0, 200], 0.9);
    shade(out, 0, img.height - m.bottom, img.width, t, [255, 0, 200], 0.9);
  }
  return out;
}

const bandJson = (b: Band | undefined) =>
  b
    ? { stretchable: b.confidence >= CONFIDENT, mode: b.period > 1 ? "tile" : "stretch", ...(b.period > 1 ? { period: b.period } : {}), band: { from: b.from, to: b.to, length: b.to - b.from + 1 }, confidence: b.confidence, residual: b.residual, ...(b.split ? { split: b.split } : {}) }
    : { stretchable: false, confidence: 0 };

TOOLS.push({
  group: "image",
  name: "nineslice",
  args: "<image>",
  summary: "Find a UI panel's or button's 9-slice margins, for Godot, Unity, CSS and Phaser",
  details: [
    "The margins are where the corners end: the longest run of columns (and of rows) that are copies of",
    "one another within --tolerance, or that repeat with a period (a rope or brick border, which engines",
    "tile instead of stretching). The JSON has the margins, each axis's band and confidence, whether the",
    "centre is a solid fill or a tile, and the settings for Godot's NinePatchRect, Unity's sprite border,",
    "CSS border-image and Phaser's nineslice. Painted art whose columns never repeat gets no margins: the",
    "tool says so (exit 12) instead of guessing. An axis that cannot stretch gets 0 and 0 (keep it at its size)."
  ],
  flags: [
    { flag: "--tolerance", value: "levels", description: "How far two pixels may differ and still match, 0-255 (default 8)" },
    { flag: "--overlay", description: "Also save the image with the bands and margins drawn on it" }
  ],
  async run(ctx: Ctx, call: ToolCall) {
    if (call.args.length !== 1) throw usage("Usage: ludo toolbox image nineslice <image> [--tolerance 8]");
    const tol = tolerance(call, 8);
    const src = loadImageFile(call.args[0]);
    if (src.grid) throw usage(`${src.file} is a spritesheet (${src.grid.cols}x${src.grid.rows}); 9-slice takes one panel or button`);
    const s = nineSlice(src.image, tol);
    const m = marginsOf(s);
    const okX = !!s.horizontal && s.horizontal.confidence >= CONFIDENT;
    const okY = !!s.vertical && s.vertical.confidence >= CONFIDENT;
    const facts = {
      image: shown(src.file),
      width: s.width,
      height: s.height,
      tolerance: tol,
      horizontal: bandJson(s.horizontal),
      vertical: bandJson(s.vertical)
    };
    if (!okX && !okY) {
      const why = (b: Band | undefined, axis: string) =>
        !b ? `no ${axis} repeat for even 4 % of the art` : `the longest ${axis} band is ${b.to - b.from + 1} px at confidence ${b.confidence}${b.split ? ", and split in two" : ""}`;
      throw new CliError(
        `No confident 9-slice for ${src.file}: ${why(s.horizontal, "columns")}; ${why(s.vertical, "rows")}`,
        EXIT.BAD_INPUT,
        "The art changes all the way across (painted or textured), so any margins would be a guess. Set them by eye, or try a higher --tolerance.",
        facts
      );
    }
    const notes: string[] = [];
    if (!okX) notes.push(`The width does not stretch cleanly: keep it at ${s.width} px (margins 0 and 0 on that axis).`);
    if (!okY) notes.push(`The height does not stretch cleanly: keep it at ${s.height} px (margins 0 and 0 on that axis).`);
    for (const [b, axis] of [[s.horizontal, "columns"], [s.vertical, "rows"]] as const) {
      if (b?.split) notes.push(`Matching ${axis} also run from ${b.split.from} to ${b.split.to}: the stretch is in two places (a centre ornament?), and 9-slice stretches one.`);
      if (b && b.period > 1) notes.push(`The ${axis} repeat every ${b.period} px: tile that band (Godot TILE_FIT, Unity Tiled, CSS round); Phaser can only stretch it.`);
    }
    const exportsFor = { horizontal: okX ? s.horizontal : undefined, vertical: okY ? s.vertical : undefined };
    const used: NineSlice = { ...s, ...exportsFor };
    const margins = marginsOf(used);
    const exp = nineSliceExports(used, baseOf(src.file), path.basename(src.file));
    const confidence = round(Math.min(...[okX ? s.horizontal!.confidence : 1, okY ? s.vertical!.confidence : 1]));
    let overlay: string | undefined;
    if (call.flags.has("--overlay")) {
      overlay = freeName(ctx.outDir, ctx.globals.name || `${baseOf(src.file)}-nineslice`, ".png");
      writePng(overlay, nineSliceOverlay(src.image, used));
    }
    const padded = s.ink.left + s.ink.top + s.ink.right + s.ink.bottom > 0;
    // A transparent border is part of every margin, and of the texture.
    const next = padded ? hint("Trim its transparent border, then measure again: the margins then start at the panel's edge", `ludo toolbox image trim ${shown(src.file)}`) : undefined;
    if (ctx.jsonOut) {
      printJson(
        {
          ...facts,
          margins,
          confidence,
          ...(s.centre && okX && okY ? { center: s.centre } : {}),
          ...(padded ? { transparent_border: s.ink } : {}),
          exports: exp,
          ...(notes.length ? { notes } : {}),
          ...(overlay ? { overlay: shown(overlay) } : {}),
          ...hintJson(ctx, next)
        },
        false
      );
    } else {
      const axis = (ok: boolean, b?: Band) => (!ok ? "fixed" : b!.period > 1 ? `tiles every ${b!.period} px` : "stretches");
      process.stdout.write(`9-slice margins: left ${margins.left}, top ${margins.top}, right ${margins.right}, bottom ${margins.bottom} (confidence ${confidence})\n`);
      process.stdout.write(`Width ${axis(okX, s.horizontal)}, height ${axis(okY, s.vertical)}${s.centre && okX && okY ? `; centre ${s.centre.fill} ${s.centre.color}` : ""}\n`);
      process.stdout.write(`Godot NinePatchRect: patch_margin_left ${margins.left}, top ${margins.top}, right ${margins.right}, bottom ${margins.bottom}\n`);
      process.stdout.write(`Unity .meta: ${exp.unity.meta} (draw mode ${exp.unity.draw_mode})\n`);
      process.stdout.write(`CSS: border-image-slice: ${margins.top} ${margins.right} ${margins.bottom} ${margins.left} fill\n`);
      process.stdout.write(`Phaser: ${exp.phaser}\n`);
      for (const n of notes) process.stdout.write(`Note: ${n}\n`);
      if (overlay) process.stdout.write(`Saved ${shown(overlay)}\n`);
      printHint(ctx, next);
    }
    return EXIT.OK;
  }
});

// ---------------------------------------------------------------------------
// Tile adjacency: which tiles of a tileset can sit next to which, from their
// edges, and the autotile layout they make, if a known one.
//
// Tiles are cut as `image tiles` cuts them (Tiled's count, with --spacing
// and --margin). Each edge is read as a strip a 1/8 of the tile deep, in 8
// segments along it (the mean premultiplied colour of each), so a road
// entering at one point of an edge is told from one entering at another,
// while the grain of painted art averages out. Two edges match when every
// segment is within the tolerance. East and west edges are grouped into
// classes, as are north and south: tile B can sit east of A when A's east
// edge and B's west edge are in one class (the rules wave function collapse
// takes).
//
// For autotiling, each tile's centre, four corners (the corner segments)
// and four edge middles (the middle two segments) are labelled by terrain
// colour. The terrain most tiles have at their centre is A; the commonest
// other one at their sides is B. Then each tile is a case of:
//   wang-edge-16    the 2-colour edge Wang set: each side A or B
//   wang-corner-16  the 2-colour corner Wang set: each corner A or B
//   blob-47         the blob: A in the centre, joined to each of the 8
//                   neighbours or not, a corner counting only when both
//                   sides next to it join (so 47 cases, not 256)
// A layout is reported when the tiles that fit its model make up at least
// half the tileset and cover at least 3/4 of its cases; the cases with no
// tile are listed, never drawn.
// ---------------------------------------------------------------------------

const SEGMENTS = 8;

type Rgba = [number, number, number, number];

interface TileEdges {
  tile: number; // Tiled's tile id: row * columns + col
  rect: TileRect;
  n: Rgba[];
  e: Rgba[];
  s: Rgba[];
  w: Rgba[];
  centre: Rgba;
}

function meanBox(pm: Uint8Array, width: number, x0: number, y0: number, x1: number, y1: number): Rgba {
  let [r, g, b, a, n] = [0, 0, 0, 0, 0];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4;
      (r += pm[i]), (g += pm[i + 1]), (b += pm[i + 2]), (a += pm[i + 3]), n++;
    }
  }
  return n ? [r / n, g / n, b / n, a / n] : [0, 0, 0, 0];
}

export function tileEdges(img: Image, rects: TileRect[], columns: number): TileEdges[] {
  const pm = premultiplied(img);
  return rects.map(r => {
    const d = Math.max(1, Math.round(Math.min(r.w, r.h) / 8));
    const along = (len: number, s: number) => [Math.floor((s * len) / SEGMENTS), Math.max(Math.floor((s * len) / SEGMENTS) + 1, Math.floor(((s + 1) * len) / SEGMENTS))];
    const seg = (side: "n" | "e" | "s" | "w") =>
      Array.from({ length: SEGMENTS }, (_, s) => {
        const [a, b] = along(side === "n" || side === "s" ? r.w : r.h, s);
        if (side === "n") return meanBox(pm, img.width, r.x + a, r.y, r.x + b, r.y + d);
        if (side === "s") return meanBox(pm, img.width, r.x + a, r.y + r.h - d, r.x + b, r.y + r.h);
        if (side === "w") return meanBox(pm, img.width, r.x, r.y + a, r.x + d, r.y + b);
        return meanBox(pm, img.width, r.x + r.w - d, r.y + a, r.x + r.w, r.y + b);
      });
    const centre = meanBox(pm, img.width, r.x + Math.floor((r.w * 3) / 8), r.y + Math.floor((r.h * 3) / 8), r.x + Math.ceil((r.w * 5) / 8), r.y + Math.ceil((r.h * 5) / 8));
    return { tile: r.row * columns + r.col, rect: r, n: seg("n"), e: seg("e"), s: seg("s"), w: seg("w"), centre };
  });
}

const colourGap = (a: Rgba, b: Rgba) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]), Math.abs(a[3] - b[3]));
const profileGap = (a: Rgba[], b: Rgba[]) => Math.max(...a.map((c, i) => colourGap(c, b[i])));

// Leader clustering: each item joins the first group whose first member it
// is within `tol` of, else starts one. Deterministic in tile order, and every
// member is within `tol` of its group's first.
function group<T>(items: T[], gap: (a: T, b: T) => number, tol: number): number[] {
  const leaders: T[] = [];
  return items.map(item => {
    const k = leaders.findIndex(l => gap(l, item) <= tol);
    if (k >= 0) return k;
    leaders.push(item);
    return leaders.length - 1;
  });
}

export type LayoutType = "wang-edge-16" | "wang-corner-16" | "blob-47";
type Terrain = "A" | "B" | "?";

// Bits of the blob mask: the 8 neighbours clockwise from north (the usual
// numbering of the 47-tile blob: N 1, NE 2, E 4, SE 8, S 16, SW 32, W 64, NW 128).
const BLOB_BITS = { n: 1, ne: 2, e: 4, se: 8, s: 16, sw: 32, w: 64, nw: 128 } as const;
const BLOB_ORDER = ["n", "ne", "e", "se", "s", "sw", "w", "nw"] as const;

// A corner bit counts only when both sides next to it are set: the 47 masks.
const reduceBlob = (m: number) => {
  let out = m & (1 | 4 | 16 | 64);
  if (m & 2 && m & 1 && m & 4) out |= 2;
  if (m & 8 && m & 4 && m & 16) out |= 8;
  if (m & 32 && m & 16 && m & 64) out |= 32;
  if (m & 128 && m & 64 && m & 1) out |= 128;
  return out;
};
export const BLOB_MASKS = [...new Set(Array.from({ length: 256 }, (_, m) => reduceBlob(m)))].sort((a, b) => a - b);

interface TileTerrain {
  centre: Terrain;
  n: Terrain;
  e: Terrain;
  s: Terrain;
  w: Terrain;
  ne: Terrain;
  se: Terrain;
  sw: Terrain;
  nw: Terrain;
}

interface LayoutFit {
  type: LayoutType;
  cases: number;
  codes: Map<number, number[]>; // case -> tile ids
  fitting: number; // tiles that fit the model
}

function fitLayout(type: LayoutType, tiles: { tile: number; t: TileTerrain }[]): LayoutFit {
  const codes = new Map<number, number[]>();
  let fitting = 0;
  const clear = (...v: Terrain[]) => v.every(x => x !== "?");
  const A = (v: Terrain) => (v === "A" ? 1 : 0);
  for (const { tile, t } of tiles) {
    let code: number | undefined;
    if (type === "wang-edge-16") {
      // A corner where both sides agree carries their colour.
      const ok = clear(t.n, t.e, t.s, t.w) && ([[t.n, t.e, t.ne], [t.e, t.s, t.se], [t.s, t.w, t.sw], [t.w, t.n, t.nw]] as Terrain[][]).every(([a, b, c]) => a !== b || c === a);
      if (ok) code = A(t.n) | (A(t.e) << 1) | (A(t.s) << 2) | (A(t.w) << 3);
    } else if (type === "wang-corner-16") {
      // A side whose corners agree is their colour at its middle.
      const ok = clear(t.ne, t.se, t.sw, t.nw) && ([[t.nw, t.ne, t.n], [t.ne, t.se, t.e], [t.sw, t.se, t.s], [t.nw, t.sw, t.w]] as Terrain[][]).every(([a, b, c]) => a !== b || c === a);
      if (ok) code = A(t.ne) | (A(t.se) << 1) | (A(t.sw) << 2) | (A(t.nw) << 3);
    } else {
      const corners: [Terrain, Terrain, Terrain][] = [[t.n, t.e, t.ne], [t.e, t.s, t.se], [t.s, t.w, t.sw], [t.w, t.n, t.nw]];
      const ok = t.centre === "A" && clear(t.n, t.e, t.s, t.w) && corners.every(([a, b, c]) => !(a === "A" && b === "A") || c !== "?");
      if (ok) code = reduceBlob(A(t.n) * 1 | A(t.ne) * 2 | A(t.e) * 4 | A(t.se) * 8 | A(t.s) * 16 | A(t.sw) * 32 | A(t.w) * 64 | A(t.nw) * 128);
    }
    if (code === undefined) continue;
    fitting++;
    codes.set(code, [...(codes.get(code) ?? []), tile]);
  }
  return { type, cases: type === "blob-47" ? 47 : 16, codes, fitting };
}

const passes = (f: LayoutFit, tiles: number) => f.fitting >= tiles / 2 && f.codes.size >= f.cases * 0.75;

export interface Adjacency {
  layout: TileLayout;
  tiles: TileEdges[];
  classes: { ew: number[]; ns: number[] }; // per tile: [e, w] and [n, s] class ids, flattened
  edgeClass: { n: string; e: string; s: string; w: string }[];
  terrains: { id: "A" | "B"; color: string; alpha: number }[];
  terrainOf: TileTerrain[];
  fits: LayoutFit[];
  detected?: LayoutFit;
}

export function adjacency(img: Image, layout: TileLayout, tol = 16): Adjacency {
  const rects = tileRects(layout).filter(r => !isEmptyTile(img, r));
  const tiles = tileEdges(img, rects, layout.columns);
  const ew = group(tiles.flatMap(t => [t.e, t.w]), profileGap, tol);
  const ns = group(tiles.flatMap(t => [t.n, t.s]), profileGap, tol);
  const edgeClass = tiles.map((_, i) => ({ n: `v${ns[2 * i]}`, s: `v${ns[2 * i + 1]}`, e: `h${ew[2 * i]}`, w: `h${ew[2 * i + 1]}` }));

  // Terrain samples, 9 a tile: centre, then corners and edge middles.
  const mid = (p: Rgba[]): Rgba => p[SEGMENTS / 2 - 1].map((v, c) => (v + p[SEGMENTS / 2][c]) / 2) as Rgba;
  const samples = tiles.flatMap(t => [t.centre, mid(t.n), mid(t.e), mid(t.s), mid(t.w), t.n[SEGMENTS - 1], t.s[SEGMENTS - 1], t.s[0], t.n[0]]);
  const labels = group(samples, colourGap, tol);
  // A and B: the two commonest terrains at the tiles' sides and corners; A
  // the one more tiles have at their centre too (the blob's terrain; in a
  // Wang set the centre is where the colours meet, so the sides decide).
  const counts = (centre: boolean) => {
    const m = new Map<number, number>();
    labels.forEach((l, i) => (i % 9 === 0) === centre && m.set(l, (m.get(l) ?? 0) + 1));
    return m;
  };
  const [p, q] = [...counts(false)].sort((x, y) => y[1] - x[1]).map(c => c[0]);
  const atCentre = counts(true);
  const [fg, bg] = q === undefined || (atCentre.get(p) ?? 0) >= (atCentre.get(q) ?? 0) ? [p, q] : [q, p];
  const terrainColour = (label: number) => {
    const members = samples.filter((_, i) => labels[i] === label);
    const m = [0, 1, 2, 3].map(k => members.reduce((sum, c) => sum + c[k], 0) / members.length);
    const k = m[3] ? 255 / m[3] : 0;
    return { color: hex(m[0] * k, m[1] * k, m[2] * k), alpha: round(m[3] / 255) };
  };
  const terrains: Adjacency["terrains"] = fg === undefined ? [] : [{ id: "A", ...terrainColour(fg) }, ...(bg === undefined ? [] : [{ id: "B" as const, ...terrainColour(bg) }])];
  const as = (l: number): Terrain => (l === fg ? "A" : l === bg ? "B" : "?");
  const terrainOf = tiles.map((_, i) => {
    const [centre, n, e, s, w, ne, se, sw, nw] = labels.slice(i * 9, i * 9 + 9).map(as);
    return { centre, n, e, s, w, ne, se, sw, nw };
  });

  const withTerrain = tiles.map((t, i) => ({ tile: t.tile, t: terrainOf[i] }));
  const fits = bg === undefined ? [] : (["blob-47", "wang-edge-16", "wang-corner-16"] as LayoutType[]).map(type => fitLayout(type, withTerrain));
  // The blob first: its edge-only tiles are a whole edge Wang set too.
  const blob = fits.find(f => f.type === "blob-47" && passes(f, tiles.length));
  const wang = fits.filter(f => f.type !== "blob-47" && passes(f, tiles.length)).sort((a, b) => b.codes.size - a.codes.size || b.fitting - a.fitting)[0];
  return { layout, tiles, classes: { ew, ns }, edgeClass, terrains, terrainOf, fits, detected: blob ?? wang };
}

const caseOf = (type: LayoutType, code: number) => {
  const t = (bit: number) => (code & bit ? "A" : "B");
  if (type === "wang-edge-16") return { code, n: t(1), e: t(2), s: t(4), w: t(8) };
  if (type === "wang-corner-16") return { code, ne: t(1), se: t(2), sw: t(4), nw: t(8) };
  return { mask: code, joined: BLOB_ORDER.filter(k => code & BLOB_BITS[k]) };
};

const allCases = (type: LayoutType) => (type === "blob-47" ? BLOB_MASKS : Array.from({ length: 16 }, (_, i) => i));

// Each tile's 8 neighbour terrains for the detected layout, clockwise from
// north (Tiled's wangid order: top, top-right, right, bottom-right, bottom,
// bottom-left, left, top-left), as "A", "B" or undefined where the layout
// does not set that place.
function neighbourTerrains(type: LayoutType, code: number): (Terrain | undefined)[] {
  const t = (on: boolean): Terrain => (on ? "A" : "B");
  if (type === "wang-edge-16") return [t(!!(code & 1)), undefined, t(!!(code & 2)), undefined, t(!!(code & 4)), undefined, t(!!(code & 8)), undefined];
  if (type === "wang-corner-16") return [undefined, t(!!(code & 1)), undefined, t(!!(code & 2)), undefined, t(!!(code & 4)), undefined, t(!!(code & 8))];
  return BLOB_ORDER.map(k => t(!!(code & BLOB_BITS[k])));
}

const tileCode = (fit: LayoutFit) => {
  const out = new Map<number, number>();
  for (const [code, ids] of fit.codes) for (const id of ids) out.set(id, code);
  return out;
};

// A transparent B is no terrain: places next to it are left unset, as
// Godot's and Tiled's own single-terrain sets leave them.
const paintedB = (a: Adjacency) => a.terrains.length > 1 && a.terrains[1].alpha >= 0.5;

// Tiled's wangset (TSX 1.10 <wangsets>): colours are 1-based, 0 is unset.
// https://doc.mapeditor.org/en/stable/reference/tmx-map-format/#wangsets
export function tiledWangset(a: Adjacency, fit: LayoutFit): string {
  const type = fit.type === "blob-47" ? "mixed" : fit.type === "wang-edge-16" ? "edge" : "corner";
  const b = paintedB(a);
  const id = (t: Terrain | undefined) => (t === "A" ? 1 : t === "B" && b ? 2 : 0);
  const codes = tileCode(fit);
  return [
    ` <wangsets>`,
    `  <wangset name="terrain" type="${type}" tile="-1">`,
    ...a.terrains.filter(t => t.id === "A" || b).map(t => `   <wangcolor name="${t.id}" color="${t.color}" tile="-1" probability="1"/>`),
    ...[...codes].sort((x, y) => x[0] - y[0]).map(([tile, code]) => `   <wangtile tileid="${tile}" wangid="${neighbourTerrains(fit.type, code).map(id).join(",")}"/>`),
    `  </wangset>`,
    ` </wangsets>`
  ].join("\n");
}

// Godot 4 terrain peering bits: one terrain set, in the mode the layout
// matches (0 MATCH_CORNERS_AND_SIDES, 1 MATCH_CORNERS, 2 MATCH_SIDES), its
// terrains A (0) and B (1, when painted), and each tile's `terrain` (its
// centre's) and `terrains_peering_bit/<neighbour>`:
// https://docs.godotengine.org/en/stable/classes/class_tileset.html (TerrainMode)
// https://docs.godotengine.org/en/stable/classes/class_tiledata.html (terrain, terrain_set, set_terrain_peering_bit)
const GODOT_BITS = ["top_side", "top_right_corner", "right_side", "bottom_right_corner", "bottom_side", "bottom_left_corner", "left_side", "top_left_corner"];

export function godotPeeringBits(a: Adjacency, fit: LayoutFit): Map<number, { terrain: number; bits: Record<string, number> }> {
  const b = paintedB(a);
  const index = (t: Terrain | undefined) => (t === "A" ? 0 : t === "B" && b ? 1 : -1);
  const out = new Map<number, { terrain: number; bits: Record<string, number> }>();
  for (const [tile, code] of tileCode(fit)) {
    const bits: Record<string, number> = {};
    neighbourTerrains(fit.type, code).forEach((t, k) => {
      if (index(t) >= 0) bits[GODOT_BITS[k]] = index(t);
    });
    const centre = a.terrainOf[a.tiles.findIndex(x => x.tile === tile)].centre;
    out.set(tile, { terrain: centre === "?" ? 0 : Math.max(0, index(centre)), bits });
  }
  return out;
}

const godotColor = (h: string) => `Color(${[1, 3, 5].map(i => round(parseInt(h.slice(i, i + 2), 16) / 255, 4)).join(", ")}, 1)`;

export function godotTerrainTileSet(texturePath: string, a: Adjacency, fit: LayoutFit): string {
  const l = a.layout;
  const v = (x: number, y: number) => `Vector2i(${x}, ${y})`;
  const peering = godotPeeringBits(a, fit);
  const mode = fit.type === "blob-47" ? 0 : fit.type === "wang-corner-16" ? 1 : 2;
  const terrains = a.terrains.filter(t => t.id === "A" || paintedB(a));
  return [
    `[gd_resource type="TileSet" format=3]`,
    ``,
    `[ext_resource type="Texture2D" path="${texturePath.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}" id="1_tiles"]`,
    ``,
    `[sub_resource type="TileSetAtlasSource" id="TileSetAtlasSource_1"]`,
    `texture = ExtResource("1_tiles")`,
    ...(l.margin ? [`margins = ${v(l.margin, l.margin)}`] : []),
    ...(l.spacing ? [`separation = ${v(l.spacing, l.spacing)}`] : []),
    `texture_region_size = ${v(l.tileWidth, l.tileHeight)}`,
    ...a.tiles.flatMap(t => {
      const key = `${t.rect.col}:${t.rect.row}/0`;
      const p = peering.get(t.tile);
      return [`${key} = 0`, ...(p ? [`${key}/terrain_set = 0`, `${key}/terrain = ${p.terrain}`, ...Object.entries(p.bits).map(([k, x]) => `${key}/terrains_peering_bit/${k} = ${x}`)] : [])];
    }),
    ``,
    `[resource]`,
    `tile_size = ${v(l.tileWidth, l.tileHeight)}`,
    `terrain_set_0/mode = ${mode}`,
    ...terrains.flatMap((t, i) => [`terrain_set_0/terrain_${i}/name = "${t.id}"`, `terrain_set_0/terrain_${i}/color = ${godotColor(t.color)}`]),
    `sources/0 = SubResource("TileSetAtlasSource_1")`,
    ``
  ].join("\n");
}

// Distinct colours for classes: hues a golden angle apart.
function classColour(k: number): [number, number, number] {
  const h = (k * 137.508) % 360;
  const f = (n: number) => {
    const x = (n + h / 60) % 6;
    return Math.round(255 * (0.85 - 0.6 * Math.max(0, Math.min(1, Math.min(x, 4 - x)))));
  };
  return [f(5), f(3), f(1)];
}

function adjacencyOverlay(img: Image, a: Adjacency): Image {
  const out = onChecker(img);
  a.tiles.forEach((t, i) => {
    const r = t.rect;
    const d = Math.max(1, Math.round(Math.min(r.w, r.h) / 8));
    const c = a.edgeClass[i];
    const n = (s: string) => Number(s.slice(1));
    shade(out, r.x, r.y, r.w, d, classColour(n(c.n)), 0.7);
    shade(out, r.x, r.y + r.h - d, r.w, d, classColour(n(c.s)), 0.7);
    shade(out, r.x, r.y + d, d, r.h - 2 * d, classColour(n(c.w) + 50), 0.7);
    shade(out, r.x + r.w - d, r.y + d, d, r.h - 2 * d, classColour(n(c.e) + 50), 0.7);
  });
  return out;
}

const writeNew = (file: string, text: string) => {
  const dir = path.dirname(file);
  const ext = path.extname(file);
  const base = path.basename(file, ext);
  for (let n = 1; ; n++) {
    const target = path.join(dir, `${base}${n > 1 ? `-${n}` : ""}${ext}`);
    try {
      fs.writeFileSync(target, text, { flag: "wx" });
      return target;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
};

TOOLS.push({
  group: "image",
  name: "adjacency",
  args: "<tileset>",
  summary: "Which tiles can sit next to which (wave function collapse rules), and the autotile layout they make",
  details: [
    "Tiles are cut as `ludo toolbox image tiles` cuts them. Each edge is compared, in 8 segments, with",
    "--tolerance; the JSON lists every tile's edge classes and the tiles that can sit north, east, south",
    "and west of it. When the tiles make a known autotile layout (the 16-tile edge or corner Wang set, the",
    "47-tile blob) it is named, with its missing_cases[] (listed, never drawn). Then:",
    "  --tiled          a Tiled tileset (.tsx) with the wangset, next to the image",
    "  --engine godot   a Godot 4 TileSet (.tres) with the terrain set and every tile's peering bits"
  ],
  flags: [
    { flag: "--size", value: "WxH", description: "Tile size in pixels, like 16x16 (or 16)" },
    { flag: "--spacing", value: "px", description: "Pixels between tiles (default 0)" },
    { flag: "--margin", value: "px", description: "Pixels around the tiles (default 0)" },
    { flag: "--tolerance", value: "levels", description: "How far two edge segments' colours may differ and still match, 0-255 (default 16)" },
    { flag: "--tiled", description: "Write a Tiled tileset (.tsx) with the detected wangset" },
    { flag: "--overlay", description: "Also save the tileset with each edge coloured by its class" }
  ],
  async run(ctx: Ctx, call: ToolCall) {
    if (call.args.length !== 1) throw usage("Usage: ludo toolbox image adjacency <tileset> --size 16x16");
    const size = sizeFlag(textFlag(call, "--size"));
    if (!size) throw usage("Pass the tile size with --size, like --size 16x16");
    const nonNegative = (flag: string) => {
      const raw = textFlag(call, flag);
      const v = raw === undefined ? 0 : Number(raw);
      if (!Number.isInteger(v) || v < 0 || v > 1024) throw usage(`${flag} takes 0 to 1024 pixels (got "${raw}")`);
      return v;
    };
    const [spacing, margin] = [nonNegative("--spacing"), nonNegative("--margin")];
    const tol = tolerance(call, 16);
    const engine = ctx.globals.engine;
    if (engine && engine !== "godot") throw usage(`Terrain rules export to Godot (--engine godot) or Tiled (--tiled), not ${engine}`);
    const src = loadImageFile(call.args[0]);
    const { width, height } = src.image;
    const layout = tileLayout(width, height, size[0], size[1], spacing, margin);
    if (!layout.columns || !layout.rows) throw usage(`${size[0]}x${size[1]} tiles do not fit a ${width}x${height} image`);
    const a = adjacency(src.image, layout, tol);
    if (!a.tiles.length) throw new CliError(`${src.file} has no tiles: every one is transparent`, EXIT.BAD_INPUT);
    noteFact("frames", a.tiles.length);
    if (engine) noteFact("engine", engine);
    const fit = a.detected;
    if ((call.flags.has("--tiled") || engine) && !/\.png$/i.test(src.file)) throw usage("Tileset files point at a PNG: convert the image to PNG first");
    if ((call.flags.has("--tiled") || engine) && !fit) {
      throw new CliError(`No known autotile layout in ${src.file}, so there is no terrain set to write`, EXIT.BAD_INPUT, `Write the plain tileset instead: ludo toolbox image tiles ${shown(src.file)} --size ${size[0]}x${size[1]}${engine ? " --engine godot" : " --tiled"}`);
    }
    const files: string[] = [];
    if (fit && call.flags.has("--tiled")) {
      const tsx = tiledTsx(baseOf(src.file), path.basename(src.file), width, height, layout).replace(/<\/tileset>\n$/, `${tiledWangset(a, fit)}\n</tileset>\n`);
      files.push(writeNew(src.file.replace(/\.png$/i, "-terrain.tsx"), tsx));
    }
    if (fit && engine === "godot") {
      const abs = path.resolve(src.file);
      const project = findGodotProject(path.dirname(abs));
      const texture = project ? `res://${path.relative(project, abs).split(path.sep).join("/")}` : path.basename(abs);
      files.push(writeNew(src.file.replace(/\.png$/i, "-terrain.tres"), godotTerrainTileSet(texture, a, fit)));
    }
    let overlay: string | undefined;
    if (call.flags.has("--overlay")) {
      overlay = freeName(ctx.outDir, ctx.globals.name || `${baseOf(src.file)}-adjacency`, ".png");
      writePng(overlay, adjacencyOverlay(src.image, a));
    }

    // The rules: B east of A when A's east class is B's west class, and so on.
    const byClass = (side: "n" | "e" | "s" | "w") => {
      const m = new Map<string, number[]>();
      a.edgeClass.forEach((c, i) => m.set(c[side], [...(m.get(c[side]) ?? []), a.tiles[i].tile]));
      return m;
    };
    const [inN, inE, inS, inW] = [byClass("n"), byClass("e"), byClass("s"), byClass("w")];
    const rules = a.tiles.map((t, i) => {
      const c = a.edgeClass[i];
      return {
        tile: t.tile,
        col: t.rect.col,
        row: t.rect.row,
        edges: c,
        north: inS.get(c.n) ?? [],
        east: inW.get(c.e) ?? [],
        south: inN.get(c.s) ?? [],
        west: inE.get(c.w) ?? [],
        seamless: c.e === c.w && c.n === c.s
      };
    });
    const peering = fit ? godotPeeringBits(a, fit) : undefined;
    const layoutJson = fit
      ? {
          type: fit.type,
          cases: fit.cases,
          present: fit.codes.size,
          tiles_fitting: fit.fitting,
          missing_cases: allCases(fit.type).filter(c => !fit.codes.has(c)).map(c => caseOf(fit.type, c)),
          variants: [...fit.codes].filter(([, ids]) => ids.length > 1).map(([code, tiles]) => ({ ...caseOf(fit.type, code), tiles })),
          tiles: [...tileCode(fit)].map(([tile, code]) => ({ tile, ...caseOf(fit.type, code), godot: peering!.get(tile) }))
        }
      : null;
    const checked = a.fits.map(f => ({ type: f.type, tiles_fitting: f.fitting, cases_present: f.codes.size, cases: f.cases }));
    const ewClasses = new Set(a.classes.ew).size;
    const nsClasses = new Set(a.classes.ns).size;
    const tiling = `--size ${size[0]}x${size[1]}${spacing ? ` --spacing ${spacing}` : ""}${margin ? ` --margin ${margin}` : ""}`;
    const next =
      fit && !engine && !call.flags.has("--tiled")
        ? hint("Write the Godot TileSet with these terrains", `ludo toolbox image adjacency ${shown(src.file)} ${tiling} --engine godot`)
        : !fit
          ? hint("Write the plain tileset for Tiled", `ludo toolbox image tiles ${shown(src.file)} ${tiling} --tiled`)
          : undefined;
    if (ctx.jsonOut) {
      printJson(
        {
          tileset: shown(src.file),
          tile_width: size[0],
          tile_height: size[1],
          columns: layout.columns,
          rows: layout.rows,
          tiles: a.tiles.length,
          tolerance: tol,
          edge_classes: { east_west: ewClasses, north_south: nsClasses },
          terrains: a.terrains,
          layout: layoutJson,
          ...(fit ? {} : { layouts_checked: checked }),
          rules,
          ...(files.length ? { files: files.map(shown) } : {}),
          ...(overlay ? { overlay: shown(overlay) } : {}),
          ...hintJson(ctx, next)
        },
        false
      );
    } else {
      const alone = rules.filter(r => r.seamless).length;
      process.stdout.write(`${a.tiles.length} tiles of ${size[0]}x${size[1]}: ${ewClasses} east/west and ${nsClasses} north/south edge classes; ${alone} tile${alone === 1 ? "" : "s"} tile${alone === 1 ? "s" : ""} seamlessly with ${alone === 1 ? "itself" : "themselves"}\n`);
      if (fit && layoutJson) {
        process.stdout.write(`Layout: ${fit.type}, ${fit.codes.size} of ${fit.cases} cases${layoutJson.missing_cases.length ? ` (${layoutJson.missing_cases.length} missing)` : ""}; terrains ${a.terrains.map(t => `${t.id} ${t.color}${t.alpha < 0.5 ? " (transparent)" : ""}`).join(", ")}\n`);
      } else {
        process.stdout.write(`No known autotile layout (${checked.map(c => `${c.type} ${c.cases_present}/${c.cases}`).join(", ") || "one terrain only"})\n`);
      }
      for (const f of files) process.stdout.write(`Saved ${shown(f)}\n`);
      if (overlay) process.stdout.write(`Saved ${shown(overlay)}\n`);
      printHint(ctx, next);
    }
    return EXIT.OK;
  }
});

// ---------------------------------------------------------------------------
// Contrast: whether a sprite's silhouette reads against its backgrounds at
// the size players see it.
//
// The sprite (its first frame, cut to its art) is scaled to --size on
// screen: area-averaged down, as a mipmapped texture is drawn, or blown up
// nearest-neighbour. Its silhouette edge is every pixel at least half opaque
// with a 4-neighbour that is not. For each, the WCAG contrast ratio between
// the edge pixel and the pixels just outside it, both as drawn over the
// background (so soft edges blend). A background image is taken at 1:1, the
// sprite placed at 16 points over it (wrapping, so a tile works), as it
// will sit anywhere in a level. The readable threshold is WCAG 2's 3:1 for
// graphics (SC 1.4.11 Non-text Contrast); the verdict is readable when at
// least 3/4 of the edge clears it.
// https://www.w3.org/TR/WCAG22/#dfn-contrast-ratio
// https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html
// ---------------------------------------------------------------------------

// sRGB to linear, the threshold IEC 61966-2-1 gives (WCAG 2.2's note on
// its 0.03928: the difference never matters at 8 bits).
const LINEAR = Float64Array.from({ length: 256 }, (_, c) => (c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4));
export const luminance = (r: number, g: number, b: number) => 0.2126 * LINEAR[Math.round(r)] + 0.7152 * LINEAR[Math.round(g)] + 0.0722 * LINEAR[Math.round(b)];
export const contrastRatio = (l1: number, l2: number) => (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);

const READABLE_SHARE = 0.25;

interface Backdrop {
  label: string;
  colour?: [number, number, number];
  image?: Image;
}

// The colour at (x, y) of the background, under a pixel of the sprite.
const backdropAt = (b: Backdrop, x: number, y: number): [number, number, number] => {
  if (b.colour) return b.colour;
  const img = b.image!;
  const i = ((mod(y, img.height) * img.width) + mod(x, img.width)) * 4;
  // A see-through background shows black behind it: a game clears to black.
  const a = img.rgba[i + 3] / 255;
  return [img.rgba[i] * a, img.rgba[i + 1] * a, img.rgba[i + 2] * a];
};

const over = (s: Uint8Array, i: number, bg: [number, number, number]): [number, number, number] => {
  const a = s[i + 3] / 255;
  return [s[i] * a + bg[0] * (1 - a), s[i + 1] * a + bg[1] * (1 - a), s[i + 2] * a + bg[2] * (1 - a)];
};

const REGIONS = ["top-left", "top", "top-right", "left", "center", "right", "bottom-left", "bottom", "bottom-right"];

export interface ContrastResult {
  background: string;
  median_ratio: number;
  p10_ratio: number;
  share_below: number;
  worst_regions: { region: string; share_below: number; median_ratio: number }[];
  readable: boolean;
  placements?: number;
  worst_placement?: { x: number; y: number; share_below: number };
  low: Uint8Array; // per sprite pixel, at the worst placement: 1 where the edge is under the threshold
  at: { x: number; y: number }; // the worst placement
}

// The silhouette edge: [x, y, outside neighbours] for every pixel at least
// half opaque with a neighbour that is not (or that is off the image).
function silhouetteEdge(s: Image): { x: number; y: number; out: [number, number][] }[] {
  const { width: w, height: h, rgba } = s;
  const solid = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && rgba[(y * w + x) * 4 + 3] >= 128;
  const edge: { x: number; y: number; out: [number, number][] }[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!solid(x, y)) continue;
      const out = ([[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]] as [number, number][]).filter(([a, b]) => !solid(a, b));
      if (out.length) edge.push({ x, y, out });
    }
  }
  return edge;
}

const median = (v: number[]) => {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

export function contrastOn(sprite: Image, b: Backdrop, minRatio = 3): ContrastResult {
  const { width: w, height: h, rgba } = sprite;
  const edge = silhouetteEdge(sprite);
  const placements: { x: number; y: number }[] = [];
  if (b.image) {
    for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) placements.push({ x: Math.floor(((i + 0.5) * b.image.width) / 4 - w / 2), y: Math.floor(((j + 0.5) * b.image.height) / 4 - h / 2) });
  } else placements.push({ x: 0, y: 0 });
  const all: number[] = [];
  const perRegion = REGIONS.map(() => [] as number[]);
  let worst = { k: 0, share: -1 };
  const lows: Uint8Array[] = [];
  placements.forEach((p, k) => {
    const low = new Uint8Array(w * h);
    let below = 0;
    for (const e of edge) {
      const inner = over(rgba, (e.y * w + e.x) * 4, backdropAt(b, p.x + e.x, p.y + e.y));
      let lo = 0;
      for (const [ox, oy] of e.out) {
        const inside = ox >= 0 && oy >= 0 && ox < w && oy < h;
        const bg = backdropAt(b, p.x + ox, p.y + oy);
        const c = inside ? over(rgba, (oy * w + ox) * 4, bg) : bg;
        lo += luminance(c[0], c[1], c[2]);
      }
      const r = contrastRatio(luminance(inner[0], inner[1], inner[2]), lo / e.out.length);
      all.push(r);
      perRegion[Math.min(2, Math.floor((3 * e.y) / h)) * 3 + Math.min(2, Math.floor((3 * e.x) / w))].push(r);
      if (r < minRatio) (below++, (low[e.y * w + e.x] = 1));
    }
    lows.push(low);
    const share = edge.length ? below / edge.length : 0;
    if (share > worst.share) worst = { k, share };
  });
  const sorted = [...all].sort((a, c) => a - c);
  const shareBelow = all.length ? all.filter(r => r < minRatio).length / all.length : 0;
  const worstRegions = perRegion
    .map((v, i) => ({ region: REGIONS[i], n: v.length, share_below: v.length ? v.filter(r => r < minRatio).length / v.length : 0, median_ratio: round(median(v)) }))
    // Regions with a few edge pixels only (a thin tip) say little.
    .filter(r => r.n >= all.length * 0.03 && r.share_below > 0)
    .sort((a, c) => c.share_below - a.share_below)
    .slice(0, 3)
    .map(({ region, share_below, median_ratio }) => ({ region, share_below: round(share_below), median_ratio }));
  return {
    background: b.label,
    median_ratio: round(median(all)),
    p10_ratio: round(sorted[Math.floor(sorted.length * 0.1)] ?? 0),
    share_below: round(shareBelow),
    worst_regions: worstRegions,
    readable: shareBelow <= READABLE_SHARE,
    ...(b.image ? { placements: placements.length, worst_placement: { ...placements[worst.k], share_below: round(worst.share) } } : {}),
    low: lows[worst.k],
    at: placements[worst.k]
  };
}

// How alike two silhouettes are: both scaled to one height, centred and
// standing on one line, the intersection over the union of their solid
// pixels; the other one mirrored too, as a sprite that faces the other way
// reads the same.
export function silhouetteAlike(a: Image, b: Image, height = 64): { iou: number; mirrored: boolean } {
  const fit = (img: Image) => {
    const w = Math.max(1, Math.round((img.width * height) / img.height));
    return img.height > height ? resizeSmooth(img, w, height) : resizeNearestTo(img, w, height);
  };
  const [sa, sb] = [fit(a), fit(b)];
  const width = Math.max(sa.width, sb.width);
  const mask = (img: Image, mirror: boolean) => {
    const m = new Uint8Array(width * height);
    const dx = Math.floor((width - img.width) / 2);
    for (let y = 0; y < height; y++) for (let x = 0; x < img.width; x++) if (img.rgba[(y * img.width + (mirror ? img.width - 1 - x : x)) * 4 + 3] >= 128) m[y * width + x + dx] = 1;
    return m;
  };
  const iou = (p: Uint8Array, q: Uint8Array) => {
    let [both, any] = [0, 0];
    for (let i = 0; i < p.length; i++) (both += p[i] & q[i]), (any += p[i] | q[i]);
    return any ? both / any : 0;
  };
  const ma = mask(sa, false);
  const [plain, flipped] = [iou(ma, mask(sb, false)), iou(ma, mask(sb, true))];
  return { iou: round(Math.max(plain, flipped)), mirrored: flipped > plain };
}

function resizeNearestTo(img: Image, width: number, height: number): Image {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(img.height - 1, Math.floor(((y + 0.5) * img.height) / height));
    for (let x = 0; x < width; x++) {
      const i = (sy * img.width + Math.min(img.width - 1, Math.floor(((x + 0.5) * img.width) / width))) * 4;
      rgba.set(img.rgba.subarray(i, i + 4), (y * width + x) * 4);
    }
  }
  return { width, height, rgba };
}

// The art of the sprite's first frame, cut to its content: what is drawn.
function spriteArt(src: Loaded): Image {
  const frame = src.grid ? sliceSheet(src.image, src.grid.cols, src.grid.rows, src.grid.frames)[0] : src.image;
  if (!frame.rgba.some((v, i) => i % 4 === 3 && v < 255)) {
    throw new CliError(`${src.file} has no transparency, so it has no silhouette to measure`, EXIT.BAD_INPUT, `Take its background away with Ludo first: ludo image remove-background --image ${shown(src.file)}`);
  }
  const box = contentBox([frame], (px, i) => px[i + 3] < 128);
  if (!box) throw new CliError(`${src.file} is transparent all over`, EXIT.BAD_INPUT);
  return crop(frame, box);
}

const meanColour = (img: Image): [number, number, number] => {
  let [r, g, b, n] = [0, 0, 0, 0];
  for (let i = 0; i < img.rgba.length; i += 4) if (img.rgba[i + 3] >= 128) (r += img.rgba[i]), (g += img.rgba[i + 1]), (b += img.rgba[i + 2]), n++;
  return n ? [r / n, g / n, b / n] : [0, 0, 0];
};

function contrastOverlay(sprite: Image, results: ContrastResult[], backdrops: Backdrop[]): Image {
  const pad = Math.max(4, Math.round(sprite.height / 4));
  const [pw, ph] = [sprite.width + 2 * pad, sprite.height + 2 * pad];
  const scale = Math.max(1, Math.floor(192 / ph));
  const out: Image = { width: pw * scale * results.length, height: ph * scale, rgba: new Uint8Array(pw * scale * results.length * ph * scale * 4) };
  results.forEach((r, k) => {
    const b = backdrops[k];
    for (let y = 0; y < ph; y++) {
      for (let x = 0; x < pw; x++) {
        const [sx, sy] = [x - pad, y - pad];
        const bg = backdropAt(b, r.at.x + sx, r.at.y + sy);
        const inside = sx >= 0 && sy >= 0 && sx < sprite.width && sy < sprite.height;
        let c = inside ? over(sprite.rgba, (sy * sprite.width + sx) * 4, bg) : bg;
        if (inside && r.low[sy * sprite.width + sx]) c = [255, 0, 64];
        for (let yy = 0; yy < scale; yy++) for (let xx = 0; xx < scale; xx++) out.rgba.set([c[0], c[1], c[2], 255], (((y * scale + yy) * out.width) + (k * pw + x) * scale + xx) * 4);
      }
    }
  });
  return out;
}

TOOLS.push({
  group: "image",
  name: "contrast",
  args: "<sprite>",
  summary: "How well a sprite's silhouette reads against backgrounds, at the size players see it",
  details: [
    "For each background (an image, taken at 1:1 with the sprite placed at 16 points over it, or a #hex",
    "colour): the WCAG contrast ratio along the silhouette's edge, the share of the edge under --min-ratio",
    "(default 3, WCAG's for graphics), the worst regions and a verdict (readable: at least 3/4 of the edge",
    "clears it). --size scales the sprite to its height on screen first. --against compares the silhouette",
    "with other sprites (scaled to one height, mirrored too): 0.8 or more reads alike. It only measures:",
    "an outline or a shadow (`image outline`, `image shadow`) is your call."
  ],
  flags: [
    { flag: "--on", value: "image|#hex,...", description: "Backgrounds to check against: images or hex colours, comma-separated or repeated" },
    { flag: "--size", value: "px", description: "The sprite's height on screen, in pixels (default: as it is)" },
    { flag: "--min-ratio", value: "ratio", description: "The contrast an edge pixel needs, 1-21 (default 3)" },
    { flag: "--against", value: "sprite,...", description: "Other sprites whose silhouettes should not read the same" },
    { flag: "--overlay", description: "Also save the sprite on each background, low-contrast edge in red" }
  ],
  async run(ctx: Ctx, call: ToolCall) {
    if (call.args.length !== 1) throw usage("Usage: ludo toolbox image contrast <sprite> --on <background|#hex>[,...] [--size 48]");
    const specs = (call.lists.get("--on") ?? []).flatMap(v => v.split(",")).map(v => v.trim()).filter(Boolean);
    if (!specs.length) throw usage("Pass the backgrounds with --on: an image, a #hex colour, or several, like --on level.png,#1e1e2e");
    const minRatio = positiveNumber(call, "--min-ratio") ?? 3;
    if (minRatio < 1 || minRatio > 21) throw usage("--min-ratio takes 1 to 21");
    const sizeRaw = textFlag(call, "--size");
    const target = sizeRaw === undefined ? undefined : Number(sizeRaw);
    if (target !== undefined && (!Number.isInteger(target) || target < 4 || target > 4096)) throw usage(`--size takes the sprite's height on screen, 4 to 4096 pixels (got "${sizeRaw}")`);
    const backdrops: Backdrop[] = specs.map(spec => {
      // A colour: #hex, or bare hex that names no file.
      if (spec.startsWith("#") || (/^([0-9a-f]{3}|[0-9a-f]{6})$/i.test(spec) && !fs.existsSync(spec))) {
        const [r, g, b] = hexColour(spec, "--on");
        return { label: hex(r, g, b), colour: [r, g, b] };
      }
      const bg = loadImageFile(spec);
      return { label: shown(bg.file), image: bg.image };
    });
    const src = loadImageFile(call.args[0]);
    const art = spriteArt(src);
    const f = target ? target / art.height : 1;
    const [sw, sh] = [Math.max(1, Math.round(art.width * f)), Math.max(1, Math.round(art.height * f))];
    const sprite = f === 1 ? art : f < 1 ? resizeSmooth(art, sw, sh) : resizeNearestTo(art, sw, sh);
    if (!silhouetteEdge(sprite).length) throw new CliError(`At ${sh} px ${src.file} has no solid pixels left`, EXIT.BAD_INPUT, "Measure it at a larger --size.");
    const results = backdrops.map(b => contrastOn(sprite, b, minRatio));

    const others = (call.lists.get("--against") ?? []).flatMap(v => v.split(",")).map(v => v.trim()).filter(Boolean);
    const lum = (c: [number, number, number]) => luminance(c[0], c[1], c[2]);
    const mine = meanColour(sprite);
    const against = others.map(file => {
      const other = spriteArt(loadImageFile(file));
      const { iou, mirrored } = silhouetteAlike(art, other, Math.max(16, target ?? 64));
      const theirs = meanColour(other);
      return {
        sprite: shown(file),
        silhouette_iou: iou,
        mirrored,
        height_ratio: round(other.height / art.height),
        luminance_ratio: round(contrastRatio(lum(mine), lum(theirs))),
        verdict: iou >= 0.8 ? "alike" : iou >= 0.65 ? "similar" : "distinct"
      };
    });

    let overlay: string | undefined;
    if (call.flags.has("--overlay")) {
      overlay = freeName(ctx.outDir, ctx.globals.name || `${baseOf(src.file)}-contrast`, ".png");
      writePng(overlay, contrastOverlay(sprite, results, backdrops));
    }
    const readable = results.every(r => r.readable);
    // The outline colour that stands out most against the worst background.
    const worst = [...results].sort((a, b) => b.share_below - a.share_below)[0];
    const wb = backdrops[results.indexOf(worst)];
    const wl = wb.colour ? lum(wb.colour) : lum(meanColour({ ...wb.image!, rgba: wb.image!.rgba.map((v, i) => (i % 4 === 3 ? 255 : v)) }));
    const ink = contrastRatio(wl, 1) > contrastRatio(wl, 0) ? "#ffffff" : "#000000";
    const next = readable ? undefined : hint(`Its edge is lost on ${worst.background}; an outline (or \`image shadow\`) would lift it, if you want one`, `ludo toolbox image outline ${shown(src.file)} --color ${ink}`);
    const strip = ({ low, at, ...rest }: ContrastResult) => rest;
    if (ctx.jsonOut) {
      printJson(
        {
          sprite: shown(src.file),
          ...(src.grid ? { frame: `1 of ${src.grid.frames}` } : {}),
          art: { width: art.width, height: art.height },
          on_screen: { width: sw, height: sh },
          min_ratio: minRatio,
          readable,
          backgrounds: results.map(strip),
          ...(against.length ? { against } : {}),
          ...(overlay ? { overlay: shown(overlay) } : {}),
          ...hintJson(ctx, next)
        },
        false
      );
    } else {
      process.stdout.write(`${shown(src.file)} at ${sw}x${sh} on screen${src.grid ? " (first frame)" : ""}:\n`);
      for (const r of results) {
        const where = r.worst_regions.length ? `; worst ${r.worst_regions.map(w => w.region).join(", ")}` : "";
        process.stdout.write(`  on ${r.background}: ${r.readable ? "readable" : "hard to read"}, ${Math.round(r.share_below * 100)}% of the edge under ${minRatio}:1 (median ${r.median_ratio}:1)${where}\n`);
      }
      for (const a of against) process.stdout.write(`  vs ${a.sprite}: silhouettes ${a.verdict} (overlap ${a.silhouette_iou}${a.mirrored ? ", mirrored" : ""})\n`);
      if (overlay) process.stdout.write(`Saved ${shown(overlay)}\n`);
      printHint(ctx, next);
    }
    return EXIT.OK;
  }
});

// ---------------------------------------------------------------------------
// `video info`: what is in a video file, read from its container without
// ffmpeg. MP4 and MOV are ISO BMFF boxes (ISO/IEC 14496-12; QuickTime's
// moov/trak/mdia/minf/stbl): the sample entry names the codec (avc1, hvc1,
// av01, vp09...), mdhd the track's timescale and length, stts the frame
// durations, stss the keyframes (none: every frame is one), and fragmented
// files (moof/traf/trun) the same per fragment. WebM and Matroska are EBML
// (https://www.matroska.org/technical/elements.html): Tracks hold each
// track's CodecID, size, AlphaMode and audio format, the Clusters' blocks
// the frames and their keyframe flags. Ogg (RFC 3533) holds Theora, the one
// video Godot plays: its identification header has the size and rate, the
// last page's granule position the frame count.
// ---------------------------------------------------------------------------

export class VideoError extends Error {}

// A file read at offsets, through a small cache: a video can be far larger
// than what is read of it.
class Source {
  private cache = { at: -1, buf: Buffer.alloc(0) };
  constructor(
    private fd: number,
    readonly size: number
  ) {}
  read(at: number, len: number): Buffer {
    if (at < 0 || len < 0) throw new VideoError("a size or offset in the file is out of range");
    len = Math.min(len, this.size - at);
    if (len <= 0) return Buffer.alloc(0);
    const c = this.cache;
    if (at >= c.at && at + len <= c.at + c.buf.length) return c.buf.subarray(at - c.at, at - c.at + len);
    if (len > 1 << 16) {
      const buf = Buffer.alloc(len);
      fs.readSync(this.fd, buf, 0, len, at);
      return buf;
    }
    const buf = Buffer.alloc(Math.min(1 << 16, this.size - at));
    fs.readSync(this.fd, buf, 0, buf.length, at);
    this.cache = { at, buf };
    return buf.subarray(0, len);
  }
}

export interface TrackInfo {
  codec: string; // ffmpeg's name: h264, hevc, av1, vp9, vp8, prores, aac, opus...
  codec_tag?: string; // the container's id: avc1, V_VP9...
  profile?: string;
}

export interface VideoFileInfo {
  container: "mp4" | "mov" | "webm" | "matroska" | "ogg";
  brand?: string;
  duration: number; // seconds
  video?: TrackInfo & {
    width: number;
    height: number;
    fps: number;
    constant_frame_rate: boolean;
    frames: number;
    keyframes?: number;
    keyframe_interval?: { average: number; max: number; seconds: number }; // in frames, between keyframes
    alpha: boolean;
  };
  audio?: TrackInfo & { sample_rate: number; channels: number };
  tracks: { video: number; audio: number; other: number };
}

// ---- ISO BMFF (MP4, MOV) ----

interface Box {
  type: string;
  start: number; // where its payload starts
  end: number;
}

function* boxesIn(buf: Buffer, from = 0, to = buf.length): Generator<Box> {
  let at = from;
  while (at + 8 <= to) {
    let size = buf.readUInt32BE(at);
    const type = buf.toString("latin1", at + 4, at + 8);
    let head = 8;
    if (size === 1) {
      if (at + 16 > to) return;
      size = Number(buf.readBigUInt64BE(at + 8));
      head = 16;
    } else if (size === 0) size = to - at;
    if (size < head || at + size > to) return;
    yield { type, start: at + head, end: at + size };
    at += size;
  }
}

const child = (buf: Buffer, parent: Box, type: string) => {
  for (const b of boxesIn(buf, parent.start, parent.end)) if (b.type === type) return b;
  return undefined;
};

const path4 = (buf: Buffer, parent: Box, ...types: string[]) => types.reduce<Box | undefined>((b, t) => b && child(buf, b, t), parent);

// The top-level boxes, read header by header, so mdat is never read.
function topBoxes(src: Source): { type: string; at: number; head: number; size: number }[] {
  const out: { type: string; at: number; head: number; size: number }[] = [];
  let at = 0;
  while (at + 8 <= src.size) {
    const h = src.read(at, 16);
    let size = h.readUInt32BE(0);
    const type = h.toString("latin1", 4, 8);
    let head = 8;
    if (size === 1) (size = Number(h.readBigUInt64BE(8))), (head = 16);
    else if (size === 0) size = src.size - at;
    if (size < head || !/^[\x20-\x7e]{4}$/.test(type)) break;
    out.push({ type, at, head, size });
    at += size;
  }
  return out;
}

const FOURCC: Record<string, string> = {
  avc1: "h264", avc3: "h264", hvc1: "hevc", hev1: "hevc", dvh1: "hevc", dvhe: "hevc", av01: "av1", vp09: "vp9", vp08: "vp8", mp4v: "mpeg4",
  apch: "prores", apcn: "prores", apcs: "prores", apco: "prores", ap4h: "prores", ap4x: "prores", jpeg: "mjpeg", mjpa: "mjpeg", "png ": "png", rle: "qtrle", "rle ": "qtrle",
  mp4a: "aac", Opus: "opus", opus: "opus", "ac-3": "ac3", "ec-3": "eac3", fLaC: "flac", ".mp3": "mp3", lpcm: "pcm", sowt: "pcm", twos: "pcm", ipcm: "pcm", fpcm: "pcm", alac: "alac"
};

const PRORES: Record<string, string> = { apco: "Proxy", apcs: "LT", apcn: "422", apch: "422 HQ", ap4h: "4444", ap4x: "4444 XQ" };
const AVC_PROFILES: Record<number, string> = { 66: "Baseline", 77: "Main", 88: "Extended", 100: "High", 110: "High 10", 122: "High 4:2:2", 244: "High 4:4:4 Predictive" };
const AAC_PROFILES: Record<number, string> = { 1: "Main", 2: "LC", 3: "SSR", 4: "LTP", 5: "HE-AAC", 23: "LD", 29: "HE-AACv2", 39: "ELD" };
const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

const avcProfile = (c: Buffer) => (c.length > 3 ? `${AVC_PROFILES[c[1]] ?? `profile ${c[1]}`}${c[1] === 66 && c[2] & 0x40 ? " (constrained)" : ""}, level ${c[3] / 10}` : undefined);
const hevcProfile = (c: Buffer) => (c.length > 12 ? `${({ 1: "Main", 2: "Main 10", 3: "Main Still Picture", 4: "Range Extensions" } as Record<number, string>)[c[1] & 0x1f] ?? `profile ${c[1] & 0x1f}`}, level ${round(c[12] / 30, 1)}` : undefined);
const av1Profile = (c: Buffer) => (c.length > 1 ? ["Main", "High", "Professional"][c[1] >> 5] ?? `profile ${c[1] >> 5}` : undefined);

// The AAC AudioSpecificConfig: object type, then rate and channels.
function aacConfig(c: Buffer): { profile?: string; rate?: number; channels?: number } {
  if (c.length < 2) return {};
  let bit = 0;
  const bits = (n: number) => {
    let v = 0;
    for (let i = 0; i < n; i++, bit++) v = (v << 1) | ((c[bit >> 3] >> (7 - (bit & 7))) & 1);
    return v;
  };
  let type = bits(5);
  if (type === 31) type = 32 + bits(6);
  const index = bits(4);
  const rate = index === 15 ? bits(24) : AAC_RATES[index];
  const channels = bits(4);
  return { profile: AAC_PROFILES[type] ?? `object type ${type}`, rate, ...(channels ? { channels } : {}) };
}

// esds: the ES descriptor's DecoderConfig (object type 0x40 is AAC, 0x69
// and 0x6B MP3) and its DecoderSpecificInfo.
function esds(buf: Buffer): { codec?: string; config?: Buffer } {
  let at = 4;
  const descriptor = () => {
    const tag = buf[at++];
    let len = 0;
    for (let i = 0; i < 4; i++) {
      const b = buf[at++];
      len = (len << 7) | (b & 0x7f);
      if (!(b & 0x80)) break;
    }
    return { tag, len };
  };
  const out: { codec?: string; config?: Buffer } = {};
  while (at < buf.length) {
    const { tag, len } = descriptor();
    if (tag === 0x03) {
      at += 2;
      const flags = buf[at++];
      if (flags & 0x80) at += 2;
      if (flags & 0x40) at += 1 + buf[at];
      if (flags & 0x20) at += 2;
    } else if (tag === 0x04) {
      const type = buf[at];
      out.codec = type === 0x40 || type === 0x66 || type === 0x67 || type === 0x68 ? "aac" : type === 0x69 || type === 0x6b ? "mp3" : `mpeg4 object 0x${type.toString(16)}`;
      at += 13;
    } else if (tag === 0x05) {
      out.config = buf.subarray(at, at + len);
      return out;
    } else at += len;
  }
  return out;
}

interface BmffTrack {
  id: number;
  handler: string;
  timescale: number;
  duration: number;
  entry?: Box;
  fourcc?: string;
  deltas: number[]; // per sample, in timescale units
  sync?: Set<number>; // 1-based sample numbers; undefined: every sample is
}

function readStbl(buf: Buffer, stbl: Box, t: BmffTrack) {
  const stts = child(buf, stbl, "stts");
  if (stts) {
    const n = buf.readUInt32BE(stts.start + 4);
    for (let k = 0; k < n && stts.start + 16 + 8 * k <= stts.end; k++) {
      const count = buf.readUInt32BE(stts.start + 8 + 8 * k);
      const delta = buf.readUInt32BE(stts.start + 12 + 8 * k);
      if (t.deltas.length + count > 50_000_000) throw new VideoError("the sample table is implausibly large");
      for (let i = 0; i < count; i++) t.deltas.push(delta);
    }
  }
  const stss = child(buf, stbl, "stss");
  if (stss) {
    const n = buf.readUInt32BE(stss.start + 4);
    t.sync = new Set();
    for (let k = 0; k < n && stss.start + 12 + 4 * k <= stss.end; k++) t.sync.add(buf.readUInt32BE(stss.start + 8 + 4 * k));
  }
}

// moof/traf/trun: a fragmented file's samples, with tfhd's and trex's
// defaults; a sample is a keyframe when its flags clear
// sample_is_non_sync_sample (0x10000).
function readFragment(buf: Buffer, moof: Box, tracks: BmffTrack[], defaults: Map<number, { duration: number; flags: number }>) {
  for (const traf of boxesIn(buf, moof.start, moof.end)) {
    if (traf.type !== "traf") continue;
    const tfhd = child(buf, traf, "tfhd");
    if (!tfhd) continue;
    const flags = buf.readUInt32BE(tfhd.start) & 0xffffff;
    const id = buf.readUInt32BE(tfhd.start + 4);
    const t = tracks.find(x => x.id === id);
    if (!t) continue;
    let at = tfhd.start + 8;
    if (flags & 1) at += 8;
    if (flags & 2) at += 4;
    let duration = defaults.get(id)?.duration ?? 0;
    let sampleFlags = defaults.get(id)?.flags ?? 0;
    if (flags & 8) (duration = buf.readUInt32BE(at)), (at += 4);
    if (flags & 0x10) at += 4;
    if (flags & 0x20) sampleFlags = buf.readUInt32BE(at);
    for (const trun of boxesIn(buf, traf.start, traf.end)) {
      if (trun.type !== "trun") continue;
      const tf = buf.readUInt32BE(trun.start) & 0xffffff;
      const count = buf.readUInt32BE(trun.start + 4);
      let p = trun.start + 8;
      if (tf & 1) p += 4;
      let first: number | undefined;
      if (tf & 4) (first = buf.readUInt32BE(p)), (p += 4);
      t.sync ??= new Set();
      for (let i = 0; i < count && p <= trun.end; i++) {
        let d = duration;
        let f = i === 0 && first !== undefined ? first : sampleFlags;
        if (tf & 0x100) (d = buf.readUInt32BE(p)), (p += 4);
        if (tf & 0x200) p += 4;
        if (tf & 0x400) (f = i === 0 && first !== undefined ? first : buf.readUInt32BE(p)), (p += 4);
        if (tf & 0x800) p += 4;
        t.deltas.push(d);
        if (!(f & 0x10000)) t.sync.add(t.deltas.length);
      }
    }
  }
}

function frameStats(deltas: number[], timescale: number, sync: Set<number> | undefined) {
  const frames = deltas.length;
  const total = deltas.reduce((a, b) => a + b, 0);
  // The last sample's duration is often a guess by the muxer: leave it out
  // when judging whether the rate is constant.
  const body = deltas.length > 2 ? deltas.slice(0, -1) : deltas;
  const constant = body.every(d => d === body[0]);
  const fps = constant && body[0] ? timescale / body[0] : total ? (frames * timescale) / total : 0;
  return { frames, fps: round(fps, 3), constant_frame_rate: constant, ...keyframeStats(frames, sync, fps) };
}

function keyframeStats(frames: number, sync: Set<number> | undefined, fps: number) {
  const keys = sync ? [...sync].filter(k => k >= 1 && k <= frames).sort((a, b) => a - b) : Array.from({ length: frames }, (_, i) => i + 1);
  if (!keys.length) return { keyframes: 0 };
  const gaps = keys.slice(1).map((k, i) => k - keys[i]);
  // The run after the last keyframe is cut short by the clip's end, so it
  // only counts toward the longest; one keyframe alone spans the clip.
  const tail = frames + 1 - keys[keys.length - 1];
  const average = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : tail;
  return { keyframes: keys.length, keyframe_interval: { average: round(average, 1), max: Math.max(tail, ...gaps), seconds: fps ? round(average / fps, 2) : 0 } };
}

function readBmff(src: Source): VideoFileInfo {
  const top = topBoxes(src);
  const ftyp = top.find(b => b.type === "ftyp");
  const moovAt = top.find(b => b.type === "moov");
  if (!moovAt) throw new VideoError(top.some(b => b.type === "mdat") ? "it has no moov box (an unfinished recording?)" : "it is not an MP4 or MOV file");
  if (moovAt.size > 512 * 1024 * 1024) throw new VideoError("its moov box is implausibly large");
  const brand = ftyp ? src.read(ftyp.at + ftyp.head, 4).toString("latin1") : undefined;
  const buf = src.read(moovAt.at, moovAt.size);
  const moov: Box = { type: "moov", start: moovAt.head, end: moovAt.size };
  const mvhd = child(buf, moov, "mvhd");
  let duration = 0;
  if (mvhd) {
    const v = buf[mvhd.start];
    const scale = buf.readUInt32BE(mvhd.start + (v === 1 ? 20 : 12));
    const d = v === 1 ? Number(buf.readBigUInt64BE(mvhd.start + 24)) : buf.readUInt32BE(mvhd.start + 16);
    if (scale) duration = d / scale;
  }
  const tracks: BmffTrack[] = [];
  const sizes = new Map<number, { width: number; height: number }>();
  for (const trak of boxesIn(buf, moov.start, moov.end)) {
    if (trak.type !== "trak") continue;
    const tkhd = child(buf, trak, "tkhd");
    const mdia = child(buf, trak, "mdia");
    if (!tkhd || !mdia) continue;
    const v = buf[tkhd.start];
    const id = buf.readUInt32BE(tkhd.start + (v === 1 ? 20 : 12));
    const wAt = tkhd.start + (v === 1 ? 88 : 76);
    if (wAt + 8 <= tkhd.end) sizes.set(id, { width: Math.round(buf.readUInt32BE(wAt) / 65536), height: Math.round(buf.readUInt32BE(wAt + 4) / 65536) });
    const mdhd = child(buf, mdia, "mdhd");
    const hdlr = child(buf, mdia, "hdlr");
    const mv = mdhd ? buf[mdhd.start] : 0;
    const t: BmffTrack = {
      id,
      handler: hdlr ? buf.toString("latin1", hdlr.start + 8, hdlr.start + 12) : "",
      timescale: mdhd ? buf.readUInt32BE(mdhd.start + (mv === 1 ? 20 : 12)) : 0,
      duration: mdhd ? (mv === 1 ? Number(buf.readBigUInt64BE(mdhd.start + 24)) : buf.readUInt32BE(mdhd.start + 16)) : 0,
      deltas: []
    };
    const stbl = path4(buf, mdia, "minf", "stbl");
    if (stbl) {
      const stsd = child(buf, stbl, "stsd");
      // The first sample entry, after the FullBox header and entry count.
      const entry = stsd ? boxesIn(buf, stsd.start + 8, stsd.end).next().value : undefined;
      if (entry) (t.entry = entry), (t.fourcc = entry && buf.toString("latin1", entry.start - 4, entry.start));
      readStbl(buf, stbl, t);
    }
    tracks.push(t);
  }
  // Fragmented: the samples are in the moof boxes after moov.
  if (tracks.every(t => !t.deltas.length) && top.some(b => b.type === "moof")) {
    const defaults = new Map<number, { duration: number; flags: number }>();
    const mvex = child(buf, moov, "mvex");
    if (mvex) for (const trex of boxesIn(buf, mvex.start, mvex.end)) if (trex.type === "trex") defaults.set(buf.readUInt32BE(trex.start + 4), { duration: buf.readUInt32BE(trex.start + 12), flags: buf.readUInt32BE(trex.start + 20) });
    for (const b of top) {
      if (b.type !== "moof" || b.size > 64 * 1024 * 1024) continue;
      const mb = src.read(b.at, b.size);
      readFragment(mb, { type: "moof", start: b.head, end: b.size }, tracks, defaults);
    }
  }

  const container = brand === "qt  " ? "mov" : "mp4";
  const info: VideoFileInfo = { container, ...(brand ? { brand: brand.trim() } : {}), duration: round(duration, 3), tracks: { video: 0, audio: 0, other: 0 } };
  for (const t of tracks) {
    if (t.handler === "vide") info.tracks.video++;
    else if (t.handler === "soun") info.tracks.audio++;
    else info.tracks.other++;
  }
  const v = tracks.find(t => t.handler === "vide" && t.entry);
  if (v && v.entry) {
    const e = v.entry;
    const at = e.start - 8; // the entry's own header
    const fourcc = v.fourcc!;
    const width = buf.readUInt16BE(at + 32) || sizes.get(v.id)?.width || 0;
    const height = buf.readUInt16BE(at + 34) || sizes.get(v.id)?.height || 0;
    const depth = buf.readUInt16BE(at + 82);
    // The configuration boxes after the 78 bytes of VisualSampleEntry.
    const config = (type: string) => {
      for (const b of boxesIn(buf, at + 86, e.end)) if (b.type === type) return buf.subarray(b.start, b.end);
      return undefined;
    };
    const avcC = config("avcC");
    const hvcC = config("hvcC");
    const av1C = config("av1C");
    const vpcC = config("vpcC");
    const profile = avcC ? avcProfile(avcC) : hvcC ? hevcProfile(hvcC) : av1C ? av1Profile(av1C) : vpcC && vpcC.length > 4 ? `profile ${vpcC[4]}` : PRORES[fourcc];
    const stats = frameStats(v.deltas, v.timescale, v.sync);
    if (!info.duration && v.timescale) info.duration = round(v.duration / v.timescale, 3) || round(v.deltas.reduce((a, b) => a + b, 0) / v.timescale, 3);
    info.video = {
      codec: FOURCC[fourcc] ?? fourcc.trim(),
      codec_tag: fourcc,
      ...(profile ? { profile } : {}),
      width,
      height,
      ...stats,
      // QuickTime's depth 32 is "with alpha" (ProRes 4444, PNG, Animation);
      // ffmpeg writes it so too. HEVC's alpha layer (Apple) is not read.
      alpha: depth === 32
    };
  }
  const a = tracks.find(t => t.handler === "soun" && t.entry);
  if (a && a.entry) {
    const at = a.entry.start - 8;
    const fourcc = a.fourcc!;
    const version = buf.readUInt16BE(at + 16);
    let channels = buf.readUInt16BE(at + 24);
    let rate = buf.readUInt32BE(at + 32) / 65536;
    // QuickTime sound description v1 adds 16 bytes, v2 moves the rate and
    // channels to a float64 and a uint32.
    let children = at + 36 + (version === 1 ? 16 : 0);
    if (version === 2) {
      rate = buf.readDoubleBE(at + 40);
      channels = buf.readUInt32BE(at + 48);
      children = at + 72;
    }
    let codec = FOURCC[fourcc] ?? fourcc.trim();
    let profile: string | undefined;
    const kids = [...boxesIn(buf, children, a.entry.end)];
    // QuickTime wraps esds in a wave box.
    const wave = kids.find(k => k.type === "wave");
    const es = kids.find(k => k.type === "esds") ?? (wave ? child(buf, wave, "esds") : undefined);
    if (es) {
      const d = esds(buf.subarray(es.start, es.end));
      if (d.codec) codec = d.codec;
      if (d.config && codec === "aac") {
        const c = aacConfig(d.config);
        profile = c.profile;
        if (c.rate) rate = c.rate;
        if (c.channels) channels = c.channels;
      }
    }
    const dOps = kids.find(k => k.type === "dOps");
    if (dOps) (channels = buf[dOps.start + 1]), (rate = buf.readUInt32BE(dOps.start + 4) || 48000);
    info.audio = { codec, codec_tag: fourcc, ...(profile ? { profile } : {}), sample_rate: Math.round(rate), channels };
  }
  return info;
}

// ---- EBML (WebM, Matroska) ----

const ID = {
  EBML: 0x1a45dfa3, DocType: 0x4282, Segment: 0x18538067, Info: 0x1549a966, TimestampScale: 0x2ad7b1, Duration: 0x4489,
  Tracks: 0x1654ae6b, TrackEntry: 0xae, TrackNumber: 0xd7, TrackUID: 0x73c5, TrackType: 0x83, CodecID: 0x86, CodecPrivate: 0x63a2, DefaultDuration: 0x23e383,
  Video: 0xe0, PixelWidth: 0xb0, PixelHeight: 0xba, AlphaMode: 0x53c0, Audio: 0xe1, SamplingFrequency: 0xb5, Channels: 0x9f,
  Cluster: 0x1f43b675, Timestamp: 0xe7, SimpleBlock: 0xa3, BlockGroup: 0xa0, Block: 0xa1, ReferenceBlock: 0xfb,
  Tags: 0x1254c367, Tag: 0x7373, Targets: 0x63c0, TagTrackUID: 0x63c5, SimpleTag: 0x67c8, TagName: 0x45a3, TagString: 0x4487
};

// Children of a Segment that end a Cluster of unknown size.
const SEGMENT_LEVEL = new Set([ID.Cluster, ID.Info, ID.Tracks, ID.Tags, 0x1c53bb6b, 0x114d9b74, 0x1043a770, 0x1941a469]);

interface Element {
  id: number;
  start: number; // payload
  end: number; // an unknown size ends where its content does (unknownEnd)
  unknown: boolean;
}

function vint(src: Source, at: number, keepMarker: boolean): { value: number; length: number; allOnes: boolean } | undefined {
  const first = src.read(at, 1)[0];
  if (first === undefined || first === 0) return undefined;
  let length = 1;
  while (!(first & (0x80 >> (length - 1)))) length++;
  const bytes = src.read(at, length);
  if (bytes.length < length) return undefined;
  let value = keepMarker ? first : first & (0xff >> length);
  let allOnes = value === (0xff >> length);
  for (let i = 1; i < length; i++) {
    value = value * 256 + bytes[i];
    if (bytes[i] !== 0xff) allOnes = false;
  }
  return { value, length, allOnes };
}

// An element of unknown size (a live recording's Segment and Clusters, as
// browsers' MediaRecorder writes them) ends where an element that cannot be
// inside it begins: for a Cluster, the next Segment-level one.
function unknownEnd(src: Source, id: number, start: number, to: number): number {
  if (id !== ID.Cluster) return to;
  let at = start;
  while (at < to) {
    const child = vint(src, at, true);
    const size = child && vint(src, at + child.length, false);
    if (!child || !size || SEGMENT_LEVEL.has(child.value) || size.allOnes) break;
    at += child.length + size.length + size.value;
  }
  return Math.min(at, to);
}

function* elements(src: Source, from: number, to: number): Generator<Element> {
  let at = from;
  while (at < to) {
    const id = vint(src, at, true);
    if (!id) return;
    const size = vint(src, at + id.length, false);
    if (!size) return;
    const start = at + id.length + size.length;
    const end = size.allOnes ? unknownEnd(src, id.value, start, to) : Math.min(to, start + size.value);
    yield { id: id.value, start, end, unknown: size.allOnes };
    if (end <= at) return;
    at = end;
  }
}

const uint = (src: Source, e: Element) => {
  let v = 0;
  for (const b of src.read(e.start, Math.min(8, e.end - e.start))) v = v * 256 + b;
  return v;
};
const float = (src: Source, e: Element) => {
  const b = src.read(e.start, e.end - e.start);
  return b.length === 4 ? b.readFloatBE(0) : b.length === 8 ? b.readDoubleBE(0) : 0;
};
const text = (src: Source, e: Element) => src.read(e.start, Math.min(4096, e.end - e.start)).toString("utf8").replace(/\0+$/, "");

const MKV_CODECS: Record<string, string> = {
  V_VP8: "vp8", V_VP9: "vp9", V_AV1: "av1", "V_MPEG4/ISO/AVC": "h264", "V_MPEGH/ISO/HEVC": "hevc", V_THEORA: "theora", "V_MPEG4/ISO/SP": "mpeg4", "V_MPEG4/ISO/ASP": "mpeg4", V_PRORES: "prores", V_MJPEG: "mjpeg",
  A_OPUS: "opus", A_VORBIS: "vorbis", A_AAC: "aac", A_MPEG_L3: "mp3", A_FLAC: "flac", A_AC3: "ac3", A_EAC3: "eac3", "A_PCM/INT/LIT": "pcm", "A_PCM/FLOAT/IEEE": "pcm"
};

interface MkvTrack {
  number: number;
  uid: number;
  type: number;
  codecId: string;
  priv?: Buffer;
  defaultDuration?: number;
  width?: number;
  height?: number;
  alpha?: number;
  rate?: number;
  channels?: number;
}

function readEbml(src: Source): VideoFileInfo {
  const head = elements(src, 0, src.size).next().value;
  if (!head || head.id !== ID.EBML) throw new VideoError("it is not a WebM or Matroska file");
  let docType = "matroska";
  for (const e of elements(src, head.start, head.end)) if (e.id === ID.DocType) docType = text(src, e);
  const segment = [...elements(src, head.end, src.size)].find(e => e.id === ID.Segment);
  if (!segment) throw new VideoError("it has no Segment");
  let scale = 1_000_000; // ns per timestamp tick
  let duration = 0;
  const tracks: MkvTrack[] = [];
  const tagAlpha = new Set<number>();
  const tagDuration = new Map<number, number>();
  let videoTrack: MkvTrack | undefined;
  const times: number[] = [];
  const keys = new Set<number>();
  let firstFrame: Buffer | undefined;
  for (const top of elements(src, segment.start, segment.end)) {
    if (top.id === ID.Info) {
      for (const e of elements(src, top.start, top.end)) {
        if (e.id === ID.TimestampScale) scale = uint(src, e) || scale;
        if (e.id === ID.Duration) duration = float(src, e);
      }
    } else if (top.id === ID.Tracks) {
      for (const te of elements(src, top.start, top.end)) {
        if (te.id !== ID.TrackEntry) continue;
        const t: MkvTrack = { number: 0, uid: 0, type: 0, codecId: "" };
        for (const e of elements(src, te.start, te.end)) {
          if (e.id === ID.TrackNumber) t.number = uint(src, e);
          else if (e.id === ID.TrackUID) t.uid = uint(src, e);
          else if (e.id === ID.TrackType) t.type = uint(src, e);
          else if (e.id === ID.CodecID) t.codecId = text(src, e);
          else if (e.id === ID.CodecPrivate) t.priv = src.read(e.start, Math.min(1 << 16, e.end - e.start));
          else if (e.id === ID.DefaultDuration) t.defaultDuration = uint(src, e);
          else if (e.id === ID.Video) {
            for (const v of elements(src, e.start, e.end)) {
              if (v.id === ID.PixelWidth) t.width = uint(src, v);
              if (v.id === ID.PixelHeight) t.height = uint(src, v);
              if (v.id === ID.AlphaMode) t.alpha = uint(src, v);
            }
          } else if (e.id === ID.Audio) {
            for (const a of elements(src, e.start, e.end)) {
              if (a.id === ID.SamplingFrequency) t.rate = float(src, a);
              if (a.id === ID.Channels) t.channels = uint(src, a);
            }
          }
        }
        tracks.push(t);
      }
      videoTrack = tracks.find(t => t.type === 1);
    } else if (top.id === ID.Tags) {
      // ffmpeg also writes alpha and each track's length as tags.
      for (const tag of elements(src, top.start, top.end)) {
        if (tag.id !== ID.Tag) continue;
        let uid = 0;
        const simple: [string, string][] = [];
        for (const e of elements(src, tag.start, tag.end)) {
          if (e.id === ID.Targets) for (const t of elements(src, e.start, e.end)) if (t.id === ID.TagTrackUID) uid = uint(src, t);
          if (e.id === ID.SimpleTag) {
            let [name, value] = ["", ""];
            for (const s of elements(src, e.start, e.end)) {
              if (s.id === ID.TagName) name = text(src, s).toUpperCase();
              if (s.id === ID.TagString) value = text(src, s);
            }
            simple.push([name, value]);
          }
        }
        for (const [name, value] of simple) {
          if (name === "ALPHA_MODE" && value === "1") tagAlpha.add(uid);
          const m = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(value);
          if (name === "DURATION" && m) tagDuration.set(uid, +m[1] * 3600 + +m[2] * 60 + +m[3]);
        }
      }
    } else if (top.id === ID.Cluster && videoTrack) {
      let base = 0;
      const block = (at: number, simple: boolean, hasReference: boolean) => {
        const track = vint(src, at, false);
        if (!track || track.value !== videoTrack!.number) return;
        const b = src.read(at + track.length, 3);
        if (b.length < 3) return;
        const time = base + b.readInt16BE(0);
        const flags = b[2];
        // Laced video is rare; each laced frame shares the block's time.
        const laced = flags & 0x06 ? src.read(at + track.length + 3, 1)[0] + 1 : 1;
        if (!times.length && !(flags & 0x06)) firstFrame = src.read(at + track.length + 3, 3);
        for (let i = 0; i < laced; i++) times.push(time);
        if (simple ? flags & 0x80 : !hasReference) keys.add(times.length - laced + 1);
      };
      for (const e of elements(src, top.start, top.end)) {
        if (e.id === ID.Timestamp) base = uint(src, e);
        else if (e.id === ID.SimpleBlock) block(e.start, true, false);
        else if (e.id === ID.BlockGroup) {
          let at = -1;
          let ref = false;
          for (const g of elements(src, e.start, e.end)) {
            if (g.id === ID.Block) at = g.start;
            if (g.id === ID.ReferenceBlock) ref = true;
          }
          if (at >= 0) block(at, false, ref);
        }
      }
    }
  }
  const info: VideoFileInfo = {
    container: docType === "webm" ? "webm" : "matroska",
    duration: 0,
    tracks: { video: tracks.filter(t => t.type === 1).length, audio: tracks.filter(t => t.type === 2).length, other: tracks.filter(t => t.type !== 1 && t.type !== 2).length }
  };
  const v = videoTrack;
  const secondsPerTick = scale / 1e9;
  if (v) {
    // Frame times in display order; the gaps between them are the durations.
    const sorted = [...times].sort((a, b) => a - b);
    const gaps = sorted.slice(1).map((t, i) => t - sorted[i]).filter(g => g > 0);
    const step = v.defaultDuration ? v.defaultDuration / scale : median(gaps);
    const fps = v.defaultDuration ? 1e9 / v.defaultDuration : step ? 1 / (step * secondsPerTick) : 0;
    const constant = gaps.length ? gaps.every(g => Math.abs(g - gaps[0]) <= 1) : true;
    const codec = MKV_CODECS[v.codecId] ?? v.codecId.replace(/^V_/, "").toLowerCase();
    // VP9's CodecPrivate is id/length/value features, profile is id 1;
    // AV1's is av1C, AVC's avcC, HEVC's hvcC.
    let profile: string | undefined;
    if (v.priv && codec === "vp9") for (let i = 0; i + 2 < v.priv.length; i += 2 + v.priv[i + 1]) if (v.priv[i] === 1) profile = `profile ${v.priv[i + 2]}`;
    // Without it, the first frame says: VP9's header starts with the frame
    // marker 0b10, then the profile's low and high bits; VP8's frame tag
    // has the version (its profile) in bits 1-3.
    if (!profile && firstFrame?.length && codec === "vp9" && firstFrame[0] >> 6 === 2) profile = `profile ${((firstFrame[0] >> 5) & 1) | (((firstFrame[0] >> 4) & 1) << 1)}`;
    if (!profile && firstFrame?.length && codec === "vp8") profile = `profile ${(firstFrame[0] >> 1) & 7}`;
    if (v.priv && codec === "av1") profile = av1Profile(v.priv);
    if (v.priv && codec === "h264") profile = avcProfile(v.priv);
    if (v.priv && codec === "hevc") profile = hevcProfile(v.priv);
    info.video = {
      codec,
      codec_tag: v.codecId,
      ...(profile ? { profile } : {}),
      width: v.width ?? 0,
      height: v.height ?? 0,
      frames: times.length,
      fps: round(fps, 3),
      constant_frame_rate: constant,
      ...keyframeStats(times.length, keys, fps),
      alpha: v.alpha === 1 || tagAlpha.has(v.uid)
    };
  }
  // Info's Duration (in ticks), else ffmpeg's DURATION tag, else the span
  // of the frames plus one frame.
  const span = () => {
    if (!v || !times.length) return 0;
    const sorted = [...times].sort((x, y) => x - y);
    return (sorted[sorted.length - 1] - sorted[0]) * secondsPerTick + (info.video?.fps ? 1 / info.video.fps : 0);
  };
  const seconds = duration * secondsPerTick || (v ? tagDuration.get(v.uid) : undefined) || span();
  info.duration = round(seconds, 3);
  const a = tracks.find(t => t.type === 2);
  if (a) {
    const codec = MKV_CODECS[a.codecId] ?? a.codecId.replace(/^A_/, "").toLowerCase();
    const aac = codec === "aac" && a.priv ? aacConfig(a.priv) : {};
    info.audio = { codec, codec_tag: a.codecId, ...(aac.profile ? { profile: aac.profile } : {}), sample_rate: Math.round(aac.rate ?? a.rate ?? 8000), channels: aac.channels ?? a.channels ?? 1 };
  }
  return info;
}

// ---- Ogg (Theora, Vorbis, Opus) ----

function readOgg(src: Source): VideoFileInfo {
  // The first page of each stream holds its identification header.
  const pages = (from: number, to: number) => {
    const out: { at: number; granule: bigint; serial: number; body: number; size: number }[] = [];
    let at = from;
    while (at + 27 <= to) {
      const h = src.read(at, 27);
      if (h.toString("latin1", 0, 4) !== "OggS") {
        const next = src.read(at + 1, Math.min(1 << 16, to - at - 1)).indexOf("OggS", 0, "latin1");
        if (next < 0) break;
        at += 1 + next;
        continue;
      }
      const segments = h[26];
      const table = src.read(at + 27, segments);
      const size = table.reduce((a, b) => a + b, 0);
      out.push({ at, granule: h.readBigInt64LE(6), serial: h.readUInt32LE(14), body: at + 27 + segments, size });
      at += 27 + segments + size;
    }
    return out;
  };
  const head = pages(0, Math.min(src.size, 1 << 20)).slice(0, 16);
  const streams = new Map<number, { kind: "theora" | "vorbis" | "opus" | "other"; id: Buffer }>();
  for (const p of head) {
    if (streams.has(p.serial)) continue;
    const id = src.read(p.body, Math.min(p.size, 64));
    const kind = id.toString("latin1", 1, 7) === "theora" && id[0] === 0x80 ? "theora" : id.toString("latin1", 1, 7) === "vorbis" && id[0] === 1 ? "vorbis" : id.toString("latin1", 0, 8) === "OpusHead" ? "opus" : "other";
    streams.set(p.serial, { kind, id });
  }
  if (!streams.size) throw new VideoError("it is not an Ogg file");
  // The last page of each stream, from the file's tail.
  const tail = pages(Math.max(0, src.size - (1 << 18)), src.size);
  const lastGranule = (serial: number) => [...head, ...tail].filter(p => p.serial === serial && p.granule >= 0n).pop()?.granule ?? 0n;
  const info: VideoFileInfo = { container: "ogg", duration: 0, tracks: { video: 0, audio: 0, other: 0 } };
  for (const [serial, s] of streams) {
    if (s.kind === "theora") {
      info.tracks.video++;
      if (info.video) continue;
      const id = s.id;
      // Theora's header: picture width and height (24 bits each) at 14 and
      // 17, frame rate numerator and denominator at 22 and 26, the
      // keyframe granule shift in bits 5-9 of bytes 40-41.
      const width = id.readUIntBE(14, 3);
      const height = id.readUIntBE(17, 3);
      const fps = id.readUInt32BE(22) / (id.readUInt32BE(26) || 1);
      const shift = ((id.readUInt16BE(40) >> 5) & 0x1f) || 6;
      const g = lastGranule(serial);
      // granulepos = last keyframe << shift | frames since it; Theora 3.2.1
      // and later count the first frame as 1.
      const frames = Number(g >> BigInt(shift)) + Number(g & ((1n << BigInt(shift)) - 1n)) + (id[9] >= 1 ? 0 : 1);
      info.video = { codec: "theora", codec_tag: "theora", width, height, fps: round(fps, 3), constant_frame_rate: true, frames, alpha: false };
      info.duration = round(fps ? frames / fps : 0, 3);
    } else if (s.kind === "vorbis" || s.kind === "opus") {
      info.tracks.audio++;
      if (info.audio) continue;
      const channels = s.kind === "vorbis" ? s.id[11] : s.id[9];
      const rate = s.kind === "vorbis" ? s.id.readUInt32LE(12) : 48000; // Opus always runs at 48 kHz
      info.audio = { codec: s.kind, codec_tag: s.kind, sample_rate: rate, channels };
      if (!info.video) {
        const skip = s.kind === "opus" ? s.id.readUInt16LE(10) : 0;
        info.duration = round(Math.max(0, Number(lastGranule(serial)) - skip) / rate, 3);
      }
    } else info.tracks.other++;
  }
  return info;
}

export function readVideoInfo(file: string): VideoFileInfo {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new CliError(`File not found: ${file}`, EXIT.USAGE);
    if (code === "EISDIR") throw new CliError(`${file} is a folder, not a video`, EXIT.USAGE);
    throw err;
  }
  try {
    const src = new Source(fd, fs.fstatSync(fd).size);
    const magic = src.read(0, 12);
    if (magic.readUInt32BE(0) === ID.EBML) return readEbml(src);
    if (magic.toString("latin1", 0, 4) === "OggS") return readOgg(src);
    if (/^(ftyp|moov|mdat|free|skip|wide|pnot|uuid)$/.test(magic.toString("latin1", 4, 8))) return readBmff(src);
    throw new VideoError("the toolbox reads MP4, MOV, WebM, Matroska (MKV) and Ogg videos");
  } catch (err) {
    if (err instanceof VideoError || err instanceof RangeError) throw new CliError(`Cannot read ${file}: ${err.message}`, EXIT.BAD_INPUT);
    throw err;
  } finally {
    fs.closeSync(fd);
  }
}

// What plays the file natively, per engine, from the engines' own pages:
//   Godot 4: "only the Ogg Theora video format" (VideoStreamTheora):
//     https://docs.godotengine.org/en/stable/tutorials/animation/playing_videos.html
//   Unity: H.264 in .mp4 (every platform), VP8 in .webm (every platform),
//     H.265 on some; VP8 in WebM is the format that keeps alpha:
//     https://docs.unity3d.com/Manual/VideoSources-FileCompatibility.html
//     https://docs.unity3d.com/Manual/VideoTransparency.html
//   Unreal: the Media Framework's Electra player and the platform players
//     take H.264 in .mp4 everywhere; H.265 depends on the platform:
//     https://dev.epicgames.com/documentation/en-us/unreal-engine/media-framework-technical-reference-for-unreal-engine
//   Browsers (MDN's codec guide): H.264 MP4 everywhere; VP8/VP9 WebM in
//     Chrome, Edge and Firefox, and recent Safari (not with alpha); AV1 in
//     Chrome, Edge and Firefox, in Safari with a hardware decoder; HEVC in
//     Safari, elsewhere with a hardware decoder; Theora in Firefox only:
//     https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Video_codecs
export function engineSupport(info: VideoFileInfo) {
  const v = info.video;
  const codec = v?.codec ?? "";
  const c = info.container;
  const mp4 = c === "mp4" || c === "mov";
  const h264mp4 = codec === "h264" && c === "mp4";
  const godot = c === "ogg" && codec === "theora";
  const unity = h264mp4 || (codec === "vp8" && c === "webm");
  const unreal = h264mp4;
  // MOV is Safari's: the others often play H.264 in it, but do not list it.
  const browsers: Record<string, boolean | "hardware" | "recent"> =
    codec === "h264" && c === "mp4"
      ? { chrome: true, edge: true, firefox: true, safari: true }
      : codec === "h264" && c === "mov"
        ? { chrome: false, edge: false, firefox: false, safari: true }
      : (codec === "vp8" || codec === "vp9") && c === "webm"
        ? { chrome: true, edge: true, firefox: true, safari: v?.alpha ? false : "recent" }
        : codec === "vp9" && c === "mp4"
          ? { chrome: true, edge: true, firefox: true, safari: false }
        : codec === "av1" && (c === "mp4" || c === "webm")
          ? { chrome: true, edge: true, firefox: true, safari: "hardware" }
          : codec === "hevc" && mp4
            ? { chrome: "hardware", edge: "hardware", firefox: false, safari: true }
            : codec === "theora" && c === "ogg"
              ? { chrome: false, edge: false, firefox: true, safari: false }
              : { chrome: false, edge: false, firefox: false, safari: c === "mov" && codec === "prores" ? true : false };
  const yes = Object.values(browsers).filter(x => x === true).length;
  return {
    godot: { plays: godot, note: godot ? "VideoStreamTheora plays it" : "Godot 4 plays only Ogg Theora (.ogv)" },
    unity: {
      plays: unity,
      note: unity
        ? `${codec === "vp8" ? "VP8 WebM" : "H.264 MP4"} imports and plays on every platform${v?.alpha && codec === "vp8" ? ", alpha included" : ""}`
        : codec === "hevc"
          ? "H.265 plays on some platforms only; H.264 MP4 or VP8 WebM play everywhere"
          : v?.alpha
            ? "Unity keeps alpha in VP8 WebM; this needs converting"
            : "Unity plays H.264 MP4 and VP8 WebM everywhere; this needs converting"
    },
    unreal: { plays: unreal, note: unreal ? "Media Framework plays H.264 MP4" : codec === "hevc" ? "H.265 depends on the platform; H.264 MP4 plays everywhere" : "Unreal's Media Framework plays H.264 MP4 everywhere; this needs converting" },
    browsers: { plays: yes === 4 ? "all" : Object.values(browsers).some(x => x !== false) ? "some" : "none", ...browsers }
  };
}

TOOLS.push({
  group: "video",
  name: "info",
  args: "<video>",
  summary: "What is in a video: codec, size, frame rate, frames, keyframes, alpha, audio, and which engines play it",
  details: [
    "Reads MP4 and MOV (H.264, HEVC, AV1, VP9, ProRes...), WebM and Matroska (VP8, VP9, AV1...) and Ogg",
    "Theora itself, without ffmpeg. engine_support says what plays it natively in Godot 4 (Ogg Theora",
    "only), Unity (H.264 MP4, VP8 WebM), Unreal (H.264 MP4) and the browsers."
  ],
  flags: [],
  async run(ctx: Ctx, call: ToolCall) {
    if (call.args.length !== 1) throw usage("Usage: ludo toolbox video info <video>");
    const file = call.args[0];
    const info = readVideoInfo(file);
    if (!info.video) throw new CliError(`${file} has no video track${info.audio ? ` (only ${info.audio.codec} audio)` : ""}`, EXIT.BAD_INPUT, info.audio ? `For a sound, use: ludo toolbox audio info ${shown(file)}` : undefined);
    const support = engineSupport(info);
    const bytes = fs.statSync(file).size;
    const next = hint("Turn it into a spritesheet (needs ffmpeg)", `ludo toolbox sprite from-video ${shown(file)}`);
    if (ctx.jsonOut) {
      printJson({ video: shown(file), bytes, ...info, engine_support: support, ...hintJson(ctx, next) }, false);
    } else {
      const v = info.video;
      const key = v.keyframe_interval ? `, a keyframe every ${v.keyframe_interval.average} frames (${v.keyframe_interval.seconds} s)` : "";
      process.stdout.write(`${info.container.toUpperCase()}: ${v.codec}${v.profile ? ` (${v.profile})` : ""}, ${v.width}x${v.height}, ${v.fps} fps${v.constant_frame_rate ? "" : " (variable)"}, ${v.frames} frames, ${info.duration} s${key}${v.alpha ? ", with alpha" : ""}\n`);
      process.stdout.write(info.audio ? `Audio: ${info.audio.codec}${info.audio.profile ? ` (${info.audio.profile})` : ""}, ${info.audio.sample_rate} Hz, ${info.audio.channels} channel${info.audio.channels === 1 ? "" : "s"}\n` : "No audio\n");
      for (const [engine, s] of Object.entries(support)) {
        if (engine === "browsers") process.stdout.write(`Browsers: ${s.plays}\n`);
        else process.stdout.write(`${engine[0].toUpperCase()}${engine.slice(1)}: ${s.plays ? "plays it" : "no"} (${(s as { note: string }).note})\n`);
      }
      printHint(ctx, next);
    }
    return EXIT.OK;
  }
});
