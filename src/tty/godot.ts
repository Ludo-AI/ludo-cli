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
//  - SpriteFrames has no pivot: with `sprite export --pivot` a `.tscn` scene
//    also comes, an AnimatedSprite2D playing the .tres whose `offset` (with
//    `centered` on, the default) puts the pivot at the node's origin.
//  - A normal map (ludo toolbox image normals) goes with its art in a
//    CanvasTexture (diffuse_texture + normal_texture), which is what Godot
//    2D lights read normals from. The AtlasTextures cut their frames out of
//    that CanvasTexture instead of the bare sheet: rendered in Godot 4.7.2
//    (Compatibility and Forward+), an AnimatedSprite2D on such frames is
//    shaded by a PointLight2D through the map, the same frames on the bare
//    sheet are not. The map is a plain PNG import: Godot's defaults
//    (lossless, no mipmaps, no colour conversion in 2D) read it as data.
//    Godot reads OpenGL maps (green up).

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
const NORMAL_ID = "2_normal";
const CANVAS_ID = "CanvasTexture_lit";

// A CanvasTexture's properties: the art, and the normal map lights read.
const canvasTextureBody = (header: string) => [header, `diffuse_texture = ExtResource("${TEXTURE_ID}")`, `normal_texture = ExtResource("${NORMAL_ID}")`];

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

/**
 * Pure: the `.tres` text. `texturePath` (and `normalPath`, the sheet's
 * normal map, when there is one) go verbatim into the ext_resource paths.
 */
