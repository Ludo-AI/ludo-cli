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
// animation's length, and the joints; then each clip run through the
// skeleton (animationFacts). test/model.test.mjs checks the counts against
// glTF-Validator on Khronos's sample models. The tool only reports: Ludo's
// rigging and animation make the model, and nothing here changes it.

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
  bufferViews?: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number; extensions?: Record<string, unknown> }[];
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

// A stored integer as glTF 2.0 §3.11 reads it: a normalized one is scaled
// to 0..1 (unsigned) or -1..1 (signed).
function dequantize(v: number, type: number | undefined, normalized: boolean | undefined): number {
  if (!normalized) return v;
  switch (type) {
    case 5120: return Math.max(v / 127, -1);
    case 5121: return v / 255;
    case 5122: return Math.max(v / 32767, -1);
    case 5123: return v / 65535;
  }
  return v;
}

// One element's component from a buffer.
function component(dv: DataView, o: number, type: number, normalized: boolean): number {
  switch (type) {
    case 5126: return dv.getFloat32(o, true);
    case 5120: return dequantize(dv.getInt8(o), type, normalized);
    case 5121: return dequantize(dv.getUint8(o), type, normalized);
    case 5122: return dequantize(dv.getInt16(o, true), type, normalized);
    case 5123: return dequantize(dv.getUint16(o, true), type, normalized);
    case 5125: return dv.getUint32(o, true);
  }
  throw new ModelError(`an accessor of component type ${type}`);
}

// Data in a buffer view the toolbox cannot decode: EXT_meshopt_compression
// (gltfpack's) keeps it in its own codec, with no uncompressed copy.
export class Compressed extends ModelError {}

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
    if (!buf && bv.extensions?.EXT_meshopt_compression) throw new Compressed("compressed (EXT_meshopt_compression)");
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

// ---- The scene graph

type Vec = number[];
type GNode = NonNullable<Gltf["nodes"]>[number];

const sub = (a: Vec, b: Vec) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec, b: Vec) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: Vec) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec) => {
  const l = len(a);
  return l > 1e-12 ? a.map(v => v / l) : [0, 0, 0];
};
const flat = (a: Vec) => [a[0], 0, a[2]]; // onto the ground: glTF is +Y up
const mean = (vs: Vec[]) => [0, 1, 2].map(k => vs.reduce((s, v) => s + v[k], 0) / Math.max(1, vs.length));
const degrees = (rad: number) => (rad * 180) / Math.PI;
const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
// "+Z" for the axis a direction is closest to.
function axisOf(v: Vec): string {
  let k = 0;
  for (let a = 1; a < 3; a++) if (Math.abs(v[a]) > Math.abs(v[k])) k = a;
  return `${v[k] < 0 ? "-" : "+"}${"XYZ"[k]}`;
}

export interface Graph {
  parent: number[]; // -1 for a scene root, or a node the scene does not draw
  depth: number[]; // -1 for nodes outside the default scene
  order: number[]; // the scene's nodes, parents before children
}

export function sceneGraph(j: Gltf): Graph {
  const nodes = j.nodes ?? [];
  const parent: number[] = new Array(nodes.length).fill(-1);
  const depth: number[] = new Array(nodes.length).fill(-1);
  const order: number[] = [];
  const walk = (n: number, p: number, d: number) => {
    if (!nodes[n] || depth[n] >= 0 || d > 256) return;
    parent[n] = p;
    depth[n] = d;
    order.push(n);
    for (const c of nodes[n].children ?? []) walk(c, n, d + 1);
  };
  for (const r of j.scenes?.[j.scene ?? 0]?.nodes ?? []) walk(r, -1, 0);
  return { parent, depth, order };
}

// Every scene node's world matrix, with `pose` standing in for the nodes an
// animation moves (an animated node has TRS, never a matrix, by the spec).
export function worldMatrices(j: Gltf, g: Graph, pose?: Map<number, GNode>): Mat[] {
  const out: Mat[] = [];
  for (const n of g.order) {
    const l = local(pose?.get(n) ?? j.nodes![n]);
    out[n] = g.parent[n] >= 0 ? multiply(out[g.parent[n]], l) : l;
  }
  return out;
}

const at = (w: Mat) => [w[12], w[13], w[14]];

// ---- The rig: which joints are the feet, and which way the toes point

// Bone names Ludo's joint namings use (SMPL, Mixamo, HumanIK, Unreal,
// Godot, Rigify, VRoid) say the side as a word or a lone L or R: L_Foot,
// LeftFoot, foot_l, foot.L, J_Bip_L_Foot.
const sideOf = (name: string): "left" | "right" | undefined => {
  if (/left/i.test(name) || /(^|[^A-Za-z])[Ll](?=[^A-Za-z]|$)|(^|[^A-Za-z])l(?=[A-Z])/.test(name)) return "left";
  if (/right/i.test(name) || /(^|[^A-Za-z])[Rr](?=[^A-Za-z]|$)|(^|[^A-Za-z])r(?=[A-Z])/.test(name)) return "right";
  return undefined;
};
const FOOT = /foot|ankle|toe|ball|heel/i;
// Helper bones that sit at the feet without being them: IK targets, Rigify's
// mechanism and original copies, Unreal's ik_foot_l.
const HELPER = /(^|[^a-z])(ik|fk|ctrl|ctl|control|pole|target|mch|org|eye)([^a-z]|$)|eyeball/i;

