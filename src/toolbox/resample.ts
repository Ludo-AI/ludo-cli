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
