import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CliError, EXIT } from "../errors.js";
import { readPng, readText, PngError, type Image } from "../tty/png.js";
import type { NormalMap } from "../tty/engines.js";
import { findGodotProject, relativePath } from "../tty/godot.js";
import { readInput } from "./read-file.js";
import { shown } from "./io.js";
import { shellArg } from "./registry.js";

// A normal map next to its art: how the toolbox finds one, tells it from a
// picture that only shares the name, and says how engines without a place
// for it in their files load it.

// The stamp `image normals` writes: which way the map's green points, and
// a checksum of its pixels ("opengl rgba-sha256:1f2e..."), so a map
// retouched since (in an editor that keeps PNG text) is not taken for one
// this tool may replace.
export const NORMAL_KEY = "ludo:normal";

/** The stamp's text for a map of `format` with these pixels. */
export const normalStamp = (format: "opengl" | "directx", img: Image) => `${format} rgba-sha256:${pixelHash(img)}`;

const pixelHash = (img: Image) => createHash("sha256").update(img.rgba).digest("hex").slice(0, 16);

/** The stamp's format, and its checksum if it has one. */
export function parseStamp(text: string | undefined): { format: "opengl" | "directx"; hash?: string } | undefined {
  const m = /^(opengl|directx)(?: rgba-sha256:([0-9a-f]{16}))?$/.exec(text ?? "");
  return m ? { format: m[1] as "opengl" | "directx", ...(m[2] ? { hash: m[2] } : {}) } : undefined;
}

// `<art>_n.png`, the name `image normals` gives a map and Unity's samples
// use. Only beside the art: a map in another folder is passed by name.
export const normalMapName = (art: string) => path.join(path.dirname(art), `${path.basename(art).replace(/\.[^.]+$/, "")}_n.png`);
// What asset manifest takes for a map's name: <name>_n.png, or the
// <name>_n-2.png a second `image normals` run (without --engine) writes.
export const NORMAL_SUFFIX = /_n(?:-\d+)?$/i;
export const isNormalMapName = (file: string) => /_n(?:-\d+)?\.png$/i.test(file);

// Whether `file` is there under that very name: on macOS's and Windows'
// file systems hero_N.png (a sprite facing north) answers to hero_n.png too.
export function existsExactly(file: string): boolean {
  try {
    return fs.readdirSync(path.dirname(path.resolve(file))).includes(path.basename(file));
  } catch {
    return false;
  }
}

// Whether an image is a normal map: nearly all of its visible pixels decode
// to unit vectors facing the viewer (blue at or above the middle), as a
// tangent-space map's do, in either green convention. Art fails this on its
// shadows and highlights: black, white, grey and most colours are far from
// unit length (of some 1,700 sprites, sheets and screenshots, only a
// blue-to-purple gradient passed). Pixels under alpha 128 are left out: a
// map's clear pixels hold whatever the tool wrote. Up to about a million
// pixels are looked at, spread over the image.
export function looksLikeNormalMap(img: Image): boolean {
  const n = img.width * img.height;
  const step = Math.max(1, Math.floor(n / 1_000_000));
  let seen = 0;
  let unit = 0;
  for (let p = 0; p < n; p += step) {
    const i = p * 4;
    if (img.rgba[i + 3] < 128) continue;
    seen++;
    const [x, y, z] = [img.rgba[i] / 127.5 - 1, img.rgba[i + 1] / 127.5 - 1, img.rgba[i + 2] / 127.5 - 1];
    // 8-bit rounding moves the length by under 1%; hand-made maps stray
    // further (Unity's 2D sample Nori_n.png: 97% of pixels within 12%).
    if (z > -0.02 && Math.abs(Math.hypot(x, y, z) - 1) < 0.2) unit++;
  }
  return seen > 0 && unit >= seen * 0.95;
}

export interface FoundNormalMap extends NormalMap {
  width: number;
  height: number;
  stamped: boolean; // made by `image normals`, which stamps it
  unchanged: boolean; // stamped, and its pixels still those it was stamped with
  normalLike: boolean; // its pixels are a normal map's (looksLikeNormalMap)
}

/** Reads a PNG as a normal map: its size, its format (the stamp, else OpenGL) and whether it is one. */
export function readNormalMap(file: string): FoundNormalMap {
  const buf = readInput(file, "a normal map");
  try {
    const { image } = readPng(buf);
    const stamp = parseStamp(readText(buf)[NORMAL_KEY]);
    return {
      file,
      format: stamp?.format ?? "opengl",
      width: image.width,
      height: image.height,
      stamped: !!stamp,
      unchanged: !!stamp?.hash && stamp.hash === pixelHash(image),
      normalLike: looksLikeNormalMap(image)
    };
  } catch (err) {
    if (!(err instanceof PngError)) throw err;
    throw new CliError(`Cannot read the normal map ${file}: ${err.message}`, EXIT.BAD_INPUT, "A normal map is a PNG: make one with ludo toolbox image normals <sheet>.");
  }
}