interface Foot {
  label: string; // "left", "right", or "foot 1" when the names do not say
  joints: number[]; // from the ankle down to the toe
}

// The skeleton's joints: the skins' joints, or for an animation-only file
// (Ludo's animate returns a skeleton and a clip, no mesh) the nodes its
// channels move and everything below them.
export function skeletonJoints(j: Gltf, g: Graph): number[] {
  const set = new Set<number>();
  for (const s of j.skins ?? []) for (const n of s.joints) if (g.depth[n] >= 0) set.add(n);
  if (!set.size) {
    const moved = new Set((j.animations ?? []).flatMap(a => a.channels.map(c => c.target.node ?? -1)));
    for (const n of g.order) if (j.nodes![n].mesh === undefined && (moved.has(n) || set.has(g.parent[n]))) set.add(n);
  }
  return g.order.filter(n => set.has(n));
}

const nameOf = (j: Gltf, n: number) => j.nodes?.[n]?.name ?? `node ${n}`;

function ancestors(g: Graph, n: number): number[] {
  const out: number[] = [];
  for (let p = g.parent[n]; p >= 0; p = g.parent[p]) out.push(p);
  return out;
}

// The feet: by name when the bones say left and right, else the chains of
// joints in the bottom 15% of the skeleton (two for a biped, four for most
// quadrupeds), each from its top joint (the ankle) down.
function feetOf(j: Gltf, g: Graph, joints: number[], w: Mat[]): { feet: Foot[]; named: boolean } {
  const chainOf = (cands: number[]) => {
    const set = new Set(cands);
    let best = cands[0];
    let most = -1;
    for (const c of cands) {
      const count = ancestors(g, c).filter(a => set.has(a)).length;
      if (count > most || (count === most && g.depth[c] > g.depth[best])) [best, most] = [c, count];
    }
    return [...ancestors(g, best).filter(a => set.has(a)).reverse(), best];
  };
  const named: Foot[] = [];
  for (const side of ["left", "right"] as const) {
    const cands = joints.filter(n => FOOT.test(nameOf(j, n)) && !HELPER.test(nameOf(j, n)) && sideOf(nameOf(j, n)) === side);
    if (cands.length) named.push({ label: side, joints: chainOf(cands) });
  }
  if (named.length === 2) return { feet: named, named: true };
  if (joints.length < 3) return { feet: [], named: false };
  const ys = joints.map(n => w[n][13]);
  const lo = Math.min(...ys);
  const hi = Math.max(...ys);
  if (hi - lo <= 1e-9) return { feet: [], named: false };
  const low = new Set(joints.filter(n => w[n][13] <= lo + 0.15 * (hi - lo)));
  const groups = new Map<number, number[]>();
  for (const n of g.order) {
    if (!low.has(n)) continue;
    let top = n;
    while (g.parent[top] >= 0 && low.has(g.parent[top])) top = g.parent[top];
    groups.set(top, [...(groups.get(top) ?? []), n]);
  }
  const feet = [...groups.values()].map(c => chainOf(c));
  return feet.length >= 2 ? { feet: feet.map((c, i) => ({ label: `foot ${i + 1}`, joints: c })), named: false } : { feet: [], named: false };
}

// Which way a rig faces, on the ground, when its feet say so clearly: its
// toes point ahead of its ankles, and a character facing +Z has its left
// side on +X (left x up = forward). Undefined when the toes and the sides
// disagree, or unnamed feet point different ways.
function rigForward(feet: Foot[], named: boolean, w: Mat[]): Vec | undefined {
  const toes = feet.filter(f => f.joints.length >= 2).map(f => unit(flat(sub(at(w[f.joints[f.joints.length - 1]]), at(w[f.joints[0]])))));
  const toe = toes.length ? unit(mean(toes)) : undefined;
  const agree = toes.length >= 2 && toes.every(t => dot(t, toe!) > 0.7);
  let side: Vec | undefined;
  if (named) {
    const left = mean(feet.find(f => f.label === "left")!.joints.map(n => at(w[n])));
    const right = mean(feet.find(f => f.label === "right")!.joints.map(n => at(w[n])));
    const across = flat(sub(left, right));
    if (len(across) > 1e-9) side = unit(cross(across, [0, 1, 0]));
  }
  if (toe && len(toe) > 0.5 && side) return dot(toe, side) > 0.7 ? unit([toe[0] + side[0], 0, toe[2] + side[2]]) : undefined;
  if (side) return side;
  return toe && len(toe) > 0.5 && agree ? toe : undefined;
}

// ---- Animation sampling

interface Channel {
  node: number;
  path: "translation" | "rotation" | "scale";
  times: Float32Array;
  values: Float32Array;
  size: number;
  interp: string;
}

