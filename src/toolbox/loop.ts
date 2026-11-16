import type { Image } from "../tty/png.js";
import type { Background } from "./grid.js";

// How well does an animation loop? One number, 0 to 1, and where it hitches.
//
// Two things are measured.
//
// 1. The quality: how alike the last frame and the first are, in absolute
//    terms. It approximates the loop_score Ludo's API returns with a sheet
//    (1 minus the mean distance between the DINOv3 patch features of the two
//    frames; under 0.7 Ludo flags bad_loop), without the network: each frame
//    goes to 224 px on a green screen and is cut into the same 16x16 patches,
//    and a patch is described by its edge directions (an 8-bin histogram of
//    oriented gradients) and its mean colour. The score is a linear mix of
//    six distances, fitted on 3,041 looping sheets Ludo generated (Nov 2026):
//    edges and colour at the seam on a coarser 8x8 grid, colour with each
//    patch allowed its best neighbour (a shape that moved a few pixels), how
//    much the two silhouettes overlap, and the clip's own typical colour and
//    overlap change from frame to frame. On those sheets it lands within 0.10
//    of loop_score 87% of the time and within 0.20 98% of the time, and it
//    agrees with bad_loop on 91%. It reads less than the network does: a
//    change of meaning in a small area (a glass filling up) costs it less,
//    and a thin shape that shifted costs it more.
//    An earlier version scored the seam against the clip's median step. That
//    ratio does not track what people call a bad loop (a near-still idle
//    fails it), and it disagreed with bad_loop on four sheets in ten.
//
// 2. Where it hitches: the frame-distance matrix of Video Textures (Schödl,
//    Szeliski, Salesin & Essa, SIGGRAPH 2000, §3). D(i, j) is how different
//    frames i and j are, in units of the animation's typical step (the median
//    adjacent distance, held frames left out), as the larger of:
//    - the mean absolute difference of premultiplied RGBA, which sees colour
//      and catches a repeated frame exactly, but saturates: sprite limbs move
//      further than their own width between frames;
//    - the symmetric chamfer distance between the two silhouettes' outlines
//      (Barrow et al. 1977; the 3-4 distance transform of Borgefors 1986),
//      which keeps growing with how far things moved.
//    From it come the steps, the held frames, the big steps inside the clip
//    (jumps), a ping-pong, and the seam's size against a typical step. A loop
//    whose last frames are its first ones again shows them twice: that is
//    reported (repeat) and does not lower the quality, since the two frames
//    match and the fix is to drop a frame, not to regenerate.
//    It never cuts: Ludo's sheets come cut to their loop, and a second cut
//    inside the first one is wrong.

export const SAME = 0.25; // under a quarter of a step: the same frame
export const SMOOTH = 1.5; // a seam up to 1.5 steps plays as smooth
const JUMP = 2; // an adjacent step over twice the typical one is a jump
export const CLEAN = 0.85; // quality from here up: loops cleanly
export const VISIBLE = 0.7; // under this: a seam a player sees (where Ludo flags bad_loop)
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
  // 1 = the last frame flows into the first; null when nothing moves.
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

