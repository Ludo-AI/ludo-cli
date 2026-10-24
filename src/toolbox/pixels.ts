import type { Image } from "../tty/png.js";
import type { Rect } from "./sheet.js";

// Lossless pixel edits for `ludo toolbox image`: trim, pad, extrude, scale
// (nearest neighbour, whole factors), flip and rotate (quarter turns). Pure:
// no files, no terminal. Each works on one image; tools apply them to every
// frame of a sheet with the same numbers, so the frames stay aligned.

// Where a trimmed image sat in the image it was cut from, so it can be put
// back (pad --restore) and exports can say `spriteSourceSize`.
export interface Trim {
  x: number;
  y: number;
  w: number;
  h: number;
  source_w: number;
  source_h: number;
}

export const TRIM_KEY = "ludo:trim";

// How many pixels of repeated border (extrude) surround every frame, so
// exports can keep it out of the frame rects.
export const EXTRUDE_KEY = "ludo:extrude";

export function parseExtrude(text: string | undefined): number | undefined {
  const n = Number(text);
  return text !== undefined && Number.isInteger(n) && n > 0 ? n : undefined;
}

export function parseTrim(text: string | undefined): Trim | undefined {
  try {
    const t = JSON.parse(text || "null");
    const ok = t && ["x", "y", "w", "h", "source_w", "source_h"].every(k => Number.isInteger(t[k]) && t[k] >= 0);
    if (ok && t.w > 0 && t.h > 0 && t.x + t.w <= t.source_w && t.y + t.h <= t.source_h) return t;
  } catch {
    // Not ours.
  }
  return undefined;
}

// Which pixels count as empty: transparent ones (alpha at or below the
// threshold), or on an image with no transparency at all, pixels of exactly
// the colour that fills most of its border (ImageMagick's -trim does the
// same with its default fuzz of 0).
export function emptiness(frames: Image[], threshold = 0): (rgba: Uint8Array, i: number) => boolean {
  if (frames.some(f => f.rgba.some((v, i) => i % 4 === 3 && v < 255))) return (px, i) => px[i + 3] <= threshold;
  const counts = new Map<number, number>();
  for (const { width, height, rgba } of frames) {
    const tally = (x: number, y: number) => {
      const i = (y * width + x) * 4;
      const key = (rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2];
      counts.set(key, (counts.get(key) || 0) + 1);
    };
    for (let x = 0; x < width; x++) tally(x, 0), tally(x, height - 1);
    for (let y = 0; y < height; y++) tally(0, y), tally(width - 1, y);
  }
  const bg = [...counts].sort((a, b) => b[1] - a[1])[0][0];
  return (px, i) => ((px[i] << 16) | (px[i + 1] << 8) | px[i + 2]) === bg;
}

// The smallest box holding every non-empty pixel of every frame (all the
// same size), or undefined when there are none.
export function contentBox(frames: Image[], isEmpty: (rgba: Uint8Array, i: number) => boolean): Rect | undefined {
  const { width, height } = frames[0];
  let [x0, y0, x1, y1] = [width, height, -1, -1];
  for (const { rgba } of frames) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (isEmpty(rgba, (y * width + x) * 4)) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? undefined : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

export interface Sides {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

// A bigger canvas with the image placed `left` and `top` in, the rest filled
// with `fill` (RGBA).
export function pad(img: Image, s: Sides, fill: [number, number, number, number] = [0, 0, 0, 0]): Image {
  const width = img.width + s.left + s.right;
  const height = img.height + s.top + s.bottom;
  const rgba = new Uint8Array(width * height * 4);
  if (fill.some(v => v)) for (let i = 0; i < rgba.length; i += 4) rgba.set(fill, i);
  for (let y = 0; y < img.height; y++) rgba.set(img.rgba.subarray(y * img.width * 4, (y + 1) * img.width * 4), ((y + s.top) * width + s.left) * 4);
  return { width, height, rgba };
}

// TexturePacker's extrude: the border pixels repeated `n` times outward, so
// filtering at the edge of a frame samples the frame and not its neighbour.
export function extrude(img: Image, n: number): Image {
  const width = img.width + 2 * n;
  const height = img.height + 2 * n;
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(img.height - 1, Math.max(0, y - n));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(img.width - 1, Math.max(0, x - n));
      const i = (sy * img.width + sx) * 4;
      rgba.set(img.rgba.subarray(i, i + 4), (y * width + x) * 4);
    }
  }
  return { width, height, rgba };
}

// Nearest neighbour by a whole factor: each pixel becomes an n x n block.
export function scaleUp(img: Image, n: number): Image {
  const width = img.width * n;
  const height = img.height * n;
  const rgba = new Uint8Array(width * height * 4);
  const row = new Uint8Array(width * 4);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      for (let k = 0; k < n; k++) row.set(img.rgba.subarray(i, i + 4), (x * n + k) * 4);
    }
    for (let k = 0; k < n; k++) rgba.set(row, (y * n + k) * width * 4);
  }
  return { width, height, rgba };
}

