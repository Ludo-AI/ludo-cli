// `ludo toolbox model orient|clips|collide` on GLBs built here with known
// answers: a box, a capsule with arms held out, a stick biped standing and
// turned, a two-key root-motion clip, a walk in place, a skinned mesh whose
// joints moved, and the CLI's JSON, hints and errors.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readAccessor, readGltf } from "../dist/toolbox/model.js";
import { clips, collide, convexHull, orient, sampleChannel } from "../dist/toolbox/model-analysis.js";

const exec = promisify(execFile);
const CLI = path.join(import.meta.dirname, "..", "dist", "cli.js");
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-model-analysis-"));
const TYPES = { 1: "SCALAR", 2: "VEC2", 3: "VEC3", 4: "VEC4", 16: "MAT4" };
const KIND = { Float32Array: 5126, Uint16Array: 5123, Uint8Array: 5121, Int16Array: 5122, Uint32Array: 5125 };

// A GLB from glTF JSON and its data: `data` lists [typedArray, components,
// extra accessor fields]; accessor i is data[i], each in its own buffer view.
function glb(json, data) {
  const pad = n => (4 - (n % 4)) % 4;
  const chunks = [];
  let offset = 0;
  json.bufferViews = [];
  json.accessors = data.map(([arr, size, extra = {}], i) => {
    const bytes = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
    json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, ...(extra.byteStride ? { byteStride: extra.byteStride } : {}) });
    chunks.push(bytes, Buffer.alloc(pad(bytes.length)));
    offset += bytes.length + pad(bytes.length);
    const { byteStride, count, ...rest } = extra;
    const acc = { bufferView: i, componentType: KIND[arr.constructor.name], count: count ?? arr.length / size, type: TYPES[size], ...rest };
    if (size === 3 && arr instanceof Float32Array && !byteStride) {
      acc.min = [0, 1, 2].map(k => Math.min(...arr.filter((_, j) => j % 3 === k)));
      acc.max = [0, 1, 2].map(k => Math.max(...arr.filter((_, j) => j % 3 === k)));
    }
    if (size === 1 && arr instanceof Float32Array) {
      acc.min = [Math.min(...arr)];
      acc.max = [Math.max(...arr)];
    }
    return acc;
  });
  const bin = Buffer.concat(chunks);
  json.buffers = [{ byteLength: bin.length }];
  json.asset = { version: "2.0", generator: "ludo test" };
  let text = Buffer.from(JSON.stringify(json));
  text = Buffer.concat([text, Buffer.alloc(pad(text.length), 0x20)]);
  const chunk = (type, d) => {
    const h = Buffer.alloc(8);
    h.writeUInt32LE(d.length, 0);
    h.writeUInt32LE(type, 4);
    return Buffer.concat([h, d]);
  };
  const header = Buffer.alloc(12);
  header.write("glTF", 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + text.length + 8 + bin.length, 8);
  return Buffer.concat([header, chunk(0x4e4f534a, text), chunk(0x004e4942, bin)]);
}