// `score` is loopScore() of the same frames.
export function analyseLoop(D: Float64Array[], score: number): LoopReport {
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

  const quality = round(score);

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

// ---- The quality (see the top) ----

const SIDE = 224; // frames are described at this size
const PATCH = 14; // in patches this wide, as a ViT-S/14 sees them
const CELLS = SIDE / PATCH; // 16 a side
const BINS = 8;
const INK = 0.04; // a patch (or pixel) with less cover than this is empty

interface Described {
  alpha: Float32Array; // per pixel, 0..1
  hog: Float32Array; // per patch: gradient magnitude by direction
  col: Float32Array; // per patch: mean colour on the green screen, 0..1
  cov: Float32Array; // per patch: mean cover
}

// Triangle-filter weights taking `from` samples to `to`, widened when it
// shrinks so that every source pixel counts.
function resampler(from: number, to: number): { first: number; weights: Float32Array }[] {
  const scale = from / to;
  const support = Math.max(1, scale);
  return Array.from({ length: to }, (_, o) => {
    const centre = (o + 0.5) * scale;
    const first = Math.max(0, Math.floor(centre - support));
    const last = Math.min(from - 1, Math.ceil(centre + support));
    const weights = new Float32Array(last - first + 1);
    let sum = 0;
    for (let s = first; s <= last; s++) sum += weights[s - first] = Math.max(0, 1 - Math.abs(s + 0.5 - centre) / support);
    for (let i = 0; i < weights.length; i++) weights[i] /= sum || 1;
    return { first, weights };
  });
}

function describe(f: Image, bg: Background): Described {
  const { width, height, rgba } = f;
  // Premultiplied, with the background's pixels made clear.
  const xs = resampler(width, SIDE);
  const ys = resampler(height, SIDE);
  const rowsDone = new Float32Array(height * SIDE * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < SIDE; x++) {
      const { first, weights } = xs[x];
      let [r, g, b, a] = [0, 0, 0, 0];
      for (let i = 0; i < weights.length; i++) {
        const p = (y * width + first + i) * 4;
        if (!bg.isInk(rgba, p)) continue;
        const w = (weights[i] * rgba[p + 3]) / 255;
        r += w * rgba[p];
        g += w * rgba[p + 1];
        b += w * rgba[p + 2];
        a += w;
      }
      rowsDone.set([r, g, b, a], (y * SIDE + x) * 4);
    }
  }
  const n = SIDE * SIDE;
  const rgb = new Float32Array(n * 3);
  const alpha = new Float32Array(n);
  const lum = new Float32Array(n);
  for (let y = 0; y < SIDE; y++) {
    const { first, weights } = ys[y];
    for (let x = 0; x < SIDE; x++) {
      let [r, g, b, a] = [0, 0, 0, 0];
      for (let i = 0; i < weights.length; i++) {
        const p = ((first + i) * SIDE + x) * 4;
        r += weights[i] * rowsDone[p];
        g += weights[i] * rowsDone[p + 1];
        b += weights[i] * rowsDone[p + 2];
        a += weights[i] * rowsDone[p + 3];
      }
      const p = y * SIDE + x;
      alpha[p] = a;
      // On a green screen, as Ludo's check sees the frames.
      rgb[p * 3] = r;
      rgb[p * 3 + 1] = g + 255 * (1 - a);
      rgb[p * 3 + 2] = b;
      lum[p] = 0.299 * rgb[p * 3] + 0.587 * rgb[p * 3 + 1] + 0.114 * rgb[p * 3 + 2];
    }
  }
  const hog = new Float32Array(CELLS * CELLS * BINS);
  const col = new Float32Array(CELLS * CELLS * 3);
  const cov = new Float32Array(CELLS * CELLS);
  for (let y = 0; y < SIDE; y++) {
    for (let x = 0; x < SIDE; x++) {
      const p = y * SIDE + x;
      const k = Math.floor(y / PATCH) * CELLS + Math.floor(x / PATCH);
      col[k * 3] += rgb[p * 3];
      col[k * 3 + 1] += rgb[p * 3 + 1];
      col[k * 3 + 2] += rgb[p * 3 + 2];
      cov[k] += alpha[p];
      if (y === 0 || x === 0 || y === SIDE - 1 || x === SIDE - 1) continue;
      const gx = lum[p + 1] - lum[p - 1];
      const gy = lum[p + SIDE] - lum[p - SIDE];
      const m = Math.hypot(gx, gy);
      if (!m) continue;
      let t = Math.atan2(gy, gx);
      if (t < 0) t += Math.PI;
      hog[k * BINS + Math.min(BINS - 1, Math.floor((t / Math.PI) * BINS))] += m;
    }
  }
  for (let k = 0; k < CELLS * CELLS; k++) {
    for (let c = 0; c < 3; c++) col[k * 3 + c] /= PATCH * PATCH * 255;
    cov[k] /= PATCH * PATCH;
  }
  return { alpha, hog, col, cov };
}

// The distance between two edge histograms, each scaled to length 1 (an
// edgeless patch counts as all zeros): 0 to √2.
function edgeDistance(a: Float32Array, i: number, b: Float32Array, j: number): number {
  let [na, nb] = [0, 0];
  for (let t = 0; t < BINS; t++) (na += a[i + t] ** 2), (nb += b[j + t] ** 2);
  [na, nb] = [Math.sqrt(na), Math.sqrt(nb)];
  let d = 0;
  for (let t = 0; t < BINS; t++) d += ((na > 1e-3 ? a[i + t] / na : 0) - (nb > 1e-3 ? b[j + t] / nb : 0)) ** 2;
  return Math.sqrt(d);
}

const colourDistance = (a: Float32Array, i: number, b: Float32Array, j: number) => Math.hypot(a[i] - b[j], a[i + 1] - b[j + 1], a[i + 2] - b[j + 2]);