// Nearest neighbour down by a whole factor: each n x n block becomes the
// pixel at its centre (for an even n, the one just before it: ImageMagick's
// -sample), so scaleDown(scaleUp(img, n), n) is img exactly. A remainder
// that does not fill a block is dropped.
export function scaleDown(img: Image, n: number): Image {
  const width = Math.floor(img.width / n);
  const height = Math.floor(img.height / n);
  const rgba = new Uint8Array(width * height * 4);
  const c = (n - 1) >> 1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = ((y * n + c) * img.width + x * n + c) * 4;
      rgba.set(img.rgba.subarray(i, i + 4), (y * width + x) * 4);
    }
  }
  return { width, height, rgba };
}

export function flip(img: Image, axis: "horizontal" | "vertical"): Image {
  const { width, height } = img;
  const rgba = new Uint8Array(img.rgba.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [sx, sy] = axis === "horizontal" ? [width - 1 - x, y] : [x, height - 1 - y];
      const i = (sy * width + sx) * 4;
      rgba.set(img.rgba.subarray(i, i + 4), (y * width + x) * 4);
    }
  }
  return { width, height, rgba };
}

// Clockwise by quarter turns (1, 2 or 3).
export function rotate(img: Image, turns: number): Image {
  const t = ((turns % 4) + 4) % 4;
  if (t === 0) return { ...img, rgba: Uint8Array.from(img.rgba) };
  const { width: w, height: h } = img;
  const [width, height] = t === 2 ? [w, h] : [h, w];
  const rgba = new Uint8Array(img.rgba.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // The source pixel that lands on (x, y).
      const [sx, sy] = t === 1 ? [y, h - 1 - x] : t === 2 ? [w - 1 - x, h - 1 - y] : [w - 1 - y, x];
      const i = (sy * w + sx) * 4;
      rgba.set(img.rgba.subarray(i, i + 4), (y * width + x) * 4);
    }
  }
  return { width, height, rgba };
}

// ---- The trim record through each edit ----

// Trimming again: the new box is inside the old one.
export function trimAgain(prev: Trim | undefined, box: Rect, width: number, height: number): Trim {
  const base = prev ?? { x: 0, y: 0, w: width, h: height, source_w: width, source_h: height };
  return { x: base.x + box.x, y: base.y + box.y, w: box.w, h: box.h, source_w: base.source_w, source_h: base.source_h };
}

// Padding grows the box outward; past the source's edge there is nothing it
// can still mean, so it is dropped.
export function trimPadded(t: Trim | undefined, s: Sides): Trim | undefined {
  if (!t) return undefined;
  const out = { ...t, x: t.x - s.left, y: t.y - s.top, w: t.w + s.left + s.right, h: t.h + s.top + s.bottom };
  return out.x >= 0 && out.y >= 0 && out.x + out.w <= t.source_w && out.y + out.h <= t.source_h ? out : undefined;
}

export function trimScaled(t: Trim | undefined, up: number, down: number): Trim | undefined {
  if (!t) return undefined;
  const vals = [t.x, t.y, t.w, t.h, t.source_w, t.source_h];
  if (down > 1 && vals.some(v => v % down)) return undefined;
  const [x, y, w, h, source_w, source_h] = vals.map(v => (v * up) / down);
  return { x, y, w, h, source_w, source_h };
}

// By a factor that is not whole, the frame comes out at its own rounded size
// (w, h): the untrimmed size and offset scale and round alike, kept inside
// that size.
export function trimScaledBy(t: Trim | undefined, f: number, w: number, h: number): Trim | undefined {
  if (!t) return undefined;
  const [source_w, source_h] = [Math.round(t.source_w * f), Math.round(t.source_h * f)];
  if (source_w < w || source_h < h) return undefined;
  return { x: Math.min(Math.round(t.x * f), source_w - w), y: Math.min(Math.round(t.y * f), source_h - h), w, h, source_w, source_h };
}

export function trimFlipped(t: Trim | undefined, axis: "horizontal" | "vertical"): Trim | undefined {
  if (!t) return undefined;
  return axis === "horizontal" ? { ...t, x: t.source_w - t.x - t.w } : { ...t, y: t.source_h - t.y - t.h };
}

export function trimRotated(t: Trim | undefined, turns: number): Trim | undefined {
  if (!t) return undefined;
  const r = ((turns % 4) + 4) % 4;
  const { x, y, w, h, source_w: sw, source_h: sh } = t;
  if (r === 0) return { ...t };
  if (r === 2) return { ...t, x: sw - x - w, y: sh - y - h };
  return r === 1 ? { x: sh - y - h, y: x, w: h, h: w, source_w: sh, source_h: sw } : { x: y, y: sw - x - w, w: h, h: w, source_w: sh, source_h: sw };
}
