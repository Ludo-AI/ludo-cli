import type { Image } from "../tty/png.js";

// Normal maps for pixel art, ported from Sprite Fusion Sprite Normals 0.1.0
// (https://github.com/hugo-dz/spritefusion-sprite-normals, commit d14b067),
// by Hugo Duprez: src/lib.rs, relief.rs, field.rs, distance.rs,
// components.rs, color.rs and settings.rs.
//
// Each island of the art (8-connected pixels over the alpha threshold) is
// lifted on its own, on a canvas padded so every blur and slope stays
// inside it. Its height is the sum of
//  - a shape term: the exact Euclidean distance to the outside
//    (Felzenszwalb-Huttenlocher lower envelopes of parabolas), inset by half
//    a pixel and eased by strength * radius * ln(1 + inset / radius), then
//    blurred by the shape softness;
//  - a detail term: the painted shading's Oklab lightness, centred, as
//    alpha-weighted normalised Gaussians at the detail scale and twice it
//    (0.7 fine + 0.3 broad), times the detail strength.
// The normal is the height's Sobel slope (x right, y down, times 1/8) times
// the normal strength, (-dx, dy, 1) normalised (dy negated for DirectX),
// stored as round((v / 2 + 1 / 2) * 255). Pixels at or below the threshold
// get the flat normal (128, 128, 255); alpha is the art's.
//
// The original works in f32. This does too: values live in
// Float32Arrays and every operation the Rust rounds to f32 is rounded here
// (Math.fround), in its order (the separable Gaussian adds its taps in
// kernel order, as field.rs does), with its fused multiply-adds rounded
// once (fma32) and the distance transform's parabola crossings in f64, as
// distance.rs has them. The one thing left is the maths library: exp,
// log1p, cbrt and pow here are correctly rounded to f32, while the original
// calls the system's expf, log1pf, cbrtf and powf, and Apple's expf and
// log1pf are one f32 step off for some 0.7% of inputs (powf is matched, see
// LINEAR below). So at the default settings the output is the macOS
// build's to the byte (every kernel tap agrees, and the shape term differs
// only for insets of 314 and 1058 px), and test/normals.test.mjs checks
// that against the original's own output (test/corpus/normals); some other
// --detail-scale values change a kernel tap, which moves a rare pixel by 1.
//
// Changes from the original: it takes one frame (the toolbox's sheets are
// cut into frames before this runs), and the size limit is per frame.
//
// MIT License
//
// Copyright (c) 2026 Hugo Duprez
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

const f = Math.fround;

export type NormalFormat = "opengl" | "directx";

// Heights and smoothing radii are in the art's own pixels.
export interface NormalSettings {
  alphaThreshold: number; // pixels at or below this opacity (0-1) keep the flat normal
  shapeRadius: number; // distance over which the silhouette's slope falls off
  shapeStrength: number;
  shapeSoftness: number;
  detailStrength: number;
  detailScale: number;
  normalStrength: number;
  format: NormalFormat;
  invertX: boolean;
  invertY: boolean;
}

export const NORMAL_DEFAULTS: NormalSettings = {
  alphaThreshold: f(0.03),
  shapeRadius: 4,
  shapeStrength: f(1.15),
  shapeSoftness: f(1.15),
  detailStrength: 6,
  detailScale: f(0.6),
  normalStrength: 1.5,
  format: "opengl",
  invertX: false,
  invertY: false
};

// settings.rs's ranges, inclusive.
export const NORMAL_RANGES: { key: keyof NormalSettings; name: string; min: number; max: number }[] = [
  { key: "alphaThreshold", name: "alpha-threshold", min: 0, max: 0.99 },
  { key: "shapeRadius", name: "shape-radius", min: 0.5, max: 512 },
  { key: "shapeStrength", name: "shape-strength", min: 0, max: 8 },
  { key: "shapeSoftness", name: "shape-softness", min: 0, max: 8 },
  { key: "detailStrength", name: "detail-strength", min: 0, max: 8 },
  { key: "detailScale", name: "detail-scale", min: 0.6, max: 8 },
  { key: "normalStrength", name: "normal-strength", min: 0, max: 8 }
];

// The original's limit on one image with its padding (lib.rs MAX_PIXELS).
export const MAX_NORMAL_PIXELS = 4_194_304;

