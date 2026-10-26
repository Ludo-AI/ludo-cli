import fs from "node:fs";
import { CliError, EXIT } from "../errors.js";
import { printJson, type Ctx } from "../generate.js";
import { shown } from "./io.js";
import { positiveInt, textFlag } from "./flags.js";
import { apply, identity, local, ModelError, multiply, readAccessor, readGltf, type Gltf, type Loaded, type Mat } from "./model.js";
import { hint, TOOLS, type Hint, type ToolCall } from "./registry.js";

// `ludo toolbox model orient|clips|collide`: placing a glTF model in an engine.
// These tools measure and advise; they never write the model back. Ludo's
// generation already makes models game-ready (rigging, joint naming for each
// engine, in-place and looping presets), so "fixing" one here would be a
// second, worse copy of that work. Every number comes from the file: the
// vertices (skinned, at rest, when the mesh has a skin), the joints through
// forward kinematics, and the animation samplers read from the buffers.

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
const round = (v: number, places = 4) => Math.round(v * 10 ** places) / 10 ** places || 0;
const rv = (v: Vec, places = 4) => v.map(x => round(x, places));
const degrees = (rad: number) => (rad * 180) / Math.PI;
const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const AXES = ["X", "Y", "Z"];

// "+Z" for the axis a direction is closest to, and how far off it is.
function axisOf(v: Vec): { axis: string; off_deg: number } {
  const u = unit(v);
  let k = 0;
  for (let a = 1; a < 3; a++) if (Math.abs(u[a]) > Math.abs(u[k])) k = a;
  return { axis: `${u[k] < 0 ? "-" : "+"}${AXES[k]}`, off_deg: round(degrees(Math.acos(Math.min(1, Math.abs(u[k])))), 1) };
}

export function loadModel(file: string): Loaded {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(file);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new CliError(`File not found: ${file}`, EXIT.USAGE);
    if (code === "EISDIR") throw new CliError(`${file} is a folder, not a model`, EXIT.USAGE);
    if (code) throw new CliError(`Cannot open ${file} (${code})`, EXIT.USAGE);
    throw err;
  }
  return readable(file, () => readGltf(buf, file));
}

// A model whose JSON reads but whose buffers do not is as unreadable as one
// that does not parse: the same exit code, and the reason.
function readable<T>(file: string, work: () => T): T {
  try {
    return work();
  } catch (err) {
    if (err instanceof ModelError || err instanceof TypeError || err instanceof RangeError) throw new CliError(`Cannot read ${file} as a glTF model: ${err.message}`, EXIT.BAD_INPUT);
    throw err;
  }
}

// ---- The scene graph

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

// ---- The mesh, as the scene draws it

export interface Points {
  xyz: Float64Array;
  triangles: Uint32Array; // indices into xyz, three per triangle
  skinned: boolean;
}

// Every vertex of every mesh the default scene draws, in scene space. A
// skinned mesh is placed by its joints, as the spec says (its own node's
// transform is ignored), with the joints at rest: that is the bind pose
// whenever, as usual, the rest pose is the pose the skin was bound in.
export function meshPoints(m: Loaded, g: Graph, w: Mat[]): Points {
  const j = m.json;
  const xyz: number[] = [];
  const tris: number[] = [];
  let skinned = false;
  for (const n of g.order) {
    const node = j.nodes![n];
    const mesh = j.meshes?.[node.mesh ?? -1];
    if (!mesh) continue;
    const skin = node.skin !== undefined ? j.skins?.[node.skin] : undefined;
    let joints: Mat[] | undefined;
    if (skin) {
      const ibm = skin.inverseBindMatrices !== undefined ? readAccessor(m, skin.inverseBindMatrices).values : undefined;
      joints = skin.joints.map((jn, k) => multiply(w[jn] ?? identity(), ibm && ibm.length >= k * 16 + 16 ? Array.from(ibm.subarray(k * 16, k * 16 + 16)) : identity()));
    }
    for (const p of mesh.primitives ?? []) {
      if (p.attributes?.POSITION === undefined) continue;
      const pos = readAccessor(m, p.attributes.POSITION);
      const base = xyz.length / 3;
      const J = joints && p.attributes.JOINTS_0 !== undefined && p.attributes.WEIGHTS_0 !== undefined ? readAccessor(m, p.attributes.JOINTS_0).values : undefined;
      const W = J ? readAccessor(m, p.attributes.WEIGHTS_0).values : undefined;
      if (J) skinned = true;
      for (let i = 0; i < pos.count; i++) {
        const v = [pos.values[i * 3], pos.values[i * 3 + 1], pos.values[i * 3 + 2]];
        let q = apply(w[n], v);
        if (J && W && joints) {
          const acc = [0, 0, 0];
          let total = 0;
          for (let k = 0; k < 4; k++) {
            const weight = W[i * 4 + k];
            const jm = joints[J[i * 4 + k]];
            if (!weight || !jm) continue;
            const s = apply(jm, v);
            for (let c = 0; c < 3; c++) acc[c] += weight * s[c];
            total += weight;
          }
          if (total > 0) q = acc.map(c => c / total);
        }
        xyz.push(q[0], q[1], q[2]);
      }
      const idx = p.indices !== undefined ? Array.from(readAccessor(m, p.indices).values) : Array.from({ length: pos.count }, (_, i) => i);
      const mode = p.mode ?? 4;
      if (mode === 4) for (let i = 0; i + 2 < idx.length; i += 3) tris.push(base + idx[i], base + idx[i + 1], base + idx[i + 2]);
      if (mode === 5) for (let i = 0; i + 2 < idx.length; i++) tris.push(base + idx[i], base + idx[i + 1 + (i & 1)], base + idx[i + 2 - (i & 1)]);
      if (mode === 6) for (let i = 1; i + 1 < idx.length; i++) tris.push(base + idx[0], base + idx[i], base + idx[i + 1]);
    }
  }
  return { xyz: Float64Array.from(xyz), triangles: Uint32Array.from(tris.filter(t => t < xyz.length / 3)), skinned };
}

export interface Bounds {
  min: Vec;
  max: Vec;
  size: Vec;
  center: Vec;
}

export function boundsOf(xyz: Float64Array): Bounds | undefined {
  if (!xyz.length) return undefined;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < xyz.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      if (xyz[i + a] < min[a]) min[a] = xyz[i + a];
      if (xyz[i + a] > max[a]) max[a] = xyz[i + a];
    }
  }
  return { min, max, size: max.map((v, a) => v - min[a]), center: max.map((v, a) => (v + min[a]) / 2) };
}

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
const HEAD = /head|skull/i;