export function spriteFramesTres(
  texturePath: string,
  sheetWidth: number,
  sheetHeight: number,
  grid: SheetGrid,
  animationName = "default",
  layout: FrameLayout = {},
  normalPath?: string,
): string {
  const { w, h } = frameSize(sheetWidth, sheetHeight, grid);
  const e = layout.extrude ?? 0;
  if (!Number.isInteger(e) || e < 0 || 2 * e >= Math.min(w, h)) throw new Error(`Godot export: an extrude of ${e} does not fit ${w}x${h} frames`);
  const [fw, fh] = [w - 2 * e, h - 2 * e];
  const t = layout.trim && layout.trim.w === fw && layout.trim.h === fh ? layout.trim : undefined;
  const out: string[] = [];
  out.push(`[gd_resource type="SpriteFrames" format=3]`, "");
  out.push(`[ext_resource type="Texture2D" path=${quote(texturePath)} id="${TEXTURE_ID}"]`);
  if (normalPath) out.push(`[ext_resource type="Texture2D" path=${quote(normalPath)} id="${NORMAL_ID}"]`);
  out.push("");
  if (normalPath) out.push(...canvasTextureBody(`[sub_resource type="CanvasTexture" id="${CANVAS_ID}"]`), "");
  const atlas = normalPath ? `SubResource("${CANVAS_ID}")` : `ExtResource("${TEXTURE_ID}")`;
  for (let i = 0; i < grid.frames; i++) {
    const x = (i % grid.cols) * w + e;
    const y = Math.floor(i / grid.cols) * h + e;
    out.push(`[sub_resource type="AtlasTexture" id="AtlasTexture_${i}"]`);
    out.push(`atlas = ${atlas}`);
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

/** Pure: the `.tscn` text, an AnimatedSprite2D playing `framesPath` with the pivot at its origin. */
export function animatedSpriteScene(
  framesPath: string,
  nodeName: string,
  sheetWidth: number,
  sheetHeight: number,
  grid: SheetGrid,
  pivot: { x: number; y: number },
  animationName = "default",
  layout: FrameLayout = {},
): string {
  const { w, h } = frameSize(sheetWidth, sheetHeight, grid);
  const e = layout.extrude ?? 0;
  const [fw, fh] = [w - 2 * e, h - 2 * e];
  // The frame Godot draws: the untrimmed one when the AtlasTexture has a margin.
  const t = layout.trim && layout.trim.w === fw && layout.trim.h === fh ? layout.trim : undefined;
  const [dw, dh] = t ? [t.source_w, t.source_h] : [fw, fh];
  const name = nodeName.replace(/[.:@/"%]/g, "_") || "Sprite";
  return [
    `[gd_scene format=3]`,
    ``,
    `[ext_resource type="SpriteFrames" path=${quote(framesPath)} id="1_frames"]`,
    ``,
    `[node name=${quote(name)} type="AnimatedSprite2D"]`,
    `sprite_frames = ExtResource("1_frames")`,
    `animation = &${quote(animationName)}`,
    `autoplay = ${quote(animationName)}`,
    `offset = Vector2(${dw / 2 - pivot.x}, ${dh / 2 - pivot.y})`,
    ``,
  ].join("\n");
}

/**
 * Writes `<.tres basename>.tscn` next to the SpriteFrames `tresPath` (never
 * overwriting: adds -2, -3, ...) and returns its path.
 */
export function writeGodotScene(
  tresPath: string,
  sheetWidth: number,
  sheetHeight: number,
  grid: SheetGrid,
  pivot: { x: number; y: number },
  animationName?: string,
  layout?: FrameLayout,
): string {
  const dir = path.dirname(path.resolve(tresPath));
  const base = path.basename(tresPath, path.extname(tresPath));
  const text = animatedSpriteScene(godotTexturePath(tresPath), animationName || base, sheetWidth, sheetHeight, grid, pivot, animationName, layout);
  for (let n = 1; ; n++) {
    const target = path.join(dir, `${base}${n > 1 ? `-${n}` : ""}.tscn`);
    try {
      fs.writeFileSync(target, text, { flag: "wx" });
      return target;
    } catch (err: any) {
      if (err?.code === "EEXIST") continue;
      throw new Error(`Could not write Godot scene ${target}: ${err?.code || err?.message || err}`);
    }
  }
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
  normalMapPath?: string,
): string {
  const normal = normalMapPath ? godotNeighbourPath(sheetPath, normalMapPath) : undefined;
  const text = spriteFramesTres(godotTexturePath(sheetPath), sheetWidth, sheetHeight, grid, animationName, layout, normal);
  return writeNumbered(sheetPath, text, "Godot SpriteFrames");
}

/** Pure: a CanvasTexture `.tres`, the art with its normal map, for a Sprite2D's texture. */
export function canvasTextureTres(texturePath: string, normalPath: string): string {
  return [
    `[gd_resource type="CanvasTexture" format=3]`,
    ``,
    `[ext_resource type="Texture2D" path=${quote(texturePath)} id="${TEXTURE_ID}"]`,
    `[ext_resource type="Texture2D" path=${quote(normalPath)} id="${NORMAL_ID}"]`,
    ``,
    ...canvasTextureBody("[resource]"),
    ``,
  ].join("\n");
}

/**
 * Writes `<art basename>.tres` next to a still image (never overwriting:
 * adds -2, -3, ...), a CanvasTexture of it and its normal map, and returns
 * its path: a Sprite2D whose texture it is gets lit through the map.
 */
export function writeGodotCanvasTexture(artPath: string, normalMapPath: string): string {
  return writeNumbered(artPath, canvasTextureTres(godotTexturePath(artPath), godotNeighbourPath(artPath, normalMapPath)), "Godot CanvasTexture");
}

// A .tres's text, read only as far as rewiring a texture needs: its header
// line, its sections, and each ext_resource's attributes.
const SECTION = /^\[(gd_resource|ext_resource|sub_resource|resource)\b(.*)\]$/;
const ATTRS = /(\w+)=("(?:[^"\\]|\\.)*"|[^\s\]]+)/g;
const unquote = (q: string) => (q.startsWith('"') ? q.slice(1, -1).replace(/\\(.)/g, (_, c) => (c === "n" ? "\n" : c)) : q);
const attrsOf = (s: string) => Object.fromEntries([...s.matchAll(ATTRS)].map(m => [m[1], unquote(m[2])]));

export type Rewired = { text: string; oldNormal?: string } | { refused: string; type?: string };

// "an AtlasTexture", "a TileSet".
export const article = (word: string) => `${/^[aeiou]/i.test(word) ? "an" : "a"} ${word}`;

interface TresParts {
  eol: string;
  lines: string[];
  type?: string;
  sections: { at: number; kind: string; attrs: Record<string, string> }[];
  exts: { at: number; kind: string; attrs: Record<string, string> }[];
  artExts: { at: number; kind: string; attrs: Record<string, string> }[];
  resolve: (p: string) => string | undefined;
  real: (p: string) => string;
}

// A .tres split into what rewiring and slicing read, when it uses the art
// (a Texture ext_resource whose path, res:// or relative, is the art's file).
function tresParts(text: string, tresPath: string, artPath: string): TresParts | undefined {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(eol);
  const dir = path.dirname(path.resolve(tresPath));
  const project = findGodotProject(dir);
  const real = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  const resolve = (p: string) => (p.startsWith("res://") ? (project ? path.join(project, p.slice(6)) : undefined) : path.isAbsolute(p) ? p : path.join(dir, p));
  const head = SECTION.exec(lines[0] ?? "");
  if (!head || head[1] !== "gd_resource") return undefined;
  const sections = lines.flatMap((l, i) => {
    const m = SECTION.exec(l);
    return m ? [{ at: i, kind: m[1], attrs: attrsOf(m[2]) }] : [];
  });
  const exts = sections.filter(x => x.kind === "ext_resource");
  const art = real(artPath);
  const artExts = exts.filter(x => {
    const p = /Texture/.test(x.attrs.type ?? "") && x.attrs.path ? resolve(x.attrs.path) : undefined;
    return !!p && real(p) === art;
  });
  if (!artExts.length) return undefined;
  return { eol, lines, type: attrsOf(head[2]).type, sections, exts, artExts, resolve, real };
}

/**
 * How a .tres that uses the art cuts it: a SpriteFrames' AtlasTexture
 * regions (those from the art, directly or through a CanvasTexture of it),
 * or a TileSet's atlas source tiles (size, margins, separation). Undefined
 * for a file that does not use the art or does not cut it (a CanvasTexture).
 */
export function tresSlicing(
  text: string,
  tresPath: string,
  artPath: string
): { rects: { x: number; y: number; w: number; h: number }[] } | { tiles: { w: number; h: number; margin: number; separation: number; coords: [number, number][] } } | undefined {
  const parts = tresParts(text, tresPath, artPath);
  if (!parts || parts.artExts.length !== 1) return undefined;
  const { lines, sections, artExts } = parts;
  const body = (sec: (typeof sections)[number]) => {
    const next = sections.find(x => x.at > sec.at);
    return lines.slice(sec.at + 1, next ? next.at : lines.length);
  };
  const artRef = `ExtResource("${artExts[0].attrs.id}")`;
  // The art, or a CanvasTexture of it.
  const fromArt = new Set([artRef, ...sections.filter(x => x.kind === "sub_resource" && x.attrs.type === "CanvasTexture" && body(x).includes(`diffuse_texture = ${artRef}`)).map(x => `SubResource("${x.attrs.id}")`)]);
  const subs = sections.filter(x => x.kind === "sub_resource");
  if (parts.type === "TileSet") {
    const source = subs.find(x => x.attrs.type === "TileSetAtlasSource" && body(x).some(l => fromArt.has(l.replace(/^texture = /, ""))));
    if (!source) return undefined;
    const v = (name: string) => {
      const m = new RegExp(`^${name} = Vector2i\\((-?\\d+), (-?\\d+)\\)$`).exec(body(source).find(l => l.startsWith(`${name} = `)) ?? "");
      return m ? [Number(m[1]), Number(m[2])] : undefined;
    };
    const [w, h] = v("texture_region_size") ?? [16, 16];
    const margin = Math.max(...(v("margins") ?? [0, 0]));
    const separation = Math.max(...(v("separation") ?? [0, 0]));
    // The tiles it lists ("c:r/0 = 0"): the empty ones are not there.
    const coords = [...new Set(body(source).flatMap(l => /^(\d+):(\d+)\//.exec(l)?.slice(1, 3).join(":") ?? []))].map(k => k.split(":").map(Number) as [number, number]);
    return { tiles: { w, h, margin, separation, coords } };
  }
  // A standalone AtlasTexture's own [resource] cuts the art too.
  const cutters = parts.type === "AtlasTexture" ? sections.filter(x => x.kind === "resource") : subs.filter(x => x.attrs.type === "AtlasTexture");
  const rects = cutters
    .filter(x => body(x).some(l => fromArt.has(l.replace(/^atlas = /, ""))))
    .flatMap(x => {
      const m = /^region = Rect2\(([-\d.]+), ([-\d.]+), ([-\d.]+), ([-\d.]+)\)$/.exec(body(x).find(l => l.startsWith("region = ")) ?? "");
      return m ? [{ x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]) }] : [];
    });
  return rects.length ? { rects } : undefined;
}

/**
 * Pure but for reading paths: `text`, a .tres at `tresPath`, with `artPath`
 * lit through the normal map `mapPath`, or undefined when the file does not
 * use that art (another art's file: not this run's business). A SpriteFrames
 * gets a CanvasTexture (diffuse: the art, normal: the map) that every
 * reference to the art now points at, its AtlasTextures' `atlas` above all;
 * a CanvasTexture of the art gets the map as its normal_texture; one that
 * already had a map (another, or an older copy) has it replaced, and
 * `oldNormal` says which. Everything else stays as it was, byte for byte,
 * whoever wrote the file: this CLI, or Godot saving it back (uids, other
 * ids, `"loop": 1`). `mapUid`, the map's uid from its .import, goes on the
 * new ext_resource when the art's has one. Refused (with why) for a file
 * that uses the art in a way this does not rewire.
 */
export function rewireTres(text: string, tresPath: string, artPath: string, mapPath: string, mapUid?: string): Rewired | undefined {
  const parts = tresParts(text, tresPath, artPath);
  if (!parts) return undefined;
  const { eol, lines, type, sections, exts, artExts, resolve, real } = parts;
  const map = real(mapPath);
  // Each kind of resource that takes a Texture2D where the art goes: the
  // CanvasTexture is one.
  if (!["SpriteFrames", "CanvasTexture", "TileSet", "AtlasTexture"].includes(type ?? "")) return { refused: `${article(type ?? "resource")}, not a SpriteFrames, TileSet, AtlasTexture or CanvasTexture`, type };
  if (artExts.length > 1) return { refused: "it loads the art twice", type };
  const artId = artExts[0].attrs.id;
  const ref = (id: string) => `ExtResource("${id}")`;
  const bodyOf = (sec: (typeof sections)[number]) => {
    const next = sections.find(x => x.at > sec.at);
    return { from: sec.at + 1, to: next ? next.at : lines.length };
  };
  // The CanvasTexture of the art already there, if any: the file's own
  // [resource] for a CanvasTexture, else a CanvasTexture sub_resource.
  const diffuseOf = (sec: (typeof sections)[number]) => {
    const { from, to } = bodyOf(sec);
    return lines.slice(from, to).some(l => l === `diffuse_texture = ${ref(artId)}`);
  };
  const canvases = type === "CanvasTexture" ? sections.filter(x => x.kind === "resource") : sections.filter(x => x.kind === "sub_resource" && x.attrs.type === "CanvasTexture" && diffuseOf(x));
  if (type === "CanvasTexture" && !(canvases[0] && diffuseOf(canvases[0]))) return { refused: "its diffuse_texture is not the art", type };
  if (canvases.length > 1) return { refused: "it has more than one CanvasTexture of the art", type };
  const taken = new Set(sections.map(x => x.attrs.id).filter(Boolean));
  const freeId = (want: string) => {
    let id = want;
    for (let n = 2; taken.has(id); n++) id = `${want}_${n}`;
    taken.add(id);
    return id;
  };
  const extLine = (id: string) => `[ext_resource type="Texture2D"${artExts[0].attrs.uid && mapUid ? ` uid="${mapUid}"` : ""} path=${quote(godotNeighbourPath(tresPath, mapPath))} id="${id}"]`;
  const out = [...lines];
  let oldNormal: string | undefined;
  let added = 0;
  const canvas = canvases[0];
  const canvasId = canvas?.attrs.id ?? freeId("CanvasTexture_lit");
  // Every other reference to the art (an AtlasTexture's atlas, a frame's
  // texture, a TileSetAtlasSource's texture) now goes through the
  // CanvasTexture.
  if (type !== "CanvasTexture") {
    const skip = canvas ? bodyOf(canvas) : { from: 0, to: 0 };
    for (let i = artExts[0].at + 1; i < out.length; i++) if (i < skip.from || i >= skip.to) out[i] = out[i].split(ref(artId)).join(`SubResource("${canvasId}")`);
  }
  if (canvas) {
    const { from, to } = bodyOf(canvas);
    const at = lines.slice(from, to).findIndex(l => l.startsWith("normal_texture = "));
    const was = at < 0 ? undefined : /^normal_texture = ExtResource\("([^"]+)"\)$/.exec(lines[from + at]);
    const wasExt = was && exts.find(x => x.attrs.id === was[1]);
    if (wasExt?.attrs.path) {
      const p = resolve(wasExt.attrs.path);
      if (p && real(p) !== map) oldNormal = wasExt.attrs.path;
    }
    // The old map's ext_resource, used only here, now names this one;
    // else a new one is added.
    if (was && wasExt && text.split(ref(was[1])).length === 2) out[wasExt.at] = extLine(was[1]);
    else {
      const id = freeId("2_normal");
      out.splice(artExts[0].at + 1, 0, extLine(id));
      added++;
      const line = `normal_texture = ${ref(id)}`;
      const shift = 1;
      if (at >= 0) out[from + at + shift] = line;
      else out.splice(from + shift + lines.slice(from, to).findIndex(l => l.startsWith("diffuse_texture = ")) + 1, 0, line);
    }
  } else {
    const id = freeId("2_normal");
    // Declared before anything uses it: before the first sub_resource.
    const firstUse = sections.find(x => x.kind === "sub_resource" || x.kind === "resource");
    if (!firstUse) return { refused: "nothing in it uses the art", type };
    const first = firstUse.at;
    out.splice(first, 0, `[sub_resource type="CanvasTexture" id="${canvasId}"]`, `diffuse_texture = ${ref(artId)}`, `normal_texture = ${ref(id)}`, "");
    out.splice(artExts[0].at + 1, 0, extLine(id));
    added += 2;
  }
  // Godot before 4.5 counts the resources in load_steps.
  if (added) out[0] = out[0].replace(/\bload_steps=(\d+)/, (_, n) => `load_steps=${Number(n) + added}`);
  return { text: out.join(eol), ...(oldNormal ? { oldNormal } : {}) };
}

/** The uid Godot gave `file` on import (its .import), if it has been imported. */
export function importedUid(file: string): string | undefined {
  try {
    return /^uid="(uid:\/\/[0-9a-z]+)"$/m.exec(fs.readFileSync(path.resolve(file) + ".import", "utf8"))?.[1];
  } catch {
    return undefined;
  }
}

/**
 * What a .tres written next to `sheetPath` should reference `file` as: its
 * res:// path in a project, else its path from the sheet's folder (just its
 * name when it sits beside the sheet).
 */
export function godotNeighbourPath(sheetPath: string, file: string): string {
  const abs = path.resolve(file);
  if (findGodotProject(path.dirname(path.resolve(sheetPath)))) return godotTexturePath(abs);
  return relativePath(path.dirname(path.resolve(sheetPath)), abs);
}

/**
 * `file` from `dir`, with forward slashes. Both are taken through symlinks
 * first, so one folder reached two ways (macOS's /var is /private/var)
 * gives the short path.
 */
export function relativePath(dir: string, file: string): string {
  const real = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return path.relative(real(dir), path.join(real(path.dirname(file)), path.basename(file))).split(path.sep).join("/");
}

// `<file basename>.tres` next to `file`, or -2, -3... when taken.
function writeNumbered(file: string, text: string, what: string): string {
  const dir = path.dirname(path.resolve(file));
  const base = path.basename(file, path.extname(file));
  for (let n = 1; ; n++) {
    const target = path.join(dir, `${base}${n > 1 ? `-${n}` : ""}.tres`);
    try {
      fs.writeFileSync(target, text, { flag: "wx" });
      return target;
    } catch (err: any) {
      if (err?.code === "EEXIST") continue;
      throw new Error(`Could not write ${what} ${target}: ${err?.code || err?.message || err}`);
    }
  }
}
