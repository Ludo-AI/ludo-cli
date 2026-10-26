import fs from "node:fs";
import path from "node:path";
import { CliError, EXIT } from "../errors.js";
import { printJson, type Ctx } from "../generate.js";
import type { Image } from "../tty/png.js";
import { baseOf, freeName, loadImageFile, shown, writePng, type Loaded } from "./io.js";
import { contentBox, emptiness } from "./pixels.js";
import { crop, sliceSheet, type Rect } from "./sheet.js";
import { gridFlag, positiveInt, textFlag } from "./flags.js";
import { resolveGrid, natural } from "./sprite.js";
import { loadAudioFile } from "./audio-io.js";
import { audibleRange, frames as frameCount, fromDb, loudness, momentaryLoudness, samplePeakAt, toDb, toMono, truePeakAt } from "./sound.js";
import type { Audio } from "./wav.js";
import { fft1d } from "./fft.js";
import { canvas, checkerboard, cross, dot, drawImage, fillRect, fitText, label, line, scaled, strokeRect, text, textHeight, textWidth, thickLine, type Rgba } from "./draw.js";
import { hint, TOOLS, type ToolCall } from "./registry.js";

// `ludo toolbox sprite contact`, `audio waveform` and `image contact`: one
// labelled PNG of an asset, for an agent that can read images but cannot
// play an animation or hear a sound. They draw a picture of the asset and
// never change it.

const usage = (message: string) => new CliError(message, EXIT.USAGE);

// ---- Colours, shared by the pictures ----

const BG: Rgba = [22, 22, 29, 255];
const PANEL: Rgba = [12, 12, 16, 255];
const STRIP: Rgba = [40, 40, 52, 255];
const INK: Rgba = [232, 232, 240, 255];
const DIM: Rgba = [150, 150, 165, 255];
const BOUNDS: Rgba = [0, 200, 255, 255];
const GROUND: Rgba = [255, 64, 96, 255];
const PIVOT: Rgba = [255, 214, 0, 255];
const CENTRE: Rgba = [255, 64, 255, 255];
const SIZE = 2; // font pixels: 2 keeps labels readable after a viewer shrinks the image

// A colour for a moment in time, 0 (first) to 1 (last): blue, cyan, green,
// yellow, red, all bright enough to read on the dark panels.
const RAMP: Rgba[] = [
  [64, 128, 255, 255],
  [0, 210, 220, 255],
  [80, 220, 80, 255],
  [250, 210, 40, 255],
  [255, 70, 60, 255]
];
export function timeColour(t: number, stops: Rgba[] = RAMP): Rgba {
  const u = Math.min(1, Math.max(0, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(u));
  const f = u - i;
  const [a, b] = [stops[i], stops[i + 1]];
  return [0, 1, 2].map(k => Math.round(a[k] + (b[k] - a[k]) * f)).concat(255) as unknown as Rgba;
}

const hex = (c: Rgba) => "#" + c.slice(0, 3).map(v => v.toString(16).padStart(2, "0")).join("");

// A row of colour swatches with names, as a picture's key. Returns its width.
function legendRow(img: Image | undefined, x: number, y: number, items: [Rgba, string][]): number {
  let at = x;
  for (const [c, name] of items) {
    if (img) fillRect(img, at, y + 2, 12, 12, c);
    at += 18;
    if (img) text(img, at, y, name, INK, SIZE);
    at += textWidth(name, SIZE) + 20;
  }
  return at - 20 - x;
}

// ---- sprite contact ----

// Alpha at or under this is empty for the overlays (the pixels a GIF or an
// engine's alpha cutoff would drop); an opaque sheet uses its border colour.
const ALPHA_EMPTY = 127;
export const MAX_SIDE = 2048;
const MIN_CELL = 48; // px on a cell's longest side, under which --every steps in
const MAX_CELL = 320; // tiny sprites are enlarged up to this, no further
const M = 12; // margin
const GAP = 6; // between cells
const STRIP_H = textHeight(SIZE) + 6; // a cell's label strip
const HEADER_H = M + 2 * (textHeight(SIZE) + 8) + 4;
const PANEL_GAP = 16;
const ONION_MAX = 12;

export interface FrameFacts {
  box?: Rect; // the opaque bounds
  centre?: { x: number; y: number }; // the centre of mass, each opaque pixel weighing the same
}

export function frameFacts(frame: Image, isEmpty: (rgba: Uint8Array, i: number) => boolean): FrameFacts {
  const box = contentBox([frame], isEmpty);
  if (!box) return {};
  let [sx, sy, n] = [0, 0, 0];
  for (let y = box.y; y < box.y + box.h; y++) {
    for (let x = box.x; x < box.x + box.w; x++) {
      if (isEmpty(frame.rgba, (y * frame.width + x) * 4)) continue;
      sx += x + 0.5;
      sy += y + 0.5;
      n++;
    }
  }
  return { box, centre: { x: sx / n, y: sy / n } };
}

export interface ContactLayout {
  cols: number;
  rows: number;
  scale: number; // output pixels per frame pixel, in the grid
  cellW: number; // a frame's size in the grid
  cellH: number;
  panelScale: number;
  panelW: number;
  panelH: number;
  width: number;
  height: number;
  gridX: number; // the first cell's frame, top-left
  gridY: number;
  pitchX: number; // from one cell to the next
  pitchY: number;
  panelY: number; // the panels' frames, top
}

// The grid and panels at one scale and column count.
function layoutAt(fw: number, fh: number, count: number, cols: number, scale: number, minWidth: number, panels?: number): ContactLayout {
  const rows = Math.ceil(count / cols);
  const cellW = Math.max(1, Math.round(fw * scale));
  const cellH = Math.max(1, Math.round(fh * scale));
  // The two panels side by side span about the grid's width, up to two
  // cells each: bigger, and they crowd out the frames.
  const k = Math.max(1, Math.min(2, Math.floor(cols / 2)));
  const panelScale = panels ?? scale * k;
  const panelW = Math.max(1, Math.round(fw * panelScale));
  const panelH = Math.max(1, Math.round(fh * panelScale));
  const gridW = cols * cellW + (cols - 1) * GAP;
  const width = 2 * M + Math.max(gridW, 2 * panelW + PANEL_GAP, minWidth);
  const pitchY = STRIP_H + cellH + GAP;
  const gridY = HEADER_H + STRIP_H;
  const panelY = HEADER_H + rows * pitchY - GAP + PANEL_GAP + STRIP_H;
  return { cols, rows, scale, cellW, cellH, panelScale, panelW, panelH, width, height: panelY + panelH + M, gridX: M, gridY, pitchX: cellW + GAP, pitchY, panelY };
}

// The biggest scale that keeps the picture within `maxSide`, over every
// column count; whole factors when enlarging, so pixel art keeps its
// pixels, up to MAX_CELL on a cell's longest side.
export function contactLayout(fw: number, fh: number, count: number, maxSide = MAX_SIDE, wantCols?: number, minWidth = 0): ContactLayout {
  const fits = (l: ContactLayout) => l.width <= maxSide && l.height <= maxSide;
  const options: ContactLayout[] = [];
  for (let cols = wantCols ?? 1; cols <= (wantCols ?? count); cols++) {
    let [lo, hi] = [0, Math.max(1, MAX_CELL / Math.max(fw, fh))];
    if (fits(layoutAt(fw, fh, count, cols, hi, minWidth))) lo = hi;
    else for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (fits(layoutAt(fw, fh, count, cols, mid, minWidth))) lo = mid;
      else hi = mid;
    }
    let s = lo >= 1 ? Math.floor(lo) : Math.floor(lo * 1000) / 1000;
    while (s > 0.001 && !fits(layoutAt(fw, fh, count, cols, s, minWidth))) s = Math.floor(s * 999) / 1000;
    if (s <= 0) continue;
    options.push(layoutAt(fw, fh, count, cols, s, minWidth));
  }
  // The most pixels per frame wins, but a grid with fewer empty cells
  // within 8% of it is easier to read (4x4 for 16 frames, not 7, 7 and 2);
  // then the squarer picture.
  const top = Math.max(...options.map(o => o.scale));
  const empty = (x: ContactLayout) => x.cols * x.rows - count;
  const squareness = (x: ContactLayout) => Math.min(x.width, x.height) / Math.max(x.width, x.height);
  const best = options
    .filter(o => o.scale >= top * 0.92)
    .sort((a, b) => empty(a) - empty(b) || b.scale - a.scale || squareness(b) - squareness(a))[0];
  if (!best) throw new CliError(`${count} frames do not fit a ${maxSide} px picture`, EXIT.USAGE, "Show fewer with --every, or allow more with --max-size.");
  // The panels then grow into what room is left: across the picture's
  // width, and down to its longest side.
  const room = Math.min((best.width - 2 * M - PANEL_GAP) / (2 * fw), (maxSide - best.panelY - M) / fh);
  const grown = room >= 1 ? Math.floor(room) : Math.floor(room * 1000) / 1000;
  if (grown > best.panelScale) {
    const bigger = layoutAt(fw, fh, count, best.cols, best.scale, minWidth, grown);
    if (fits(bigger)) return bigger;
  }
  return best;
}

