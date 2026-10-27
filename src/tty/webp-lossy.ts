import { corrupt, WebpError } from "./webp-error.js";
import {
  AC_QUANT,
  B_PRED,
  COEFF_BANDS,
  COEFF_PROBS,
  COEFF_UPDATE_PROBS,
  DC_QUANT,
  DCT_CAT1,
  DCT_CAT_BASE,
  DCT_EOB,
  DCT_TOKEN_TREE,
  KEYFRAME_BPRED_MODE_PROBS,
  KEYFRAME_BPRED_MODE_TREE,
  KEYFRAME_UV_MODE_PROBS,
  KEYFRAME_UV_MODE_TREE,
  KEYFRAME_YMODE_PROBS,
  KEYFRAME_YMODE_TREE,
  PROB_DCT_CAT,
  SEGMENT_ID_TREE,
  ZIGZAG
} from "./webp-tables.js";

// The VP8 key frame decoder behind lossy WebP, ported from image-webp 0.2.4
// (https://github.com/image-rs/image-webp, commit f4d80bd), the WebP backend
// of Rust's `image` crate:
//   src/lossy/mod.rs                the frame header, macroblock modes and
//                                   residuals, the loop filter's driver;
//   src/lossy/arithmetic_decoder.rs the boolean entropy decoder;
//   src/lossy/prediction.rs         intra prediction;
//   src/lossy/transform.rs          the inverse DCT and Walsh-Hadamard;
//   src/lossy/loop_filter.rs        the loop filters;
//   src/lossy/yuv.rs                YUV to RGB with libwebp's "fancy"
//                                   (bilinear) chroma upsampling, dwebp's
//                                   default, which image-webp matches
//                                   exactly.
// The format is RFC 6386 (VP8) inside RFC 9649 (WebP).
//
// Changes from the original:
//  - the boolean decoder reads a byte at a time instead of 32-bit chunks with
//    a fast path; it gives the same bits and, like the original, allows
//    reading one zero byte past the end of a partition (as libwebp does) and
//    fails past that;
//  - trees are read in RFC 6386's form (section 8.1) instead of image-webp's
//    precomputed node structs, which hold the same trees;
//  - the horizontal loop filters are the vertical ones with a stride of 1
//    (image-webp has a copy of each for an 8-pixel slice);
//  - the IDCT multiplies in doubles where image-webp widens to i64: the same
//    integers;
//  - only RGBA output, and errors are WebpError.
//
// image-webp is dual-licensed MIT or Apache-2.0; it is used here under the
// MIT licence. Its LICENSE-MIT names no copyright holder; the authors are
// the image-rs developers (https://github.com/image-rs/image-webp/graphs/contributors).
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

// ---- The boolean entropy decoder (RFC 6386 section 7) ----

class BoolDecoder {
  private value = 0; // the bits read ahead, `bitCount` of them below the 8 in use
  private range = 255;
  private bitCount = -8;
  private pos: number;
  private paddingUsed = false;
  private eof = false;

  constructor(
    private data: Uint8Array,
    start: number,
    private end: number
  ) {
    this.pos = start;
  }

  private load() {
    this.value <<= 8;
    this.bitCount += 8;
    if (this.pos < this.end) this.value |= this.data[this.pos++];
    // libwebp allows one zero byte past the end; after it the partition is
    // over, and check() says so.
    else if (this.paddingUsed) this.eof = true;
    else this.paddingUsed = true;
  }

  readBool(prob: number): boolean {
    if (this.bitCount < 0) this.load();
    const split = 1 + (((this.range - 1) * prob) >> 8);
    const bigsplit = split << this.bitCount;
    let bit: boolean;
    if (this.value >= bigsplit) {
      this.range -= split;
      this.value -= bigsplit;
      bit = true;
    } else {
      this.range = split;
      bit = false;
    }
    // Renormalise so that range >= 128.
    const shift = Math.clz32(this.range) - 24;
    this.range <<= shift;
    this.bitCount -= shift;
    return bit;
  }

  readFlag(): boolean {
    return this.readBool(128);
  }

  readLiteral(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | (this.readFlag() ? 1 : 0);
    return v;
  }

  readOptionalSigned(n: number): number {
    if (!this.readFlag()) return 0;
    const magnitude = this.readLiteral(n);
    return this.readFlag() ? -magnitude : magnitude;
  }

  // RFC 6386 section 8.1, treed_read; `start` skips the first branch (2
  // after a DCT_0 token, which cannot be followed by DCT_EOB).
  readTree(tree: Int8Array, probs: Uint8Array, probsAt = 0, start = 0): number {
    let i = start;
    while ((i = tree[i + (this.readBool(probs[probsAt + (i >> 1)]) ? 1 : 0)]) > 0);
    return -i;
  }

  check() {
    if (this.eof) throw corrupt("the lossy image data is truncated");
  }
}

// ---- Prediction (src/lossy/prediction.rs) ----

const LUMA_STRIDE = 1 + 16 + 4;
const CHROMA_STRIDE = 1 + 8;

// The 16x16 luma block with its border: one pixel above (and four more to
// the top right) and one to the left.
function createBorderLuma(ws: Uint8Array, mbx: number, mby: number, mbw: number, top: Uint8Array, left: Uint8Array) {
  const stride = LUMA_STRIDE;
  ws.fill(0);
  if (mby === 0) {
    ws.fill(127, 1, stride);
  } else {
    for (let i = 0; i < 16; i++) ws[1 + i] = top[mbx * 16 + i];
    if (mbx === mbw - 1) {
      for (let i = 16; i < stride - 1; i++) ws[1 + i] = top[mbx * 16 + 15];
    } else {
      for (let i = 16; i < stride - 1; i++) ws[1 + i] = top[mbx * 16 + i];
    }
  }
  for (let i = 17; i < stride; i++) {
    ws[4 * stride + i] = ws[i];
    ws[8 * stride + i] = ws[i];
    ws[12 * stride + i] = ws[i];
  }
  if (mbx === 0) {
    for (let i = 0; i < 16; i++) ws[(i + 1) * stride] = 129;
  } else {
    for (let i = 0; i < 16; i++) ws[(i + 1) * stride] = left[1 + i];
  }
  ws[0] = mby === 0 ? 127 : mbx === 0 ? 129 : left[0];
}

