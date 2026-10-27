import zlib from "node:zlib";

// A PNG codec on node:zlib alone, for terminal previews and the toolbox.
//
// Reading covers every PNG the format allows: grey, grey+alpha, RGB, RGBA and
// palette images at every bit depth, tRNS transparency and Adam7 interlacing.
// 16-bit channels are scaled to 8 bits (sourceDepth says so, so a command can
// warn). An animated PNG is refused unless the caller only wants a preview, in
// which case its default image is read. Checked against PngSuite in the tests.
//
// Memory: decoding holds the compressed data, the inflated rows (at most
// 8 bytes a pixel, for 16-bit RGBA) and the RGBA result (4 bytes a pixel). An
// 8-bit RGBA image at MAX_PIXELS peaks near 2 x 160 MB.

export interface Image {
  width: number;
  height: number;
  rgba: Uint8Array; // width * height * 4
}

export interface RawChunk {
  type: string;
  data: Buffer;
}

export interface PngInfo {
  sourceDepth: number; // bits per channel in the file: 1, 2, 4, 8 or 16
  colorType: number;
  interlaced: boolean;
  animated: boolean; // an APNG; only its default image was read
  // Chunks that stay true when pixels are cut, moved or re-encoded without a
  // colour change: colour space (gAMA, cHRM, sRGB, iCCP), pixel size (pHYs)
  // and text. Written back by encodePng({ chunks }).
  chunks: RawChunk[];
}

export type PngErrorCode = "NOT_PNG" | "CORRUPT" | "UNSUPPORTED" | "TOO_LARGE" | "ANIMATED";

