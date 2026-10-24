import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliError, EXIT } from "../errors.js";
import { encodePng, MAX_TOOLBOX_PIXELS, readPng, readText, textChunk, PngError, type Image, type PngInfo, type RawChunk } from "../tty/png.js";
import { decodeGif, GifError, isGif } from "../tty/gif.js";
import { joinFrames } from "./sheet.js";
import { gifFps } from "./gif.js";
import { convertToPng } from "../tty/image.js";
import { decodeWebp, isWebp, WebpError } from "../tty/webp.js";
import { readGrid, GRID_KEY, type Grid } from "../tty/preview.js";
import { EXTRUDE_KEY, parseExtrude, parseTrim, TRIM_KEY, type Trim } from "./pixels.js";
import { ENGINE_FILE, writeEngineFile } from "../tty/engines.js";
import type { Ctx } from "../generate.js";
import { noteInput } from "../telemetry.js";

// Reading and writing the toolbox's files. The image work stays in pure
// functions; this is the only place that touches the disk.

export interface Loaded {
  file: string;
  image: Image;
  info: PngInfo;
  grid?: Grid; // the ludo:grid stamp, when the sheet has one
  trim?: Trim; // the ludo:trim stamp: where a trimmed image (or each frame) sat
  extrude?: number; // the ludo:extrude stamp: repeated border around each frame
  animation?: "gif" | "webp"; // read from an animated GIF or WebP: its frames laid out as a sheet, `grid` from its timing
}