interface ContactInput {
  frames: Image[]; // every frame of the animation
  shown: number[]; // the frame indices (from 0) to draw
  title: string;
  maxSide: number;
  cols?: number;
}

export interface Contact {
  image: Image;
  layout: ContactLayout;
  ground: number | null; // the row under the lowest opaque pixel of any frame
  pivot: { x: number; y: number } | null;
  facts: FrameFacts[]; // per shown frame
  inset?: number; // the motion trail inset's magnification, when it has one
  onion: number[]; // the frame numbers (from 1) in the onion skin
}

// The contact sheet: the shown frames on a checkerboard with their bounds,
// the shared ground line, the pivot and each centre of mass; then the onion
// skin (every shown frame over the others, coloured by time) and the motion
// trail (the centres of mass joined in order).
export function drawContact(input: ContactInput): Contact {
  const { frames, shown } = input;
  const { width: fw, height: fh } = frames[0];
  const picked = shown.map(i => frames[i]);
  const isEmpty = emptiness(picked, ALPHA_EMPTY);
  const facts = picked.map(f => frameFacts(f, isEmpty));
  const boxes = facts.map(f => f.box).filter((b): b is Rect => !!b);
  const ground = boxes.length ? Math.max(...boxes.map(b => b.y + b.h)) : null;
  const left = boxes.length ? Math.min(...boxes.map(b => b.x)) : 0;
  const right = boxes.length ? Math.max(...boxes.map(b => b.x + b.w)) : 0;
  const pivot = ground === null ? null : { x: (left + right) / 2, y: ground };

  const legend: [Rgba, string][] = [
    [BOUNDS, "bounds"],
    [GROUND, "ground"],
    [PIVOT, "pivot"],
    [CENTRE, "centre of mass"]
  ];
  const minWidth = Math.min(input.maxSide - 2 * M, Math.max(legendRow(undefined, 0, 0, legend), 360));
  const l = contactLayout(fw, fh, shown.length, input.maxSide, input.cols, minWidth);
  const img = canvas(l.width, l.height, BG);
  text(img, M, M, fitText(input.title, l.width - 2 * M, SIZE), INK, SIZE);
  legendRow(img, M, M + textHeight(SIZE) + 8, legend);

  const t = l.cellW >= 160 ? 2 : 1; // line width: 1 px vanishes when a viewer shrinks a big picture
  const toCell = (v: number, s: number) => Math.round(v * s);
  // The overlays of one frame in a box at (x, y) drawn at scale s.
  const overlays = (x: number, y: number, w: number, s: number, f: FrameFacts, withBox: boolean) => {
    if (ground !== null) fillRect(img, x, y + toCell(ground, s) - Math.floor(t / 2), w, t, GROUND);
    if (withBox && f.box) strokeRect(img, x + toCell(f.box.x, s), y + toCell(f.box.y, s), Math.max(t * 2, toCell(f.box.w, s)), Math.max(t * 2, toCell(f.box.h, s)), BOUNDS, t);
    if (pivot) cross(img, x + toCell(pivot.x, s), y + toCell(pivot.y, s), Math.max(4, 3 * t + 2), PIVOT, t);
    if (withBox && f.centre) dot(img, x + toCell(f.centre.x, s), y + toCell(f.centre.y, s), t + 1, CENTRE);
  };

  shown.forEach((frame, k) => {
    const x = l.gridX + (k % l.cols) * l.pitchX;
    const y = l.gridY + Math.floor(k / l.cols) * l.pitchY;
    fillRect(img, x, y - STRIP_H, l.cellW, STRIP_H, STRIP);
    text(img, x + 3, y - STRIP_H + 3, fitText(`${frame + 1}${facts[k].box ? "" : " empty"}`, l.cellW - 6, SIZE), INK, SIZE);
    checkerboard(img, x, y, l.cellW, l.cellH);
    drawImage(img, scaled(frames[frame], l.scale), x, y);
    overlays(x, y, l.cellW, l.scale, facts[k], true);
  });

  // The panels draw each frame's shape (its non-empty pixels), so an opaque
  // sheet's background stays out of them too.
  const ps = l.panelScale;
  const shape = (f: Image, c: Rgba): Image => {
    const rgba = new Uint8Array(f.rgba.length);
    for (let i = 0; i < rgba.length; i += 4) if (!isEmpty(f.rgba, i)) rgba.set(c, i);
    return scaled({ width: f.width, height: f.height, rgba }, ps);
  };
  const onionX = M;
  const trailX = M + l.panelW + PANEL_GAP;
  const py = l.panelY;
  const n = shown.length;
  const tOf = (k: number) => (n > 1 ? k / (n - 1) : 0);

  // Onion skin: every shape faint (what stays put adds up to a solid
  // blend), then every edge solid on top, the latest last, so what moves
  // reads as coloured outlines.
  fillRect(img, onionX, py, l.panelW, l.panelH, PANEL);
  // Over ONION_MAX outlines are a tangle: then that many, evenly spaced.
  const layers = n <= ONION_MAX ? shown.map((_, k) => k) : Array.from({ length: ONION_MAX }, (_, i) => Math.round((i * (n - 1)) / (ONION_MAX - 1)));
  const shapes = layers.map(k => shape(frames[shown[k]], timeColour(tOf(k))));
  shapes.forEach(s => drawImage(img, s, onionX, py, Math.min(0.25, 2 / layers.length)));
  const edge = Math.max(1, Math.round(ps / 2));
  shapes.forEach((s, j) => {
    const c = timeColour(tOf(layers[j]));
    const on = (xx: number, yy: number) => xx >= 0 && yy >= 0 && xx < s.width && yy < s.height && s.rgba[(yy * s.width + xx) * 4 + 3] > 0;
    for (let y = 0; y < s.height; y++) {
      for (let x = 0; x < s.width; x++) {
        if (on(x, y) && (!on(x - edge, y) || !on(x + edge, y) || !on(x, y - edge) || !on(x, y + edge))) fillRect(img, onionX + x, py + y, 1, 1, c);
      }
    }
  });
  overlays(onionX, py, l.panelW, ps, {}, false);

  // Motion trail: the first frame as a ghost, then the centres joined.
  fillRect(img, trailX, py, l.panelW, l.panelH, PANEL);
  if (n) drawImage(img, shape(frames[shown[0]], [120, 120, 135, 255]), trailX, py, 0.35);
  overlays(trailX, py, l.panelW, ps, {}, false);
  const points = facts.map((f, k) => (f.centre ? { k, x: trailX + toCell(f.centre.x, ps), y: py + toCell(f.centre.y, ps) } : undefined)).filter(p => !!p);
  for (let i = 1; i < points.length; i++) thickLine(img, points[i - 1].x, points[i - 1].y, points[i].x, points[i].y, timeColour(tOf(points[i - 1].k)), 2);
  for (const p of points) dot(img, p.x, p.y, 3, timeColour(tOf(p.k)));
  const ends = points.length > 1 ? [points[0], points[points.length - 1]] : points;
  ends.forEach((p, e) => {
    const s = String(shown[p.k] + 1);
    const w = textWidth(s, SIZE) + 4;
    label(img, Math.min(trailX + l.panelW - w, p.x + (e ? 6 : -w - 6)), p.y - textHeight(SIZE) - 6, s, BG, timeColour(tOf(p.k)), SIZE);
  });
  // A body's centre often moves a few pixels only, which at the panel's
  // scale is a knot of dots: then an inset draws the path magnified, every
  // point numbered, so a bob, a sway or a drift can be told apart.
  const inset = trailInset(img, facts, shown, trailX, py, l.panelW, l.panelH, ps, tOf);

  // The panels' titles, with the time key.
  const key = (x: number, y: number, w: number) => {
    const first = String(shown[0] + 1);
    const last = String(shown[n - 1] + 1);
    const bar = Math.min(120, w - textWidth(first + last, SIZE) - 16);
    if (bar < 20) return;
    const x0 = x + w - bar - textWidth(last, SIZE) - 6;
    text(img, x0 - textWidth(first, SIZE) - 6, y, first, DIM, SIZE);
    for (let i = 0; i < bar; i++) fillRect(img, x0 + i, y + 2, 1, textHeight(SIZE) - 4, timeColour(i / (bar - 1)));
    text(img, x0 + bar + 6, y, last, DIM, SIZE);
  };
  const titleY = py - STRIP_H + 3;
  const xs = points.map(p => p.x);
  const ys = points.map(p => p.y);
  const spread = points.length ? ` ${Math.round((Math.max(...xs) - Math.min(...xs)) / ps)}x${Math.round((Math.max(...ys) - Math.min(...ys)) / ps)} px` : "";
  text(img, onionX, titleY, fitText("onion skin", l.panelW, SIZE), INK, SIZE);
  if (l.panelW > 200) key(onionX + textWidth("onion skin", SIZE), titleY, l.panelW - textWidth("onion skin", SIZE));
  text(img, trailX, titleY, fitText(`motion trail${spread}${inset ? `, inset x${inset}` : ""}`, l.panelW, SIZE), INK, SIZE);
  return { image: img, layout: l, ground, pivot, facts, inset, onion: layers.map(k => shown[k] + 1) };
}

