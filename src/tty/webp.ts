import type { Image } from "./png.js";
import { MAX_TOOLBOX_PIXELS } from "./png.js";
import { corrupt, WebpError } from "./webp-error.js";
import { decodeVp8, vp8Size } from "./webp-lossy.js";
import { decodeVp8l, vp8lHeader } from "./webp-lossless.js";

export { WebpError, type WebpErrorCode } from "./webp-error.js";
export { encodeWebp } from "./webp-encode.js";

// WebP reading, in-process: the RIFF container (the simple formats, VP8 and
// VP8L, and the extended one, VP8X, with ALPH alpha and ANIM/ANMF
// animation), ported from image-webp 0.2.4 (src/decoder.rs, src/extended.rs;
// https://github.com/image-rs/image-webp, commit f4d80bd). The lossy and
// lossless bitstreams are in webp-lossy.ts and webp-lossless.ts, the
// encoder in webp-encode.ts. The format is RFC 9649.
//
// Animated frames are composited the way libwebp's WebPAnimDecoder does it
// (src/demux/anim_decode.c, libwebp 1.6), which is what Pillow and libwebp's
// anim_dump show: the canvas starts transparent (the ANIM background colour
// is only a hint, and ignored); a "key frame" (the first, one covering the
// canvas with no alpha or no blending, or one after a frame disposed to the
// background that covered the canvas or was itself a key frame) starts from
// a cleared canvas, which gives the same pixels as the general case and is
// kept to follow libwebp line by line; blending is libwebp's integer
// non-premultiplied "over"; and pixels in the rectangle the previous frame
// cleared are copied, not blended with the transparent black there (which
// would change their colour by rounding). image-webp composites with a
// rounder division by 255, blends inside that rectangle, and does not clear
// it before a frame without alpha, so its frames differ from libwebp's; this
// part follows libwebp instead.
//
// Changes from image-webp, beyond the compositing:
//  - the RIFF size is checked as libwebp's ParseRIFF does
//    (src/dec/webp_dec.c): a file shorter than it says is truncated, and
//    bytes after it are ignored;
//  - the EXIF and XMP flags of VP8X need not match chunks, and a missing ALPH
//    chunk means opaque, as in libwebp (image-webp refused both);
//  - VP8L alpha is kept whatever the VP8X alpha flag says (dwebp's RGBA
//    output keeps it too);
//  - pixel budgets, and errors are WebpError.
//
// image-webp is dual-licensed MIT or Apache-2.0, used here under the MIT
// licence. Its LICENSE-MIT names no copyright holder; the authors are the
// image-rs developers (https://github.com/image-rs/image-webp/graphs/contributors).
//
// MIT License
//
// Permission is hereby granted, free of charge, to any
// person obtaining a copy of this software and associated
// documentation files (the "Software"), to deal in the
// Software without restriction, including without
// limitation the rights to use, copy, modify, merge,
// publish, distribute, sublicense, and/or sell copies of
// the Software, and to permit persons to whom the Software
// is furnished to do so, subject to the following
// conditions:
//
// The above copyright notice and this permission notice
// shall be included in all copies or substantial portions
// of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF
// ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED
// TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
// PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT
// SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
// CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
// OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR
// IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
// DEALINGS IN THE SOFTWARE.
//
// libwebp's licence, for the compositing (and the libwebp behaviours
// webp-lossless.ts follows):
//
// Copyright (c) 2010, Google Inc. All rights reserved.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are
// met:
//
//   * Redistributions of source code must retain the above copyright
//     notice, this list of conditions and the following disclaimer.
//
//   * Redistributions in binary form must reproduce the above copyright
//     notice, this list of conditions and the following disclaimer in
//     the documentation and/or other materials provided with the
//     distribution.
//
//   * Neither the name of Google nor the names of its contributors may
//     be used to endorse or promote products derived from this software
//     without specific prior written permission.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
// "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
// LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
// A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
// HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
// SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
// LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
// DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
// THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
// (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
// OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

// Previews decode at most this much, like PNG previews.
const MAX_PREVIEW_PIXELS = 40_000_000;

export const isWebp = (buf: Uint8Array) =>
  buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50;

export interface DecodedWebp {
  width: number;
  height: number;
  frames: Image[]; // each the whole canvas as shown at that point; one for a still image
  durations: number[]; // milliseconds, as stored; [0] for a still image
  loops: number; // 0: forever; 1 for a still image
  animated: boolean;
  lossy: boolean; // any frame is VP8
}

export interface WebpOptions {
  maxPixels?: number; // width x height x frames; default MAX_TOOLBOX_PIXELS
  firstFrame?: boolean; // an animation's first frame only
}

