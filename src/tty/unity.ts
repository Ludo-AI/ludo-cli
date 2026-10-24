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

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { frameRects } from "../toolbox/sheet.js";
import type { AtlasGrid, FrameLayout } from "./texturepacker.js";

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
  rects?: { x: number; y: number; w: number; h: number }[] // explicit sprite rects (a tileset's), top-left origin
): string {
  check(sheetWidth, sheetHeight, grid, layout);
  const e = layout.extrude ?? 0;
  const t = rects ? undefined : layout.trim;
  const cells = rects ?? frameRects(sheetWidth, sheetHeight, grid.cols, grid.rows, grid.frames).map(r => ({ x: r.x + e, y: r.y + e, w: r.w - 2 * e, h: r.h - 2 * e }));
  const ids = spriteFileIds(sheet, cells.length, earlier);
  const names = ids.map((_, i) => spriteName(sheet, i));
  const max = maxTextureSize(sheetWidth, sheetHeight);
  const sprites = cells.map((r, i) => {
    const { w, h } = r;
    const trimmed = t && t.w === w && t.h === h && (t.w !== t.source_w || t.h !== t.source_h);
    // The untrimmed frame's centre, in the trimmed rect's own units (y up).
    const pivot = trimmed ? { x: (t.source_w / 2 - t.x) / w, y: (t.source_h / 2 - (t.source_h - t.y - h)) / h } : { x: 0.5, y: 0.5 };
    return [
      `    - serializedVersion: 2`,
      `      name: ${yamlText(names[i])}`,
      `      rect:`,
      `        serializedVersion: 2`,
      `        x: ${r.x}`,
      `        y: ${sheetHeight - (r.y + h)}`,
      `        width: ${w}`,
      `        height: ${h}`,
      `      alignment: ${trimmed ? 9 : 0}`,
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
    `  spritePixelsToUnits: 100`,
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
    `    secondaryTextures: []`,
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
  const guid = /^guid: ([0-9a-f]{32})\s*$/m.exec(text)?.[1];
  if (!guid) return undefined;
  const fileIds: Record<string, string> = {};
  const table = /^ {4}nameFileIdTable:\n((?: {6}.*\n?)*)/m.exec(text)?.[1] ?? "";
  for (const m of table.matchAll(/^ {6}(.+): (-?\d+)\s*$/gm)) fileIds[m[1].startsWith("'") ? m[1].slice(1, -1).replace(/''/g, "'") : m[1]] = m[2];
  return { guid, fileIds };
}

/**
 * Writes `<sheet>.png.meta` (replacing one there, keeping its guid and file
 * IDs) and `<animation>.anim` (the sheet's name by default; never
 * overwriting: adds -2, -3, ...) next to the sheet, and returns both paths.
 * Throws a plain Error with a readable message.
 */
export function writeUnityFiles(sheetPath: string, sheetWidth: number, sheetHeight: number, grid: UnityGrid, animation?: string, layout?: FrameLayout): string[] {
  const dir = path.dirname(path.resolve(sheetPath));
  const base = path.basename(sheetPath, path.extname(sheetPath));
  const metaPath = path.resolve(sheetPath) + ".meta";
  let earlier: UnityIds | undefined;
  try {
    earlier = readUnityMeta(fs.readFileSync(metaPath, "utf8"));
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw new Error(`Could not read ${metaPath}: ${err?.code || err?.message || err}`);
  }
  const guid = earlier?.guid ?? randomBytes(16).toString("hex");
  const meta = unityTextureMeta(base, guid, sheetWidth, sheetHeight, grid, layout, earlier);
  const ids = spriteFileIds(base, grid.frames, earlier);
  try {
    fs.writeFileSync(metaPath, meta);
  } catch (err: any) {
    throw new Error(`Could not write Unity import settings ${metaPath}: ${err?.code || err?.message || err}`);
  }
  // Unity names an asset after its file, so the clip is named as its file is.
  const clipBase = (animation || base).replace(/[\\/:*?"<>|]/g, "-");
  for (let n = 1; ; n++) {
    const name = `${clipBase}${n > 1 ? `-${n}` : ""}`;
    const target = path.join(dir, `${name}.anim`);
    try {
      fs.writeFileSync(target, unityAnimationClip(name, guid, ids, grid.fps, grid.loop !== false), { flag: "wx" });
      return [metaPath, target];
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
