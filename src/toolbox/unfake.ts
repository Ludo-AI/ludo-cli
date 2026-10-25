import type { Image } from "../tty/png.js";

// Pixel art that is not on its own grid any more (an image model's "pixel
// art", drawn at 6x or resampled to 2048 px) back to one pixel per art pixel.
//
// A port of unfake.js's canonical core, unfake-core 0.3.0
// (https://github.com/jenissimo/unfake.js, crates/unfake-core at 6636868,
// release v1.4.0): the scale detectors (detect/runs.rs, detect/edge.rs), the
// fractional grid (detect/grid.rs), the elastic grid fitted to hand-drawn
// cells (detect/elastic.rs), the grid phase (snap.rs) and the cell reducers
// (downscale.rs, math.rs). `unfake` runs them in the order unfake.js's own
// pipeline does (browser-tool/lib/pixel.js processImage, with its defaults:
// alpha binarized at 128, tiled edge detection, dominant colour per cell),
// except colour quantization, which there is libimagequant (GPL) and here an
// optional separate step. test/unfake.test.mjs checks it against unfake.js's
// own wasm build (scripts/unfake-fixtures.mjs).
//
// Added here, ahead of the estimators: exactGrid, which reads an exact
// upscale exactly (unfake.js's runs detector, made to tolerate stray
// pixels). Ludo's own pixel art is mostly exact upscales, which unfake.js's
// edge periods often read at twice or more the true size.
//
// Where Rust picks one of several equal maxima, so does this: `max_by` the
// last, `find` the first. The one place the Rust is not deterministic (the
// dominant colour of a cell whose two most common colours tie, read out of a
// HashMap) takes the colour seen first, as unfake.js's JavaScript does.
//
// MIT License
//
// Copyright (c) 2024 unfake.js team
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// ---- math.rs ----

function medianU8(values: number[]): number {
  if (!values.length) return 0;
  const s = values.slice().sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) >> 1;
}

// The first value whose running count goes past every earlier one's.
function modeOf(values: ArrayLike<number>): number {
  if (!values.length) return 0;
  const counts = new Map<number, number>();
  let best = values[0];
  let bestN = 0;
  for (let i = 0; i < values.length; i++) {
    const c = (counts.get(values[i]) ?? 0) + 1;
    counts.set(values[i], c);
    if (c > bestN) {
      bestN = c;
      best = values[i];
    }
  }
  return best;
}

function meanU8(values: number[]): number {
  if (!values.length) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return Math.floor(sum / values.length);
}

// ---- detect/runs.rs ----

// The greatest common divisor of every run of identical pixels longer than
// one, across rows and columns: exact for clean upscaled pixel art.
export function runsBasedDetect(img: Image): number {
  const { width: w, height: h, rgba } = img;
  const runs: number[] = [];
  const same = (a: number, b: number) =>
    rgba[a * 4] === rgba[b * 4] && rgba[a * 4 + 1] === rgba[b * 4 + 1] && rgba[a * 4 + 2] === rgba[b * 4 + 2] && rgba[a * 4 + 3] === rgba[b * 4 + 3];
  for (let y = 0; y < h; y++) {
    let len = 1;
    for (let x = 1; x < w; x++) {
      if (same(y * w + x, y * w + x - 1)) len++;
      else {
        if (len > 1) runs.push(len);
        len = 1;
      }
    }
    if (len > 1) runs.push(len);
  }
  for (let x = 0; x < w; x++) {
    let len = 1;
    for (let y = 1; y < h; y++) {
      if (same(y * w + x, (y - 1) * w + x)) len++;
      else {
        if (len > 1) runs.push(len);
        len = 1;
      }
    }
    if (len > 1) runs.push(len);
  }
  if (runs.length < 10) return 1;
  let g = runs[0];
  for (let i = 1; i < runs.length && g !== 1; i++) g = gcd(g, runs[i]);
  return Math.max(1, g);
}

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

// An exact upscale, found the way runs-based detection finds it (every
// colour change on one lattice) but allowing 2% of the changes off it, for
// the stray pixels that break the plain GCD: per axis, the exact colour
// changes across each column (row) boundary, and the largest cell size whose
// best phase holds 98% of them on both axes. Pixel art that is one, scaled
// down by it, loses nothing; anything else (soft or lossy edges) has no such
// size and is left to the estimators.
//
// With a tolerance, only brightness changes of more than that count: an
// exact upscale saved as lossy WebP or JPEG keeps its edges on the grid but
// speckles every cell, which the plain check reads as edges everywhere.
export function exactGrid(img: Image, need = 0.98, tolerance = 0): Grid | undefined {
  const { width: w, height: h, rgba } = img;
  const px = new Float64Array(w);
  const py = new Float64Array(h);
  const luma = (i: number) => 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
  const differs = (a: number, b: number) => {
    const oa = rgba[a + 3] > 127;
    if (oa !== rgba[b + 3] > 127) return true;
    if (!oa) return false;
    if (!tolerance) return rgba[a] !== rgba[b] || rgba[a + 1] !== rgba[b + 1] || rgba[a + 2] !== rgba[b + 2];
    return Math.abs(luma(a) - luma(b)) > tolerance;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 1; x < w; x++) if (differs((y * w + x) * 4, (y * w + x - 1) * 4)) px[x]++;
    if (y) for (let x = 0; x < w; x++) if (differs((y * w + x) * 4, ((y - 1) * w + x) * 4)) py[y]++;
  }
  const onLattice = (profile: Float64Array, s: number) => {
    const res = new Float64Array(s);
    let total = 0;
    for (let i = 0; i < profile.length; i++) {
      res[i % s] += profile[i];
      total += profile[i];
    }
    let best = 0;
    for (let r = 1; r < s; r++) if (res[r] > res[best]) best = r;
    return { share: total ? res[best] / total : 0, offset: best, total };
  };
  let found: Grid | undefined;
  const maxS = Math.min(64, Math.floor(Math.min(w, h) / 4));
  for (let s = 2; s <= maxS; s++) {
    const a = onLattice(px, s);
    const b = onLattice(py, s);
    if (a.total >= 16 && b.total >= 16 && a.share >= need && b.share >= need) found = integerGrid(s, a.offset, b.offset);
  }
  return found;
}

