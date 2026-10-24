import { corrupt } from "./webp-error.js";

// The VP8L (lossless WebP) decoder, ported from image-webp 0.2.4
// (https://github.com/image-rs/image-webp, commit f4d80bd), the WebP backend
// of Rust's `image` crate:
//   src/lossless/mod.rs                       the code length order and the
//                                             distance map;
//   src/lossless/decoder/mod.rs               the bitstream: header,
//                                             transforms, prefix codes,
//                                             colour cache, backward
//                                             references;
//   src/lossless/decoder/huffman.rs           the two-level prefix code
//                                             tables;
//   src/lossless/decoder/reverse_transform.rs the four inverse transforms.
// The format is RFC 9649 (WebP), section 3.
//
// Changes from the original:
//  - the bit reader reads straight from the chunk (padded with zeros) and
//    fails only when a code runs past its end; image-webp's 56-bit buffer
//    could fail early on a pixel whose four codes and extra bits pass 56
//    bits;
//  - a simple prefix code naming the same symbol twice is one symbol that
//    takes no bits, as RFC 9649 section 3.7.2.1.1 allows ("Duplicate
//    symbols are allowed"); image-webp read a bit for it;
//  - predictor modes 14 and 15 (and the mode is the green value's low 4
//    bits) predict 0xff000000 like mode 0, as libwebp does
//    (src/dsp/lossless.c: "padding security sentinels"); image-webp left
//    such pixels unpredicted;
//  - every decoded pixel goes into the colour cache, including those read
//    from it, as libwebp does (src/dec/vp8l_dec.c, DecodeImageData);
//    image-webp skipped those, which differs only when a code reads an
//    empty cache entry;
//  - prefix table entries are 32 bits, so a secondary table may pass
//    image-webp's 4096 entries (it asserted instead);
//  - errors are WebpError; output is always RGBA.
//
// image-webp is dual-licensed MIT or Apache-2.0; it is used here under the
// MIT licence; the libwebp behaviours above are under libwebp's BSD licence
// (in webp.ts). image-webp's LICENSE-MIT names no copyright holder; the
// authors are the image-rs developers
// (https://github.com/image-rs/image-webp/graphs/contributors).
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

// (x, y) offsets of the 120 short distance codes (RFC 9649 section 4.2.2).
// prettier-ignore
const DISTANCE_MAP = [
  0, 1,  1, 0,  1, 1,  -1, 1, 0, 2,  2, 0,  1, 2,  -1, 2,
  2, 1,  -2, 1, 2, 2,  -2, 2, 0, 3,  3, 0,  1, 3,  -1, 3,
  3, 1,  -3, 1, 2, 3,  -2, 3, 3, 2,  -3, 2, 0, 4,  4, 0,
  1, 4,  -1, 4, 4, 1,  -4, 1, 3, 3,  -3, 3, 2, 4,  -2, 4,
  4, 2,  -4, 2, 0, 5,  3, 4,  -3, 4, 4, 3,  -4, 3, 5, 0,
  1, 5,  -1, 5, 5, 1,  -5, 1, 2, 5,  -2, 5, 5, 2,  -5, 2,
  4, 4,  -4, 4, 3, 5,  -3, 5, 5, 3,  -5, 3, 0, 6,  6, 0,
  1, 6,  -1, 6, 6, 1,  -6, 1, 2, 6,  -2, 6, 6, 2,  -6, 2,
  4, 5,  -4, 5, 5, 4,  -5, 4, 3, 6,  -3, 6, 6, 3,  -6, 3,
  0, 7,  7, 0,  1, 7,  -1, 7, 5, 5,  -5, 5, 7, 1,  -7, 1,
  4, 6,  -4, 6, 6, 4,  -6, 4, 2, 7,  -2, 7, 7, 2,  -7, 2,
  3, 7,  -3, 7, 7, 3,  -7, 3, 5, 6,  -5, 6, 6, 5,  -6, 5,
  8, 0,  4, 7,  -4, 7, 7, 4,  -7, 4, 8, 1,  8, 2,  6, 6,
  -6, 6, 8, 3,  5, 7,  -5, 7, 7, 5,  -7, 5, 8, 4,  6, 7,
  -6, 7, 7, 6,  -7, 6, 8, 5,  7, 7,  -7, 7, 8, 6,  8, 7
];

