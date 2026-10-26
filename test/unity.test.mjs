// The Unity writer against files Unity itself wrote (test/corpus/unity), and
// the parts those files don't cover: rows (Unity's y is up), trims, extrudes,
// re-exports keeping the guid, and the CLI.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { unityAnimationClip, unityFloat, unityTextureMeta, readUnityMeta, writeUnityFiles, spriteFileIds } from "../dist/tty/unity.js";
import { encodePng } from "../dist/tty/png.js";

const exec = promisify(execFile);
const corpus = path.join(import.meta.dirname, "corpus", "unity");
const unityMeta = fs.readFileSync(path.join(corpus, "explosion.png.meta"), "utf8");
const unityClip = fs.readFileSync(path.join(corpus, "explosion.anim"), "utf8");
const GUID = "195d2ebbbf668124ab3fa9932a849bcb";
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ludo-unity-test-"));
const field = (text, name) => [...text.matchAll(new RegExp(`^ *${name}: (.*)$`, "gm"))].map(m => m[1]);

test("floats are written as Unity writes them", () => {
  assert.equal(unityFloat(0), "0");
  assert.equal(unityFloat(1 / 12), "0.083333336");
  assert.equal(unityFloat(2 / 12), "0.16666667");
  assert.equal(unityFloat(4 / 12), "0.33333334");
  assert.equal(unityFloat(5 / 12), "0.41666666");
  assert.equal(unityFloat(7 / 12), "0.5833333");
  assert.equal(unityFloat(8 / 12), "0.6666667");
  assert.equal(unityFloat(0.5), "0.5");
  assert.equal(unityFloat(12), "12");
  assert.equal(unityFloat(7.5), "7.5");
  // Every key time in Unity's clips reads back through ours.
  for (const t of field(unityClip, "- time").map(Number)) assert.equal(unityFloat(t), String(t));
});

test("the .meta for Unity's explosion sheet is Unity's, but for the settings we choose", () => {
  const ours = unityTextureMeta("explosion", GUID, 112, 16, { cols: 7, rows: 1, frames: 7, fps: 12 });
  // What we set on purpose: smooth filtering and Unity's default 100 pixels
  // per unit (the sample is a 16 px pixel-art project), centre pivots, our
  // own spriteIDs, and only the default platform's settings.
  const known = unityMeta
    .replace("    filterMode: 0", "    filterMode: 1")
    .replace("  spritePixelsToUnits: 16", "  spritePixelsToUnits: 100")
    .replaceAll("      pivot: {x: 0, y: 0}", "      pivot: {x: 0.5, y: 0.5}")
    .replace(/  - serializedVersion: 4\n    buildTarget: Standalone\n(?: {4}.*\n)*?(?=  spriteSheet:)/, "");
  const strip = text => text.replace(/^( +spriteID: )[0-9a-f]{32}$/gm, "$1<id>");
  assert.equal(strip(ours), strip(known));
  // spriteIDs: 32 hex, all different, the same on every run.
  const ids = field(ours, "spriteID").filter(Boolean);
  assert.equal(ids.length, 7);
  assert.equal(new Set(ids).size, 7);
  assert.ok(ids.every(id => /^[0-9a-f]{32}$/.test(id)));
  assert.equal(unityTextureMeta("explosion", GUID, 112, 16, { cols: 7, rows: 1, frames: 7, fps: 12 }), ours);
});

test("the clip for Unity's explosion is Unity's, without its closing empty key", () => {
  const ours = unityAnimationClip("explosion", GUID, spriteFileIds("explosion", 7), 12, false);
  // Unity's clip ends on an empty key (the explosion disappears); ours ends
  // on the last frame, which then shows for one frame's time.
  const known = unityClip
    .replace("    - time: 0.5833333\n      value: {fileID: 0}\n", "")
    .replace("    - {fileID: 0}\n", "")
    .replace("    m_StopTime: 0.6666666", "    m_StopTime: 0.5833333");
  assert.equal(ours, known);
  const looping = unityAnimationClip("run", GUID, spriteFileIds("run", 6), 12);
  assert.match(looping, /m_LoopTime: 1\n/);
  assert.match(looping, /m_StopTime: 0\.5\n/);
  assert.match(looping, /m_Name: run\n/);
});