function createBorderChroma(ws: Uint8Array, mbx: number, mby: number, top: Uint8Array, left: Uint8Array) {
  const stride = CHROMA_STRIDE;
  ws.fill(0);
  if (mby === 0) ws.fill(127, 1, stride);
  else for (let i = 0; i < 8; i++) ws[1 + i] = top[mbx * 8 + i];
  if (mbx === 0) {
    for (let y = 0; y < 8; y++) ws[(y + 1) * stride] = 129;
  } else {
    for (let y = 0; y < 8; y++) ws[(y + 1) * stride] = left[1 + y];
  }
  ws[0] = mby === 0 ? 127 : mbx === 0 ? 129 : left[0];
}

const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

// Adds a 4x4 block of residuals (rblock[at..at+16]) at (x0, y0).
function addResidue(p: Uint8Array, r: Int32Array, at: number, y0: number, x0: number, stride: number) {
  let pos = y0 * stride + x0;
  for (let row = 0; row < 4; row++) {
    for (let i = 0; i < 4; i++) p[pos + i] = clamp255(r[at + row * 4 + i] + p[pos + i]);
    pos += stride;
  }
}

const avg3 = (l: number, t: number, r: number) => (l + 2 * t + r + 2) >> 2;
const avg2 = (t: number, r: number) => (t + r + 1) >> 1;

function predictVpred(a: Uint8Array, size: number, x0: number, y0: number, stride: number) {
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) a[(y0 + y) * stride + x0 + x] = a[(y0 - 1) * stride + x0 + x];
}

function predictHpred(a: Uint8Array, size: number, x0: number, y0: number, stride: number) {
  for (let y = 0; y < size; y++) {
    const row = (y0 + y) * stride;
    a.fill(a[row + x0 - 1], row + x0, row + x0 + size);
  }
}

function predictDcpred(a: Uint8Array, size: number, stride: number, above: boolean, left: boolean) {
  let sum = 0;
  let shf = size === 8 ? 2 : 3;
  if (left) {
    for (let y = 0; y < size; y++) sum += a[(y + 1) * stride];
    shf++;
  }
  if (above) {
    for (let x = 1; x <= size; x++) sum += a[x];
    shf++;
  }
  const dc = !left && !above ? 128 : (sum + (1 << (shf - 1))) >> shf;
  for (let y = 0; y < size; y++) a.fill(dc, 1 + stride * (y + 1), 1 + stride * (y + 1) + size);
}

// X = L + A - P, clamped (RFC 6386 section 12.2).
function predictTmpred(a: Uint8Array, size: number, x0: number, y0: number, stride: number) {
  const p = a[(y0 - 1) * stride + x0 - 1];
  for (let y = 0; y < size; y++) {
    const leftMinusP = a[(y0 + y) * stride + x0 - 1] - p;
    for (let x = 0; x < size; x++) a[(y0 + y) * stride + x0 + x] = clamp255(leftMinusP + a[(y0 - 1) * stride + x0 + x]);
  }
}

function predictBdcpred(a: Uint8Array, x0: number, y0: number, stride: number) {
  let v = 4;
  for (let i = 0; i < 4; i++) v += a[(y0 - 1) * stride + x0 + i];
  for (let i = 0; i < 4; i++) v += a[(y0 + i) * stride + x0 - 1];
  v >>= 3;
  for (let y = 0; y < 4; y++) a.fill(v, (y0 + y) * stride + x0, (y0 + y) * stride + x0 + 4);
}

