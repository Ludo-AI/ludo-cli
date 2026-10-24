import { fft2d, nextPow2 } from "./fft.js";

// The OpenCV operations the ML service's aligner uses (align.ts), on plain
// arrays, matched against opencv-python 5.0.0 (imgproc's resize.cpp,
// imgwarp.cpp and warp_kernels.simd.hpp, morph.dispatch.cpp, templmatch.cpp,
// connectedcomponents.cpp). Masks are Uint8Array, 0 or 1, row-major.

/** cvRound and Python's round(): to the nearest integer, ties to even. */
export function roundEven(v: number): number {
  const r = Math.round(v);
  return r - v === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** cv2.resize with INTER_NEAREST: source x = floor(x * (1 / (dst / src))). */
export function resizeNearestMask(mask: Uint8Array, w: number, h: number, tw: number, th: number): Uint8Array {
  const out = new Uint8Array(tw * th);
  const ifx = 1 / (tw / w);
  const ify = 1 / (th / h);
  const xs = new Int32Array(tw);
  for (let x = 0; x < tw; x++) xs[x] = Math.min(Math.floor(x * ifx), w - 1);
  for (let y = 0; y < th; y++) {
    const sy = Math.min(Math.floor(y * ify), h - 1);
    for (let x = 0; x < tw; x++) out[y * tw + x] = mask[sy * w + xs[x]];
  }
  return out;
}

/**
 * cv2.warpAffine with INTER_NEAREST and a constant 0 border, for a matrix
 * [[m0, m1, m2], [m3, m4, m5]] given as float32 (as the ML passes it).
 * Without `inverse` the matrix maps source to destination and is inverted in
 * double first, as warpAffine does. The kernel then works in float32:
 * per row, y * M1 + M2 and y * M4 + M5 fused; per pixel fma(M0, x, row) in
 * the SIMD loop and separately rounded products in the scalar tail (the last
 * width % 8 columns on a 128-bit SIMD build); then cvRound.
 */
export function warpAffineNearest(src: Uint8Array, w: number, h: number, matrix: number[], tw: number, th: number, inverse: boolean): Uint8Array {
  const f = Math.fround;
  let M = matrix.map(f);
  if (!inverse) {
    let D = M[0] * M[4] - M[1] * M[3];
    D = D !== 0 ? 1 / D : 0;
    const [A11, A22] = [M[4] * D, M[0] * D];
    M = [A11, M[1] * -D, 0, M[3] * -D, A22, 0];
    const [m2, m5] = [matrix[2], matrix[5]].map(f);
    M[2] = -M[0] * m2 - M[1] * m5;
    M[5] = -M[3] * m2 - M[4] * m5;
  }
  const m = M.map(f);
  const out = new Uint8Array(tw * th);
  const simdEnd = tw - (tw % 8);
  for (let y = 0; y < th; y++) {
    const rowX = f(y * m[1] + m[2]);
    const rowY = f(y * m[4] + m[5]);
    for (let x = 0; x < tw; x++) {
      let sx: number;
      let sy: number;
      if (x < simdEnd) {
        sx = f(m[0] * x + rowX);
        sy = f(m[3] * x + rowY);
      } else {
        sx = f(f(f(x * m[0]) + f(y * m[1])) + m[2]);
        sy = f(f(f(x * m[3]) + f(y * m[4])) + m[5]);
      }
      const ix = roundEven(sx);
      const iy = roundEven(sy);
      if (ix >= 0 && ix < w && iy >= 0 && iy < h) out[y * tw + x] = src[iy * w + ix];
    }
  }
  return out;
}

/** cv2.getStructuringElement(MORPH_ELLIPSE, (2r + 1, 2r + 1)): each row's half-width. */
function ellipseRows(r: number): Int32Array {
  const rows = new Int32Array(2 * r + 1);
  for (let i = 0; i <= 2 * r; i++) {
    const dy = i - r;
    rows[i] = roundEven(r * Math.sqrt((r * r - dy * dy) / (r * r)));
  }
  return rows;
}

/** cv2.dilate of a 0/1 mask by an ellipse of radius r (the border never adds). */
export function dilateEllipse(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const rows = ellipseRows(r);
  // Per row, a prefix count of set pixels, so a span test is O(1).
  const prefix = new Int32Array((w + 1) * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) prefix[y * (w + 1) + x + 1] = prefix[y * (w + 1) + x] + mask[y * w + x];
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let i = 0; i <= 2 * r; i++) {
        const sy = y + i - r;
        if (sy < 0 || sy >= h) continue;
        const x0 = Math.max(0, x - rows[i]);
        const x1 = Math.min(w, x + rows[i] + 1);
        if (prefix[sy * (w + 1) + x1] - prefix[sy * (w + 1) + x0] > 0) {
          out[y * w + x] = 1;
          break;
        }
      }
    }
  }
  return out;
}

/**
 * The ML's _clean_mask: cv2.connectedComponentsWithStats with 8-connectivity,
 * keeping the components of at least min_fraction of the largest one's area.
 */