const GREEN = 0;
const RED = 1;
const BLUE = 2;
const ALPHA = 3;
const DIST = 4;
const ALPHABET_SIZE = [256 + 24, 256, 256, 256, 40];

const subsampleSize = (size: number, bits: number) => (size + (1 << bits) - 1) >> bits;

// ---- Bits ----

export class BitReader {
  private data: Uint8Array; // the chunk, with 4 zero bytes after it
  private bitPos = 0;
  private bitEnd: number;

  constructor(src: Uint8Array, start: number, end: number) {
    this.data = new Uint8Array(end - start + 4);
    this.data.set(src.subarray(start, end));
    this.bitEnd = (end - start) * 8;
  }

  // The next n <= 25 bits, zeros past the end.
  peek(n: number): number {
    const i = this.bitPos >>> 3;
    const d = this.data;
    const v = (d[i] | (d[i + 1] << 8) | (d[i + 2] << 16) | (d[i + 3] << 24)) >>> (this.bitPos & 7);
    return v & ((1 << n) - 1);
  }

  consume(n: number) {
    if (this.bitPos + n > this.bitEnd) throw corrupt("the lossless image data is truncated");
    this.bitPos += n;
  }

  readBits(n: number): number {
    const v = this.peek(n);
    this.consume(n);
    return v;
  }
}

// ---- Prefix codes (src/lossless/decoder/huffman.rs) ----

const MAX_ALLOWED_CODE_LENGTH = 15;
const MAX_TABLE_BITS = 10;

class HuffmanTree {
  // single >= 0: the code has one symbol and takes no bits.
  constructor(
    readonly single: number,
    private mask = 0,
    private primary = new Uint32Array(0), // (length << 16) | symbol, or | start of a secondary table
    private secondary = new Uint32Array(0) // (symbol << 4) | length
  ) {}

  static singleNode(symbol: number) {
    return new HuffmanTree(symbol);
  }

  static twoNode(zero: number, one: number) {
    if (zero === one) return new HuffmanTree(zero);
    return new HuffmanTree(-1, 1, new Uint32Array([(1 << 16) | zero, (1 << 16) | one]));
  }

  // The code length's next canonical codeword, bit-reversed (codes are read
  // least significant bit first), or the same one if it is the last.
  private static nextCodeword(codeword: number, tableSize: number): number {
    if (codeword === tableSize - 1) return codeword;
    const bit = 1 << (31 - Math.clz32(codeword ^ (tableSize - 1)));
    return (codeword & (bit - 1)) | bit;
  }

