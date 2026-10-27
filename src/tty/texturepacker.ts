// TexturePacker "JSON (Hash)" export: the atlas description PixiJS
// (Assets.load / Spritesheet) and Phaser (load.atlas) read natively, written
// next to a spritesheet.
//
// Format notes (checked by loading the files in real Phaser 3, Phaser 4 and
// PixiJS 8, see test/engines/):
//  - Frames are keyed "0", "1", ... in playing order. Phaser's
//    anims.createFromAseprite() looks frames up by exactly those keys and
//    reads each one's `duration` (ms), from Aseprite's JSON, which shares
//    this layout; PixiJS takes any key. Phaser needs the files loaded with
//    load.aseprite() for that (load.atlas() gives the frames only).
//  - `animations` (PixiJS: sheet.animations[name]) and `meta.frameTags`
//    (Phaser: createFromAseprite) both name the animation.
//  - A trimmed sheet (ludo toolbox image trim) says where each frame sat in
//    its untrimmed size: `trimmed`, `spriteSourceSize`, `sourceSize`. An
//    extruded one (ludo toolbox image extrude) keeps the repeated border out
//    of each `frame` rect.

import fs from "node:fs";
import path from "node:path";
import { frameRects } from "../toolbox/sheet.js";

export interface AtlasGrid {
  cols: number;
  rows: number;
  frames: number;
  fps: number;
}

// Where each frame sat before a trim, and how many pixels of repeated border
// surround each frame.
export interface FrameLayout {
  trim?: { x: number; y: number; w: number; h: number; source_w: number; source_h: number };
  extrude?: number;
}

export const ATLAS_APP = "https://github.com/Ludo-AI/ludo-cli";

function check(sheetWidth: number, sheetHeight: number, grid: AtlasGrid, layout: FrameLayout) {
  for (const [name, n] of Object.entries({ "sheet width": sheetWidth, "sheet height": sheetHeight, cols: grid.cols, rows: grid.rows, frames: grid.frames })) {
    if (!Number.isInteger(n) || n < 1) throw new Error(`TexturePacker export: ${name} must be a positive integer, got ${n}`);
  }
  if (grid.frames > grid.cols * grid.rows) throw new Error(`TexturePacker export: ${grid.frames} frames do not fit a ${grid.cols}x${grid.rows} grid`);
  if (!Number.isFinite(grid.fps) || grid.fps <= 0) throw new Error(`TexturePacker export: fps must be a positive number, got ${grid.fps}`);
  const e = layout.extrude ?? 0;
  if (2 * e >= Math.floor(sheetWidth / grid.cols) || 2 * e >= Math.floor(sheetHeight / grid.rows)) {
    throw new Error(`TexturePacker export: an extrude of ${e} leaves nothing of the frames`);
  }
}

/** Pure: the atlas object. `image` goes verbatim into meta.image. */
export function textureAtlas(image: string, sheetWidth: number, sheetHeight: number, grid: AtlasGrid, animation: string, layout: FrameLayout = {}) {
  check(sheetWidth, sheetHeight, grid, layout);
  const e = layout.extrude ?? 0;
  const duration = Math.max(1, Math.round(1000 / grid.fps));
  const t = layout.trim;
  const frames: Record<string, unknown> = {};
  frameRects(sheetWidth, sheetHeight, grid.cols, grid.rows, grid.frames).forEach((r, i) => {
    const [w, h] = [r.w - 2 * e, r.h - 2 * e];
    const fits = t && t.w === w && t.h === h;
    frames[String(i)] = {
      frame: { x: r.x + e, y: r.y + e, w, h },
      rotated: false,
      trimmed: !!fits && (t.w !== t.source_w || t.h !== t.source_h),
      spriteSourceSize: fits ? { x: t.x, y: t.y, w, h } : { x: 0, y: 0, w, h },
      sourceSize: fits ? { w: t.source_w, h: t.source_h } : { w, h },
      duration
    };
  });
  const keys = Object.keys(frames);
  return {
    frames,
    animations: { [animation]: keys },
    meta: {
      app: ATLAS_APP,
      version: "1.0",
      image,
      format: "RGBA8888",
      size: { w: sheetWidth, h: sheetHeight },
      scale: "1",
      frameTags: [{ name: animation, from: 0, to: keys.length - 1, direction: "forward" }]
    }
  };
}

/**
 * Writes `<sheet basename>.json` next to the sheet (never overwriting: adds
 * -2, -3, ... like the CLI's downloads) and returns its path. Throws a plain
 * Error with a readable message on bad input or IO failure.
 */
export function writeTextureAtlas(sheetPath: string, sheetWidth: number, sheetHeight: number, grid: AtlasGrid, animation: string, layout: FrameLayout = {}): string {
  const atlas = textureAtlas(path.basename(sheetPath), sheetWidth, sheetHeight, grid, animation, layout);
  const text = JSON.stringify(atlas, null, 2) + "\n";
  const dir = path.dirname(path.resolve(sheetPath));
  const base = path.basename(sheetPath, path.extname(sheetPath));
  for (let n = 1; ; n++) {
    const target = path.join(dir, `${base}${n > 1 ? `-${n}` : ""}.json`);
    try {
      fs.writeFileSync(target, text, { flag: "wx" });
      return target;
    } catch (err: any) {
      if (err?.code === "EEXIST") continue;
      throw new Error(`Could not write TexturePacker JSON ${target}: ${err?.code || err?.message || err}`);
    }
  }
}