// What is wrong with the settings, or undefined. Values compare as f32, as
// the original parses them.
export function normalSettingsError(s: NormalSettings): string | undefined {
  for (const r of NORMAL_RANGES) {
    const v = s[r.key] as number;
    if (!Number.isFinite(v) || f(v) < f(r.min) || f(v) > f(r.max)) return `${r.name} must be from ${r.min} to ${r.max}`;
  }
  return undefined;
}

// The border every island's canvas gets: three blur radii and the Sobel's
// reach (settings.rs padding()).
export const normalPadding = (s: NormalSettings) => Math.ceil(f(3 * Math.max(f(s.shapeSoftness), f(f(s.detailScale) * 2)))) + 3;

// ---- f32 helpers ----

const F32 = new Float32Array(1);
const I32 = new Int32Array(F32.buffer);

// The next f32 above x (x finite).
function nextUp32(x: number): number {
  if (x === 0) return 1.401298464324817e-45;
  F32[0] = x;
  I32[0] += x > 0 ? 1 : -1;
  return F32[0];
}

// The f32 nearest the exact value s + e, where e is s's f64 rounding error
// (|e| at most half an f64 ulp of s). Rounding s alone goes wrong only when
// s sits exactly halfway between two f32s and e pushes it off the tie.
function round32(s: number, e: number): number {
  const r = f(s);
  if (e === 0 || r === s) return r;
  const other = s > r ? nextUp32(r) : -nextUp32(-r);
  if ((r + other) / 2 !== s) return r;
  return e > 0 === other > r ? other : r;
}

// Rust's f32::mul_add (a * b + c, rounded once) for f32 inputs: the product
// is exact in f64, the sum's error comes from TwoSum.
function fma32(a: number, b: number, c: number): number {
  const p = a * b;
  const s = p + c;
  const bb = s - p;
  const e = p - (s - bb) + (c - bb);
  return round32(s, e);
}

// ---- color.rs: sRGB to Oklab lightness ----

// Each 8-bit value linearised once, as color.rs does. The original's powf
// is the platform's: Apple's (on the macOS build this is checked against)
// is one f32 step above the correctly rounded value at 71 and 180, so
// those two are its bits; every other entry is the same either way.
const LINEAR = (() => {
  const t = new Float32Array(256);
  const knee = f(0.04045);
  for (let v = 0; v < 256; v++) {
    const x = f(v / 255);
    t[v] = x <= knee ? f(x / f(12.92)) : f(Math.pow(f(f(x + f(0.055)) / f(1.055)), f(2.4)));
  }
  const bits = new Uint32Array(t.buffer);
  bits[71] = 0x3d810b68;
  bits[180] = 0x3ee9aeb7;
  return t;
})();

const C = [0.41222146, 0.53633255, 0.051445995, 0.2119035, 0.6806995, 0.10739696, 0.08830246, 0.28171885, 0.6299787, 0.21045426, 0.7936178, 0.004072047].map(f);

function lightness(r8: number, g8: number, b8: number): number {
  const [r, g, b] = [LINEAR[r8], LINEAR[g8], LINEAR[b8]];
  const l = f(Math.cbrt(f(f(f(C[0] * r) + f(C[1] * g)) + f(C[2] * b))));
  const m = f(Math.cbrt(f(f(f(C[3] * r) + f(C[4] * g)) + f(C[5] * b))));
  const s = f(Math.cbrt(f(f(f(C[6] * r) + f(C[7] * g)) + f(C[8] * b))));
  return f(f(f(C[9] * l) + f(C[10] * m)) - f(C[11] * s));
}

// ---- field.rs ----

// Separable Gaussian, zero outside. Taps add in kernel order, a whole row
// at a time, as field.rs does (the order changes the f32 sums).
function gaussian(input: Float32Array, width: number, height: number, sigma: number): Float32Array {
  if (sigma < f(0.05)) return input.slice();
  const radius = Math.ceil(f(sigma * 3));
  const kernel = new Float32Array(2 * radius + 1);
  let total = 0;
  for (let i = -radius; i <= radius; i++) {
    const t = f(i / sigma);
    kernel[i + radius] = f(Math.exp(f(-0.5 * f(t * t))));
  }
  for (let k = 0; k < kernel.length; k++) total = f(total + kernel[k]);
  for (let k = 0; k < kernel.length; k++) kernel[k] = f(kernel[k] / total);

  const horizontal = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let k = 0; k < kernel.length; k++) {
      const offset = k - radius;
      const weight = kernel[k];
      // Output x reads source x + offset; taps outside the row add nothing.
      const x0 = Math.max(0, -offset);
      const x1 = Math.min(width, width - offset);
      for (let x = x0; x < x1; x++) horizontal[row + x] = horizontal[row + x] + f(input[row + x + offset] * weight);
    }
  }
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let k = 0; k < kernel.length; k++) {
      const source = y + k - radius;
      if (source < 0 || source >= height) continue;
      const weight = kernel[k];
      const from = source * width;
      for (let x = 0; x < width; x++) out[row + x] = out[row + x] + f(horizontal[from + x] * weight);
    }
  }
  return out;
}

