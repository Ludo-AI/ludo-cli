// Engine files written next to a spritesheet (--engine): a Godot 4
// SpriteFrames .tres, a TexturePacker JSON atlas for PixiJS and Phaser, or
// Unity's import settings and AnimationClip.

import fs from "node:fs";
import path from "node:path";
import { importedUid, rewireTres, tresSlicing, writeGodotCanvasTexture, writeGodotScene, writeGodotSpriteFrames } from "./godot.js";
import { writeTextureAtlas, type FrameLayout } from "./texturepacker.js";
import { metaRects, metaText, normalMapEntryGuid, normalMapGuid, withNormalMapEntry, writeUnityFiles, writeUnityMeta, writeUnityNormalMapMeta } from "./unity.js";
import { noteFact } from "../telemetry.js";

export const ENGINES = ["godot", "texturepacker", "unity"] as const;
export type Engine = (typeof ENGINES)[number];

export const ENGINE_NAME: Record<Engine, string> = { godot: "Godot", texturepacker: "TexturePacker", unity: "Unity" };

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
  normalMap?: NormalMap;
}

// A normal map for the sheet (ludo toolbox image normals), the sheet's size:
// Godot gets it in a CanvasTexture, Unity as the sheet's _NormalMap
// secondary texture. A TexturePacker atlas has no place for one.
export interface NormalMap {
  file: string;
  format: "opengl" | "directx";
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
    const tres = writeGodotSpriteFrames(sheetPath, width, height, grid, animation, layout, options.normalMap?.file);
    return options.pivot ? [tres, writeGodotScene(tres, width, height, grid, options.pivot, animation, layout)] : [tres];
  }
  if (engine === "unity") return writeUnityFiles(sheetPath, width, height, grid, animation, layout, options);
  const name = animation || sheetPath.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "") || "default";
  return [writeTextureAtlas(sheetPath, width, height, grid, name, layout)];
}

/** What `image normals --engine` writes or updates; run() does it and says which files, and whether each was updated in place. */
export interface LitStep {
  run(): { file: string; patched: boolean }[];
}

export interface LitPlan {
  steps: LitStep[];
  foreign: { file: string; why: string; type?: string }[]; // engine files that use the art in a way not rewired here: left as they are
  skipped: { file: string; why: string }[]; // .tres files beside the art it could not read: not looked at
  rewired: { file: string; was: string }[]; // files that used another normal map, now this one
  atlas?: string; // TexturePacker: the art's atlas already there, used as it is
  unlistable?: string; // Unity: the art's .meta has no secondaryTextures list to add the map to
}

/**
 * What `image normals --engine` does to light the art through `normalMap`,
 * worked out before anything is written: every file read, and every file it
 * writes checked to be writable (a read-only .meta, as Perforce leaves
 * them, stops it with nothing changed). The art's own engine files are
 * updated, never regenerated: Godot, every .tres beside the art that uses it
 * (rewireTres: whoever wrote it, frames and animation stay; another art's
 * .tres is not touched); Unity, only the secondaryTextures of the art's
 * .meta, and the map's .meta made a normal map's (its other lines stay).
 * Only when the art has none are they written, as `sprite export` would
 * (`grid` undefined: a still image, which gets a Godot CanvasTexture and
 * no Unity clip).
 */