// ---- detect/edge.rs ----

const KX = [-1, 0, 1, -2, 0, 2, -1, 0, 1];
const KY = [-1, -2, -1, 0, 0, 0, 1, 2, 1];

function toGray(img: Image, round = false): Float64Array {
  const n = img.width * img.height;
  const g = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const v = 0.299 * img.rgba[i * 4] + 0.587 * img.rgba[i * 4 + 1] + 0.114 * img.rgba[i * 4 + 2];
    g[i] = round ? roundHalfAway(v) : v;
  }
  return g;
}

// Rust's f64::round: halves away from zero (Math.round goes up).
const roundHalfAway = (v: number) => Math.sign(v) * Math.round(Math.abs(v));

function reflect(i: number, n: number): number {
  if (n === 1) return 0;
  let v = i;
  while (v < 0 || v >= n) {
    if (v < 0) v = -v;
    if (v >= n) v = 2 * (n - 1) - v;
  }
  return v;
}

// Column and row sums of |Sobel| over a region.
function sobelProfiles(gray: Float64Array, w: number, h: number, x0: number, y0: number, rw: number, rh: number): [Float64Array, Float64Array] {
  const px = new Float64Array(rw);
  const py = new Float64Array(rh);
  for (let ly = 0; ly < rh; ly++) {
    for (let lx = 0; lx < rw; lx++) {
      const y = y0 + ly;
      const x = x0 + lx;
      let sx = 0;
      let sy = 0;
      let k = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const v = gray[reflect(y + dy, h) * w + reflect(x + dx, w)];
          sx += v * KX[k];
          sy += v * KY[k];
          k++;
        }
      }
      px[lx] += Math.abs(sx);
      py[ly] += Math.abs(sy);
    }
  }
  return [px, py];
}

function regionStddev(gray: Float64Array, w: number, x0: number, y0: number, rw: number, rh: number): number {
  const n = rw * rh;
  let sum = 0;
  let sum2 = 0;
  for (let ly = 0; ly < rh; ly++) {
    for (let lx = 0; lx < rw; lx++) {
      const v = gray[(y0 + ly) * w + x0 + lx];
      sum += v;
      sum2 += v * v;
    }
  }
  const mean = sum / n;
  return Math.sqrt(Math.max(0, sum2 / n - mean * mean));
}

const scalesFromRoi = (gray: Float64Array, w: number, h: number, x0: number, y0: number, rw: number, rh: number): [number, number] => {
  if (rw < 3 || rh < 3) return [1, 1];
  const [px, py] = sobelProfiles(gray, w, h, x0, y0, rw, rh);
  return [peakLag(px), peakLag(py)];
};

// The period of a 1-D profile: the first autocorrelation peak within 60% of
// the strongest (cvfree.mjs peakLag).
export function peakLag(sig: ArrayLike<number>): number {
  const n = sig.length;
  if (n < 4) return 1;
  const maxLag = Math.max(2, Math.min(Math.floor(n / 8), 128));
  let mean = 0;
  for (let i = 0; i < n; i++) mean += sig[i];
  mean /= n;
  const s = new Float64Array(n);
  let norm = 0;
  for (let i = 0; i < n; i++) {
    s[i] = sig[i] - mean;
    norm += s[i] * s[i];
  }
  norm = Math.max(norm, 1e-9);
  const ac = new Float64Array(maxLag + 2);
  for (let lag = 2; lag <= maxLag; lag++) {
    let r = 0;
    for (let i = 0; i < n - lag; i++) r += s[i] * s[i + lag];
    ac[lag] = r / norm;
  }
  let start = 2;
  const cap = Math.max(maxLag >> 1, 3);
  while (start < cap && ac[start + 1] <= ac[start]) start++;
  let gmax = 0;
  let gp = start;
  for (let p = start; p <= maxLag; p++) {
    if (ac[p] > gmax) {
      gmax = ac[p];
      gp = p;
    }
  }
  if (gmax <= 0) return 1;
  const thr = 0.6 * gmax;
  for (let p = start; p <= maxLag; p++) if (ac[p] >= thr && ac[p] >= ac[p - 1] && ac[p] >= ac[p + 1]) return p;
  return gp;
}

export function singleRegionEdgeDetect(img: Image): number {
  const gray = toGray(img);
  const { width: w, height: h } = img;
  const x0 = Math.floor(w * 0.125);
  const y0 = Math.floor(h * 0.125);
  const rw = Math.floor(w * 0.75);
  const rh = Math.floor(h * 0.75);
  if (rw < 3 || rh < 3) return 1;
  const [hs, vs] = scalesFromRoi(gray, w, h, x0, y0, rw, rh);
  if (hs > 1 && vs > 1 && Math.abs(hs - vs) <= 2) return roundHalfAway((hs + vs) / 2);
  return Math.max(hs, vs, 1);
}

