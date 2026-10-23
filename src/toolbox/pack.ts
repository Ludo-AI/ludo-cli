import type { Image } from "../tty/png.js";
import { crop } from "./sheet.js";
import { resizeNearest, resizeSmooth } from "./resample.js";
import {
  calculateAnimationCharacterHeight,
  calculateAnimationTrimBounds,
  calculateCharacterBounds,
  calculateGroundOffsetFromBounds,
  computeFramePlacement,
  computePackNormalization,
  type PixelData,
  type TrimBounds
} from "./packMath.js";

// An animation pack: several animations of one character brought to the
// same character height and ground line, centred in one shared frame size.
// The web app's Export Pack, on RGBA buffers: the sizing and placement are
// its math (packMath.ts), the steps around it follow ExportAnimationPackModal:
//  - each animation is cropped to the union of its frames' content (alpha
//    above 10), one box for all its frames;
//  - its character height is frame 1's content height; the pack's target is
//    the shortest, so animations only shrink unless --size says otherwise;
//  - the ground offset starts at the space below frame 1's character in
//    that box, so frame 1's feet land on the ground line;
//  - the box is resized to round(size * scale) and drawn at the rounded
//    placement. Unlike the web's spritesheet mode, a frame never spills into
//    the next cell: drawing is clipped to its own.
// Pure: frames in, frames out.

export type ArtMode = "smooth" | "pixel";

export interface PackInput {
  frames: Image[];
  size?: number; // multiplier on the matched height (default 1)
  ground?: number; // the web's "Vertical": source pixels, up is positive (default: frame 1 on the ground line)
  offsetX?: number; // source pixels, right is positive (default 0)
}

export interface PackedAnimation {
  frames: Image[]; // frameWidth x frameHeight each
  scale: number;
  size: number;
  ground: number; // the value used
  groundAuto: number; // the default it started from
  offsetX: number;
  trim: TrimBounds;
}

export interface Pack {
  frameWidth: number;
  frameHeight: number;
  targetHeight: number; // the shared character height, in output pixels before --size
  groundLine: number; // pixels from the frame bottom to the ground line
  animations: PackedAnimation[];
}

const pixelData = (img: Image): PixelData => ({ data: img.rgba, width: img.width, height: img.height });

// Copies `src` onto `dst` at (x, y), clipped to dst (source-over onto
// transparent cells is a copy).
function blit(dst: Image, src: Image, x: number, y: number) {
  const x0 = Math.max(0, x);
  const x1 = Math.min(dst.width, x + src.width);
  if (x1 <= x0) return;
  for (let row = Math.max(0, y); row < Math.min(dst.height, y + src.height); row++) {
    const from = ((row - y) * src.width + (x0 - x)) * 4;
    dst.rgba.set(src.rgba.subarray(from, from + (x1 - x0) * 4), (row * dst.width + x0) * 4);
  }
}

export function buildPack(inputs: PackInput[], opts: { art: ArtMode; frameSize?: { w?: number; h?: number } }): Pack {
  const prepared = inputs.map(input => {
    const data = input.frames.map(pixelData);
    const trim = calculateAnimationTrimBounds({ frames: data });
    const groundAuto = -calculateGroundOffsetFromBounds(calculateCharacterBounds(data[0]), trim);
    return { input, data, trim, groundAuto, animCharHeight: calculateAnimationCharacterHeight({ frames: data }) };
  });
  // The web's getters: a size of 0 means 1, a missing ground means 0 once
  // the default is filled in.
  const size = (p: (typeof prepared)[number]) => p.input.size || 1;
  const groundOffset = (p: (typeof prepared)[number]) => -(p.input.ground ?? p.groundAuto) || 0;
  const offsetX = (p: (typeof prepared)[number]) => p.input.offsetX || 0;

  const { targetHeight, scales, frameSize } = computePackNormalization(
    prepared.map(p => ({
      animCharHeight: p.animCharHeight,
      sizeMultiplier: size(p),
      groundOffset: groundOffset(p),
      horizontalOffset: offsetX(p),
      frameBounds: p.data.map(() => ({ width: p.trim.width, height: p.trim.height }))
    })),
    opts.frameSize
  );
  const maxGroundOffset = Math.max(0, ...prepared.map((p, i) => groundOffset(p) * scales[i]));
  const resize = opts.art === "pixel" ? resizeNearest : resizeSmooth;

  const animations = prepared.map((p, i) => {
    const scale = scales[i];
    const scaledWidth = p.trim.width * scale;
    const scaledHeight = p.trim.height * scale;
    const { charX, charY } = computeFramePlacement({
      frameWidth: frameSize.width,
      frameHeight: frameSize.height,
      maxGroundOffset,
      groundOffset: groundOffset(p) * scale,
      scaledWidth,
      scaledHeight,
      horizontalOffset: offsetX(p),
      scale
    });
    const [w, h] = [Math.round(scaledWidth), Math.round(scaledHeight)];
    const frames = p.input.frames.map(frame => {
      const out: Image = { width: frameSize.width, height: frameSize.height, rgba: new Uint8Array(frameSize.width * frameSize.height * 4) };
      if (w > 0 && h > 0) {
        const box = crop(frame, { x: p.trim.cropX, y: p.trim.cropY, w: p.trim.cropWidth, h: p.trim.cropHeight });
        blit(out, w === box.width && h === box.height ? box : resize(box, w, h), charX, charY);
      }
      return out;
    });
    return { frames, scale, size: size(p), ground: -groundOffset(p) || 0, groundAuto: p.groundAuto || 0, offsetX: offsetX(p), trim: p.trim };
  });

  return { frameWidth: frameSize.width, frameHeight: frameSize.height, targetHeight, groundLine: maxGroundOffset, animations };
}

/** Frames into a sheet of `cols` x `rows` cells, in reading order. */
export function layoutSheet(frames: Image[], cols: number, rows: number): Image {
  const { width: fw, height: fh } = frames[0];
  const sheet: Image = { width: fw * cols, height: fh * rows, rgba: new Uint8Array(fw * cols * fh * rows * 4) };
  frames.forEach((f, i) => blit(sheet, f, (i % cols) * fw, Math.floor(i / cols) * fh));
  return sheet;
}