export interface Foot {
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
export function feetOf(j: Gltf, g: Graph, joints: number[], w: Mat[]): { feet: Foot[]; named: boolean } {
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

// Which way a rig faces, on the ground: its toes point ahead of its ankles,
// and a character facing +Z has its left side on +X (left x up = forward).
function rigForward(feet: Foot[], named: boolean, w: Mat[]) {
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
  if (toe && len(toe) > 0.5 && side) {
    if (dot(toe, side) > 0.7) return { vector: unit([toe[0] + side[0], 0, toe[2] + side[2]]), confidence: "high", from: "rig: the toes point ahead of the ankles, and the left foot is on the character's left" };
    return { vector: side, confidence: "low", from: "rig: the left and right feet say one way and the toes another; the sides are trusted" };
  }
  if (side) return { vector: side, confidence: "medium", from: "rig: the left foot is on the character's left (no toe joints)" };
  if (toe && len(toe) > 0.5) return { vector: toe, confidence: agree ? "medium" : "low", from: `rig: the toes point ahead of the ankles (${named ? "named" : "unnamed"} joints${agree ? "" : ", and the feet disagree"})` };
  return undefined;
}

// Which way a mesh with no rig faces: a character is mirror-symmetric across
// its sides, so the horizontal axis it mirrors best across runs left to
// right and the other runs front to back. Which end is the front is three
// votes, each a share of the depth: the feet reach ahead of the shins, the
// toes stick out further in front than the heels do behind, and the head
// sits ahead of the chest. With their rigs taken away, 27 of Ludo's rigged
// characters (whose rigs say the front) got the right front 18 times and no
// answer 9 times, never a wrong one; capes, tails and held weapons are what
// split the votes. So: medium confidence when all three agree, low when two
// do and one abstains, and no sign at all otherwise.
function meshForward(xyz: Float64Array, b: Bounds) {
  const thin = Math.min(b.size[0], b.size[2]) < 0.15 * Math.max(b.size[0], b.size[2]);
  if (thin) return { line: b.size[0] < b.size[2] ? "X" : "Z", flat: true };
  const N = 24;
  const cell = (v: number, a: number) => Math.min(N - 1, Math.max(0, Math.floor(((v - b.min[a]) / (b.size[a] || 1)) * N)));
  const grid = new Uint8Array(N * N * N);
  for (let i = 0; i < xyz.length; i += 3) grid[(cell(xyz[i], 0) * N + cell(xyz[i + 1], 1)) * N + cell(xyz[i + 2], 2)] = 1;
  const mirror = (axis: number) => {
    let both = 0;
    let any = 0;
    for (let x = 0; x < N; x++)
      for (let y = 0; y < N; y++)
        for (let z = 0; z < N; z++) {
          if (!grid[(x * N + y) * N + z]) continue;
          any++;
          const mx = axis === 0 ? N - 1 - x : x;
          const mz = axis === 2 ? N - 1 - z : z;
          if (grid[(mx * N + y) * N + mz]) both++;
        }
    return any ? both / any : 0;
  };
  const sx = mirror(0);
  const sz = mirror(2);
  const symmetry = { x: round(sx, 2), z: round(sz, 2) };
  if (Math.max(sx, sz) < 0.6 || Math.abs(sx - sz) < 0.03) return { symmetry };
  const ahead = sx > sz ? 2 : 0; // mirrored across x: x runs left to right, z front to back
  const h = b.size[1] || 1;
  const depth = b.size[ahead] || 1;
  const band = (lo: number, hi: number) => {
    const vs: number[] = [];
    for (let i = 0; i < xyz.length; i += 3) {
      const y = (xyz[i + 1] - b.min[1]) / h;
      if (y >= lo && y < hi) vs.push(xyz[i + ahead]);
    }
    vs.sort((p, q) => p - q);
    // The 2nd and 98th percentiles, so a stray vertex does not decide.
    return vs.length ? { mean: vs.reduce((s, v) => s + v, 0) / vs.length, back: vs[Math.floor(0.02 * (vs.length - 1))], front: vs[Math.floor(0.98 * (vs.length - 1))] } : undefined;
  };
  const feet = band(0, 0.06);
  const legs = band(0.1, 0.45);
  const chest = band(0.5, 0.85);
  const head = band(0.9, 1.01);
  const votes = [
    feet && legs ? (feet.mean - legs.mean) / depth : 0,
    feet && legs ? (feet.front - legs.front - (legs.back - feet.back)) / depth : 0,
    head && chest ? (head.mean - chest.mean) / depth : 0
  ].map(v => (Math.abs(v) < 0.02 ? 0 : Math.sign(v)));
  const sum = votes.reduce((s, v) => s + v, 0);
  if (Math.abs(sum) < 2) return { symmetry, line: AXES[ahead] };
  const vector = [0, 0, 0];
  vector[ahead] = Math.sign(sum);
  return { symmetry, line: AXES[ahead], vector, confidence: Math.abs(sum) === 3 ? "medium" : "low", votes: Math.abs(sum) === 3 ? "3 of 3" : "2 of 3" };
}

// ---- model orient

export interface Unit {
  unit: string;
  to_metres: number | null;
  why: string;
}

function unitGuess(height: number, longest: number, biped: boolean): Unit {
  if (Math.abs(longest - 1) <= 0.03) return { unit: "normalised", to_metres: null, why: `its longest side is 1 unit: a size fitted to a unit box, not a real one; scale it to its game size${biped ? " (a person is about 1.7 m)" : ""}` };
  if (biped) {
    if (height >= 1.2 && height <= 2.5) return { unit: "m", to_metres: 1, why: `a ${round(height, 2)} m two-legged character is person-sized in metres` };
    if (height >= 120 && height <= 250) return { unit: "cm", to_metres: 0.01, why: `a two-legged character ${round(height, 1)} units tall is person-sized in centimetres` };
    if (height >= 45 && height <= 100) return { unit: "in", to_metres: 0.0254, why: `a two-legged character ${round(height, 1)} units tall is person-sized in inches` };
    if (height >= 12 && height <= 25) return { unit: "dm", to_metres: 0.1, why: `a two-legged character ${round(height, 1)} units tall is person-sized in decimetres` };
    return { unit: "m", to_metres: 1, why: `${round(height, 3)} m is not person-sized in any common unit; read as metres, as glTF says` };
  }
  if (height > 50 && height <= 5000) return { unit: "cm", to_metres: 0.01, why: `${round(height, 1)} units is large for metres; centimetres are likely` };
  return { unit: "m", to_metres: 1, why: "glTF is in metres, and nothing says otherwise" };
}

export function orient(m: Loaded) {
  const j = m.json;
  const g = sceneGraph(j);
  const w = worldMatrices(j, g);
  const pts = meshPoints(m, g, w);
  const joints = skeletonJoints(j, g);
  const fromJoints = !pts.xyz.length;
  const xyz = fromJoints ? Float64Array.from(joints.flatMap(n => at(w[n]))) : pts.xyz;
  const b = boundsOf(xyz);
  if (!b || len(b.size) < 1e-9) return undefined;
  const { feet, named } = feetOf(j, g, joints, w);
  const notes: string[] = [];
  if (pts.skinned) notes.push("Skinned: measured in the rest pose (the joints as the file sets them, no animation), which is the bind pose here unless the rig was re-posed.");
  if (fromJoints) notes.push("No mesh: measured from the skeleton's joints, which stop short of the head's top and the soles.");

  // Up: the head above the feet when the bones say which they are; else
  // glTF's +Y, checked against the mesh's tallest side.
  let up: Record<string, unknown>;
  const head = joints.find(n => HEAD.test(nameOf(j, n)) && !HELPER.test(nameOf(j, n)));
  if (named && head !== undefined) {
    const v = sub(at(w[head]), mean(feet.map(f => at(w[f.joints[0]]))));
    const a = axisOf(v);
    up = { axis: a.axis, vector: rv(unit(v)), off_deg: a.off_deg, matches_gltf: a.axis === "+Y" && a.off_deg < 20, confidence: a.off_deg < 20 ? "high" : "medium", from: "rig: the head above the ankles" };
  } else {
    const order = [0, 1, 2].sort((p, q) => b.size[q] - b.size[p]);
    const ratio = b.size[order[0]] / Math.max(1e-9, b.size[order[1]]);
    const tallest = AXES[order[0]];
    // Without a rig, glTF's +Y stands unless the mesh says otherwise; a
    // mesh longer than it is tall may be a character saved lying down, or
    // just a barrel or a sword lying as it should, so that is only flagged.
    up =
      tallest === "Y"
        ? { axis: "+Y", matches_gltf: true, confidence: ratio >= 1.15 ? "medium" : "low", from: `glTF's +Y, and the mesh is tallest along Y (${round(ratio, 2)}x its next side); a mesh alone cannot tell up from upside down` }
        : { axis: "+Y", matches_gltf: true, confidence: "low", from: `glTF's +Y, but the mesh is longest along ${tallest} (${round(ratio, 2)}x); if it should stand upright, it was saved lying down or Z-up` };
  }

  // Forward, on the ground plane: the rig first, then the mesh's shape.
  const rig = feet.length >= 2 ? rigForward(feet, named, w) : undefined;
  const shape = rig || fromJoints ? undefined : meshForward(xyz, b);
  let forward: Record<string, unknown>;
  let yaw: number | undefined;
  const fv = rig?.vector ?? shape?.vector;
  if (fv) {
    const a = axisOf(fv);
    yaw = Math.round(degrees(-Math.atan2(fv[0], fv[2])));
    forward = {
      axis: a.axis,
      vector: rv(fv, 3),
      off_deg: a.off_deg,
      matches_gltf: a.axis === "+Z" && a.off_deg < 20,
      turn_to_front_deg: yaw,
      confidence: rig?.confidence ?? shape?.confidence,
      from: rig?.from ?? `mesh: mirror-symmetric left to right across ${shape!.line === "Z" ? "X" : "Z"} (overlap x ${shape!.symmetry?.x}, z ${shape!.symmetry?.z}); feet, toes and head vote ${shape!.votes} for this end`
    };
  } else {
    forward = {
      axis: shape?.line ? `±${shape.line}` : "unknown",
      confidence: "none",
      from: shape?.flat
        ? `mesh: a flat piece, thin along ${shape.line}, so it faces one side or the other of ${shape.line}`
        : shape?.line
          ? `mesh: symmetric left to right, so it faces along ${shape.line}, but its feet, toes and head do not agree on which end`
          : "nothing to go on: no rig, and the mesh is not mirror-symmetric like a character"
    };
  }

  // The origin is the scene's (0, 0, 0); the ground offset lifts the lowest
  // point onto it, so the model stands on the floor its parent stands on.
  const h = b.size[1];
  const f = (0 - b.min[1]) / (h || 1);
  const bottom = Math.abs(b.min[1]) <= 0.02 * h;
  const across = Math.max(b.size[0], b.size[2]) || 1;
  const centred = Math.abs(b.center[0]) <= 0.05 * across && Math.abs(b.center[2]) <= 0.05 * across;
  const where = bottom ? "at the feet" : b.min[1] > 0 ? "below the model" : b.max[1] < 0 ? "above the model" : Math.abs(f - 0.5) <= 0.05 ? "at the centre" : `${Math.round(f * 100)}% of the way up`;
  const origin = {
    at: where,
    centred,
    relative: rv([0, 1, 2].map(a => (0 - b.min[a]) / (b.size[a] || 1)), 3),
    ground_offset: round(-b.min[1]),
    horizontal_offset: rv([-b.center[0], 0, -b.center[2]])
  };

  const biped = feet.length === 2 && (named || feet.every(ft => ft.joints.length >= 2));
  const unitInfo = unitGuess(h, Math.max(...b.size), biped);
  const size = { height: round(h), width: round(b.size[0]), depth: round(b.size[2]), unit_guess: unitInfo };
  const s = unitInfo.to_metres ?? 1;

  const fwdAxis = forward.axis as string;
  const facesFront = forward.matches_gltf === true;
  const groundM = round(-b.min[1] * s, 3);
  const atScale = unitInfo.unit === "normalised" ? " at scale 1" : "";
  const scaleLine = (person: string, metres = "it reads as metres") =>
    unitInfo.unit === "normalised"
      ? `Scale: its longest side is 1 unit, a fitted size; scale it to its game size${biped ? ` (${person})` : ""}`
      : s === 1
        ? `Scale: 1 (${metres})`
        : `Scale: ${s} (it reads as ${unitInfo.unit})`;
  const engines = {
    godot: [
      up.matches_gltf ? "Up: +Y, as Godot's importer keeps it" : `Up: it does not stand along +Y (${up.axis}); turn it upright in its scene`,
      facesFront
        ? "Facing: +Z, Godot's Vector3.MODEL_FRONT; look_at(target, Vector3.UP, true) faces it at a target. A controller that walks along -Z (the CharacterBody3D template does) wants it turned 180° on Y under the body"
        : yaw !== undefined
          ? `Facing: ${fwdAxis}; set the model's rotation_degrees.y = ${yaw} to face +Z (Vector3.MODEL_FRONT)`
          : "Facing: unknown; check it in the editor against Vector3.MODEL_FRONT (+Z)",
      scaleLine("a person is about 1.7 m"),
      bottom ? "Offset: none; the origin is at its feet" : `Offset: position.y = ${groundM}${atScale} under the body, so its lowest point is on the floor`
    ],
    unity: [
      up.matches_gltf ? "Up: +Y, as glTFast and UnityGLTF import it" : `Up: it does not stand along +Y (${up.axis}); turn it upright on a parent object`,
      facesFront
        ? "Facing: +Z, transform.forward (the glTF importers flip X for Unity's left-handed axes, and +Z stays the front)"
        : yaw !== undefined
          ? `Facing: ${fwdAxis}; put it under a parent and set its local rotation Y = ${-yaw} to face transform.forward`
          : "Facing: unknown; check it in the scene view against transform.forward (+Z)",
      scaleLine("a person is about 1.7 m"),
      bottom ? "Offset: none; the origin is at its feet" : `Offset: localPosition.y = ${groundM}${atScale} under its parent, so its lowest point is on the floor`
    ],
    unreal: [
      up.matches_gltf ? "Up: the glTF importer turns +Y up into Unreal's +Z up" : `Up: it does not stand along +Y (${up.axis}), so it will not stand along Unreal's +Z either; set Import Rotation`,
      yaw !== undefined
        ? `Facing: Unreal actors face +X. glTF's +Z front usually arrives facing +Y, as Epic's mannequin does, so in a Character Blueprint the Mesh takes yaw -90${facesFront ? "" : `, plus the ${Math.abs(yaw)}° turn that brings this model's ${fwdAxis} front round to glTF's +Z`}; check it against the arrow`
        : "Facing: unknown; Unreal actors face +X: turn the Mesh in its Blueprint until it faces along the arrow",
      scaleLine("a person is about 1.7 m, which the importer makes 170 cm", "it reads as metres, which the importer makes centimetres"),
      `Offset: a Character's capsule sits centred on the actor, so the Mesh's Z = -(capsule half height)${bottom ? "" : ` + ${round(groundM * 100, 1)} cm${atScale}`}`
    ]
  };
  return { up, forward, origin, size, bounds: { min: rv(b.min), max: rv(b.max), size: rv(b.size), center: rv(b.center) }, rig: { joints: joints.length, feet: feet.map(ft => ({ foot: ft.label, joints: ft.joints.map(n => nameOf(j, n)) })) }, engines, notes };
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
    const times = readAccessor(m, s.input).values;
    const out_ = readAccessor(m, s.output);
    out.push({ node: c.target.node, path, times, values: out_.values, size: path === "rotation" ? 4 : 3, interp: s.interpolation ?? "LINEAR" });
  }
  return out;
}

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
const dot4 = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
const norm4 = (a: Vec) => {
  const l = Math.hypot(a[0], a[1], a[2], a[3]) || 1;
  return a.map(v => v / l);
};

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

// ---- model clips

interface Loop {
  seam_deg: number;
  max_deg: number;
  worst_joint: string; // the joint whose jump is largest against its own steps
  worst_jump_deg: number;
  worst_step_deg: number;
  verdict: string;
}

interface RootMotion {
  joint: string;
  distance: number;
  path: number;
  speed: number;
  axis?: string;
  direction?: Vec;
  vertical_range: number;
  in_place: boolean;
}

interface MoveSpeed {
  speed: number;
  axis?: string;
  direction?: Vec;
  from: string;
  cycle_seconds?: number;
  stride?: number;
  planted_foot_slide?: number;
  note?: string;
}

interface ClipReport {
  name: string;
  index: number;
  duration: number;
  keyframes: number;
  fps?: number;
  channels?: number;
  note?: string;
  loop?: Loop;
  root_motion?: RootMotion;
  feet?: { foot: string; joint: string; lowest: number; contacts: { start: number; end: number; slide_speed: number }[] }[];
  move_speed?: MoveSpeed;
}

export function clips(m: Loaded, only?: string) {
  const j = m.json;
  const g = sceneGraph(j);
  const rest = worldMatrices(j, g);
  const joints = skeletonJoints(j, g);
  const { feet, named } = feetOf(j, g, joints, rest);
  const restY = joints.map(n => rest[n][13]);
  // The skeleton's height sets every tolerance, so they hold at any scale.
  const tall = joints.length ? Math.max(...restY) - Math.min(...restY) : 0;
  const forwardRig = feet.length >= 2 ? rigForward(feet, named, rest) : undefined;
  const list = (j.animations ?? []).map((a, index) => ({ a, index })).filter(({ a, index }) => only === undefined || a.name === only || String(index) === only);
  return {
    joints: joints.length,
    skeleton_height: round(tall),
    forward: forwardRig ? { axis: axisOf(forwardRig.vector).axis, confidence: forwardRig.confidence } : undefined,
    feet: feet.map(f => ({ foot: f.label, joints: f.joints.map(n => nameOf(j, n)) })),
    clips: list.map(({ a, index }) => clipReport(m, g, a, index, feet, tall))
  };
}

function clipReport(m: Loaded, g: Graph, a: NonNullable<Gltf["animations"]>[number], index: number, feet: Foot[], tall: number): ClipReport {
  const j = m.json;
  const chans = channelsOf(m, a).filter(c => g.depth[c.node] >= 0);
  const start = Math.min(...chans.map(c => c.times[0] ?? Infinity));
  const end = Math.max(...chans.map(c => c.times[c.times.length - 1] ?? -Infinity));
  const name = a.name || `animation ${index}`;
  if (!chans.length || !Number.isFinite(start) || end <= start) return { name, index, duration: 0, keyframes: chans[0]?.times.length ?? 0, note: "nothing moves: no keyframes over time on the scene's nodes" };
  const duration = end - start;
  // A clip whose keys all hold one pose plays as a statue: say so first.
  const moves = chans.some(c => {
    const v = c.values;
    const z = c.interp === "CUBICSPLINE" ? c.size : 0; // the first value, past its in-tangent
    for (let k = z; k + c.size <= v.length; k += c.size) {
      if (c.interp === "CUBICSPLINE" && (k / c.size) % 3 !== 1) continue;
      if (c.path === "rotation" ? degrees(quatAngle(Array.from(v.subarray(z, z + 4)), Array.from(v.subarray(k, k + 4)))) > 0.1 : Math.hypot(...[0, 1, 2].map(i => v[k + i] - v[z + i])) > 1e-4 * (tall || 1)) return true;
    }
    return false;
  });
  const main = chans.reduce((p, c) => (c.times.length > p.times.length ? c : p));
  const keys = main.times.length;
  const deltas = Array.from(main.times.subarray(1)).map((t, i) => t - main.times[i]);
  const keyDt = median(deltas);
  const fps = keyDt > 0 ? 1 / keyDt : 0;

  // Sample at the keys' own rate (at least 30 a second, at most 2000 in all).
  const n = Math.min(2000, Math.max(2, Math.ceil(duration * Math.max(30, fps)) + 1));
  const dt = duration / (n - 1);
  const times = Array.from({ length: n }, (_, k) => start + k * dt);
  const worlds = times.map(t => worldMatrices(j, g, poseAt(j, chans, t)));

  // The loop seam: the jump each joint's rotation makes from the last pose
  // back to the first, against the steps it takes either side of the seam
  // (the first and the last key intervals). Moving fast through the seam is
  // fine; jumping further than a step or two is a pop.
  const rots = chans.filter(c => c.path === "rotation");
  let loop: Loop | undefined;
  if (rots.length && keyDt > 0) {
    const h = Math.min(keyDt, duration / 10);
    const per = rots.map(c => {
      const seam = degrees(quatAngle(sampleChannel(c, end), sampleChannel(c, start)));
      const step = (degrees(quatAngle(sampleChannel(c, start), sampleChannel(c, start + h))) + degrees(quatAngle(sampleChannel(c, end - h), sampleChannel(c, end)))) / 2;
      return { c, seam, step, ratio: seam / Math.max(step, 0.5) };
    });
    const moving = per.filter(p => p.seam >= 1);
    const worst = (moving.length ? moving : per).reduce((p, q) => (q.ratio > p.ratio ? q : p));
    const biggest = Math.max(...per.map(p => p.seam));
    const verdict =
      biggest < 1
        ? "closes: the last pose is the first"
        : worst.ratio <= 2
          ? "loops: no joint jumps more than a step at the seam"
          : worst.ratio <= 4
            ? "small pop at the seam"
            : "does not loop: a visible jump from the end back to the start";
    loop = {
      seam_deg: round(per.reduce((t, p) => t + p.seam, 0) / per.length, 2),
      max_deg: round(biggest, 2),
      worst_joint: nameOf(j, worst.c.node),
      worst_jump_deg: round(worst.seam, 2),
      worst_step_deg: round(worst.step, 2),
      verdict
    };
  }

  // Root motion: how the topmost animated joint travels over the ground
  // (the hips, in Ludo's clips; a dedicated root bone, in Unreal's), as an
  // engine's root-motion extraction reads it.
  const animated = [...new Set(chans.map(c => c.node))];
  const root = animated.length ? animated.reduce((p, q) => (g.depth[q] < g.depth[p] ? q : p)) : undefined;
  let rootMotion: RootMotion | undefined;
  let travel = 0;
  let inPlace = true;
  let rootDir: Vec | undefined;
  if (root !== undefined) {
    const p = worlds.map(w => at(w[root]));
    const d = flat(sub(p[n - 1], p[0]));
    travel = len(d);
    let path = 0;
    for (let k = 1; k < n; k++) path += len(flat(sub(p[k], p[k - 1])));
    const ys = p.map(v => v[1]);
    inPlace = travel < 0.03 * (tall || 1);
    if (!inPlace) rootDir = unit(d);
    rootMotion = {
      joint: nameOf(j, root),
      distance: round(travel),
      path: round(path),
      speed: round(travel / duration),
      ...(inPlace ? {} : { axis: axisOf(d).axis, direction: rv(unit(d), 3) }),
      vertical_range: round(Math.max(...ys) - Math.min(...ys)),
      in_place: inPlace
    };
  }

  // Foot contacts. A joint of a foot is low while it is near the lowest it
  // gets in the clip (within 30% of how high it lifts, kept between 1.5% and
  // 5% of the skeleton's height) and barely moving up or down; a foot is
  // down while one of its joints is low (the heel at heel strike, the ball at
  // toe-off). Height alone is fooled by a foot that shuffles low through its
  // swing, so a striding foot (one that swings well ahead of and behind the
  // root) is also only down while it moves back against the root, as a
  // planted foot does whether the clip travels or walks in place; any other
  // foot only while it stays still.
  const T = tall || 1;
  const tolV = 0.35 * T;
  const minRun = Math.max(2, Math.round(0.06 / dt));
  const looped = !!loop && /^(loops|closes)/.test(loop.verdict);
  const rootAt = worlds.map(w => (root !== undefined ? at(w[root]) : [0, 0, 0]));
  const rate = (xs: number[], k: number) => {
    const k0 = Math.max(0, k - 1);
    const k1 = Math.min(n - 1, k + 1);
    return (xs[k1] - xs[k0]) / ((k1 - k0) * dt);
  };
  const heights = feet.map(f => f.joints.map(nd => worlds.map(w => w[nd][13])));
  const floors = heights.map(hs => hs.map(h => Math.min(...h)));
  const reach = (ji: number) => Math.min(...floors.filter(fl => fl.length > ji).map(fl => fl[ji]));
  const contacts = feet.map((f, fi) => {
    const low: boolean[] = new Array(n).fill(false);
    heights[fi].forEach((h, ji) => {
      const floor = floors[fi][ji];
      if (floor > reach(ji) + 0.05 * T) return; // never gets down to where the other feet do
      const tol = Math.min(0.05 * T, Math.max(0.015 * T, 0.3 * (Math.max(...h) - floor)));
      for (let k = 0; k < n; k++) if (h[k] <= floor + tol && Math.abs(rate(h, k)) <= tolV) low[k] = true;
    });
    const ball = f.joints[Math.min(1, f.joints.length - 1)];
    // The foot against the root, on the ground, along the line it swings on.
    const rel = worlds.map((w, k) => flat(sub(mean(f.joints.map(nd => at(w[nd]))), rootAt[k])));
    const c = mean(rel);
    let sxx = 0;
    let szz = 0;
    let sxz = 0;
    for (const r of rel) {
      sxx += (r[0] - c[0]) ** 2;
      szz += (r[2] - c[2]) ** 2;
      sxz += (r[0] - c[0]) * (r[2] - c[2]);
    }
    const theta = 0.5 * Math.atan2(2 * sxz, sxx - szz);
    const axis = [Math.cos(theta), 0, Math.sin(theta)];
    const along = rel.map(r => dot(r, axis));
    const striding = Math.max(...along) - Math.min(...along) > 0.08 * T;
    const u = along.map((_, k) => rate(along, k));
    let back = 0;
    if (striding) {
      let neg = 0;
      let pos = 0;
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
    // A step cut short by the clip's end continues at its start when it loops.
    const wraps = looped && runs.length > 1 && runs[0][0] === 0 && runs[runs.length - 1][1] === n - 1;
    const kept = runs.filter(([s0, e], i) => e - s0 + 1 >= minRun || (wraps && (i === 0 || i === runs.length - 1)));
    const steps = kept.map(([s0, e]) => {
      const ks = Array.from({ length: e - s0 + 1 }, (_, i) => s0 + i);
      return {
        start: times[s0] - start,
        end: times[e] - start,
        seconds: (e - s0) * dt,
        cut: wraps && (s0 === 0 || e === n - 1),
        slide: median(ks.map(slideAt)), // against the root
        world: median(ks.map(k => Math.hypot(rate(bx, k), rate(bz, k)))), // over the ground
        travel: Math.abs(along[e] - along[s0]) / (Math.max(...along) - Math.min(...along) || 1) // of the swing
      };
    });
    return { foot: f, floor: Math.min(...floors[fi]), ball, steps, striding, rel, ahead: striding ? axis.map(v => -back * v) : undefined };
  });

  let moveSpeed: MoveSpeed | undefined;
  if (feet.length >= 2 && contacts.every(c => c.steps.length > 0)) {
    // The cycle: from one step's start to the same foot's next; a looping
    // clip with one step per foot is one cycle long.
    const gaps = contacts.flatMap(c => {
      const st = c.steps.filter(s0 => !(s0.cut && s0.start === 0)).map(s0 => s0.start);
      return st.slice(1).map((t, i) => t - st[i]);
    });
    const cycle = gaps.length ? median(gaps) : looped ? duration : undefined;
    const whole = contacts.flatMap(c => c.steps.filter(s0 => !s0.cut && s0.seconds > 0));
    const steps = whole.length ? whole : contacts.flatMap(c => c.steps.filter(s0 => s0.seconds > 0));
    // A gait, not a dance, a jump or an attack: the feet take turns (one
    // ahead while the other is behind, so their swings against the root run
    // against each other), and a planted foot sweeps back through over a
    // third of its swing.
    const corr = (p: number[], q: number[]) => p.reduce((t, v, k) => t + v * q[k], 0) / Math.sqrt(p.reduce((t, v) => t + v * v, 0) * q.reduce((t, v) => t + v * v, 0) || 1);
    const gait = (dir: Vec) => {
      const along = contacts.map(c => {
        const xs = c.rel.map(r => dot(r, dir));
        const m0 = xs.reduce((t, v) => t + v, 0) / n;
        return xs.map(v => v - m0);
      });
      return (contacts.length !== 2 || corr(along[0], along[1]) < -0.3) && contacts.every(c => Math.max(...c.steps.map(x => x.travel)) >= 0.35);
    };
    if (!inPlace && travel / duration > 0.05 * T && rootDir && gait(rootDir)) {
      const speed = travel / duration;
      const footSlide = steps.length ? median(steps.map(s0 => s0.world)) : 0;
      moveSpeed = {
        speed: round(speed),
        axis: axisOf(rootDir).axis,
        direction: rv(rootDir, 3),
        from: "root motion: the clip travels on its own",
        ...(cycle ? { cycle_seconds: round(cycle, 3), stride: round(speed * cycle) } : {}),
        planted_foot_slide: round(footSlide),
        ...(footSlide > 0.15 * speed ? { note: "its planted feet slide over the ground in the clip itself" } : {})
      };
    } else if (inPlace && contacts.every(c => c.ahead)) {
      // In place, a planted foot slides back at the speed the body should
      // move: the character covers the ground the foot gives away.
      const dirs = contacts.map(c => c.ahead!);
      const dir = unit(mean(dirs));
      const time = steps.reduce((t, x) => t + x.seconds, 0);
      const speed = time > 0 ? steps.reduce((t, x) => t + x.slide * x.seconds, 0) / time : 0;
      if (dirs.every(d => dot(d, dir) > 0.7) && speed > 0.05 * T && gait(dir)) {
        moveSpeed = { speed: round(speed), axis: axisOf(dir).axis, direction: rv(dir, 3), from: "planted feet: the speed they slide back at, in place", ...(cycle ? { cycle_seconds: round(cycle, 3), stride: round(speed * cycle) } : {}) };
      }
    }
  }

  return {
    name,
    index,
    ...(moves ? {} : { note: "nothing moves: every key holds the same pose" }),
    duration: round(duration, 4),
    keyframes: keys,
    fps: round(fps, 2),
    channels: chans.length,
    ...(loop ? { loop } : {}),
    ...(rootMotion ? { root_motion: rootMotion } : {}),
    feet: contacts.map(c => ({
      foot: c.foot.label,
      joint: nameOf(j, c.ball),
      lowest: round(c.floor),
      contacts: c.steps.map(s0 => ({ start: round(s0.start, 3), end: round(s0.end, 3), slide_speed: round(inPlace ? s0.slide : s0.world) }))
    })),
    ...(moveSpeed ? { move_speed: moveSpeed } : {})
  };
}

// ---- model collide

// The smallest circle around 2D points (Welzl's algorithm, iteratively,
// on a shuffled copy, so it runs in expected linear time).
function enclosingCircle(xs: number[], zs: number[]): { x: number; z: number; r: number } {
  const idx = xs.map((_, i) => i);
  let seed = 12345;
  for (let i = idx.length - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const k = seed % (i + 1);
    [idx[i], idx[k]] = [idx[k], idx[i]];
  }
  const inside = (c: { x: number; z: number; r: number }, i: number) => Math.hypot(xs[i] - c.x, zs[i] - c.z) <= c.r * (1 + 1e-9) + 1e-12;
  const two = (a: number, b: number) => ({ x: (xs[a] + xs[b]) / 2, z: (zs[a] + zs[b]) / 2, r: Math.hypot(xs[a] - xs[b], zs[a] - zs[b]) / 2 });
  const three = (a: number, b: number, c: number) => {
    const ax = xs[a], az = zs[a], bx = xs[b] - ax, bz = zs[b] - az, cx = xs[c] - ax, cz = zs[c] - az;
    const d = 2 * (bx * cz - bz * cx);
    if (Math.abs(d) < 1e-18) {
      const pairs = [two(a, b), two(a, c), two(b, c)];
      return pairs.reduce((p, q) => (q.r > p.r ? q : p));
    }
    const ux = (cz * (bx * bx + bz * bz) - bz * (cx * cx + cz * cz)) / d;
    const uz = (bx * (cx * cx + cz * cz) - cx * (bx * bx + bz * bz)) / d;
    return { x: ax + ux, z: az + uz, r: Math.hypot(ux, uz) };
  };
  let c = { x: xs[idx[0]] ?? 0, z: zs[idx[0]] ?? 0, r: 0 };
  for (let i = 1; i < idx.length; i++) {
    if (inside(c, idx[i])) continue;
    c = { x: xs[idx[i]], z: zs[idx[i]], r: 0 };
    for (let k = 0; k < i; k++) {
      if (inside(c, idx[k])) continue;
      c = two(idx[i], idx[k]);
      for (let l = 0; l < k; l++) if (!inside(c, idx[l])) c = three(idx[i], idx[k], idx[l]);
    }
  }
  return c;
}

export interface Hull {
  vertices: Vec[];
  faces: number[][]; // triangles, counter-clockwise seen from outside
  volume: number;
  outside: number; // how far the farthest point left out lies outside it (0 for the full hull)
}

// Quickhull (Barber, Dobkin and Huhdanpaa, 1996), always adding the point
// farthest outside any face, so stopping at --max-vertices leaves the hull
// that covers the most for its vertex count, and says how much it misses.
export function convexHull(xyz: Float64Array, maxVertices = Infinity): Hull | undefined {
  const n = xyz.length / 3;
  if (n < 4) return undefined;
  const P = (i: number) => [xyz[i * 3], xyz[i * 3 + 1], xyz[i * 3 + 2]];
  const b = boundsOf(xyz)!;
  const eps = 1e-7 * Math.max(...b.size, 1e-12);
  // The first tetrahedron: the two extreme points farthest apart, the point
  // farthest from their line, the point farthest from their plane.
  const ext: number[] = [];
  for (let a = 0; a < 3; a++) {
    let lo = 0;
    let hi = 0;
    for (let i = 1; i < n; i++) {
      if (xyz[i * 3 + a] < xyz[lo * 3 + a]) lo = i;
      if (xyz[i * 3 + a] > xyz[hi * 3 + a]) hi = i;
    }
    ext.push(lo, hi);
  }
  let i0 = ext[0];
  let i1 = ext[1];
  let best = -1;
  for (const p of ext) for (const q of ext) if (len(sub(P(p), P(q))) > best) [i0, i1, best] = [p, q, len(sub(P(p), P(q)))];
  if (best <= eps) return undefined;
  const dir = unit(sub(P(i1), P(i0)));
  let i2 = -1;
  best = eps;
  for (let i = 0; i < n; i++) {
    const v = sub(P(i), P(i0));
    const d = len(cross(v, dir));
    if (d > best) [i2, best] = [i, d];
  }
  if (i2 < 0) return undefined;
  const pn = unit(cross(sub(P(i1), P(i0)), sub(P(i2), P(i0))));
  let i3 = -1;
  best = eps;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(dot(sub(P(i), P(i0)), pn));
    if (d > best) [i3, best] = [i, d];
  }
  if (i3 < 0) return undefined;

  interface Face {
    v: [number, number, number];
    normal: Vec;
    offset: number;
    outside: number[];
    far: number;
    farDist: number;
    alive: boolean;
  }
  const faces: Face[] = [];
  const edges = new Map<number, number>(); // directed edge u -> v, as u * n + v, to the face that has it
  const dist = (f: Face, i: number) => dot(f.normal, P(i)) - f.offset;
  // How many live faces use each point: a hull vertex can fall inside when
  // a later point is added, so the vertex count is kept, not assumed.
  const uses = new Int32Array(n);
  let count = 0;
  const use = (v: number, by: number) => {
    if (by > 0 && uses[v] === 0) count++;
    uses[v] += by;
    if (by < 0 && uses[v] === 0) count--;
  };
  const addFace = (a: number, bb: number, c: number) => {
    for (const v of [a, bb, c]) use(v, 1);
    const normal = unit(cross(sub(P(bb), P(a)), sub(P(c), P(a))));
    const f: Face = { v: [a, bb, c], normal, offset: dot(normal, P(a)), outside: [], far: -1, farDist: 0, alive: true };
    const id = faces.push(f) - 1;
    edges.set(a * n + bb, id);
    edges.set(bb * n + c, id);
    edges.set(c * n + a, id);
    return id;
  };
  const centre = mean([P(i0), P(i1), P(i2), P(i3)]);
  for (const [a, bb, c] of [[i0, i1, i2], [i0, i1, i3], [i0, i2, i3], [i1, i2, i3]]) {
    const normal = cross(sub(P(bb), P(a)), sub(P(c), P(a)));
    if (dot(normal, sub(centre, P(a))) > 0) addFace(a, c, bb);
    else addFace(a, bb, c);
  }
  const assign = (points: Iterable<number>, ids: number[]) => {
    for (const i of points) {
      for (const id of ids) {
        const f = faces[id];
        const d = dist(f, i);
        if (d > eps) {
          f.outside.push(i);
          if (d > f.farDist) [f.far, f.farDist] = [i, d];
          break;
        }
      }
    }
  };
  const used = new Set([i0, i1, i2, i3]);
  assign(Array.from({ length: n }, (_, i) => i).filter(i => !used.has(i)), [0, 1, 2, 3]);
  for (let guard = 0; guard < n; guard++) {
    let pick = -1;
    for (let id = 0; id < faces.length; id++) if (faces[id].alive && faces[id].far >= 0 && (pick < 0 || faces[id].farDist > faces[pick].farDist)) pick = id;
    if (pick < 0 || count >= maxVertices) break;
    const eye = faces[pick].far;
    // The faces the eye sees, found across shared edges from the first, and
    // the horizon: their edges whose other face it does not see.
    const visible = new Set([pick]);
    const stack = [pick];
    const horizon: [number, number][] = [];
    while (stack.length) {
      const id = stack.pop()!;
      const [a, bb, c] = faces[id].v;
      for (const [u, v] of [[a, bb], [bb, c], [c, a]]) {
        const other = edges.get(v * n + u);
        if (other === undefined) continue;
        if (visible.has(other)) continue;
        if (dist(faces[other], eye) > eps) {
          visible.add(other);
          stack.push(other);
        }
      }
    }
    for (const id of visible) {
      const [a, bb, c] = faces[id].v;
      for (const [u, v] of [[a, bb], [bb, c], [c, a]]) {
        const other = edges.get(v * n + u);
        if (other !== undefined && !visible.has(other)) horizon.push([u, v]);
      }
    }
    const orphans: number[] = [];
    for (const id of visible) {
      const f = faces[id];
      f.alive = false;
      const [a, bb, c] = f.v;
      for (const v of f.v) use(v, -1);
      for (const [u, v] of [[a, bb], [bb, c], [c, a]]) if (edges.get(u * n + v) === id) edges.delete(u * n + v);
      for (const i of f.outside) if (i !== eye) orphans.push(i);
      f.outside = [];
    }
    const made = horizon.map(([u, v]) => addFace(u, v, eye));
    assign(orphans, made);
  }
  const alive = faces.filter(f => f.alive);
  const keep = [...new Set(alive.flatMap(f => f.v))];
  const index = new Map(keep.map((v, i) => [v, i]));
  let volume = 0;
  for (const f of alive) volume += dot(P(f.v[0]), cross(P(f.v[1]), P(f.v[2]))) / 6;
  return { vertices: keep.map(P), faces: alive.map(f => f.v.map(v => index.get(v)!)), volume, outside: Math.max(0, ...alive.map(f => f.farDist)) };
}

// Ritter's sphere (1990), then shrunk towards the box's centre if that is
// tighter: within a few percent of the smallest sphere, which is enough for
// a broad-phase shape.
function boundingSphere(xyz: Float64Array, b: Bounds): { center: Vec; radius: number } {
  const n = xyz.length / 3;
  const P = (i: number) => [xyz[i * 3], xyz[i * 3 + 1], xyz[i * 3 + 2]];
  const farFrom = (p: Vec) => {
    let k = 0;
    let d = -1;
    for (let i = 0; i < n; i++) {
      const e = len(sub(P(i), p));
      if (e > d) [k, d] = [i, e];
    }
    return k;
  };
  const a = farFrom(P(0));
  const c = farFrom(P(a));
  let center = mean([P(a), P(c)]);
  let radius = len(sub(P(a), P(c))) / 2;
  for (let i = 0; i < n; i++) {
    const p = P(i);
    const d = len(sub(p, center));
    if (d > radius) {
      const r = (radius + d) / 2;
      center = center.map((v, k) => v + ((p[k] - v) * (r - radius)) / d);
      radius = r;
    }
  }
  let boxR = 0;
  for (let i = 0; i < n; i++) boxR = Math.max(boxR, len(sub(P(i), b.center)));
  return boxR < radius ? { center: b.center, radius: boxR } : { center, radius };
}

// A capsule standing on Y around (x, z) with radius r, and the shortest
// segment for it to hold every point: a point d from the axis is inside
// while its height is within sqrt(r^2 - d^2) of the segment.
function capsuleAround(xyz: Float64Array, x: number, z: number, r: number, bottomY: number, topY: number, all: boolean) {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < xyz.length; i += 3) {
    const d = Math.hypot(xyz[i] - x, xyz[i + 2] - z);
    if (d > r) continue;
    const reach = Math.sqrt(Math.max(0, r * r - d * d));
    hi = Math.max(hi, xyz[i + 1] - reach);
    lo = Math.min(lo, xyz[i + 1] + reach);
  }
  if (!all) [lo, hi] = [bottomY + r, topY - r];
  if (!(hi >= lo)) lo = hi = (bottomY + topY) / 2;
  const height = hi - lo + 2 * r;
  return { center: [x, (lo + hi) / 2, z], radius: r, height, cylinder: hi - lo };
}

