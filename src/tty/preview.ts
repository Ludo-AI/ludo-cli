import fs from "node:fs";
import { readText, withText, type Image } from "./png.js";
import { loadImage } from "./image.js";
import { renderLines, type Rect } from "./halfblock.js";
import { armRestore, sleep, type Visuals } from "./visuals.js";

// Still previews and spritesheet playback on stderr. Everything here returns
// quietly on any problem: a preview is a bonus, never a failure.

export interface Grid {
  cols: number;
  rows: number;
  frames: number;
  fps: number;
}

export const GRID_KEY = "ludo:grid";

// The grid is stored in the saved PNG itself, so a Ludo spritesheet plays in
// `ludo preview` however it is renamed or moved.
export function gridFromResult(result: any): Grid | undefined {
  const frames = Number(result?.num_frames);
  let cols = Number(result?.num_cols);
  let rows = Number(result?.num_rows);
  if (!frames || frames < 2) return undefined;
  if (!cols || !rows) {
    const side = Math.round(Math.sqrt(frames));
    if (side * side !== frames) return undefined;
    cols = rows = side;
  }
  const duration = Number(result?.duration);
  const fps = duration > 0 ? frames / duration : 10;
  return { cols, rows, frames, fps: Math.round(fps * 100) / 100 };
}

export function stampGrid(file: string, grid: Grid) {
  try {
    const buf = fs.readFileSync(file);
    const stamped = withText(buf, GRID_KEY, JSON.stringify(grid));
    if (stamped !== buf) fs.writeFileSync(file, stamped);
  } catch {
    // An unstamped sheet still previews as a still image.
  }
}

export function readGrid(buf: Buffer): Grid | undefined {
  try {
    const g = JSON.parse(readText(buf)[GRID_KEY] || "null");
    if (g && g.cols > 0 && g.rows > 0 && g.frames > 0) return { cols: g.cols, rows: g.rows, frames: g.frames, fps: g.fps > 0 ? g.fps : 10 };
  } catch {
    // Not ours.
  }
  return undefined;
}

// "8x4" -> {cols: 8, rows: 4}
export function parseGrid(spec: string): { cols: number; rows: number } | undefined {
  const m = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(spec.trim());
  return m ? { cols: Number(m[1]), rows: Number(m[2]) } : undefined;
}

function sizeFor(v: Visuals) {
  return { maxCols: Math.min(48, v.columns - 4), maxRows: 20, truecolor: v.truecolor };
}

export function drawStill(img: Image, v: Visuals, region?: Rect): number {
  const lines = renderLines(img, region || { x: 0, y: 0, w: img.width, h: img.height }, sizeFor(v));
  process.stderr.write(lines.map(l => "  " + l).join("\n") + "\n");
  return lines.length;
}

function frameRect(img: Image, grid: Grid, i: number): Rect | undefined {
  if (img.width % grid.cols !== 0 || img.height % grid.rows !== 0) return undefined;
  const w = img.width / grid.cols;
  const h = img.height / grid.rows;
  return { x: (i % grid.cols) * w, y: Math.floor(i / grid.cols) * h, w, h };
}

// Plays the sheet a few times in place, then leaves the last frame on screen.
// Never reads stdin; Ctrl-C stops it and the exit hook restores the cursor.
export async function playSheet(img: Image, grid: Grid, v: Visuals, loops = 3): Promise<boolean> {
  const first = frameRect(img, grid, 0);
  if (!first || grid.frames > grid.cols * grid.rows) return false;
  armRestore();
  const size = sizeFor(v);
  const frameMs = Math.max(40, Math.min(500, 1000 / grid.fps));
  const total = Math.min(grid.frames * loops, Math.ceil(6000 / frameMs)); // cap at ~6s
  let height = 0;
  // Ctrl-C mid-animation: leave the terminal tidy and exit like any interrupt.
  const onInt = () => {
    process.stderr.write("\x1b[0m\x1b[?25h\n");
    process.exit(130);
  };
  process.once("SIGINT", onInt);
  process.stderr.write("\x1b[?25l");
  for (let n = 0; n < total; n++) {
    const lines = renderLines(img, frameRect(img, grid, n % grid.frames)!, size);
    if (height) process.stderr.write(`\x1b[${height}A\r`);
    process.stderr.write(lines.map(l => "  " + l + "\x1b[K").join("\n") + "\n");
    height = lines.length;
    await sleep(frameMs);
  }
  process.stderr.write("\x1b[?25h");
  process.removeListener("SIGINT", onInt);
  return true;
}

// The preview for a saved file: plays a sheet whose grid is known, shows
// anything else as a still. Returns false when the file cannot be shown.
export async function previewFile(file: string, v: Visuals, gridOverride?: Grid): Promise<boolean> {
  if (!v.enabled) return false;
  try {
    const img = loadImage(file);
    if (!img) return false;
    const grid = gridOverride || readGrid(fs.readFileSync(file));
    if (grid && (await playSheet(img, grid, v))) return true;
    drawStill(img, v);
    return true;
  } catch {
    return false;
  }
}
