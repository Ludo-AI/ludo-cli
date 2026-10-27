// Engine files written next to a spritesheet (--engine): a Godot 4
// SpriteFrames .tres, a TexturePacker JSON atlas for PixiJS and Phaser, or
// Unity's import settings and AnimationClip.

import { writeGodotScene, writeGodotSpriteFrames } from "./godot.js";
import { writeTextureAtlas, type FrameLayout } from "./texturepacker.js";
import { writeUnityFiles } from "./unity.js";
import { noteFact } from "../telemetry.js";

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

// What `ludo toolbox sprite export` adds from the sheet's measures: a pivot
// (Unity: each sprite's custom pivot; Godot: an AnimatedSprite2D scene whose
// offset puts it at the node's origin) and Unity's pixels per unit.
export interface EngineOptions {
  pivot?: { x: number; y: number }; // pixels from the untrimmed frame's top-left, without extrusion
  ppu?: number;
}

/**
 * Writes the engine's files for the sheet and returns their paths.
 * `animation` names the animation (default: "default" for Godot, as its
 * editor does; the sheet's file name for TexturePacker, whose atlases often
 * hold several, and for Unity). Throws a plain Error with a readable message.
 */
export function writeEngineFile(engine: Engine, sheetPath: string, width: number, height: number, grid: SheetInfo, layout: FrameLayout = {}, animation?: string, options: EngineOptions = {}): string[] {
  noteFact("engine", engine);
  if (engine === "godot") {
    const tres = writeGodotSpriteFrames(sheetPath, width, height, grid, animation, layout);
    return options.pivot ? [tres, writeGodotScene(tres, width, height, grid, options.pivot, animation, layout)] : [tres];
  }
  if (engine === "unity") return writeUnityFiles(sheetPath, width, height, grid, animation, layout, options);
  const name = animation || sheetPath.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "") || "default";
  return [writeTextureAtlas(sheetPath, width, height, grid, name, layout)];
}