  static buildImplicit(codeLengths: ArrayLike<number>): HuffmanTree {
    let numSymbols = 0;
    const histogram = new Array(MAX_ALLOWED_CODE_LENGTH + 1).fill(0);
    for (let i = 0; i < codeLengths.length; i++) {
      histogram[codeLengths[i]]++;
      if (codeLengths[i] !== 0) numSymbols++;
    }
    if (numSymbols === 0) throw corrupt("the lossless image has an empty prefix code");
    if (numSymbols === 1) {
      for (let i = 0; i < codeLengths.length; i++) if (codeLengths[i] !== 0) return HuffmanTree.singleNode(i);
    }

    let maxLength = MAX_ALLOWED_CODE_LENGTH;
    while (maxLength > 1 && histogram[maxLength] === 0) maxLength--;

    const offsets = new Array(16).fill(0);
    let codespaceUsed = 0;
    offsets[1] = histogram[0];
    for (let i = 1; i < maxLength; i++) {
      offsets[i + 1] = offsets[i] + histogram[i];
      codespaceUsed = (codespaceUsed << 1) + histogram[i];
    }
    codespaceUsed = (codespaceUsed << 1) + histogram[maxLength];
    if (codespaceUsed !== 1 << maxLength) throw corrupt("the lossless image has an invalid prefix code");

    const tableBits = Math.min(maxLength, MAX_TABLE_BITS);
    const tableSize = 1 << tableBits;
    const primary = new Uint32Array(tableSize);

    const nextIndex = offsets.slice();
    const sorted = new Uint16Array(codeLengths.length);
    for (let symbol = 0; symbol < codeLengths.length; symbol++) sorted[nextIndex[codeLengths[symbol]]++] = symbol;

    let codeword = 0;
    let i = histogram[0];
    for (let length = 1; length <= tableBits; length++) {
      const currentTableEnd = 1 << length;
      for (let k = 0; k < histogram[length]; k++) {
        primary[codeword] = (length << 16) | sorted[i++];
        codeword = HuffmanTree.nextCodeword(codeword, currentTableEnd);
      }
      if (length < tableBits) primary.copyWithin(currentTableEnd, 0, currentTableEnd);
    }

    const secondary: number[] = [];
    if (maxLength > tableBits) {
      const primaryMask = tableSize - 1;
      let subtableStart = 0;
      let subtablePrefix = -1;
      for (let length = tableBits + 1; length <= maxLength; length++) {
        const subtableSize = 1 << (length - tableBits);
        for (let k = 0; k < histogram[length]; k++) {
          if ((codeword & primaryMask) !== subtablePrefix) {
            subtablePrefix = codeword & primaryMask;
            subtableStart = secondary.length;
            primary[subtablePrefix] = (length << 16) | subtableStart;
            for (let s = 0; s < subtableSize; s++) secondary.push(0);
          }
          secondary[subtableStart + (codeword >>> tableBits)] = (sorted[i++] << 4) | length;
          codeword = HuffmanTree.nextCodeword(codeword, 1 << length);
        }
        // More codes with this prefix: double the subtable.
        if (length < maxLength && (codeword & primaryMask) === subtablePrefix) {
          secondary.push(...secondary.slice(subtableStart));
          primary[subtablePrefix] = ((length + 1) << 16) | subtableStart;
        }
      }
    }
    return new HuffmanTree(-1, tableSize - 1, primary, Uint32Array.from(secondary));
  }

  readSymbol(br: BitReader): number {
    if (this.single >= 0) return this.single;
    const v = br.peek(MAX_ALLOWED_CODE_LENGTH);
    const entry = this.primary[v & this.mask];
    const length = entry >>> 16;
    if (length <= MAX_TABLE_BITS) {
      br.consume(length);
      return entry & 0xffff;
    }
    const sub = this.secondary[(entry & 0xffff) + ((v >>> MAX_TABLE_BITS) & ((1 << (length - MAX_TABLE_BITS)) - 1))];
    br.consume(sub & 0xf);
    return sub >>> 4;
  }
}

// ---- Inverse transforms (src/lossless/decoder/reverse_transform.rs) ----

const average2 = (a: number, b: number) => (a + b) >> 1;
const clampByte = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

