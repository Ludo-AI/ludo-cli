// `ludo toolbox model info`: counts against Khronos's glTF-Validator (a dev
// dependency) on Khronos's CC0 sample models, transforms and image sizes on a
// GLB built here, broken files, and what each clip does on skeletons built
// here with known answers.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { animationFacts, modelInfo, readAccessor, readGltf, ModelError, sampleChannel } from "../dist/toolbox/model.js";
import { encodePng } from "../dist/tty/png.js";

const exec = promisify(execFile);
const CLI = path.join(import.meta.dirname, "..", "dist", "cli.js");
const CORPUS = path.join(import.meta.dirname, "corpus", "gltf");
const files = fs.readdirSync(CORPUS).filter(f => /\.(glb|gltf)$/.test(f));
const info = file => modelInfo(readGltf(fs.readFileSync(file), file));

test("counts agree with Khronos's glTF-Validator on every sample model", async t => {
  let validator;
  try {
    validator = await import("gltf-validator");
  } catch {
    return t.skip("gltf-validator is not installed");
  }
  assert.equal(files.length, 6);
  for (const f of files) {
    const theirs = (await validator.validateBytes(new Uint8Array(fs.readFileSync(path.join(CORPUS, f))))).info;
    const ours = info(path.join(CORPUS, f));
    assert.deepEqual(
      [ours.primitives, ours.vertices, ours.triangles, ours.materials, ours.animations.length, ours.rigged, ours.morph_targets],
      [theirs.drawCallCount, theirs.totalVertexCount, theirs.totalTriangleCount, theirs.materialCount, theirs.animationCount, theirs.hasSkins, theirs.hasMorphTargets],
      f
    );
  }
});

test("sample models: bounds, joints and animation lengths", () => {
  assert.deepEqual(info(path.join(CORPUS, "Triangle.gltf")).bounds, { min: [0, 0, 0], max: [1, 1, 0], size: [1, 1, 0] });
  const skin = info(path.join(CORPUS, "SimpleSkin.gltf"));
  assert.equal(skin.rigged, true);
  assert.equal(skin.skins[0].joints, 2);
  assert.deepEqual(info(path.join(CORPUS, "AnimatedTriangle.gltf")).animations, [{ name: "animation 0", seconds: 1, channels: 1 }]);
});

// A GLB with one quad mesh drawn by two nodes: one moved and scaled, one
// turned 90 degrees about z under a moved parent; and an embedded 7x5 PNG.
function glb() {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 2, 0, 0, 2, 0]);
  const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
  const png = encodePng({ width: 7, height: 5, rgba: new Uint8Array(7 * 5 * 4).fill(200) });
  const pad = n => (4 - (n % 4)) % 4;
  const bin = Buffer.concat([Buffer.from(positions.buffer), Buffer.from(indices.buffer), Buffer.alloc(pad(indices.byteLength)), png, Buffer.alloc(pad(png.length))]);
  const s = Math.SQRT1_2;
  const json = {
    asset: { version: "2.0", generator: "ludo test" },
    scene: 0,
    scenes: [{ nodes: [0, 1] }],
    nodes: [
      { mesh: 0, translation: [10, 0, 0], scale: [2, 1, 1] },
      { translation: [0, 5, 0], children: [2] },
      { mesh: 0, rotation: [0, 0, s, s] }
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: "VEC3", min: [0, 0, 0], max: [1, 2, 0] },
      { bufferView: 1, componentType: 5123, count: 6, type: "SCALAR" }
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 48 },
      { buffer: 0, byteOffset: 48, byteLength: 12 },
      { buffer: 0, byteOffset: 60, byteLength: png.length }
    ],
    buffers: [{ byteLength: bin.length }],
    images: [{ bufferView: 2, mimeType: "image/png" }],
    textures: [{ source: 0 }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }]
  };
  let text = Buffer.from(JSON.stringify(json));
  text = Buffer.concat([text, Buffer.alloc(pad(text.length), 0x20)]);
  const header = Buffer.alloc(12);
  header.write("glTF", 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + text.length + 8 + bin.length, 8);
  const chunk = (type, data) => {
    const h = Buffer.alloc(8);
    h.writeUInt32LE(data.length, 0);
    h.writeUInt32LE(type, 4);
    return Buffer.concat([h, data]);
  };
  return Buffer.concat([header, chunk(0x4e4f534a, text), chunk(0x004e4942, bin)]);
}