export class PngError extends Error {
  code: PngErrorCode;
  constructor(code: PngErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Decoding a huge sheet costs memory for no visible gain in a terminal.
const MAX_PIXELS = 40_000_000;
// The toolbox edits atlases, which run larger: an 8192 x 8192 sheet is the
// biggest it reads (about 270 MB a buffer, see Memory above).
export const MAX_TOOLBOX_PIXELS = 8192 * 8192;

const KEPT_CHUNKS = new Set(["gAMA", "cHRM", "sRGB", "iCCP", "pHYs", "tEXt", "zTXt", "iTXt"]);
// Ancillary chunks that must come before PLTE and IDAT; the rest go after.
const BEFORE_PLTE = new Set(["gAMA", "cHRM", "sRGB", "iCCP"]);
const BEFORE_IDAT = new Set(["pHYs"]);

export function isPng(buf: Buffer): boolean {
  return buf.length > 8 && buf.subarray(0, 8).equals(SIGNATURE);
}

interface Chunk {
  type: string;
  data: Buffer;
  offset: number; // of the length field
  crcOk: boolean;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(...parts: Buffer[]): number {
  let c = 0xffffffff;
  for (const buf of parts) for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Splits the file into chunks. strict: a chunk running past the end of the
// file, or a malformed chunk name, is an error rather than the end of the list.
function chunks(buf: Buffer, strict = false): Chunk[] {
  const out: Chunk[] = [];
  let pos = 8;
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("latin1", pos + 4, pos + 8);
    if (pos + 12 + len > buf.length) {
      if (strict) throw new PngError("CORRUPT", `the file is truncated (in the ${JSON.stringify(type)} chunk)`);
      break;
    }
    if (strict && !/^[A-Za-z]{4}$/.test(type)) throw new PngError("CORRUPT", `bad chunk name ${JSON.stringify(type)}`);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    const crcOk = crc32(buf.subarray(pos + 4, pos + 8), data) === buf.readUInt32BE(pos + 8 + len);
    out.push({ type, data, offset: pos, crcOk });
    pos += 12 + len;
    if (type === "IEND") break;
  }
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

// Reverses the row filters of one (sub-)image in place: `rows` rows of
// `stride` bytes, each preceded by its filter byte, starting at `start`. One
// tight loop per filter type: this is the hot path of every decode.
function unfilter(raw: Buffer, start: number, stride: number, rows: number, bpp: number) {
  for (let y = 0; y < rows; y++) {
    const at = start + y * (stride + 1);
    const filter = raw[at];
    const cur = at + 1;
    const prev = cur - (stride + 1); // only read when y > 0
    if (filter === 0) continue;
    if (filter > 4) throw new PngError("CORRUPT", `unknown row filter ${filter}`);
    if (filter === 1) {
      for (let x = bpp; x < stride; x++) raw[cur + x] = (raw[cur + x] + raw[cur + x - bpp]) & 0xff;
    } else if (filter === 2) {
      if (y > 0) for (let x = 0; x < stride; x++) raw[cur + x] = (raw[cur + x] + raw[prev + x]) & 0xff;
    } else if (filter === 3) {
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? raw[cur + x - bpp] : 0;
        const b = y > 0 ? raw[prev + x] : 0;
        raw[cur + x] = (raw[cur + x] + ((a + b) >> 1)) & 0xff;
      }
    } else if (y === 0) {
      // Paeth with no row above is Sub.
      for (let x = bpp; x < stride; x++) raw[cur + x] = (raw[cur + x] + raw[cur + x - bpp]) & 0xff;
    } else {
      for (let x = 0; x < bpp && x < stride; x++) raw[cur + x] = (raw[cur + x] + raw[prev + x]) & 0xff;
      for (let x = bpp; x < stride; x++) {
        const a = raw[cur + x - bpp];
        const b = raw[prev + x];
        const c = raw[prev + x - bpp];
        const p = a + b - c;
        const pa = p > a ? p - a : a - p;
        const pb = p > b ? p - b : b - p;
        const pc = p > c ? p - c : c - p;
        raw[cur + x] = (raw[cur + x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      }
    }
  }
}

// Adam7: seven passes, each a small image of every n-th pixel.
const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2]
];

interface Pass {
  x0: number;
  y0: number;
  dx: number;
  dy: number;
  w: number;
  h: number;
}

function passesOf(width: number, height: number, interlaced: boolean): Pass[] {
  if (!interlaced) return [{ x0: 0, y0: 0, dx: 1, dy: 1, w: width, h: height }];
  return ADAM7.map(([x0, y0, dx, dy]) => ({ x0, y0, dx, dy, w: Math.ceil((width - x0) / dx), h: Math.ceil((height - y0) / dy) })).filter(
    p => p.w > 0 && p.h > 0
  );
}

export interface ReadOptions {
  maxPixels?: number; // default MAX_TOOLBOX_PIXELS
  allowAnimated?: boolean; // read an APNG's default image instead of refusing
}

// Reads a PNG or throws a PngError saying why it cannot.
export function readPng(buf: Buffer, opts: ReadOptions = {}): { image: Image; info: PngInfo } {
  if (!isPng(buf)) {
    // A PNG sent through a text-mode transfer has its line endings rewritten.
    const mangled = buf.length > 8 && buf[0] === 0x89 && buf.toString("latin1", 1, 4) === "PNG";
    throw new PngError("NOT_PNG", mangled ? "the PNG signature is damaged (was it copied in text mode?)" : "not a PNG file");
  }
  const all = chunks(buf, true);
  if (all[0]?.type !== "IHDR" || all[0].data.length !== 13) throw new PngError("CORRUPT", "the header chunk (IHDR) is missing");
  for (const c of all) {
    // A damaged ancillary chunk only loses that chunk; a damaged critical one
    // (upper-case first letter) means the image itself cannot be trusted.
    if (!c.crcOk && c.type[0] === c.type[0].toUpperCase()) throw new PngError("CORRUPT", `the ${c.type} chunk is damaged (checksum mismatch)`);
  }
  const ok = all.filter(c => c.crcOk);
  const ihdr = all[0].data;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const depth = ihdr[8];
  const colorType = ihdr[9];
  const interlace = ihdr[12];
  if (!width || !height || width > 0x7fffffff || height > 0x7fffffff) throw new PngError("CORRUPT", `bad image size ${width}x${height}`);
  if (ihdr[10] !== 0 || ihdr[11] !== 0 || interlace > 1) throw new PngError("CORRUPT", "unknown compression, filter or interlace method");

  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colorType];
  if (!channels) throw new PngError("CORRUPT", `unknown colour type ${colorType}`);
  const depthOk = colorType === 3 ? [1, 2, 4, 8] : colorType === 0 ? [1, 2, 4, 8, 16] : [8, 16];
  if (!depthOk.includes(depth)) throw new PngError("CORRUPT", `bit depth ${depth} is not allowed for colour type ${colorType}`);

  const maxPixels = opts.maxPixels ?? MAX_TOOLBOX_PIXELS;
  if (width * height > maxPixels) {
    throw new PngError("TOO_LARGE", `${width}x${height} is ${(width * height / 1e6).toFixed(1)} megapixels; the limit is ${(maxPixels / 1e6).toFixed(1)}`);
  }

  const animated = ok.some(c => c.type === "acTL");
  if (animated && !opts.allowAnimated) throw new PngError("ANIMATED", "this is an animated PNG (APNG), which is not supported yet");

  const palette = ok.find(c => c.type === "PLTE")?.data;
  const trns = ok.find(c => c.type === "tRNS")?.data;
  if (colorType === 3 && !palette) throw new PngError("CORRUPT", "a palette image without a palette (PLTE)");
  const idat = all.filter(c => c.type === "IDAT");
  if (!idat.length) throw new PngError("CORRUPT", "no image data (IDAT)");

  const bitsPerPixel = channels * depth;
  const bpp = Math.max(1, bitsPerPixel >> 3); // bytes per pixel, for filters
  const passes = passesOf(width, height, interlace === 1);
  const strideOf = (w: number) => Math.ceil((w * bitsPerPixel) / 8);
  const expected = passes.reduce((n, p) => n + p.h * (strideOf(p.w) + 1), 0);

  // Bounded: a few bytes of zlib can claim gigabytes. Trailing bytes past the
  // image are tolerated, as libpng does.
  let raw: Buffer;
  try {
    raw = zlib.inflateSync(Buffer.concat(idat.map(c => c.data)), { maxOutputLength: expected + 65536, finishFlush: zlib.constants.Z_SYNC_FLUSH });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") throw new PngError("CORRUPT", "the image data is larger than its header says");
    throw new PngError("CORRUPT", `the image data does not decompress (${(err as Error).message})`);
  }
  if (raw.length < expected) throw new PngError("CORRUPT", "the image data is truncated");

  const rgba = new Uint8Array(width * height * 4);
  const max = (1 << depth) - 1;
  // tRNS for grey and RGB names one transparent colour at the file's own
  // depth, compared before any scaling.
  const trnsGrey = colorType === 0 && trns && trns.length >= 2 ? trns.readUInt16BE(0) & (depth === 16 ? 0xffff : max) : -1;
  const trnsRgb = colorType === 2 && trns && trns.length >= 6 ? [trns.readUInt16BE(0), trns.readUInt16BE(2), trns.readUInt16BE(4)] : undefined;
  const to8 = (v: number) => (depth === 8 ? v : depth === 16 ? Math.round(v / 257) : Math.round((v * 255) / max));
  const paletteSize = palette ? Math.floor(palette.length / 3) : 0;

  let start = 0;
  for (const p of passes) {
    const stride = strideOf(p.w);
    unfilter(raw, start, stride, p.h, bpp);
    // The i-th sample of a row, at the file's depth.
    const sample = (row: number, i: number): number => {
      if (depth === 8) return raw[row + i];
      if (depth === 16) return (raw[row + i * 2] << 8) | raw[row + i * 2 + 1];
      const perByte = 8 / depth;
      const byte = raw[row + Math.floor(i / perByte)];
      return (byte >> (8 - depth * ((i % perByte) + 1))) & max;
    };
    for (let y = 0; y < p.h; y++) {
      const row = start + y * (stride + 1) + 1;
      const outY = p.y0 + y * p.dy;
      if (colorType === 6 && depth === 8 && p.dx === 1) {
        rgba.set(raw.subarray(row, row + width * 4), outY * width * 4);
        continue;
      }
      for (let x = 0; x < p.w; x++) {
        const o = (outY * width + p.x0 + x * p.dx) * 4;
        if (colorType === 3) {
          const idx = sample(row, x);
          if (idx < paletteSize) {
            rgba[o] = palette![idx * 3];
            rgba[o + 1] = palette![idx * 3 + 1];
            rgba[o + 2] = palette![idx * 3 + 2];
          }
          rgba[o + 3] = trns && idx < trns.length ? trns[idx] : 255;
        } else if (colorType === 0 || colorType === 4) {
          const g = sample(row, x * channels);
          rgba[o] = rgba[o + 1] = rgba[o + 2] = to8(g);
          rgba[o + 3] = colorType === 4 ? to8(sample(row, x * channels + 1)) : g === trnsGrey ? 0 : 255;
        } else {
          const r = sample(row, x * channels);
          const g = sample(row, x * channels + 1);
          const b = sample(row, x * channels + 2);
          rgba[o] = to8(r);
          rgba[o + 1] = to8(g);
          rgba[o + 2] = to8(b);
          rgba[o + 3] =
            colorType === 6 ? to8(sample(row, x * channels + 3)) : trnsRgb && r === trnsRgb[0] && g === trnsRgb[1] && b === trnsRgb[2] ? 0 : 255;
        }
      }
    }
    start += p.h * (stride + 1);
  }

  const kept = ok.filter(c => KEPT_CHUNKS.has(c.type)).map(c => ({ type: c.type, data: Buffer.from(c.data) }));
  return {
    image: { width, height, rgba },
    info: { sourceDepth: depth, colorType, interlaced: interlace === 1, animated, chunks: kept }
  };
}

// For previews: anything it cannot read returns undefined, since a preview is
// optional and must never fail the command.
export function decodePng(buf: Buffer): Image | undefined {
  try {
    return readPng(buf, { maxPixels: MAX_PIXELS, allowAnimated: true }).image;
  } catch {
    return undefined;
  }
}

// ---- tEXt metadata: how a saved spritesheet remembers its grid ----

export function readText(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isPng(buf)) return out;
  for (const c of chunks(buf)) {
    if (c.type !== "tEXt") continue;
    const nul = c.data.indexOf(0);
    if (nul > 0) out[c.data.toString("latin1", 0, nul)] = c.data.toString("latin1", nul + 1);
  }
  return out;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(head.subarray(4), data), 0);
  return Buffer.concat([head, data, crc]);
}