// Adds the prediction of `mode` to the pixels [start, end) (byte offsets
// into RGBA data `width` pixels wide), left to right.
function predictRange(d: Uint8Array, start: number, end: number, width: number, mode: number) {
  const up = width * 4;
  switch (mode) {
    case 1:
      for (let i = start; i < end; i++) d[i] = (d[i] + d[i - 4]) & 0xff;
      return;
    case 2:
      for (let i = start; i < end; i++) d[i] = (d[i] + d[i - up]) & 0xff;
      return;
    case 3:
      for (let i = start; i < end; i++) d[i] = (d[i] + d[i - up + 4]) & 0xff;
      return;
    case 4:
      for (let i = start; i < end; i++) d[i] = (d[i] + d[i - up - 4]) & 0xff;
      return;
    case 5:
      for (let i = start; i < end; i++) d[i] = (d[i] + average2(average2(d[i - 4], d[i - up + 4]), d[i - up])) & 0xff;
      return;
    case 6:
      for (let i = start; i < end; i++) d[i] = (d[i] + average2(d[i - 4], d[i - up - 4])) & 0xff;
      return;
    case 7:
      for (let i = start; i < end; i++) d[i] = (d[i] + average2(d[i - 4], d[i - up])) & 0xff;
      return;
    case 8:
      for (let i = start; i < end; i++) d[i] = (d[i] + average2(d[i - up - 4], d[i - up])) & 0xff;
      return;
    case 9:
      for (let i = start; i < end; i++) d[i] = (d[i] + average2(d[i - up], d[i - up + 4])) & 0xff;
      return;
    case 10:
      for (let i = start; i < end; i++) d[i] = (d[i] + average2(average2(d[i - 4], d[i - up - 4]), average2(d[i - up], d[i - up + 4]))) & 0xff;
      return;
    case 11:
      // Select: L or T, whichever is nearer to L + T - TL in all four channels.
      for (let p = start; p < end; p += 4) {
        let predictLeft = 0;
        let predictTop = 0;
        for (let c = 0; c < 4; c++) {
          const l = d[p - 4 + c];
          const t = d[p - up + c];
          const predict = l + t - d[p - up - 4 + c];
          predictLeft += Math.abs(predict - l);
          predictTop += Math.abs(predict - t);
        }
        const from = predictLeft < predictTop ? p - 4 : p - up;
        for (let c = 0; c < 4; c++) d[p + c] = (d[p + c] + d[from + c]) & 0xff;
      }
      return;
    case 12:
      for (let i = start; i < end; i++) d[i] = (d[i] + clampByte(d[i - 4] + d[i - up] - d[i - up - 4])) & 0xff;
      return;
    case 13:
      for (let i = start; i < end; i++) {
        const a = average2(d[i - 4], d[i - up]);
        d[i] = (d[i] + clampByte(a + Math.trunc((a - d[i - up - 4]) / 2))) & 0xff;
      }
      return;
    default:
      // 0, and 14 and 15 as libwebp reads them: black, 0xff000000.
      for (let i = start + 3; i < end; i += 4) d[i] = (d[i] + 255) & 0xff;
  }
}

function applyPredictorTransform(d: Uint8Array, width: number, height: number, sizeBits: number, predictorData: Uint8Array) {
  const blockXsize = subsampleSize(width, sizeBits);
  // The top-left pixel predicts black, the rest of the top row L, the left
  // column T, whatever their block's mode.
  d[3] = (d[3] + 255) & 0xff;
  predictRange(d, 4, width * 4, width, 1);
  for (let y = 1; y < height; y++) for (let i = 0; i < 4; i++) d[y * width * 4 + i] = (d[y * width * 4 + i] + d[(y - 1) * width * 4 + i]) & 0xff;
  for (let y = 1; y < height; y++) {
    for (let bx = 0; bx < blockXsize; bx++) {
      const mode = predictorData[((y >> sizeBits) * blockXsize + bx) * 4 + 1] & 0xf;
      const start = (y * width + Math.max(bx << sizeBits, 1)) * 4;
      const end = (y * width + Math.min((bx + 1) << sizeBits, width)) * 4;
      predictRange(d, start, end, width, mode);
    }
  }
}

// color_transform_delta: (t * c) >> 5 on signed bytes.
const delta = (t: number, c: number) => (((t << 24) >> 24) * ((c << 24) >> 24)) >> 5;

