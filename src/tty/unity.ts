// Unity export: a spritesheet's `.png.meta`, which imports it as a Sprite
// sliced into one sprite per frame (Sprite Mode: Multiple), and an `.anim`
// AnimationClip that plays those sprites on a SpriteRenderer.
//
// Format notes (copied from what Unity 6000.3 itself writes, in
// Unity-Technologies/2d-techdemos: Tilemap/Destructible/Sprites/explosion.png.meta
// and Tilemap/IsometricZAsY/Characters/Witch/AnimationClips/Run E.anim):
//  - Sprites are named `<sheet>_<i>`, as Unity's Sprite Editor slices them,
//    and get the file IDs 21300000 + 2i (213 is the Sprite class), listed in
//    both `internalIDToNameTable` and `nameFileIdTable`. The clip points at
//    each sprite as {fileID, guid of the sheet, type: 3}.
//  - Sprite rects count from the bottom-left corner of the sheet.
//  - A clip has one key per frame at i / fps and stops at n / fps (the last
//    frame shows for one frame's time), `m_LoopTime: 1` to loop. Times are
//    float32, written as the shortest decimal that reads back the same.
//  - The `.meta` belongs to the sheet's file name, so it is replaced, not
//    numbered like other engine files. One that is already there keeps its
//    guid and each sprite's file ID, so scenes and prefabs using them still
//    find them.
//  - A trimmed sheet (ludo toolbox image trim) gives every sprite a custom
//    pivot at the centre of its untrimmed frame, so trimmed and untrimmed
//    frames sit in the same place. An extruded one keeps the repeated border
//    out of each rect.
//  - A pivot from `sprite export --pivot` is every sprite's custom pivot
//    (alignment 9), in its own rect's units from the bottom-left; --ppu sets
//    spritePixelsToUnits (100, Unity's default, without it).
//  - A normal map (ludo toolbox image normals) is the sheet's secondary
//    texture `_NormalMap`, which the 2D Renderer's lit sprite shaders (URP
//    2D lights) sample with the sprite's own UVs, as Unity's 2D samples
//    list theirs (2d-renderer-samples: Common/Sprites/GlowRocks B.png.meta).
//    The map gets a .meta of its own, kept like the sheet's (guid and all),
//    importing it as Unity's 6000.3 2d-techdemos imports its tile normal
//    map (Tilemap/Normal Mapping (Built-in)/Sprites/normalmap.png.meta):
//    Texture Type Normal map (textureType 1), sRGB off, alpha not
//    transparency, and the sheet's own size, filter, wrap and (no)
//    compression so its pixels stay on the sheet's. A DirectX map gets
//    flipGreenChannel: Unity reads OpenGL ones.

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { frameRects } from "../toolbox/sheet.js";
import type { AtlasGrid, FrameLayout } from "./texturepacker.js";
import type { EngineOptions, NormalMap } from "./engines.js";

export interface UnityGrid extends AtlasGrid {
  loop?: boolean;
}

// What an earlier .meta for the same sheet already says.
export interface UnityIds {
  guid: string;
  fileIds: Record<string, string>; // sprite name -> file ID
}

const SPRITE_CLASS = 213;
const FIRST_SPRITE_ID = 21300000;

// The shortest decimal that reads back as the same float32, as Unity writes them.
export function unityFloat(n: number): string {
  const f = Math.fround(n);
  if (f === 0) return "0";
  for (let p = 1; p < 10; p++) {
    const s = String(Number(f.toPrecision(p)));
    if (Math.fround(Number(s)) === f) return s;
  }
  return String(f);
}

