import type { Image } from "../tty/png.js";
import type { Background } from "./grid.js";

// How well does an animation loop? One number, 0 to 1, and where it hitches.
//
// The method is the frame-distance matrix of Video Textures (Schödl,
// Szeliski, Salesin & Essa, SIGGRAPH 2000, §3): D(i, j) is how different
// frames i and j are, and a jump from frame e back to frame s looks like an
// ordinary step when the frame that would have followed e matches s,
// D(e+1, s) ≈ 0. Their "preserving dynamics" filter with m = 1 averages that
// with the tap one step earlier, D(e, s-1), so a pose passed through in the
// opposite direction does not count as a match. Here:
//
// - D is the larger of two measures, each in units of the animation's
//   typical step (the median adjacent distance, held frames left out), so the
//   numbers mean the same on a slow idle and a fast attack:
//   - the mean absolute difference of premultiplied RGBA, which sees colour
//     and catches a repeated frame exactly, but saturates: sprite limbs move
//     further than their own width between frames, and two poses that share
//     no pixels look equally far whatever the distance between them;
//   - the symmetric chamfer distance between the two silhouettes' outlines
//     (Barrow et al. 1977; the 3-4 distance transform of Borgefors 1986),
//     which keeps growing with how far things moved;
// - a tap only counts when the step it leans on is an ordinary one (not a
//   held frame, not a jump): a sheet whose last frame is a glitch would
//   otherwise vouch for loops that run into the glitch. With no usable tap
//   the seam itself is judged: up to about one step is smooth, much more is
//   a jump;
// - a loop whose last frames are its first ones again shows them twice, and
//   its seam can measure like an ordinary step while it steps backwards, so
//   that is checked on its own (whole cycles excepted);
// - the quality is how far the seam, the step from the last frame back to
//   the first, is off the pace: bigger than a typical step is a jump,
//   smaller than the steps either side of it a hover (a clip stalling at its
//   loop point), and none at all a pose shown twice.
//   A seam measured against the clip's own median step is what best told
//   bad loops from good in Ludo's ML calibration (28 loops marked blind,
//   ai-server research_findings/sprite-animation.md), better than the biggest
//   step anywhere. Big steps inside the clip are listed (jumps), not scored.
//   It never cuts: Ludo's sheets come cut to their loop, and a second cut
//   inside the first one is wrong.
//
// The thresholds are ours, picked on the fixtures in test/toolbox.test.mjs
// and on real sheets. Ludo's own wrap check is DINOv3 patch similarity, a
// different measure: the two numbers are not comparable.

export const SAME = 0.25; // under a quarter of a step: the same frame
export const SMOOTH = 1.5; // a seam up to 1.5 steps plays as smooth
const JUMP = 2; // an adjacent step over twice the typical one is a jump
// The quality is 1 / (1 + (w - 1)²) for a seam w times off the pace: 0.8 at
// 1.5, 0.5 at 2 (a jump).
export const CLEAN = 0.8; // quality from here up: loops cleanly
export const VISIBLE = 0.5; // under this: a hitch a player sees
const MAX_SIDE = 128; // frames are compared at this size or smaller
const BUDGET = 5e7; // pixel comparisons for the whole matrix

export interface LoopReport {
  frames: number;
  steps: number[]; // adjacent distances in typical steps: frame i -> i+1, then last -> first
  holds: number[]; // 1-based frames that repeat the frame before them
  jumps: number[]; // 1-based frames over twice a typical step from the frame before them
  // repeat: the last `repeats` frames are the first ones again.
  seam: { ratio: number; verdict: "smooth" | "jump" | "repeat" | "static"; repeats: number };
  mirrored: boolean; // plays forward then back (a ping-pong)
  // 1 = the seam plays like any other step; null when nothing moves.
  quality: number | null;
  matrix: number[][]; // D in typical steps: 1 = an ordinary step, 0 = the same frame
}