function applyColorTransform(d: Uint8Array, width: number, height: number, sizeBits: number, data: Uint8Array) {
  const blockXsize = subsampleSize(width, sizeBits);
  for (let y = 0; y < height; y++) {
    const rowData = (y >> sizeBits) * blockXsize * 4;
    for (let x = 0; x < width; x++) {
      const t = rowData + (x >> sizeBits) * 4;
      const redToBlue = data[t];
      const greenToBlue = data[t + 1];
      const greenToRed = data[t + 2];
      const p = (y * width + x) * 4;
      const green = d[p + 1];
      const red = (d[p] + delta(greenToRed, green)) & 0xff;
      d[p] = red;
      d[p + 2] = (d[p + 2] + delta(greenToBlue, green) + delta(redToBlue, red)) & 0xff;
    }
  }
}

function applySubtractGreen(d: Uint8Array, n: number) {
  for (let p = 0; p < n * 4; p += 4) {
    d[p] = (d[p] + d[p + 1]) & 0xff;
    d[p + 2] = (d[p + 2] + d[p + 1]) & 0xff;
  }
}

// Expands the palette indices (in green, packed 2, 4 or 8 to a pixel when
// the palette is small) to colours, in place, bottom row first. Indices
// past the palette are transparent black.
function applyColorIndexing(d: Uint8Array, width: number, height: number, tableSize: number, table: Uint8Array) {
  const wbits = tableSize <= 2 ? 3 : tableSize <= 4 ? 2 : tableSize <= 16 ? 1 : 0;
  const packedWidth = subsampleSize(width, wbits);
  const bitsPerEntry = 8 >> wbits;
  const mask = (1 << bitsPerEntry) - 1;
  const xmask = (1 << wbits) - 1;
  const row = new Uint8Array(packedWidth);
  for (let y = height - 1; y >= 0; y--) {
    for (let i = 0; i < packedWidth; i++) row[i] = d[(y * packedWidth + i) * 4 + 1];
    for (let x = 0; x < width; x++) {
      const k = (row[x >> wbits] >> ((x & xmask) * bitsPerEntry)) & mask;
      const o = (y * width + x) * 4;
      if (k < tableSize) {
        d[o] = table[k * 4];
        d[o + 1] = table[k * 4 + 1];
        d[o + 2] = table[k * 4 + 2];
        d[o + 3] = table[k * 4 + 3];
      } else {
        d[o] = d[o + 1] = d[o + 2] = d[o + 3] = 0;
      }
    }
  }
}

// ---- The decoder (src/lossless/decoder/mod.rs) ----

type Transform =
  | { type: 0; sizeBits: number; data: Uint8Array }
  | { type: 1; sizeBits: number; data: Uint8Array }
  | { type: 2 }
  | { type: 3; tableSize: number; data: Uint8Array };

interface HuffmanInfo {
  xsize: number;
  bits: number;
  mask: number;
  image: Uint16Array;
  groups: HuffmanTree[][];
  cacheBits: number; // 0: no colour cache
  cache: Uint32Array; // RGBA packed little-endian
}

class LosslessDecoder {
  private transforms: (Transform | undefined)[] = [undefined, undefined, undefined, undefined];
  private order: number[] = [];

  constructor(
    private br: BitReader,
    private maxPixels: number
  ) {}

  decodeFrame(width: number, height: number, implicitDimensions: boolean): Uint8Array {
    const br = this.br;
    if (!implicitDimensions) {
      const signature = br.readBits(8);
      if (signature !== 0x2f) throw corrupt("the lossless image has a bad signature");
      const w = br.readBits(14) + 1;
      const h = br.readBits(14) + 1;
      if (w !== width || h !== height) throw corrupt(`the lossless image is ${w}x${h}, not ${width}x${height} as its container says`);
      br.readBits(1); // alpha_is_used: a hint
      if (br.readBits(3) !== 0) throw corrupt("unknown lossless format version");
    }
    if (width * height > this.maxPixels) throw corrupt(`the lossless image is too large: ${width}x${height}`);

    const transformedWidth = this.readTransforms(width, height);
    const buf = new Uint8Array(width * height * 4);
    this.decodeImageStream(transformedWidth, height, true, buf);

    let w = transformedWidth;
    for (let k = this.order.length - 1; k >= 0; k--) {
      const t = this.transforms[this.order[k]]!;
      if (t.type === 0) applyPredictorTransform(buf, w, height, t.sizeBits, t.data);
      else if (t.type === 1) applyColorTransform(buf, w, height, t.sizeBits, t.data);
      else if (t.type === 2) applySubtractGreen(buf, w * height);
      else {
        w = width;
        applyColorIndexing(buf, width, height, t.tableSize, t.data);
      }
    }
    return buf;
  }