// Mean colour distance over the patches either frame covers, and how much
// the two silhouettes overlap (intersection over union).
function colourAndOverlap(a: Described, b: Described): { col: number; iou: number } {
  let [sum, patches] = [0, 0];
  for (let k = 0; k < CELLS * CELLS; k++) {
    if (a.cov[k] < INK && b.cov[k] < INK) continue;
    sum += colourDistance(a.col, k * 3, b.col, k * 3);
    patches++;
  }
  let [both, either] = [0, 0];
  for (let p = 0; p < a.alpha.length; p++) {
    const [ia, ib] = [a.alpha[p] > INK, b.alpha[p] > INK];
    if (ia || ib) either++;
    if (ia && ib) both++;
  }
  return { col: patches ? sum / patches : 0, iou: either ? both / either : 1 };
}

// Edge and colour distance on a grid of 2x2 patches (8 cells a side).
function coarse(a: Described, b: Described): { hog: number; col: number } {
  const C = 2;
  const g = CELLS / C;
  let [dh, dc, cells] = [0, 0, 0];
  const [ha, hb] = [new Float32Array(BINS), new Float32Array(BINS)];
  const [ca, cb] = [new Float32Array(3), new Float32Array(3)];
  for (let cy = 0; cy < g; cy++) {
    for (let cx = 0; cx < g; cx++) {
      ha.fill(0), hb.fill(0), ca.fill(0), cb.fill(0);
      let [wa, wb] = [0, 0];
      for (let j = 0; j < C; j++) {
        for (let i = 0; i < C; i++) {
          const k = (cy * C + j) * CELLS + cx * C + i;
          for (let t = 0; t < BINS; t++) (ha[t] += a.hog[k * BINS + t]), (hb[t] += b.hog[k * BINS + t]);
          for (let c = 0; c < 3; c++) (ca[c] += a.col[k * 3 + c] / (C * C)), (cb[c] += b.col[k * 3 + c] / (C * C));
          (wa += a.cov[k]), (wb += b.cov[k]);
        }
      }
      if (wa / (C * C) < INK && wb / (C * C) < INK) continue;
      cells++;
      dh += edgeDistance(ha, 0, hb, 0);
      dc += colourDistance(ca, 0, cb, 0);
    }
  }
  return { hog: cells ? dh / cells : 0, col: cells ? dc / cells : 0 };
}

// Colour distance with each patch matched to the best of the other frame's
// 3x3 neighbourhood (by edges and colour together), both ways round.
function shiftedColour(a: Described, b: Described): number {
  let [sum, count] = [0, 0];
  for (const [A, B] of [
    [a, b],
    [b, a]
  ]) {
    for (let y = 0; y < CELLS; y++) {
      for (let x = 0; x < CELLS; x++) {
        const k = y * CELLS + x;
        if (A.cov[k] < INK && B.cov[k] < INK) continue;
        let [bestEdge, bestColour] = [9, 9];
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const [yy, xx] = [y + dy, x + dx];
            if (yy < 0 || xx < 0 || yy >= CELLS || xx >= CELLS) continue;
            const k2 = yy * CELLS + xx;
            const e = edgeDistance(A.hog, k * BINS, B.hog, k2 * BINS);
            const c = colourDistance(A.col, k * 3, B.col, k2 * 3);
            if (e + 2 * c < bestEdge + 2 * bestColour) [bestEdge, bestColour] = [e, c];
          }
        }
        sum += bestColour;
        count++;
      }
    }
  }
  return count ? sum / count : 0;
}

// What the score is made of: four distances between the last frame and the
// first, and the clip's typical colour and overlap change between
// neighbouring frames.
export function loopFeatures(frames: Image[], bg: Background): number[] {
  const d = frames.map(f => describe(f, bg));
  const [last, first] = [d[d.length - 1], d[0]];
  const seam = colourAndOverlap(last, first);
  const grid = coarse(last, first);
  const steps = d.slice(0, -1).map((f, i) => colourAndOverlap(f, d[i + 1]));
  // The upper median, as the fit used.
  const typical = (xs: number[]) => [...xs].sort((x, y) => x - y)[xs.length >> 1] ?? 0;
  return [grid.hog, shiftedColour(last, first), grid.col, 1 - seam.iou, typical(steps.map(s => s.col)), 1 - typical(steps.map(s => s.iou))];
}

// Fitted by least squares on loop_score (see the top): the intercept, then
// one weight per feature.
const WEIGHTS = [0.964, -0.429, -0.678, -0.137, -0.239, 0.641, -0.116];

export function loopScore(frames: Image[], bg: Background): number {
  const x = loopFeatures(frames, bg);
  return Math.max(0, Math.min(1, x.reduce((s, v, i) => s + v * WEIGHTS[i + 1], WEIGHTS[0])));
}