function channelsOf(m: Loaded, a: NonNullable<Gltf["animations"]>[number]): Channel[] {
  const out: Channel[] = [];
  for (const c of a.channels) {
    const path = c.target.path;
    const s = a.samplers[c.sampler];
    if (c.target.node === undefined || !s || (path !== "translation" && path !== "rotation" && path !== "scale")) continue;
    out.push({ node: c.target.node, path, times: readAccessor(m, s.input).values, values: readAccessor(m, s.output).values, size: path === "rotation" ? 4 : 3, interp: s.interpolation ?? "LINEAR" });
  }
  return out;
}

const dot4 = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
const norm4 = (a: Vec) => {
  const l = Math.hypot(a[0], a[1], a[2], a[3]) || 1;
  return a.map(v => v / l);
};

function slerp(a: Vec, b: Vec, u: number): Vec {
  let d = dot4(a, b);
  const bb = d < 0 ? b.map(v => -v) : b;
  d = Math.abs(d);
  if (d > 0.9995) return norm4(a.map((v, i) => v + (bb[i] - v) * u));
  const th = Math.acos(d);
  const s = Math.sin(th);
  const wa = Math.sin((1 - u) * th) / s;
  const wb = Math.sin(u * th) / s;
  return a.map((v, i) => wa * v + wb * bb[i]);
}

// A channel's value at time t, interpolated as glTF 2.0 Appendix C says:
// STEP holds, LINEAR lerps (slerps rotations), CUBICSPLINE is a Hermite curve
// with its tangents stored either side of each value. Before the first key
// and after the last, the end keys hold.
export function sampleChannel(c: Pick<Channel, "times" | "values" | "size" | "interp" | "path">, t: number): Vec {
  const n = c.times.length;
  const cubic = c.interp === "CUBICSPLINE";
  const get = (k: number, part = 1) => {
    const o = cubic ? (k * 3 + part) * c.size : k * c.size;
    return Array.from(c.values.subarray(o, o + c.size));
  };
  if (n === 0) return c.path === "rotation" ? [0, 0, 0, 1] : c.path === "scale" ? [1, 1, 1] : [0, 0, 0];
  if (t <= c.times[0] || n === 1) return get(0);
  if (t >= c.times[n - 1]) return get(n - 1);
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (c.times[mid] <= t) lo = mid;
    else hi = mid;
  }
  const t0 = c.times[lo];
  const dt = c.times[hi] - t0;
  const u = dt > 0 ? (t - t0) / dt : 0;
  if (c.interp === "STEP") return get(lo);
  if (cubic) {
    const p0 = get(lo);
    const m0 = get(lo, 2);
    const p1 = get(hi);
    const m1 = get(hi, 0);
    const u2 = u * u;
    const u3 = u2 * u;
    const v = p0.map((_, i) => (2 * u3 - 3 * u2 + 1) * p0[i] + (u3 - 2 * u2 + u) * dt * m0[i] + (-2 * u3 + 3 * u2) * p1[i] + (u3 - u2) * dt * m1[i]);
    return c.path === "rotation" ? norm4(v) : v;
  }
  const a = get(lo);
  const b = get(hi);
  return c.path === "rotation" ? slerp(a, b, u) : a.map((v, i) => v + (b[i] - v) * u);
}

function poseAt(j: Gltf, chans: Channel[], t: number): Map<number, GNode> {
  const pose = new Map<number, GNode>();
  for (const c of chans) {
    const rest = j.nodes![c.node];
    const node = pose.get(c.node) ?? { translation: rest.translation, rotation: rest.rotation, scale: rest.scale };
    node[c.path] = sampleChannel(c, t);
    pose.set(c.node, node);
  }
  return pose;
}

const quatAngle = (a: Vec, b: Vec) => 2 * Math.acos(Math.min(1, Math.abs(dot4(norm4(a), norm4(b)))));

// ---- What each clip does

export interface ClipFacts {
  still?: true; // every key holds one pose
  returns_to_first_pose?: boolean; // no joint jumps more than a step from the last pose to the first
  end_jump?: { joint: string; deg: number }; // when it does not: the worst joint's turn
  end_offset?: { joint: string; distance: number }; // and how far the root or the hips end from their start
  not_read?: string; // why its keys could not be read
  root_motion?: { distance: number; axis: string; speed: number }; // only when it travels
  move_speed?: { speed: number; axis: string; from: "planted feet" | "root motion"; range?: [number, number] };
}

// The clips that may be a gait, by name: walk_forward, Brisk Walk, h4_run.
const LOCOMOTION = /(^|[^a-z])(walk|run|jog|sprint|strafe|march|sneak|crawl|backpedal|trot|gallop|locomot)/;
// The hips by name (Hips, pelvis, mixamorig:Hips), not a leg's L_Hip.
const HIPS = /(^|[^a-z])(hips|pelvis)$/i;

const isLocomotion = (name: string) => LOCOMOTION.test(name.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase());

const r4 = (v: number) => Math.round(v * 1e4) / 1e4 || 0;

/**
 * What each animation does, from its samplers run through the skeleton, and
 * which way the skeleton faces. Lengths are in the model's units.
 */
