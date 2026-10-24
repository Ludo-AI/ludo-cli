import type { Image } from "../tty/png.js";

// Resizing to any size, for the pack and sequence exporters.
//
// nearest: each output pixel takes the source pixel under its centre,
//   floor((x + 0.5) * in / out): what a canvas draws with smoothing off,
//   and Pillow's NEAREST.
// smooth: Pillow's separable convolution resampler (libImaging/Resample.c),
//   on premultiplied alpha so transparent pixels do not bleed their colour
//   into edges. An axis that shrinks uses the box filter (area averaging); one
//   that grows uses Keys' bicubic with a = -0.5 (Keys 1981, Pillow's BICUBIC).
//   Each pass rounds to 8 bits, as Pillow does.

export function resizeNearest(img: Image, width: number, height: number): Image {
  const rgba = new Uint8Array(width * height * 4);
  const xs = new Int32Array(width);
  for (let x = 0; x < width; x++) xs[x] = Math.min(img.width - 1, Math.floor(((x + 0.5) * img.width) / width));
  for (let y = 0; y < height; y++) {
    const sy = Math.min(img.height - 1, Math.floor(((y + 0.5) * img.height) / height));
    for (let x = 0; x < width; x++) {
      const i = (sy * img.width + xs[x]) * 4;
      rgba.set(img.rgba.subarray(i, i + 4), (y * width + x) * 4);
    }
  }
  return { width, height, rgba };
}

const box = (x: number) => (x > -0.5 && x <= 0.5 ? 1 : 0);

const bicubic = (x: number) => {
  const a = -0.5;
  x = Math.abs(x);
  if (x < 1) return ((a + 2) * x - (a + 3)) * x * x + 1;
  if (x < 2) return (((x - 5) * x + 8) * x - 4) * a;
  return 0;
};

// For each output pixel along one axis: the first input pixel it reads and
// the weights of the ones from there (Pillow's precompute_coeffs).
function coefficients(inSize: number, outSize: number) {
  const scale = inSize / outSize;
  const [filter, support0] = scale > 1 ? [box, 0.5] : [bicubic, 2];
  const filterscale = Math.max(1, scale);
  const support = support0 * filterscale;
  const ss = 1 / filterscale;
  const starts = new Int32Array(outSize);
  const weights: Float64Array[] = [];
  for (let xx = 0; xx < outSize; xx++) {
    const center = (xx + 0.5) * scale;
    const xmin = Math.max(0, Math.trunc(center - support + 0.5));
    const xmax = Math.min(inSize, Math.trunc(center + support + 0.5)) - xmin;
    const k = new Float64Array(Math.max(0, xmax));
    let ww = 0;
    for (let x = 0; x < xmax; x++) {
      k[x] = filter((x + xmin - center + 0.5) * ss);
      ww += k[x];
    }
    if (ww !== 0) for (let x = 0; x < xmax; x++) k[x] /= ww;
    starts[xx] = xmin;
    weights.push(k);
  }
  return { starts, weights };
}

const clip8 = (v: number) => (v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v));

// One axis of the convolution over premultiplied RGBA.
function pass(src: Uint8Array, w: number, h: number, outW: number, outH: number, horizontal: boolean): Uint8Array {
  const out = new Uint8Array(outW * outH * 4);
  const { starts, weights } = coefficients(horizontal ? w : h, horizontal ? outW : outH);
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const k = weights[horizontal ? x : y];
      const start = starts[horizontal ? x : y];
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let t = 0; t < k.length; t++) {
        const i = horizontal ? (y * w + start + t) * 4 : ((start + t) * w + x) * 4;
        r += src[i] * k[t];
        g += src[i + 1] * k[t];
        b += src[i + 2] * k[t];
        a += src[i + 3] * k[t];
      }
      const o = (y * outW + x) * 4;
      out[o] = clip8(r);
      out[o + 1] = clip8(g);
      out[o + 2] = clip8(b);
      out[o + 3] = clip8(a);
    }
  }
  return out;
}

// Pillow's Image.resize on RGBA, to the byte, for the aligner (align.ts),
// which must see what the ML service's Pillow sees: RGBA converted to
// premultiplied RGBa (Convert.c rgbA2rgba), Resample.c's two passes in its
// 8-bit fixed point (horizontal first, each rounded to 8 bits), and back with
// rgba2rgbA's truncating divide.
export type PillowFilter = "bilinear" | "bicubic" | "lanczos";

const sinc = (x: number) => {
  if (x === 0) return 1;
  x *= Math.PI;
  return Math.sin(x) / x;
};
const PILLOW_FILTERS: Record<PillowFilter, [(x: number) => number, number]> = {
  bilinear: [x => (x < 0 ? -x : x) < 1 ? 1 - (x < 0 ? -x : x) : 0, 1],
  bicubic: [bicubic, 2],
  lanczos: [x => (x > -3 && x < 3 ? sinc(x) * sinc(x / 3) : 0), 3],
};
const PRECISION_BITS = 32 - 8 - 2;
const ONE = 2 ** PRECISION_BITS;