export function textChunk(keyword: string, value: string): RawChunk {
  return { type: "tEXt", data: Buffer.concat([Buffer.from(keyword, "latin1"), Buffer.from([0]), Buffer.from(value, "latin1")]) };
}

const keywordOf = (c: RawChunk) => c.data.toString("latin1", 0, Math.max(0, c.data.indexOf(0)));

// Returns the PNG with a tEXt chunk (replacing any with the same keyword)
// inserted before IEND. Image tools ignore unknown text chunks.
export function withText(buf: Buffer, keyword: string, value: string): Buffer {
  if (!isPng(buf)) return buf;
  const parts: Buffer[] = [buf.subarray(0, 8)];
  for (const c of chunks(buf)) {
    if (c.type === "tEXt" && keywordOf(c) === keyword) continue;
    if (c.type === "IEND") {
      const t = textChunk(keyword, value);
      parts.push(chunk(t.type, t.data));
    }
    parts.push(buf.subarray(c.offset, c.offset + 12 + c.data.length));
  }
  return Buffer.concat(parts);
}

// ---- Encoder ----

export interface EncodeOptions {
  // Terminal previews: no filtering, no palette, quick compression.
  fast?: boolean;
  // Ancillary chunks to write, usually PngInfo.chunks from the source file.
  // A tEXt chunk here replaces any other one with the same keyword.
  chunks?: RawChunk[];
}

