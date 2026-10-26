import fs from "node:fs";
import path from "node:path";
import { CliError, EXIT } from "../errors.js";
import { printJson, type Ctx } from "../generate.js";
import { shown } from "./io.js";
import { hint, TOOLS, type ToolCall } from "./registry.js";

// What is in a glTF 2.0 model (.glb, or .gltf with its buffers), read from
// its JSON as the spec (Khronos glTF 2.0) lays it out: the counts Khronos's
// glTF-Validator reports in its `info` (primitives, vertices and triangles
// over every mesh in the file, each counted once; materials, animations,
// skins, morph targets), plus what a game needs to know before using it:
// how many mesh instances the default scene draws, its size there (POSITION
// bounds through the node transforms), each image's pixel size, each
// animation's length, and the joints. test/model.test.mjs
// checks the counts against glTF-Validator on Khronos's sample models.

export class ModelError extends Error {}

export interface Gltf {
  asset?: { version?: string; generator?: string };
  scene?: number;
  scenes?: { nodes?: number[] }[];
  nodes?: { children?: number[]; mesh?: number; skin?: number; matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[]; name?: string }[];
  meshes?: { name?: string; primitives: { attributes: Record<string, number>; indices?: number; mode?: number; targets?: unknown[] }[] }[];
  accessors?: {
    count: number;
    min?: number[];
    max?: number[];
    bufferView?: number;
    byteOffset?: number;
    componentType?: number;
    type?: string;
    normalized?: boolean;
    sparse?: { count: number; indices: { bufferView: number; byteOffset?: number; componentType: number }; values: { bufferView: number; byteOffset?: number } };
  }[];
  bufferViews?: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }[];
  buffers?: { uri?: string; byteLength: number }[];
  materials?: unknown[];
  textures?: unknown[];
  images?: { uri?: string; bufferView?: number; mimeType?: string; name?: string }[];
  skins?: { joints: number[]; name?: string; skeleton?: number; inverseBindMatrices?: number }[];
  animations?: { name?: string; channels: { sampler: number; target: { node?: number; path: string } }[]; samplers: { input: number; output: number; interpolation?: string }[] }[];
  extensionsUsed?: string[];
  extensionsRequired?: string[];
}

export interface Loaded {
  json: Gltf;
  bin?: Uint8Array; // a GLB's binary chunk
  dir: string;
}

export function readGltf(buf: Uint8Array, file: string): Loaded {
  const dir = path.dirname(file);
  if (buf.length >= 12 && buf[0] === 0x67 && buf[1] === 0x6c && buf[2] === 0x54 && buf[3] === 0x46) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    if (dv.getUint32(4, true) !== 2) throw new ModelError(`a GLB of version ${dv.getUint32(4, true)} (only glTF 2.0 is read)`);
    const length = dv.getUint32(8, true);
    if (length > buf.length) throw new ModelError(`the GLB says ${length} bytes and the file has ${buf.length}`);
    let json: Gltf | undefined;
    let bin: Uint8Array | undefined;
    for (let o = 12; o + 8 <= length; ) {
      const size = dv.getUint32(o, true);
      const type = dv.getUint32(o + 4, true);
      if (o + 8 + size > length) throw new ModelError("a GLB chunk runs past the end of the file");
      const data = buf.subarray(o + 8, o + 8 + size);
      if (type === 0x4e4f534a && !json) json = parseJson(new TextDecoder().decode(data));
      else if (type === 0x004e4942 && !bin) bin = data;
      o += 8 + size + ((4 - (size % 4)) % 4);
    }
    if (!json) throw new ModelError("the GLB has no JSON chunk");
    return { json, bin, dir };
  }
  return { json: parseJson(new TextDecoder().decode(buf)), dir };
}

function parseJson(text: string): Gltf {
  let json: Gltf;
  try {
    json = JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    throw new ModelError("not a GLB, and its JSON does not parse");
  }
  if (!json || typeof json !== "object" || !json.asset) throw new ModelError("not a glTF: it has no asset");
  if (!String(json.asset.version ?? "").startsWith("2.")) throw new ModelError(`glTF ${json.asset.version} (only 2.0 is read)`);
  return json;
}

export type Mat = number[]; // 4x4, column-major, as glTF writes them

export const identity = (): Mat => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function multiply(a: Mat, b: Mat): Mat {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return out;
}

// A node's local matrix: its `matrix`, or T * R * S.
export function local(n: NonNullable<Gltf["nodes"]>[number]): Mat {
  if (n.matrix?.length === 16) return n.matrix;
  const [tx, ty, tz] = n.translation ?? [0, 0, 0];
  const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = n.scale ?? [1, 1, 1];
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1
  ];
}

