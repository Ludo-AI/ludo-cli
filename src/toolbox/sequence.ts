import type { Image } from "../tty/png.js";
import { alignSprites, groundAlignment } from "./align.js";
import type { ArtMode } from "./pack.js";
import { resizeNearest, resizeSmooth } from "./resample.js";
import { blit } from "./sheet.js";
import { cropBounds, nextSequenceSlot, paddedFrameLayout, sequenceCanvasBounds, type Placement, type Slot } from "./sequenceMath.js";

// An animation sequence: several animations played one after the other
// (idle, jump, land), each placed so its first frame continues from the
// previous one's last frame. The web app's Export Sequence
// (ExportSequenceModal's buildAlignedFrames and renderOutputFrame), on RGBA
// buffers, step for step:
//  - animation 1 sits at (0, 0) at its own size; each next one is placed by
//    aligning the previous one's last frame, at the size it was drawn, with
//    its own first frame (align.ts, where the web calls the ML service);
//  - every frame is drawn at its animation's place on a canvas holding them
//    all, then all are cropped to the box around every frame's content;
//  - that box is laid out in the output frame by paddedFrameLayout (size,
//    vertical, horizontal, frame size).
// The canvas is never built: each frame goes straight into the crop box,
// which gives the same pixels. Pure: frames in, frames out.

export type AlignMode = "auto" | "ground" | "none";

export interface Transition {
  dx: number;
  dy: number;
  scale: number;
  confidence: number; // NaN when no matching was done
  method: "ncc" | "ground" | "none";
}

export interface SequenceOptions {
  art: ArtMode;
  align: AlignMode;
  transitions?: (Transition | undefined)[]; // fixed ones (from a manifest) win over aligning
  frameSize?: { w?: number; h?: number };
  placement?: Placement;
}

export interface Sequence {
  transitions: Transition[];
  slots: Slot[]; // each animation's place and drawn size, before the crop
  content: { width: number; height: number; x: number; y: number }; // the crop box, on the canvas
  layout: ReturnType<typeof paddedFrameLayout>;
  frames: Image[][]; // per animation, layout.frameW x layout.frameH each
}

const resizer = (art: ArtMode) => (art === "pixel" ? resizeNearest : resizeSmooth);
const sized = (img: Image, w: number, h: number, resize: (img: Image, w: number, h: number) => Image) => (w === img.width && h === img.height ? img : resize(img, w, h));

/** The box around a frame's content (alpha above 10), or null when empty. */
function contentBox(img: Image) {
  let [minX, minY, maxX, maxY] = [img.width, img.height, -1, -1];
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.rgba[(y * img.width + x) * 4 + 3] > 10) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX < 0 ? null : { minX, minY, maxX, maxY };
}

export function align(a: Image, b: Image, mode: AlignMode): Transition {
  if (mode === "none") return { dx: 0, dy: 0, scale: 1, confidence: Number.NaN, method: "none" };
  return mode === "ground" ? groundAlignment(a, b) : alignSprites(a, b);
}

export function buildSequence(animations: Image[][], opts: SequenceOptions): Sequence {
  const first = animations[0][0];
  const slots: Slot[] = [{ x: 0, y: 0, w: first.width, h: first.height }];
  const transitions: Transition[] = [];
  for (let i = 0; i + 1 < animations.length; i++) {
    const prev = slots[i];
    const next = animations[i + 1][0];
    // The previous animation's last frame as it is drawn, against the next
    // one's first frame at its own size.
    const t = opts.transitions?.[i] ?? align(sized(animations[i][animations[i].length - 1], prev.w, prev.h, resizeSmooth), next, opts.align);
    transitions.push(t);
    slots.push(nextSequenceSlot(prev, t, next.width, next.height));
  }

  const { canvasW, canvasH, shiftX, shiftY } = sequenceCanvasBounds(slots);
  const resize = resizer(opts.art);
  const drawn = animations.map((frames, i) => frames.map(f => sized(f, slots[i].w, slots[i].h, resize)));
  // Each frame's content on the canvas; an empty frame counts as the whole
  // canvas, as the web's bounds scan does.
  const boxes = drawn.flatMap((frames, i) =>
    frames.map(f => {
      const b = contentBox(f);
      const [x, y] = [slots[i].x + shiftX, slots[i].y + shiftY];
      return b ? { minX: b.minX + x, minY: b.minY + y, maxX: b.maxX + x, maxY: b.maxY + y } : { minX: 0, minY: 0, maxX: canvasW - 1, maxY: canvasH - 1 };
    })
  );
  const crop = cropBounds(boxes, canvasW, canvasH);
  const layout = paddedFrameLayout(crop.cropW, crop.cropH, opts.frameSize?.w, opts.frameSize?.h, opts.placement);
  const transformed = layout.frameW !== crop.cropW || layout.frameH !== crop.cropH || layout.drawH !== crop.cropH;

  const frames = drawn.map((list, i) =>
    list.map(f => {
      const cropped: Image = { width: crop.cropW, height: crop.cropH, rgba: new Uint8Array(crop.cropW * crop.cropH * 4) };
      blit(cropped, f, slots[i].x + shiftX - crop.minX, slots[i].y + shiftY - crop.minY);
      if (!transformed) return cropped;
      const out: Image = { width: layout.frameW, height: layout.frameH, rgba: new Uint8Array(layout.frameW * layout.frameH * 4) };
      blit(out, sized(cropped, layout.drawW, layout.drawH, resize), layout.offsetX, layout.offsetY);
      return out;
    })
  );

  return { transitions, slots, content: { width: crop.cropW, height: crop.cropH, x: crop.minX - shiftX, y: crop.minY - shiftY }, layout, frames };
}