// Edge periods in a 3x3 of overlapping tiles, the most common one: robust to
// a flat background and a busy middle.
export function tiledEdgeDetect(img: Image): number {
  const gray = toGray(img);
  const { width: w, height: h } = img;
  const tileW = Math.floor(w / 3);
  const tileH = Math.floor(h / 3);
  const overlapW = Math.floor(tileW * 0.25);
  const overlapH = Math.floor(tileH * 0.25);
  if (tileW < 50 || tileH < 50) return singleRegionEdgeDetect(img);
  const all: number[] = [];
  for (let ty = 0; ty < 3; ty++) {
    for (let tx = 0; tx < 3; tx++) {
      const x0 = Math.max(0, tx * tileW - overlapW);
      const y0 = Math.max(0, ty * tileH - overlapH);
      const rw = Math.min(tileW + 2 * overlapW, w - x0);
      const rh = Math.min(tileH + 2 * overlapH, h - y0);
      if (rw < 30 || rh < 30) continue;
      if (regionStddev(gray, w, x0, y0, rw, rh) < 5) continue;
      const [hs, vs] = scalesFromRoi(gray, w, h, x0, y0, rw, rh);
      if (hs > 1) all.push(hs);
      if (vs > 1) all.push(vs);
    }
  }
  return all.length ? Math.max(1, modeOf(all)) : singleRegionEdgeDetect(img);
}

// ---- detect/grid.rs ----

const PMIN = 2.1;
const HARMONIC_RATIO = 0.3;
const NEAR_PEAK = 0.8;
const SUBHARMONIC_COHERENCE = 0.75;
const MIN_COHERENCE = 0.15;
const DCT_COHERENCE = 0.3;
const MIN_PROMINENCE = 5;
const MAX_AXIS_DISAGREEMENT = 0.02;

export interface AxisGrid {
  period: number; // cell size in source pixels, maybe fractional
  offset: number; // a cell boundary lies at offset + i * period, offset in [0, period)
  coherence: number; // share of edge energy on the grid
  prominence: number; // spectral peak over the band's median
}

export interface Grid {
  x: AxisGrid;
  y: AxisGrid;
}

// Explicit boundaries per axis, ascending; each pair is one output pixel,
// and the outer two may lie outside the image.
export interface CellBounds {
  x: number[];
  y: number[];
}

const firstCell = (a: AxisGrid) => Math.ceil(-a.offset / a.period - 0.5);

// Cells whose centre lies inside [0, len).
export function axisCells(a: AxisGrid, len: number): number {
  const last = Math.ceil((len - a.offset) / a.period - 0.5) - 1;
  return Math.max(0, last - firstCell(a) + 1);
}

export function axisBounds(a: AxisGrid, len: number): number[] {
  const first = firstCell(a);
  return Array.from({ length: axisCells(a, len) + 1 }, (_, i) => a.offset + (first + i) * a.period);
}

const isIntegerLike = (a: AxisGrid, len: number) => {
  const r = roundHalfAway(a.period);
  return r >= 1 && Math.abs(len / a.period - len / r) < 0.5;
};

export const integerGrid = (scale: number, ox: number, oy: number): Grid => ({
  x: { period: scale, offset: ox, coherence: 0, prominence: 0 },
  y: { period: scale, offset: oy, coherence: 0, prominence: 0 }
});

export const gridBounds = (g: Grid, width: number, height: number): CellBounds => ({ x: axisBounds(g.x, width), y: axisBounds(g.y, height) });

const isDctPeriod = (p: number) => {
  const k = roundHalfAway(16 / p);
  return k >= 1 && Math.abs(p - 16 / k) < 0.005;
};

// A confident non-integer grid, or undefined where the integer detectors
// should be trusted.
export function fractionalGridDetect(img: Image): Grid | undefined {
  const [px, py] = edgeProfiles(img);
  const x = estimateAxis(px);
  if (!x) return undefined;
  const y = estimateAxis(py);
  if (!y) return undefined;
  const [a, b] = [x.period, y.period];
  const minCoherence = isDctPeriod(a) || isDctPeriod(b) ? DCT_COHERENCE : MIN_COHERENCE;
  if (
    Math.abs(a - b) / Math.max(a, b) > MAX_AXIS_DISAGREEMENT ||
    Math.min(x.coherence, y.coherence) < minCoherence ||
    Math.min(x.prominence, y.prominence) < MIN_PROMINENCE ||
    (isIntegerLike(x, img.width) && isIntegerLike(y, img.height))
  ) {
    return undefined;
  }
  return { x, y };
}

// A grid for a given (maybe fractional) cell size: snapped to a whole number
// of cells when within a quarter cell, phase from the edges.
export function gridForScale(img: Image, scale: number): Grid {
  const [px, py] = edgeProfiles(img);
  return { x: axisForPeriod(px, img.width, scale), y: axisForPeriod(py, img.height, scale) };
}

function axisForPeriod(profile: Float64Array, len: number, scale: number): AxisGrid {
  const cells = len / scale;
  const whole = roundHalfAway(cells);
  const period = whole >= 1 && Math.abs(cells - whole) < 0.25 ? len / whole : scale;
  const [offset, coherence] = phaseAndCoherence(profile, period);
  return { period, offset, coherence, prominence: 0 };
}