function check(sheetWidth: number, sheetHeight: number, grid: AtlasGrid, layout: FrameLayout) {
  for (const [name, n] of Object.entries({ "sheet width": sheetWidth, "sheet height": sheetHeight, cols: grid.cols, rows: grid.rows, frames: grid.frames })) {
    if (!Number.isInteger(n) || n < 1) throw new Error(`Unity export: ${name} must be a positive integer, got ${n}`);
  }
  if (grid.frames > grid.cols * grid.rows) throw new Error(`Unity export: ${grid.frames} frames do not fit a ${grid.cols}x${grid.rows} grid`);
  if (!Number.isFinite(grid.fps) || grid.fps <= 0) throw new Error(`Unity export: fps must be a positive number, got ${grid.fps}`);
  const e = layout.extrude ?? 0;
  if (2 * e >= Math.floor(sheetWidth / grid.cols) || 2 * e >= Math.floor(sheetHeight / grid.rows)) {
    throw new Error(`Unity export: an extrude of ${e} leaves nothing of the frames`);
  }
}

export const spriteName = (sheet: string, i: number) => `${sheet}_${i}`;

// A YAML scalar as Unity writes it: plain when it can be, else single-quoted.
const yamlText = (s: string) => (/^[A-Za-z0-9_][A-Za-z0-9 _.()-]*$/.test(s) && !/ $/.test(s) ? s : `'${s.replace(/'/g, "''")}'`);

/** The sprites' file IDs, in frame order: the earlier .meta's where it names the same sprite. */
export function spriteFileIds(sheet: string, frames: number, earlier?: UnityIds): string[] {
  return Array.from({ length: frames }, (_, i) => earlier?.fileIds[spriteName(sheet, i)] ?? String(FIRST_SPRITE_ID + 2 * i));
}

// A sprite's 32-hex spriteID, stable for the same sheet and sprite.
const spriteId = (guid: string, name: string) => createHash("md5").update(`${guid}/${name}`).digest("hex");

// Unity's texture size cap, raised to fit the sheet so it is not scaled down
// on import.
const maxTextureSize = (w: number, h: number) => {
  let size = 2048;
  while (size < Math.max(w, h) && size < 16384) size *= 2;
  return size;
};