// Chooses the smallest lossless layout: a palette (1, 2, 4 or 8 bits a pixel)
// when the image has at most 256 colours, else RGB when it is fully opaque,
// else RGBA. Fully transparent pixels count as one colour (their RGB is
// written as 0), which no viewer can tell apart.
export function encodePng(img: Image, opts: EncodeOptions = {}): Buffer {
  const { width, height } = img;
  const src = img.rgba;
  const n = width * height;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);

  if (opts.fast) {
    ihdr[8] = 8;
    ihdr[9] = 6;
    const raw = Buffer.alloc(height * (width * 4 + 1));
    for (let y = 0; y < height; y++) {
      Buffer.from(src.buffer, src.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
    }
    return Buffer.concat([SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 1 })), chunk("IEND", Buffer.alloc(0))]);
  }

  const view = new DataView(src.buffer, src.byteOffset, src.byteLength);
  const keyAt = (i: number) => (src[i * 4 + 3] === 0 ? 0 : view.getUint32(i * 4));
  let opaque = true;
  const colours = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    if (src[i * 4 + 3] !== 255) opaque = false;
    const k = keyAt(i);
    if (colours.size <= 256 && !colours.has(k)) colours.set(k, colours.size);
  }

  let rows: Buffer; // unfiltered scanlines
  let stride: number;
  let bpp: number;
  const extra: Buffer[] = [];
  if (colours.size <= 256) {
    // Translucent entries first, so tRNS can stop at the last of them.
    const keys = [...colours.keys()].sort((a, b) => ((a & 0xff) === 255 ? 1 : 0) - ((b & 0xff) === 255 ? 1 : 0) || a - b);
    keys.forEach((k, i) => colours.set(k, i));
    const depth = keys.length <= 2 ? 1 : keys.length <= 4 ? 2 : keys.length <= 16 ? 4 : 8;
    ihdr[8] = depth;
    ihdr[9] = 3;
    const plte = Buffer.alloc(keys.length * 3);
    keys.forEach((k, i) => {
      plte[i * 3] = k >>> 24;
      plte[i * 3 + 1] = (k >>> 16) & 0xff;
      plte[i * 3 + 2] = (k >>> 8) & 0xff;
    });
    const translucent = keys.filter(k => (k & 0xff) !== 255).length;
    extra.push(chunk("PLTE", plte));
    if (translucent) extra.push(chunk("tRNS", Buffer.from(keys.slice(0, translucent).map(k => k & 0xff))));
    stride = Math.ceil((width * depth) / 8);
    bpp = 1;
    rows = Buffer.alloc(height * stride);
    const perByte = 8 / depth;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = colours.get(keyAt(y * width + x))!;
        rows[y * stride + Math.floor(x / perByte)] |= idx << (8 - depth * ((x % perByte) + 1));
      }
    }
  } else {
    const channels = opaque ? 3 : 4;
    ihdr[8] = 8;
    ihdr[9] = opaque ? 2 : 6;
    stride = width * channels;
    bpp = channels;
    rows = Buffer.alloc(height * stride);
    for (let i = 0; i < n; i++) {
      if (!opaque && src[i * 4 + 3] === 0) continue; // stays 0,0,0,0
      for (let c = 0; c < channels; c++) rows[i * channels + c] = src[i * 4 + c];
    }
  }

  // Row filters: none for palette images (as the PNG spec advises), else per
  // row the filter with the smallest sum of absolute signed bytes, libpng's
  // heuristic.
  const raw = Buffer.alloc(height * (stride + 1));
  const zero = new Uint8Array(stride);
  const out = new Uint8Array(stride);
  // Writes filter f's residuals (what the file stores) into `out`, and
  // returns their sum of absolute signed values, stopping once it reaches
  // `limit`. One tight loop per filter: this is the encoder's hot path.
  // Stores one residual byte and returns its absolute signed value.
  const put = (x: number, v: number) => {
    v &= 0xff;
    out[x] = v;
    return v < 128 ? v : 256 - v;
  };
  const filterRow = (f: number, cur: Uint8Array, prev: Uint8Array, limit: number): number => {
    let score = 0;
    let x = 0;
    if (f === 0) for (; x < stride && score < limit; x++) score += put(x, cur[x]);
    else if (f === 1) {
      for (; x < bpp && x < stride; x++) score += put(x, cur[x]);
      for (; x < stride && score < limit; x++) score += put(x, cur[x] - cur[x - bpp]);
    } else if (f === 2) for (; x < stride && score < limit; x++) score += put(x, cur[x] - prev[x]);
    else if (f === 3) {
      for (; x < bpp && x < stride; x++) score += put(x, cur[x] - (prev[x] >> 1));
      for (; x < stride && score < limit; x++) score += put(x, cur[x] - ((cur[x - bpp] + prev[x]) >> 1));
    } else {
      for (; x < bpp && x < stride; x++) score += put(x, cur[x] - prev[x]);
      for (; x < stride && score < limit; x++) {
        const a = cur[x - bpp];
        const b = prev[x];
        const c = prev[x - bpp];
        const p = a + b - c;
        const pa = p > a ? p - a : a - p;
        const pb = p > b ? p - b : b - p;
        const pc = p > c ? p - c : c - p;
        score += put(x, cur[x] - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c));
      }
    }
    return x < stride ? Infinity : score;
  };
  for (let y = 0; y < height; y++) {
    const cur = rows.subarray(y * stride, (y + 1) * stride);
    const prev = y ? rows.subarray((y - 1) * stride, y * stride) : zero;
    const at = y * (stride + 1);
    let best = 0;
    if (ihdr[9] !== 3) {
      // Every filter scored (stopping once it is beaten), the winner kept:
      // the minimum sum of absolute differences, libpng's heuristic.
      let bestScore = Infinity;
      for (let f = 0; f <= 4 && bestScore > 0; f++) {
        const score = filterRow(f, cur, prev, bestScore);
        if (score < bestScore) (bestScore = score), (best = f);
      }
    }
    raw[at] = best;
    filterRow(best, cur, prev, Infinity);
    raw.set(out, at + 1);
  }

  // A later chunk replaces an earlier one it conflicts with: tEXt with the
  // same keyword, any other kind that may appear once, and sRGB and iCCP,
  // which exclude each other.
  const ancillary: RawChunk[] = [];
  const colourSpace = new Set(["sRGB", "iCCP"]);
  const clash = (a: RawChunk, b: RawChunk) => {
    if (a.type === "tEXt" && b.type === "tEXt") return keywordOf(a) === keywordOf(b);
    if (a.type === b.type) return !a.type.endsWith("TXt");
    return colourSpace.has(a.type) && colourSpace.has(b.type);
  };
  for (const c of opts.chunks || []) {
    for (let i = ancillary.length - 1; i >= 0; i--) if (clash(ancillary[i], c)) ancillary.splice(i, 1);
    ancillary.push(c);
  }
  const write = (filter: (t: string) => boolean) => ancillary.filter(c => filter(c.type)).map(c => chunk(c.type, c.data));
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", ihdr),
    ...write(t => BEFORE_PLTE.has(t)),
    ...extra,
    ...write(t => BEFORE_IDAT.has(t)),
    // Level 9 costs several times level 6's time for a percent or two; worth it
    // only on palette images, which are small.
    chunk("IDAT", zlib.deflateSync(raw, ihdr[9] === 3 ? { level: 9, memLevel: 9 } : { level: 6 })),
    ...write(t => !BEFORE_PLTE.has(t) && !BEFORE_IDAT.has(t)),
    chunk("IEND", Buffer.alloc(0))
  ]);
}
