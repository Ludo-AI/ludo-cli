import type { Image } from "./png.js";
import { WebpError } from "./webp-error.js";

// Lossless WebP (VP8L) writing, ported from image-webp 0.2.4
// (https://github.com/image-rs/image-webp, commit f4d80bd), the WebP backend
// of Rust's `image` crate:
//   src/lossless/encoder/mod.rs     the bitstream: subtract-green and a
//                                   single "top" predictor, then literal
//                                   pixels and runs of repeats as backward
//                                   references to the pixel on the left;
//   src/lossless/encoder/huffman.rs length-limited prefix codes;
//   src/encoder.rs                  the RIFF container (the simple format).
// image-webp's encoder is deliberately simple and fast; it does not search
// for transforms, a palette or a colour cache the way cwebp does, so its
// files are larger than cwebp's.
//
// Changes from the original:
//  - the colour type is chosen from the image (grey or colour, with alpha
//    or opaque) instead of being the caller's;
//  - RGB under fully transparent pixels is written as 0, as encodePng does;
//  - codes are written one at a time (image-webp packs a pixel's four into
//    one 64-bit write); ties between equal frequencies may break differently
//    from Rust's BinaryHeap, which changes the codes, never their validity.
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

const CODE_LENGTH_CODE_ORDER = [17, 18, 0, 1, 2, 3, 4, 5, 16, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

class BitWriter {
  private bytes: Uint8Array = new Uint8Array(1 << 16);
  private length = 0;
  private buffer = 0; // fewer than 8 pending bits
  private nbits = 0;

  // n <= 24 bits at a time.
  writeBits(bits: number, n: number) {
    if (n > 24) {
      this.writeBits(bits & 0xffffff, 24);
      this.writeBits(Math.floor(bits / 0x1000000), n - 24);
      return;
    }
    this.buffer |= bits << this.nbits;
    this.nbits += n;
    while (this.nbits >= 8) {
      if (this.length === this.bytes.length) {
        const grown = new Uint8Array(this.bytes.length * 2);
        grown.set(this.bytes);
        this.bytes = grown;
      }
      this.bytes[this.length++] = this.buffer & 0xff;
      this.buffer >>>= 8;
      this.nbits -= 8;
    }
  }

  finish(): Uint8Array {
    if (this.nbits > 0) this.writeBits(0, 8 - this.nbits);
    return this.bytes.subarray(0, this.length);
  }
}

// ---- Prefix codes (src/lossless/encoder/huffman.rs) ----

function writeSingleEntryHuffmanTree(w: BitWriter, symbol: number) {
  w.writeBits(1, 2); // simple code, one symbol
  if (symbol <= 1) {
    w.writeBits(0, 1);
    w.writeBits(symbol, 1);
  } else {
    w.writeBits(1, 1);
    w.writeBits(symbol, 8);
  }
}

// A min-heap of [frequency, node] by frequency.
class Heap {
  private items: [number, number][] = [];
  get size() {
    return this.items.length;
  }
  push(item: [number, number]) {
    const a = this.items;
    a.push(item);
    for (let i = a.length - 1; i > 0; ) {
      const parent = (i - 1) >> 1;
      if (a[parent][0] <= a[i][0]) break;
      [a[parent], a[i]] = [a[i], a[parent]];
      i = parent;
    }
  }
  pop(): [number, number] {
    const a = this.items;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      for (let i = 0; ; ) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

const reverseBits = (code: number, len: number) => {
  let r = 0;
  for (let i = 0; i < len; i++) r |= ((code >> i) & 1) << (len - 1 - i);
  return r;
};

// Code lengths (at most lengthLimit) and codes for the symbols' frequencies.
// Returns false, with all lengths 0, when at most one symbol occurs.
function buildHuffmanTree(frequencies: Uint32Array, lengths: Uint8Array, codes: Uint16Array, lengthLimit: number): boolean {
  const n = frequencies.length;
  let used = 0;
  for (const f of frequencies) if (f > 0) used++;
  lengths.fill(0);
  codes.fill(0);
  if (used <= 1) return false;

  // Huffman's algorithm; internal nodes are numbered from n.
  const internal: [number, number][] = [];
  const heap = new Heap();
  frequencies.forEach((f, i) => f > 0 && heap.push([f, i]));
  while (heap.size > 1) {
    const [f1, i1] = heap.pop();
    const [f2, i2] = heap.pop();
    internal.push([i1, i2]);
    heap.push([f1 + f2, n + internal.length - 1]);
  }
  const stack: [number, number][] = [[heap.pop()[1], 0]];
  while (stack.length) {
    const [node, depth] = stack.pop()!;
    if (node < n) lengths[node] = depth;
    else {
      const [left, right] = internal[node - n];
      stack.push([left, depth + 1], [right, depth + 1]);
    }
  }

  // Limit the lengths: move codes down from the longest lengths until the
  // Kraft sum fits, then hand the lengths out again by frequency.
  let maxLength = 0;
  for (const l of lengths) maxLength = Math.max(maxLength, l);
  if (maxLength > lengthLimit) {
    const counts = new Array(16).fill(0);
    for (const l of lengths) counts[Math.min(l, lengthLimit)]++;
    let total = 0;
    for (let i = 1; i <= lengthLimit; i++) total += counts[i] << (lengthLimit - i);
    while (total > 1 << lengthLimit) {
      let i = lengthLimit - 1;
      while (counts[i] === 0) i--;
      counts[i]--;
      counts[lengthLimit]--;
      counts[i + 1] += 2;
      total--;
    }
    let len = lengthLimit;
    const order = Array.from(frequencies, (f, i) => [i, f]).sort((a, b) => a[1] - b[1]);
    for (const [i, f] of order) {
      if (f > 0) {
        while (counts[len] === 0) len--;
        lengths[i] = len;
        counts[len]--;
      }
    }
  }

  // Canonical codes, bit-reversed: the bitstream is least significant bit first.
  let code = 0;
  for (let len = 1; len <= lengthLimit; len++) {
    for (let i = 0; i < n; i++) {
      if (lengths[i] === len) codes[i] = reverseBits(code++, len);
    }
    code <<= 1;
  }
  return true;
}

function writeHuffmanTree(w: BitWriter, frequencies: Uint32Array, lengths: Uint8Array, codes: Uint16Array) {
  if (!buildHuffmanTree(frequencies, lengths, codes, 15)) {
    const symbol = frequencies.findIndex(f => f > 0);
    writeSingleEntryHuffmanTree(w, Math.max(0, symbol));
    return;
  }
  const codeLengthLengths = new Uint8Array(16);
  const codeLengthCodes = new Uint16Array(16);
  const codeLengthFrequencies = new Uint32Array(16);
  for (const l of lengths) codeLengthFrequencies[l]++;
  const singleCodeLengthLength = !buildHuffmanTree(codeLengthFrequencies, codeLengthLengths, codeLengthCodes, 7);

  w.writeBits(0, 1); // normal code length code
  w.writeBits(19 - 4, 4); // num_code_lengths - 4
  for (const i of CODE_LENGTH_CODE_ORDER) {
    if (i > 15 || codeLengthFrequencies[i] === 0) w.writeBits(0, 3);
    else if (singleCodeLengthLength) w.writeBits(1, 3);
    else w.writeBits(codeLengthLengths[i], 3);
  }
  if (lengths.length === 256) {
    w.writeBits(1, 1); // max_symbol is stored
    w.writeBits(3, 3); // length_nbits = 2 + 2 * 3
    w.writeBits(254, 8); // max_symbol - 2
  } else {
    w.writeBits(0, 1);
  }
  if (!singleCodeLengthLength) for (const l of lengths) w.writeBits(codeLengthCodes[l], codeLengthLengths[l]);
}

// The prefix symbol of a run length > 4 and its number of extra bits.
function lengthToSymbol(len: number): [number, number] {
  const v = len - 1;
  const highestBit = 31 - Math.clz32(v);
  const secondHighestBit = (v >> (highestBit - 1)) & 1;
  return [2 * highestBit + secondHighestBit, highestBit - 1];
}

// ---- The encoder (src/lossless/encoder/mod.rs) ----

function encodeFrameLossless(img: Image): Uint8Array {
  const { width, height } = img;
  const n = width * height;
  const pixels = new Uint8Array(img.rgba);
  let isAlpha = false;
  let isColor = false;
  for (let p = 0; p < n * 4; p += 4) {
    if (pixels[p + 3] === 0) pixels[p] = pixels[p + 1] = pixels[p + 2] = 0;
    else if (pixels[p + 3] !== 255) isAlpha = true;
    if (pixels[p + 3] === 0) isAlpha = true;
    if (pixels[p] !== pixels[p + 1] || pixels[p + 1] !== pixels[p + 2]) isColor = true;
  }

  const w = new BitWriter();
  w.writeBits(0x2f, 8); // signature
  w.writeBits(width - 1, 14);
  w.writeBits(height - 1, 14);
  w.writeBits(isAlpha ? 1 : 0, 1); // alpha_is_used
  w.writeBits(0, 3); // version

  // Subtract green (transform 2), then the predictor transform (0) with
  // 512-pixel blocks, every one mode 2 (top).
  w.writeBits(0b101, 3);
  w.writeBits(0b111001, 6);
  w.writeBits(0, 1); // the predictor image: no colour cache
  writeSingleEntryHuffmanTree(w, 2);
  for (let i = 0; i < 4; i++) writeSingleEntryHuffmanTree(w, 0);
  w.writeBits(0, 1); // no more transforms
  w.writeBits(0, 1); // no colour cache
  w.writeBits(0, 1); // no meta prefix codes

  // The transforms, forwards.
  for (let p = 0; p < n * 4; p += 4) {
    pixels[p] = (pixels[p] - pixels[p + 1]) & 0xff;
    pixels[p + 2] = (pixels[p + 2] - pixels[p + 1]) & 0xff;
  }
  const rowBytes = width * 4;
  for (let i = n * 4 - 1; i >= rowBytes; i--) pixels[i] = (pixels[i] - pixels[i - rowBytes]) & 0xff;
  for (let i = rowBytes - 1; i >= 4; i--) pixels[i] = (pixels[i] - pixels[i - 4]) & 0xff;
  pixels[3] = (pixels[3] - 255) & 0xff;

  const view = new DataView(pixels.buffer);
  const same = (a: number, b: number) => view.getUint32(a * 4) === view.getUint32(b * 4);
  // A pixel, then a run of up to 4096 copies of it as a backward reference
  // at distance 1 (distance code 2, the pixel on the left).
  const runAfter = (i: number) => {
    let run = 0;
    while (run < 4096 && i + 1 + run < n && same(i + 1 + run, i)) run++;
    return run;
  };

  const f0 = new Uint32Array(256);
  const f1 = new Uint32Array(280);
  const f2 = new Uint32Array(256);
  const f3 = new Uint32Array(256);
  if (!isColor) f0[0] = f2[0] = 1;
  if (!isAlpha) f3[0] = 1;
  for (let i = 0; i < n; ) {
    const p = i * 4;
    f1[pixels[p + 1]]++;
    if (isColor) {
      f0[pixels[p]]++;
      f2[pixels[p + 2]]++;
    }
    if (isAlpha) f3[pixels[p + 3]]++;
    const run = runAfter(i);
    if (run > 0) f1[256 + (run <= 4 ? run - 1 : lengthToSymbol(run)[0])]++;
    i += 1 + run;
  }

  const l0 = new Uint8Array(256);
  const l1 = new Uint8Array(280);
  const l2 = new Uint8Array(256);
  const l3 = new Uint8Array(256);
  const c0 = new Uint16Array(256);
  const c1 = new Uint16Array(280);
  const c2 = new Uint16Array(256);
  const c3 = new Uint16Array(256);
  writeHuffmanTree(w, f1, l1, c1);
  if (isColor) {
    writeHuffmanTree(w, f0, l0, c0);
    writeHuffmanTree(w, f2, l2, c2);
  } else {
    writeSingleEntryHuffmanTree(w, 0);
    writeSingleEntryHuffmanTree(w, 0);
  }
  if (isAlpha) writeHuffmanTree(w, f3, l3, c3);
  else writeSingleEntryHuffmanTree(w, 0); // the predicted alpha residual of an opaque image
  writeSingleEntryHuffmanTree(w, 1); // distance symbol 1: distance code 2

  for (let i = 0; i < n; ) {
    const p = i * 4;
    w.writeBits(c1[pixels[p + 1]], l1[pixels[p + 1]]);
    if (isColor) {
      w.writeBits(c0[pixels[p]], l0[pixels[p]]);
      w.writeBits(c2[pixels[p + 2]], l2[pixels[p + 2]]);
    }
    if (isAlpha) w.writeBits(c3[pixels[p + 3]], l3[pixels[p + 3]]);
    const run = runAfter(i);
    if (run > 0) {
      if (run <= 4) w.writeBits(c1[256 + run - 1], l1[256 + run - 1]);
      else {
        const [symbol, extraBits] = lengthToSymbol(run);
        w.writeBits(c1[256 + symbol], l1[256 + symbol]);
        w.writeBits((run - 1) & ((1 << extraBits) - 1), extraBits);
      }
    }
    i += 1 + run;
  }
  return w.finish();
}

/** A lossless WebP file (RIFF, one VP8L chunk) of the image. */
export function encodeWebp(img: Image): Buffer {
  const { width, height } = img;
  if (width < 1 || height < 1 || width > 16384 || height > 16384) throw new WebpError("TOO_LARGE", `a WebP is 1-16384 pixels a side, not ${width}x${height}`);
  if (img.rgba.length !== width * height * 4) throw new Error("the image needs 4 bytes a pixel");
  const frame = encodeFrameLossless(img);
  const pad = frame.length & 1;
  const out = Buffer.alloc(20 + frame.length + pad);
  out.write("RIFF", 0, "latin1");
  out.writeUInt32LE(12 + frame.length + pad, 4);
  out.write("WEBPVP8L", 8, "latin1");
  out.writeUInt32LE(frame.length, 16);
  out.set(frame, 20);
  return out;
}
