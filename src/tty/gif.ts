import { ByteStream, lzwEncode } from "./gif-lzw.js";
import { GifFormatError, lzwDecode, parseGif } from "./omggif.js";
import type { Image } from "./png.js";

// GIF89a: writing indexed frames, and reading a GIF back as the full frames a
// browser shows. The LZW coding is vendored (gifenc for writing, omggif for
// reading); the file layout and the compositing follow the GIF89a
// specification (https://www.w3.org/Graphics/GIF/spec-gif89a.txt).

export interface GifFrame {
  x: number;
  y: number;
  width: number;
  height: number;
  indices: Uint8Array; // width * height palette indices
  delay: number; // centiseconds
  disposal: 0 | 1 | 2 | 3; // 1: leave in place, 2: clear to transparent, 3: restore
}

export interface GifSpec {
  width: number;
  height: number;
  palette: [number, number, number][]; // 1-256 colours, the global colour table
  transparentIndex?: number; // the palette entry that means transparent
  loop: boolean; // play forever (a NETSCAPE2.0 block), else once
  frames: GifFrame[];
}

// Bits per index for n colours: a colour table holds 2^bits entries, at
// least 2.
const tableBits = (n: number) => Math.max(1, Math.ceil(Math.log2(n)));

export function encodeGif(spec: GifSpec): Uint8Array {
  const { width, height, palette, frames } = spec;
  if (!palette.length || palette.length > 256) throw new Error(`a GIF palette holds 1-256 colours, not ${palette.length}`);
  if (width < 1 || height < 1 || width > 65535 || height > 65535) throw new Error(`a GIF is 1-65535 pixels a side, not ${width}x${height}`);
  const bits = tableBits(palette.length);
  const out = new ByteStream(1 << 16);
  const u16 = (v: number) => out.writeBytes([v & 0xff, (v >> 8) & 0xff]);
  const transparent = spec.transparentIndex !== undefined;

  out.writeBytes([...Buffer.from("GIF89a")]);
  // Logical screen: a global colour table of 2^bits entries; the background
  // is the transparent entry, so a decoder that clears to the background
  // still clears to transparent.
  u16(width);
  u16(height);
  out.writeBytes([0x80 | ((bits - 1) << 4) | (bits - 1), transparent ? spec.transparentIndex! : 0, 0]);
  for (let i = 0; i < 1 << bits; i++) out.writeBytes(palette[i] ?? [0, 0, 0]);
  if (spec.loop && frames.length > 1) {
    // NETSCAPE2.0, loop count 0: forever.
    out.writeBytes([0x21, 0xff, 11, ...Buffer.from("NETSCAPE2.0"), 3, 1, 0, 0, 0]);
  }
  for (const f of frames) {
    if (f.width < 1 || f.height < 1 || f.x + f.width > width || f.y + f.height > height) throw new Error("a GIF frame must lie inside the image");
    if (f.indices.length !== f.width * f.height) throw new Error("a GIF frame needs one index per pixel");
    // Graphic Control Extension: disposal, delay, transparency.
    out.writeBytes([0x21, 0xf9, 4, (f.disposal << 2) | (transparent ? 1 : 0)]);
    u16(Math.max(0, Math.min(65535, Math.round(f.delay))));
    out.writeBytes([transparent ? spec.transparentIndex! : 0, 0]);
    // Image descriptor: no local colour table, not interlaced.
    out.writeByte(0x2c);
    u16(f.x);
    u16(f.y);
    u16(f.width);
    u16(f.height);
    out.writeByte(0);
    lzwEncode(f.indices, bits, out);
  }
  out.writeByte(0x3b);
  return out.bytes();
}