export const apply = (m: Mat, p: number[]) => [0, 1, 2].map(r => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]);

// The pixel size from a PNG's IHDR or a JPEG's SOF, if the bytes are one.
function imageSize(b: Uint8Array): { width: number; height: number } | undefined {
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50) return { width: (b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19], height: (b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23] };
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    for (let o = 2; o + 9 < b.length; ) {
      if (b[o] !== 0xff) return undefined;
      const marker = b[o + 1];
      const len = (b[o + 2] << 8) | b[o + 3];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: (b[o + 5] << 8) | b[o + 6], width: (b[o + 7] << 8) | b[o + 8] };
      o += 2 + len;
    }
  }
  if (b.length > 30 && String.fromCharCode(...b.subarray(0, 4)) === "RIFF" && String.fromCharCode(...b.subarray(8, 12)) === "WEBP") {
    const kind = String.fromCharCode(...b.subarray(12, 16));
    if (kind === "VP8X") return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    if (kind === "VP8L") {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (kind === "VP8 ") return { width: (b[26] | (b[27] << 8)) & 0x3fff, height: (b[28] | (b[29] << 8)) & 0x3fff };
  }
  return undefined;
}

export function bufferBytes(m: Loaded, index: number): Uint8Array | undefined {
  const b = m.json.buffers?.[index];
  if (!b) return undefined;
  if (b.uri === undefined) return index === 0 ? m.bin : undefined;
  const data = /^data:[^,]*;base64,(.*)$/s.exec(b.uri);
  if (data) return Buffer.from(data[1], "base64");
  try {
    return fs.readFileSync(path.join(m.dir, decodeURIComponent(b.uri)));
  } catch {
    return undefined;
  }
}

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const buffers = new WeakMap<Loaded, Map<number, Uint8Array | undefined>>();

// One element's component from a buffer, as glTF 2.0 §3.11 reads it: a
// normalized integer is scaled to 0..1 (unsigned) or -1..1 (signed).
function component(dv: DataView, o: number, type: number, normalized: boolean): number {
  switch (type) {
    case 5126: return dv.getFloat32(o, true);
    case 5120: return normalized ? Math.max(dv.getInt8(o) / 127, -1) : dv.getInt8(o);
    case 5121: return normalized ? dv.getUint8(o) / 255 : dv.getUint8(o);
    case 5122: return normalized ? Math.max(dv.getInt16(o, true) / 32767, -1) : dv.getInt16(o, true);
    case 5123: return normalized ? dv.getUint16(o, true) / 65535 : dv.getUint16(o, true);
    case 5125: return dv.getUint32(o, true);
  }
  throw new ModelError(`an accessor of component type ${type}`);
}

// What an accessor holds, as floats, `size` per element: its buffer view
// read with its stride, then any sparse substitution on top. An accessor
// with no buffer view is zeros, as the spec says. Matrices of 1- and 2-byte
// components (padded columns) are not read: glTF uses them for nothing a
// game needs.
export function readAccessor(m: Loaded, index: number): { values: Float32Array; size: number; count: number } {
  const a = m.json.accessors?.[index];
  if (!a) throw new ModelError(`accessor ${index} is missing`);
  const size = COMPONENTS[a.type ?? ""];
  const bytes = BYTES[a.componentType ?? 0];
  if (!size || !bytes) throw new ModelError(`accessor ${index} has type ${a.type} of ${a.componentType}`);
  const values = new Float32Array(a.count * size);
  let cache = buffers.get(m);
  if (!cache) buffers.set(m, (cache = new Map()));
  const view = (v: number) => {
    const bv = m.json.bufferViews?.[v];
    if (!bv) throw new ModelError(`buffer view ${v} is missing`);
    if (!cache!.has(bv.buffer)) cache!.set(bv.buffer, bufferBytes(m, bv.buffer));
    const buf = cache!.get(bv.buffer);
    if (!buf) throw new ModelError(`buffer ${bv.buffer} is missing`);
    return { dv: new DataView(buf.buffer, buf.byteOffset, buf.byteLength), start: bv.byteOffset ?? 0, stride: bv.byteStride, end: (bv.byteOffset ?? 0) + bv.byteLength, length: buf.byteLength };
  };
  const normalized = !!a.normalized;
  if (a.bufferView !== undefined) {
    const v = view(a.bufferView);
    const stride = v.stride || size * bytes;
    const base = v.start + (a.byteOffset ?? 0);
    if (a.count > 0 && (base + (a.count - 1) * stride + size * bytes > Math.min(v.end, v.length))) throw new ModelError(`accessor ${index} runs past its buffer`);
    for (let i = 0; i < a.count; i++) for (let c = 0; c < size; c++) values[i * size + c] = component(v.dv, base + i * stride + c * bytes, a.componentType!, normalized);
  }
  if (a.sparse && a.sparse.count > 0) {
    const iv = view(a.sparse.indices.bufferView);
    const vv = view(a.sparse.values.bufferView);
    const ib = BYTES[a.sparse.indices.componentType] ?? 0;
    const io = iv.start + (a.sparse.indices.byteOffset ?? 0);
    const vo = vv.start + (a.sparse.values.byteOffset ?? 0);
    if (!ib || io + a.sparse.count * ib > iv.length || vo + a.sparse.count * size * bytes > vv.length) throw new ModelError(`accessor ${index}'s sparse data runs past its buffer`);
    for (let k = 0; k < a.sparse.count; k++) {
      const i = component(iv.dv, io + k * ib, a.sparse.indices.componentType, false);
      if (i >= a.count) continue;
      for (let c = 0; c < size; c++) values[i * size + c] = component(vv.dv, vo + (k * size + c) * bytes, a.componentType!, normalized);
    }
  }
  return { values, size, count: a.count };
}