export function animationFacts(m: Loaded): { facing?: { axis: string; turn_deg: number }; clips: ClipFacts[] } {
  const j = m.json;
  const g = sceneGraph(j);
  const rest = worldMatrices(j, g);
  const joints = skeletonJoints(j, g);
  const { feet, named } = feetOf(j, g, joints, rest);
  const restY = joints.map(n => rest[n][13]);
  // The skeleton's height sets every tolerance, so they hold at any scale.
  const tall = joints.length ? Math.max(...restY) - Math.min(...restY) : 0;
  const fwd = feet.length >= 2 ? rigForward(feet, named, rest) : undefined;
  return {
    ...(fwd ? { facing: { axis: axisOf(fwd), turn_deg: Math.round(degrees(-Math.atan2(fwd[0], fwd[2]))) || 0 } } : {}),
    clips: (j.animations ?? []).map((a, i) => clipFacts(m, g, a, a.name || `animation ${i}`, feet, tall))
  };
}

function clipFacts(m: Loaded, g: Graph, a: NonNullable<Gltf["animations"]>[number], name: string, feet: Foot[], tall: number): ClipFacts {
  const j = m.json;
  let chans: Channel[];
  try {
    chans = channelsOf(m, a).filter(c => g.depth[c.node] >= 0);
  } catch (err) {
    // Keys it cannot read: said, so the clip is not taken for one with nothing to say.
    if (err instanceof ModelError || err instanceof RangeError) return { not_read: err instanceof Compressed ? `its keys are ${err.message}` : err.message };
    throw err;
  }
  const start = Math.min(...chans.map(c => c.times[0] ?? Infinity));
  const end = Math.max(...chans.map(c => c.times[c.times.length - 1] ?? -Infinity));
  if (!chans.length || !Number.isFinite(start) || end <= start) return { still: true };
  const duration = end - start;
  const T = tall || 1;
  const moves = chans.some(c => {
    const v = c.values;
    const z = c.interp === "CUBICSPLINE" ? c.size : 0; // the first value, past its in-tangent
    for (let k = z; k + c.size <= v.length; k += c.size) {
      if (c.interp === "CUBICSPLINE" && (k / c.size) % 3 !== 1) continue;
      if (c.path === "rotation" ? degrees(quatAngle(Array.from(v.subarray(z, z + 4)), Array.from(v.subarray(k, k + 4)))) > 0.1 : Math.hypot(...[0, 1, 2].map(i => v[k + i] - v[z + i])) > 1e-4 * T) return true;
    }
    return false;
  });
  if (!moves) return { still: true };
  const main = chans.reduce((p, c) => (c.times.length > p.times.length ? c : p));
  const keyDt = median(Array.from(main.times.subarray(1)).map((t, i) => t - main.times[i]));
  const out: ClipFacts = {};
  // The topmost animated joint: the hips, in Ludo's clips; a dedicated root
  // bone, in Unreal's.
  const animated = [...new Set(chans.map(c => c.node))];
  const root = animated.reduce((p, q) => (g.depth[q] < g.depth[p] ? q : p));

  // The seam: the jump each joint's rotation makes from the last pose back
  // to the first, and the jump the root and the hips make in the scene, less
  // the ground the clip travels (which an engine's root motion carries
  // over); each against the steps it takes either side of it (the first and
  // the last key intervals). Jumping no further than a step or two is a
  // clean seam, as on a loop or a one-shot that ends at rest; which of the
  // two it is, the clip's name says, not its keys.
  if (keyDt > 0) {
    const h = Math.min(keyDt, duration / 10);
    const rots = chans.filter(c => c.path === "rotation").map(c => {
      const seam = degrees(quatAngle(sampleChannel(c, end), sampleChannel(c, start)));
      const step = (degrees(quatAngle(sampleChannel(c, start), sampleChannel(c, start + h))) + degrees(quatAngle(sampleChannel(c, end - h), sampleChannel(c, end)))) / 2;
      return { node: c.node, seam, ratio: seam / Math.max(step, 0.5) };
    });
    const [w0, w1, w2, w3] = [start, start + h, end - h, end].map(t => worldMatrices(j, g, poseAt(j, chans, t)));
    const glide = flat(sub(at(w3[root]), at(w0[root])));
    const glideStep = glide.map(v => (v * h) / duration);
    const hips = g.order.find(nd => HIPS.test(nameOf(j, nd)));
    const places = [...new Set([root, ...(hips === undefined ? [] : [hips])])].map(nd => {
      const away = sub(at(w3[nd]), at(w0[nd]));
      const seam = len(sub(away, glide));
      const step = (len(sub(sub(at(w1[nd]), at(w0[nd])), glideStep)) + len(sub(sub(at(w3[nd]), at(w2[nd])), glideStep))) / 2;
      return { node: nd, seam, ratio: seam / Math.max(step, 0.005 * T), away: len(away) };
    });
    const worst = <X extends { ratio: number }>(xs: X[]) => xs.reduce((p, q) => (q.ratio > p.ratio ? q : p));
    const turnsBack = !rots.length || rots.every(p => p.seam < 1) || worst(rots).ratio <= 2;
    const comesBack = places.every(p => p.seam < 0.01 * T) || worst(places).ratio <= 2;
    out.returns_to_first_pose = turnsBack && comesBack;
    if (!turnsBack) {
      const w = worst(rots);
      out.end_jump = { joint: nameOf(j, w.node), deg: Math.round(w.seam) };
    }
    // Ending elsewhere, how far the root or the hips end from where they
    // started, the ground it travels included (when over 2% of the height).
    const far = places.reduce((p, q) => (q.away > p.away ? q : p));
    if (!out.returns_to_first_pose && (!comesBack || far.away >= 0.02 * T)) out.end_offset = { joint: nameOf(j, far.node), distance: r4(far.away) };
  }

  // Sample at the keys' own rate (at least 30 a second, at most 2000 in all).
  const n = Math.min(2000, Math.max(2, Math.ceil(duration * Math.max(30, keyDt > 0 ? 1 / keyDt : 0)) + 1));
  const dt = duration / (n - 1);
  const worlds = Array.from({ length: n }, (_, k) => worldMatrices(j, g, poseAt(j, chans, start + k * dt)));

  // Root motion: how the root travels over the ground, as an engine's
  // root-motion extraction reads it. Under a tenth of the skeleton's height
  // is drift, not travel: Ludo's in-place runs drift up to 5% over a loop.
  const rootAt = worlds.map(w => at(w[root]));
  const travel = flat(sub(rootAt[n - 1], rootAt[0]));
  const inPlace = len(travel) < 0.1 * T;
  if (!inPlace) out.root_motion = { distance: r4(len(travel)), axis: axisOf(travel), speed: r4(len(travel) / duration) };
  // A walk that turns (and so ends away from its first pose) has no one
  // direction to give a speed along.
  if (feet.length < 2 || !isLocomotion(name) || out.returns_to_first_pose === false) return out;

  // Foot contacts. A joint of a foot is low while it is near the lowest it
  // gets in the clip (within 30% of how high it lifts, kept between 1.5% and
  // 5% of the skeleton's height) and barely moving up or down; a foot is
  // down while one of its joints is low (the heel at heel strike, the ball at
  // toe-off). Height alone is fooled by a foot that shuffles low through its
  // swing, so a striding foot (one that swings well ahead of and behind the
  // root) is also only down while it moves back against the root, as a
  // planted foot does whether the clip travels or walks in place; any other
  // foot only while it stays still.
  const minRun = Math.max(2, Math.round(0.06 / dt));
  const rate = (xs: number[], k: number) => {
    const k0 = Math.max(0, k - 1);
    const k1 = Math.min(n - 1, k + 1);
    return (xs[k1] - xs[k0]) / ((k1 - k0) * dt);
  };
  // Barely moving up or down: since the sample before, until the one after,
  // or across both. A run's foot lands and lifts within a frame or two, so
  // its sample on the ground is still on one side only.
  const still = (xs: number[], k: number, tol: number) =>
    Math.min(Math.abs(rate(xs, k)), k > 0 ? Math.abs(xs[k] - xs[k - 1]) / dt : Infinity, k + 1 < n ? Math.abs(xs[k + 1] - xs[k]) / dt : Infinity) <= tol;
  const heights = feet.map(f => f.joints.map(nd => worlds.map(w => w[nd][13])));
  const floors = heights.map(hs => hs.map(h => Math.min(...h)));
  const reach = (ji: number) => Math.min(...floors.filter(fl => fl.length > ji).map(fl => fl[ji]));
  const contacts = feet.map((f, fi) => {
    const low: boolean[] = new Array(n).fill(false);
    heights[fi].forEach((h, ji) => {
      const floor = floors[fi][ji];
      if (floor > reach(ji) + 0.05 * T) return; // never gets down to where the other feet do
      const tol = Math.min(0.05 * T, Math.max(0.015 * T, 0.3 * (Math.max(...h) - floor)));
      for (let k = 0; k < n; k++) if (h[k] <= floor + tol && still(h, k, 0.35 * T)) low[k] = true;
    });
    const ball = f.joints[Math.min(1, f.joints.length - 1)];
    // The foot against the root, on the ground, along the line it swings on.
    const rel = worlds.map((w, k) => flat(sub(mean(f.joints.map(nd => at(w[nd]))), rootAt[k])));
    const c = mean(rel);
    let [sxx, szz, sxz] = [0, 0, 0];
    for (const r of rel) {
      sxx += (r[0] - c[0]) ** 2;
      szz += (r[2] - c[2]) ** 2;
      sxz += (r[0] - c[0]) * (r[2] - c[2]);
    }
    const theta = 0.5 * Math.atan2(2 * sxz, sxx - szz);
    const axis = [Math.cos(theta), 0, Math.sin(theta)];
    const along = rel.map(r => dot(r, axis));
    const swing = Math.max(...along) - Math.min(...along);
    const striding = swing > 0.08 * T;
    const u = along.map((_, k) => rate(along, k));
    let back = 0;
    if (striding) {
      let [neg, pos] = [0, 0];
      for (let k = 0; k < n; k++) if (low[k]) u[k] < 0 ? neg++ : pos++;
      back = neg >= pos ? -1 : 1;
    }
    const bx = worlds.map(w => w[ball][12]);
    const bz = worlds.map(w => w[ball][14]);
    const down = low.map((l, k) => l && (striding ? u[k] * back >= -0.02 * T : Math.hypot(rate(bx, k), rate(bz, k)) <= 0.1 * T));
    // The point on the ground is whichever joint is lowest (the heel, then
    // the ball), so a step's slide is that joint's, sample by sample.
    const lowestAlong = heights[fi].map((_, ji) => {
      const ja = worlds.map((w, k) => dot(flat(sub(at(w[f.joints[ji]]), rootAt[k])), axis));
      return ja.map((_, k) => rate(ja, k));
    });
    const slideAt = (k: number) => {
      let ji = 0;
      for (let q = 1; q < heights[fi].length; q++) if (heights[fi][q][k] < heights[fi][ji][k]) ji = q;
      return Math.abs(lowestAlong[ji][k]);
    };
    const runs: [number, number][] = [];
    const bridge = Math.max(2, Math.round(0.12 / dt)); // a flicker inside one step is not two steps
    for (let k = 0; k < n; k++) {
      if (!down[k]) continue;
      let e = k;
      while (e + 1 < n && down[e + 1]) e++;
      if (runs.length && k - runs[runs.length - 1][1] <= bridge) runs[runs.length - 1][1] = e;
      else runs.push([k, e]);
      k = e;
    }
    // A step the clip's start or end cuts short is part of one that wraps
    // round, when the clip returns to its first pose.
    const wraps = !!out.returns_to_first_pose && runs.length > 1 && runs[0][0] === 0 && runs[runs.length - 1][1] === n - 1;
    const steps = runs
      .filter(([s0, e], i) => e - s0 + 1 >= minRun || (wraps && (i === 0 || i === runs.length - 1)))
      .map(([s0, e]) => {
        const ks = Array.from({ length: e - s0 + 1 }, (_, i) => s0 + i);
        return {
          seconds: (e - s0) * dt,
          cut: wraps && (s0 === 0 || e === n - 1),
          slide: median(ks.map(slideAt)), // against the root
          world: median(ks.map(k => Math.hypot(rate(bx, k), rate(bz, k)))), // over the ground
          travel: Math.abs(along[e] - along[s0]) / (swing || 1) // of the swing
        };
      });
    return { steps, rel, ahead: striding ? axis.map(v => -back * v) : undefined };
  });
  if (!contacts.every(c => c.steps.length)) return out;
  const whole = contacts.flatMap(c => c.steps.filter(s0 => !s0.cut && s0.seconds > 0));
  const all = whole.length ? whole : contacts.flatMap(c => c.steps.filter(s0 => s0.seconds > 0));
  // Steps under half the usual length are a foot touching down, not a step.
  const usual = median(all.map(s0 => s0.seconds));
  const steps = all.filter(s0 => s0.seconds >= 0.5 * usual);
  if (!steps.length) return out;
  // A gait, not a dance, a jump or an attack: the feet take turns (one
  // ahead while the other is behind, so their swings against the root run
  // against each other), and a planted foot sweeps back through some of its
  // swing: over Ludo's clips a sprint's short stance covers 21% of it, the
  // most a dance or jumping jacks named as a run covers 13%.
  const corr = (p: number[], q: number[]) => p.reduce((t, v, k) => t + v * q[k], 0) / Math.sqrt(p.reduce((t, v) => t + v * v, 0) * q.reduce((t, v) => t + v * v, 0) || 1);
  const gait = (dir: Vec) => {
    const along = contacts.map(c => {
      const xs = c.rel.map(r => dot(r, dir));
      const m0 = xs.reduce((t, v) => t + v, 0) / n;
      return xs.map(v => v - m0);
    });
    return (contacts.length !== 2 || corr(along[0], along[1]) < -0.3) && contacts.every(c => Math.max(...c.steps.map(x => x.travel)) >= 0.15);
  };
  const speed = len(travel) / duration;
  if (!inPlace) {
    // Travelling, the clip's own speed is the one to move at, as long as
    // its planted feet hold still on the ground while it does.
    if (speed > 0.05 * T && gait(unit(travel)) && median(steps.map(s0 => s0.world)) <= 0.25 * speed) out.move_speed = { speed: r4(speed), axis: axisOf(travel), from: "root motion" };
    return out;
  }
  // In place, a planted foot slides back at the speed the body should move:
  // the character covers the ground the foot gives away.
  if (!contacts.every(c => c.ahead)) return out;
  const dirs = contacts.map(c => c.ahead!);
  const dir = unit(mean(dirs));
  const slides = steps.map(s0 => s0.slide);
  const slide = median(slides);
  if (dirs.every(d => dot(d, dir) > 0.7) && slide > 0.05 * T && gait(dir)) {
    out.move_speed = { speed: r4(slide), axis: axisOf(dir), from: "planted feet", range: [r4(Math.min(...slides)), r4(Math.max(...slides))] };
  }
  return out;
}