  private readTransforms(width: number, height: number): number {
    const br = this.br;
    let xsize = width;
    while (br.readBits(1) === 1) {
      const type = br.readBits(2);
      if (this.transforms[type]) throw corrupt("the lossless image repeats a transform");
      this.order.push(type);
      if (type === 0 || type === 1) {
        const sizeBits = br.readBits(3) + 2;
        const bw = subsampleSize(xsize, sizeBits);
        const bh = subsampleSize(height, sizeBits);
        const data = new Uint8Array(bw * bh * 4);
        this.decodeImageStream(bw, bh, false, data);
        this.transforms[type] = { type, sizeBits, data };
      } else if (type === 2) {
        this.transforms[type] = { type };
      } else {
        const tableSize = br.readBits(8) + 1;
        const data = new Uint8Array(tableSize * 4);
        this.decodeImageStream(tableSize, 1, false, data);
        // The palette is coded as differences from the previous entry.
        for (let i = 4; i < data.length; i++) data[i] = (data[i] + data[i - 4]) & 0xff;
        const bits = tableSize <= 2 ? 3 : tableSize <= 4 ? 2 : tableSize <= 16 ? 1 : 0;
        xsize = subsampleSize(xsize, bits);
        this.transforms[type] = { type: 3, tableSize, data };
      }
    }
    return xsize;
  }

  private decodeImageStream(xsize: number, ysize: number, isArgbImage: boolean, data: Uint8Array) {
    const br = this.br;
    let cacheBits = 0;
    if (br.readBits(1) === 1) {
      cacheBits = br.readBits(4);
      if (cacheBits < 1 || cacheBits > 11) throw corrupt(`the lossless image has a bad colour cache size (${cacheBits} bits)`);
    }
    const info = this.readHuffmanCodes(isArgbImage, xsize, ysize, cacheBits);
    this.decodeImageData(xsize, ysize, info, data);
  }

  private readHuffmanCodes(readMeta: boolean, xsize: number, ysize: number, cacheBits: number): HuffmanInfo {
    const br = this.br;
    let numGroups = 1;
    let bits = 0;
    let hxsize = 1;
    let image = new Uint16Array(0);
    if (readMeta && br.readBits(1) === 1) {
      bits = br.readBits(3) + 2;
      hxsize = subsampleSize(xsize, bits);
      const hysize = subsampleSize(ysize, bits);
      const data = new Uint8Array(hxsize * hysize * 4);
      this.decodeImageStream(hxsize, hysize, false, data);
      image = new Uint16Array(hxsize * hysize);
      for (let i = 0; i < image.length; i++) {
        const code = (data[i * 4] << 8) | data[i * 4 + 1];
        image[i] = code;
        if (code >= numGroups) numGroups = code + 1;
      }
    }
    const groups: HuffmanTree[][] = [];
    for (let g = 0; g < numGroups; g++) {
      const group: HuffmanTree[] = [];
      for (let j = 0; j < 5; j++) group.push(this.readHuffmanCode(ALPHABET_SIZE[j] + (j === 0 && cacheBits ? 1 << cacheBits : 0)));
      groups.push(group);
    }
    return { xsize: hxsize, bits, mask: bits === 0 ? 0xffff : (1 << bits) - 1, image, groups, cacheBits, cache: new Uint32Array(cacheBits ? 1 << cacheBits : 0) };
  }

