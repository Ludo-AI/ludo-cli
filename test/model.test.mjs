// `ludo toolbox model info`: counts against Khronos's glTF-Validator (a dev
// dependency) on Khronos's CC0 sample models, transforms and image sizes on a
// GLB built here, and broken files.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { modelInfo, readGltf, ModelError } from "../dist/toolbox/model.js";
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