// precompute_coeffs + normalize_coeffs_8bpc.
function fixedCoefficients(inSize: number, outSize: number, filterName: PillowFilter) {
  const [filter, support0] = PILLOW_FILTERS[filterName];
  const scale = inSize / outSize;
  const filterscale = Math.max(1, scale);
  const support = support0 * filterscale;
  const ss = 1 / filterscale;
  const starts = new Int32Array(outSize);
  const weights: Int32Array[] = [];
  for (let xx = 0; xx < outSize; xx++) {
    const center = (xx + 0.5) * scale;
    const xmin = Math.max(0, Math.trunc(center - support + 0.5));
    const xmax = Math.min(inSize, Math.trunc(center + support + 0.5)) - xmin;
    const k = new Float64Array(Math.max(0, xmax));
    let ww = 0;
    for (let x = 0; x < xmax; x++) {
      k[x] = filter((x + xmin - center + 0.5) * ss);
      ww += k[x];
    }
    const kk = new Int32Array(k.length);
    for (let x = 0; x < k.length; x++) {
      const w = ww !== 0 ? k[x] / ww : k[x];
      kk[x] = Math.trunc(w < 0 ? -0.5 + w * ONE : 0.5 + w * ONE);
    }
    starts[xx] = xmin;
    weights.push(kk);
  }
  return { starts, weights };
}

function fixedPass(src: Uint8Array, w: number, h: number, outW: number, outH: number, horizontal: boolean, filter: PillowFilter): Uint8Array {
  const out = new Uint8Array(outW * outH * 4);
  const { starts, weights } = fixedCoefficients(horizontal ? w : h, horizontal ? outW : outH, filter);
  const clip = (v: number) => {
    const s = Math.floor(v / ONE);
    return s < 0 ? 0 : s > 255 ? 255 : s;
  };
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const k = weights[horizontal ? x : y];
      const start = starts[horizontal ? x : y];
      let [r, g, b, a] = [ONE / 2, ONE / 2, ONE / 2, ONE / 2];
      for (let t = 0; t < k.length; t++) {
        const i = horizontal ? (y * w + start + t) * 4 : ((start + t) * w + x) * 4;
        r += src[i] * k[t];
        g += src[i + 1] * k[t];
        b += src[i + 2] * k[t];
        a += src[i + 3] * k[t];
      }
      const o = (y * outW + x) * 4;
      out[o] = clip(r);
      out[o + 1] = clip(g);
      out[o + 2] = clip(b);
      out[o + 3] = clip(a);
    }
  }
  return out;
}

export function resizePillow(img: Image, width: number, height: number, filter: PillowFilter): Image {
  if (width === img.width && height === img.height) return { width, height, rgba: img.rgba.slice() };
  // rgbA2rgba: MULDIV255, which is c * a / 255 rounded.
  let data: Uint8Array = new Uint8Array(img.rgba.length);
  for (let i = 0; i < data.length; i += 4) {
    const a = img.rgba[i + 3];
    for (let c = 0; c < 3; c++) {
      const t = img.rgba[i + c] * a + 128;
      data[i + c] = ((t >> 8) + t) >> 8;
    }
    data[i + 3] = a;
  }
  let [w, h] = [img.width, img.height];
  // ImagingResampleInner: the vertical pass goes first when the height
  // shrinks by more than twice as many pixels as the width does.
  const horizontalFirst = !(h - height > 0 && h - height > (w - width) * 2);
  const horizontal = () => {
    if (width !== w) data = fixedPass(data, w, h, width, h, true, filter);
    w = width;
  };
  const vertical = () => {
    if (height !== h) data = fixedPass(data, w, h, w, height, false, filter);
    h = height;
  };
  if (horizontalFirst) {
    horizontal();
    vertical();
  } else {
    vertical();
    horizontal();
  }
  // rgba2rgbA: 255 * c / a, truncated; alpha 0 and 255 copy as they are.
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a === 0 || a === 255) continue;
    for (let c = 0; c < 3; c++) data[i + c] = Math.min(255, Math.trunc((255 * data[i + c]) / a));
  }
  return { width, height, rgba: data };
}

export function resizeSmooth(img: Image, width: number, height: number): Image {
  // Premultiply: c * a / 255, rounded.
  let data: Uint8Array = new Uint8Array(img.rgba.length);
  for (let i = 0; i < data.length; i += 4) {
    const a = img.rgba[i + 3];
    data[i] = Math.round((img.rgba[i] * a) / 255);
    data[i + 1] = Math.round((img.rgba[i + 1] * a) / 255);
    data[i + 2] = Math.round((img.rgba[i + 2] * a) / 255);
    data[i + 3] = a;
  }
  let [w, h] = [img.width, img.height];
  if (width !== w) {
    data = pass(data, w, h, width, h, true);
    w = width;
  }
  if (height !== h) {
    data = pass(data, w, h, w, height, false);
    h = height;
  }
  // Back to straight alpha. A colour above its alpha (bicubic overshoot)
  // clips to full intensity.
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    for (let c = 0; c < 3; c++) data[i + c] = a ? Math.min(255, Math.round((data[i + c] * 255) / a)) : 0;
  }
  return { width, height, rgba: data };
}