const save = (name, bytes) => {
  const file = path.join(DIR, name);
  fs.writeFileSync(file, bytes);
  return file;
};
const load = file => readGltf(fs.readFileSync(file), file);
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} is not within ${tol} of ${b}`);

// A box from (lo) to (hi): 8 corners, 12 triangles.
function boxMesh(lo, hi) {
  const p = [];
  for (let k = 0; k < 8; k++) p.push(k & 1 ? hi[0] : lo[0], k & 2 ? hi[1] : lo[1], k & 4 ? hi[2] : lo[2]);
  const idx = [0, 2, 1, 1, 2, 3, 4, 5, 6, 5, 7, 6, 0, 1, 4, 1, 5, 4, 2, 6, 3, 3, 6, 7, 0, 4, 2, 2, 4, 6, 1, 3, 5, 3, 7, 5];
  return { positions: new Float32Array(p), indices: new Uint16Array(idx) };
}

const meshJson = (extra = {}) => ({
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ mesh: 0, ...extra }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }]
});

test("readAccessor reads strides, normalized integers and sparse substitutions", () => {
  // Two VEC3 floats interleaved with a padding float (stride 16), normalized
  // unsigned bytes, and a sparse accessor over zeros.
  const interleaved = new Float32Array([1, 2, 3, 99, 4, 5, 6, 99]);
  const bytes = new Uint8Array([0, 255, 51, 0]);
  const sparseIdx = new Uint16Array([2, 0]);
  const sparseVal = new Float32Array([7, 8]);
  const json = { scene: 0, scenes: [{ nodes: [] }], nodes: [] };
  const file = save("accessors.glb", glb(json, [[interleaved, 3, { byteStride: 16, count: 2 }], [bytes, 4, { normalized: true }], [sparseIdx, 1], [sparseVal, 1]]));
  const m = load(file);
  // A sparse accessor with no buffer view of its own.
  m.json.accessors.push({ componentType: 5126, count: 4, type: "SCALAR", sparse: { count: 2, indices: { bufferView: 2, componentType: 5123 }, values: { bufferView: 3 } } });
  assert.deepEqual(Array.from(readAccessor(m, 0).values), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(Array.from(readAccessor(m, 1).values, v => +v.toFixed(3)), [0, 1, 0.2, 0]);
  assert.deepEqual(Array.from(readAccessor(m, 4).values), [8, 0, 7, 0]);
});

test("sampleChannel: STEP holds, LINEAR slerps, CUBICSPLINE follows its tangents", () => {
  const times = new Float32Array([0, 1]);
  const s = Math.SQRT1_2;
  const rot = { times, values: new Float32Array([0, 0, 0, 1, 0, s, 0, s]), size: 4, path: "rotation" };
  const half = sampleChannel({ ...rot, interp: "LINEAR" }, 0.5);
  near(2 * Math.acos(half[3]) * (180 / Math.PI), 45, 1e-4, "slerp halfway to 90 degrees");
  assert.deepEqual(sampleChannel({ ...rot, interp: "STEP" }, 0.99), [0, 0, 0, 1]);
  // Hermite from 0 to 1 with zero tangents is smoothstep: 0.5 at the middle, 0.15625 at a quarter.
  const cubic = { times, values: new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0]), size: 3, path: "translation", interp: "CUBICSPLINE" };
  near(sampleChannel(cubic, 0.5)[1], 0.5, 1e-6, "cubic middle");
  near(sampleChannel(cubic, 0.25)[1], 0.15625, 1e-6, "cubic quarter");
});

test("collide: a moved box gets its exact box, sphere and an 8-vertex hull", () => {
  const { positions, indices } = boxMesh([0, 0, 0], [2, 4, 1]);
  const file = save("box.glb", glb(meshJson({ translation: [1, 0, -0.5] }), [[positions, 3], [indices, 1]]));
  const r = collide(load(file), 64);
  assert.deepEqual(r.box, { center: [2, 2, 0], size: [2, 4, 1] });
  near(r.sphere.radius, Math.hypot(2, 4, 1) / 2, 1e-4, "sphere radius");
  assert.deepEqual(r.sphere.center, [2, 2, 0]);
  assert.equal(r.hull.vertices.length, 8);
  assert.equal(r.hull.triangles, 12);
  near(r.hull.volume, 8, 1e-6, "hull volume");
  assert.equal(r.hull.outside, 0);
  assert.equal(r.pose, "as the scene draws it");
  // The capsule holding everything does hold every corner.
  const c = r.capsule_all;
  for (let k = 0; k < 8; k++) {
    const p = [k & 1 ? 3 : 1, k & 2 ? 4 : 0, k & 4 ? 0.5 : -0.5];
    const y = Math.min(Math.max(p[1], c.center[1] - c.cylinder / 2), c.center[1] + c.cylinder / 2);
    assert.ok(Math.hypot(p[0] - c.center[0], p[1] - y, p[2] - c.center[2]) <= c.radius + 1e-3, `corner ${k} is outside capsule_all`);
  }
  // Godot and three.js keep glTF's axes; Unity's importers flip X.
  assert.match(r.godot.box, /shape\.size = Vector3\(2, 4, 1\)/);
  assert.match(r.unity.box, /c\.center = new Vector3\(-2f, 2f, 0f\)/);
  assert.match(r.three.box, /BoxGeometry\(2, 4, 1\)/);
});

test("collide: a capsule-shaped body with arms held out gets a body-wide capsule", () => {
  // Rings of radius 0.3 from y 0.3 to 1.5, hemispheres closing them at 0 and
  // 1.8, and a flat T-pose "arm" plank across x at shoulder height.
  const p = [];
  for (let y = 0.3; y <= 1.5001; y += 0.05) for (let a = 0; a < 32; a++) p.push(0.3 * Math.cos((a * Math.PI) / 16), y, 0.3 * Math.sin((a * Math.PI) / 16));
  for (let e = 1; e <= 8; e++) {
    const phi = (e * Math.PI) / 16;
    for (let a = 0; a < 32; a++) {
      const r = 0.3 * Math.cos(phi);
      const h = 0.3 * Math.sin(phi);
      p.push(r * Math.cos((a * Math.PI) / 16), 1.5 + h, r * Math.sin((a * Math.PI) / 16));
      p.push(r * Math.cos((a * Math.PI) / 16), 0.3 - h, r * Math.sin((a * Math.PI) / 16));
    }
  }
  for (let x = -0.9; x <= 0.9001; x += 0.05) for (const z of [-0.05, 0.05]) p.push(x, 1.35, z), p.push(x, 1.4, z);
  const n = p.length / 3;
  const idx = [];
  for (let i = 0; i + 2 < n; i += 3) idx.push(i, i + 1, i + 2);
  const file = save("capsule.glb", glb(meshJson(), [[new Float32Array(p), 3], [new Uint16Array(idx), 1]]));
  const r = collide(load(file), 64);
  near(r.capsule.radius, 0.3, 0.01, "body capsule radius");
  near(r.capsule.height, 1.8, 0.01, "body capsule height");
  near(r.capsule.center[1], 0.9, 0.01, "body capsule centre");
  assert.ok(r.capsule_all.radius >= 0.9, `capsule_all must reach the arms (${r.capsule_all.radius})`);
  assert.match(r.godot.capsule, /shape\.radius = 0\.[23]\d*\nshape\.height = 1\.8/);
  assert.match(r.three.capsule, /CapsuleGeometry\(0\.[23]\d*, 1\.[12]\d*\)/);
});

test("convexHull: points inside a cube leave its 8 corners; a cap leaves the farthest points", () => {
  const p = [];
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 500; i++) p.push(rnd(), rnd(), rnd());
  for (let k = 0; k < 8; k++) p.push(k & 1 ? 1.5 : -0.5, k & 2 ? 1.5 : -0.5, k & 4 ? 1.5 : -0.5);
  const full = convexHull(new Float64Array(p));
  assert.equal(full.vertices.length, 8);
  near(full.volume, 8, 1e-9, "cube volume");
  // On a sphere every point is a hull vertex; capped, it keeps the count and says what it misses.
  const s = [];
  for (let i = 0; i < 300; i++) {
    const zz = 1 - (2 * (i + 0.5)) / 300;
    const r = Math.sqrt(1 - zz * zz);
    s.push(r * Math.cos(i * 2.39996), r * Math.sin(i * 2.39996), zz);
  }
  const sphere = convexHull(new Float64Array(s));
  assert.equal(sphere.vertices.length, 300);
  assert.equal(sphere.faces.length, 2 * 300 - 4);
  near(sphere.volume, (4 / 3) * Math.PI, 0.1, "sphere volume");
  const capped = convexHull(new Float64Array(s), 20);
  assert.equal(capped.vertices.length, 20);
  assert.ok(capped.outside > 0 && capped.outside < 0.5, `capped hull misses by ${capped.outside}`);
  assert.equal(convexHull(new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0])), undefined, "a flat set has no hull");
});

// A stick biped 1.8 tall (head at 1.75, ankles 0.1 up, toes on the floor 0.15
// ahead): `turn` turns it about Y, `scale` scales it (100 = centimetres), and
// `lift` moves its origin up from its feet. Its mesh is a box around it.
function biped({ turn = 0, scale = 1, lift = 0 } = {}) {
  const { positions, indices } = boxMesh([-0.25, 0, -0.15], [0.25, 1.8, 0.2]);
  const s = Math.sin(((turn / 2) * Math.PI) / 180);
  const c = Math.cos(((turn / 2) * Math.PI) / 180);
  const nodes = [
    { name: "Armature", children: [1, 2], rotation: [0, s, 0, c], scale: [scale, scale, scale], translation: [0, -lift * scale, 0] },
    { mesh: 0 },
    { name: "Hips", translation: [0, 1, 0], children: [3, 4, 6] },
    { name: "Head", translation: [0, 0.75, 0] },
    { name: "L_Ankle", translation: [0.1, -0.9, 0], children: [5] },
    { name: "L_Foot", translation: [0, -0.1, 0.15] },
    { name: "R_Ankle", translation: [-0.1, -0.9, 0], children: [7] },
    { name: "R_Foot", translation: [0, -0.1, 0.15] }
  ];
  return glb({ scene: 0, scenes: [{ nodes: [0] }], nodes, meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }], skins: [{ joints: [2, 3, 4, 5, 6, 7] }] }, [[positions, 3], [indices, 1]]);
}

test("orient: a standing biped facing +Z with its origin at its feet", () => {
  const r = orient(load(save("biped.glb", biped())));
  assert.equal(r.up.axis, "+Y");
  assert.equal(r.up.confidence, "high");
  assert.equal(r.forward.axis, "+Z");
  assert.equal(r.forward.confidence, "high");
  assert.equal(r.forward.matches_gltf, true);
  assert.equal(r.origin.at, "at the feet");
  assert.equal(r.origin.ground_offset, 0);
  assert.equal(r.size.height, 1.8);
  assert.deepEqual([r.size.unit_guess.unit, r.size.unit_guess.to_metres], ["m", 1]);
  assert.deepEqual(r.rig.feet, [{ foot: "left", joints: ["L_Ankle", "L_Foot"] }, { foot: "right", joints: ["R_Ankle", "R_Foot"] }]);
  assert.match(r.engines.godot[3], /Offset: none/);
});

test("orient: turned to face +X, in centimetres, origin at its middle", () => {
  const r = orient(load(save("biped-turned.glb", biped({ turn: 90, scale: 100, lift: 0.9 }))));
  assert.equal(r.forward.axis, "+X");
  assert.equal(r.forward.turn_to_front_deg, -90);
  assert.equal(r.forward.matches_gltf, false);
  assert.equal(r.origin.at, "at the centre");
  near(r.origin.ground_offset, 90, 1e-3, "ground offset");
  assert.deepEqual([r.size.unit_guess.unit, r.size.unit_guess.to_metres], ["cm", 0.01]);
  assert.match(r.engines.godot[1], /rotation_degrees\.y = -90/);
  assert.match(r.engines.unity[1], /local rotation Y = 90/);
  assert.match(r.engines.godot[3], /position\.y = 0\.9 /);
  assert.match(r.engines.unreal[3], /\+ 90 cm/);
});

test("orient: a mesh with no rig and no symmetry says it cannot tell its front", () => {
  // An L-shaped block: no mirror plane across X or Z.
  const a = boxMesh([0, 0, 0], [1, 3, 0.4]);
  const b = boxMesh([0, 0, 0], [0.4, 3, 1]);
  const positions = new Float32Array([...a.positions, ...b.positions]);
  const indices = new Uint16Array([...a.indices, ...Array.from(b.indices, i => i + 8)]);
  const r = orient(load(save("ell.glb", glb(meshJson(), [[positions, 3], [indices, 1]]))));
  assert.equal(r.forward.confidence, "none");
  assert.equal(r.up.axis, "+Y");
});

// A two-key clip: the hips glide 2 m along +Z in 2 s and the head turns
// `endTurn` degrees by the end.
function rootClip(endTurn, travel = 2) {
  const s = Math.sin(((endTurn / 2) * Math.PI) / 180);
  const c = Math.cos(((endTurn / 2) * Math.PI) / 180);
  const nodes = [
    { name: "Hips", translation: [0, 1, 0], children: [1, 2, 4] },
    { name: "Head", translation: [0, 0.75, 0] },
    { name: "L_Ankle", translation: [0.1, -0.9, 0], children: [3] },
    { name: "L_Foot", translation: [0, -0.1, 0.15] },
    { name: "R_Ankle", translation: [-0.1, -0.9, 0], children: [5] },
    { name: "R_Foot", translation: [0, -0.1, 0.15] }
  ];
  const animations = [
    {
      name: "glide",
      channels: [
        { sampler: 0, target: { node: 0, path: "translation" } },
        { sampler: 1, target: { node: 1, path: "rotation" } }
      ],
      samplers: [
        { input: 0, output: 1 },
        { input: 0, output: 2 }
      ]
    }
  ];
  return glb({ scene: 0, scenes: [{ nodes: [0] }], nodes, animations }, [
    [new Float32Array([0, 2]), 1],
    [new Float32Array([0, 1, 0, 0, 1, travel]), 3],
    [new Float32Array([0, 0, 0, 1, 0, s, 0, c]), 4]
  ]);
}

test("clips: a two-key root-motion clip travels 2 m along +Z at 1 m/s", () => {
  const r = clips(load(save("glide.glb", rootClip(0))));
  const c = r.clips[0];
  assert.deepEqual([c.name, c.duration, c.keyframes, c.fps], ["glide", 2, 2, 0.5]);
  assert.deepEqual([c.root_motion.joint, c.root_motion.distance, c.root_motion.speed, c.root_motion.axis, c.root_motion.in_place], ["Hips", 2, 1, "+Z", false]);
  assert.equal(c.loop.verdict, "closes: the last pose is the first");
  // The feet glide too, so they are never planted: no gait, no move speed.
  assert.equal(c.move_speed, undefined);
  const turned = clips(load(save("glide-turn.glb", rootClip(90)))).clips[0];
  assert.match(turned.loop.verdict, /^does not loop/);
  assert.equal(turned.loop.worst_joint, "Head");
  near(turned.loop.max_deg, 90, 0.01, "seam");
  assert.equal(turned.note, undefined);
  // Keys that all hold one pose: a statue, said first.
  assert.equal(clips(load(save("statue.glb", rootClip(0, 0)))).clips[0].note, "nothing moves: every key holds the same pose");
});

// A walk in place: each ankle is planted for 0.6 s sliding back from z +0.3
// to -0.3 (1 m/s), then lifts 0.2 and swings forward for 0.4 s; the right
// foot half a cycle behind the left. One 1 s cycle, its last key its first.
function walkInPlace() {
  const keys = 21;
  const times = Float32Array.from({ length: keys }, (_, k) => k * 0.05);
  const foot = (phase, x) => {
    const out = [];
    for (const t0 of times) {
      const t = (t0 + phase) % 1;
      if (t < 0.6) out.push(x, -0.9, 0.3 - t);
      else {
        const u = (t - 0.6) / 0.4;
        out.push(x, -0.9 + 0.2 * Math.sin(u * Math.PI), -0.3 + 0.6 * u);
      }
    }
    return new Float32Array(out);
  };
  const nodes = [
    { name: "Hips", translation: [0, 1, 0], children: [1, 2, 4] },
    { name: "Head", translation: [0, 0.75, 0] },
    { name: "L_Ankle", translation: [0.1, -0.9, 0], children: [3] },
    { name: "L_Foot", translation: [0, 0, 0.15] },
    { name: "R_Ankle", translation: [-0.1, -0.9, 0], children: [5] },
    { name: "R_Foot", translation: [0, 0, 0.15] }
  ];
  const animations = [
    {
      name: "walk",
      channels: [
        { sampler: 0, target: { node: 2, path: "translation" } },
        { sampler: 1, target: { node: 4, path: "translation" } },
        { sampler: 2, target: { node: 0, path: "rotation" } }
      ],
      samplers: [
        { input: 0, output: 1 },
        { input: 0, output: 2 },
        { input: 0, output: 3 }
      ]
    }
  ];
  const still = new Float32Array(keys * 4).map((_, i) => (i % 4 === 3 ? 1 : 0));
  return glb({ scene: 0, scenes: [{ nodes: [0] }], nodes, animations }, [[times, 1], [foot(0, 0.1), 3], [foot(0.5, -0.1), 3], [still, 4]]);
}

test("clips: a walk in place gets its foot contacts and the speed that keeps its feet planted", async () => {
  const file = save("walk.glb", walkInPlace());
  const c = clips(load(file)).clips[0];
  assert.equal(c.root_motion.in_place, true);
  assert.deepEqual(c.feet.map(f => f.foot), ["left", "right"]);
  // The left foot is down from 0 to 0.6 s; the right from 0.5 s round to 0.1 s.
  const left = c.feet[0].contacts;
  assert.equal(left.length, 1);
  near(left[0].start, 0, 0.04, "left down");
  near(left[0].end, 0.6, 0.06, "left up");
  const right = c.feet[1].contacts;
  near(right[0].start, 0, 0.04, "right still down at the start");
  near(right[0].end, 0.1, 0.06, "right up");
  near(right[right.length - 1].start, 0.5, 0.06, "right down again");
  assert.equal(c.move_speed.axis, "+Z");
  near(c.move_speed.speed, 1, 0.03, "move speed");
  near(c.move_speed.cycle_seconds, 1, 0.05, "cycle");
  near(c.move_speed.stride, 1, 0.06, "stride");
  const { stdout } = await exec(process.execPath, [CLI, "toolbox", "model", "clips", file], { cwd: DIR, env: { ...process.env, LUDO_TELEMETRY: "0", LUDO_CONFIG_DIR: path.join(DIR, ".c") } });
  const out = JSON.parse(stdout);
  assert.equal(out.clips[0].move_speed.axis, "+Z");
  assert.match(out.hint.command, /^ludo toolbox model collide /);
});

test("collide and orient place a skinned mesh by its joints, at rest", () => {
  // A unit box bound to one joint whose inverse bind matrix undoes y = 1;
  // the joint now rests at y = 3, so the drawn box sits 2 higher.
  const { positions, indices } = boxMesh([-0.5, 1, -0.5], [0.5, 2, 0.5]);
  const joints = new Uint8Array(8 * 4);
  const weights = new Float32Array(8 * 4).map((_, i) => (i % 4 === 0 ? 1 : 0));
  const ibm = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -1, 0, 1]);
  const json = {
    scene: 0,
    scenes: [{ nodes: [0, 1] }],
    nodes: [{ mesh: 0, skin: 0, translation: [100, 100, 100] }, { name: "Bone", translation: [0, 3, 0] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, JOINTS_0: 2, WEIGHTS_0: 3 }, indices: 1 }] }],
    skins: [{ joints: [1], inverseBindMatrices: 4 }]
  };
  const file = save("skinned.glb", glb(json, [[positions, 3], [indices, 1], [joints, 4], [weights, 4], [ibm, 16]]));
  const r = collide(load(file), 64);
  assert.deepEqual(r.box, { center: [0, 3.5, 0], size: [1, 1, 1] });
  assert.equal(r.pose, "rest (bind) pose");
  assert.match(r.notes[0], /^Skinned/);
  assert.match(orient(load(file)).notes[0], /^Skinned/);
});

test("the CLI: JSON with a hint that --quiet drops, help, and refusals", async () => {
  const env = { ...process.env, LUDO_TELEMETRY: "0", LUDO_CONFIG_DIR: path.join(DIR, ".c") };
  const run = (...args) => exec(process.execPath, [CLI, "toolbox", "model", ...args], { cwd: DIR, env });
  const fail = async (args, code, pattern) => {
    try {
      await run(...args);
      assert.fail(`${args.join(" ")} should exit non-zero`);
    } catch (err) {
      assert.equal(err.code, code, `${args.join(" ")}: ${err.stderr}`);
      assert.match(err.stderr, pattern);
    }
  };
  const bip = path.join(DIR, "biped.glb");
  const box = path.join(DIR, "box.glb");
  const o = JSON.parse((await run("orient", bip)).stdout);
  assert.equal(o.forward.axis, "+Z");
  assert.match(o.hint.command, /^ludo toolbox model collide /);
  assert.equal(JSON.parse((await run("orient", bip, "--quiet")).stdout).hint, undefined);
  // An unrigged box has no front to find, so the hint is Ludo's rig.
  assert.match(JSON.parse((await run("orient", box)).stdout).hint.command, /^ludo model rig --model /);
  const k = JSON.parse((await run("collide", box, "--max-vertices", "6")).stdout);
  assert.equal(k.hull.vertices.length, 6);
  assert.match(k.hint.command, /^ludo toolbox model orient /);
  const glide = JSON.parse((await run("clips", path.join(DIR, "glide.glb"), "--clip", "glide")).stdout);
  assert.equal(glide.clips.length, 1);
  assert.match((await run("collide", "--help")).stdout, /--max-vertices/);
  await fail(["clips", box], 12, /has no animations[\s\S]*ludo model rig --model/);
  await fail(["clips", path.join(DIR, "glide.glb"), "--clip", "run"], 2, /no animation "run"; it has glide/);
  await fail(["collide", path.join(DIR, "glide.glb")], 12, /no mesh to fit shapes to[\s\S]*animation only/);
  await fail(["collide", box, "--max-vertices", "3"], 2, /4 or more/);
  await fail(["orient", path.join(DIR, "missing.glb")], 2, /File not found/);
  fs.writeFileSync(path.join(DIR, "junk.gltf"), "not json");
  await fail(["orient", path.join(DIR, "junk.gltf")], 12, /Cannot read .* as a glTF model/);
});