const fmt = (v: number) => String(round(v, 4));
const v3 = (prefix: string, v: Vec) => `${prefix}(${v.map(fmt).join(", ")})`;

export function collide(m: Loaded, maxVertices: number) {
  const j = m.json;
  const g = sceneGraph(j);
  const w = worldMatrices(j, g);
  const pts = meshPoints(m, g, w);
  const b = boundsOf(pts.xyz);
  if (!b) return undefined;
  const xyz = pts.xyz;
  const xs: number[] = [];
  const zs: number[] = [];
  for (let i = 0; i < xyz.length; i += 3) xs.push(xyz[i]), zs.push(xyz[i + 2]);
  const circle = enclosingCircle(xs, zs);
  const capsule = capsuleAround(xyz, circle.x, circle.z, Math.min(circle.r, Math.max(b.size[1], 1e-9)), b.min[1], b.max[1], true);
  // A character controller's capsule: as tall as the model, as wide as its
  // body. It stands on the median vertex (the body has most of them, so a
  // held weapon does not pull it aside), and its radius is the median, over
  // ten slices from 10% to 90% of the height, of the distance that holds 90%
  // of each slice: arms held out (a T-pose) or a sword fill only a few
  // slices, so they are left out, as a character controller wants.
  const cx = median(xs);
  const cz = median(zs);
  const slices: number[][] = Array.from({ length: 10 }, () => []);
  for (let i = 0; i < xyz.length; i += 3) {
    const f = (xyz[i + 1] - b.min[1]) / (b.size[1] || 1);
    if (f >= 0.1 && f < 0.9) slices[Math.min(9, Math.floor((f - 0.1) * 12.5))].push(Math.hypot(xyz[i] - cx, xyz[i + 2] - cz));
  }
  const widths = slices.filter(sl => sl.length).map(sl => sl.sort((p, q) => p - q)[Math.floor(0.9 * (sl.length - 1))]);
  const coreR = Math.min(widths.length ? median(widths) : circle.r, b.size[1] / 2);
  const core = capsuleAround(xyz, cx, cz, coreR, b.min[1], b.max[1], false);
  const sphere = boundingSphere(xyz, b);
  const hull = convexHull(xyz, maxVertices);
  const notes: string[] = [];
  if (pts.skinned) notes.push("Skinned: the shapes fit the rest (bind) pose, not any frame of an animation; limbs that swing out leave them.");
  const tallest = [0, 1, 2].reduce((p, q) => (b.size[q] > b.size[p] ? q : p), 1);
  if (tallest !== 1) notes.push(`It is longest along ${AXES[tallest]}, not Y: the capsules stand on Y, glTF's up, as engines import it.`);
  if (!hull) notes.push("Flat: it has no volume, so no convex hull.");
  if (hull && hull.outside > 0) notes.push(`The hull stops at ${hull.vertices.length} vertices (--max-vertices); the farthest point it leaves out is ${round(hull.outside, 4)} outside it.`);

  const box = { center: rv(b.center), size: rv(b.size) };
  const sph = { center: rv(sphere.center), radius: round(sphere.radius) };
  const cap = (c: ReturnType<typeof capsuleAround>) => ({ axis: "Y", center: rv(c.center), radius: round(c.radius), height: round(c.height), cylinder: round(c.cylinder) });
  const hullOut = hull ? { vertices: hull.vertices.map(v => rv(v)), triangles: hull.faces.length, volume: round(hull.volume, 6), outside: round(hull.outside) } : undefined;
  // Unity's glTF importers (glTFast, UnityGLTF) flip X for its left-handed
  // axes, so a centre's x changes sign there; Godot and three.js keep glTF's.
  const ux = (v: Vec) => [-v[0], v[1], v[2]];
  const ctr = cap(core);
  const godot = {
    capsule: `var shape := CapsuleShape3D.new()\nshape.radius = ${fmt(core.radius)}\nshape.height = ${fmt(core.height)}\n$CollisionShape3D.shape = shape\n$CollisionShape3D.position = ${v3("Vector3", core.center)}`,
    box: `var shape := BoxShape3D.new()\nshape.size = ${v3("Vector3", b.size)}\n$CollisionShape3D.shape = shape\n$CollisionShape3D.position = ${v3("Vector3", b.center)}`,
    sphere: `var shape := SphereShape3D.new()\nshape.radius = ${fmt(sphere.radius)}\n$CollisionShape3D.shape = shape\n$CollisionShape3D.position = ${v3("Vector3", sphere.center)}`,
    ...(hull ? { hull: `var shape := ConvexPolygonShape3D.new()\nshape.points = PackedVector3Array([${hull.vertices.map(v => v3("Vector3", v)).join(", ")}])\n$CollisionShape3D.shape = shape` } : {})
  };
  const unity = {
    capsule: `var c = gameObject.AddComponent<CapsuleCollider>();\nc.direction = 1; // Y\nc.radius = ${fmt(core.radius)}f;\nc.height = ${fmt(core.height)}f;\nc.center = new Vector3(${ux(core.center).map(v => `${fmt(v)}f`).join(", ")});`,
    character_controller: `var cc = gameObject.AddComponent<CharacterController>();\ncc.radius = ${fmt(core.radius)}f;\ncc.height = ${fmt(core.height)}f;\ncc.center = new Vector3(${ux(core.center).map(v => `${fmt(v)}f`).join(", ")});`,
    box: `var c = gameObject.AddComponent<BoxCollider>();\nc.size = new Vector3(${b.size.map(v => `${fmt(v)}f`).join(", ")});\nc.center = new Vector3(${ux(b.center).map(v => `${fmt(v)}f`).join(", ")});`,
    sphere: `var c = gameObject.AddComponent<SphereCollider>();\nc.radius = ${fmt(sphere.radius)}f;\nc.center = new Vector3(${ux(sphere.center).map(v => `${fmt(v)}f`).join(", ")});`,
    hull: "var c = gameObject.AddComponent<MeshCollider>();\nc.convex = true; // Unity builds its own hull from the mesh, at most 255 triangles"
  };
  const three = {
    capsule: `const capsule = new THREE.Mesh(new THREE.CapsuleGeometry(${fmt(core.radius)}, ${fmt(core.cylinder)}), material);\ncapsule.position.set(${core.center.map(fmt).join(", ")});`,
    box: `const box = new THREE.Mesh(new THREE.BoxGeometry(${b.size.map(fmt).join(", ")}), material);\nbox.position.set(${b.center.map(fmt).join(", ")});`,
    sphere: `const sphere = new THREE.Mesh(new THREE.SphereGeometry(${fmt(sphere.radius)}), material);\nsphere.position.set(${sphere.center.map(fmt).join(", ")});`,
    ...(hull ? { hull: `import { ConvexGeometry } from "three/addons/geometries/ConvexGeometry.js";\nconst hull = new THREE.Mesh(new ConvexGeometry(${JSON.stringify(hull.vertices.map(v => rv(v)))}.map(p => new THREE.Vector3(...p))), material);` } : {})
  };
  return {
    pose: pts.skinned ? "rest (bind) pose" : "as the scene draws it",
    vertices: xyz.length / 3,
    box,
    sphere: sph,
    capsule: ctr,
    capsule_all: cap(capsule),
    ...(hullOut ? { hull: hullOut } : {}),
    godot,
    unity,
    three,
    notes
  };
}

