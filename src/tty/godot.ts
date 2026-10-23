// Godot 4 SpriteFrames export: turns a downloaded spritesheet into a `.tres`
// resource a game dev can drop on an AnimatedSprite2D.
//
// Format notes (validated against Godot 4.7.2-stable, see test/godot/):
//  - Text resource format 3, no `load_steps` (Godot >= 4.5 no longer writes it
//    and every 4.x reader treats it as optional) and no `uid=` attributes:
//    Godot resolves the texture by path and assigns uids itself on import.
//  - An ext_resource path without a scheme is resolved relative to the .tres
//    file, so a sheet + .tres pair outside any project keeps working once both
//    are copied into one, as long as they stay side by side.
//  - A trimmed sheet (ludo toolbox image trim) gives each AtlasTexture a
//    `margin`: Rect2(offset, untrimmed size - frame size), which is how Godot
//    puts a cut-down region back at its original size and place. An extruded
//    one keeps the repeated border out of each region.

import fs from "node:fs";
import path from "node:path";
import type { FrameLayout } from "./texturepacker.js";

export interface SheetGrid {
  cols: number;
  rows: number;
  frames: number;
  fps: number;
  loop?: boolean;
}

const TEXTURE_ID = "1_sheet";

function quote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

function godotFloat(n: number): string {
  return Number.isInteger(n) ? `${n}.0` : String(n);
}

function positiveInt(name: string, n: number): void {
  if (!Number.isInteger(n) || n < 1) throw new Error(`Godot export: ${name} must be a positive integer, got ${n}`);
}

/** Validates the grid against the sheet size and returns the frame size. */
function frameSize(sheetWidth: number, sheetHeight: number, grid: SheetGrid): { w: number; h: number } {
  positiveInt("sheet width", sheetWidth);
  positiveInt("sheet height", sheetHeight);
  positiveInt("cols", grid.cols);
  positiveInt("rows", grid.rows);
  positiveInt("frames", grid.frames);
  if (grid.frames > grid.cols * grid.rows) {
    throw new Error(`Godot export: ${grid.frames} frames do not fit a ${grid.cols}x${grid.rows} grid`);
  }
  if (!Number.isFinite(grid.fps) || grid.fps <= 0) throw new Error(`Godot export: fps must be a positive number, got ${grid.fps}`);
  if (sheetWidth % grid.cols !== 0 || sheetHeight % grid.rows !== 0) {
    throw new Error(
      `Godot export: a ${sheetWidth}x${sheetHeight} sheet does not divide into a ${grid.cols}x${grid.rows} grid of whole-pixel frames`,
    );
  }
  return { w: sheetWidth / grid.cols, h: sheetHeight / grid.rows };
}

/** Pure: the `.tres` text. `texturePath` goes verbatim into the ext_resource path. */
export function spriteFramesTres(
  texturePath: string,
  sheetWidth: number,
  sheetHeight: number,
  grid: SheetGrid,
  animationName = "default",
  layout: FrameLayout = {},
): string {
  const { w, h } = frameSize(sheetWidth, sheetHeight, grid);
  const e = layout.extrude ?? 0;
  if (!Number.isInteger(e) || e < 0 || 2 * e >= Math.min(w, h)) throw new Error(`Godot export: an extrude of ${e} does not fit ${w}x${h} frames`);
  const [fw, fh] = [w - 2 * e, h - 2 * e];
  const t = layout.trim && layout.trim.w === fw && layout.trim.h === fh ? layout.trim : undefined;
  const out: string[] = [];
  out.push(`[gd_resource type="SpriteFrames" format=3]`, "");
  out.push(`[ext_resource type="Texture2D" path=${quote(texturePath)} id="${TEXTURE_ID}"]`, "");
  for (let i = 0; i < grid.frames; i++) {
    const x = (i % grid.cols) * w + e;
    const y = Math.floor(i / grid.cols) * h + e;
    out.push(`[sub_resource type="AtlasTexture" id="AtlasTexture_${i}"]`);
    out.push(`atlas = ExtResource("${TEXTURE_ID}")`);
    out.push(`region = Rect2(${x}, ${y}, ${fw}, ${fh})`);
    if (t && (t.source_w !== fw || t.source_h !== fh)) out.push(`margin = Rect2(${t.x}, ${t.y}, ${t.source_w - fw}, ${t.source_h - fh})`);
    out.push("");
  }
  const frames = Array.from(
    { length: grid.frames },
    (_, i) => `{\n"duration": 1.0,\n"texture": SubResource("AtlasTexture_${i}")\n}`,
  ).join(", ");
  out.push("[resource]");
  out.push(
    `animations = [{\n"frames": [${frames}],\n"loop": ${grid.loop === false ? "false" : "true"},\n` +
      `"name": &${quote(animationName)},\n"speed": ${godotFloat(grid.fps)}\n}]`,
  );
  return out.join("\n") + "\n";
}

/** The nearest directory at or above `dir` holding a project.godot, if any. */
export function findGodotProject(dir: string): string | undefined {
  let current = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(current, "project.godot"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** What the .tres (written next to the sheet) should reference the sheet as. */
export function godotTexturePath(sheetPath: string): string {
  const abs = path.resolve(sheetPath);
  const project = findGodotProject(path.dirname(abs));
  if (project) return `res://${path.relative(project, abs).split(path.sep).join("/")}`;
  return path.basename(abs);
}

/**
 * Writes `<sheet basename>.tres` next to the sheet (never overwriting: adds
 * -2, -3, ... like the CLI's downloads) and returns its path. Throws a plain
 * Error with a readable message on bad input or IO failure.
 */
export function writeGodotSpriteFrames(
  sheetPath: string,
  sheetWidth: number,
  sheetHeight: number,
  grid: SheetGrid,
  animationName?: string,
  layout?: FrameLayout,
): string {
  const text = spriteFramesTres(godotTexturePath(sheetPath), sheetWidth, sheetHeight, grid, animationName, layout);
  const dir = path.dirname(path.resolve(sheetPath));
  const base = path.basename(sheetPath, path.extname(sheetPath));
  for (let n = 1; ; n++) {
    const target = path.join(dir, `${base}${n > 1 ? `-${n}` : ""}.tres`);
    try {
      fs.writeFileSync(target, text, { flag: "wx" });
      return target;
    } catch (err: any) {
      if (err?.code === "EEXIST") continue;
      throw new Error(`Could not write Godot SpriteFrames ${target}: ${err?.code || err?.message || err}`);
    }
  }
}