// The subblock predictors of RFC 6386 section 12.3, as image-webp writes
// them: A[0..7] the row above (with the top right), L[0..3] the column to
// the left, P the top-left corner, E the edge from bottom-left round to the
// top right.
function predictSubblock(a: Uint8Array, mode: number, x0: number, y0: number, stride: number) {
  const at = (x: number, y: number) => (y0 + y) * stride + x0 + x;
  const top = (y0 - 1) * stride + x0;
  const P = a[top - 1];
  const A = (i: number) => a[top + i];
  const L = (i: number) => a[(y0 + i) * stride + x0 - 1];
  switch (mode) {
    case 1: // TM
      return predictTmpred(a, 4, x0, y0, stride);
    case 2: {
      // VE
      const row = [avg3(P, A(0), A(1)), avg3(A(0), A(1), A(2)), avg3(A(1), A(2), A(3)), avg3(A(2), A(3), A(4))];
      for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) a[at(x, y)] = row[x];
      return;
    }
    case 3: {
      // HE
      const col = [avg3(P, L(0), L(1)), avg3(L(0), L(1), L(2)), avg3(L(1), L(2), L(3)), avg3(L(2), L(3), L(3))];
      for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) a[at(x, y)] = col[y];
      return;
    }
    case 0: // DC
      return predictBdcpred(a, x0, y0, stride);
    case 4: {
      // LD
      const avgs = [
        avg3(A(0), A(1), A(2)),
        avg3(A(1), A(2), A(3)),
        avg3(A(2), A(3), A(4)),
        avg3(A(3), A(4), A(5)),
        avg3(A(4), A(5), A(6)),
        avg3(A(5), A(6), A(7)),
        avg3(A(6), A(7), A(7))
      ];
      for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) a[at(x, y)] = avgs[y + x];
      return;
    }
  }
  // The modes reading the left edge and the corner.
  const pos = top - 1;
  const e0 = a[pos + 4 * stride];
  const e1 = a[pos + 3 * stride];
  const e2 = a[pos + 2 * stride];
  const e3 = a[pos + stride];
  const e4 = a[pos];
  const e5 = a[pos + 1];
  const e6 = a[pos + 2];
  const e7 = a[pos + 3];
  const e8 = a[pos + 4];
  switch (mode) {
    case 5: {
      // RD
      const avgs = [avg3(e0, e1, e2), avg3(e1, e2, e3), avg3(e2, e3, e4), avg3(e3, e4, e5), avg3(e4, e5, e6), avg3(e5, e6, e7), avg3(e6, e7, e8)];
      for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) a[at(x, y)] = avgs[3 - y + x];
      return;
    }
    case 6: // VR
      a[at(0, 3)] = avg3(e1, e2, e3);
      a[at(0, 2)] = avg3(e2, e3, e4);
      a[at(1, 3)] = avg3(e3, e4, e5);
      a[at(0, 1)] = avg3(e3, e4, e5);
      a[at(1, 2)] = avg2(e4, e5);
      a[at(0, 0)] = avg2(e4, e5);
      a[at(2, 3)] = avg3(e4, e5, e6);
      a[at(1, 1)] = avg3(e4, e5, e6);
      a[at(2, 2)] = avg2(e5, e6);
      a[at(1, 0)] = avg2(e5, e6);
      a[at(3, 3)] = avg3(e5, e6, e7);
      a[at(2, 1)] = avg3(e5, e6, e7);
      a[at(3, 2)] = avg2(e6, e7);
      a[at(2, 0)] = avg2(e6, e7);
      a[at(3, 1)] = avg3(e6, e7, e8);
      a[at(3, 0)] = avg2(e7, e8);
      return;
    case 7: {
      // VL
      const [a0, a1, a2, a3, a4, a5, a6, a7] = [A(0), A(1), A(2), A(3), A(4), A(5), A(6), A(7)];
      a[at(0, 0)] = avg2(a0, a1);
      a[at(0, 1)] = avg3(a0, a1, a2);
      a[at(0, 2)] = avg2(a1, a2);
      a[at(1, 0)] = avg2(a1, a2);
      a[at(1, 1)] = avg3(a1, a2, a3);
      a[at(0, 3)] = avg3(a1, a2, a3);
      a[at(1, 2)] = avg2(a2, a3);
      a[at(2, 0)] = avg2(a2, a3);
      a[at(1, 3)] = avg3(a2, a3, a4);
      a[at(2, 1)] = avg3(a2, a3, a4);
      a[at(2, 2)] = avg2(a3, a4);
      a[at(3, 0)] = avg2(a3, a4);
      a[at(2, 3)] = avg3(a3, a4, a5);
      a[at(3, 1)] = avg3(a3, a4, a5);
      a[at(3, 2)] = avg3(a4, a5, a6);
      a[at(3, 3)] = avg3(a5, a6, a7);
      return;
    }
    case 8: // HD
      a[at(0, 3)] = avg2(e0, e1);
      a[at(1, 3)] = avg3(e0, e1, e2);
      a[at(0, 2)] = avg2(e1, e2);
      a[at(2, 3)] = avg2(e1, e2);
      a[at(1, 2)] = avg3(e1, e2, e3);
      a[at(3, 3)] = avg3(e1, e2, e3);
      a[at(2, 2)] = avg2(e2, e3);
      a[at(0, 1)] = avg2(e2, e3);
      a[at(3, 2)] = avg3(e2, e3, e4);
      a[at(1, 1)] = avg3(e2, e3, e4);
      a[at(2, 1)] = avg2(e3, e4);
      a[at(0, 0)] = avg2(e3, e4);
      a[at(3, 1)] = avg3(e3, e4, e5);
      a[at(1, 0)] = avg3(e3, e4, e5);
      a[at(2, 0)] = avg3(e4, e5, e6);
      a[at(3, 0)] = avg3(e5, e6, e7);
      return;
    case 9: {
      // HU
      const [l0, l1, l2, l3] = [L(0), L(1), L(2), L(3)];
      a[at(0, 0)] = avg2(l0, l1);
      a[at(1, 0)] = avg3(l0, l1, l2);
      a[at(2, 0)] = avg2(l1, l2);
      a[at(0, 1)] = avg2(l1, l2);
      a[at(3, 0)] = avg3(l1, l2, l3);
      a[at(1, 1)] = avg3(l1, l2, l3);
      a[at(2, 1)] = avg2(l2, l3);
      a[at(0, 2)] = avg2(l2, l3);
      a[at(3, 1)] = avg3(l2, l3, l3);
      a[at(1, 2)] = avg3(l2, l3, l3);
      a[at(2, 2)] = l3;
      a[at(3, 2)] = l3;
      a[at(0, 3)] = l3;
      a[at(1, 3)] = l3;
      a[at(2, 3)] = l3;
      a[at(3, 3)] = l3;
      return;
    }
  }
}

// ---- Transforms (src/lossy/transform.rs) ----

// cos(pi/8) * sqrt(2) - 1 and sin(pi/8) * sqrt(2), in 16-bit fixed point.
const CONST1 = 20091;
const CONST2 = 35468;
// (v * c) >> 16 on integers that may pass 2^31 (image-webp widens to i64).
const mulShift = (v: number, c: number) => Math.floor((v * c) / 65536);

function idct4x4(b: Int32Array, at: number) {
  for (let i = 0; i < 4; i++) {
    const i0 = b[at + i];
    const i4 = b[at + 4 + i];
    const i8 = b[at + 8 + i];
    const i12 = b[at + 12 + i];
    const a1 = i0 + i8;
    const b1 = i0 - i8;
    const c1 = mulShift(i4, CONST2) - (i12 + mulShift(i12, CONST1));
    const d1 = i4 + mulShift(i4, CONST1) + mulShift(i12, CONST2);
    b[at + i] = a1 + d1;
    b[at + 4 + i] = b1 + c1;
    b[at + 12 + i] = a1 - d1;
    b[at + 8 + i] = b1 - c1;
  }
  for (let i = 0; i < 4; i++) {
    const r = at + 4 * i;
    const i0 = b[r];
    const i1 = b[r + 1];
    const i2 = b[r + 2];
    const i3 = b[r + 3];
    const a1 = i0 + i2;
    const b1 = i0 - i2;
    const c1 = mulShift(i1, CONST2) - (i3 + mulShift(i3, CONST1));
    const d1 = i1 + mulShift(i1, CONST1) + mulShift(i3, CONST2);
    b[r] = Math.floor((a1 + d1 + 4) / 8);
    b[r + 3] = Math.floor((a1 - d1 + 4) / 8);
    b[r + 1] = Math.floor((b1 + c1 + 4) / 8);
    b[r + 2] = Math.floor((b1 - c1 + 4) / 8);
  }
}

// RFC 6386 section 14.3.
function iwht4x4(b: Int32Array) {
  for (let i = 0; i < 4; i++) {
    const a1 = b[i] + b[12 + i];
    const b1 = b[4 + i] + b[8 + i];
    const c1 = b[4 + i] - b[8 + i];
    const d1 = b[i] - b[12 + i];
    b[i] = a1 + b1;
    b[4 + i] = c1 + d1;
    b[8 + i] = a1 - b1;
    b[12 + i] = d1 - c1;
  }
  for (let r = 0; r < 16; r += 4) {
    const a1 = b[r] + b[r + 3];
    const b1 = b[r + 1] + b[r + 2];
    const c1 = b[r + 1] - b[r + 2];
    const d1 = b[r] - b[r + 3];
    b[r] = (a1 + b1 + 3) >> 3;
    b[r + 1] = (c1 + d1 + 3) >> 3;
    b[r + 2] = (a1 - b1 + 3) >> 3;
    b[r + 3] = (d1 - c1 + 3) >> 3;
  }
}

