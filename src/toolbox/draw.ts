import type { Image } from "../tty/png.js";
import { ADVANCE, GLYPH_H, GLYPH_W, GLYPHS } from "./font.js";
import { scaleUp } from "./pixels.js";
import { resizeSmooth } from "./resample.js";

// Drawing on an RGBA image, for the pictures the preview tools make: filled
// and outlined boxes, lines, a checkerboard, images composited over, and
// text in font.ts's bitmap font. Everything clips to the image, and colours
// with alpha under 255 blend over what is there (source-over), so overlays
// can be translucent. Pure: no files.

export type Rgba = readonly [number, number, number, number];

export function canvas(width: number, height: number, fill: Rgba): Image {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < rgba.length; i += 4) rgba.set(fill, i);
  return { width, height, rgba };
}

// Source-over of one colour, with its alpha scaled by `cover` (0-1).
export function blend(img: Image, x: number, y: number, c: Rgba, cover = 1) {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const i = (y * img.width + x) * 4;
  const a = (c[3] / 255) * cover;
  if (a <= 0) return;
  const d = img.rgba;
  if (a >= 1) {
    d[i] = c[0];
    d[i + 1] = c[1];
    d[i + 2] = c[2];
    d[i + 3] = 255;
    return;
  }
  const da = d[i + 3] / 255;
  const oa = a + da * (1 - a);
  for (let k = 0; k < 3; k++) d[i + k] = Math.round((c[k] * a + d[i + k] * da * (1 - a)) / oa);
  d[i + 3] = Math.round(oa * 255);
}

export function fillRect(img: Image, x: number, y: number, w: number, h: number, c: Rgba) {
  const [x0, y0] = [Math.max(0, Math.round(x)), Math.max(0, Math.round(y))];
  const [x1, y1] = [Math.min(img.width, Math.round(x + w)), Math.min(img.height, Math.round(y + h))];
  for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) blend(img, xx, yy, c);
}

// A box's outline, `t` pixels thick, drawn inside the box.
export function strokeRect(img: Image, x: number, y: number, w: number, h: number, c: Rgba, t = 1) {
  fillRect(img, x, y, w, t, c);
  fillRect(img, x, y + h - t, w, t, c);
  fillRect(img, x, y + t, t, h - 2 * t, c);
  fillRect(img, x + w - t, y + t, t, h - 2 * t, c);
}

// Bresenham's line, both ends included; `dash` draws that many pixels on,
// then as many off.
export function line(img: Image, x0: number, y0: number, x1: number, y1: number, c: Rgba, dash = 0) {
  [x0, y0, x1, y1] = [x0, y0, x1, y1].map(Math.round);
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (let n = 0; ; n++) {
    if (!dash || Math.floor(n / dash) % 2 === 0) blend(img, x0, y0, c);
    if (x0 === x1 && y0 === y1) return;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
}

// A thicker line: the 1-pixel one drawn again offset across its direction.
export function thickLine(img: Image, x0: number, y0: number, x1: number, y1: number, c: Rgba, width: number) {
  const steep = Math.abs(y1 - y0) > Math.abs(x1 - x0);
  for (let k = -Math.floor((width - 1) / 2); k <= Math.floor(width / 2); k++) {
    if (steep) line(img, x0 + k, y0, x1 + k, y1, c);
    else line(img, x0, y0 + k, x1, y1 + k, c);
  }
}

// A plus sign centred on (x, y), arms `arm` pixels long.
export function cross(img: Image, x: number, y: number, arm: number, c: Rgba, width = 1) {
  fillRect(img, x - arm, y - Math.floor((width - 1) / 2), 2 * arm + 1, width, c);
  fillRect(img, x - Math.floor((width - 1) / 2), y - arm, width, 2 * arm + 1, c);
}

export function dot(img: Image, x: number, y: number, r: number, c: Rgba) {
  for (let yy = -r; yy <= r; yy++) for (let xx = -r; xx <= r; xx++) if (xx * xx + yy * yy <= r * r + r) blend(img, Math.round(x) + xx, Math.round(y) + yy, c);
}

// The grey checkerboard editors draw under transparency, so a clear pixel
// and a black one look different.
export function checkerboard(img: Image, x: number, y: number, w: number, h: number, size = 8, light: Rgba = [204, 204, 204, 255], dark: Rgba = [168, 168, 168, 255]) {
  for (let yy = 0; yy < h; yy++) {
    for (let xx = 0; xx < w; xx++) {
      const c = (Math.floor(xx / size) + Math.floor(yy / size)) % 2 ? dark : light;
      blend(img, x + xx, y + yy, c);
    }
  }
}

// `src` composited over `dst` at (x, y), its alpha times `opacity`.
export function drawImage(dst: Image, src: Image, x: number, y: number, opacity = 1) {
  for (let yy = 0; yy < src.height; yy++) {
    for (let xx = 0; xx < src.width; xx++) {
      const i = (yy * src.width + xx) * 4;
      const a = src.rgba[i + 3];
      if (a) blend(dst, x + xx, y + yy, [src.rgba[i], src.rgba[i + 1], src.rgba[i + 2], a], opacity);
    }
  }
}

// An image at `scale` times its size: whole factors by nearest neighbour,
// so pixel art keeps its pixels; anything smaller by area averaging (to the
// rounded size), so a big frame shrinks without aliasing.
export function scaled(img: Image, scale: number): Image {
  if (scale === 1) return img;
  if (scale > 1 && Number.isInteger(scale)) return scaleUp(img, scale);
  return resizeSmooth(img, Math.max(1, Math.round(img.width * scale)), Math.max(1, Math.round(img.height * scale)));
}

// The width of a line of text at `size` (pixels per font pixel); the
// height is textHeight.
export const textWidth = (text: string, size = 1) => Math.max(0, [...text].length * ADVANCE - 1) * size;
export const textHeight = (size = 1) => GLYPH_H * size;

// Text with its top-left at (x, y). Returns the x after it.
export function text(img: Image, x: number, y: number, s: string, c: Rgba, size = 1): number {
  for (const ch of s) {
    const bits = GLYPHS.get(ch) ?? GLYPHS.get("?")!;
    for (let r = 0; r < GLYPH_H; r++) {
      for (let col = 0; col < GLYPH_W; col++) {
        if (bits[r] & (1 << (GLYPH_W - 1 - col))) fillRect(img, x + col * size, y + r * size, size, size, c);
      }
    }
    x += ADVANCE * size;
  }
  return x;
}

// Text on a box of `bg` with `pad` pixels around it, so a label reads on
// any picture. Returns the box.
export function label(img: Image, x: number, y: number, s: string, fg: Rgba, bg: Rgba, size = 1, pad = 2) {
  const w = textWidth(s, size) + 2 * pad;
  const h = textHeight(size) + 2 * pad;
  fillRect(img, x, y, w, h, bg);
  text(img, x + pad, y + pad, s, fg, size);
  return { x, y, w, h };
}

// The longest prefix of `s` that fits `width` at `size`, with "..." when cut.
export function fitText(s: string, width: number, size = 1): string {
  if (textWidth(s, size) <= width) return s;
  const chars = [...s];
  while (chars.length && textWidth(chars.join("") + "...", size) > width) chars.pop();
  return chars.length ? chars.join("") + "..." : "";
}