// Frames shrunk by an integer box filter: premultiplied RGBA, and which
// small pixels are mostly ink.
function shrink(frames: Image[], bg: Background) {
  const { width, height } = frames[0];
  let k = Math.max(1, Math.ceil(Math.max(width, height) / MAX_SIDE));
  const pairs = (frames.length * (frames.length - 1)) / 2;
  while (k < Math.max(width, height) && Math.floor(width / k) * Math.floor(height / k) * pairs > BUDGET) k++;
  const w = Math.max(1, Math.floor(width / k));
  const h = Math.max(1, Math.floor(height / k));
  const covered = new Uint8Array(w * h);
  const small = frames.map(f => {
    const data = new Float32Array(w * h * 4);
    const ink = new Uint16Array(w * h);
    for (let y = 0; y < h * k; y++) {
      for (let x = 0; x < w * k; x++) {
        const i = (y * f.width + x) * 4;
        const a = f.rgba[i + 3];
        const p = Math.floor(y / k) * w + Math.floor(x / k);
        if (bg.isInk(f.rgba, i)) ink[p]++;
        if (!a) continue;
        data[p * 4] += (f.rgba[i] * a) / 255;
        data[p * 4 + 1] += (f.rgba[i + 1] * a) / 255;
        data[p * 4 + 2] += (f.rgba[i + 2] * a) / 255;
        data[p * 4 + 3] += a;
        covered[p] = 1;
      }
    }
    for (let i = 0; i < data.length; i++) data[i] /= k * k;
    const mask = Uint8Array.from(ink, c => (2 * c >= k * k ? 1 : 0));
    return { data, mask };
  });
  return { small, covered, w, h };
}

// Ink pixels on the silhouette's outline: a 4-neighbour is not ink, or is
// off the frame.
function outline(mask: Uint8Array, w: number, h: number): number[] {
  const out: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (mask[p] && (x === 0 || y === 0 || x === w - 1 || y === h - 1 || !mask[p - 1] || !mask[p + 1] || !mask[p - w] || !mask[p + w])) out.push(p);
    }
  }
  return out;
}

// Borgefors' 3-4 chamfer distance transform: for every pixel, about three
// times the distance to the nearest outline pixel, in two raster passes.
function distanceTransform(edges: number[], w: number, h: number): Uint32Array {
  const d = new Uint32Array(w * h).fill(0x3fffffff);
  for (const p of edges) d[p] = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      let v = d[p];
      if (x > 0) v = Math.min(v, d[p - 1] + 3);
      if (y > 0) {
        v = Math.min(v, d[p - w] + 3);
        if (x > 0) v = Math.min(v, d[p - w - 1] + 4);
        if (x < w - 1) v = Math.min(v, d[p - w + 1] + 4);
      }
      d[p] = v;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const p = y * w + x;
      let v = d[p];
      if (x < w - 1) v = Math.min(v, d[p + 1] + 3);
      if (y < h - 1) {
        v = Math.min(v, d[p + w] + 3);
        if (x < w - 1) v = Math.min(v, d[p + w + 1] + 4);
        if (x > 0) v = Math.min(v, d[p + w - 1] + 4);
      }
      d[p] = v;
    }
  }
  return d;
}

const matrixOf = (n: number) => Array.from({ length: n }, () => new Float64Array(n));

// The median adjacent distance, held frames (next to no change) left out.
function typicalStep(D: Float64Array[]): { step: number; isHold: (d: number) => boolean } {
  const adjacent = D.slice(0, -1).map((row, i) => row[i + 1]);
  const moving = median(adjacent.filter(d => d > 0));
  const isHold = (d: number) => d <= SAME * moving;
  return { step: median(adjacent.filter(d => !isHold(d))) || moving, isHold };
}