test("bounds go through node transforms; embedded images report their size", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-model-"));
  const file = path.join(dir, "quad.glb");
  fs.writeFileSync(file, glb());
  const ours = info(file);
  // Node 0: x 10..12, y 0..2. Node 2, turned 90° and moved up 5: x -2..0, y 5..6.
  assert.deepEqual(ours.bounds, { min: [-2, 0, 0], max: [12, 6, 0], size: [14, 6, 0] });
  // The one mesh counts once, as glTF-Validator counts it; the scene draws it twice.
  assert.deepEqual([ours.primitives, ours.vertices, ours.triangles, ours.mesh_instances], [1, 4, 2, 2]);
  assert.deepEqual(ours.images, [{ mime: "image/png", width: 7, height: 5, bytes: ours.images[0].bytes }]);
  try {
    const validator = await import("gltf-validator");
    const report = await validator.validateBytes(new Uint8Array(fs.readFileSync(file)));
    assert.equal(report.issues.numErrors, 0, JSON.stringify(report.issues.messages.slice(0, 3)));
    assert.deepEqual([report.info.drawCallCount, report.info.totalVertexCount, report.info.totalTriangleCount], [1, 4, 2]);
  } catch (err) {
    if (err?.code === "ERR_MODULE_NOT_FOUND") t.diagnostic("gltf-validator is not installed");
    else throw err;
  }
  const { stdout } = await exec(process.execPath, [CLI, "toolbox", "model", "info", file], { cwd: dir, env: { ...process.env, LUDO_TELEMETRY: "0", LUDO_CONFIG_DIR: path.join(dir, ".c") } });
  const out = JSON.parse(stdout);
  assert.deepEqual([out.meshes, out.mesh_instances, out.triangles, out.rigged, out.bytes], [1, 2, 2, false, fs.statSync(file).size]);
  assert.match(out.hint.command, /^ludo model rig --model /);
});

test("broken models are refused with a reason", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-model-bad-"));
  const good = glb();
  const cases = [
    ["short.glb", good.subarray(0, 40), /runs past the end|says \d+ bytes/],
    ["v1.glb", Buffer.concat([good.subarray(0, 4), Buffer.from([1, 0, 0, 0]), good.subarray(8)]), /version 1/],
    ["junk.gltf", Buffer.from("not json"), /does not parse/],
    ["noasset.gltf", Buffer.from("{}"), /no asset/]
  ];
  for (const [name, bytes, why] of cases) {
    fs.writeFileSync(path.join(dir, name), bytes);
    assert.throws(() => info(path.join(dir, name)), err => err instanceof ModelError && why.test(err.message), name);
  }
  try {
    await exec(process.execPath, [CLI, "toolbox", "model", "info", path.join(dir, "junk.gltf")], { env: { ...process.env, LUDO_TELEMETRY: "0" } });
    assert.fail("should exit non-zero");
  } catch (err) {
    assert.equal(err.code, 12);
    assert.match(err.stderr, /Cannot read .* as a glTF model/);
  }
});