test("rows count from the bottom; trims get the untrimmed centre as pivot; extrudes stay out of the rects", () => {
  const meta = unityTextureMeta("hero", GUID, 64, 64, { cols: 2, rows: 2, frames: 3, fps: 8 });
  const rects = [...meta.matchAll(/x: (\d+)\n {8}y: (\d+)\n {8}width: (\d+)\n {8}height: (\d+)/g)].map(m => m.slice(1).map(Number));
  assert.deepEqual(rects, [[0, 32, 32, 32], [32, 32, 32, 32], [0, 0, 32, 32]]);
  assert.deepEqual(field(meta, "second"), ["hero_0", "hero_1", "hero_2"]);

  // 20x10 content at (4, 18) of a 32x32 frame: its centre (16, 16) is
  // 12 px right of the content's left edge and 16 - (32 - 28) = 12 px up from
  // its bottom.
  const trim = { x: 4, y: 18, w: 20, h: 10, source_w: 32, source_h: 32 };
  const trimmed = unityTextureMeta("hero", GUID, 40, 20, { cols: 2, rows: 2, frames: 4, fps: 8 }, { trim });
  assert.deepEqual(field(trimmed, "      alignment"), ["9", "9", "9", "9"]);
  assert.deepEqual(field(trimmed, "      pivot")[0], `{x: ${unityFloat(12 / 20)}, y: 1.2}`);

  const extruded = unityTextureMeta("hero", GUID, 72, 36, { cols: 2, rows: 1, frames: 2, fps: 8 }, { extrude: 2 });
  const r = [...extruded.matchAll(/x: (\d+)\n {8}y: (\d+)\n {8}width: (\d+)\n {8}height: (\d+)/g)].map(m => m.slice(1).map(Number));
  assert.deepEqual(r, [[2, 2, 32, 32], [38, 2, 32, 32]]);
  assert.throws(() => unityTextureMeta("hero", GUID, 8, 8, { cols: 2, rows: 1, frames: 2, fps: 8 }, { extrude: 2 }), /leaves nothing/);
});

test("a pivot from sprite export is each sprite's custom pivot, in its own rect; --ppu sets the pixels per unit", () => {
  assert.deepEqual(field(unityTextureMeta("hero", GUID, 64, 64, { cols: 2, rows: 2, frames: 3, fps: 8 }), "  spritePixelsToUnits"), ["100"]);
  const meta = unityTextureMeta("hero", GUID, 64, 64, { cols: 2, rows: 2, frames: 3, fps: 8 }, {}, undefined, undefined, { pivot: { x: 16, y: 30 }, ppu: 32 });
  assert.deepEqual(field(meta, "      alignment"), ["9", "9", "9"]);
  assert.deepEqual(field(meta, "      pivot"), Array(3).fill(`{x: 0.5, y: ${unityFloat(2 / 32)}}`));
  assert.deepEqual(field(meta, "  spritePixelsToUnits"), ["32"]);
  // In a trimmed sheet the pivot is given in the untrimmed frame: (14, 28)
  // is the middle of the 20 px rect starting at x 4, on its bottom edge (18 + 10).
  const trim = { x: 4, y: 18, w: 20, h: 10, source_w: 32, source_h: 32 };
  const trimmed = unityTextureMeta("hero", GUID, 40, 20, { cols: 2, rows: 2, frames: 4, fps: 8 }, { trim }, undefined, undefined, { pivot: { x: 14, y: 28 } });
  assert.deepEqual(field(trimmed, "      pivot")[0], "{x: 0.5, y: 0}");
  assert.throws(() => unityTextureMeta("hero", GUID, 64, 64, { cols: 2, rows: 2, frames: 3, fps: 8 }, {}, undefined, undefined, { ppu: 0 }), /pixels per unit/);
});

test("names YAML would misread are quoted, and read back", () => {
  const meta = unityTextureMeta("boss: phase 2", GUID, 16, 8, { cols: 2, rows: 1, frames: 2, fps: 8 });
  assert.match(meta, /^ {6}name: 'boss: phase 2_0'$/m);
  assert.deepEqual(readUnityMeta(meta).fileIds, { "boss: phase 2_0": "21300000", "boss: phase 2_1": "21300002" });
});

test("a .meta checked out with Windows line endings keeps its guid and file IDs", () => {
  assert.deepEqual(readUnityMeta(unityMeta.replace(/\n/g, "\r\n")), readUnityMeta(unityMeta));
  assert.equal(Object.keys(readUnityMeta(unityMeta.replace(/\n/g, "\r\n")).fileIds).length, 7);
});