// ---- The tools

const usage = (message: string) => new CliError(message, EXIT.USAGE);
const one = (call: ToolCall, line: string) => {
  if (call.args.length !== 1) throw usage(`Usage: ${line}`);
  return call.args[0];
};
const sayHint = (ctx: Ctx, next: Hint) => {
  if (!ctx.globals.quiet) process.stderr.write(`Next: ${next.text}: ${next.command}\n`);
};
const withHint = (ctx: Ctx, body: Record<string, unknown>, next: Hint) => ({ ...body, ...(ctx.globals.quiet ? {} : { hint: next }) });

TOOLS.push({
  group: "model",
  name: "orient",
  args: "<model>",
  summary: "Which way a model stands and faces, where its origin is and how big it is, and what to set in Godot, Unity and Unreal",
  details: [
    "Up is checked against glTF's +Y (from the rig's head and feet, else the mesh's tallest side). The",
    "front, against glTF's +Z: from the rig (toes ahead of the ankles, the left foot on the left), else",
    "from the mesh's mirror symmetry and its feet, with a confidence. The origin is placed against the",
    "bounds, with the lift that puts the lowest point on the floor; the height comes with a unit guess.",
    "It reports and advises: the model is never changed."
  ],
  flags: [],
  async run(ctx, call) {
    const file = one(call, "ludo toolbox model orient <model.glb>");
    const m = loadModel(file);
    const r = readable(file, () => orient(m));
    if (!r) throw new CliError(`${shown(file)} has no mesh or skeleton to measure`, EXIT.BAD_INPUT, "Check it with ludo toolbox model info.");
    const rigged = r.rig.joints > 0 && !!m.json.skins?.length;
    const next =
      r.forward.confidence === "none" || (!rigged && r.forward.confidence === "low")
        ? hint("Rig it with Ludo; the rig tells its front", `ludo model rig --model ${shown(file)}`)
        : m.json.meshes?.length
          ? hint("Fit its physics shapes", `ludo toolbox model collide ${shown(file)}`)
          : hint("Check its clips: loop seam, root motion and foot contacts", `ludo toolbox model clips ${shown(file)}`);
    if (ctx.jsonOut) {
      printJson(withHint(ctx, { model: shown(file), ...r }, next), false);
      return EXIT.OK;
    }
    const u = r.size.unit_guess;
    const lines = [
      `${shown(file)}: ${r.size.height} tall, ${r.size.width} wide, ${r.size.depth} deep (${u.unit === "normalised" ? "a normalised size" : u.unit === "m" ? "metres" : `${u.unit}, x${u.to_metres} to metres`})`,
      `  Up       ${r.up.axis}${r.up.matches_gltf ? " (glTF's up)" : ", not glTF's +Y"}: ${r.up.confidence} confidence, ${r.up.from}`,
      `  Front    ${r.forward.axis}${r.forward.matches_gltf ? " (glTF's front)" : ""}: ${r.forward.confidence === "none" ? "no" : r.forward.confidence} confidence, ${r.forward.from}`,
      `  Origin   ${r.origin.at}${r.origin.centred ? ", centred" : `, ${r.origin.horizontal_offset[0]}, ${r.origin.horizontal_offset[2]} off centre (x, z)`}${r.origin.ground_offset ? `; raise it ${r.origin.ground_offset} to stand on the floor` : ""}`,
      `  Units    ${u.why}`,
      "",
      ...(["godot", "unity", "unreal"] as const).flatMap(e => [`${e === "godot" ? "Godot" : e === "unity" ? "Unity" : "Unreal"}:`, ...r.engines[e].map(l => `  ${l}`)]),
      ...r.notes.map(n => `Note: ${n}`)
    ];
    process.stdout.write(lines.join("\n") + "\n");
    sayHint(ctx, next);
    return EXIT.OK;
  }
});