// What a sheet says about its frames beyond the grid.
export interface Layout {
  trim?: Trim;
  extrude?: number;
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
  if (isGif(buf)) {
    noteInput("gif", false);
    return loadGif(file, buf);
  }
  if (isWebp(buf)) {
    noteInput("webp", false);
    return loadWebp(file, buf);
  }
  const converted = !buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  // JPEG and the rest go through a converter the system already has, as
  // previews do.
  if (converted && !/\.png$/i.test(file)) {
    const tmp = path.join(os.tmpdir(), `ludo-toolbox-${process.pid}-${Date.now()}.png`);
    try {
      if (!convertToPng(file, tmp)) {
        throw new CliError(
          `Cannot read ${file}: the toolbox reads PNG, GIF and WebP, and found no converter for other formats`,
          EXIT.BAD_INPUT,
          process.platform === "darwin" ? "Convert it to PNG first." : "Convert it to PNG first, or install ImageMagick or ffmpeg."
        );
      }
      buf = fs.readFileSync(tmp);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
  try {
    const { image, info } = readPng(buf);
    const text = readText(buf);
    const grid = readGrid(buf);
    noteInput(converted ? path.extname(file).slice(1) || "other" : "png", !!grid);
    return { file, image, info, grid, trim: parseTrim(text[TRIM_KEY]), extrude: parseExtrude(text[EXTRUDE_KEY]) };
  } catch (err) {
    if (!(err instanceof PngError)) throw err;
    const hint =
      err.code === "TOO_LARGE" ? "Split it into smaller images first." : err.code === "ANIMATED" ? "Export its frames as separate PNGs first." : undefined;
    throw new CliError(`Cannot read ${file}: ${err.message}`, EXIT.BAD_INPUT, hint);
  }
}

// A GIF reads as its frames, as browsers show them, side by side in a
// near-square grid: a sheet every sheet tool takes. The grid's fps comes
// from its delays (gifFps).
function loadGif(file: string, buf: Buffer): Loaded {
  let gif;
  try {
    gif = decodeGif(buf, MAX_TOOLBOX_PIXELS);
  } catch (err) {
    if (!(err instanceof GifError)) throw err;
    throw new CliError(`Cannot read ${file}: ${err.message}`, EXIT.BAD_INPUT, err.code === "TOO_LARGE" ? "Split it into shorter GIFs first." : undefined);
  }
  return asSheet(file, gif.frames, "gif", gifFps(gif.delays));
}

// An animated WebP reads like a GIF; a still one is a plain image. The
// grid's fps comes from its durations (webpFps).
function loadWebp(file: string, buf: Buffer): Loaded {
  let webp;
  try {
    webp = decodeWebp(buf, { maxPixels: MAX_TOOLBOX_PIXELS });
  } catch (err) {
    if (!(err instanceof WebpError)) throw err;
    const hint = err.code === "TOO_LARGE" ? (webpIsAnimated(buf) ? "Split it into shorter animations first." : "Split it into smaller images first.") : undefined;
    throw new CliError(`Cannot read ${file}: ${err.message}`, EXIT.BAD_INPUT, hint);
  }
  if (!webp.animated) return { file, image: webp.frames[0], info: noInfo() };
  return asSheet(file, webp.frames, "webp", webpFps(webp.durations));
}

// The animation flag of a VP8X header.
const webpIsAnimated = (buf: Buffer) => buf.toString("latin1", 12, 16) === "VP8X" && (buf[20] & 2) !== 0;

const noInfo = (): PngInfo => ({ sourceDepth: 8, colorType: 6, interlaced: false, animated: false, chunks: [] });

// Frames side by side in a near-square grid, as `sprite join` lays them out.
function asSheet(file: string, frames: Image[], animation: "gif" | "webp", fps: number): Loaded {
  const n = frames.length;
  if (n === 1) return { file, image: frames[0], info: noInfo(), animation };
  const cols = Math.ceil(Math.sqrt(n));
  const { sheet, rows } = joinFrames(frames, cols);
  return { file, image: sheet, info: noInfo(), animation, grid: { cols, rows, frames: n, fps } };
}

// The frame rate of WebP frame durations (milliseconds). Durations of 10 ms
// or less count as 100 ms, the rule gifFps applies to GIF delays of 0-1 cs
// (browsers' rule for GIF, taken for WebP too). A whole fps whose frame
// length every duration is within 1 ms of (however the encoder rounded it)
// wins, the one nearest the average if several do; otherwise the average,
// to 2 decimals.
export function webpFps(durations: number[]): number {
  const played = durations.map(d => (d <= 10 ? 100 : d));
  const average = 1000 / (played.reduce((a, b) => a + b, 0) / played.length);
  let best = 0;
  for (let fps = 1; fps <= 120; fps++) {
    if (played.every(d => Math.abs(d - 1000 / fps) < 1) && (!best || Math.abs(fps - average) < Math.abs(best - average))) best = fps;
  }
  return best || Math.round(average * 100) / 100;
}

// The source's colour space and pixel size, for files made from it; its text
// (including any old grid, trim or extrude stamp) does not carry over unless
// passed again.
export function carriedChunks(src: Loaded, grid?: Grid, layout: Layout = {}): RawChunk[] {
  const chunks = src.info.chunks.filter(c => KEEP.has(c.type));
  if (grid) chunks.push(textChunk(GRID_KEY, JSON.stringify(grid)));
  if (layout.trim) chunks.push(textChunk(TRIM_KEY, JSON.stringify(layout.trim)));
  if (layout.extrude) chunks.push(textChunk(EXTRUDE_KEY, String(layout.extrude)));
  return chunks;
}

// The --engine file for a sheet just written, next to it. Empty without
// --engine (or a project's "engine").
export function engineFiles(ctx: Ctx, sheet: string, image: { width: number; height: number }, grid: Grid, layout: Layout = {}, animation?: string): string[] {
  const engine = ctx.globals.engine;
  if (!engine) return [];
  try {
    return writeEngineFile(engine, sheet, image.width, image.height, grid, layout, animation);
  } catch (err) {
    throw new CliError(`Could not write the ${ENGINE_FILE[engine]} for ${shown(sheet)}: ${(err as Error).message}`, EXIT.BAD_INPUT);
  }
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