test("a re-export keeps the guid and file IDs Unity gave the sheet; the clip is never overwritten", () => {
  const dir = tmp();
  const sheet = path.join(dir, "explosion.png");
  fs.writeFileSync(sheet, "");
  // As if Unity had imported it: its guid, and one sprite with an ID of its own.
  fs.writeFileSync(sheet + ".meta", unityMeta.replace("explosion_3: 21300006", "explosion_3: -4912371838123"));
  const [meta, clip] = writeUnityFiles(sheet, 112, 16, { cols: 7, rows: 1, frames: 7, fps: 12 });
  assert.equal(meta, sheet + ".meta");
  assert.equal(clip, path.join(dir, "explosion.anim"));
  const text = fs.readFileSync(meta, "utf8");
  assert.match(text, new RegExp(`^guid: ${GUID}$`, "m"));
  assert.match(text, /^ {6}internalID: -4912371838123$/m);
  assert.match(fs.readFileSync(clip, "utf8"), /{fileID: -4912371838123, guid: 195d2ebbbf668124ab3fa9932a849bcb, type: 3}/);

  const [, again] = writeUnityFiles(sheet, 112, 16, { cols: 7, rows: 1, frames: 7, fps: 12 }, "boom");
  assert.equal(again, path.join(dir, "boom.anim"));
  const [, third] = writeUnityFiles(sheet, 112, 16, { cols: 7, rows: 1, frames: 7, fps: 12 }, "boom");
  assert.equal(third, path.join(dir, "boom-2.anim"));
  assert.match(fs.readFileSync(third, "utf8"), /m_Name: boom-2\n/);

  // A new sheet gets a new guid.
  const other = path.join(dir, "other.png");
  writeUnityFiles(other, 16, 16, { cols: 1, rows: 1, frames: 1, fps: 1 });
  const guid = readUnityMeta(fs.readFileSync(other + ".meta", "utf8")).guid;
  assert.match(guid, /^[0-9a-f]{32}$/);
  assert.notEqual(guid, GUID);
});

test("ludo toolbox sprite export --engine unity, and ludo init in a Unity project", async () => {
  const dir = tmp();
  const cli = path.join(import.meta.dirname, "..", "dist", "cli.js");
  const env = { ...process.env, LUDO_CONFIG_DIR: dir, LUDO_TELEMETRY: "0" };
  const img = { width: 64, height: 32, rgba: new Uint8Array(64 * 32 * 4).fill(255) };
  const sheet = path.join(dir, "walk.png");
  fs.writeFileSync(sheet, encodePng(img));
  const out = JSON.parse((await exec(process.execPath, [cli, "toolbox", "sprite", "export", "walk.png", "--grid", "2x1", "--fps", "8", "--engine", "unity", "--json"], { env, cwd: dir })).stdout);
  assert.deepEqual(out.engine_files, ["walk.png.meta", "walk.anim"]);
  assert.match(fs.readFileSync(path.join(dir, "walk.anim"), "utf8"), /m_SampleRate: 8\n/);

  // Two 32x32 frames of a 16x24 figure standing on row 27: --pivot feet puts
  // every sprite's pivot under it, on the ground line (16, 28).
  const fig = { width: 64, height: 32, rgba: new Uint8Array(64 * 32 * 4) };
  for (let y = 4; y < 28; y++) for (let x = 0; x < 64; x++) if (x % 32 >= 8 && x % 32 < 24) fig.rgba.set([200, 60, 40, 255], (y * 64 + x) * 4);
  fs.writeFileSync(path.join(dir, "stand.png"), encodePng(fig));
  const piv = JSON.parse((await exec(process.execPath, [cli, "toolbox", "sprite", "export", "stand.png", "--grid", "2x1", "--engine", "unity", "--pivot", "feet", "--ppu", "24", "--json"], { env, cwd: dir })).stdout);
  assert.deepEqual([piv.pivot.x, piv.pivot.y, piv.pivot.kind, piv.pixels_per_unit], [16, 28, "feet", 24]);
  const standMeta = fs.readFileSync(path.join(dir, "stand.png.meta"), "utf8");
  assert.deepEqual(field(standMeta, "      pivot"), Array(2).fill("{x: 0.5, y: 0.125}"));
  assert.deepEqual(field(standMeta, "  spritePixelsToUnits"), ["24"]);
  const ppuGodot = await exec(process.execPath, [cli, "toolbox", "sprite", "export", "stand.png", "--grid", "2x1", "--engine", "godot", "--ppu", "24", "--json"], { env, cwd: dir }).catch(e => e);
  assert.equal(ppuGodot.code, 2);
  // Godot 2D draws one pixel per unit: the error says so, and where a Sprite3D's pixel_size comes from.
  assert.match(JSON.parse(ppuGodot.stdout).error.hint, /^Godot 2D draws one pixel per unit[^]*pixel_size/);
  const tp = await exec(process.execPath, [cli, "toolbox", "sprite", "export", "stand.png", "--grid", "2x1", "--engine", "texturepacker", "--pivot", "feet", "--json"], { env, cwd: dir }).catch(e => e);
  assert.equal(tp.code, 2);

  const project = path.join(dir, "game");
  fs.mkdirSync(path.join(project, "ProjectSettings"), { recursive: true });
  fs.mkdirSync(path.join(project, "Assets"));
  fs.writeFileSync(path.join(project, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 6000.3.3f1\n");
  await exec(process.execPath, [cli, "init"], { env, cwd: project });
  const config = JSON.parse(fs.readFileSync(path.join(project, ".ludo.json"), "utf8"));
  assert.equal(config.engine, "unity");
  assert.equal(config.out, "Assets/Ludo");
});