// Column / row edge profiles; entry i is the boundary at i + 1. On
// premultiplied RGB + alpha, so the colour of transparent pixels adds nothing.
export function edgeProfiles(img: Image): [Float64Array, Float64Array] {
  const { width: w, height: h, rgba } = img;
  const px = new Float64Array(Math.max(0, w - 1));
  const py = new Float64Array(Math.max(0, h - 1));
  let prev = new Int32Array(w * 4);
  let cur = new Int32Array(w * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const a = rgba[i + 3];
      cur[x * 4] = Math.trunc((rgba[i] * a) / 255);
      cur[x * 4 + 1] = Math.trunc((rgba[i + 1] * a) / 255);
      cur[x * 4 + 2] = Math.trunc((rgba[i + 2] * a) / 255);
      cur[x * 4 + 3] = a;
    }
    for (let x = 0; x < w - 1; x++) {
      const a = x * 4;
      const b = a + 4;
      px[x] += Math.abs(cur[b] - cur[a]) + Math.abs(cur[b + 1] - cur[a + 1]) + Math.abs(cur[b + 2] - cur[a + 2]) + Math.abs(cur[b + 3] - cur[a + 3]);
    }
    if (y > 0) {
      let s = 0;
      for (let k = 0; k < w * 4; k++) s += Math.abs(cur[k] - prev[k]);
      py[y - 1] = s;
    }
    [prev, cur] = [cur, prev];
  }
  return [px, py];
}

function estimateAxis(profile: Float64Array): AxisGrid | undefined {
  const m = profile.length;
  if (m < 16) return undefined;
  const n = m + 1;
  const pmax = Math.min(Math.max(n / 6, 4), 160);
  let mean = 0;
  for (let i = 0; i < m; i++) mean += profile[i];
  mean /= m;
  const windowed = new Float64Array(m);
  for (let i = 0; i < m; i++) windowed[i] = (profile[i] - mean) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (m - 1)));
  const spec = new Spectrum(windowed);

  const [fmin, fmax] = [1 / pmax, 1 / PMIN];
  const [k0, k1] = [spec.binCeil(fmin), spec.binFloor(fmax)];
  if (k1 <= k0) return undefined;
  // The band's maximum, the last of equals (Iterator::max_by).
  let peakK = k0;
  for (let k = k0; k <= k1; k++) if (spec.mag[k] >= spec.mag[peakK]) peakK = k;
  const amax = spec.mag[peakK];
  if (!(amax > 0)) return undefined;
  const sorted = Array.from(spec.mag.subarray(k0, k1 + 1)).sort((a, b) => a - b);
  const prominence = amax / Math.max(sorted[sorted.length >> 1], 1e-9);

  // Near-equal peaks with equal coherence are one comb seen twice (edges on
  // every 2nd or 3rd pixel mirror the spectrum): the lowest is the cell size.
  const argmaxF = peakK / spec.nFft;
  const cohMax = coherenceAt(profile, argmaxF);
  const last = spec.mag.length - 1;
  let fs = argmaxF;
  for (let k = k0; k <= k1; k++) {
    const v = spec.mag[k];
    if (!(v >= NEAR_PEAK * amax && v >= spec.mag[k - 1] && v >= spec.mag[Math.min(k + 1, last)])) continue;
    const f = k / spec.nFft;
    if (coherenceAt(profile, f) >= SUBHARMONIC_COHERENCE * cohMax) {
      fs = f;
      break;
    }
  }

  // The largest divisor d with every harmonic k * fs / d present, whose
  // coarser grid still keeps the edges on its lines.
  const floor = HARMONIC_RATIO * amax;
  const cohFs = coherenceAt(profile, fs);
  let bestD = 1;
  for (let d = 2; d <= Math.floor(fs / fmin); d++) {
    const f0 = fs / d;
    let all = true;
    for (let k = 1; k < d && all; k++) all = spec.local(k * f0) >= floor;
    if (all && coherenceAt(profile, f0) >= SUBHARMONIC_COHERENCE * cohFs) bestD = d;
  }
  const f0 = fs / bestD;

  const harmonics: number[] = [];
  for (let k = 1; k <= 8; k++) if (k * f0 < 0.5 && spec.local(k * f0) >= floor) harmonics.push(k);
  const score = (fr: number) => {
    let s = 0;
    for (const k of harmonics) s += dftMag(windowed, k * fr);
    return s;
  };

  let [lo, hi] = [f0 - 1.5 / m, f0 + 1.5 / m];
  let bestF = f0;
  for (let it = 0; it < 6; it++) {
    const step = (hi - lo) / 32;
    let bestV = -Number.MAX_VALUE;
    for (let i = 0; i <= 32; i++) {
      const f = lo + step * i;
      const v = score(f);
      if (v > bestV) {
        bestV = v;
        bestF = f;
      }
    }
    lo = bestF - 2 * step;
    hi = bestF + 2 * step;
  }

  let period = 1 / bestF;
  // Resampled from a whole N-cell canvas: lock to exactly n / N.
  const cells = n / period;
  const whole = roundHalfAway(cells);
  if (whole >= 1 && Math.abs(cells - whole) < 0.25 && score(whole / n) >= 0.97 * score(bestF)) period = n / whole;

  const [offset, coherence] = phaseAndCoherence(profile, period);
  return { period, offset, coherence, prominence };
}

const coherenceAt = (profile: Float64Array, f: number) => phaseAndCoherence(profile, 1 / f)[1];

// Rust's rem_euclid for a positive modulus.
const remEuclid = (a: number, m: number) => {
  const r = a % m;
  return r < 0 ? r + m : r;
};

function phaseAndCoherence(profile: Float64Array, period: number): [number, number] {
  let total = 0;
  for (let i = 0; i < profile.length; i++) total += profile[i];
  if (total <= 0) return [0, 0];
  const [re, im] = dft(profile, 1 / period);
  const coherence = Math.sqrt(re * re + im * im) / total;
  const offset = remEuclid((-Math.atan2(im, re) * period) / (2 * Math.PI), period);
  return [offset, coherence];
}

