import { encodeGif, type GifFrame } from "../tty/gif.js";
import type { Image } from "../tty/png.js";
import { PaletteMap, WuQuantizer, type Rgb } from "./quantize.js";

// An animated GIF from frames of one size. Pure: bytes out, no files.
//
// GIF has one 256-colour palette and 1-bit transparency, so:
//  - a pixel is transparent when its alpha is below `alphaThreshold`; the
//    rest are opaque, their colour as is, or blended over `matte` when given
//    (so soft edges fade into the colour the GIF will sit on, not into black);
//  - one palette serves every frame, so colours do not flicker between
//    frames: the exact colours when there are few enough, else Wu's
//    quantizer (quantize.ts), with each pixel mapped to its nearest colour.
//    No dithering: it shimmers when frames change and bloats the file.
//  - delays are whole centiseconds: frame i starts at round(i * 100 / fps),
//    so 12 fps alternates 8 and 9 cs and keeps its average. Browsers play a
//    delay of 0 or 1 cs as 10, so 50 fps (2 cs) is the fastest.
//
// Each frame stores only the rectangle it needs: with transparency, the box
// around its visible pixels, cleared afterwards (disposal 2) so the next
// frame starts from nothing; without, the box of pixels that changed since
// the frame before, left in place (disposal 1). Both decode to the full
// frames exactly.

export const MAX_GIF_FPS = 50;

export interface GifOptions {
  fps: number;
  alphaThreshold: number; // 1-255: alpha below it is transparent
  matte?: Rgb;
  loop: boolean;
}

export interface GifResult {
  bytes: Uint8Array;
  colours: number; // in the palette, not counting transparent
  exact: boolean; // the palette holds every colour of the frames
  transparent: boolean;
  fps: number; // what it plays at: the asked fps, at most MAX_GIF_FPS
  delays: number[]; // centiseconds
}

/** Frame i starts at round(i * 100 / fps) cs. */
export function gifDelays(frames: number, fps: number): number[] {
  const start = (i: number) => Math.round((i * 100) / fps);
  return Array.from({ length: frames }, (_, i) => Math.max(2, start(i + 1) - start(i)));
}

/**
 * The frame rate behind a GIF's delays: a whole fps whose delays (as
 * gifDelays spaces them) are exactly these, else the average. Delays of 0-1
 * cs count as 10, as browsers play them.
 */
export function gifFps(delays: number[]): number {
  const played = delays.map(d => (d <= 1 ? 10 : d));
  const average = 100 / (played.reduce((a, b) => a + b, 0) / played.length);
  const exact = [];
  for (let fps = 1; fps <= MAX_GIF_FPS; fps++) if (gifDelays(played.length, fps).every((d, i) => d === played[i])) exact.push(fps);
  if (exact.length) return exact.reduce((best, fps) => (Math.abs(fps - average) < Math.abs(best - average) ? fps : best));
  return Math.round(average * 100) / 100;
}

export function makeGif(frames: Image[], opts: GifOptions): GifResult {
  if (!frames.length) throw new Error("no frames");
  const { width, height } = frames[0];
  if (frames.some(f => f.width !== width || f.height !== height)) throw new Error("GIF frames must all be the same size");
  const threshold = opts.alphaThreshold;
  const matte = opts.matte;

  // The colour a kept pixel shows: -1 when transparent.
  const colourAt = (rgba: Uint8Array, i: number): number => {
    const a = rgba[i + 3];
    if (a < threshold) return -1;
    let [r, g, b] = [rgba[i], rgba[i + 1], rgba[i + 2]];
    if (matte && a < 255) {
      const k = a / 255;
      r = Math.round(r * k + matte[0] * (1 - k));
      g = Math.round(g * k + matte[1] * (1 - k));
      b = Math.round(b * k + matte[2] * (1 - k));
    }
    return (r << 16) | (g << 8) | b;
  };

  // One pass: the distinct colours (while few enough to keep exactly) and
  // the quantizer's histogram.
  const unique = new Map<number, true>();
  const wu = new WuQuantizer();
  let transparent = false;
  for (const { rgba } of frames) {
    for (let i = 0; i < rgba.length; i += 4) {
      const c = colourAt(rgba, i);
      if (c < 0) {
        transparent = true;
        continue;
      }
      if (unique.size <= 256) unique.set(c, true);
      wu.add(c >> 16, (c >> 8) & 0xff, c & 0xff);
    }
  }
  const room = transparent ? 255 : 256;
  const exact = unique.size <= room;
  let palette: Rgb[] = exact ? [...unique.keys()].map(c => [c >> 16, (c >> 8) & 0xff, c & 0xff]) : wu.palette(room);
  if (!palette.length) palette = [[0, 0, 0]]; // every pixel transparent
  const map = new PaletteMap(palette);
  const clear = transparent ? palette.length : -1;

  const indexed = frames.map(({ rgba }) => {
    const out = new Uint8Array(width * height);
    for (let p = 0; p < out.length; p++) {
      const c = colourAt(rgba, p * 4);
      out[p] = c < 0 ? clear : map.index(c >> 16, (c >> 8) & 0xff, c & 0xff);
    }
    return out;
  });

  const fps = Math.min(opts.fps, MAX_GIF_FPS);
  const delays = gifDelays(frames.length, fps);
  const gifFrames: GifFrame[] = indexed.map((idx, k) => {
    const keep = transparent ? (p: number) => idx[p] !== clear : k === 0 ? () => true : (p: number) => idx[p] !== indexed[k - 1][p];
    const box = boundingBox(width, height, keep) ?? { x: 0, y: 0, w: 1, h: 1 };
    const indices = new Uint8Array(box.w * box.h);
    for (let y = 0; y < box.h; y++) indices.set(idx.subarray((box.y + y) * width + box.x, (box.y + y) * width + box.x + box.w), y * box.w);
    return { x: box.x, y: box.y, width: box.w, height: box.h, indices, delay: delays[k], disposal: transparent ? 2 : 1 };
  });

  const bytes = encodeGif({
    width,
    height,
    palette: transparent ? [...palette, [0, 0, 0]] : palette,
    transparentIndex: transparent ? clear : undefined,
    loop: opts.loop,
    frames: gifFrames
  });
  return { bytes, colours: exact ? unique.size : palette.length, exact, transparent, fps, delays };
}

function boundingBox(width: number, height: number, keep: (p: number) => boolean) {
  let [x0, y0, x1, y1] = [width, height, -1, -1];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!keep(y * width + x)) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? undefined : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
