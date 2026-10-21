import type { Image } from "../tty/png.js";
import { frameRects } from "./sheet.js";

// Finds the grid of a spritesheet that does not say what it is.
//
// Each axis is solved on its own. Frames of one animation look alike, so a
// sheet shifted by one cell along an axis nearly matches itself. That is
// pitch detection, and this uses the YIN method's normalised difference
// (de Cheveigné & Kawahara, 2002, steps 2-4) on a downscaled, alpha-
// premultiplied copy of the sheet: d'(τ) is low where the sheet repeats every
// τ pixels. Only lags that split the axis into whole cells count; the finest
// such split that repeats wins, refined to the bottom of its dip so a lag
// next to the true one does not win on a technicality.
//
// Frames far apart in an animation (one row to the next of a 6x6 attack) can
// differ too much to repeat, so a second test, pose-independent, backs it up:
// sprites sit inside their cells, so the true boundaries cross little or no
// ink. A split counts if its cells repeat, or if every boundary is (nearly)
// ink-free, no band of cells is empty and it refines the split repetition
// found (narrow sprites leave gaps where no boundary is).
//
// Below a fixed confidence the answer is a guess, and callers refuse rather
// than slice.

export interface AxisGuess {
  count: number; // cells along the axis
  score: number; // d' at that split: 0 = identical cells, ~1 = no repetition
  boundaryInk: number; // ink on the boundaries vs the average line: 0 = clean
  confidence: number; // 0..1
}

export interface GridGuess {
  cols: number;
  rows: number;
  frames: number; // trailing empty cells dropped
  confidence: number; // the weaker axis
  x: AxisGuess;
  y: AxisGuess;
}

export const CONFIDENT = 0.5;
const MIN_CELL = 8; // px
const MAX_CELLS = 64; // per axis
const REPEATS = 0.6; // d' below this counts as repeating
const CLEAN = 0.12; // boundary ink below this counts as a gap between cells
const CLASHES = 1.15; // d' above this: shifting by a cell lands ink on gaps
const MAX_SIDE = 512; // the downscaled copy's longest side

// What counts as background: transparent pixels, or for an opaque sheet the
// colour that fills its border.
export interface Background {
  isInk(rgba: Uint8Array, i: number): boolean;
  // Anything at all, however faint: what keeps a trailing cell a frame.
  isAny(rgba: Uint8Array, i: number): boolean;
}

export function backgroundOf(img: Image): Background {
  const { width, height, rgba } = img;
  let clear = 0;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] < 16) clear++;
  if (clear > (width * height) / 200) return { isInk: (px, i) => px[i + 3] >= 16, isAny: (px, i) => px[i + 3] > 0 };
  // Opaque: the most common border colour is the background.
  const counts = new Map<number, number>();
  const tally = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    const key = (rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2];
    counts.set(key, (counts.get(key) || 0) + 1);
  };
  for (let x = 0; x < width; x++) tally(x, 0), tally(x, height - 1);
  for (let y = 0; y < height; y++) tally(0, y), tally(width - 1, y);
  const bg = [...counts].sort((a, b) => b[1] - a[1])[0][0];
  const [r, g, b] = [bg >> 16, (bg >> 8) & 0xff, bg & 0xff];
  const isInk = (px: Uint8Array, i: number) => px[i + 3] >= 16 && Math.abs(px[i] - r) + Math.abs(px[i + 1] - g) + Math.abs(px[i + 2] - b) > 48;
  return { isInk, isAny: isInk };
}

interface Small {
  data: Float32Array; // premultiplied RGBA, background zeroed
  w: number;
  h: number;
  k: number; // downscale factor
  inkCols: Float64Array; // full resolution: ink (alpha) summed per column
  inkRows: Float64Array;
}