/** Pure: the `.png.meta` text for the sheet `sheet` (its name without the extension). */
export function unityTextureMeta(
  sheet: string,
  guid: string,
  sheetWidth: number,
  sheetHeight: number,
  grid: AtlasGrid,
  layout: FrameLayout = {},
  earlier?: UnityIds,
  rects?: { x: number; y: number; w: number; h: number }[], // explicit sprite rects (a tileset's), top-left origin
  options: EngineOptions = {},
  normalMapGuid?: string // the guid of the sheet's normal map, when it has one
): string {
  check(sheetWidth, sheetHeight, grid, layout);
  if (options.ppu !== undefined && !(Number.isFinite(options.ppu) && options.ppu > 0)) throw new Error(`Unity export: pixels per unit must be a positive number, got ${options.ppu}`);
  const p = options.pivot;
  const e = layout.extrude ?? 0;
  const t = rects ? undefined : layout.trim;
  const cells = rects ?? frameRects(sheetWidth, sheetHeight, grid.cols, grid.rows, grid.frames).map(r => ({ x: r.x + e, y: r.y + e, w: r.w - 2 * e, h: r.h - 2 * e }));
  const ids = spriteFileIds(sheet, cells.length, earlier);
  const names = ids.map((_, i) => spriteName(sheet, i));
  const max = maxTextureSize(sheetWidth, sheetHeight);
  const sprites = cells.map((r, i) => {
    const { w, h } = r;
    const trimmed = t && t.w === w && t.h === h && (t.w !== t.source_w || t.h !== t.source_h);
    // The pivot (else the untrimmed frame's centre), in the rect's own units
    // from its bottom-left: a trimmed rect starts t.x, t.y into its frame.
    const [px, py] = p ? [p.x, p.y] : trimmed ? [t.source_w / 2, t.source_h / 2] : [w / 2, h / 2];
    const [ox, oy] = trimmed ? [t.x, t.y] : [0, 0];
    const pivot = { x: (px - ox) / w, y: (oy + h - py) / h };
    const custom = trimmed || !!p;
    return [
      `    - serializedVersion: 2`,
      `      name: ${yamlText(names[i])}`,
      `      rect:`,
      `        serializedVersion: 2`,
      `        x: ${r.x}`,
      `        y: ${sheetHeight - (r.y + h)}`,
      `        width: ${w}`,
      `        height: ${h}`,
      `      alignment: ${custom ? 9 : 0}`,
      `      pivot: {x: ${unityFloat(pivot.x)}, y: ${unityFloat(pivot.y)}}`,
      `      border: {x: 0, y: 0, z: 0, w: 0}`,
      `      customData: `,
      `      outline: []`,
      `      physicsShape: []`,
      `      tessellationDetail: 0`,
      `      bones: []`,
      `      spriteID: ${spriteId(guid, names[i])}`,
      `      internalID: ${ids[i]}`,
      `      vertices: []`,
      `      indices: `,
      `      edges: []`,
      `      weights: []`
    ].join("\n");
  });
  return [
    `fileFormatVersion: 2`,
    `guid: ${guid}`,
    `TextureImporter:`,
    `  internalIDToNameTable:`,
    ...names.flatMap((n, i) => [`  - first:`, `      ${SPRITE_CLASS}: ${ids[i]}`, `    second: ${yamlText(n)}`]),
    `  externalObjects: {}`,
    `  serializedVersion: 13`,
    `  mipmaps:`,
    `    mipMapMode: 0`,
    `    enableMipMap: 0`,
    `    sRGBTexture: 1`,
    `    linearTexture: 0`,
    `    fadeOut: 0`,
    `    borderMipMap: 0`,
    `    mipMapsPreserveCoverage: 0`,
    `    alphaTestReferenceValue: 0.5`,
    `    mipMapFadeDistanceStart: 1`,
    `    mipMapFadeDistanceEnd: 3`,
    `  bumpmap:`,
    `    convertToNormalMap: 0`,
    `    externalNormalMap: 0`,
    `    heightScale: 0.25`,
    `    normalMapFilter: 0`,
    `    flipGreenChannel: 0`,
    `  isReadable: 0`,
    `  streamingMipmaps: 0`,
    `  streamingMipmapsPriority: 0`,
    `  vTOnly: 0`,
    `  ignoreMipmapLimit: 0`,
    `  grayScaleToAlpha: 0`,
    `  generateCubemap: 6`,
    `  cubemapConvolution: 0`,
    `  seamlessCubemap: 0`,
    `  textureFormat: 1`,
    `  maxTextureSize: ${max}`,
    `  textureSettings:`,
    `    serializedVersion: 2`,
    `    filterMode: 1`,
    `    aniso: 1`,
    `    mipBias: 0`,
    `    wrapU: 1`,
    `    wrapV: 1`,
    `    wrapW: 1`,
    `  nPOTScale: 0`,
    `  lightmap: 0`,
    `  compressionQuality: 50`,
    `  spriteMode: 2`,
    `  spriteExtrude: 1`,
    `  spriteMeshType: 0`,
    `  alignment: 0`,
    `  spritePivot: {x: 0.5, y: 0.5}`,
    `  spritePixelsToUnits: ${unityFloat(options.ppu ?? 100)}`,
    `  spriteBorder: {x: 0, y: 0, z: 0, w: 0}`,
    `  spriteGenerateFallbackPhysicsShape: 1`,
    `  alphaUsage: 1`,
    `  alphaIsTransparency: 1`,
    `  spriteTessellationDetail: -1`,
    `  textureType: 8`,
    `  textureShape: 1`,
    `  singleChannelComponent: 0`,
    `  flipbookRows: 1`,
    `  flipbookColumns: 1`,
    `  maxTextureSizeSet: 0`,
    `  compressionQualitySet: 0`,
    `  textureFormatSet: 0`,
    `  ignorePngGamma: 0`,
    `  applyGammaDecoding: 1`,
    `  swizzle: 50462976`,
    `  cookieLightType: 1`,
    `  platformSettings:`,
    `  - serializedVersion: 4`,
    `    buildTarget: DefaultTexturePlatform`,
    `    maxTextureSize: ${max}`,
    `    resizeAlgorithm: 0`,
    `    textureFormat: -1`,
    `    textureCompression: 0`,
    `    compressionQuality: 50`,
    `    crunchedCompression: 0`,
    `    allowsAlphaSplitting: 0`,
    `    overridden: 0`,
    `    ignorePlatformSupport: 0`,
    `    androidETC2FallbackOverride: 0`,
    `    forceMaximumCompressionQuality_BC6H_BC7: 1`,
    `  spriteSheet:`,
    `    serializedVersion: 2`,
    `    sprites:`,
    ...sprites,
    `    outline: []`,
    `    customData: `,
    `    physicsShape: []`,
    `    bones: []`,
    `    spriteID: `,
    `    internalID: 0`,
    `    vertices: []`,
    `    indices: `,
    `    edges: []`,
    `    weights: []`,
    ...(normalMapGuid ? [`    secondaryTextures:`, `    - texture: {fileID: 2800000, guid: ${normalMapGuid}, type: 3}`, `      name: _NormalMap`] : [`    secondaryTextures: []`]),
    `    spriteCustomMetadata:`,
    `      entries: []`,
    `    nameFileIdTable:`,
    ...names.map((n, i) => `      ${yamlText(n)}: ${ids[i]}`),
    `  mipmapLimitGroupName: `,
    `  pSDRemoveMatte: 0`,
    `  userData: `,
    `  assetBundleName: `,
    `  assetBundleVariant: `
  ].join("\n") + "\n";
}