// ---- Loop filters (src/lossy/loop_filter.rs) ----
// Each filters across the edge before `point`: p3 p2 p1 p0 | q0 q1 q2 q3,
// `stride` apart (1 for a vertical edge, the row length for a horizontal one).

const c128 = (v: number) => (v < -128 ? -128 : v > 127 ? 127 : v);
const u2s = (v: number) => v - 128;
const s2u = (v: number) => c128(v) + 128;
const diff = (a: number, b: number) => (a > b ? a - b : b - a);

// Adjusts p0 and q0 (RFC 6386 sections 15.2, 15.3); returns the filter value.
function commonAdjust(useOuterTaps: boolean, px: Uint8Array, point: number, stride: number): number {
  const p1 = u2s(px[point - 2 * stride]);
  const p0 = u2s(px[point - stride]);
  const q0 = u2s(px[point]);
  const q1 = u2s(px[point + stride]);
  const outer = useOuterTaps ? c128(p1 - q1) : 0;
  const a0 = c128(outer + 3 * (q0 - p0));
  const b = c128(a0 + 3) >> 3;
  const a = c128(a0 + 4) >> 3;
  px[point] = s2u(q0 - a);
  px[point - stride] = s2u(p0 + b);
  return a;
}

const simpleThreshold = (limit: number, px: Uint8Array, point: number, stride: number) =>
  diff(px[point - stride], px[point]) * 2 + (diff(px[point - 2 * stride], px[point + stride]) >> 1) <= limit;

function shouldFilter(interior: number, edge: number, px: Uint8Array, point: number, stride: number): boolean {
  return (
    simpleThreshold(edge, px, point, stride) &&
    diff(px[point - 4 * stride], px[point - 3 * stride]) <= interior &&
    diff(px[point - 3 * stride], px[point - 2 * stride]) <= interior &&
    diff(px[point - 2 * stride], px[point - stride]) <= interior &&
    diff(px[point + 3 * stride], px[point + 2 * stride]) <= interior &&
    diff(px[point + 2 * stride], px[point + stride]) <= interior &&
    diff(px[point + stride], px[point]) <= interior
  );
}

const highEdgeVariance = (threshold: number, px: Uint8Array, point: number, stride: number) =>
  diff(px[point - 2 * stride], px[point - stride]) > threshold || diff(px[point + stride], px[point]) > threshold;

function simpleSegment(edge: number, px: Uint8Array, point: number, stride: number) {
  if (simpleThreshold(edge, px, point, stride)) commonAdjust(true, px, point, stride);
}

function subblockFilter(hev: number, interior: number, edge: number, px: Uint8Array, point: number, stride: number) {
  if (!shouldFilter(interior, edge, px, point, stride)) return;
  const hv = highEdgeVariance(hev, px, point, stride);
  const a = (commonAdjust(hv, px, point, stride) + 1) >> 1;
  if (!hv) {
    px[point + stride] = s2u(u2s(px[point + stride]) - a);
    px[point - 2 * stride] = s2u(u2s(px[point - 2 * stride]) + a);
  }
}

function macroblockFilter(hev: number, interior: number, edge: number, px: Uint8Array, point: number, stride: number) {
  if (!shouldFilter(interior, edge, px, point, stride)) return;
  if (highEdgeVariance(hev, px, point, stride)) {
    commonAdjust(true, px, point, stride);
    return;
  }
  const p2 = u2s(px[point - 3 * stride]);
  const p1 = u2s(px[point - 2 * stride]);
  const p0 = u2s(px[point - stride]);
  const q0 = u2s(px[point]);
  const q1 = u2s(px[point + stride]);
  const q2 = u2s(px[point + 2 * stride]);
  const w = c128(c128(p1 - q1) + 3 * (q0 - p0));
  let a = c128((27 * w + 63) >> 7);
  px[point] = s2u(q0 - a);
  px[point - stride] = s2u(p0 + a);
  a = c128((18 * w + 63) >> 7);
  px[point + stride] = s2u(q1 - a);
  px[point - 2 * stride] = s2u(p1 + a);
  a = c128((9 * w + 63) >> 7);
  px[point + 2 * stride] = s2u(q2 - a);
  px[point - 3 * stride] = s2u(p2 + a);
}

// ---- YUV to RGB (src/lossy/yuv.rs, after libwebp's src/dsp/yuv.h) ----

const mulhi = (v: number, coeff: number) => (v * coeff) >> 8;
const clip = (v: number) => clamp255(v >> 6);

function setPixel(out: Uint8Array, o: number, y: number, u: number, v: number) {
  out[o] = clip(mulhi(y, 19077) + mulhi(v, 26149) - 14234);
  out[o + 1] = clip(mulhi(y, 19077) - mulhi(u, 6419) - mulhi(v, 13320) + 8708);
  out[o + 2] = clip(mulhi(y, 19077) + mulhi(u, 33050) - 17685);
}

const fancy = (main: number, s1: number, s2: number, t: number) => (9 * main + 3 * s1 + 3 * s2 + t + 8) >> 4;

// A row whose chroma comes from one row of chroma samples (the first, and
// the last of an even height).
function fillRow1(out: Uint8Array, o: number, width: number, Y: Uint8Array, yAt: number, U: Uint8Array, V: Uint8Array, uvAt: number, cw: number) {
  setPixel(out, o, Y[yAt], U[uvAt], V[uvAt]);
  let x = 1;
  for (let k = 0; k + 1 < cw && x + 1 < width; k++, x += 2) {
    const u0 = U[uvAt + k];
    const u1 = U[uvAt + k + 1];
    const v0 = V[uvAt + k];
    const v1 = V[uvAt + k + 1];
    setPixel(out, o + x * 4, Y[yAt + x], fancy(u0, u1, u0, u1), fancy(v0, v1, v0, v1));
    setPixel(out, o + (x + 1) * 4, Y[yAt + x + 1], fancy(u1, u0, u1, u0), fancy(v1, v0, v1, v0));
  }
  if (x < width) setPixel(out, o + x * 4, Y[yAt + x], U[uvAt + cw - 1], V[uvAt + cw - 1]);
}

