import type { Image } from "../tty/png.js";
import type { Background } from "./grid.js";

// Does an animation loop, and if not, where inside it does one close?
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
//   that is checked on its own (whole cycles excepted).
//
// The thresholds are ours, picked on the fixtures in test/toolbox.test.mjs
// and checked with scripts/loop-eval.mjs on real sheets damaged in known ways.

export const SAME = 0.25; // under a quarter of a step: the same frame
export const SMOOTH = 1.5; // a seam up to 1.5 steps plays as smooth
const JUMP = 2; // an adjacent step over twice the typical one is a jump
const MATCH = 0.5; // a trimmed loop is offered when its cost is at most this
const BETTER = 0.25; // and over a seam that already plays, only when this much better
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
  // The best loop inside the frames (1-based, inclusive); the whole sheet when
  // it already loops, none when no run of frames loops cleanly. cost: 0 = a
  // perfect match, 1 = off by a whole step.
  best: { start: number; end: number; frames: number; cost: number; seam: number } | undefined;
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

export function analyseLoop(D: Float64Array[], minFrames = Math.ceil(D.length / 2)): LoopReport {
  const n = D.length;
  const adjacent = Array.from({ length: n - 1 }, (_, i) => D[i][i + 1]);
  const { step, isHold } = typicalStep(D);
  const matrix = D.map(row => Array.from(row, d => round(step ? d / step : 0)));
  if (n < 2 || step === 0) {
    return {
      frames: n,
      steps: [],
      holds: [],
      jumps: [],
      seam: { ratio: 0, verdict: "static", repeats: 0 },
      mirrored: false,
      best: n ? { start: 1, end: n, frames: n, cost: 0, seam: 0 } : undefined,
      matrix
    };
  }
  const r = (i: number, j: number) => D[i][j] / step;
  // A step that can vouch for a tap: it moves, and not by a jump. A big but
  // ordinary step still can: AI motion is uneven, and without the tap a
  // seam is judged on its size alone.
  const ordinary = (i: number) => i >= 0 && i < n - 1 && !isHold(adjacent[i]) && adjacent[i] <= JUMP * step;
  // A seam that lands behind where it left from: frame s is nearer e - 1
  // than e, or s + 1 is nearer e than s is. It steps backwards and then shows
  // a pose again, a stutter however small the seam measures, so a trimmed
  // loop should end one frame earlier, or start one later, instead.
  const backwards = (s: number, e: number) => {
    const ratio = r(e, s);
    return (s + 1 < e && r(e, s + 1) < ratio) || (e - 1 > s && r(e - 1, s) < ratio);
  };
  // Up to one step is right (motion often eases into the loop point); much
  // more is a jump, and next to nothing is a pose shown twice.
  const seamCost = (e: number, s: number) => {
    const ratio = r(e, s);
    return ratio < SAME ? 1 : Math.max(0, ratio - 1);
  };
  // A loop over frames s..e runs past its loop point when its last k frames
  // are its first k again: it shows them twice, and its seam can look like an
  // ordinary step while it steps backwards. Not when every frame is the one k
  // later too: then it is whole cycles, which loop. Returns k, or 0.
  const twins = D.map((_, s) => {
    const later: number[] = [];
    for (let j = n - 1; j > s; j--) if (r(j, s) < SAME) later.push(j);
    return later; // latest first, so the shortest overlap is found first
  });
  const overlap = (s: number, e: number) => {
    for (const j of twins[s]) {
      if (j > e) continue;
      const k = e - j + 1;
      let all = true;
      for (let i = 1; i < k && all; i++) all = r(j + i, s + i) < SAME;
      if (!all) continue;
      let cycles = true;
      for (let i = s; i + k <= e && cycles; i++) cycles = r(i, i + k) < SAME;
      return cycles ? 0 : k;
    }
    return 0;
  };
  // The cost of a loop over frames s..e (0-based), jumping from e back to s.
  // A last frame reached by a jump is what a glitch usually looks like; a
  // loop that keeps it is suspect however well it closes.
  const glitchAtEnd = n > 2 && adjacent[n - 2] > SMOOTH * step;
  const cost = (s: number, e: number) => {
    if (overlap(s, e) || (glitchAtEnd && e === n - 1)) return 1;
    const taps: number[] = [];
    if (e + 1 < n && ordinary(e)) taps.push(r(e + 1, s));
    if (s > 0 && ordinary(s - 1)) taps.push(r(e, s - 1));
    if (taps.length) return taps.reduce((a, b) => a + b, 0) / taps.length;
    return backwards(s, e) ? 1 : seamCost(e, s);
  };

  const seamRatio = r(n - 1, 0);
  const repeats = overlap(0, n - 1);
  const verdict = repeats ? "repeat" : seamRatio <= SMOOTH ? "smooth" : "jump";
  const asIs = repeats ? 1 : seamCost(n - 1, 0);

  // Longest first, so a shorter loop has to be clearly better to win.
  const min = Math.max(2, Math.min(minFrames, n - 1));
  let found: { s: number; e: number; c: number } | undefined;
  for (let len = n - 1; len >= min; len--) {
    for (let s = 0; s + len <= n; s++) {
      const c = cost(s, s + len - 1);
      if (!found || c < found.c - 0.05) found = { s, e: s + len - 1, c };
    }
  }
  // A sheet that already loops keeps all its frames unless a loop inside it
  // is clearly better.
  const inside = found && found.c <= MATCH && (verdict !== "smooth" || found.c + BETTER < asIs) ? found : undefined;
  const best: LoopReport["best"] = inside
    ? { start: inside.s + 1, end: inside.e + 1, frames: inside.e - inside.s + 1, cost: round(inside.c), seam: round(r(inside.e, inside.s)) }
    : verdict === "smooth"
      ? { start: 1, end: n, frames: n, cost: round(asIs), seam: round(seamRatio) }
      : undefined;

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
    best,
    matrix
  };
}