// Where a mesh's vertices land in the scene: through its node's world
// matrix or, for a skinned mesh (whose node's own transform glTF ignores),
// its skeleton's root joint's world matrix times that joint's inverse bind
// matrix. In the bind pose every joint gives the same matrix; gltfpack
// folds its positions' dequantization into it.
function placement(m: Loaded, g: Graph, skin: number | undefined, world: Mat, worlds: Mat[]): Mat {
  const s = skin === undefined ? undefined : m.json.skins?.[skin];
  const placed = (s?.joints ?? []).map((n, i) => ({ n, i })).filter(({ n }) => worlds[n]);
  if (!placed.length) return world;
  const { n, i } = placed.reduce((p, q) => (g.depth[q.n] < g.depth[p.n] ? q : p));
  if (s!.inverseBindMatrices === undefined) return worlds[n];
  try {
    return multiply(worlds[n], Array.from(readAccessor(m, s!.inverseBindMatrices).values.subarray(i * 16, i * 16 + 16)));
  } catch (err) {
    if (err instanceof ModelError) throw new ModelError(`its skin's inverse bind matrices are ${err instanceof Compressed ? err.message : `unreadable (${err.message})`}`);
    throw err;
  }
}

export function modelInfo(m: Loaded) {
  const j = m.json;
  const acc = (i: number | undefined) => (i === undefined ? undefined : j.accessors?.[i]);
  // The nodes the default scene draws, with their world matrices.
  const g = sceneGraph(j);
  const worlds = worldMatrices(j, g);
  const drawn = g.order.map(node => ({ node, world: worlds[node] }));

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
  let boundsNotRead: string | undefined;
  for (const { node, world } of drawn) {
    const mesh = j.meshes?.[j.nodes![node].mesh ?? -1];
    if (!mesh) continue;
    instances++;
    let place: Mat;
    try {
      place = placement(m, g, j.nodes![node].skin, world, worlds);
    } catch (err) {
      if (!(err instanceof ModelError || err instanceof RangeError)) throw err;
      boundsNotRead ??= err.message;
      continue;
    }
    for (const p of mesh.primitives ?? []) {
      const pos = acc(p.attributes?.POSITION);
      if (pos?.min?.length === 3 && pos.max?.length === 3) {
        // min and max are the stored values (glTF 2.0 §5.1.2): a quantized
        // position (KHR_mesh_quantization) is normalized here, as when read.
        const lo = pos.min.map(v => dequantize(v, pos.componentType, pos.normalized));
        const hi = pos.max.map(v => dequantize(v, pos.componentType, pos.normalized));
        for (let k = 0; k < 8; k++) {
          const corner = [k & 1 ? hi[0] : lo[0], k & 2 ? hi[1] : lo[1], k & 4 ? hi[2] : lo[2]];
          const w = apply(place, corner);
          for (let a = 0; a < 3; a++) {
            min[a] = Math.min(min[a], w[a]);
            max[a] = Math.max(max[a], w[a]);
          }
        }
      }
    }
  }
  const round = (v: number) => Math.round(v * 1e5) / 1e5;
  const bounds = Number.isFinite(min[0]) && !boundsNotRead ? { min: min.map(round), max: max.map(round), size: max.map((v, a) => round(v - min[a])) } : undefined;
  const place: { bounds?: NonNullable<typeof bounds>; bounds_not_read?: string } = bounds ? { bounds } : boundsNotRead ? { bounds_not_read: boundsNotRead } : {};

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
    ...place,
    extensions_used: j.extensionsUsed ?? [],
    extensions_required: j.extensionsRequired ?? []
  };
}