// Opacity-weighted normalised convolution: hidden RGB never counts.
function maskedGaussian(input: Float32Array, weight: Float32Array, width: number, height: number, sigma: number): Float32Array {
  const weighted = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) weighted[i] = input[i] * weight[i];
  const numerator = gaussian(weighted, width, height, sigma);
  const denominator = gaussian(weight, width, height, sigma);
  const floor = f(1e-8);
  for (let i = 0; i < numerator.length; i++) numerator[i] = numerator[i] / Math.max(denominator[i], floor);
  return numerator;
}

// ---- distance.rs: exact Euclidean distance transform ----

// One line's squared distances to its nearest site (finite entries), by
// the lower envelope of parabolas; the crossings are f64, as there.
function squaredLine(source: Float32Array, n: number, dest: Float32Array, sites: Int32Array, starts: Float64Array) {
  let count = 0;
  for (let q = 0; q < n; q++) {
    const h = source[q];
    if (!Number.isFinite(h)) continue;
    let crossing = -Infinity;
    while (count > 0) {
      const p = sites[count - 1];
      crossing = (h + q * q - source[p] - p * p) / (2 * (q - p));
      if (crossing > starts[count - 1]) break;
      count--;
    }
    if (count === 0) crossing = -Infinity;
    sites[count] = q;
    starts[count] = crossing;
    count++;
  }
  if (count === 0) {
    dest.fill(Infinity, 0, n);
    return;
  }
  let active = 0;
  for (let q = 0; q < n; q++) {
    while (active + 1 < count && starts[active + 1] < q) active++;
    const site = sites[active];
    const delta = q - site;
    // delta.mul_add(delta, source[site]): whole numbers, exact in f64.
    dest[q] = delta * delta + source[site];
  }
}

function edt(mask: Uint8Array, width: number, height: number): Float32Array {
  const out = new Float32Array(width * height);
  const n = Math.max(width, height);
  const source = new Float32Array(n);
  const dest = new Float32Array(n);
  const sites = new Int32Array(n);
  const starts = new Float64Array(n);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) source[x] = mask[y * width + x] ? Infinity : 0;
    squaredLine(source, width, dest, sites, starts);
    out.set(dest.subarray(0, width), y * width);
  }
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) source[y] = out[y * width + x];
    squaredLine(source, height, dest, sites, starts);
    for (let y = 0; y < height; y++) out[y * width + x] = Math.sqrt(dest[y]);
  }
  return out;
}

// ---- components.rs: 8-connected islands ----

interface Island {
  pixels: number[];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function islands(mask: Uint8Array, width: number, height: number): Island[] {
  const visited = new Uint8Array(mask.length);
  const out: Island[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || visited[start]) continue;
    const part: Island = { pixels: [start], minX: start % width, minY: Math.floor(start / width), maxX: start % width, maxY: Math.floor(start / width) };
    visited[start] = 1;
    for (let cursor = 0; cursor < part.pixels.length; cursor++) {
      const index = part.pixels[cursor];
      const x = index % width;
      const y = (index - x) / width;
      if (x < part.minX) part.minX = x;
      if (x > part.maxX) part.maxX = x;
      if (y < part.minY) part.minY = y;
      if (y > part.maxY) part.maxY = y;
      for (let ny = Math.max(0, y - 1); ny <= Math.min(height - 1, y + 1); ny++) {
        for (let nx = Math.max(0, x - 1); nx <= Math.min(width - 1, x + 1); nx++) {
          const neighbour = ny * width + nx;
          if (mask[neighbour] && !visited[neighbour]) {
            visited[neighbour] = 1;
            part.pixels.push(neighbour);
          }
        }
      }
    }
    out.push(part);
  }
  return out;
}

// ---- relief.rs and lib.rs ----

const opaqueEnough = (a8: number, s: NormalSettings) => f(a8 / 255) > f(s.alphaThreshold);