export function planLitFiles(engine: Engine, artPath: string, width: number, height: number, grid: SheetInfo | undefined, layout: FrameLayout, normalMap: NormalMap): LitPlan {
  noteFact("engine", engine);
  const dir = path.dirname(path.resolve(artPath));
  const base = path.basename(artPath, path.extname(artPath));
  const write = (file: string, text: string) => {
    try {
      fs.writeFileSync(file, text);
    } catch (err: any) {
      throw new Error(`Could not write ${file}: ${err?.code || err?.message || err}`);
    }
    return [{ file, patched: true }];
  };
  const plan: LitPlan = { steps: [], foreign: [], rewired: [], skipped: [] };
  const writes: string[] = []; // the files it will write (or the folder, for a new one)
  if (engine === "godot") {
    const uid = importedUid(normalMap.file);
    for (const { file, text, why } of tresBeside(artPath)) {
      if (text === undefined) {
        plan.skipped.push({ file, why: why! });
        continue;
      }
      const r = rewireTres(text, file, artPath, normalMap.file, uid);
      if (!r) continue;
      if ("refused" in r) {
        plan.foreign.push({ file, why: r.refused, type: r.type });
        continue;
      }
      if (r.oldNormal) plan.rewired.push({ file, was: r.oldNormal });
      writes.push(file);
      plan.steps.push({ run: () => write(file, r.text) });
    }
    if (!plan.steps.length && !plan.foreign.length) {
      writes.push(dir);
      plan.steps.push({
        run: () => [{ file: grid ? writeGodotSpriteFrames(artPath, width, height, grid, undefined, layout, normalMap.file) : writeGodotCanvasTexture(artPath, normalMap.file), patched: false }]
      });
    }
  } else if (engine === "unity") {
    const metaPath = path.resolve(artPath) + ".meta";
    const meta = metaText(metaPath);
    const mapMeta = path.resolve(normalMap.file) + ".meta";
    const mapHadMeta = metaText(mapMeta) !== undefined;
    writes.push(mapMeta);
    if (meta === undefined) {
      writes.push(dir);
      const run = () => writeUnityFiles(artPath, width, height, grid ?? { cols: 1, rows: 1, frames: 1, fps: 1 }, undefined, layout, { normalMap }, !!grid).map(file => ({ file, patched: file === mapMeta && mapHadMeta }));
      plan.steps.push({ run });
    } else {
      const guid = normalMapGuid(normalMap);
      const listed = withNormalMapEntry(meta, guid);
      const was = normalMapEntryGuid(meta);
      if (was && was !== guid) plan.rewired.push({ file: metaPath, was: guidName(dir, was, metaPath) });
      if (listed !== undefined) {
        writes.push(metaPath);
        plan.steps.push({ run: () => (writeUnityMeta(metaPath, listed), [{ file: metaPath, patched: true }]) });
      } else plan.unlistable = metaPath;
      plan.steps.push({ run: () => [{ file: writeUnityNormalMapMeta(normalMap, width, height, guid).metaPath, patched: mapHadMeta }] });
    }
  } else if (grid) {
    // An atlas has no place for the map: one already there is used as it is.
    const atlas = path.join(dir, `${base}.json`);
    if (fs.existsSync(atlas)) plan.atlas = atlas;
    else {
      writes.push(dir);
      plan.steps.push({ run: () => [{ file: writeTextureAtlas(artPath, width, height, grid, base, layout), patched: false }] });
    }
  }
  for (const file of writes) assertWritable(file);
  return plan;
}