// The inset of a small motion trail, in the panel's top-right corner;
// returns its magnification over frame pixels, or undefined when the path
// is big enough to read as it is.
function trailInset(img: Image, facts: FrameFacts[], shown: number[], px: number, py: number, pw: number, ph: number, ps: number, tOf: (k: number) => number): number | undefined {
  const pts = facts.map((f, k) => (f.centre ? { k, ...f.centre } : undefined)).filter(p => !!p);
  if (pts.length < 2) return undefined;
  const [x0, x1] = [Math.min(...pts.map(p => p.x)), Math.max(...pts.map(p => p.x))];
  const [y0, y1] = [Math.min(...pts.map(p => p.y)), Math.max(...pts.map(p => p.y))];
  const side = Math.floor(Math.min(pw, ph) * 0.45);
  const extent = Math.max(x1 - x0, y1 - y0, 1);
  if (extent * ps >= side / 2 || side < 80) return undefined;
  const pad = 24;
  const zoom = Math.max(1, Math.floor((side - 2 * pad) / extent));
  if (zoom <= ps * 1.5) return undefined;
  const ix = px + pw - side - 8;
  const iy = py + 8;
  fillRect(img, ix, iy, side, side, [30, 30, 40, 240]);
  strokeRect(img, ix, iy, side, side, DIM);
  // A frame pixel's grid, when its cells are big enough to see.
  const cx = ix + side / 2 - ((x0 + x1) / 2) * zoom;
  const cy = iy + side / 2 - ((y0 + y1) / 2) * zoom;
  if (zoom >= 8) {
    for (let g = Math.ceil((ix - cx) / zoom); cx + g * zoom < ix + side; g++) fillRect(img, Math.round(cx + g * zoom), iy + 1, 1, side - 2, [255, 255, 255, 18]);
    for (let g = Math.ceil((iy - cy) / zoom); cy + g * zoom < iy + side; g++) fillRect(img, ix + 1, Math.round(cy + g * zoom), side - 2, 1, [255, 255, 255, 18]);
  }
  const at = pts.map(p => ({ k: p.k, x: Math.round(cx + p.x * zoom), y: Math.round(cy + p.y * zoom) }));
  for (let i = 1; i < at.length; i++) thickLine(img, at[i - 1].x, at[i - 1].y, at[i].x, at[i].y, timeColour(tOf(at[i - 1].k)), 2);
  for (const p of at) dot(img, p.x, p.y, 3, timeColour(tOf(p.k)));
  // Numbers where they do not cover one another; the first and last always.
  const taken: { x: number; y: number; w: number; h: number }[] = [];
  const order = [at[0], at[at.length - 1], ...at.slice(1, -1)];
  for (const p of order) {
    const s = String(shown[p.k] + 1);
    const w = textWidth(s, SIZE) + 4;
    const h = textHeight(SIZE) + 4;
    const box = { x: Math.min(ix + side - w - 2, p.x + 5), y: Math.max(iy + 2, p.y - h - 3), w, h };
    if (taken.some(b => box.x < b.x + b.w && b.x < box.x + box.w && box.y < b.y + b.h && b.y < box.y + box.h)) continue;
    taken.push(box);
    label(img, box.x, box.y, s, BG, timeColour(tOf(p.k)), SIZE, 2);
  }
  text(img, ix + 4, iy + side - textHeight(SIZE) - 4, `x${zoom}`, DIM, SIZE);
  return zoom;
}