interface Chunk {
  fourcc: string;
  start: number; // of the payload
  end: number;
}

const u24 = (d: Uint8Array, i: number) => d[i] | (d[i + 1] << 8) | (d[i + 2] << 16);
const u32 = (d: Uint8Array, i: number) => (d[i] | (d[i + 1] << 8) | (d[i + 2] << 16) | (d[i + 3] << 24)) >>> 0;
const fourcc = (d: Uint8Array, i: number) => String.fromCharCode(d[i], d[i + 1], d[i + 2], d[i + 3]);

// The chunks in data[start..end], each padded to an even size. A chunk
// running past the end is cut there (its decoder then finds it short).
function chunksIn(d: Uint8Array, start: number, end: number): Chunk[] {
  const out: Chunk[] = [];
  for (let pos = start; pos + 8 <= end; ) {
    const size = u32(d, pos + 4);
    out.push({ fourcc: fourcc(d, pos), start: pos + 8, end: Math.min(end, pos + 8 + size) });
    pos += 8 + size + (size & 1);
  }
  return out;
}

const tooLarge = (what: string, pixels: number, max: number) =>
  new WebpError("TOO_LARGE", `${what} is ${(pixels / 1e6).toFixed(1)} megapixels; the limit is ${(max / 1e6).toFixed(1)}`);

// ---- Alpha (src/extended.rs: read_alpha_chunk, get_alpha_predictor) ----

function decodeAlpha(d: Uint8Array, c: Chunk, width: number, height: number, maxPixels: number): Uint8Array {
  if (c.end - c.start < 1) throw corrupt("the alpha chunk is empty");
  const info = d[c.start];
  const preprocessing = (info >> 4) & 3;
  const filtering = (info >> 2) & 3;
  const compression = info & 3;
  if (preprocessing > 1) throw corrupt("the alpha chunk has an unknown preprocessing method");
  if (compression > 1) throw corrupt("the alpha chunk has an unknown compression method");
  const n = width * height;
  let alpha: Uint8Array;
  if (compression === 1) {
    const rgba = decodeVp8l(d, c.start + 1, c.end, width, height, true, maxPixels);
    alpha = new Uint8Array(n);
    for (let i = 0; i < n; i++) alpha[i] = rgba[i * 4 + 1];
  } else {
    if (c.end - c.start - 1 < n) throw corrupt("the alpha chunk is truncated");
    alpha = d.slice(c.start + 1, c.start + 1 + n);
  }
  // Undo the filter (RFC 9649 section 2.7.1.2), in place, in scan order.
  if (filtering) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        let pred: number;
        if (x === 0 && y === 0) pred = 0;
        else if (y === 0) pred = alpha[i - 1];
        else if (x === 0) pred = alpha[i - width];
        else if (filtering === 1) pred = alpha[i - 1];
        else if (filtering === 2) pred = alpha[i - width];
        else {
          const g = alpha[i - 1] + alpha[i - width] - alpha[i - width - 1];
          pred = g < 0 ? 0 : g > 255 ? 255 : g;
        }
        alpha[i] = (alpha[i] + pred) & 0xff;
      }
    }
  }
  return alpha;
}

// One image: VP8 (with an optional ALPH) or VP8L, `width` x `height`.
function decodeImage(d: Uint8Array, image: Chunk, alph: Chunk | undefined, width: number, height: number, maxPixels: number): { rgba: Uint8Array; hasAlpha: boolean } {
  if (width * height > maxPixels) throw tooLarge(`${width}x${height}`, width * height, maxPixels);
  if (image.fourcc === "VP8L") {
    const header = vp8lHeader(d, image.start, image.end);
    return { rgba: decodeVp8l(d, image.start, image.end, width, height, false, maxPixels), hasAlpha: !!header?.alpha };
  }
  // Checked before decoding, which allocates for the size the bitstream says.
  const size = vp8Size(d, image.start, image.end);
  if (size && (size.width !== width || size.height !== height)) throw corrupt(`the lossy image is ${size.width}x${size.height}, not ${width}x${height} as its container says`);
  const frame = decodeVp8(d, image.start, image.end);
  if (!alph) return { rgba: frame.rgba, hasAlpha: false };
  const alpha = decodeAlpha(d, alph, width, height, maxPixels);
  for (let i = 0; i < alpha.length; i++) frame.rgba[i * 4 + 3] = alpha[i];
  return { rgba: frame.rgba, hasAlpha: true };
}

// ---- Compositing (libwebp src/demux/anim_decode.c) ----