  private readHuffmanCode(alphabetSize: number): HuffmanTree {
    const br = this.br;
    if (br.readBits(1) === 1) {
      // Simple code length code: one or two symbols.
      const numSymbols = br.readBits(1) + 1;
      const isFirst8Bits = br.readBits(1);
      const zero = br.readBits(1 + 7 * isFirst8Bits);
      if (zero >= alphabetSize) throw corrupt("the lossless image has a bad prefix code");
      if (numSymbols === 1) return HuffmanTree.singleNode(zero);
      const one = br.readBits(8);
      if (one >= alphabetSize) throw corrupt("the lossless image has a bad prefix code");
      return HuffmanTree.twoNode(zero, one);
    }
    const codeLengthCodeLengths = new Uint8Array(19);
    const numCodeLengths = 4 + br.readBits(4);
    for (let i = 0; i < numCodeLengths; i++) codeLengthCodeLengths[CODE_LENGTH_CODE_ORDER[i]] = br.readBits(3);
    return HuffmanTree.buildImplicit(this.readHuffmanCodeLengths(codeLengthCodeLengths, alphabetSize));
  }

  private readHuffmanCodeLengths(codeLengthCodeLengths: Uint8Array, numSymbols: number): Uint8Array {
    const br = this.br;
    const table = HuffmanTree.buildImplicit(codeLengthCodeLengths);
    let maxSymbol = numSymbols;
    if (br.readBits(1) === 1) {
      const lengthNbits = 2 + 2 * br.readBits(3);
      const maxMinusTwo = br.readBits(lengthNbits);
      if (maxMinusTwo > numSymbols - 2) throw corrupt("the lossless image has a bad prefix code");
      maxSymbol = 2 + maxMinusTwo;
    }
    const codeLengths = new Uint8Array(numSymbols);
    let prevCodeLen = 8;
    let symbol = 0;
    while (symbol < numSymbols) {
      if (maxSymbol === 0) break;
      maxSymbol--;
      const codeLen = table.readSymbol(br);
      if (codeLen < 16) {
        codeLengths[symbol++] = codeLen;
        if (codeLen !== 0) prevCodeLen = codeLen;
      } else {
        const slot = codeLen - 16;
        const extraBits = [2, 3, 7][slot];
        const repeatOffset = [3, 3, 11][slot];
        if (extraBits === undefined) throw corrupt("the lossless image has a bad prefix code");
        const repeat = br.readBits(extraBits) + repeatOffset;
        if (symbol + repeat > numSymbols) throw corrupt("the lossless image has a bad prefix code");
        codeLengths.fill(codeLen === 16 ? prevCodeLen : 0, symbol, symbol + repeat);
        symbol += repeat;
      }
    }
    return codeLengths;
  }