// "ends 5° (Neck) and 0.94 units (Pelvis) from its first pose"
function endsAway(a: ClipFacts): string {
  const turn = a.end_jump && `${a.end_jump.deg}°`;
  const off = a.end_offset && `${+a.end_offset.distance.toFixed(3)} units`;
  if (turn && off) return `ends ${turn} (${a.end_jump!.joint}) and ${off} (${a.end_offset!.joint}) from its first pose`;
  return `ends ${turn ?? off} from its first pose (${a.end_jump?.joint ?? a.end_offset?.joint})`;
}

// One clip in words: a still, or how its end meets its start, how it
// travels, and for a walk or run the speed that keeps its feet planted.
function clipLine(a: { name: string; seconds: number } & ClipFacts): string {
  const said = a.not_read
    ? [`not read: ${a.not_read}`]
    : a.still
    ? ["a still: every key holds one pose"]
    : [
        a.returns_to_first_pose === undefined ? "" : a.returns_to_first_pose ? "returns to its first pose" : endsAway(a),
        a.root_motion ? `travels ${+a.root_motion.distance.toFixed(3)} units along ${a.root_motion.axis}` : "",
        a.move_speed
          ? a.move_speed.from === "planted feet"
            ? `move it at ${+a.move_speed.speed.toFixed(2)} units/s along ${a.move_speed.axis}, the median speed its planted feet slide back${a.move_speed.range![1] - a.move_speed.range![0] >= 0.005 ? ` (${a.move_speed.range!.map(v => v.toFixed(2)).join(" to ")} a step)` : ""}`
            : `moves at ${+a.move_speed.speed.toFixed(2)} units/s along ${a.move_speed.axis}, its feet planted`
          : ""
      ].filter(Boolean);
  return `  ${a.name} (${+a.seconds.toFixed(2)} s)${said.length ? `: ${said.join("; ")}` : ""}`;
}