function shrink(img: Image, bg: Background): Small {
  const { width, height, rgba } = img;
  const k = Math.max(1, Math.ceil(Math.max(width, height) / MAX_SIDE));
  const w = Math.floor(width / k);
  const h = Math.floor(height / k);
  const data = new Float32Array(w * h * 4);
  const inkCols = new Float64Array(width);
  const inkRows = new Float64Array(height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (!bg.isInk(rgba, i)) continue;
      inkCols[x] += rgba[i + 3] / 255;
      inkRows[y] += rgba[i + 3] / 255;
      const sx = Math.floor(x / k);
      const sy = Math.floor(y / k);
      if (sx >= w || sy >= h) continue;
      const o = (sy * w + sx) * 4;
      const a = rgba[i + 3] / 255;
      data[o] += rgba[i] * a;
      data[o + 1] += rgba[i + 1] * a;
      data[o + 2] += rgba[i + 2] * a;
      data[o + 3] += rgba[i + 3];
    }
  }
  for (let i = 0; i < data.length; i++) data[i] /= k * k;
  return { data, w, h, k, inkCols, inkRows };
}

// YIN's cumulative mean normalised difference, d'(τ) for τ = 0..len/2.
function normalisedDifference(s: Small, axis: "x" | "y"): Float64Array {
  const { data, w, h } = s;
  const len = axis === "x" ? w : h;
  const max = Math.ceil(len / 2);
  const out = new Float64Array(max + 1);
  out[0] = 1;
  let running = 0;
  for (let t = 1; t <= max; t++) {
    let sum = 0;
    let n = 0;
    const step = axis === "x" ? t * 4 : t * w * 4;
    const xEnd = axis === "x" ? w - t : w;
    const yEnd = axis === "x" ? h : h - t;
    for (let y = 0; y < yEnd; y++) {
      for (let x = 0, a = y * w * 4; x < xEnd; x++, a += 4) {
        const b = a + step;
        sum += Math.abs(data[a] - data[b]) + Math.abs(data[a + 1] - data[b + 1]) + Math.abs(data[a + 2] - data[b + 2]) + Math.abs(data[a + 3] - data[b + 3]);
        n++;
      }
    }
    const d = n ? sum / n : 0;
    running += d;
    out[t] = running ? (d * t) / running : 1;
  }
  return out;
}

// Boundaries of `count` cells along `len` pixels: round(i * len / count), as
// the web's exporter cuts fractional cells.
export const cuts = (len: number, count: number) => Array.from({ length: count + 1 }, (_, i) => Math.round((i * len) / count));