/**
 * Pure: the `.png.meta` of a sheet's normal map, `width` x `height` like
 * the sheet: a Normal map texture (not a sprite), linear, imported at the
 * sheet's size with its filter, wrap and compression.
 */
export function unityNormalMapMeta(guid: string, width: number, height: number, flipGreen = false): string {
  for (const [name, n] of Object.entries({ "normal map width": width, "normal map height": height })) {
    if (!Number.isInteger(n) || n < 1) throw new Error(`Unity export: ${name} must be a positive integer, got ${n}`);
  }
  const max = maxTextureSize(width, height);
  return [
    `fileFormatVersion: 2`,
    `guid: ${guid}`,
    `TextureImporter:`,
    `  internalIDToNameTable: []`,
    `  externalObjects: {}`,
    `  serializedVersion: 13`,
    `  mipmaps:`,
    `    mipMapMode: 0`,
    `    enableMipMap: 0`,
    `    sRGBTexture: 0`,
    `    linearTexture: 0`,
    `    fadeOut: 0`,
    `    borderMipMap: 0`,
    `    mipMapsPreserveCoverage: 0`,
    `    alphaTestReferenceValue: 0.5`,
    `    mipMapFadeDistanceStart: 1`,
    `    mipMapFadeDistanceEnd: 3`,
    `  bumpmap:`,
    `    convertToNormalMap: 0`,
    `    externalNormalMap: 0`,
    `    heightScale: 0.25`,
    `    normalMapFilter: 0`,
    `    flipGreenChannel: ${flipGreen ? 1 : 0}`,
    `  isReadable: 0`,
    `  streamingMipmaps: 0`,
    `  streamingMipmapsPriority: 0`,
    `  vTOnly: 0`,
    `  ignoreMipmapLimit: 0`,
    `  grayScaleToAlpha: 0`,
    `  generateCubemap: 6`,
    `  cubemapConvolution: 0`,
    `  seamlessCubemap: 0`,
    `  textureFormat: 1`,
    `  maxTextureSize: ${max}`,
    `  textureSettings:`,
    `    serializedVersion: 2`,
    `    filterMode: 1`,
    `    aniso: 1`,
    `    mipBias: 0`,
    `    wrapU: 1`,
    `    wrapV: 1`,
    `    wrapW: 1`,
    `  nPOTScale: 0`,
    `  lightmap: 0`,
    `  compressionQuality: 50`,
    `  spriteMode: 0`,
    `  spriteExtrude: 1`,
    `  spriteMeshType: 0`,
    `  alignment: 0`,
    `  spritePivot: {x: 0.5, y: 0.5}`,
    `  spritePixelsToUnits: 100`,
    `  spriteBorder: {x: 0, y: 0, z: 0, w: 0}`,
    `  spriteGenerateFallbackPhysicsShape: 1`,
    `  alphaUsage: 1`,
    `  alphaIsTransparency: 0`,
    `  spriteTessellationDetail: -1`,
    `  textureType: 1`,
    `  textureShape: 1`,
    `  singleChannelComponent: 0`,
    `  flipbookRows: 1`,
    `  flipbookColumns: 1`,
    `  maxTextureSizeSet: 0`,
    `  compressionQualitySet: 0`,
    `  textureFormatSet: 0`,
    `  ignorePngGamma: 0`,
    `  applyGammaDecoding: 1`,
    `  swizzle: 50462976`,
    `  cookieLightType: 1`,
    `  platformSettings:`,
    `  - serializedVersion: 4`,
    `    buildTarget: DefaultTexturePlatform`,
    `    maxTextureSize: ${max}`,
    `    resizeAlgorithm: 0`,
    `    textureFormat: -1`,
    `    textureCompression: 0`,
    `    compressionQuality: 50`,
    `    crunchedCompression: 0`,
    `    allowsAlphaSplitting: 0`,
    `    overridden: 0`,
    `    ignorePlatformSupport: 0`,
    `    androidETC2FallbackOverride: 0`,
    `    forceMaximumCompressionQuality_BC6H_BC7: 1`,
    `  spriteSheet:`,
    `    serializedVersion: 2`,
    `    sprites: []`,
    `    outline: []`,
    `    customData: `,
    `    physicsShape: []`,
    `    bones: []`,
    `    spriteID: `,
    `    internalID: 0`,
    `    vertices: []`,
    `    indices: `,
    `    edges: []`,
    `    weights: []`,
    `    secondaryTextures: []`,
    `    spriteCustomMetadata:`,
    `      entries: []`,
    `    nameFileIdTable: {}`,
    `  mipmapLimitGroupName: `,
    `  pSDRemoveMatte: 0`,
    `  userData: `,
    `  assetBundleName: `,
    `  assetBundleVariant: `
  ].join("\n") + "\n";
}