// D(i, j) for every pair, symmetric, in typical steps (see the top).
export function frameDifferences(frames: Image[], bg: Background): Float64Array[] {
  const n = frames.length;
  const { small, covered, w, h } = shrink(frames, bg);
  let px = 0;
  for (const c of covered) px += c;
  const pixels = matrixOf(n);
  const shape = matrixOf(n);
  const edges = small.map(f => outline(f.mask, w, h));
  const fields = edges.map(e => distanceTransform(e, w, h));
  const far = 3 * (w + h);
  const meanOver = (e: number[], field: Uint32Array) => e.reduce((a, p) => a + Math.min(field[p], far), 0) / e.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = small[i].data;
      const b = small[j].data;
      let sum = 0;
      for (let p = 0, o = 0; p < covered.length; p++, o += 4) {
        if (!covered[p]) continue;
        sum += Math.abs(a[o] - b[o]) + Math.abs(a[o + 1] - b[o + 1]) + Math.abs(a[o + 2] - b[o + 2]) + Math.abs(a[o + 3] - b[o + 3]);
      }
      pixels[i][j] = pixels[j][i] = px ? sum / (px * 4) : 0;
      const [ei, ej] = [edges[i], edges[j]];
      const c = !ei.length && !ej.length ? 0 : !ei.length || !ej.length ? far : (meanOver(ei, fields[j]) + meanOver(ej, fields[i])) / 2;
      shape[i][j] = shape[j][i] = c / 3;
    }
  }
  // Each measure in its own typical steps; a measure that never moves (only
  // colours change, or nothing does) sits out.
  const scaled = [pixels, shape].map(m => ({ m, step: typicalStep(m).step })).filter(x => x.step > 0);
  const D = matrixOf(n);
  for (const { m, step } of scaled) for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) D[i][j] = Math.max(D[i][j], m[i][j] / step);
  return D;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const round = (x: number, places = 2) => Math.round(x * 10 ** places) / 10 ** places;

export function analyseLoop(D: Float64Array[]): LoopReport {
  const n = D.length;
  const adjacent = Array.from({ length: n - 1 }, (_, i) => D[i][i + 1]);
  const { step, isHold } = typicalStep(D);
  const matrix = D.map(row => Array.from(row, d => round(step ? d / step : 0)));
  if (n < 2 || step === 0) {
    return { frames: n, steps: [], holds: [], jumps: [], seam: { ratio: 0, verdict: "static", repeats: 0 }, mirrored: false, quality: null, matrix };
  }
  const r = (i: number, j: number) => D[i][j] / step;
  // A loop whose last k frames are its first k again shows them twice, and
  // its seam can look like an ordinary step while it steps backwards. Not
  // when every frame is the one k later too: then it is whole cycles, which
  // loop. Returns k, or 0.
  const repeatsAtEnd = () => {
    for (let j = n - 1; j > 0; j--) {
      if (r(j, 0) >= SAME) continue;
      const k = n - j;
      let all = true;
      for (let i = 1; i < k && all; i++) all = r(j + i, i) < SAME;
      if (!all) continue;
      let cycles = true;
      for (let i = 0; i + k < n && cycles; i++) cycles = r(i, i + k) < SAME;
      return cycles ? 0 : k;
    }
    return 0;
  };

  const seamRatio = r(n - 1, 0);
  const repeats = repeatsAtEnd();
  const verdict = repeats ? "repeat" : seamRatio <= SMOOTH ? "smooth" : "jump";

  // How far the seam is off the pace (see the top). Bigger is judged against
  // the typical step; smaller against the steps either side of it, up to a
  // typical one, since an idle that is slow at its loop point anyway does not
  // hover there. A pose shown twice is a stutter whatever the seam measures.
  const beside = [adjacent[n - 2], adjacent[0]].filter(d => !isHold(d)).map(d => d / step);
  const pace = Math.min(1, beside.length ? beside.reduce((a, b) => a + b, 0) / beside.length : 1);
  const slow = pace / Math.max(seamRatio, 0.05);
  const off = repeats ? Math.max(1 / SAME, slow) : Math.max(1, seamRatio, slow);
  const quality = round(1 / (1 + (off - 1) ** 2));

  // A ping-pong: some pivot mirrors every frame onto a twin, i + j ≡ 2c.
  let mirrored = false;
  if (n >= 4) {
    for (let twice = 0; twice < n && !mirrored; twice++) {
      let all = true;
      let pairs = 0;
      for (let i = 0; i < n && all; i++) {
        const j = (((twice - i) % n) + n) % n;
        if (j <= i) continue;
        pairs++;
        if (r(i, j) >= SAME) all = false;
      }
      mirrored = all && pairs >= 2;
    }
  }

  const holds: number[] = [];
  const jumps: number[] = [];
  adjacent.forEach((d, i) => {
    if (isHold(d)) holds.push(i + 2);
    else if (d > JUMP * step) jumps.push(i + 2);
  });
  return {
    frames: n,
    steps: [...adjacent.map(d => round(d / step)), round(seamRatio)],
    holds,
    jumps,
    seam: { ratio: round(seamRatio), verdict, repeats },
    mirrored,
    quality,
    matrix
  };
}