export class GifError extends Error {
  code: "CORRUPT" | "TOO_LARGE";
  constructor(code: GifError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export interface DecodedGif {
  width: number;
  height: number;
  frames: Image[]; // each the whole picture as shown at that point
  delays: number[]; // centiseconds, as stored (browsers show 0-1 as 10)
  loops: number | null; // NETSCAPE2.0 loop count (0: forever), null: none
}

export const isGif = (buf: Uint8Array) => buf.length >= 6 && /^GIF8[79]a$/.test(Buffer.from(buf.subarray(0, 6)).toString("latin1"));

// Rows of an interlaced image in the order they are stored (GIF89a,
// appendix E): every 8th from 0, every 8th from 4, every 4th from 2, every
// 2nd from 1.
function storedRows(height: number, interlaced: boolean): number[] {
  if (!interlaced) return Array.from({ length: height }, (_, y) => y);
  const rows: number[] = [];
  for (const [start, step] of [
    [0, 8],
    [4, 8],
    [2, 4],
    [1, 2]
  ]) {
    for (let y = start; y < height; y += step) rows.push(y);
  }
  return rows;
}

/**
 * Every frame of a GIF, composited the way browsers show them: a frame's
 * transparent pixels show what was there before, and its disposal (clear to
 * transparent, restore the previous picture, or leave) runs before the next
 * frame. The canvas starts transparent. Refuses more than `maxPixels` in all
 * (width x height x frames) before decoding anything.
 */
export function decodeGif(buf: Uint8Array, maxPixels: number): DecodedGif {
  let gif;
  try {
    gif = parseGif(buf);
  } catch (err) {
    if (err instanceof GifFormatError) throw new GifError("CORRUPT", err.message);
    throw err;
  }
  const { width, height, frames } = gif;
  if (!width || !height) throw new GifError("CORRUPT", `the GIF says it is ${width}x${height} pixels`);
  if (!frames.length) throw new GifError("CORRUPT", "the GIF has no images");
  if (width * height * frames.length > maxPixels) {
    throw new GifError("TOO_LARGE", `${frames.length} frames of ${width}x${height} is over ${Math.round(maxPixels / 1e6)} megapixels in all`);
  }

  const canvas = new Uint8Array(width * height * 4);
  const out: Image[] = [];
  for (const f of frames) {
    if (f.width * f.height > maxPixels) throw new GifError("TOO_LARGE", `a ${f.width}x${f.height} frame is over ${Math.round(maxPixels / 1e6)} megapixels`);
    if (f.palette_offset === null) throw new GifError("CORRUPT", "an image has no colour table");
    const saved = f.disposal === 3 ? canvas.slice() : undefined;
    const indices = new Uint8Array(f.width * f.height);
    let decoded: number;
    try {
      decoded = lzwDecode(buf, f.data_offset, indices);
    } catch (err) {
      if (err instanceof GifFormatError) throw new GifError("CORRUPT", err.message);
      throw err;
    }
    const rows = storedRows(f.height, f.interlaced);
    // Pixels outside the canvas are cut off.
    const x0 = f.x;
    const xEnd = Math.min(width, f.x + f.width);
    for (let i = 0; i < decoded; i++) {
      const index = indices[i];
      if (index === f.transparent_index || index >= f.palette_size) continue;
      const x = x0 + (i % f.width);
      const y = f.y + rows[Math.floor(i / f.width)];
      if (x >= xEnd || y >= height) continue;
      const o = (y * width + x) * 4;
      const p = f.palette_offset + index * 3;
      canvas[o] = buf[p];
      canvas[o + 1] = buf[p + 1];
      canvas[o + 2] = buf[p + 2];
      canvas[o + 3] = 255;
    }
    out.push({ width, height, rgba: canvas.slice() });
    if (f.disposal === 2) {
      for (let y = f.y; y < Math.min(height, f.y + f.height); y++) canvas.fill(0, (y * width + Math.min(width, x0)) * 4, (y * width + xEnd) * 4);
    } else if (saved) {
      canvas.set(saved);
    }
  }
  return { width, height, frames: out, delays: frames.map(f => f.delay), loops: gif.loop_count };
}