// ---- Clips

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-model-clips-"));
const TYPES = { 1: "SCALAR", 2: "VEC2", 3: "VEC3", 4: "VEC4", 16: "MAT4" };
const KIND = { Float32Array: 5126, Uint16Array: 5123, Uint8Array: 5121 };
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} is not within ${tol} of ${b}`);

// A GLB from glTF JSON and its data: `data` lists [typedArray, components,
// extra accessor fields]; accessor i is data[i], each in its own buffer view.
function build(json, data) {
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
const facts = file => animationFacts(load(file));
const cli = async file => JSON.parse((await exec(process.execPath, [CLI, "toolbox", "model", "info", file], { cwd: DIR, env: { ...process.env, LUDO_TELEMETRY: "0", LUDO_CONFIG_DIR: path.join(DIR, ".c") } })).stdout);

test("readAccessor reads strides, normalized integers and sparse substitutions", () => {
  // Two VEC3 floats interleaved with a padding float (stride 16), normalized
  // unsigned bytes, and a sparse accessor over zeros.
  const interleaved = new Float32Array([1, 2, 3, 99, 4, 5, 6, 99]);
  const bytes = new Uint8Array([0, 255, 51, 0]);
  const sparseIdx = new Uint16Array([2, 0]);
  const sparseVal = new Float32Array([7, 8]);
  const json = { scene: 0, scenes: [{ nodes: [] }], nodes: [] };
  const m = load(save("accessors.glb", build(json, [[interleaved, 3, { byteStride: 16, count: 2 }], [bytes, 4, { normalized: true }], [sparseIdx, 1], [sparseVal, 1]])));
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

// Stick-figure joints 1.8 tall: hips at 1, head at 1.75, ankles 0.1 up and
// toes on the floor 0.15 ahead (+Z).
const stick = (foot = [0, -0.1, 0.15]) => [
  { name: "Hips", translation: [0, 1, 0], children: [1, 2, 4] },
  { name: "Head", translation: [0, 0.75, 0] },
  { name: "L_Ankle", translation: [0.1, -0.9, 0], children: [3] },
  { name: "L_Foot", translation: foot },
  { name: "R_Ankle", translation: [-0.1, -0.9, 0], children: [5] },
  { name: "R_Foot", translation: foot }
];

// The stick figure skinned to a box mesh, turned `turn` degrees about Y.
function rigged(turn = 0) {
  const p = [];
  for (let k = 0; k < 8; k++) p.push(k & 1 ? 0.25 : -0.25, k & 2 ? 1.8 : 0, k & 4 ? 0.2 : -0.15);
  const idx = [0, 2, 1, 1, 2, 3, 4, 5, 6, 5, 7, 6, 0, 1, 4, 1, 5, 4, 2, 6, 3, 3, 6, 7, 0, 4, 2, 2, 4, 6, 1, 3, 5, 3, 7, 5];
  const s = Math.sin(((turn / 2) * Math.PI) / 180);
  const c = Math.cos(((turn / 2) * Math.PI) / 180);
  const nodes = [{ name: "Armature", children: [1, 2], rotation: [0, s, 0, c] }, { mesh: 0 }, ...stick().map(n => ({ ...n, children: n.children?.map(i => i + 2) }))];
  return build({ scene: 0, scenes: [{ nodes: [0] }], nodes, meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }], skins: [{ joints: [2, 3, 4, 5, 6, 7] }] }, [
    [new Float32Array(p), 3],
    [new Uint16Array(idx), 1]
  ]);
}

test("a rigged model faces where its toes and its left side say; an unrigged one gets no facing", async () => {
  assert.deepEqual(facts(save("rigged.glb", rigged())).facing, { axis: "+Z", turn_deg: 0 });
  assert.deepEqual(facts(save("rigged-turned.glb", rigged(90))).facing, { axis: "+X", turn_deg: -90 });
  const out = await cli(path.join(DIR, "rigged.glb"));
  assert.deepEqual(out.facing, { axis: "+Z", turn_deg: 0 });
  assert.match(out.hint.command, /^ludo model animate --model /);
  // The quad from above: no rig, so no facing, and the hint is Ludo's rig.
  const quad = save("quad.glb", glb());
  assert.equal((await cli(quad)).facing, undefined);
  assert.match((await cli(quad)).hint.command, /^ludo model rig --model /);
});

// A two-key clip on the stick figure, no mesh: the hips glide `travel` along
// +Z in 2 s and the head turns `endTurn` degrees by the end.
function glide(endTurn, travel = 2, name = "glide") {
  const s = Math.sin(((endTurn / 2) * Math.PI) / 180);
  const c = Math.cos(((endTurn / 2) * Math.PI) / 180);
  const animations = [
    {
      name,
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
  return build({ scene: 0, scenes: [{ nodes: [0] }], nodes: stick(), animations }, [
    [new Float32Array([0, 2]), 1],
    [new Float32Array([0, 1, 0, 0, 1, travel]), 3],
    [new Float32Array([0, 0, 0, 1, 0, s, 0, c]), 4]
  ]);
}

test("clips: root motion only when it travels, the seam as a return to the first pose, and a still", async () => {
  const [straight] = facts(save("glide.glb", glide(0))).clips;
  assert.deepEqual(straight.root_motion, { distance: 2, axis: "+Z", speed: 1 });
  assert.equal(straight.returns_to_first_pose, true);
  // Its feet glide too, never planted: no move speed, even named a walk.
  assert.equal(facts(save("glide-walk.glb", glide(0, 2, "walk"))).clips[0].move_speed, undefined);
  const [turned] = facts(save("glide-turn.glb", glide(90))).clips;
  assert.equal(turned.returns_to_first_pose, false);
  assert.deepEqual(turned.end_jump, { joint: "Head", deg: 90 });
  // Keys that all hold one pose: a still, and nothing else said of it.
  const statue = save("statue.glb", glide(0, 0));
  assert.deepEqual(facts(statue).clips, [{ still: true }]);
  const out = await cli(statue);
  assert.deepEqual(out.animations, [{ name: "glide", seconds: 2, channels: 2, still: true }]);
  assert.match(out.hint.text, /does not move/);
  assert.match(out.hint.command, /^ludo model animate --model <rigged model>/);
});

// A walk in place: each ankle is planted for 0.6 s sliding back from z +0.3
// to -0.3 (1 unit/s), then lifts 0.2 and swings forward for 0.4 s; the right
// foot half a cycle behind the left. One 1 s cycle, its last key its first.
function walkInPlace(name) {
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
  const animations = [
    {
      name,
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
  return build({ scene: 0, scenes: [{ nodes: [0] }], nodes: stick([0, 0, 0.15]), animations }, [[times, 1], [foot(0, 0.1), 3], [foot(0.5, -0.1), 3], [still, 4]]);
}

test("clips: a walk in place gets the speed its planted feet slide back at; a dance with the same feet does not", async () => {
  const [walk] = facts(save("walk.glb", walkInPlace("Brisk Walk"))).clips;
  assert.equal(walk.root_motion, undefined);
  assert.equal(walk.returns_to_first_pose, true);
  assert.equal(walk.move_speed.axis, "+Z");
  assert.equal(walk.move_speed.from, "planted feet");
  near(walk.move_speed.speed, 1, 0.03, "move speed");
  for (const v of walk.move_speed.range) near(v, 1, 0.05, "a step's slide");
  // Only a clip named as a walk or a run gets a speed.
  assert.equal(facts(save("dance.glb", walkInPlace("dance_basic"))).clips[0].move_speed, undefined);
  const out = await cli(path.join(DIR, "walk.glb"));
  assert.equal(out.animations[0].move_speed.axis, "+Z");
  assert.equal(out.rigged, false);
  assert.equal(out.facing, undefined, "an animation-only file has no model to face");
});