// Σ sig[i] e^{-2πi f (i+1)}, by a rotating phasor.
function dft(sig: Float64Array, f: number): [number, number] {
  const w = -2 * Math.PI * f;
  const [sw, cw] = [Math.sin(w), Math.cos(w)];
  let [zr, zi] = [cw, sw];
  let re = 0;
  let im = 0;
  for (let i = 0; i < sig.length; i++) {
    re += sig[i] * zr;
    im += sig[i] * zi;
    const nr = zr * cw - zi * sw;
    zi = zr * sw + zi * cw;
    zr = nr;
    if (i % 1024 === 1023) {
      const norm = Math.sqrt(zr * zr + zi * zi);
      zr /= norm;
      zi /= norm;
    }
  }
  return [re, im];
}

const dftMag = (sig: Float64Array, f: number) => {
  const [re, im] = dft(sig, f);
  return Math.sqrt(re * re + im * im);
};

// Magnitude spectrum, zero-padded 8x for peak resolution.
class Spectrum {
  mag: Float64Array;
  nFft: number;
  m: number;
  constructor(sig: Float64Array) {
    this.m = sig.length;
    let nFft = 1;
    while (nFft < this.m * 8) nFft *= 2;
    this.nFft = nFft;
    const re = new Float64Array(nFft);
    const im = new Float64Array(nFft);
    re.set(sig);
    fft(re, im);
    this.mag = new Float64Array(nFft / 2 + 1);
    for (let k = 0; k <= nFft / 2; k++) this.mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
  }
  binCeil(f: number) {
    return Math.min(Math.ceil(f * this.nFft), this.mag.length - 1);
  }
  binFloor(f: number) {
    return Math.min(Math.floor(f * this.nFft), this.mag.length - 1);
  }
  // Peak magnitude within the main lobe around f.
  local(f: number) {
    const half = 1.5 / this.m;
    const lo = this.binCeil(Math.max(f - half, 0));
    const hi = this.binFloor(f + half);
    let v = 0;
    for (let k = lo; k <= hi; k++) v = Math.max(v, this.mag[k]);
    return v;
  }
}

// In-place iterative radix-2 FFT, as grid.rs's (its rounding, so the peaks
// land in the same bins).
function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    while (j & bit) {
      j ^= bit;
      bit >>= 1;
    }
    j |= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const [sw, cw] = [Math.sin(ang), Math.cos(ang)];
    for (let start = 0; start < n; start += len) {
      let [cr, ci] = [1, 0];
      for (let k = 0; k < len / 2; k++) {
        const a = start + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const nr = cr * cw - ci * sw;
        ci = cr * sw + ci * cw;
        cr = nr;
      }
    }
  }
}

// ---- detect/elastic.rs ----

const LATTICE = 4;
const MIN_PERIOD = 8;
const MIN_GAIN = 1.5;
const MIN_SPACING = 0.75;
const MAX_SPACING = 1.3;
const SLACK = 0.25;

// Boundaries fitted to the drawn edges on the axes where a regular grid
// drifts (hand-drawn cells jitter around the period), or undefined when the
// regular grid fits both.
export function elasticBounds(img: Image, grid: Grid): { bounds: CellBounds; adapted: [boolean, boolean] } | undefined {
  if (grid.x.period < MIN_PERIOD && grid.y.period < MIN_PERIOD) return undefined;
  const [px, py] = edgeProfiles(img);
  const regular = gridBounds(grid, img.width, img.height);
  const fx = fitAxis(px, img.width, grid.x.period, regular.x);
  const fy = fitAxis(py, img.height, grid.y.period, regular.y);
  if (!fx && !fy) return undefined;
  return { bounds: { x: fx ?? regular.x, y: fy ?? regular.y }, adapted: [!!fx, !!fy] };
}

function fitAxis(profile: Float64Array, len: number, period: number, regular: number[]): number[] | undefined {
  if (period < MIN_PERIOD || !profile.length) return undefined;
  const edges = edgeStrength(profile, len);
  const fitted = fitBoundaries(edges, len, period);
  const gain = capture(edges, fitted) / Math.max(capture(edges, regular), 1e-9);
  return gain >= MIN_GAIN ? fitted : undefined;
}

function edgeStrength(profile: Float64Array, len: number): Float64Array {
  const n = len;
  const raw = new Float64Array(n + 1);
  raw.set(profile.subarray(0, n - 1), 1);
  const e = new Float64Array(n + 1);
  for (let c = 0; c <= n; c++) {
    const left = c > 0 ? raw[c - 1] : 0;
    const right = c < n ? raw[c + 1] : 0;
    e[c] = Math.max(raw[c], 0.5 * Math.max(left, right));
  }
  const inner = Array.from(e.subarray(1, n)).sort((a, b) => a - b);
  const p90 = Math.max(inner[Math.floor((inner.length * 9) / 10)] ?? 0, 1e-9);
  for (let c = 0; c <= n; c++) e[c] /= p90;
  return e;
}

function capture(edges: Float64Array, bounds: number[]): number {
  const n = edges.length - 1;
  let total = 0;
  for (let i = 1; i < n; i++) total += edges[i];
  let hit = 0;
  for (const b of bounds) {
    const c = roundHalfAway(b);
    if (c > 0 && c < n) hit += edges[c];
  }
  return hit / Math.max(total, 1e-9);
}