/**
 * What a file beside the art is to `image normals --engine`: "ours" (its
 * stamp, and its pixels unchanged since: it may be replaced), "changed"
 * (stamped, but its pixels are not the ones it was stamped with), or
 * "foreign".
 */
export function mapState(file: string): "ours" | "changed" | "foreign" {
  try {
    const buf = fs.readFileSync(file);
    const stamp = parseStamp(readText(buf)[NORMAL_KEY]);
    if (!stamp) return "foreign";
    return stamp.hash && stamp.hash === pixelHash(readPng(buf).image) ? "ours" : "changed";
  } catch {
    return "foreign";
  }
}

// The nearest folder at or above `dir` that is a Unity project (it has
// Assets/ and ProjectSettings/ProjectVersion.txt, as `ludo init` tells one).
function unityProject(dir: string): string | undefined {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, "ProjectSettings", "ProjectVersion.txt")) && fs.existsSync(path.join(d, "Assets"))) return d;
    if (path.dirname(d) === d) return undefined;
  }
}

const real = (p: string) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

/**
 * Throws (bad input) when the engine's files could not find `map` from
 * `art`'s: Godot resolves a res:// path in the art's project, so the map has
 * to be in that very project (or, outside any, in none); Unity finds it by
 * guid among its project's assets, so it has to be under the art's project's
 * Assets/ (or, outside any, in none). Checked before anything is written.
 */
export function checkMapPlace(engine: string, art: string, map: string): void {
  const [artDir, mapDir] = [real(path.dirname(path.resolve(art))), real(path.dirname(path.resolve(map)))];
  const fix = "Put the map beside the art (ludo toolbox image normals <art> --engine " + engine + " makes it there).";
  if (engine === "godot") {
    const [a, m] = [findGodotProject(artDir), findGodotProject(mapDir)];
    if (a !== m) {
      throw new CliError(
        a
          ? `The normal map ${shown(map)} is ${m ? "in another Godot project" : "outside the Godot project"} of ${shown(art)} (${shown(a)}), so the art's Godot files could not load it`
          : `The normal map ${shown(map)} is inside a Godot project (${shown(m!)}) and ${shown(art)} is not, so the art's Godot files could not load it`,
        EXIT.BAD_INPUT,
        fix
      );
    }
  }
  if (engine === "unity") {
    const [a, m] = [unityProject(artDir), unityProject(mapDir)];
    const inAssets = (p: string, project: string) => !path.relative(path.join(project, "Assets"), p).startsWith("..");
    if (a !== m || (a && !inAssets(mapDir, a))) {
      throw new CliError(
        a
          ? `The normal map ${shown(map)} is not under the Assets folder of ${shown(art)}'s Unity project (${shown(a)}), so Unity could not find it by its guid`
          : `The normal map ${shown(map)} is inside a Unity project (${shown(m!)}) and ${shown(art)} is not, so the sheet's .meta could not find it`,
        EXIT.BAD_INPUT,
        fix
      );
    }
  }
}

/**
 * The normal map engine files for `sheet` should use: --normal-map, else
 * `<sheet>_n.png` beside it (that very name) when it is a normal map of the
 * sheet's size, unless --no-normal-map. A picture that only shares the name
 * (a sprite facing north) is left out with a note. A map of another size, or
 * one the engine's files could not find, is bad input, except a map found
 * beside the sheet for TexturePacker, whose atlas has no place for one: it
 * is only mentioned, when it fits.
 */