// BlendPixelNonPremult: src over dst, neither premultiplied.
function blendPixel(c: Uint8Array, i: number, prev: Uint8Array) {
  const srcA = c[i + 3];
  if (srcA === 0) {
    c[i] = prev[i];
    c[i + 1] = prev[i + 1];
    c[i + 2] = prev[i + 2];
    c[i + 3] = prev[i + 3];
    return;
  }
  const dstFactorA = (prev[i + 3] * (256 - srcA)) >> 8;
  const blendA = srcA + dstFactorA;
  const scale = Math.floor((1 << 24) / blendA);
  for (let k = 0; k < 3; k++) c[i + k] = Math.floor(((c[i + k] * srcA + prev[i + k] * dstFactorA) * scale) / (1 << 24));
  c[i + 3] = blendA;
}

// BlendPixelRowNonPremult: blends the pixels that are not opaque.
function blendRow(c: Uint8Array, prev: Uint8Array, from: number, count: number) {
  for (let i = from * 4; i < (from + count) * 4; i += 4) if (c[i + 3] !== 255) blendPixel(c, i, prev);
}

interface FrameInfo {
  x: number;
  y: number;
  width: number;
  height: number;
  duration: number;
  blend: boolean;
  disposeBackground: boolean;
  image: Chunk;
  alph?: Chunk;
}

function animationFrames(d: Uint8Array, anmfs: Chunk[], canvasW: number, canvasH: number): FrameInfo[] {
  return anmfs.map(c => {
    if (c.end - c.start < 24) throw corrupt("an animation frame (ANMF) is truncated");
    const x = u24(d, c.start) * 2;
    const y = u24(d, c.start + 3) * 2;
    const width = u24(d, c.start + 6) + 1;
    const height = u24(d, c.start + 9) + 1;
    const duration = u24(d, c.start + 12);
    const flags = d[c.start + 15];
    if (width > 16384 || height > 16384) throw new WebpError("TOO_LARGE", `an animation frame is ${width}x${height} pixels`);
    if (x + width > canvasW || y + height > canvasH) throw corrupt("an animation frame lies outside the canvas");
    const sub = chunksIn(d, c.start + 16, c.end);
    let alph: Chunk | undefined;
    let image = sub[0];
    if (image?.fourcc === "ALPH") {
      alph = image;
      image = sub[1];
      if (image?.fourcc !== "VP8 ") throw corrupt("an animation frame has alpha but no lossy image");
    }
    if (image?.fourcc !== "VP8 " && image?.fourcc !== "VP8L") throw corrupt("an animation frame has no image");
    return { x, y, width, height, duration, blend: (flags & 2) === 0, disposeBackground: (flags & 1) === 1, image, alph };
  });
}

function composite(d: Uint8Array, frames: FrameInfo[], width: number, height: number, maxPixels: number): Image[] {
  const curr = new Uint8Array(width * height * 4);
  const prevDisposed = new Uint8Array(width * height * 4);
  const out: Image[] = [];
  let prev: FrameInfo | undefined;
  let prevWasKey = false;
  const isFull = (f: FrameInfo) => f.width === width && f.height === height;
  for (const f of frames) {
    const { rgba, hasAlpha } = decodeImage(d, f.image, f.alph, f.width, f.height, maxPixels);
    // IsKeyFrame
    const key: boolean = !prev || ((!hasAlpha || !f.blend) && isFull(f)) || (prev.disposeBackground && (isFull(prev) || prevWasKey));
    if (key) curr.fill(0);
    else curr.set(prevDisposed);
    for (let y = 0; y < f.height; y++) curr.set(rgba.subarray(y * f.width * 4, (y + 1) * f.width * 4), ((f.y + y) * width + f.x) * 4);
    if (prev && f.blend && !key) {
      for (let y = 0; y < f.height; y++) {
        const cy = f.y + y;
        const row = cy * width;
        if (!prev.disposeBackground) {
          blendRow(curr, prevDisposed, row + f.x, f.width);
          continue;
        }
        // FindBlendRangeAtRow: the cleared rectangle of the previous frame
        // is transparent already, so only the parts outside it blend.
        if (cy < prev.y || cy >= prev.y + prev.height || f.x >= prev.x + prev.width || f.x + f.width <= prev.x) {
          blendRow(curr, prevDisposed, row + f.x, f.width);
          continue;
        }
        if (f.x < prev.x) blendRow(curr, prevDisposed, row + f.x, prev.x - f.x);
        if (f.x + f.width > prev.x + prev.width) blendRow(curr, prevDisposed, row + prev.x + prev.width, f.x + f.width - (prev.x + prev.width));
      }
    }
    prev = f;
    prevWasKey = key;
    prevDisposed.set(curr);
    if (f.disposeBackground) for (let y = 0; y < f.height; y++) prevDisposed.fill(0, ((f.y + y) * width + f.x) * 4, ((f.y + y) * width + f.x + f.width) * 4);
    out.push({ width, height, rgba: curr.slice() });
  }
  return out;
}