// Dynamic programming over a quarter-pixel lattice: boundaries that sit on
// strong edges, each cell paying a quadratic cost for leaving the period.
function fitBoundaries(edges: Float64Array, len: number, period: number): number[] {
  const q = LATTICE;
  const n = len;
  const steps = n * LATTICE;
  const smin = Math.max(Math.floor(MIN_SPACING * period * q), 1);
  const smax = Math.max(Math.ceil(MAX_SPACING * period * q), smin + 1);
  const lambda = 1 / (SLACK * period) ** 2;
  const penalty: number[] = [];
  for (let s = smin; s <= smax; s++) penalty.push(lambda * (s / q - period) ** 2);
  const gain = (t: number) => {
    if (t === 0 || t >= steps) return 0;
    const c = Math.floor(t / LATTICE);
    const f = (t % LATTICE) / q;
    return edges[c] * (1 - f) + edges[Math.min(c + 1, n)] * f;
  };
  const size = steps + 2 * smax + 1;
  const best = new Float64Array(size).fill(-Infinity);
  const prev = new Int32Array(size).fill(-1);
  for (let j = 1; j <= smax; j++) best[j] = 0;
  for (let j = smax + 1; j < size; j++) {
    let top = -Infinity;
    let arg = -1;
    for (let k = 0, s = smin; s <= smax; k++, s++) {
      if (s > j) break;
      const v = best[j - s] - penalty[k];
      if (v > top) {
        top = v;
        arg = j - s;
      }
    }
    if (arg !== -1) {
      best[j] = top + gain(j - smax);
      prev[j] = arg;
    }
  }
  let j = size - 1;
  let jBest = -Infinity;
  for (let t = steps + smax; t < size; t++) {
    if (best[t] >= jBest) {
      jBest = best[t];
      j = t;
    }
  }
  const bounds = [(j - smax) / q];
  while (prev[j] !== -1) {
    j = prev[j];
    bounds.push((j - smax) / q);
  }
  bounds.reverse();
  const inside = (i: number) => {
    const c = (bounds[i] + bounds[i + 1]) / 2;
    return c >= 0 && c < len;
  };
  let first = -1;
  for (let i = 0; i < bounds.length - 1; i++) {
    if (inside(i)) {
      first = i;
      break;
    }
  }
  let lastI = -1;
  for (let i = bounds.length - 2; i >= 0; i--) {
    if (inside(i)) {
      lastI = i;
      break;
    }
  }
  return first >= 0 && lastI >= 0 ? bounds.slice(first, lastI + 2) : bounds;
}

// ---- snap.rs ----

// The grid's phase for a whole scale: the offset whose columns (and rows)
// collect the most Sobel edge energy.
export function findOptimalCropOffset(img: Image, scale: number): { x: number; y: number } {
  if (scale <= 1) return { x: 0, y: 0 };
  const { width: w, height: h } = img;
  const gray = toGray(img, true);
  const [px, py] = sobelProfiles(gray, w, h, 0, 0, w, h);
  return { x: bestOffset(px, scale), y: bestOffset(py, scale) };
}

function bestOffset(profile: Float64Array, scale: number): number {
  let best = 0;
  let max = -1;
  for (let offset = 0; offset < scale; offset++) {
    let score = 0;
    for (let i = offset; i < profile.length; i += scale) score += profile[i];
    if (score > max) {
      max = score;
      best = offset;
    }
  }
  return best;
}

// ---- downscale.rs ----

export type ReduceMethod = "dominant" | "median" | "mode" | "mean" | "nearest";

interface Span {
  start: number;
  end: number;
  center: number;
}

const uniformSpans = (cells: number, scale: number): Span[] =>
  Array.from({ length: cells }, (_, t) => ({ start: t * scale, end: t * scale + scale, center: t * scale + (scale >> 1) }));

// The inner region of each cell: pixels whose centres are at least a quarter
// cell from its borders (at least the centre pixel), so the blur a resample
// leaves at cell borders does not vote.
function boundSpans(bounds: number[], len: number): Span[] {
  const out: Span[] = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const [a, b] = [bounds[i], bounds[i + 1]];
    const p = b - a;
    const margin = Math.min(0.25 * p, Math.max((p - 1) / 2, 0));
    const center = Math.min(Math.max(Math.floor((a + b) / 2), 0), len - 1);
    const lo = Math.max(Math.ceil(a + margin - 0.5), 0);
    const hi = Math.min(Math.floor(b - margin - 0.5), len - 1);
    out.push(hi >= lo ? { start: lo, end: hi + 1, center } : { start: center, end: center + 1, center });
  }
  return out;
}