TOOLS.push({
  group: "model",
  name: "clips",
  args: "<model>",
  summary: "Each animation's length, keys, loop seam, root motion and foot contacts, and the move speed that keeps feet from sliding",
  details: [
    "Reads the samplers from the file and runs the skeleton through them. The loop seam compares the last",
    "pose with the first on every joint's rotation, against a step between keys. Root motion is how far",
    "the top moved joint travels on the ground, and whether the clip is in place. Foot contacts are when",
    "each foot's lowest joint is down and still; a walk or run then gets the speed that matches its feet",
    "(stride over cycle): from root motion when it travels, from how fast planted feet slide when in place.",
    "Lengths are in the model's units (metres, if it is in metres)."
  ],
  flags: [{ flag: "--clip", value: "name|index", description: "Only this animation" }],
  async run(ctx, call) {
    const file = one(call, "ludo toolbox model clips <model.glb> [--clip <name>]");
    const only = textFlag(call, "--clip");
    if (call.flags.has("--clip") && !only) throw usage("--clip takes an animation's name or index");
    const m = loadModel(file);
    if (!m.json.animations?.length) {
      throw new CliError(
        `${shown(file)} has no animations`,
        EXIT.BAD_INPUT,
        m.json.skins?.length ? `Animate it with Ludo: ludo model animate --model ${shown(file)} --prompt "<what it does>"` : `Rig it with Ludo first: ludo model rig --model ${shown(file)}`
      );
    }
    const r = readable(file, () => clips(m, only));
    if (!r.clips.length) throw usage(`${shown(file)} has no animation "${only}"; it has ${(m.json.animations ?? []).map((a, i) => a.name || String(i)).join(", ")}`);
    const pop = r.clips.find(c => c.loop && /pop|does not loop/.test(c.loop.verdict));
    const travels = r.clips.find(c => c.root_motion && c.root_motion.in_place === false && /walk|run|jog|sprint|strafe|locomot/i.test(c.name));
    const still = r.clips.find(c => c.note?.startsWith("nothing moves"));
    const next = still
      ? hint("It does not move; ask Ludo for another take", `ludo model animate --model <rigged model> --prompt "<what it does>"`)
      : travels
      ? hint("For engine-driven movement, ask Ludo for it in place", `ludo model animate-preset --model <rigged model> --preset-id <id> --in-place`)
      : pop
        ? hint("For a clean loop, ask Ludo to crop it to its looping span", `ludo model animate-preset --model <rigged model> --preset-id <id> --crop-loop`)
        : m.json.meshes?.length
          ? hint("Size the character's capsule", `ludo toolbox model collide ${shown(file)}`)
          : hint("Size the character's capsule from the rigged model", "ludo toolbox model collide <rigged model>");
    if (ctx.jsonOut) {
      printJson(withHint(ctx, { model: shown(file), ...r }, next), false);
      return EXIT.OK;
    }
    const lines = [`${shown(file)}: ${r.clips.length} animation${r.clips.length === 1 ? "" : "s"}, ${r.joints} joints${r.feet.length ? `, feet ${r.feet.map(f => `${f.foot} (${f.joints.join(" > ")})`).join(", ")}` : ", no feet found"}`];
    for (const c of r.clips) {
      lines.push("", `${c.name}: ${c.duration} s, ${c.keyframes} keys${c.fps ? ` (${c.fps} fps)` : ""}`);
      if ("note" in c) {
        lines.push(`  ${c.note}`);
        continue;
      }
      if (c.loop) lines.push(`  Loop     ${c.loop.verdict} (mean jump ${c.loop.seam_deg}°; worst ${c.loop.worst_jump_deg}° on ${c.loop.worst_joint}, whose step there is ${c.loop.worst_step_deg}°)`);
      if (c.root_motion) {
        const rm = c.root_motion;
        lines.push(`  Root     ${rm.in_place ? `in place (${rm.distance} drift on ${rm.joint})` : `travels ${rm.distance} along ${rm.axis} at ${rm.speed} units/s (${rm.joint})`}; bobs ${rm.vertical_range}`);
      }
      for (const f of c.feet ?? []) lines.push(`  ${`${f.foot}`.padEnd(8)} ${f.contacts.length ? f.contacts.map(k => `down ${k.start}-${k.end} s`).join(", ") : "never down"}`);
      if (c.move_speed) {
        const ms = c.move_speed;
        lines.push(`  Speed    move at ${ms.speed} units/s${ms.axis ? ` along ${ms.axis}` : ""}${ms.stride ? ` (stride ${ms.stride} per ${ms.cycle_seconds} s cycle)` : ""}: ${ms.from}${ms.note ? `; ${ms.note}` : ""}`);
      }
    }
    process.stdout.write(lines.join("\n") + "\n");
    sayHint(ctx, next);
    return EXIT.OK;
  }
});