const round = (v: number, places = 2) => Math.round(v * 10 ** places) / 10 ** places;

// The frames of a sheet, without an extruded border.
function sheetFrames(src: Loaded, call: ToolCall) {
  const resolved = resolveGrid(src, gridFlag(call));
  const e = src.extrude ?? 0;
  const frames = sliceSheet(src.image, resolved.grid.cols, resolved.grid.rows, resolved.grid.frames).map(img => (e ? crop(img, { x: e, y: e, w: img.width - 2 * e, h: img.height - 2 * e }) : img));
  return { ...resolved, frames };
}

function maxSideFlag(call: ToolCall): number {
  const v = positiveInt(call, "--max-size") ?? MAX_SIDE;
  if (v < 256 || v > 8192) throw usage("--max-size takes pixels from 256 to 8192");
  return v;
}

const lookHint = (file: string, what: string) => hint(`Open the image to look at ${what}`, file);

TOOLS.push({
  group: "sprite",
  name: "contact",
  args: "<sheet>",
  summary: "One PNG of an animation to look at: every frame labelled, with an onion skin and a motion trail",
  details: [
    "For an agent that can read images but cannot play an animation: is it the move asked for, which",
    "way it faces, does it drift, does it end where it starts. Each frame sits on a checkerboard under",
    "its number (from 1, as `sprite frames` counts), with its opaque bounds, the shared ground line",
    "(under the lowest opaque pixel of any frame), the pivot (the ground's centre under all frames) and",
    "its centre of mass. The onion skin lays the frames over one another (12 evenly spaced, when there",
    "are more), coloured by time from blue to red; the motion trail joins the centres of mass in order,",
    "with a magnified inset when they move only a little. Opaque means alpha over 127, or on",
    `a sheet with no transparency, not the colour of its border. The picture is at most ${MAX_SIDE} px a side:`,
    "big frames are shrunk, small ones enlarged by whole factors (pixel art keeps its pixels). It only",
    "draws: the sheet is not changed."
  ],
  flags: [
    { flag: "--every", value: "n", description: `Show every nth frame (default 1, or more when the cells would be under ${MIN_CELL} px)` },
    { flag: "--cols", value: "n", description: "Frames per row (default: whatever shows them largest)" },
    { flag: "--max-size", value: "px", description: `The picture's longest side (default ${MAX_SIDE})` },
    { flag: "--grid", value: "CxR", description: "The sheet's grid, when it has no Ludo stamp and detection is unsure" }
  ],
  async run(ctx: Ctx, call: ToolCall) {
    if (call.args.length !== 1) throw usage("Usage: ludo toolbox sprite contact <sheet> [--every n]");
    const maxSide = maxSideFlag(call);
    const wantEvery = positiveInt(call, "--every");
    const cols = positiveInt(call, "--cols");
    const src = loadImageFile(call.args[0]);
    const { grid, from, frames } = sheetFrames(src, call);
    const { width: fw, height: fh } = frames[0];
    const pick = (every: number) => frames.map((_, i) => i).filter(i => i % every === 0);
    const title = (every: number, count: number) =>
      `${path.basename(src.file)} · ${frames.length} frames of ${fw}x${fh} · ${grid.cols}x${grid.rows} · ${grid.fps} fps${every > 1 ? ` · every ${every}: ${count} shown` : ""}`;
    // Without --every, the fewest frames dropped that still leave cells
    // big enough to see.
    let every = wantEvery ?? 1;
    if (wantEvery === undefined) {
      while (every < frames.length) {
        const l = contactLayout(fw, fh, pick(every).length, maxSide, cols && Math.min(cols, pick(every).length));
        if (Math.max(l.cellW, l.cellH) >= Math.min(MIN_CELL, Math.max(fw, fh))) break;
        every++;
      }
    }
    if (every > frames.length) throw usage(`--every ${every} is more than the ${frames.length} frames`);
    const shownFrames = pick(every);
    if (cols !== undefined && cols > shownFrames.length) throw usage(`--cols ${cols} is more than the ${shownFrames.length} frames shown`);
    const contact = drawContact({ frames, shown: shownFrames, title: title(every, shownFrames.length), maxSide, cols });
    const l = contact.layout;
    const file = freeName(ctx.outDir, ctx.globals.name || `${baseOf(src.file)}-contact`, ".png");
    writePng(file, contact.image);

    const next = lookHint(shown(file), "the animation");
    if (ctx.jsonOut) {
      printJson(
        {
          sheet: shown(src.file),
          image: shown(file),
          width: l.width,
          height: l.height,
          grid: { cols: grid.cols, rows: grid.rows, frames: grid.frames, frame_width: fw, frame_height: fh, fps: grid.fps },
          grid_from: from,
          every,
          shown: shownFrames.map(i => i + 1),
          layout: {
            cols: l.cols,
            rows: l.rows,
            cell_width: l.cellW,
            cell_height: l.cellH,
            scale: round(l.scale, 3),
            // Frame k (from 0 among those shown) is at first_cell + (k % cols, floor(k / cols)) * pitch.
            first_cell: { x: l.gridX, y: l.gridY },
            pitch: { x: l.pitchX, y: l.pitchY },
            onion_skin: { x: M, y: l.panelY, width: l.panelW, height: l.panelH, scale: round(l.panelScale, 3) },
            motion_trail: { x: M + l.panelW + PANEL_GAP, y: l.panelY, width: l.panelW, height: l.panelH, scale: round(l.panelScale, 3), ...(contact.inset ? { inset_scale: contact.inset } : {}) }
          },
          onion_frames: contact.onion,
          ground_y: contact.ground,
          pivot: contact.pivot && { x: round(contact.pivot.x, 1), y: contact.pivot.y },
          legend: {
            labels: "the frame's number, from 1; \"empty\" when it has no opaque pixel",
            checkerboard: "transparent pixels",
            bounds: `${hex(BOUNDS)} box: the frame's opaque pixels (alpha over ${ALPHA_EMPTY})`,
            ground: `${hex(GROUND)} line: under the lowest opaque pixel of any shown frame`,
            pivot: `${hex(PIVOT)} cross: on the ground, centred under all shown frames`,
            centre_of_mass: `${hex(CENTRE)} dot: the mean of the frame's opaque pixels`,
            onion_skin: `the shown frames' shapes over one another (${ONION_MAX} evenly spaced when there are more: onion_frames), blue (first) to red (last), faint fills and solid outlines, the latest on top`,
            motion_trail: "the centres of mass joined in order, coloured by time, over the first frame's shape; the title gives how far they spread, in frame pixels; when that is small, an inset in its corner draws the path magnified (inset_scale), every point numbered where there is room"
          },
          ...(ctx.globals.quiet ? {} : { hint: next })
        },
        false
      );
    } else {
      process.stdout.write(`${shownFrames.length} of ${frames.length} frames in a ${l.cols}x${l.rows} grid at ${round(l.scale, 3)}x, with an onion skin and a motion trail\n`);
      process.stdout.write(`Saved ${shown(file)} (${l.width}x${l.height})\n`);
      if (!ctx.globals.quiet) process.stderr.write(`Next: ${next.text}: ${next.command}\n`);
    }
    return EXIT.OK;
  }
});