function reduceCells(img: Image, xs: Span[], ys: Span[], method: ReduceMethod, threshold: number, ties?: Map<number, number[]>): Image {
  if (!xs.length || !ys.length) return { width: 1, height: 1, rgba: new Uint8Array(4) };
  const tw = xs.length;
  const th = ys.length;
  const out = new Uint8Array(tw * th * 4);
  const d = img.rgba;
  const sw = img.width;
  for (let ty = 0; ty < th; ty++) {
    const row = ys[ty];
    for (let tx = 0; tx < tw; tx++) {
      const col = xs[tx];
      const o = (ty * tw + tx) * 4;
      if (method === "nearest") {
        const i = (row.center * sw + col.center) * 4;
        out.set(d.subarray(i, i + 4), o);
        continue;
      }
      const alphas: number[] = [];
      if (method === "dominant") {
        // The cell's most common opaque colour when it covers at least
        // `threshold` of them, else their mean; alpha all or nothing.
        const counts = new Map<number, number>();
        const opaque: number[] = [];
        for (let sy = row.start; sy < row.end; sy++) {
          for (let sx = col.start; sx < col.end; sx++) {
            const i = (sy * sw + sx) * 4;
            alphas.push(d[i + 3]);
            if (d[i + 3] > 128) {
              const packed = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
              counts.set(packed, (counts.get(packed) ?? 0) + 1);
              opaque.push(packed);
            }
          }
        }
        if (!opaque.length) continue;
        let dominant = 0;
        let maxCount = 0;
        for (const [c, n] of counts) {
          if (n > maxCount) {
            maxCount = n;
            dominant = c;
          }
        }
        let colour = dominant;
        if (ties && maxCount / opaque.length >= threshold) {
          const top = [...counts].filter(([, n]) => n === maxCount).map(([c]) => c);
          if (top.length > 1) ties.set(ty * tw + tx, top);
        }
        if (maxCount / opaque.length < threshold) {
          let [r, g, b] = [0, 0, 0];
          for (const c of opaque) {
            r += (c >> 16) & 0xff;
            g += (c >> 8) & 0xff;
            b += c & 0xff;
          }
          const k = opaque.length;
          colour = (Math.floor(r / k) << 16) | (Math.floor(g / k) << 8) | Math.floor(b / k);
        }
        out[o] = (colour >> 16) & 0xff;
        out[o + 1] = (colour >> 8) & 0xff;
        out[o + 2] = colour & 0xff;
        out[o + 3] = medianU8(alphas) > 128 ? 255 : 0;
        continue;
      }
      const ch: [number[], number[], number[]] = [[], [], []];
      for (let sy = row.start; sy < row.end; sy++) {
        for (let sx = col.start; sx < col.end; sx++) {
          const i = (sy * sw + sx) * 4;
          alphas.push(d[i + 3]);
          if (d[i + 3] > 128) for (let c = 0; c < 3; c++) ch[c].push(d[i + c]);
        }
      }
      const agg = method === "mode" ? modeOf : method === "mean" ? meanU8 : medianU8;
      for (let c = 0; c < 3; c++) out[o + c] = ch[c].length ? agg(ch[c]) : 0;
      out[o + 3] = medianU8(alphas);
    }
  }
  return { width: tw, height: th, rgba: out };
}

function crop(img: Image, x: number, y: number, w: number, h: number): Image {
  const out = new Uint8Array(w * h * 4);
  for (let r = 0; r < h; r++) out.set(img.rgba.subarray(((y + r) * img.width + x) * 4, ((y + r) * img.width + x + w) * 4), r * w * 4);
  return { width: w, height: h, rgba: out };
}

export const downscaleBounds = (img: Image, b: CellBounds, method: ReduceMethod, threshold = 0.15, ties?: Map<number, number[]>) =>
  reduceCells(img, boundSpans(b.x, img.width), boundSpans(b.y, img.height), method, threshold, ties);

export function downscaleWhole(img: Image, scale: number, method: ReduceMethod, threshold = 0.15, ties?: Map<number, number[]>): Image {
  if (scale <= 1) return { ...img, rgba: img.rgba.slice() };
  return reduceCells(img, uniformSpans(Math.floor(img.width / scale), scale), uniformSpans(Math.floor(img.height / scale), scale), method, threshold, ties);
}

// ---- The pipeline (pixel.js processImage) ----

export interface UnfakeOptions {
  scale?: number; // the cell size, when known (maybe fractional); detected otherwise
  method?: ReduceMethod; // default dominant
  threshold?: number; // dominant's share (default 0.15)
  alphaThreshold?: number | null; // binarize alpha here first (default 128; null keeps it)
  elastic?: boolean; // fit hand-drawn cells (default true)
  exact?: boolean; // try an exact upscale first (default true; false is unfake.js as is)
  phase?: { x: number; y: number }; // with a whole scale: where its cells start (found otherwise)
  ties?: Map<number, number[]>; // filled with the cells whose most common colours tie (for tests)
}

export interface Unfaked {
  image: Image;
  scale: number; // the cell size used, 1 when the image already is one pixel per pixel
  detected: number; // what the integer detector said
  exact?: boolean; // an exact upscale: nothing was lost
  lossyExact?: boolean; // an exact upscale saved lossily: its grid, each cell's colour by `method`
  fit: number; // the share of the source the result explains (see fitOf)
  grid?: { period: [number, number]; offset: [number, number]; cells: [number, number] };
  elastic?: [boolean, boolean]; // the axes fitted to drawn edges
  crop?: { x: number; y: number }; // the whole-scale grid's phase
}

export function binarizeAlpha(img: Image, threshold = 128): Image {
  const rgba = img.rgba.slice();
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = rgba[i] >= threshold ? 255 : 0;
  return { width: img.width, height: img.height, rgba };
}

// Alpha below 128 becomes fully transparent black, the rest fully opaque
// (utils.js finalizePixels).
export function finalizePixels(img: Image): Image {
  const rgba = img.rgba;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] < 128) rgba[i] = rgba[i + 1] = rgba[i + 2] = rgba[i + 3] = 0;
    else rgba[i + 3] = 255;
  }
  return img;
}

// The lossy pass of exactGrid, on brightness (lossy WebP and H.264 keep
// colour at half resolution, which puts every colour edge on a 2 px grid):
// more than they speckle a flat cell, well under an edge between two colours.
const LOSSY_TOLERANCE = 24;