export function sheetNormalMap(
  sheet: string,
  size: { width: number; height: number },
  given: string | undefined,
  none: boolean,
  engine: string
): { map?: FoundNormalMap; from?: "flag" | "beside"; notes: string[] } {
  const notes: string[] = [];
  if (given !== undefined && none) throw new CliError("--normal-map and --no-normal-map do not go together", EXIT.USAGE);
  if (none) return { notes };
  if (given !== undefined && real(given) === real(sheet)) throw new CliError("--normal-map names the sheet itself: pass its normal map (<name>_n.png)", EXIT.USAGE);
  const beside = normalMapName(sheet);
  const file = given ?? (existsExactly(beside) ? beside : undefined);
  if (!file) return { notes };
  const from = given !== undefined ? "flag" : "beside";
  const lenient = from === "beside" && engine === "texturepacker";
  let map: FoundNormalMap;
  try {
    map = readNormalMap(file);
  } catch (err) {
    if (from === "flag" || !(err instanceof CliError)) throw err;
    if (!lenient) notes.push(`${shown(file)} is beside the sheet but is not a PNG it can read, so it is left out.`);
    return { notes };
  }
  if (!map.stamped && !map.normalLike) {
    if (from === "beside") {
      if (!lenient) notes.push(`${shown(file)} is beside the sheet but does not look like a normal map, so it is left out (pass --normal-map ${shellArg(shown(file))} to use it anyway).`);
      return { notes };
    }
    notes.push(`${shown(file)} does not look like a normal map (its pixels are not unit normals), but it is used as one, as --normal-map says.`);
  }
  if (map.width !== size.width || map.height !== size.height) {
    if (lenient) return { notes };
    // A hint whose command clears the error: `image normals --engine`
    // replaces a map it made beside the sheet, and only such a map.
    const remake = `ludo toolbox image normals ${shellArg(shown(sheet))} --engine ${engine}`;
    throw new CliError(
      `The normal map ${shown(file)} is ${map.width}x${map.height} and the sheet ${size.width}x${size.height}: a normal map has to be its sheet's size, pixel for pixel`,
      EXIT.BAD_INPUT,
      from === "flag"
        ? `Pass the map made from this sheet, or make one beside it and leave --normal-map out: ${remake}`
        : map.unchanged
          ? `Make it again from the sheet, which replaces it and writes the engine files: ${remake} (or pass --no-normal-map to export without it).`
          : `It was not made by ludo toolbox image normals, or has changed since: move or rename it, or pass --no-normal-map to export without it.`
    );
  }
  if (!lenient) checkMapPlace(engine, sheet, file);
  return { map, from, notes };
}

// What a directx map does in an engine that reads OpenGL ones.
export function directxNote(engine: string, file: string): string | undefined {
  if (engine === "unity") {
    return unityFlipsGreen(file)
      ? `${shown(file)} is a DirectX normal map: its .meta turns on Flip Green Channel, so Unity reads it the right way up.`
      : `${shown(file)} is a DirectX normal map, and its .meta (from a Unity without Flip Green Channel) cannot flip it, so Unity reads it upside down: make it again without --normal-format directx.`;
  }
  if (engine === "godot") return `${shown(file)} is a DirectX normal map, and Godot reads OpenGL ones (green up): turn on Normal Map Invert Y in its Import dock, or make it again without --normal-format directx.`;
  return `${shown(file)} is a DirectX normal map, and Phaser reads OpenGL ones (green up): make it again without --normal-format directx.`;
}

// Lights in Phaser: the loader takes the map with the art, and the scene
// turns lights on. Phaser 3 and 4 differ only in how a sprite opts in.
export const PHASER_LIGHTS = 'this.lights.enable() in the scene and, on each sprite, setPipeline("Light2D") in Phaser 3 or setLighting(true) in Phaser 4 (WebGL only)';

// How to load an atlas (or a still, without one) with its normal map in
// Phaser, whose TexturePacker JSON has no place for it; PixiJS has no
// normal-map lighting of its own.
export function phaserNormalMapNote(art: string, map: string, atlas?: string): string {
  const url = (p: string) => JSON.stringify(relativePath(path.dirname(path.resolve(art)), p));
  const key = JSON.stringify(path.basename(art).replace(/\.[^.]+$/, ""));
  const load = atlas
    ? `this.load.atlas({ key: ${key}, textureURL: ${url(art)}, atlasURL: ${url(atlas)}, normalMap: ${url(map)} }) (load.aseprite takes the same)`
    : `this.load.image({ key: ${key}, url: ${url(art)}, normalMap: ${url(map)} })`;
  return `${atlas ? "A TexturePacker atlas has no place for a normal map, so Phaser loads it with the art" : "Phaser loads a still image with its normal map, no atlas needed"}: ${load}, then ${PHASER_LIGHTS}. PixiJS has no normal-map lighting of its own.`;
}

// URP's 2D lights skip normal maps until a light asks for them: Light 2D's
// Normal Maps quality is Disabled by default (Light2D.cs:
// m_NormalMapQuality = NormalMapQuality.Disabled).
export const UNITY_LIGHTS = "In Unity the sprite is lit through the map by a Light 2D whose Normal Maps quality is Fast or Accurate (it is Disabled by default), in a project on URP's 2D Renderer with lit sprites (Sprite-Lit-Default).";

// Whether the map's .meta, as written, flips green on import.
function unityFlipsGreen(map: string): boolean {
  try {
    return /^ {4}flipGreenChannel: 1\r?$/m.test(fs.readFileSync(path.resolve(map) + ".meta", "utf8"));
  } catch {
    return false;
  }
}
