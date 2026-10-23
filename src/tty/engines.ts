// Engine files written next to a spritesheet (--engine): a Godot 4
// SpriteFrames .tres, or a TexturePacker JSON atlas for PixiJS and Phaser.

import { writeGodotSpriteFrames } from "./godot.js";
import { writeTextureAtlas, type FrameLayout } from "./texturepacker.js";

export const ENGINES = ["godot", "texturepacker"] as const;
export type Engine = (typeof ENGINES)[number];

export const ENGINE_FILE: Record<Engine, string> = {
  godot: "Godot SpriteFrames",
  texturepacker: "TexturePacker JSON"
};

export interface SheetInfo {
  cols: number;
  rows: number;
  frames: number;
  fps: number;
}

/**
 * Writes the engine's file for the sheet and returns its path. `animation`
 * names the animation (default: "default" for Godot, as its editor does; the
 * sheet's file name for TexturePacker, whose atlases often hold several).
 * Throws a plain Error with a readable message.
 */
export function writeEngineFile(engine: Engine, sheetPath: string, width: number, height: number, grid: SheetInfo, layout: FrameLayout = {}, animation?: string): string {
  if (engine === "godot") return writeGodotSpriteFrames(sheetPath, width, height, grid, animation, layout);
  const name = animation || sheetPath.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "") || "default";
  return writeTextureAtlas(sheetPath, width, height, grid, name, layout);
}