// A row between two rows of chroma samples: `near` (weight 3/4) and `far`.
function fillRow2(out: Uint8Array, o: number, width: number, Y: Uint8Array, yAt: number, U: Uint8Array, V: Uint8Array, near: number, far: number, cw: number) {
  setPixel(out, o, Y[yAt], fancy(U[near], U[near], U[far], U[far]), fancy(V[near], V[near], V[far], V[far]));
  let x = 1;
  for (let k = 0; k + 1 < cw && x + 1 < width; k++, x += 2) {
    const [u0, u1, u2, u3] = [U[near + k], U[near + k + 1], U[far + k], U[far + k + 1]];
    const [v0, v1, v2, v3] = [V[near + k], V[near + k + 1], V[far + k], V[far + k + 1]];
    setPixel(out, o + x * 4, Y[yAt + x], fancy(u0, u1, u2, u3), fancy(v0, v1, v2, v3));
    setPixel(out, o + (x + 1) * 4, Y[yAt + x + 1], fancy(u1, u0, u3, u2), fancy(v1, v0, v3, v2));
  }
  if (x < width) {
    const [un, uf, vn, vf] = [U[near + cw - 1], U[far + cw - 1], V[near + cw - 1], V[far + cw - 1]];
    setPixel(out, o + x * 4, Y[yAt + x], fancy(un, un, uf, uf), fancy(vn, vn, vf, vf));
  }
}

// fill_rgb_buffer_fancy: every output row interpolates the chroma rows on
// either side of it, 3/4 and 1/4, and so across.
function fillRgbaFancy(out: Uint8Array, Y: Uint8Array, U: Uint8Array, V: Uint8Array, width: number, height: number, bufferWidth: number) {
  const cbw = bufferWidth / 2;
  const cw = (width + 1) >> 1;
  fillRow1(out, 0, width, Y, 0, U, V, 0, cw);
  let y = 1;
  for (let k = 0; y + 1 < height; k++, y += 2) {
    fillRow2(out, y * width * 4, width, Y, y * bufferWidth, U, V, k * cbw, (k + 1) * cbw, cw);
    fillRow2(out, (y + 1) * width * 4, width, Y, (y + 1) * bufferWidth, U, V, (k + 1) * cbw, k * cbw, cw);
  }
  if (y < height) fillRow1(out, y * width * 4, width, Y, y * bufferWidth, U, V, (((height + 1) >> 1) - 1) * cbw, cw);
  for (let i = 3; i < out.length; i += 4) out[i] = 255;
}

// ---- The decoder (src/lossy/mod.rs) ----

// Planes of DCT coefficients (RFC 6386 section 13.3), the first index of
// the token probabilities.
const Y_AFTER_Y2 = 0;
const Y2 = 1;
const CHROMA = 2;
const Y_WITH_DC = 3;

// Luma mode to the subblock mode its subblocks count as for their
// neighbours: DC, V, H, TM to B_DC, B_VE, B_HE, B_TM.
const LUMA_TO_INTRA = [0, 2, 3, 1];

interface Segment {
  ydc: number;
  yac: number;
  y2dc: number;
  y2ac: number;
  uvdc: number;
  uvac: number;
  deltaValues: boolean;
  quantizerLevel: number;
  loopfilterLevel: number;
}

export interface Vp8Frame {
  width: number;
  height: number;
}

/** The size a VP8 bitstream says it is, or undefined if it is no key frame. */
export function vp8Size(data: Uint8Array, start: number, end: number): Vp8Frame | undefined {
  if (end - start < 10 || data[start] & 1) return undefined;
  if (data[start + 3] !== 0x9d || data[start + 4] !== 0x01 || data[start + 5] !== 0x2a) return undefined;
  return { width: (data[start + 6] | (data[start + 7] << 8)) & 0x3fff, height: (data[start + 8] | (data[start + 9] << 8)) & 0x3fff };
}

/**
 * Decodes a VP8 key frame (the payload of a "VP8 " chunk, data[start..end])
 * to RGBA, every pixel opaque.
 */