TOOLS.push({
  group: "model",
  name: "collide",
  args: "<model>",
  summary: "Physics shapes for a model: box, sphere, a standing capsule and a convex hull, with Godot, Unity and three.js code",
  details: [
    "The box and sphere hold every vertex. The capsule stands on Y (glTF's up), as tall as the model and",
    "as wide as its body (the median width of its height slices), so arms held out and held weapons are",
    "left out, as a character controller wants; capsule_all holds every vertex. The hull is a quickhull",
    "capped at --max-vertices.",
    "Skinned meshes are measured in their rest (bind) pose. Unity's importers flip X, so its centres do."
  ],
  flags: [{ flag: "--max-vertices", value: "n", description: "Most vertices for the convex hull (default 64; Unity's own hull stops at 255 triangles)" }],
  async run(ctx, call) {
    const file = one(call, "ludo toolbox model collide <model.glb> [--max-vertices 64]");
    const max = positiveInt(call, "--max-vertices") ?? 64;
    if (max < 4) throw usage("--max-vertices must be 4 or more: a hull needs a tetrahedron");
    const m = loadModel(file);
    const r = readable(file, () => collide(m, max));
    if (!r) throw new CliError(`${shown(file)} has no mesh to fit shapes to`, EXIT.BAD_INPUT, m.json.animations?.length ? "It is animation only; run this on the rigged model the clip is for." : "Check it with ludo toolbox model info.");
    const next = hint("Check which way it faces and where its origin is", `ludo toolbox model orient ${shown(file)}`);
    if (ctx.jsonOut) {
      printJson(withHint(ctx, { model: shown(file), ...r }, next), false);
      return EXIT.OK;
    }
    const lines = [
      `${shown(file)}: ${r.vertices} vertices, ${r.pose}`,
      `  Box      size ${r.box.size.join(" x ")} at ${r.box.center.join(", ")}`,
      `  Sphere   radius ${r.sphere.radius} at ${r.sphere.center.join(", ")}`,
      `  Capsule  radius ${r.capsule.radius}, height ${r.capsule.height} at ${r.capsule.center.join(", ")} (holding everything: radius ${r.capsule_all.radius}, height ${r.capsule_all.height})`,
      ...(r.hull ? [`  Hull     ${r.hull.vertices.length} vertices, ${r.hull.triangles} triangles, volume ${r.hull.volume}`] : []),
      "",
      "Godot:",
      ...r.godot.capsule.split("\n").map(l => `  ${l}`),
      "Unity:",
      ...r.unity.capsule.split("\n").map(l => `  ${l}`),
      "three.js:",
      ...r.three.capsule.split("\n").map(l => `  ${l}`),
      "(--json has the box, sphere and hull for each)",
      ...r.notes.map(n => `Note: ${n}`)
    ];
    process.stdout.write(lines.join("\n") + "\n");
    sayHint(ctx, next);
    return EXIT.OK;
  }
});