/** Pure: the `.anim` text, playing the sprites `fileIds` of the sheet `guid` at `fps`. */
export function unityAnimationClip(name: string, guid: string, fileIds: string[], fps: number, loop = true): string {
  if (!fileIds.length) throw new Error("Unity export: a clip needs at least one frame");
  if (!Number.isFinite(fps) || fps <= 0) throw new Error(`Unity export: fps must be a positive number, got ${fps}`);
  const ref = (id: string) => `{fileID: ${id}, guid: ${guid}, type: 3}`;
  return [
    `%YAML 1.1`,
    `%TAG !u! tag:unity3d.com,2011:`,
    `--- !u!74 &7400000`,
    `AnimationClip:`,
    `  m_ObjectHideFlags: 0`,
    `  m_CorrespondingSourceObject: {fileID: 0}`,
    `  m_PrefabInstance: {fileID: 0}`,
    `  m_PrefabAsset: {fileID: 0}`,
    `  m_Name: ${yamlText(name)}`,
    `  serializedVersion: 6`,
    `  m_Legacy: 0`,
    `  m_Compressed: 0`,
    `  m_UseHighQualityCurve: 1`,
    `  m_RotationCurves: []`,
    `  m_CompressedRotationCurves: []`,
    `  m_EulerCurves: []`,
    `  m_PositionCurves: []`,
    `  m_ScaleCurves: []`,
    `  m_FloatCurves: []`,
    `  m_PPtrCurves:`,
    `  - curve:`,
    ...fileIds.flatMap((id, i) => [`    - time: ${unityFloat(i / fps)}`, `      value: ${ref(id)}`]),
    `    attribute: m_Sprite`,
    `    path: `,
    `    classID: 212`,
    `    script: {fileID: 0}`,
    `  m_SampleRate: ${unityFloat(fps)}`,
    `  m_WrapMode: 0`,
    `  m_Bounds:`,
    `    m_Center: {x: 0, y: 0, z: 0}`,
    `    m_Extent: {x: 0, y: 0, z: 0}`,
    `  m_ClipBindingConstant:`,
    `    genericBindings:`,
    `    - serializedVersion: 2`,
    `      path: 0`,
    `      attribute: 0`,
    `      script: {fileID: 0}`,
    `      typeID: 212`,
    `      customType: 23`,
    `      isPPtrCurve: 1`,
    `    pptrCurveMapping:`,
    ...fileIds.map(id => `    - ${ref(id)}`),
    `  m_AnimationClipSettings:`,
    `    serializedVersion: 2`,
    `    m_AdditiveReferencePoseClip: {fileID: 0}`,
    `    m_AdditiveReferencePoseTime: 0`,
    `    m_StartTime: 0`,
    `    m_StopTime: ${unityFloat(fileIds.length / fps)}`,
    `    m_OrientationOffsetY: 0`,
    `    m_Level: 0`,
    `    m_CycleOffset: 0`,
    `    m_HasAdditiveReferencePose: 0`,
    `    m_LoopTime: ${loop ? 1 : 0}`,
    `    m_LoopBlend: 0`,
    `    m_LoopBlendOrientation: 0`,
    `    m_LoopBlendPositionY: 0`,
    `    m_LoopBlendPositionXZ: 0`,
    `    m_KeepOriginalOrientation: 0`,
    `    m_KeepOriginalPositionY: 1`,
    `    m_KeepOriginalPositionXZ: 0`,
    `    m_HeightFromFeet: 0`,
    `    m_Mirror: 0`,
    `  m_EditorCurves: []`,
    `  m_EulerEditorCurves: []`,
    `  m_HasGenericRootTransform: 0`,
    `  m_HasMotionFloatCurves: 0`,
    `  m_Events: []`
  ].join("\n") + "\n";
}