  private decodeImageData(width: number, height: number, info: HuffmanInfo, data: Uint8Array) {
    const br = this.br;
    const numValues = width * height;
    const cache = info.cache;
    const cacheShift = 32 - info.cacheBits;
    const insert = (p: number) => {
      const color = (data[p + 3] << 24) | (data[p] << 16) | (data[p + 1] << 8) | data[p + 2];
      cache[Math.imul(0x1e35a7bd, color) >>> cacheShift] = data[p] | (data[p + 1] << 8) | (data[p + 2] << 16) | (data[p + 3] << 24);
    };
    const lookup = (k: number, p: number) => {
      const c = cache[k];
      data[p] = c & 0xff;
      data[p + 1] = (c >>> 8) & 0xff;
      data[p + 2] = (c >>> 16) & 0xff;
      data[p + 3] = c >>> 24;
    };
    const groupAt = (x: number, y: number) => (info.bits === 0 ? 0 : info.image[(y >> info.bits) * info.xsize + (x >> info.bits)]);

    let tree = info.groups[groupAt(0, 0)];
    let index = 0;
    let nextBlockStart = 0;
    while (index < numValues) {
      if (index >= nextBlockStart) {
        const x = index % width;
        const y = (index - x) / width;
        nextBlockStart = Math.min(x | info.mask, width - 1) + y * width + 1;
        tree = info.groups[groupAt(x, y)];
        // Every code of one symbol: the block is one colour and takes no bits.
        if (tree[GREEN].single >= 0 && tree[RED].single >= 0 && tree[BLUE].single >= 0 && tree[ALPHA].single >= 0 && tree[GREEN].single < 256) {
          const n = (info.bits === 0 ? numValues : nextBlockStart) - index;
          const [r, g, b, a] = [tree[RED].single, tree[GREEN].single, tree[BLUE].single, tree[ALPHA].single];
          for (let i = 0; i < n; i++) {
            const p = (index + i) * 4;
            data[p] = r;
            data[p + 1] = g;
            data[p + 2] = b;
            data[p + 3] = a;
          }
          if (info.cacheBits) insert(index * 4);
          index += n;
          continue;
        }
      }

      const code = tree[GREEN].readSymbol(br);
      if (code < 256) {
        const p = index * 4;
        data[p + 1] = code;
        data[p] = tree[RED].readSymbol(br);
        data[p + 2] = tree[BLUE].readSymbol(br);
        data[p + 3] = tree[ALPHA].readSymbol(br);
        if (info.cacheBits) insert(p);
        index++;
      } else if (code < 256 + 24) {
        // A backward reference: length, then distance.
        const length = copyDistance(br, code - 256);
        const distCode = copyDistance(br, tree[DIST].readSymbol(br));
        let dist: number;
        if (distCode > 120) dist = distCode - 120;
        else {
          dist = DISTANCE_MAP[(distCode - 1) * 2] + DISTANCE_MAP[(distCode - 1) * 2 + 1] * width;
          if (dist < 1) dist = 1;
        }
        if (index < dist || numValues - index < length) throw corrupt("the lossless image has a backward reference out of the image");
        // Byte by byte, so a copy may overlap what it writes.
        const to = index * 4;
        const from = to - dist * 4;
        for (let i = 0; i < length * 4; i++) data[to + i] = data[from + i];
        if (info.cacheBits) for (let i = 0; i < length; i++) insert(to + i * 4);
        index += length;
      } else {
        if (!info.cacheBits) throw corrupt("the lossless image uses a colour cache it does not have");
        const k = code - 280;
        if (k >= cache.length) throw corrupt("the lossless image has a bad colour cache index");
        lookup(k, index * 4);
        insert(index * 4);
        index++;
      }
    }
  }
}

// get_copy_distance: a length or distance from its prefix symbol and extra bits.
function copyDistance(br: BitReader, prefix: number): number {
  if (prefix < 4) return prefix + 1;
  const extraBits = (prefix - 2) >> 1;
  const offset = (2 + (prefix & 1)) << extraBits;
  return offset + br.readBits(extraBits) + 1;
}

/**
 * Decodes a VP8L bitstream (data[start..end]) to RGBA. With
 * `implicitDimensions` (an ALPH chunk) there is no header and the size is
 * given; otherwise the header must match it.
 */
export function decodeVp8l(data: Uint8Array, start: number, end: number, width: number, height: number, implicitDimensions: boolean, maxPixels: number): Uint8Array {
  return new LosslessDecoder(new BitReader(data, start, end), maxPixels).decodeFrame(width, height, implicitDimensions);
}

/** The size, alpha hint and validity of a VP8L header. */
export function vp8lHeader(data: Uint8Array, start: number, end: number): { width: number; height: number; alpha: boolean } | undefined {
  if (end - start < 5 || data[start] !== 0x2f) return undefined;
  const bits = (data[start + 1] | (data[start + 2] << 8) | (data[start + 3] << 16) | (data[start + 4] << 24)) >>> 0;
  if (bits >>> 29 !== 0) return undefined;
  return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1, alpha: ((bits >>> 28) & 1) === 1 };
}
