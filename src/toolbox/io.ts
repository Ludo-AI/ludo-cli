import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliError, EXIT } from "../errors.js";
import { encodePng, readPng, readText, textChunk, PngError, type Image, type PngInfo, type RawChunk } from "../tty/png.js";
import { convertToPng } from "../tty/image.js";
import { readGrid, GRID_KEY, type Grid } from "../tty/preview.js";
import { parseTrim, TRIM_KEY, type Trim } from "./pixels.js";

// Reading and writing the toolbox's files. The image work stays in pure
// functions; this is the only place that touches the disk.

export interface Loaded {
  file: string;
  image: Image;
  info: PngInfo;
  grid?: Grid; // the ludo:grid stamp, when the sheet has one
  trim?: Trim; // the ludo:trim stamp: where a trimmed image (or each frame) sat
}

const KEEP = new Set(["gAMA", "cHRM", "sRGB", "iCCP", "pHYs"]);

export function loadImageFile(file: string): Loaded {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(file);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new CliError(`File not found: ${file}`, EXIT.USAGE);
    if (code === "EISDIR") throw new CliError(`${file} is a folder, not an image`, EXIT.USAGE);
    throw err;
  }
  // WebP, JPEG and the rest go through a converter the system already has,
  // as previews do.
  if (!buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && !/\.png$/i.test(file)) {
    const tmp = path.join(os.tmpdir(), `ludo-toolbox-${process.pid}-${Date.now()}.png`);
    try {
      if (!convertToPng(file, tmp)) {
        throw new CliError(
          `Cannot read ${file}: the toolbox reads PNG, and found no converter for other formats`,
          EXIT.BAD_INPUT,
          process.platform === "darwin" ? "Convert it to PNG first." : "Convert it to PNG first, or install dwebp (libwebp), ImageMagick or ffmpeg."
        );
      }
      buf = fs.readFileSync(tmp);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
  try {
    const { image, info } = readPng(buf);
    return { file, image, info, grid: readGrid(buf), trim: parseTrim(readText(buf)[TRIM_KEY]) };
  } catch (err) {
    if (!(err instanceof PngError)) throw err;
    const hint =
      err.code === "TOO_LARGE" ? "Split it into smaller images first." : err.code === "ANIMATED" ? "Export its frames as separate PNGs first." : undefined;
    throw new CliError(`Cannot read ${file}: ${err.message}`, EXIT.BAD_INPUT, hint);
  }
}

// The source's colour space and pixel size, for files made from it; its text
// (including any old grid or trim stamp) does not carry over.
export function carriedChunks(src: Loaded, grid?: Grid, trim?: Trim): RawChunk[] {
  const chunks = src.info.chunks.filter(c => KEEP.has(c.type));
  if (grid) chunks.push(textChunk(GRID_KEY, JSON.stringify(grid)));
  if (trim) chunks.push(textChunk(TRIM_KEY, JSON.stringify(trim)));
  return chunks;
}

export function writePng(file: string, image: Image, chunks: RawChunk[] = []) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, encodePng(image, { chunks }));
}

// <dir>/<base>, or <base>-2, -3... when taken: never overwrite.
export function freeName(dir: string, base: string, ext = ""): string {
  let target = path.join(dir, `${base}${ext}`);
  for (let n = 2; fs.existsSync(target); n++) target = path.join(dir, `${base}-${n}${ext}`);
  return target;
}

export const baseOf = (file: string) => path.basename(file).replace(/\.[^.]+$/, "") || "image";

// Relative to the working folder when inside it, else absolute.
export const shown = (p: string) => {
  const rel = path.relative(process.cwd(), p);
  return !rel ? p : rel.startsWith("..") || path.isAbsolute(rel) ? path.resolve(p) : rel;
};