/** The guid and sprite file IDs of a .meta Unity (or we) wrote, if it is one. */
export function readUnityMeta(text: string): UnityIds | undefined {
  // Unity writes \n, but git's autocrlf hands Windows users \r\n.
  text = text.replace(/\r\n/g, "\n");
  const guid = /^guid: ([0-9a-f]{32})\s*$/m.exec(text)?.[1];
  if (!guid) return undefined;
  const fileIds: Record<string, string> = {};
  const table = /^ {4}nameFileIdTable:\n((?: {6}.*\n?)*)/m.exec(text)?.[1] ?? "";
  for (const m of table.matchAll(/^ {6}(.+): (-?\d+)\s*$/gm)) fileIds[m[1].startsWith("'") ? m[1].slice(1, -1).replace(/''/g, "'") : m[1]] = m[2];
  return { guid, fileIds };
}

// What an earlier .meta at `metaPath` says (its guid and sprite IDs), if there is one.
function earlierMeta(metaPath: string): UnityIds | undefined {
  const text = metaText(metaPath);
  return text === undefined ? undefined : readUnityMeta(text);
}

/** The text of the .meta at `metaPath`, or undefined when there is none. */
export function metaText(metaPath: string): string | undefined {
  try {
    return fs.readFileSync(metaPath, "utf8");
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw new Error(`Could not read ${metaPath}: ${err?.code || err?.message || err}`);
    return undefined;
  }
}

/**
 * Pure: `meta` (a .meta Unity or we wrote) with its sprite sheet's
 * `secondaryTextures` listing `guid` as `_NormalMap`: an earlier _NormalMap
 * entry is replaced where it was, other entries (a _MaskTex) stay, and
 * every other line is left as it is, line endings too. Undefined when it
 * has no secondaryTextures list (not a sprite import of a recent Unity).
 */