// ---- audio waveform ----

const WAVE: Rgba = [90, 169, 255, 255];
const WAVE_RMS: Rgba = [170, 212, 255, 255];
const GRIDLINE: Rgba = [255, 255, 255, 28];
const SILENCE: Rgba = [0, 0, 0, 120];
const HATCH: Rgba = [255, 255, 255, 34];
const PEAK: Rgba = [255, 159, 26, 255];
const TRUE_PEAK: Rgba = [255, 77, 77, 255];
const LOUDEST: Rgba = [61, 220, 132, 255];
const MAGMA: Rgba[] = [
  [0, 0, 4, 255],
  [40, 11, 84, 255],
  [101, 21, 110, 255],
  [159, 42, 99, 255],
  [212, 72, 66, 255],
  [245, 125, 21, 255],
  [250, 193, 39, 255],
  [252, 255, 164, 255]
];

const RULER_W = 64; // the dB and Hz labels, left of the plots
const MARK_ROW = textHeight(SIZE) + 6;
const TIME_H = textHeight(SIZE) + 12;
const SPECTRUM_DB = 90;
const WAVE_FLOOR = -60; // dBFS at a lane's centre line
const ENVELOPE_MS = 5; // the shortest stretch a column's peak is taken over // the spectrogram shows this far under its loudest bin

export interface WaveformOptions {
  width: number;
  threshold: number; // dBFS, for the silence at the ends
  spectrogram: boolean;
  title: string;
}

export interface Waveform {
  image: Image;
  plot: { x: number; y: number; width: number; height: number }; // the waveform lanes
  spectrum?: { x: number; y: number; width: number; height: number; minHz: number; maxHz: number };
  msPerPixel: number;
  silence: { start: number; end: number } | null; // seconds of silence at each end; null when all of it is
  peak: { time: number; db: number };
  truePeak: { time: number; db: number };
  loudest: { start: number; end: number; lufs: number } | null;
  loudness: number;
}

// A tick step of 1, 2 or 5 times a power of ten, for at most `count` ticks.
function niceStep(span: number, count: number): number {
  const raw = span / Math.max(1, count);
  const p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map(m => m * p).find(s => s >= raw) ?? 10 * p;
}

function timeText(t: number, step: number): string {
  if (step < 1 && t < 10 && step < 0.1) return `${Math.round(t * 1000)} ms`;
  if (t >= 60 && step >= 1) return `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, "0")}`;
  const places = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
  return `${t.toFixed(places)} s`;
}

