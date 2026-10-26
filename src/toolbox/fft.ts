// The 2-D discrete Fourier transform, for cross-correlating images
// (cv.ts's matchTemplate), and the 1-D one, for the audio tools' spectra
// (audio.ts's tempo). Iterative radix-2 Cooley-Tukey (Cooley & Tukey
// 1965; the in-place, bit-reversed form of Numerical Recipes 12.2) on
// separate real and imaginary arrays, rows then columns. Sizes must be powers
// of two. inverse computes the unnormalized inverse; divide by w * h.

const tables = new Map<number, { rev: Uint32Array; cos: Float64Array; sin: Float64Array }>();

function table(n: number) {
  let t = tables.get(n);
  if (!t) {
    const bits = Math.log2(n);
    const rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      rev[i] = r;
    }
    const cos = new Float64Array(n / 2);
    const sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      cos[i] = Math.cos((2 * Math.PI * i) / n);
      sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
    t = { rev, cos, sin };
    tables.set(n, t);
  }
  return t;
}

/** One in-place transform of length n (a power of two) over re/im. */
export function fft1d(re: Float64Array, im: Float64Array, n: number, inverse: boolean) {
  const { rev, cos, sin } = table(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  const sign = inverse ? 1 : -1;
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step];
        const wi = sign * sin[k * step];
        const a = start + k;
        const b = a + half;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
      }
    }
  }
}

export const nextPow2 = (n: number) => 2 ** Math.ceil(Math.log2(Math.max(1, n)));

// Blocked, so both sides stay in cache.
function transpose(src: Float64Array, dst: Float64Array, w: number, h: number) {
  const B = 32;
  for (let y0 = 0; y0 < h; y0 += B) {
    for (let x0 = 0; x0 < w; x0 += B) {
      const [y1, x1] = [Math.min(h, y0 + B), Math.min(w, x0 + B)];
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) dst[x * h + y] = src[y * w + x];
    }
  }
}

function rows(re: Float64Array, im: Float64Array, w: number, h: number, inverse: boolean) {
  for (let y = 0; y < h; y++) fft1d(re.subarray(y * w, (y + 1) * w), im.subarray(y * w, (y + 1) * w), w, inverse);
}

/**
 * In place over a w x h complex image (row-major); w and h powers of two.
 * Rows from `nonZeroRows` on must be zero: their first pass is skipped.
 */
export function fft2d(re: Float64Array, im: Float64Array, w: number, h: number, inverse = false, nonZeroRows = h) {
  rows(re, im, w, Math.min(h, nonZeroRows), inverse);
  const tr = new Float64Array(w * h);
  const ti = new Float64Array(w * h);
  transpose(re, tr, w, h);
  transpose(im, ti, w, h);
  rows(tr, ti, h, w, inverse);
  transpose(tr, re, h, w);
  transpose(ti, im, h, w);
}

/** In place over one complex signal of power-of-two length (the audio tools' spectra). */
export function fft(re: Float64Array, im: Float64Array, inverse = false) {
  fft1d(re, im, re.length, inverse);
}