export function cleanMask(mask: Uint8Array, w: number, h: number, minFraction: number): Uint8Array {
  const label = new Int32Array(w * h).fill(-1);
  const areas: number[] = [];
  const stack: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || label[i] >= 0) continue;
    const id = areas.length;
    let area = 0;
    label[i] = id;
    stack.push(i);
    while (stack.length) {
      const p = stack.pop() as number;
      area++;
      const [px, py] = [p % w, Math.floor(p / w)];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const [nx, ny] = [px + dx, py + dy];
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const q = ny * w + nx;
          if (mask[q] && label[q] < 0) {
            label[q] = id;
            stack.push(q);
          }
        }
      }
    }
    areas.push(area);
  }
  if (areas.length <= 1) return mask;
  const threshold = Math.max(...areas) * minFraction;
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) if (label[i] >= 0 && areas[label[i]] >= threshold) out[i] = 1;
  return out;
}

/** Population standard deviation, as numpy's ndarray.std(). */
function std(a: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  const mean = s / a.length;
  let v = 0;
  for (let i = 0; i < a.length; i++) v += (a[i] - mean) ** 2;
  return Math.sqrt(v / a.length);
}

// The rectangle around a grey image's non-zero pixels.
function nonZeroBox(g: Float32Array, w: number, h: number) {
  let [x0, y0, x1, y1] = [w, h, -1, -1];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (g[y * w + x] !== 0) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

export interface Template {
  gray: Float32Array;
  width: number;
  height: number;
}

export interface Match {
  dx: number;
  dy: number;
  confidence: number;
}

// The source's spectrum, kept for the next call at the same transform size
// (the ternary search matches one source up to 15 times).
const spectra = new WeakMap<Float32Array, { fw: number; fh: number; re: Float64Array; im: Float64Array }>();

/**
 * The ML's _ncc_match for each template against one source: the template
 * slid over the source padded on every side by the template's size, scored
 * by cv2.matchTemplate's TM_CCOEFF_NORMED, and the first best position
 * (cv2.minMaxLoc's, row by row). Each result is the template's top-left in
 * the source and the score, or null when either image is flat (std under
 * 1e-6).
 *
 * TM_CCOEFF_NORMED at each window: num = sum(T * I) - mean(T) * sum(I) and
 * t = sqrt(max(sum(I^2) - sum(I)^2 / n, 0)) * sqrt(sum((T - mean(T))^2)); the
 * score is num / t when |num| < t, the sign of num when |num| < 1.125 t, else
 * 0; stored as float32 (templmatch.cpp's common_matchTemplate). sum(T * I)
 * is a cross-correlation, done here by FFT over only the non-zero boxes of T
 * and of the source: elsewhere it is 0, so num <= 0 there and no window
 * outside can score above one inside. Where no window scores above 0, the
 * best is 0 at the first window, entirely in the padding. Templates go
 * through the transforms two at a time, as the real and imaginary parts of
 * one complex image.
 */
export function nccMatchAll(src: Float32Array, w1: number, h1: number, templates: Template[]): (Match | null)[] {
  const results: (Match | null)[] = templates.map(() => null);
  const sb = nonZeroBox(src, w1, h1);
  // Window sums of I and I^2 by integral images of the source.
  const W = w1 + 1;
  const i1 = new Float64Array(W * (h1 + 1));
  const i2 = new Float64Array(W * (h1 + 1));
  let s = 0;
  for (let y = 0; y < h1; y++) {
    let r1 = 0;
    let r2 = 0;
    for (let x = 0; x < w1; x++) {
      const p = src[y * w1 + x];
      s += p;
      r1 += p;
      r2 += p * p;
      i1[(y + 1) * W + x + 1] = i1[y * W + x + 1] + r1;
      i2[(y + 1) * W + x + 1] = i2[y * W + x + 1] + r2;
    }
  }

  // Which templates are matched, and their boxes.
  const live: { k: number; t: Template; tb: NonNullable<ReturnType<typeof nonZeroBox>>; tMean: number; tNorm: number }[] = [];
  templates.forEach((t, k) => {
    if (std(t.gray) < 1e-6) return;
    // The padded source holds the same values plus zeros.
    const nPad = (w1 + 2 * t.width) * (h1 + 2 * t.height);
    const mean = s / nPad;
    let v = (nPad - src.length) * mean * mean;
    for (let i = 0; i < src.length; i++) v += (src[i] - mean) ** 2;
    if (Math.sqrt(v / nPad) < 1e-6) return;
    const tb = nonZeroBox(t.gray, t.width, t.height);
    if (!sb || !tb) {
      results[k] = { dx: -t.width, dy: -t.height, confidence: 0 };
      return;
    }
    const n = t.width * t.height;
    let tSum = 0;
    let tSq = 0;
    for (let i = 0; i < n; i++) {
      tSum += t.gray[i];
      tSq += t.gray[i] * t.gray[i];
    }
    const tMean = tSum / n;
    live.push({ k, t, tb, tMean, tNorm: Math.sqrt(Math.max(tSq - n * tMean * tMean, 0)) });
  });
  if (!live.length || !sb) return results;

  // One transform size for all, to share the source's spectrum.
  const fw = nextPow2(sb.w + Math.max(...live.map(l => l.tb.w)) - 1);
  const fh = nextPow2(sb.h + Math.max(...live.map(l => l.tb.h)) - 1);
  let S = spectra.get(src);
  if (!S || S.fw !== fw || S.fh !== fh) {
    const re = new Float64Array(fw * fh);
    const im = new Float64Array(fw * fh);
    for (let y = 0; y < sb.h; y++) for (let x = 0; x < sb.w; x++) re[y * fw + x] = src[(sb.y0 + y) * w1 + sb.x0 + x];
    fft2d(re, im, fw, fh, false, sb.h);
    S = { fw, fh, re, im };
    spectra.set(src, S);
  }

  for (let p = 0; p < live.length; p += 2) {
    const [a, b] = [live[p], live[p + 1]];
    // Z = Ta + i Tb; F(Ta)[k] = (Z[k] + conj(Z[-k])) / 2, F(Tb)[k] = (Z[k] - conj(Z[-k])) / 2i.
    const zr = new Float64Array(fw * fh);
    const zi = new Float64Array(fw * fh);
    for (const [l, part] of [[a, zr], [b, zi]] as const) {
      if (!l) continue;
      for (let y = 0; y < l.tb.h; y++) for (let x = 0; x < l.tb.w; x++) part[y * fw + x] = l.t.gray[(l.tb.y0 + y) * l.t.width + l.tb.x0 + x];
    }
    fft2d(zr, zi, fw, fh, false, Math.max(a.tb.h, b ? b.tb.h : 0));
    // Each correlation's spectrum is F(S) conj(F(T)); Q = Pa + i Pb.
    const qr = new Float64Array(fw * fh);
    const qi = new Float64Array(fw * fh);
    for (let ky = 0; ky < fh; ky++) {
      for (let kx = 0; kx < fw; kx++) {
        const k = ky * fw + kx;
        const j = ((fh - ky) % fh) * fw + ((fw - kx) % fw);
        const [sr, si] = [S.re[k], S.im[k]];
        const ar = (zr[k] + zr[j]) / 2;
        const ai = (zi[k] - zi[j]) / 2;
        const br = (zi[k] + zi[j]) / 2;
        const bi = -(zr[k] - zr[j]) / 2;
        const par = sr * ar + si * ai;
        const pai = si * ar - sr * ai;
        const pbr = sr * br + si * bi;
        const pbi = si * br - sr * bi;
        qr[k] = par - pbi;
        qi[k] = pai + pbr;
      }
    }
    fft2d(qr, qi, fw, fh, true);
    for (const [l, part] of [[a, qr], [b, qi]] as const) if (l) results[l.k] = best(l, part);
  }
  return results;

  // The best window for one template, from its correlation.
  function best(l: (typeof live)[number], corr: Float64Array): Match {
    const { t, tb, tMean, tNorm } = l;
    const [w2, h2] = [t.width, t.height];
    const n = w2 * h2;
    const sbox = sb as NonNullable<typeof sb>;
    const rect = (ii: Float64Array, dx: number, dy: number) => {
      const [x0, y0] = [Math.max(0, dx), Math.max(0, dy)];
      const [x1, y1] = [Math.min(w1, dx + w2), Math.min(h1, dy + h2)];
      if (x1 <= x0 || y1 <= y0) return 0;
      return ii[y1 * W + x1] - ii[y0 * W + x1] - ii[y1 * W + x0] + ii[y0 * W + x0];
    };
    const norm = fw * fh;
    let out: Match = { dx: -w2, dy: -h2, confidence: 0 };
    // Shifts of the template's top-left in the source where the two boxes
    // overlap, in minMaxLoc's order: dy, then dx. corr holds
    // sum T(t) S(t + e) at e = (template box) - (source box) + shift.
    for (let dy = sbox.y0 - tb.y0 - (tb.h - 1); dy <= sbox.y0 + sbox.h - 1 - tb.y0; dy++) {
      const ey = dy + tb.y0 - sbox.y0;
      const ry = ((ey % fh) + fh) % fh;
      for (let dx = sbox.x0 - tb.x0 - (tb.w - 1); dx <= sbox.x0 + sbox.w - 1 - tb.x0; dx++) {
        const ex = dx + tb.x0 - sbox.x0;
        const rx = ((ex % fw) + fw) % fw;
        const s1 = rect(i1, dx, dy);
        const s2 = rect(i2, dx, dy);
        let num = corr[ry * fw + rx] / norm - tMean * s1;
        const thr = Math.sqrt(Math.max(s2 - (s1 * s1) / n, 0)) * tNorm;
        if (Math.abs(num) < thr) num /= thr;
        else if (Math.abs(num) < thr * 1.125) num = num > 0 ? 1 : -1;
        else num = 0;
        const score = Math.fround(num);
        if (score > out.confidence) out = { dx, dy, confidence: score };
      }
    }
    return out;
  }
}