export function modelInfo(m: Loaded) {
  const j = m.json;
  const acc = (i: number | undefined) => (i === undefined ? undefined : j.accessors?.[i]);
  // The nodes the default scene draws, with their world matrices.
  const scene = j.scenes?.[j.scene ?? 0];
  const drawn: { node: number; world: Mat }[] = [];
  const walk = (n: number, parent: Mat, depth: number) => {
    const node = j.nodes?.[n];
    if (!node || depth > 256) return;
    const world = multiply(parent, local(node));
    drawn.push({ node: n, world });
    for (const c of node.children ?? []) walk(c, world, depth + 1);
  };
  for (const n of scene?.nodes ?? []) walk(n, identity(), 0);

  let primitives = 0;
  let vertices = 0;
  let triangles = 0;
  let morph = false;
  for (const mesh of j.meshes ?? []) {
    for (const p of mesh.primitives ?? []) {
      primitives++;
      const count = acc(p.attributes?.POSITION)?.count ?? 0;
      vertices += count;
      const n = acc(p.indices)?.count ?? count;
      const mode = p.mode ?? 4;
      triangles += mode === 4 ? Math.floor(n / 3) : mode === 5 || mode === 6 ? Math.max(0, n - 2) : 0;
      if (p.targets?.length) morph = true;
    }
  }
  let instances = 0;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const { node, world } of drawn) {
    const mesh = j.meshes?.[j.nodes![node].mesh ?? -1];
    if (!mesh) continue;
    instances++;
    for (const p of mesh.primitives ?? []) {
      const pos = acc(p.attributes?.POSITION);
      if (pos?.min?.length === 3 && pos.max?.length === 3) {
        for (let k = 0; k < 8; k++) {
          const corner = [k & 1 ? pos.max[0] : pos.min[0], k & 2 ? pos.max[1] : pos.min[1], k & 4 ? pos.max[2] : pos.min[2]];
          const w = apply(world, corner);
          for (let a = 0; a < 3; a++) {
            min[a] = Math.min(min[a], w[a]);
            max[a] = Math.max(max[a], w[a]);
          }
        }
      }
    }
  }
  const round = (v: number) => Math.round(v * 1e5) / 1e5;
  const bounds = Number.isFinite(min[0]) ? { min: min.map(round), max: max.map(round), size: max.map((v, a) => round(v - min[a])) } : undefined;

  const images = (j.images ?? []).map(img => {
    let bytes: Uint8Array | undefined;
    if (img.bufferView !== undefined) {
      const v = j.bufferViews?.[img.bufferView];
      const b = v && bufferBytes(m, v.buffer);
      if (v && b) bytes = b.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength);
    } else if (img.uri) {
      const data = /^data:([^;,]*)[^,]*;base64,(.*)$/s.exec(img.uri);
      if (data) bytes = Buffer.from(data[2], "base64");
      else {
        try {
          bytes = fs.readFileSync(path.join(m.dir, decodeURIComponent(img.uri)));
        } catch {
          bytes = undefined;
        }
      }
    }
    const size = bytes && imageSize(bytes);
    return { ...(img.name ? { name: img.name } : {}), ...(img.mimeType ? { mime: img.mimeType } : {}), ...(size ?? {}), ...(bytes ? { bytes: bytes.length } : { missing: true }) };
  });
  const animations = (j.animations ?? []).map((a, i) => {
    const length = Math.max(0, ...a.samplers.map(s => acc(s.input)?.max?.[0] ?? 0));
    return { name: a.name || `animation ${i}`, seconds: round(length), channels: a.channels.length };
  });
  const skins = (j.skins ?? []).map((s, i) => ({ name: s.name || `skin ${i}`, joints: s.joints.length, joint_names: s.joints.slice(0, 64).map(n => j.nodes?.[n]?.name ?? `node ${n}`) }));
  return {
    version: j.asset?.version,
    ...(j.asset?.generator ? { generator: j.asset.generator } : {}),
    scenes: j.scenes?.length ?? 0,
    nodes: j.nodes?.length ?? 0,
    meshes: j.meshes?.length ?? 0,
    mesh_instances: instances,
    primitives,
    vertices,
    triangles,
    materials: j.materials?.length ?? 0,
    textures: j.textures?.length ?? 0,
    images,
    morph_targets: morph,
    rigged: skins.length > 0,
    skins,
    animated: animations.length > 0,
    animations,
    ...(bounds ? { bounds } : {}),
    extensions_used: j.extensionsUsed ?? [],
    extensions_required: j.extensionsRequired ?? []
  };
}