export function withNormalMapEntry(meta: string, guid: string): string | undefined {
  const eol = meta.includes("\r\n") ? "\r\n" : "\n";
  const lines = meta.split(eol);
  const at = lines.findIndex(l => /^ {4}secondaryTextures:(?: \[\])? *$/.test(l));
  if (at < 0) return undefined;
  // Each entry: a "    - " line and the deeper ones after it.
  const entries: string[][] = [];
  let end = at + 1;
  if (!lines[at].includes("[]")) {
    for (; end < lines.length && (/^ {4}- /.test(lines[end]) || (entries.length && /^ {6}/.test(lines[end]))); end++) {
      if (/^ {4}- /.test(lines[end])) entries.push([lines[end]]);
      else entries[entries.length - 1].push(lines[end]);
    }
  }
  const ours = [`    - texture: {fileID: 2800000, guid: ${guid}, type: 3}`, `      name: _NormalMap`];
  const isNormal = (e: string[]) => e.some(l => /^ {4}(?:- | {2})name: _NormalMap *$/.test(l));
  const i = entries.findIndex(isNormal);
  const list = i < 0 ? [...entries, ours] : entries.flatMap((e, k) => (k === i ? [ours] : isNormal(e) ? [] : [e]));
  return [...lines.slice(0, at), "    secondaryTextures:", ...list.flat(), ...lines.slice(end)].join(eol);
}

/**
 * The sprite rects an existing .meta slices the texture into, top-left
 * origin like the sheet (Unity counts y from the bottom): its Multiple
 * mode's sprites, or for a Single sprite (none listed) the whole texture.
 */
export function metaRects(meta: string, width: number, height: number): { x: number; y: number; w: number; h: number }[] {
  const rects = [...meta.matchAll(/^ {6}rect:\r?\n {8}serializedVersion: \d+\r?\n {8}x: (-?[\d.]+)\r?\n {8}y: (-?[\d.]+)\r?\n {8}width: ([\d.]+)\r?\n {8}height: ([\d.]+)\r?$/gm)].map(m => {
    const [x, y, w, h] = m.slice(1).map(Number);
    return { x, y: height - (y + h), w, h };
  });
  return rects.length ? rects : [{ x: 0, y: 0, w: width, h: height }];
}

/** The guid an existing .meta lists as its _NormalMap secondary texture, if any. */
export function normalMapEntryGuid(meta: string): string | undefined {
  const m = /^ {4}- (?:texture: \{[^}]*guid: ([0-9a-f]{32})[^}]*\}\r?\n {6}name: _NormalMap|name: _NormalMap\r?\n {6}texture: \{[^}]*guid: ([0-9a-f]{32}))/m.exec(meta);
  return m?.[1] ?? m?.[2];
}

/**
 * Pure: an existing .meta of a normal map, set to import it as one: Texture
 * Type Normal map, sRGB off, green flipped for a DirectX map (where the
 * .meta has the field: older Unity versions have none). Its other
 * settings (and its sprites, should it have been sliced) stay.
 */
export function asNormalMapMeta(meta: string, flipGreen: boolean): string {
  const out = meta.replace(/^( {2}textureType: )-?\d+/m, "$11").replace(/^( {4}sRGBTexture: )\d+/m, "$10");
  // A .meta from before Unity had Flip Green Channel has no field for it,
  // and one is not added: what such a version makes of it is unknown.
  // The output says it is not flipped (directxNote).
  return out.replace(/^( {4}flipGreenChannel: )\d+/m, `$1${flipGreen ? 1 : 0}`);
}

function writeMeta(metaPath: string, text: string) {
  try {
    fs.writeFileSync(metaPath, text);
  } catch (err: any) {
    throw new Error(`Could not write Unity import settings ${metaPath}: ${err?.code || err?.message || err}`);
  }
}

/**
 * Writes the normal map's `.png.meta` and returns its path and guid. One
 * already there keeps its guid and every setting but the few that make it a
 * normal map (asNormalMapMeta); else a new one gets `guid` (default: a new
 * random one).
 */