// One island's normals, `rgba` being its box (other pixels transparent).
function relief(rgba: Uint8Array, w: number, h: number, s: NormalSettings): Uint8Array {
  const pad = normalPadding(s);
  const width = w + 2 * pad;
  const height = h + 2 * pad;
  const opacity = new Float32Array(width * height);
  const light = new Float32Array(width * height);
  const mask = new Uint8Array(width * height);
  let low = 1;
  let high = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      if (!opaqueEnough(rgba[p + 3], s)) continue;
      const i = (y + pad) * width + x + pad;
      mask[i] = 1;
      opacity[i] = rgba[p + 3] / 255;
      const v = lightness(rgba[p], rgba[p + 1], rgba[p + 2]);
      light[i] = v;
      low = Math.min(low, v);
      high = Math.max(high, v);
    }
  }
  // A constant height has no normal; centring keeps flat art free of
  // cancellation noise.
  const mid = f(f(low + high) * 0.5);
  for (let i = 0; i < light.length; i++) if (mask[i]) light[i] = light[i] - mid;

  const shape = edt(mask, width, height);
  const reach = f(s.shapeRadius);
  const scale = f(f(s.shapeStrength) * reach);
  for (let i = 0; i < shape.length; i++) {
    const inset = Math.max(f(shape[i] - 0.5), 0);
    shape[i] = scale * f(Math.log1p(f(inset / reach)));
  }
  const combined = gaussian(shape, width, height, f(s.shapeSoftness));
  const detailScale = f(s.detailScale);
  const fine = maskedGaussian(light, opacity, width, height, detailScale);
  const broad = maskedGaussian(light, opacity, width, height, f(detailScale * 2));
  const detail = f(s.detailStrength);
  const [c7, c3] = [f(0.7), f(0.3)];
  for (let i = 0; i < combined.length; i++) combined[i] = combined[i] + f(detail * f(f(c7 * fine[i]) + f(c3 * broad[i])));

  const strength = f(s.normalStrength);
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const i = (y + pad) * width + x + pad;
      if (!mask[i]) continue;
      // field.rs sobel(): a correlation, x right and y down, over 8.
      const d = combined;
      const up = i - width;
      const down = i + width;
      const dx = f(f(f(f(f(f(d[up + 1] + 2 * d[i + 1]) + d[down + 1]) - d[up - 1]) - 2 * d[i - 1]) - d[down - 1]) * 0.125);
      const dy = f(f(f(f(f(f(d[down - 1] + 2 * d[down]) + d[down + 1]) - d[up - 1]) - 2 * d[up]) - d[up + 1]) * 0.125);
      // lib.rs slopes_to_normal().
      let nx = f(-dx * strength);
      let ny = f(dy * strength);
      if (s.format === "directx") ny = -ny;
      if (s.invertX) nx = -nx;
      if (s.invertY) ny = -ny;
      const length = f(Math.sqrt(fma32(nx, nx, fma32(ny, ny, 1))));
      out[p] = encode(f(nx / length));
      out[p + 1] = encode(f(ny / length));
      out[p + 2] = encode(f(1 / length));
      out[p + 3] = rgba[p + 3];
    }
  }
  return out;
}

const encode = (v: number) => Math.round(f(f(f(v * 0.5) + 0.5) * 255));

// The image's normal map: same size and alpha, the flat normal wherever
// the art is at or below the alpha threshold. Every island is lifted on its
// own, so separate parts (a sword apart from its hand) do not touch.
export function normalMap(img: Image, s: NormalSettings = NORMAL_DEFAULTS): Image {
  const { width, height, rgba } = img;
  const out = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p++) out.set([128, 128, 255, rgba[p * 4 + 3]], p * 4);
  const mask = new Uint8Array(width * height);
  for (let p = 0; p < width * height; p++) mask[p] = opaqueEnough(rgba[p * 4 + 3], s) ? 1 : 0;
  for (const part of islands(mask, width, height)) {
    const w = part.maxX - part.minX + 1;
    const h = part.maxY - part.minY + 1;
    const box = new Uint8Array(w * h * 4);
    for (const index of part.pixels) {
      const x = index % width;
      const y = (index - x) / width;
      box.set(rgba.subarray(index * 4, index * 4 + 4), ((y - part.minY) * w + x - part.minX) * 4);
    }
    const lifted = relief(box, w, h, s);
    for (const index of part.pixels) {
      const x = index % width;
      const y = (index - x) / width;
      const from = ((y - part.minY) * w + x - part.minX) * 4;
      out.set(lifted.subarray(from, from + 4), index * 4);
    }
  }
  return { width, height, rgba: out };
}