// ---- The container (src/decoder.rs: read_data, read_image, read_frame) ----

/**
 * Every frame of a WebP file as it is shown (a still image is one frame),
 * or a WebpError saying why it cannot be read. Refuses more than
 * `maxPixels` in all (width x height x frames) before decoding anything.
 */
export function decodeWebp(buf: Uint8Array, opts: WebpOptions = {}): DecodedWebp {
  const maxPixels = opts.maxPixels ?? MAX_TOOLBOX_PIXELS;
  if (!isWebp(buf)) throw new WebpError("NOT_WEBP", "not a WebP file");
  const d = buf;
  const riffSize = u32(d, 4);
  if (riffSize < 12) throw corrupt("the RIFF header is too small");
  if (riffSize > d.length - 8) throw corrupt("the file is truncated");
  const end = 8 + riffSize;
  const [first] = chunksIn(d, 12, end);
  if (!first) throw corrupt("the file has no image");

  if (first.fourcc === "VP8 " || first.fourcc === "VP8L") {
    const size = first.fourcc === "VP8 " ? vp8Size(d, first.start, first.end) : vp8lHeader(d, first.start, first.end);
    if (!size) {
      const tag = first.end - first.start >= 1 && first.fourcc === "VP8 " && d[first.start] & 1;
      throw tag ? new WebpError("UNSUPPORTED", "the lossy image is not a key frame") : corrupt(`the ${first.fourcc.trim()} header is damaged`);
    }
    if (!size.width || !size.height) throw corrupt(`the image says it is ${size.width}x${size.height} pixels`);
    const { rgba } = decodeImage(d, first, undefined, size.width, size.height, maxPixels);
    return { width: size.width, height: size.height, frames: [{ width: size.width, height: size.height, rgba }], durations: [0], loops: 1, animated: false, lossy: first.fourcc === "VP8 " };
  }

  if (first.fourcc !== "VP8X") throw corrupt(`the first chunk is ${JSON.stringify(first.fourcc)}, not an image`);
  if (first.end - first.start < 10) throw corrupt("the VP8X chunk is truncated");
  const flags = d[first.start];
  const animation = (flags & 0b10) !== 0;
  const width = u24(d, first.start + 4) + 1;
  const height = u24(d, first.start + 7) + 1;
  if (width * height > 0xffffffff) throw new WebpError("TOO_LARGE", `the canvas is ${width}x${height} pixels`);

  const chunks = chunksIn(d, first.end + ((first.end - first.start) & 1), end);
  const find = (cc: string) => chunks.find(c => c.fourcc === cc);

  if (!animation) {
    const image = chunks.find(c => c.fourcc === "VP8 " || c.fourcc === "VP8L");
    if (!image) throw corrupt("the file has no image");
    if (width * height > maxPixels) throw tooLarge(`${width}x${height}`, width * height, maxPixels);
    const { rgba } = decodeImage(d, image, image.fourcc === "VP8 " ? find("ALPH") : undefined, width, height, maxPixels);
    return { width, height, frames: [{ width, height, rgba }], durations: [0], loops: 1, animated: false, lossy: image.fourcc === "VP8 " };
  }

  const anim = find("ANIM");
  const anmfs = chunks.filter(c => c.fourcc === "ANMF");
  if (!anim || anim.end - anim.start < 6) throw corrupt("the animation has no ANIM chunk");
  if (!anmfs.length) throw corrupt("the animation has no frames");
  const loops = d[anim.start + 4] | (d[anim.start + 5] << 8);
  const wanted = opts.firstFrame ? anmfs.slice(0, 1) : anmfs;
  if (width * height * wanted.length > maxPixels) {
    throw new WebpError("TOO_LARGE", `${wanted.length} frames of ${width}x${height} is over ${Math.round(maxPixels / 1e6)} megapixels in all`);
  }
  const frames = animationFrames(d, wanted, width, height);
  return {
    width,
    height,
    frames: composite(d, frames, width, height, maxPixels),
    durations: frames.map(f => f.duration),
    loops,
    animated: true,
    lossy: frames.some(f => f.image.fourcc === "VP8 ")
  };
}

/** The image (an animation's first frame) of a WebP file; throws WebpError. */
export function readWebp(buf: Uint8Array, maxPixels = MAX_TOOLBOX_PIXELS): Image {
  return decodeWebp(buf, { maxPixels, firstFrame: true }).frames[0];
}

// For previews: anything it cannot read returns undefined, as decodePng does.
export function decodeWebpPreview(buf: Uint8Array): Image | undefined {
  try {
    return readWebp(buf, MAX_PREVIEW_PIXELS);
  } catch {
    return undefined;
  }
}