// <name>.tres, <name>-2.tres... first, in the order they were written; then the rest by name.
const numbered = (base: string) => (a: string, b: string) => {
  const n = (x: string) => {
    const m = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:-(\\d+))?\\.tres$`, "i").exec(x);
    return m ? Number(m[1] ?? 1) : Infinity;
  };
  return n(a) - n(b) || (a < b ? -1 : a > b ? 1 : 0);
};

// The file a Unity guid belongs to: the .meta beside the art that declares
// it (its own `guid:` line, not a reference to it, as the art's .meta has).
function guidName(dir: string, guid: string, artMeta: string): string {
  const declares = new RegExp(`^guid: ${guid}\\r?$`, "m");
  for (const n of fs.readdirSync(dir).filter(n => n.endsWith(".meta"))) {
    if (path.join(dir, n) === artMeta) continue;
    try {
      if (declares.test(fs.readFileSync(path.join(dir, n), "utf8"))) return n.slice(0, -5);
    } catch {
      // unreadable: not this one
    }
  }
  return `an asset no longer beside the art (guid ${guid})`;
}

// Every .tres beside the art, read (or why it could not be), <name>.tres,
// <name>-2.tres... first. Only these are looked at: a .tres elsewhere in the
// project is not.
function tresBeside(artPath: string): { file: string; text?: string; why?: string }[] {
  const dir = path.dirname(path.resolve(artPath));
  const base = path.basename(artPath, path.extname(artPath));
  return fs
    .readdirSync(dir)
    .filter(n => /\.tres$/i.test(n))
    .sort(numbered(base))
    .map(n => {
      const file = path.join(dir, n);
      try {
        return { file, text: fs.readFileSync(file, "utf8") };
      } catch (err: any) {
        return { file, why: err?.code || err?.message || String(err) };
      }
    });
}

/**
 * How the art's existing engine files cut it, as a grid for its normal map:
 * Godot, each .tres beside it that uses it (SpriteFrames regions, a
 * TileSet's tiles); Unity, its .meta's sprite rects. A file that does not
 * cut it into a uniform grid (one Unity sprite: the whole picture) says so.
 */
export function existingSlicing(engine: Engine, artPath: string, width: number, height: number): Slicing[] {
  if (engine === "godot") {
    return tresBeside(artPath).flatMap(({ file, text }): Slicing[] => {
      const cut = text === undefined ? undefined : tresSlicing(text, file, artPath);
      if (!cut) return [];
      if ("tiles" in cut) {
        const { w, h, margin, separation, coords } = cut.tiles;
        const rects = coords.map(([c, r]) => ({ x: margin + c * (w + separation), y: margin + r * (h + separation), w, h }));
        if (rects.some(r => r.x + r.w > width || r.y + r.h > height)) return [{ file, why: "its tiles reach past the art" }];
        if (margin || separation) return [{ file, rects, tiles: true, why: "its tiles have margins or spacing" }];
        if (width % w || height % h) return [{ file, rects, tiles: true, why: `its ${w}x${h} tiles do not divide the art` }];
        return [{ file, rects, tiles: true, grid: { cols: width / w, rows: height / h, frames: (width / w) * (height / h) } }];
      }
      const grid = uniformGrid(cut.rects, width, height);
      return [grid ? { file, rects: cut.rects, grid } : { file, rects: cut.rects, why: "its frames are not a uniform grid" }];
    });
  }
  if (engine === "unity") {
    const metaPath = path.resolve(artPath) + ".meta";
    const meta = metaText(metaPath);
    if (meta === undefined) return [];
    const rects = metaRects(meta, width, height);
    const grid = uniformGrid(rects, width, height);
    return [grid ? { file: metaPath, rects, grid } : { file: metaPath, rects, why: "its sprites are not a uniform grid" }];
  }
  return [];
}

/** How an existing engine file cuts the art: its rects, and the uniform grid they make, if they make one. */
export interface Slicing {
  file: string;
  rects?: { x: number; y: number; w: number; h: number }[];
  grid?: { cols: number; rows: number; frames: number };
  tiles?: boolean; // a TileSet's tiles
  why?: string; // why it is no uniform grid
}

/**
 * The grid of cells `rects` (top-left origin) are cut from, as this CLI's
 * writers cut a sheet: cells of one size filling the sheet, each rect its
 * cell less a repeated border of `e` on every side (an extruded sheet's), in
 * any order and with cells left out (empty tiles). Undefined otherwise.
 */
export function uniformGrid(rects: { x: number; y: number; w: number; h: number }[], width: number, height: number): { cols: number; rows: number; frames: number } | undefined {
  if (!rects.length) return undefined;
  const [fw, fh] = [rects[0].w, rects[0].h];
  if (!rects.every(r => r.w === fw && r.h === fh && Number.isInteger(r.x) && Number.isInteger(r.y))) return undefined;
  for (let e = 0; e <= 64; e++) {
    const [cw, ch] = [fw + 2 * e, fh + 2 * e];
    if (width % cw || height % ch) continue;
    if (rects.every(r => (r.x - e) % cw === 0 && (r.y - e) % ch === 0 && r.x >= e && r.y >= e && r.x + fw + e <= width && r.y + fh + e <= height)) {
      return { cols: width / cw, rows: height / ch, frames: rects.length };
    }
  }
  return undefined;
}

/** Throws unless `file` (or, when it is not there yet, its folder) can be written. */
export function assertWritable(file: string): void {
  const target = fs.existsSync(file) ? file : path.dirname(file);
  try {
    fs.accessSync(target, fs.constants.W_OK);
  } catch {
    throw new Error(`${target} cannot be written (read-only, or checked in and locked?), so nothing was written`);
  }
}
