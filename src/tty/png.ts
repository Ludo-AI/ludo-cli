import zlib from "node:zlib";

// A small PNG decoder for terminal previews, on node:zlib alone. It covers
// what generators and sprite tools write: 8-bit grey, grey+alpha, RGB, RGBA
// and palette images (1/2/4/8-bit, with tRNS transparency); 16-bit channels
// keep their high byte. Interlaced (Adam7) images are declined. Anything it
// cannot read returns undefined: a preview is optional and must never fail
// the command.

export interface Image {
  width: number;
  height: number;
  rgba: Uint8Array; // width * height * 4
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Decoding a huge sheet costs memory for no visible gain in a terminal.
const MAX_PIXELS = 40_000_000;

export function isPng(buf: Buffer): boolean {
  return buf.length > 8 && buf.subarray(0, 8).equals(SIGNATURE);
}

interface Chunk {
  type: string;
  data: Buffer;
  offset: number; // of the length field
}

function chunks(buf: Buffer): Chunk[] {
  const out: Chunk[] = [];
  let pos = 8;
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("latin1", pos + 4, pos + 8);
    if (pos + 12 + len > buf.length) break;
    out.push({ type, data: buf.subarray(pos + 8, pos + 8 + len), offset: pos });
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

export function decodePng(buf: Buffer): Image | undefined {
  try {
    if (!isPng(buf)) return undefined;
    const all = chunks(buf);
    const ihdr = all.find(c => c.type === "IHDR")?.data;
    if (!ihdr) return undefined;
    const width = ihdr.readUInt32BE(0);
    const height = ihdr.readUInt32BE(4);
    const depth = ihdr[8];
    const colorType = ihdr[9];
    const interlace = ihdr[12];
    if (!width || !height || width * height > MAX_PIXELS || interlace !== 0) return undefined;

    const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colorType];
    if (!channels) return undefined;
    if (colorType === 3 ? ![1, 2, 4, 8].includes(depth) : colorType === 0 ? ![1, 2, 4, 8, 16].includes(depth) : ![8, 16].includes(depth)) {
      return undefined;
    }

    const palette = all.find(c => c.type === "PLTE")?.data;
    const trns = all.find(c => c.type === "tRNS")?.data;
    if (colorType === 3 && !palette) return undefined;

    const raw = zlib.inflateSync(Buffer.concat(all.filter(c => c.type === "IDAT").map(c => c.data)));
    const bitsPerPixel = channels * depth;
    const bpp = Math.max(1, bitsPerPixel >> 3); // bytes per pixel, for filters
    const stride = Math.ceil((width * bitsPerPixel) / 8);
    if (raw.length < height * (stride + 1)) return undefined;

    // Unfilter in place, row by row.
    const lines = Buffer.alloc(height * stride);
    let prev = Buffer.alloc(stride);
    for (let y = 0; y < height; y++) {
      const filter = raw[y * (stride + 1)];
      const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
      const cur = lines.subarray(y * stride, (y + 1) * stride);
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? cur[x - bpp] : 0;
        const b = prev[x];
        const c = x >= bpp ? prev[x - bpp] : 0;
        let v = src[x];
        if (filter === 1) v += a;
        else if (filter === 2) v += b;
        else if (filter === 3) v += (a + b) >> 1;
        else if (filter === 4) v += paeth(a, b, c);
        else if (filter !== 0) return undefined;
        cur[x] = v & 0xff;
      }
      prev = cur;
    }

    const rgba = new Uint8Array(width * height * 4);
    const sample = (row: Buffer, i: number): number => {
      // The i-th sample of a row, scaled to 0-255.
      if (depth === 8) return row[i];
      if (depth === 16) return row[i * 2];
      const perByte = 8 / depth;
      const byte = row[Math.floor(i / perByte)];
      const shift = 8 - depth * ((i % perByte) + 1);
      const v = (byte >> shift) & ((1 << depth) - 1);
      return colorType === 3 ? v : Math.round((v * 255) / ((1 << depth) - 1));
    };
    // Grey/RGB tRNS names one transparent color, in the image's own depth.
    const trnsGrey = colorType === 0 && trns && trns.length >= 2 ? trns.readUInt16BE(0) : undefined;
    const trnsRgb = colorType === 2 && trns && trns.length >= 6 ? [trns.readUInt16BE(0), trns.readUInt16BE(2), trns.readUInt16BE(4)] : undefined;
    const scaleTrns = (v: number) => (depth === 16 ? v >> 8 : depth === 8 ? v : Math.round((v * 255) / ((1 << depth) - 1)));

    for (let y = 0; y < height; y++) {
      const row = lines.subarray(y * stride, (y + 1) * stride);
      for (let x = 0; x < width; x++) {
        const o = (y * width + x) * 4;
        if (colorType === 3) {
          const idx = sample(row, x);
          rgba[o] = palette![idx * 3] ?? 0;
          rgba[o + 1] = palette![idx * 3 + 1] ?? 0;
          rgba[o + 2] = palette![idx * 3 + 2] ?? 0;
          rgba[o + 3] = trns && idx < trns.length ? trns[idx] : 255;
        } else if (colorType === 0 || colorType === 4) {
          const g = sample(row, x * channels);
          rgba[o] = rgba[o + 1] = rgba[o + 2] = g;
          rgba[o + 3] = colorType === 4 ? sample(row, x * channels + 1) : trnsGrey !== undefined && g === scaleTrns(trnsGrey) ? 0 : 255;
        } else {
          const r = sample(row, x * channels);
          const g = sample(row, x * channels + 1);
          const b = sample(row, x * channels + 2);
          rgba[o] = r;
          rgba[o + 1] = g;
          rgba[o + 2] = b;
          rgba[o + 3] =
            colorType === 6
              ? sample(row, x * channels + 3)
              : trnsRgb && r === scaleTrns(trnsRgb[0]) && g === scaleTrns(trnsRgb[1]) && b === scaleTrns(trnsRgb[2])
                ? 0
                : 255;
        }
      }
    }
    return { width, height, rgba };
  } catch {
    return undefined;
  }
}

// ---- tEXt metadata: how a saved spritesheet remembers its grid ----

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

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

// Returns the PNG with a tEXt chunk (replacing any with the same keyword)
// inserted before IEND. Image tools ignore unknown text chunks.
export function withText(buf: Buffer, keyword: string, value: string): Buffer {
  if (!isPng(buf)) return buf;
  const parts: Buffer[] = [buf.subarray(0, 8)];
  for (const c of chunks(buf)) {
    if (c.type === "tEXt" && c.data.toString("latin1", 0, c.data.indexOf(0)) === keyword) continue;
    const whole = buf.subarray(c.offset, c.offset + 12 + c.data.length);
    if (c.type === "IEND") {
      const data = Buffer.concat([Buffer.from(keyword, "latin1"), Buffer.from([0]), Buffer.from(value, "latin1")]);
      const head = Buffer.alloc(8);
      head.writeUInt32BE(data.length, 0);
      head.write("tEXt", 4, "latin1");
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
      parts.push(head, data, crc);
    }
    parts.push(whole);
  }
  return Buffer.concat(parts);
}

// Minimal encoder for tests and fixtures: 8-bit RGBA, no filtering.
export function encodePng(img: Image): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "latin1");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(img.height * (img.width * 4 + 1));
  for (let y = 0; y < img.height; y++) {
    Buffer.from(img.rgba.buffer, img.rgba.byteOffset + y * img.width * 4, img.width * 4).copy(raw, y * (img.width * 4 + 1) + 1);
  }
  return Buffer.concat([SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
