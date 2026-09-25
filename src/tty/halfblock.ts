import type { Image } from "./png.js";

// Draws an image with "▀" cells: the glyph's top half takes one pixel's colour
// as foreground, its bottom half the pixel below as background, so each
// character cell shows two square-ish pixels. Plain text escape codes: it
// works over SSH and in tmux, no image protocol needed.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RenderOptions {
  maxCols: number;
  maxRows: number;
  truecolor: boolean;
}

function color256(r: number, g: number, b: number): number {
  const q = (v: number) => (v < 48 ? 0 : v < 115 ? 1 : Math.floor((v - 35) / 40));
  return 16 + 36 * q(r) + 6 * q(g) + q(b);
}

function fg(c: number[], t: boolean) {
  return t ? `\x1b[38;2;${c[0]};${c[1]};${c[2]}m` : `\x1b[38;5;${color256(c[0], c[1], c[2])}m`;
}
function bg(c: number[], t: boolean) {
  return t ? `\x1b[48;2;${c[0]};${c[1]};${c[2]}m` : `\x1b[48;5;${color256(c[0], c[1], c[2])}m`;
}

// The cell grid a region fits in: whole-number scaling, up for small pixel
// art (so a 32px sprite is not a smudge) and down for big sheets.
export function fit(region: Rect, opts: RenderOptions): { cols: number; rows: number; scale: number } {
  const maxW = Math.max(4, opts.maxCols);
  const maxH = Math.max(4, opts.maxRows * 2);
  let scale: number;
  if (region.w <= maxW && region.h <= maxH) {
    scale = 1 / Math.max(1, Math.floor(Math.min(maxW / region.w, maxH / region.h)));
  } else {
    scale = Math.max(region.w / maxW, region.h / maxH);
  }
  const cols = Math.max(1, Math.floor(region.w / scale));
  const pxRows = Math.max(2, Math.floor(region.h / scale));
  return { cols, rows: Math.ceil(pxRows / 2), scale };
}

// Returns one string per terminal row, each ending in a colour reset.
export function renderLines(img: Image, region: Rect, opts: RenderOptions): string[] {
  const { cols, rows, scale } = fit(region, opts);
  const pixel = (cx: number, py: number): number[] | undefined => {
    const x = Math.min(region.w - 1, Math.floor(cx * scale));
    const y = Math.floor(py * scale);
    if (y >= region.h) return undefined;
    const o = ((region.y + y) * img.width + region.x + x) * 4;
    // Mostly transparent pixels show the terminal's own background.
    return img.rgba[o + 3] < 128 ? undefined : [img.rgba[o], img.rgba[o + 1], img.rgba[o + 2]];
  };
  const lines: string[] = [];
  for (let r = 0; r < rows; r++) {
    let line = "";
    for (let c = 0; c < cols; c++) {
      const top = pixel(c, r * 2);
      const bottom = pixel(c, r * 2 + 1);
      if (top && bottom) line += fg(top, opts.truecolor) + bg(bottom, opts.truecolor) + "▀";
      else if (top) line += "\x1b[49m" + fg(top, opts.truecolor) + "▀";
      else if (bottom) line += "\x1b[49m" + fg(bottom, opts.truecolor) + "▄";
      else line += "\x1b[0m ";
    }
    lines.push(line + "\x1b[0m");
  }
  return lines;
}