export function writeUnityNormalMapMeta(normalMap: NormalMap, width: number, height: number, guid?: string): { metaPath: string; guid: string; patched: boolean } {
  const metaPath = path.resolve(normalMap.file) + ".meta";
  const earlier = metaText(metaPath);
  const kept = earlier === undefined ? undefined : readUnityMeta(earlier)?.guid;
  if (earlier !== undefined && kept) {
    writeMeta(metaPath, asNormalMapMeta(earlier, normalMap.format === "directx"));
    return { metaPath, guid: kept, patched: true };
  }
  const id = guid ?? randomBytes(16).toString("hex");
  writeMeta(metaPath, unityNormalMapMeta(id, width, height, normalMap.format === "directx"));
  return { metaPath, guid: id, patched: false };
}

/** The guid the normal map's .meta has, or will get. */
export function normalMapGuid(normalMap: NormalMap): string {
  const earlier = metaText(path.resolve(normalMap.file) + ".meta");
  return (earlier === undefined ? undefined : readUnityMeta(earlier)?.guid) ?? randomBytes(16).toString("hex");
}

export { writeMeta as writeUnityMeta };

/**
 * Writes `<sheet>.png.meta` (replacing one there, keeping its guid and file
 * IDs) and `<animation>.anim` (the sheet's name by default; never
 * overwriting: adds -2, -3, ...) next to the sheet, and returns both paths.
 * With a normal map, its .meta too (second), and the sheet's lists it; a
 * still image (`clip` false) gets no .anim. Throws a plain Error with a
 * readable message.
 */
export function writeUnityFiles(sheetPath: string, sheetWidth: number, sheetHeight: number, grid: UnityGrid, animation?: string, layout?: FrameLayout, options: EngineOptions = {}, clip = true): string[] {
  const dir = path.dirname(path.resolve(sheetPath));
  const base = path.basename(sheetPath, path.extname(sheetPath));
  const metaPath = path.resolve(sheetPath) + ".meta";
  const earlier = earlierMeta(metaPath);
  const guid = earlier?.guid ?? randomBytes(16).toString("hex");
  // The map's .meta first: the sheet's names its guid.
  const normal = options.normalMap ? writeUnityNormalMapMeta(options.normalMap, sheetWidth, sheetHeight) : undefined;
  const meta = unityTextureMeta(base, guid, sheetWidth, sheetHeight, grid, layout, earlier, undefined, options, normal?.guid);
  const ids = spriteFileIds(base, grid.frames, earlier);
  writeMeta(metaPath, meta);
  const written = normal ? [metaPath, normal.metaPath] : [metaPath];
  if (!clip) return written;
  // Unity names an asset after its file, so the clip is named as its file is.
  const clipBase = (animation || base).replace(/[\\/:*?"<>|]/g, "-");
  for (let n = 1; ; n++) {
    const name = `${clipBase}${n > 1 ? `-${n}` : ""}`;
    const target = path.join(dir, `${name}.anim`);
    try {
      fs.writeFileSync(target, unityAnimationClip(name, guid, ids, grid.fps, grid.loop !== false), { flag: "wx" });
      return [...written, target];
    } catch (err: any) {
      if (err?.code === "EEXIST") continue;
      throw new Error(`Could not write Unity AnimationClip ${target}: ${err?.code || err?.message || err}`);
    }
  }
}

/**
 * Writes `<tileset>.png.meta` slicing it into the given tiles (a Tile
 * Palette takes them), replacing one there but keeping its guid and file
 * IDs, and returns its path.
 */
export function writeUnityTileset(sheetPath: string, sheetWidth: number, sheetHeight: number, rects: { x: number; y: number; w: number; h: number }[]): string {
  const base = path.basename(sheetPath, path.extname(sheetPath));
  const metaPath = path.resolve(sheetPath) + ".meta";
  let earlier: UnityIds | undefined;
  try {
    earlier = readUnityMeta(fs.readFileSync(metaPath, "utf8"));
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw new Error(`Could not read ${metaPath}: ${err?.code || err?.message || err}`);
  }
  const guid = earlier?.guid ?? randomBytes(16).toString("hex");
  fs.writeFileSync(metaPath, unityTextureMeta(base, guid, sheetWidth, sheetHeight, { cols: 1, rows: 1, frames: 1, fps: 1 }, {}, earlier, rects));
  return metaPath;
}