export function decodeVp8(data: Uint8Array, start: number, end: number): { width: number; height: number; rgba: Uint8Array } {
  // Frame tag and key frame header (RFC 6386 sections 9.1, 19.1).
  if (end - start < 10) throw corrupt("the lossy image header is truncated");
  const tag = data[start] | (data[start + 1] << 8) | (data[start + 2] << 16);
  if (tag & 1) throw new WebpError("UNSUPPORTED", "the lossy image is not a key frame");
  const firstPartitionSize = tag >>> 5;
  if (data[start + 3] !== 0x9d || data[start + 4] !== 0x01 || data[start + 5] !== 0x2a) throw corrupt("the lossy image has no VP8 start code");
  const width = (data[start + 6] | (data[start + 7] << 8)) & 0x3fff;
  const height = (data[start + 8] | (data[start + 9] << 8)) & 0x3fff;
  if (!width || !height) throw corrupt(`the lossy image says it is ${width}x${height} pixels`);
  const mbw = (width + 15) >> 4;
  const mbh = (height + 15) >> 4;

  let pos = start + 10;
  if (pos + firstPartitionSize > end) throw corrupt("the lossy image header is truncated");
  const b = new BoolDecoder(data, pos, pos + firstPartitionSize);
  pos += firstPartitionSize;

  const colorSpace = b.readLiteral(1);
  b.readLiteral(1); // pixel type (clamping), always clamped here
  if (colorSpace !== 0) throw new WebpError("UNSUPPORTED", `the lossy image uses colour space ${colorSpace}`);

  // Segments (section 9.3).
  const segments: Segment[] = Array.from({ length: 4 }, () => ({
    ydc: 0,
    yac: 0,
    y2dc: 0,
    y2ac: 0,
    uvdc: 0,
    uvac: 0,
    deltaValues: false,
    quantizerLevel: 0,
    loopfilterLevel: 0
  }));
  const segmentProbs = new Uint8Array([255, 255, 255]);
  const segmentsEnabled = b.readFlag();
  let segmentsUpdateMap = false;
  if (segmentsEnabled) {
    segmentsUpdateMap = b.readFlag();
    if (b.readFlag()) {
      const absolute = b.readFlag();
      for (const s of segments) s.deltaValues = !absolute;
      for (const s of segments) s.quantizerLevel = b.readOptionalSigned(7);
      for (const s of segments) s.loopfilterLevel = b.readOptionalSigned(6);
    }
    if (segmentsUpdateMap) for (let i = 0; i < 3; i++) segmentProbs[i] = b.readFlag() ? b.readLiteral(8) : 255;
    b.check();
  }

  // Loop filter (sections 9.4, 9.6).
  const simpleFilter = b.readFlag();
  const filterLevel = b.readLiteral(6);
  const sharpness = b.readLiteral(3);
  const lfAdjust = b.readFlag();
  const refDelta = [0, 0, 0, 0];
  const modeDelta = [0, 0, 0, 0];
  if (lfAdjust && b.readFlag()) {
    for (let i = 0; i < 4; i++) refDelta[i] = b.readOptionalSigned(6);
    for (let i = 0; i < 4; i++) modeDelta[i] = b.readOptionalSigned(6);
  }
  const numPartitions = 1 << b.readLiteral(2);
  b.check();

  // Token partitions (section 9.5): sizes of all but the last, then the data.
  const partitions: BoolDecoder[] = [];
  if (pos + 3 * (numPartitions - 1) > end) throw corrupt("the lossy image data is truncated");
  let partStart = pos + 3 * (numPartitions - 1);
  for (let i = 0; i < numPartitions - 1; i++) {
    const size = data[pos + 3 * i] | (data[pos + 3 * i + 1] << 8) | (data[pos + 3 * i + 2] << 16);
    if (partStart + size > end) throw corrupt("the lossy image data is truncated");
    partitions.push(new BoolDecoder(data, partStart, partStart + size));
    partStart += size;
  }
  partitions.push(new BoolDecoder(data, partStart, end));

  // Quantizers (section 9.6, 14.1).
  const yacAbs = b.readLiteral(7);
  const ydcDelta = b.readOptionalSigned(4);
  const y2dcDelta = b.readOptionalSigned(4);
  const y2acDelta = b.readOptionalSigned(4);
  const uvdcDelta = b.readOptionalSigned(4);
  const uvacDelta = b.readOptionalSigned(4);
  const dcQuant = (i: number) => DC_QUANT[i < 0 ? 0 : i > 127 ? 127 : i];
  const acQuant = (i: number) => AC_QUANT[i < 0 ? 0 : i > 127 ? 127 : i];
  for (let i = 0; i < (segmentsEnabled ? 4 : 1); i++) {
    const s = segments[i];
    const base = segmentsEnabled ? (s.deltaValues ? s.quantizerLevel + yacAbs : s.quantizerLevel) : yacAbs;
    s.ydc = dcQuant(base + ydcDelta);
    s.yac = acQuant(base);
    s.y2dc = dcQuant(base + y2dcDelta) * 2;
    s.y2ac = Math.max(8, Math.floor((acQuant(base + y2acDelta) * 155) / 100));
    s.uvdc = Math.min(132, dcQuant(base + uvdcDelta));
    s.uvac = acQuant(base + uvacDelta);
  }
  b.check();

  b.readLiteral(1); // refresh_entropy_probs: nothing to refresh in a still image

  // Token probability updates (section 13.4).
  const tokenProbs = COEFF_PROBS.slice();
  for (let i = 0; i < tokenProbs.length; i++) if (b.readBool(COEFF_UPDATE_PROBS[i])) tokenProbs[i] = b.readLiteral(8);
  b.check();

  const probSkipFalse = b.readLiteral(1) ? b.readLiteral(8) : -1;
  b.check();

  // Per-macroblock state.
  const ybuf = new Uint8Array(mbw * 16 * mbh * 16);
  const ubuf = new Uint8Array(mbw * 8 * mbh * 8);
  const vbuf = new Uint8Array(mbw * 8 * mbh * 8);
  const topBpred = new Uint8Array(mbw * 4); // defaults: B_DC_PRED
  const leftBpred = new Uint8Array(4);
  // Non-zero flags of the neighbouring blocks: y2, y x4, u x2, v x2.
  const topComplexity = new Uint8Array(mbw * 9);
  const leftComplexity = new Uint8Array(9);
  const topBorderY = new Uint8Array(width + 4 + 16).fill(127);
  let leftBorderY = new Uint8Array(17).fill(129);
  const topBorderU = new Uint8Array(8 * mbw).fill(127);
  let leftBorderU = new Uint8Array(9).fill(129);
  const topBorderV = new Uint8Array(8 * mbw).fill(127);
  let leftBorderV = new Uint8Array(9).fill(129);
  // What the loop filter needs of each macroblock.
  const mbLuma = new Uint8Array(mbw * mbh);
  const mbSegment = new Uint8Array(mbw * mbh);
  const mbFilterInner = new Uint8Array(mbw * mbh);

  const bpred = new Uint8Array(16);
  const blocks = new Int32Array(384);
  const y2 = new Int32Array(16);
  const ws = new Uint8Array(LUMA_STRIDE * 17);
  const uws = new Uint8Array(CHROMA_STRIDE * 9);
  const vws = new Uint8Array(CHROMA_STRIDE * 9);

  // read_coefficients: one 4x4 block's tokens (section 13), dequantised
  // into blocks[at..at+16]. Returns whether any coefficient was coded.
  const readCoefficients = (d: BoolDecoder, at: number, plane: number, context: number, dcq: number, acq: number, out: Int32Array): boolean => {
    const first = plane === Y_AFTER_Y2 ? 1 : 0;
    let complexity = context;
    let hasCoefficients = false;
    let skip = false;
    for (let i = first; i < 16; i++) {
      const probsAt = ((plane * 8 + COEFF_BANDS[i]) * 3 + complexity) * 11;
      const token = d.readTree(DCT_TOKEN_TREE, tokenProbs, probsAt, skip ? 2 : 0);
      if (token === DCT_EOB) break;
      if (token === 0) {
        skip = true;
        hasCoefficients = true;
        complexity = 0;
        continue;
      }
      let value = token;
      if (token >= DCT_CAT1) {
        const probs = PROB_DCT_CAT[token - DCT_CAT1];
        let extra = 0;
        for (let k = 0; probs[k]; k++) extra = extra + extra + (d.readBool(probs[k]) ? 1 : 0);
        value = DCT_CAT_BASE[token - DCT_CAT1] + extra;
      }
      skip = false;
      complexity = value === 1 ? 1 : 2;
      if (d.readFlag()) value = -value;
      const z = ZIGZAG[i];
      out[at + z] = value * (z > 0 ? acq : dcq);
      hasCoefficients = true;
    }
    d.check();
    return hasCoefficients;
  };

  for (let mby = 0; mby < mbh; mby++) {
    const d = partitions[mby % numPartitions];
    leftBpred.fill(0);
    leftComplexity.fill(0);
    for (let mbx = 0; mbx < mbw; mbx++) {
      const mbi = mby * mbw + mbx;

      // Macroblock header (section 19.3).
      const segment = segmentsEnabled && segmentsUpdateMap ? b.readTree(SEGMENT_ID_TREE, segmentProbs) : 0;
      const skipped = probSkipFalse >= 0 ? b.readBool(probSkipFalse) : false;
      const luma = b.readTree(KEYFRAME_YMODE_TREE, KEYFRAME_YMODE_PROBS);
      bpred.fill(0);
      if (luma === B_PRED) {
        for (let y = 0; y < 4; y++) {
          for (let x = 0; x < 4; x++) {
            const mode = b.readTree(KEYFRAME_BPRED_MODE_TREE, KEYFRAME_BPRED_MODE_PROBS, (topBpred[mbx * 4 + x] * 10 + leftBpred[y]) * 9);
            bpred[x + y * 4] = mode;
            topBpred[mbx * 4 + x] = mode;
            leftBpred[y] = mode;
          }
        }
      } else {
        const mode = LUMA_TO_INTRA[luma];
        for (let i = 0; i < 4; i++) {
          bpred[12 + i] = mode;
          leftBpred[i] = mode;
        }
      }
      const chroma = b.readTree(KEYFRAME_UV_MODE_TREE, KEYFRAME_UV_MODE_PROBS);
      for (let i = 0; i < 4; i++) topBpred[mbx * 4 + i] = bpred[12 + i];
      b.check();

      // Residuals (section 13).
      blocks.fill(0);
      let nonZeroDct = false;
      const tc = mbx * 9;
      if (!skipped) {
        const s = segments[segment];
        let plane = Y_WITH_DC;
        if (luma !== B_PRED) {
          y2.fill(0);
          const n = readCoefficients(d, 0, Y2, topComplexity[tc] + leftComplexity[0], s.y2dc, s.y2ac, y2);
          topComplexity[tc] = leftComplexity[0] = n ? 1 : 0;
          iwht4x4(y2);
          for (let k = 0; k < 16; k++) blocks[16 * k] = y2[k];
          plane = Y_AFTER_Y2;
        }
        for (let y = 0; y < 4; y++) {
          let left = leftComplexity[y + 1];
          for (let x = 0; x < 4; x++) {
            const at = (x + y * 4) * 16;
            const n = readCoefficients(d, at, plane, topComplexity[tc + x + 1] + left, s.ydc, s.yac, blocks);
            if (blocks[at] !== 0 || n) {
              nonZeroDct = true;
              idct4x4(blocks, at);
            }
            left = n ? 1 : 0;
            topComplexity[tc + x + 1] = left;
          }
          leftComplexity[y + 1] = left;
        }
        for (const j of [5, 7]) {
          for (let y = 0; y < 2; y++) {
            let left = leftComplexity[y + j];
            for (let x = 0; x < 2; x++) {
              const at = (x + y * 2 + (j === 5 ? 16 : 20)) * 16;
              const n = readCoefficients(d, at, CHROMA, topComplexity[tc + x + j] + left, s.uvdc, s.uvac, blocks);
              if (blocks[at] !== 0 || n) {
                nonZeroDct = true;
                idct4x4(blocks, at);
              }
              left = n ? 1 : 0;
              topComplexity[tc + x + j] = left;
            }
            leftComplexity[y + j] = left;
          }
        }
      } else {
        if (luma !== B_PRED) topComplexity[tc] = leftComplexity[0] = 0;
        for (let i = 1; i < 9; i++) topComplexity[tc + i] = leftComplexity[i] = 0;
      }

      // Luma prediction and reconstruction (section 12).
      createBorderLuma(ws, mbx, mby, mbw, topBorderY, leftBorderY);
      if (luma === B_PRED) {
        for (let sby = 0; sby < 4; sby++) {
          for (let sbx = 0; sbx < 4; sbx++) {
            const i = sbx + sby * 4;
            predictSubblock(ws, bpred[i], sbx * 4 + 1, sby * 4 + 1, LUMA_STRIDE);
            addResidue(ws, blocks, i * 16, sby * 4 + 1, sbx * 4 + 1, LUMA_STRIDE);
          }
        }
      } else {
        if (luma === 1) predictVpred(ws, 16, 1, 1, LUMA_STRIDE);
        else if (luma === 2) predictHpred(ws, 16, 1, 1, LUMA_STRIDE);
        else if (luma === 3) predictTmpred(ws, 16, 1, 1, LUMA_STRIDE);
        else predictDcpred(ws, 16, LUMA_STRIDE, mby !== 0, mbx !== 0);
        for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) addResidue(ws, blocks, (x + y * 4) * 16, 1 + y * 4, 1 + x * 4, LUMA_STRIDE);
      }
      leftBorderY[0] = ws[16];
      for (let i = 0; i < 16; i++) leftBorderY[i + 1] = ws[(i + 1) * LUMA_STRIDE + 16];
      for (let i = 0; i < 16; i++) topBorderY[mbx * 16 + i] = ws[16 * LUMA_STRIDE + 1 + i];
      const lw = mbw * 16;
      for (let y = 0; y < 16; y++) ybuf.set(ws.subarray((1 + y) * LUMA_STRIDE + 1, (1 + y) * LUMA_STRIDE + 17), (mby * 16 + y) * lw + mbx * 16);

      // Chroma.
      createBorderChroma(uws, mbx, mby, topBorderU, leftBorderU);
      createBorderChroma(vws, mbx, mby, topBorderV, leftBorderV);
      for (const w of [uws, vws]) {
        if (chroma === 0) predictDcpred(w, 8, CHROMA_STRIDE, mby !== 0, mbx !== 0);
        else if (chroma === 1) predictVpred(w, 8, 1, 1, CHROMA_STRIDE);
        else if (chroma === 2) predictHpred(w, 8, 1, 1, CHROMA_STRIDE);
        else predictTmpred(w, 8, 1, 1, CHROMA_STRIDE);
      }
      for (let y = 0; y < 2; y++) {
        for (let x = 0; x < 2; x++) {
          const i = x + y * 2;
          addResidue(uws, blocks, (16 + i) * 16, 1 + y * 4, 1 + x * 4, CHROMA_STRIDE);
          addResidue(vws, blocks, (20 + i) * 16, 1 + y * 4, 1 + x * 4, CHROMA_STRIDE);
        }
      }
      const setChromaBorder = (left: Uint8Array, top: Uint8Array, w: Uint8Array) => {
        left[0] = w[8];
        for (let i = 0; i < 8; i++) left[i + 1] = w[(i + 1) * CHROMA_STRIDE + 8];
        for (let i = 0; i < 8; i++) top[mbx * 8 + i] = w[8 * CHROMA_STRIDE + 1 + i];
      };
      setChromaBorder(leftBorderU, topBorderU, uws);
      setChromaBorder(leftBorderV, topBorderV, vws);
      const cw8 = mbw * 8;
      for (let y = 0; y < 8; y++) {
        const at = (mby * 8 + y) * cw8 + mbx * 8;
        ubuf.set(uws.subarray((1 + y) * CHROMA_STRIDE + 1, (1 + y) * CHROMA_STRIDE + 9), at);
        vbuf.set(vws.subarray((1 + y) * CHROMA_STRIDE + 1, (1 + y) * CHROMA_STRIDE + 9), at);
      }

      mbLuma[mbi] = luma;
      mbSegment[mbi] = segment;
      // Subblock edges are filtered in B_PRED macroblocks and in any with
      // non-zero coefficients.
      mbFilterInner[mbi] = luma === B_PRED || (!skipped && nonZeroDct) ? 1 : 0;
    }
    leftBorderY = new Uint8Array(17).fill(129);
    leftBorderU = new Uint8Array(9).fill(129);
    leftBorderV = new Uint8Array(9).fill(129);
  }

  // Loop filter (section 15), macroblock by macroblock in raster order.
  if (filterLevel > 0) {
    const lw = mbw * 16;
    const cw8 = mbw * 8;
    for (let mby = 0; mby < mbh; mby++) {
      for (let mbx = 0; mbx < mbw; mbx++) {
        const mbi = mby * mbw + mbx;
        // calculate_filter_parameters
        const seg = segments[mbSegment[mbi]];
        let level = filterLevel;
        if (segmentsEnabled) level = seg.deltaValues ? level + seg.loopfilterLevel : seg.loopfilterLevel;
        level = level < 0 ? 0 : level > 63 ? 63 : level;
        if (lfAdjust) {
          level += refDelta[0];
          if (mbLuma[mbi] === B_PRED) level += modeDelta[0];
        }
        level = level < 0 ? 0 : level > 63 ? 63 : level;
        if (level === 0) continue;
        let interior = level;
        if (sharpness > 0) {
          interior >>= sharpness > 4 ? 2 : 1;
          if (interior > 9 - sharpness) interior = 9 - sharpness;
        }
        if (interior === 0) interior = 1;
        const hev = level >= 40 ? 2 : level >= 15 ? 1 : 0;
        const mbEdge = (level + 2) * 2 + interior;
        const subEdge = level * 2 + interior;
        const inner = mbFilterInner[mbi] === 1;

        if (mbx > 0) {
          if (simpleFilter) {
            for (let y = 0; y < 16; y++) simpleSegment(mbEdge, ybuf, (mby * 16 + y) * lw + mbx * 16, 1);
          } else {
            for (let y = 0; y < 16; y++) macroblockFilter(hev, interior, mbEdge, ybuf, (mby * 16 + y) * lw + mbx * 16, 1);
            for (let y = 0; y < 8; y++) {
              macroblockFilter(hev, interior, mbEdge, ubuf, (mby * 8 + y) * cw8 + mbx * 8, 1);
              macroblockFilter(hev, interior, mbEdge, vbuf, (mby * 8 + y) * cw8 + mbx * 8, 1);
            }
          }
        }
        if (inner) {
          if (simpleFilter) {
            for (let x = 4; x < 16; x += 4) for (let y = 0; y < 16; y++) simpleSegment(subEdge, ybuf, (mby * 16 + y) * lw + mbx * 16 + x, 1);
          } else {
            for (let x = 4; x < 16; x += 4) for (let y = 0; y < 16; y++) subblockFilter(hev, interior, subEdge, ybuf, (mby * 16 + y) * lw + mbx * 16 + x, 1);
            for (let y = 0; y < 8; y++) {
              subblockFilter(hev, interior, subEdge, ubuf, (mby * 8 + y) * cw8 + mbx * 8 + 4, 1);
              subblockFilter(hev, interior, subEdge, vbuf, (mby * 8 + y) * cw8 + mbx * 8 + 4, 1);
            }
          }
        }
        if (mby > 0) {
          if (simpleFilter) {
            for (let x = 0; x < 16; x++) simpleSegment(mbEdge, ybuf, mby * 16 * lw + mbx * 16 + x, lw);
          } else {
            for (let x = 0; x < 16; x++) macroblockFilter(hev, interior, mbEdge, ybuf, mby * 16 * lw + mbx * 16 + x, lw);
            for (let x = 0; x < 8; x++) {
              macroblockFilter(hev, interior, mbEdge, ubuf, mby * 8 * cw8 + mbx * 8 + x, cw8);
              macroblockFilter(hev, interior, mbEdge, vbuf, mby * 8 * cw8 + mbx * 8 + x, cw8);
            }
          }
        }
        if (inner) {
          if (simpleFilter) {
            for (let y = 4; y < 16; y += 4) for (let x = 0; x < 16; x++) simpleSegment(subEdge, ybuf, (mby * 16 + y) * lw + mbx * 16 + x, lw);
          } else {
            for (let y = 4; y < 16; y += 4) for (let x = 0; x < 16; x++) subblockFilter(hev, interior, subEdge, ybuf, (mby * 16 + y) * lw + mbx * 16 + x, lw);
            for (let x = 0; x < 8; x++) {
              subblockFilter(hev, interior, subEdge, ubuf, (mby * 8 + 4) * cw8 + mbx * 8 + x, cw8);
              subblockFilter(hev, interior, subEdge, vbuf, (mby * 8 + 4) * cw8 + mbx * 8 + x, cw8);
            }
          }
        }
      }
    }
  }

  const rgba = new Uint8Array(width * height * 4);
  fillRgbaFancy(rgba, ybuf, ubuf, vbuf, width, height, mbw * 16);
  return { width, height, rgba };
}