function guessAxis(s: Small, axis: "x" | "y", len: number): AxisGuess {
  const dp = normalisedDifference(s, axis);
  const ink = axis === "x" ? s.inkCols : s.inkRows;
  const meanInk = ink.reduce((a, b) => a + b, 0) / len || 1;
  const lagOf = (n: number) => len / n / s.k;
  const at = (lag: number) => {
    const lo = Math.floor(lag);
    const hi = Math.ceil(lag);
    if (hi >= dp.length || lo < 1) return 1;
    return Math.min(dp[lo], dp[hi]);
  };
  const candidates: number[] = [];
  for (let n = 2; n <= Math.min(MAX_CELLS, Math.floor(len / MIN_CELL)); n++) if (lagOf(n) >= 2) candidates.push(n);
  const score = new Map(candidates.map(n => [n, at(lagOf(n))]));

  // Ink on the boundaries: per boundary the emptiest line within 2% of a
  // cell, relative to the average line; the worst boundary counts, since a
  // split twice too fine has clean true boundaries and inked middles.
  const boundaryInk = (n: number) => {
    const reach = Math.max(1, Math.round((len / n) * 0.02));
    let worst = 0;
    for (const c of cuts(len, n).slice(1, -1)) {
      let least = Infinity;
      for (let t = Math.max(0, c - reach); t <= Math.min(len - 1, c + reach); t++) least = Math.min(least, ink[t]);
      worst = Math.max(worst, least);
    }
    return worst / meanInk;
  };
  // Every band of cells has ink, except possibly trailing ones.
  const bandsInked = (n: number) => {
    const c = cuts(len, n);
    const inked = Array.from({ length: n }, (_, i) => ink.subarray(c[i], c[i + 1]).some(v => v > 0));
    const last = inked.lastIndexOf(true);
    return last > 0 && inked.slice(0, last + 1).every(Boolean);
  };
  const clean = new Map(candidates.map(n => [n, boundaryInk(n)]));
  const repeats = (n: number) => score.get(n)! < REPEATS;
  const gapped = (n: number) => clean.get(n)! < CLEAN && score.get(n)! < CLASHES && bandsInked(n);

  // The finest split that repeats, taken down to the bottom of its dip:
  // follow d' over whole lags while it keeps falling, and take the split
  // nearest that minimum.
  const repeating = candidates.filter(repeats);
  let lattice = repeating.length ? Math.max(...repeating) : 1;
  if (lattice > 1) {
    let lag = Math.round(lagOf(lattice));
    for (;;) {
      const next = [lag - 1, lag + 1].filter(t => t >= 1 && t < dp.length && dp[t] < dp[lag]).sort((a, b) => dp[a] - dp[b])[0];
      if (next === undefined) break;
      lag = next;
    }
    lattice = candidates.reduce((best, n) => (Math.abs(lagOf(n) - lag) < Math.abs(lagOf(best) - lag) ? n : best), lattice);
  }
  // Gaps alone may refine that split (frames too different to repeat, but
  // with clean boundaries between them) but never contradict it: narrow
  // sprites leave gaps where no boundary is.
  const plausible = (n: number) => (repeats(n) && lattice % n === 0) || n === lattice || (gapped(n) && n % lattice === 0);
  const count = Math.max(lattice, ...candidates.filter(plausible));
  // How strongly n looks like a split: below 1 is plausible, lower is stronger.
  const evidence = (n: number) => Math.min(score.get(n)! / REPEATS, plausible(n) && gapped(n) ? clean.get(n)! / CLEAN : Infinity);

  // Confidence: how far the chosen split beats every rival that is not one
  // of its own coarser versions (a 6-cell sheet also splits into 2 or 3).
  const rivals = candidates.filter(n => n !== count && count % n !== 0).map(evidence);
  const rival = Math.min(1.5, ...rivals);
  const own = count > 1 ? evidence(count) : 1;
  // Nothing plausible: one cell, believable only when nothing came close.
  const confidence = Math.min(1, Math.max(0, (rival - own) / 0.5));
  return { count, score: count > 1 ? score.get(count)! : 1, boundaryInk: count > 1 ? clean.get(count)! : 1, confidence };
}

// Cells at the end of the sheet, in reading order, with nothing in them (not
// even 4 faint pixels) are padding rather than frames.
export function countFrames(img: Image, cols: number, rows: number, bg: Background = backgroundOf(img)): number {
  const rects = frameRects(img.width, img.height, cols, rows);
  for (let f = rects.length - 1; f > 0; f--) {
    const r = rects[f];
    let ink = 0;
    for (let y = r.y; y < r.y + r.h && ink < 4; y++) {
      for (let x = r.x; x < r.x + r.w; x++) if (bg.isAny(img.rgba, (y * img.width + x) * 4) && ++ink >= 4) break;
    }
    if (ink >= 4) return f + 1;
  }
  return 1;
}

export function guessGrid(img: Image): GridGuess {
  const bg = backgroundOf(img);
  const s = shrink(img, bg);
  const x = guessAxis(s, "x", img.width);
  const y = guessAxis(s, "y", img.height);
  // One cell along an axis is believable only when the frames it implies
  // are not far out of proportion: a 6-column sheet whose rows do not repeat
  // is more likely 6 x 6 of very different frames than 6 tall strips.
  for (const [one, other, len, otherLen] of [[x, y, img.width, img.height], [y, x, img.height, img.width]] as const) {
    if (one.count === 1 && other.count > 1) {
      const ratio = len / (otherLen / other.count);
      if (ratio > 2 || ratio < 0.5) one.confidence = Math.min(one.confidence, 0.2);
    }
  }
  // A single cell is not a sheet.
  if (x.count === 1 && y.count === 1) x.confidence = y.confidence = 0;
  const frames = countFrames(img, x.count, y.count, bg);
  return { cols: x.count, rows: y.count, frames, confidence: Math.min(x.confidence, y.confidence), x, y };
}