TOOLS.push({
  group: "model",
  name: "info",
  args: "<model>",
  summary: "What is in a glTF or GLB model: meshes, triangles, size, textures, rig and animations",
  details: [
    "Counts as Khronos's glTF-Validator does (primitives, vertices and triangles of every mesh, once),",
    "plus the mesh instances the scene draws, its size there (bounds through the node transforms), each",
    "texture's pixel size, the skeleton's joints and each animation's length. Reads .glb, and .gltf",
    "with its buffers and images beside it or embedded."
  ],
  flags: [],
  async run(ctx: Ctx, call: ToolCall) {
    if (call.args.length !== 1) throw new CliError("Usage: ludo toolbox model info <model.glb>", EXIT.USAGE);
    const file = call.args[0];
    let buf: Buffer;
    try {
      buf = fs.readFileSync(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new CliError(`File not found: ${file}`, EXIT.USAGE);
      throw err;
    }
    let info: ReturnType<typeof modelInfo>;
    try {
      info = modelInfo(readGltf(buf, file));
    } catch (err) {
      if (err instanceof ModelError || err instanceof TypeError) throw new CliError(`Cannot read ${file} as a glTF model: ${err.message}`, EXIT.BAD_INPUT);
      throw err;
    }
    const next = info.rigged
      ? hint("Animate it with Ludo", `ludo model animate --model ${shown(file)} --prompt "<what it does>"`)
      : hint("Rig it with Ludo, so it can be animated", `ludo model rig --model ${shown(file)}`);
    if (ctx.jsonOut) {
      printJson({ model: shown(file), bytes: buf.length, ...info, ...(ctx.globals.quiet ? {} : { hint: next }) }, false);
    } else {
      const lines = [
        `${info.meshes} mesh${info.meshes === 1 ? "" : "es"} (${info.mesh_instances} drawn), ${info.primitives} primitive${info.primitives === 1 ? "" : "s"}, ${info.vertices} vertices, ${info.triangles} triangles`,
        ...(info.bounds ? [`Size ${info.bounds.size.map(v => +v.toFixed(3)).join(" x ")} (x, y, z)`] : []),
        `${info.materials} material${info.materials === 1 ? "" : "s"}, ${info.textures} texture${info.textures === 1 ? "" : "s"}${info.images.length ? ` (${info.images.map(i => ("width" in i ? `${i.width}x${i.height}` : "?")).join(", ")})` : ""}`,
        info.rigged ? `Rigged: ${info.skins.map(s => `${s.joints} joints`).join(", ")}` : "Not rigged",
        info.animated ? `Animations: ${info.animations.map(a => `${a.name} (${a.seconds} s)`).join(", ")}` : "No animations",
        ...(info.morph_targets ? ["Has morph targets"] : []),
        ...(info.extensions_required.length ? [`Requires ${info.extensions_required.join(", ")}`] : [])
      ];
      process.stdout.write(lines.join("\n") + "\n");
      if (!ctx.globals.quiet) process.stderr.write(`Next: ${next.text}: ${next.command}\n`);
    }
    return EXIT.OK;
  }
});