TOOLS.push({
  group: "model",
  name: "info",
  args: "<model>",
  summary: "What is in a glTF or GLB model: meshes, triangles, size, textures, rig and animations",
  details: [
    "Counts as Khronos's glTF-Validator does (primitives, vertices and triangles of every mesh, once),",
    "plus the mesh instances the scene draws, its size there (bounds through the node transforms, or a",
    "skinned mesh's joints; quantized positions are scaled as glTF says), each texture's pixel size, the",
    "skeleton's joints and each animation's length. Reads .glb, and .gltf with its buffers and images",
    "beside it or embedded. Buffers compressed with EXT_meshopt_compression (gltfpack's) are not",
    "decoded: a size or clip that needs them says so.",
    "Each clip is run through the skeleton: whether it holds one pose, returns to its first pose (no",
    "joint turns, and the hips do not move, more than a key's step from its last pose to its first,",
    "less the ground it travels; whether to loop it is for its name to say) and travels (root motion",
    "of a tenth of its height or more). A walk or run, by its name and feet that take turns, gets",
    "the speed to move it at: the median speed its planted feet slide back when it walks in place, or",
    "its own speed when it travels. Lengths and speeds are in the model's units, as its size is. A",
    "rigged model whose feet say which way it faces gets that facing."
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
    let facts: ReturnType<typeof animationFacts> | undefined;
    try {
      const m = readGltf(buf, file);
      info = modelInfo(m);
      try {
        facts = animationFacts(m);
      } catch (err) {
        // Buffers it cannot read leave the counts, which need none.
        if (!(err instanceof ModelError || err instanceof RangeError)) throw err;
      }
    } catch (err) {
      if (err instanceof ModelError || err instanceof TypeError) throw new CliError(`Cannot read ${file} as a glTF model: ${err.message}`, EXIT.BAD_INPUT);
      throw err;
    }
    const animations = info.animations.map((a, i) => ({ ...a, ...facts?.clips[i] }));
    // A facing for the model a rig places, not for an animation file's skeleton.
    const facing = info.rigged ? facts?.facing : undefined;
    const skeleton = !info.meshes && info.animated; // an animation-only file: a skeleton and its clips
    const next = skeleton
      ? animations.some(a => a.still)
        ? hint("A clip does not move; ask Ludo for another take", `ludo model animate --model <rigged model> --prompt "<what it does>"`)
        : hint("Ask Ludo for more clips for the rigged model", `ludo model animate --model <rigged model> --prompt "<what it does>"`)
      : info.rigged
        ? hint("Animate it with Ludo", `ludo model animate --model ${shown(file)} --prompt "<what it does>"`)
        : hint("Rig it with Ludo, so it can be animated", `ludo model rig --model ${shown(file)}`);
    if (ctx.jsonOut) {
      printJson({ model: shown(file), bytes: buf.length, ...info, animations, ...(facing ? { facing } : {}), ...(ctx.globals.quiet ? {} : { hint: next }) }, false);
    } else {
      const lines = [
        `${info.meshes} mesh${info.meshes === 1 ? "" : "es"} (${info.mesh_instances} drawn), ${info.primitives} primitive${info.primitives === 1 ? "" : "s"}, ${info.vertices} vertices, ${info.triangles} triangles`,
        ...(info.bounds ? [`Size ${info.bounds.size.map(v => +v.toFixed(3)).join(" x ")} (x, y, z)`] : info.bounds_not_read ? [`Size not read: ${info.bounds_not_read}`] : []),
        `${info.materials} material${info.materials === 1 ? "" : "s"}, ${info.textures} texture${info.textures === 1 ? "" : "s"}${info.images.length ? ` (${info.images.map(i => ("width" in i ? `${i.width}x${i.height}` : "?")).join(", ")})` : ""}`,
        info.rigged ? `Rigged: ${info.skins.map(s => `${s.joints} joints`).join(", ")}` : skeleton ? "No mesh: a skeleton and its animations" : "Not rigged",
        // glTF's front is +Z, which Godot keeps as Vector3.MODEL_FRONT.
        ...(facing
          ? [
              facing.axis === "+Z" && Math.abs(facing.turn_deg) < 20
                ? "Faces +Z, glTF's front (Godot's MODEL_FRONT); Godot's CharacterBody3D template moves along -Z, so turn it 180° under the body there"
                : `Faces ${facing.axis}, not glTF's +Z front: turned ${facing.turn_deg}° on Y, it faces +Z`
            ]
          : []),
        ...(info.animated ? [`Animations: ${animations.length}`, ...animations.map(clipLine)] : ["No animations"]),
        ...(info.morph_targets ? ["Has morph targets"] : []),
        ...(info.extensions_required.length ? [`Requires ${info.extensions_required.join(", ")}`] : [])
      ];
      process.stdout.write(lines.join("\n") + "\n");
      if (!ctx.globals.quiet) process.stderr.write(`Next: ${next.text}: ${next.command}\n`);
    }
    return EXIT.OK;
  }
});