export function unfake(src: Image, opts: UnfakeOptions = {}): Unfaked {
  const method = opts.method ?? "dominant";
  const threshold = opts.threshold ?? 0.15;
  let current = opts.alphaThreshold === null ? src : binarizeAlpha(src, opts.alphaThreshold ?? 128);
  let scale: number;
  let detected: number;
  let grid: Grid | undefined;
  let exact: Grid | undefined;
  let lossy = false;
  if (opts.scale) {
    scale = Math.max(1, opts.scale);
    detected = scale;
    if (!Number.isInteger(scale)) grid = gridForScale(current, scale);
  } else if ((exact = opts.exact === false ? undefined : exactGrid(current))) {
    scale = detected = exact.x.period;
  } else {
    // Over 8 MP, pixel.js uses the runs detector, for speed.
    detected = current.width * current.height > 8_000_000 ? runsBasedDetect(current) : tiledEdgeDetect(current);
    scale = detected;
    grid = fractionalGridDetect(current);
    if (grid) scale = (grid.x.period + grid.y.period) / 2;
    // A lossy copy of an exact upscale: where its lattice is the size the
    // estimators found, it gives the phase they can miss by a cell. Only
    // then: a lossy lattice can also be a stage of the image's making (a
    // 2x video upscale around 9 px art) rather than the art pixel.
    const near = opts.exact === false ? undefined : exactGrid(current, 0.98, LOSSY_TOLERANCE);
    if (near && Math.abs(near.x.period - scale) < 0.5) {
      exact = near;
      lossy = true;
      grid = undefined;
      scale = near.x.period;
    }
  }
  if (!grid && !Number.isInteger(scale)) scale = Math.max(1, roundHalfAway(scale));

  let fitted: ReturnType<typeof elasticBounds>;
  let phase: { x: number; y: number } | undefined = opts.phase ?? (exact && { x: exact.x.offset, y: exact.y.offset });
  if (!exact && !opts.phase && (opts.elastic ?? true) && scale >= 8) {
    let base = grid;
    if (!base) {
      phase = findOptimalCropOffset(current, scale);
      base = integerGrid(scale, phase.x, phase.y);
    }
    fitted = elasticBounds(current, base);
  }
  const gridInfo = grid && {
    period: [grid.x.period, grid.y.period] as [number, number],
    offset: [grid.x.offset, grid.y.offset] as [number, number],
    cells: [axisCells(grid.x, current.width), axisCells(grid.y, current.height)] as [number, number]
  };
  if (scale <= 1) return { image: { ...current, rgba: current.rgba.slice() }, scale: 1, detected, fit: 1 };

  let out: Image;
  let cells: CellBounds;
  if (fitted) out = downscaleBounds(current, (cells = fitted.bounds), method, threshold, opts.ties);
  else if (grid) out = downscaleBounds(current, (cells = gridBounds(grid, current.width, current.height)), method, threshold, opts.ties);
  else {
    phase ??= findOptimalCropOffset(current, scale);
    const w = Math.floor((current.width - phase.x) / scale) * scale;
    const h = Math.floor((current.height - phase.y) / scale) * scale;
    if (w >= scale && h >= scale) current = crop(current, phase.x, phase.y, w, h);
    else phase = { x: 0, y: 0 };
    out = downscaleWhole(current, scale, method, threshold, opts.ties);
    const lattice = (n: number) => Array.from({ length: Math.floor(n / scale) + 1 }, (_, i) => i * scale);
    cells = { x: lattice(current.width), y: lattice(current.height) };
  }
  out = finalizePixels(out);
  return {
    image: out,
    scale,
    detected,
    fit: fitOf(current, out, cells),
    ...(exact ? (lossy ? { lossyExact: true } : { exact: true }) : {}),
    ...(gridInfo ? { grid: gridInfo } : {}),
    ...(fitted ? { elastic: fitted.adapted } : {}),
    ...(!grid && !fitted && phase ? { crop: phase } : {})
  };
}

// How much of the source the result explains: the share of its pixels
// (other than ones transparent in both) that the result, drawn back at the
// cells' size, shows within 32 per channel, transparent where they are.
// Near 1 for an upscale (exactly 1 for an exact one); pixel art at its own
// size read as an upscale scores far lower.
export function fitOf(src: Image, out: Image, cells: CellBounds): number {
  const index = (bounds: number[], len: number) => {
    const at = new Int32Array(len).fill(-1);
    for (let i = 0; i + 1 < bounds.length; i++) {
      for (let p = Math.max(0, Math.ceil(bounds[i] - 0.5)); p < Math.min(len, Math.ceil(bounds[i + 1] - 0.5)); p++) at[p] = i;
    }
    return at;
  };
  const xs = index(cells.x, src.width);
  const ys = index(cells.y, src.height);
  let seen = 0;
  let good = 0;
  for (let y = 0; y < src.height; y++) {
    if (ys[y] < 0 || ys[y] >= out.height) continue;
    for (let x = 0; x < src.width; x++) {
      if (xs[x] < 0 || xs[x] >= out.width) continue;
      const i = (y * src.width + x) * 4;
      const o = (ys[y] * out.width + xs[x]) * 4;
      const a = src.rgba[i + 3] > 127;
      const b = out.rgba[o + 3] > 127;
      if (!a && !b) continue;
      seen++;
      if (a && b && Math.abs(src.rgba[i] - out.rgba[o]) <= 32 && Math.abs(src.rgba[i + 1] - out.rgba[o + 1]) <= 32 && Math.abs(src.rgba[i + 2] - out.rgba[o + 2]) <= 32) good++;
    }
  }
  return seen ? good / seen : 1;
}