// The waveform (min to max per column, the RMS inside it), one lane per
// channel (more than two are mixed to one), under a band of marker labels
// and over a time ruler; the silence at each end shaded; optionally a
// log-frequency spectrogram of the mono mix.
export function drawWaveform(a: Audio, opts: WaveformOptions): Waveform {
  const n = frameCount(a);
  const rate = a.rate;
  const lanes = a.channels.length > 2 ? [toMono(a).channels[0]] : a.channels;
  const laneNames = a.channels.length === 2 ? ["L", "R"] : a.channels.length > 2 ? ["mix"] : [""];
  const W = opts.width;
  const PW = W - RULER_W - M;
  const laneH = lanes.length === 1 ? 220 : 130;
  const headerH = M + textHeight(SIZE) + 8 + textHeight(SIZE) + 8;
  const plotY = headerH + 3 * MARK_ROW;
  const plotH = lanes.length * laneH + (lanes.length - 1) * GAP;
  const specH = opts.spectrogram ? 220 : 0;
  const specY = plotY + plotH + (opts.spectrogram ? GAP + 4 : 0);
  const timeY = specY + specH + 2;
  const H = timeY + TIME_H + M;
  const img = canvas(W, H, BG);
  const X0 = RULER_W;
  const xOf = (frame: number) => X0 + Math.min(PW - 1, Math.floor((frame / n) * PW));
  const span = (x: number) => [Math.floor((x * n) / PW), Math.max(Math.floor((x * n) / PW) + 1, Math.floor(((x + 1) * n) / PW))];

  // What the markers say.
  const sp = samplePeakAt(a);
  const tp = truePeakAt(a);
  const m = momentaryLoudness(a);
  let loudK = -1;
  m.lufs.forEach((v, k) => Number.isFinite(v) && (loudK < 0 || v > m.lufs[loudK]) && (loudK = k));
  const loudest = loudK < 0 ? null : { from: loudK * m.step, to: Math.min(n, loudK * m.step + m.block), lufs: m.lufs[loudK] };
  const range = audibleRange(a, fromDb(opts.threshold));
  const integrated = loudness(a).lufs;

  text(img, M, M, fitText(opts.title, W - 2 * M, SIZE), INK, SIZE);
  legendRow(img, M, M + textHeight(SIZE) + 8, [
    [PEAK, "peak"],
    [TRUE_PEAK, "true peak"],
    [LOUDEST, "loudest 400 ms"],
    [[90, 90, 100, 255], `silence (under ${opts.threshold} dBFS)`]
  ]);
  if (opts.spectrogram) text(img, W - M - textWidth("spectrogram: Hz, log", SIZE), M + textHeight(SIZE) + 8, "spectrogram: Hz, log", DIM, SIZE);

  // The lanes, on a dB scale: the centre is WAVE_FLOOR dBFS and each edge 0
  // dBFS, mirrored, so a quiet sound and a long decay are as visible as a
  // loud hit (on a linear scale a -30 dB tail is a hairline). The dB lines
  // are those with room for a label.
  const reach = (v: number) => Math.max(0, (toDb(Math.abs(v)) - WAVE_FLOOR) / -WAVE_FLOOR);
  lanes.forEach((ch, li) => {
    const top = plotY + li * (laneH + GAP);
    const mid = top + laneH / 2;
    const half = laneH / 2 - 2;
    fillRect(img, X0, top, PW, laneH, PANEL);
    let lastY = -Infinity;
    for (const db of [0, -6, -12, -24, -36, -48]) {
      const dy = reach(fromDb(db)) * half;
      if (half - dy < lastY + textHeight(SIZE) + 2 && db !== 0) continue;
      lastY = half - dy;
      fillRect(img, X0, Math.round(mid - dy), PW, 1, GRIDLINE);
      fillRect(img, X0, Math.round(mid + dy), PW, 1, GRIDLINE);
      const s = db === 0 ? "0 dB" : String(db);
      text(img, X0 - 6 - textWidth(s, SIZE), Math.round(mid - dy - textHeight(SIZE) / 2), s, DIM, SIZE);
    }
    fillRect(img, X0, Math.round(mid), PW, 1, [255, 255, 255, 50]);
    // The envelope: each column's peak (and RMS) over at least ENVELOPE_MS,
    // the same both sides of the centre. On a dB scale, a column of a few
    // samples would show single cycles dipping to the floor at every zero
    // crossing, not the sound's shape.
    const reachOut = Math.max(0, Math.round((rate * ENVELOPE_MS) / 2000));
    for (let x = 0; x < PW; x++) {
      let [s0, s1] = span(x);
      if (s1 - s0 < 2 * reachOut) {
        const c = (s0 + s1) >> 1;
        [s0, s1] = [Math.max(0, c - reachOut), Math.min(n, c + reachOut)];
      }
      let [peak, sq] = [0, 0];
      for (let i = s0; i < Math.min(n, s1); i++) {
        const v = Math.abs(ch[i]);
        if (v > peak) peak = v;
        sq += v * v;
      }
      const rms = Math.sqrt(sq / Math.max(1, Math.min(n, s1) - s0));
      const up = reach(Math.min(1, peak));
      if (up <= 0) continue;
      fillRect(img, X0 + x, Math.round(mid - up * half), 1, Math.max(1, Math.round(2 * up * half)), WAVE);
      const r = reach(rms);
      if (r > 0) fillRect(img, X0 + x, Math.round(mid - r * half), 1, Math.max(1, Math.round(2 * r * half)), WAVE_RMS);
    }
    if (laneNames[li]) label(img, X0 + 4, top + 4, laneNames[li], INK, STRIP, SIZE);
  });

  // The spectrogram: a Hann-windowed FFT at each column's centre, on a log
  // frequency axis from 40 Hz to half the sample rate.
  let spectrum: Waveform["spectrum"];
  if (opts.spectrogram) {
    const N = rate >= 32000 ? 2048 : 1024;
    const mono = toMono(a).channels[0];
    const minHz = 40;
    const maxHz = rate / 2;
    const bins = N / 2;
    const hann = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
    const mags = new Float32Array(PW * specH);
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    // Each row covers the bins between its edges' frequencies; a row
    // narrower than a bin (the low end, on a log axis) reads between two.
    const binAt = (y: number) => ((minHz * (maxHz / minHz) ** (1 - y / specH)) / rate) * N;
    let top = 0;
    for (let x = 0; x < PW; x++) {
      const centre = Math.round(((x + 0.5) * n) / PW);
      for (let i = 0; i < N; i++) {
        const at = centre - N / 2 + i;
        re[i] = at >= 0 && at < n ? mono[at] * hann[i] : 0;
        im[i] = 0;
      }
      fft1d(re, im, N, false);
      for (let y = 0; y < specH; y++) {
        const [b0, b1] = [binAt(y + 1), binAt(y)];
        let v = 0;
        if (b1 - b0 < 1) {
          const b = Math.min(bins - 1, (b0 + b1) / 2);
          const k = Math.floor(b);
          const f = b - k;
          const mag = (j: number) => Math.hypot(re[j], im[j]);
          v = mag(k) * (1 - f) + mag(Math.min(bins, k + 1)) * f;
        } else {
          for (let k = Math.floor(b0); k <= Math.min(bins, Math.ceil(b1)); k++) v = Math.max(v, Math.hypot(re[k], im[k]));
        }
        mags[y * PW + x] = v;
        if (v > top) top = v;
      }
    }
    for (let y = 0; y < specH; y++) {
      for (let x = 0; x < PW; x++) {
        const db = top > 0 && mags[y * PW + x] > 0 ? 20 * Math.log10(mags[y * PW + x] / top) : -Infinity;
        fillRect(img, X0 + x, specY + y, 1, 1, timeColour(Math.max(0, 1 + db / SPECTRUM_DB), MAGMA));
      }
    }
    // Hz labels at 100, 1k, 10k (and the halves between when there is room).
    const yOfHz = (hz: number) => specY + Math.round(specH * (1 - Math.log(hz / minHz) / Math.log(maxHz / minHz)));
    let lastY = Infinity;
    for (const hz of [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) {
      if (hz <= minHz || hz >= maxHz) continue;
      const y = yOfHz(hz);
      if (y > specY + specH - textHeight(SIZE)) continue;
      if (lastY - y < textHeight(SIZE) + 4) continue;
      lastY = y;
      fillRect(img, X0, y, PW, 1, [255, 255, 255, 40]);
      const s = hz >= 1000 ? `${hz / 1000}k` : String(hz);
      text(img, X0 - 6 - textWidth(s, SIZE), y - textHeight(SIZE) / 2, s, DIM, SIZE);
    }
    spectrum = { x: X0, y: specY, width: PW, height: specH, minHz, maxHz };
  }
  const bottom = specY + specH;

  // The silence at each end, hatched over everything.
  const shade = (x0: number, x1: number, says: string) => {
    if (x1 <= x0) return;
    fillRect(img, x0, plotY, x1 - x0, bottom - plotY, SILENCE);
    for (let x = x0; x < x1; x++) for (let y = plotY; y < bottom; y++) if ((x + y) % 8 === 0) fillRect(img, x, y, 1, 1, HATCH);
    const s = fitText(says, x1 - x0 - 8, SIZE);
    if (s) label(img, x0 + 4, bottom - textHeight(SIZE) - 10, s, INK, STRIP, SIZE);
  };
  if (!range) shade(X0, X0 + PW, `silent: nothing over ${opts.threshold} dBFS`);
  else {
    shade(X0, xOf(range.start), `${((range.start / rate)).toFixed(2)} s`);
    shade(xOf(range.end), X0 + PW, `${((n - range.end) / rate).toFixed(2)} s`);
  }

  // The time ruler, with its lines through every panel.
  const duration = n / rate;
  const step = niceStep(duration, Math.max(2, Math.floor(PW / 120)));
  for (let t = 0; t <= duration + 1e-9; t += step) {
    const x = X0 + Math.min(PW - 1, Math.round((t / duration) * PW));
    fillRect(img, x, plotY, 1, bottom - plotY, GRIDLINE);
    fillRect(img, x, bottom, 1, 6, DIM);
    const s = timeText(t, step);
    text(img, Math.min(X0 + PW - textWidth(s, SIZE), Math.max(0, x - textWidth(s, SIZE) / 2)), timeY + 8, s, DIM, SIZE);
  }

  // The markers: a line down through the panels from a label in its own row.
  const marker = (row: number, x: number, c: Rgba, says: string, dash = 0) => {
    const y = headerH + row * MARK_ROW;
    line(img, x, y + MARK_ROW - 2, x, bottom - 1, c, dash);
    const w = textWidth(says, SIZE) + 6;
    const lx = x + 4 + w <= X0 + PW ? x + 4 : Math.max(0, x - 4 - w);
    label(img, lx, y, says, BG, c, SIZE, 3);
    fillRect(img, x - 1, y + MARK_ROW - 4, 3, 3, c);
  };
  const tpFrame = tp.at;
  if (loudest) {
    const [x0, x1] = [xOf(loudest.from), Math.max(xOf(loudest.from) + 1, xOf(loudest.to))];
    fillRect(img, x0, plotY, x1 - x0, plotH, [LOUDEST[0], LOUDEST[1], LOUDEST[2], 46]);
    fillRect(img, x0, plotY, x1 - x0, 2, LOUDEST);
    marker(2, x0, LOUDEST, `loudest ${loudest.lufs.toFixed(1)} LUFS at ${(loudest.from / rate).toFixed(2)}-${(loudest.to / rate).toFixed(2)} s`);
  }
  if (sp.peak > 0) {
    marker(0, xOf(sp.at), PEAK, `peak ${toDb(sp.peak).toFixed(1)} dBFS at ${(sp.at / rate).toFixed(3)} s`);
    marker(1, xOf(tpFrame), TRUE_PEAK, `true peak ${toDb(tp.peak).toFixed(1)} dBTP at ${(tpFrame / rate).toFixed(3)} s`, 3);
  }

  return {
    image: img,
    plot: { x: X0, y: plotY, width: PW, height: plotH },
    spectrum,
    msPerPixel: (duration * 1000) / PW,
    silence: range ? { start: range.start / rate, end: (n - range.end) / rate } : null,
    peak: { time: sp.at / rate, db: toDb(sp.peak) },
    truePeak: { time: tpFrame / rate, db: toDb(tp.peak) },
    loudest: loudest && { start: loudest.from / rate, end: loudest.to / rate, lufs: loudest.lufs },
    loudness: integrated
  };
}

const finite = (v: number, places = 2) => (Number.isFinite(v) ? round(v, places) : null);

TOOLS.push({
  group: "audio",
  name: "waveform",
  args: "<sound>",
  summary: "One PNG of a sound to look at: its waveform, the silence at its ends, its peaks and loudest moment",
  details: [
    "For an agent that cannot listen: where the hit lands, how it decays, whether it starts late or",
    "ends early. Each channel is a lane (more than two are mixed to one): its peak envelope, each",
    `pixel's loudest sample (over at least ${ENVELOPE_MS} ms), with the RMS inside, on a dB scale (${WAVE_FLOOR} dBFS at the`,
    "centre, 0 at the edges, so a quiet tail shows), over a time ruler. The silence at each",
    "end is hatched (under --threshold, -50 dBFS by default, as `audio trim` cuts). Markers: the sample",
    "peak, the true peak (between the samples, as `audio info` measures it) and the loudest 400 ms",
    "(momentary loudness, EBU R 128). --spectrogram adds a log-frequency spectrogram of the mono mix,",
    `40 Hz to half the sample rate, ${SPECTRUM_DB} dB of range. It only draws: the sound is not changed.`
  ],
  flags: [
    { flag: "--width", value: "px", description: "The picture's width (default 1200, 400 to 4096)" },
    { flag: "--spectrogram", description: "Add a spectrogram under the waveform" },
    { flag: "--threshold", value: "dB", description: "Quieter than this counts as silence, in dBFS (default -50)" }
  ],
  async run(ctx: Ctx, call: ToolCall) {
    if (call.args.length !== 1) throw usage("Usage: ludo toolbox audio waveform <sound> [--spectrogram]");
    const width = positiveInt(call, "--width") ?? 1200;
    if (width < 400 || width > 4096) throw usage("--width takes pixels from 400 to 4096");
    const rawThreshold = textFlag(call, "--threshold");
    if (call.flags.has("--threshold") && rawThreshold === undefined) throw usage("--threshold takes a number of dB");
    const threshold = rawThreshold === undefined ? -50 : Number(rawThreshold.trim().replace(/(dbfs|db)$/i, ""));
    if (!Number.isFinite(threshold) || threshold < -120 || threshold > 0) throw usage(`--threshold takes dB from -120 to 0 (got "${rawThreshold}")`);
    const src = loadAudioFile(call.args[0]);
    const a = src.audio;
    const ch = a.channels.length === 1 ? "mono" : a.channels.length === 2 ? "stereo" : `${a.channels.length} channels`;
    const lufs = loudness(a).lufs;
    const title = `${path.basename(src.file)} · ${src.format.toUpperCase()} ${round(a.rate / 1000, 3)} kHz ${ch} · ${(frameCount(a) / a.rate).toFixed(2)} s · ${Number.isFinite(lufs) ? `${lufs.toFixed(1)} LUFS` : "silent"}`;
    const w = drawWaveform(a, { width, threshold, spectrogram: call.flags.has("--spectrogram"), title });
    const file = freeName(ctx.outDir, ctx.globals.name || `${baseOf(src.file)}-waveform`, ".png");
    writePng(file, w.image);

    const next = lookHint(shown(file), "the sound");
    if (ctx.jsonOut) {
      printJson(
        {
          audio: shown(src.file),
          image: shown(file),
          width: w.image.width,
          height: w.image.height,
          duration: round(frameCount(a) / a.rate, 3),
          rate: a.rate,
          channels: a.channels.length,
          ms_per_pixel: round(w.msPerPixel, 3),
          // Time t seconds is at x = plot.x + t * 1000 / ms_per_pixel.
          plot: w.plot,
          ...(w.spectrum ? { spectrogram: { x: w.spectrum.x, y: w.spectrum.y, width: w.spectrum.width, height: w.spectrum.height, min_hz: w.spectrum.minHz, max_hz: w.spectrum.maxHz, scale: "log" } } : {}),
          loudness_lufs: finite(w.loudness),
          silence: w.silence ? { threshold_db: threshold, start: round(w.silence.start, 3), end: round(w.silence.end, 3) } : { threshold_db: threshold, all: true },
          markers: {
            peak: { time: round(w.peak.time, 3), db: finite(w.peak.db) },
            true_peak: { time: round(w.truePeak.time, 3), db: finite(w.truePeak.db) },
            ...(w.loudest ? { loudest: { start: round(w.loudest.start, 3), end: round(w.loudest.end, 3), lufs: finite(w.loudest.lufs) } } : {})
          },
          legend: {
            waveform: `${hex(WAVE)}: the peak envelope, each pixel's loudest sample (over at least ${ENVELOPE_MS} ms), mirrored; ${hex(WAVE_RMS)} inside: their RMS`,
            scale: `dB, mirrored: the centre line is ${WAVE_FLOOR} dBFS (and anything quieter), each lane's edge 0 dBFS`,
            db_lines: "0, -6, -12, -24, -36 and -48 dBFS, those with room for a label",
            silence: `hatched: under ${threshold} dBFS at the start and the end, its length in the label`,
            peak: `${hex(PEAK)} line: the loudest sample`,
            true_peak: `${hex(TRUE_PEAK)} dashed line: the loudest point between the samples`,
            loudest: `${hex(LOUDEST)} band: the loudest 400 ms block (momentary loudness)`,
            ...(w.spectrum ? { spectrogram: `log frequency up, black (${SPECTRUM_DB} dB under the loudest) to pale yellow (the loudest)` } : {})
          },
          ...(ctx.globals.quiet ? {} : { hint: next })
        },
        false
      );
    } else {
      process.stdout.write(`${(frameCount(a) / a.rate).toFixed(2)} s at ${round(w.msPerPixel, 2)} ms a pixel${w.spectrum ? ", with a spectrogram" : ""}\n`);
      process.stdout.write(`Saved ${shown(file)} (${w.image.width}x${w.image.height})\n`);
      if (!ctx.globals.quiet) process.stderr.write(`Next: ${next.text}: ${next.command}\n`);
    }
    return EXIT.OK;
  }
});

// ---- image contact ----

const IMAGE_FILE = /\.(png|webp|gif|jpe?g)$/i;

// Each argument is an image, or a folder whose images are taken in natural order.
function imageFiles(args: string[]): string[] {
  return args.flatMap(arg => {
    const stat = fs.statSync(arg, { throwIfNoEntry: false });
    if (!stat?.isDirectory()) return [arg];
    const found = fs.readdirSync(arg).filter(f => IMAGE_FILE.test(f)).sort(natural.compare);
    if (!found.length) throw usage(`No PNG, WebP, GIF or JPEG files in ${arg}`);
    return found.map(f => path.join(arg, f));
  });
}

export interface ImageContactLayout {
  cols: number;
  rows: number;
  cell: number; // the square each image is fitted into
  width: number;
  height: number;
  pitchX: number;
  pitchY: number;
  firstX: number;
  firstY: number;
}

const CAPTION_H = 2 * (textHeight(SIZE) + 4) + 4;
const IMAGE_HEADER_H = M + textHeight(SIZE) + 10;

function imageLayoutAt(count: number, cols: number, cell: number): ImageContactLayout {
  const rows = Math.ceil(count / cols);
  const pitchX = cell + GAP * 2;
  const pitchY = cell + CAPTION_H + GAP * 2;
  return { cols, rows, cell, width: 2 * M + cols * pitchX - 2 * GAP, height: IMAGE_HEADER_H + rows * pitchY - 2 * GAP + M, pitchX, pitchY, firstX: M, firstY: IMAGE_HEADER_H };
}

// The biggest square cell, up to `maxCell`, over every column count that
// keeps the picture within `maxSide`.
export function imageContactLayout(count: number, maxSide = MAX_SIDE, maxCell = 256, wantCols?: number): ImageContactLayout {
  let best: ImageContactLayout | undefined;
  for (let cols = wantCols ?? 1; cols <= (wantCols ?? count); cols++) {
    let cell = maxCell;
    while (cell >= 16) {
      const l = imageLayoutAt(count, cols, cell);
      if (l.width <= maxSide && l.height <= maxSide) break;
      cell--;
    }
    if (cell < 16) continue;
    const l = imageLayoutAt(count, cols, cell);
    const squareness = (x: ImageContactLayout) => Math.min(x.width, x.height) / Math.max(x.width, x.height);
    const empty = (x: ImageContactLayout) => x.cols * x.rows - count;
    // The biggest cells; then the fewest empty ones; then the squarer picture.
    if (!best || l.cell > best.cell || (l.cell === best.cell && (empty(l) < empty(best) || (empty(l) === empty(best) && squareness(l) > squareness(best))))) best = l;
  }
  if (!best) throw new CliError(`${count} images do not fit a ${maxSide} px picture`, EXIT.USAGE, "Pass fewer images, or allow more with --max-size.");
  return best;
}

// The scale that fits an image in a cell: whole factors up (pixel art keeps
// its pixels), any factor down.
export function fitScale(w: number, h: number, cell: number): number {
  const s = cell / Math.max(w, h);
  return s >= 1 ? Math.floor(s) : s;
}

export function drawImageContact(images: { name: string; image: Image }[], opts: { maxSide: number; cell?: number; cols?: number; title: string }) {
  const l = imageContactLayout(images.length, opts.maxSide, opts.cell ?? 256, opts.cols);
  const img = canvas(l.width, l.height, BG);
  text(img, M, M, fitText(opts.title, l.width - 2 * M, SIZE), INK, SIZE);
  const placed = images.map(({ name, image }, k) => {
    const x = l.firstX + (k % l.cols) * l.pitchX;
    const y = l.firstY + Math.floor(k / l.cols) * l.pitchY;
    const s = fitScale(image.width, image.height, l.cell);
    const shownImg = scaled(image, s);
    checkerboard(img, x, y, l.cell, l.cell);
    const ix = x + Math.floor((l.cell - shownImg.width) / 2);
    const iy = y + Math.floor((l.cell - shownImg.height) / 2);
    drawImage(img, shownImg, ix, iy);
    text(img, x, y + l.cell + 4, fitText(name, l.cell, SIZE), INK, SIZE);
    text(img, x, y + l.cell + 8 + textHeight(SIZE), fitText(`${image.width}x${image.height}${s !== 1 ? ` at ${round(s, 2)}x` : ""}`, l.cell, SIZE), DIM, SIZE);
    return { x, y, scale: s, drawn: { x: ix, y: iy, width: shownImg.width, height: shownImg.height } };
  });
  return { image: img, layout: l, placed };
}

TOOLS.push({
  group: "image",
  name: "contact",
  args: "<images...>",
  summary: "One PNG of several images side by side, each labelled with its name and size",
  details: [
    "For an agent comparing a set: icons, a UI kit, a character's variations, takes of one prompt.",
    "Images are files, or folders of them taken in natural order (icon-2 before icon-10). Each is",
    "fitted into a square cell on a checkerboard: enlarged by whole factors (pixel art keeps its",
    "pixels), or shrunk to fit; its name and its real size are printed under it. An animated GIF or",
    `WebP shows as its frames' sheet. The picture is at most ${MAX_SIDE} px a side. It only draws: the`,
    "images are not changed."
  ],
  flags: [
    { flag: "--cols", value: "n", description: "Images per row (default: whatever shows them largest)" },
    { flag: "--cell", value: "px", description: "The largest cell (default 256)" },
    { flag: "--max-size", value: "px", description: `The picture's longest side (default ${MAX_SIDE})` }
  ],
  async run(ctx: Ctx, call: ToolCall) {
    if (!call.args.length) throw usage("Usage: ludo toolbox image contact <images...>");
    const maxSide = maxSideFlag(call);
    const cell = positiveInt(call, "--cell") ?? 256;
    if (cell < 16 || cell > 1024) throw usage("--cell takes pixels from 16 to 1024");
    const files = imageFiles(call.args);
    if (files.length > 400) throw usage(`${files.length} images is too many for one picture; the limit is 400`);
    const cols = positiveInt(call, "--cols");
    if (cols !== undefined && cols > files.length) throw usage(`--cols ${cols} is more than the ${files.length} images`);
    const loaded = files.map(loadImageFile);
    const items = loaded.map(s => ({ name: path.basename(s.file), image: s.image }));
    const sheet = drawImageContact(items, { maxSide, cell, cols, title: `${items.length} images` });
    const l = sheet.layout;
    const file = freeName(ctx.outDir, ctx.globals.name || (files.length === 1 ? `${baseOf(files[0])}-contact` : "contact"), ".png");
    writePng(file, sheet.image);

    const next = lookHint(shown(file), "the images");
    if (ctx.jsonOut) {
      printJson(
        {
          image: shown(file),
          width: l.width,
          height: l.height,
          layout: { cols: l.cols, rows: l.rows, cell: l.cell, first_cell: { x: l.firstX, y: l.firstY }, pitch: { x: l.pitchX, y: l.pitchY } },
          images: loaded.map((s, k) => ({ file: shown(s.file), width: s.image.width, height: s.image.height, scale: round(sheet.placed[k].scale, 3), at: sheet.placed[k].drawn })),
          legend: {
            checkerboard: "transparent pixels",
            caption: "the file's name, then its size in pixels (and the scale it is shown at, when not 1)"
          },
          ...(ctx.globals.quiet ? {} : { hint: next })
        },
        false
      );
    } else {
      process.stdout.write(`${items.length} images in a ${l.cols}x${l.rows} grid of ${l.cell} px cells\n`);
      process.stdout.write(`Saved ${shown(file)} (${l.width}x${l.height})\n`);
      if (!ctx.globals.quiet) process.stderr.write(`Next: ${next.text}: ${next.command}\n`);
    }
    return EXIT.OK;
  }
});
