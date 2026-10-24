// Engine files written next to a spritesheet (--engine): a Godot 4
// SpriteFrames .tres, a TexturePacker JSON atlas for PixiJS and Phaser, or
// Unity's import settings and AnimationClip.

import { writeGodotSpriteFrames } from "./godot.js";
import { writeTextureAtlas, type FrameLayout } from "./texturepacker.js";
import { writeUnityFiles } from "./unity.js";

export const ENGINES = ["godot", "texturepacker", "unity"] as const;
export type Engine = (typeof ENGINES)[number];

export const ENGINE_FILE: Record<Engine, string> = {
  godot: "Godot SpriteFrames",
  texturepacker: "TexturePacker JSON",
  unity: "Unity sprite import and AnimationClip"
};

export interface SheetInfo {
  cols: number;
  rows: number;
  frames: number;
  fps: number;
}

/**
 * Writes the engine's files for the sheet and returns their paths.
 * `animation` names the animation (default: "default" for Godot, as its
 * editor does; the sheet's file name for TexturePacker, whose atlases often
 * hold several, and for Unity). Throws a plain Error with a readable message.
 */
export function writeEngineFile(engine: Engine, sheetPath: string, width: number, height: number, grid: SheetInfo, layout: FrameLayout = {}, animation?: string): string[] {
  if (engine === "godot") return [writeGodotSpriteFrames(sheetPath, width, height, grid, animation, layout)];
  if (engine === "unity") return writeUnityFiles(sheetPath, width, height, grid, animation, layout);
  const name = animation || sheetPath.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "") || "default";
  return [writeTextureAtlas(sheetPath, width, height, grid, name, layout)];
}
