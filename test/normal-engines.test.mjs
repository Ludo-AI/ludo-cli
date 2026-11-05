// A normal map in the engine files: `image normals --engine` (the map
// beside the art, the art's engine files updated, never made again from
// defaults) and `sprite export` picking a map up. Godot's lighting itself is
// checked in real Godot (test/godot/run.sh); Unity's files against Unity's
// own (test/unity.test.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { encodePng, readPng, readText, textChunk } from "../dist/tty/png.js";
import { encodeWebp } from "../dist/tty/webp-encode.js";
import { canvasTextureTres, spriteFramesTres } from "../dist/tty/godot.js";
import { readUnityMeta } from "../dist/tty/unity.js";
import { EXIT } from "../dist/errors.js";

const exec = promisify(execFile);
const CLI = path.join(import.meta.dirname, "..", "dist", "cli.js");
const NORMALS = path.join(import.meta.dirname, "corpus", "normals");
const UNITY = path.join(import.meta.dirname, "corpus", "unity");
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ludo-lit-")));

// Runs the CLI in `dir`; JSON out, or the error.
const cli = async (dir, args) => {
  try {
    const { stdout } = await exec(process.execPath, [CLI, ...args, "--json", "--quiet"], { cwd: dir, env: { ...process.env, LUDO_TELEMETRY: "0", LUDO_CONFIG_DIR: path.join(os.tmpdir(), "ludo-lit-config") } });
    return { code: 0, out: JSON.parse(stdout) };
  } catch (err) {
    return { code: err.code, stderr: err.stderr, out: err.stdout ? JSON.parse(err.stdout) : undefined };
  }
};
const normals = (dir, args) => cli(dir, ["toolbox", "image", "normals", ...args]);
const exportSheet = (dir, args) => cli(dir, ["toolbox", "sprite", "export", ...args]);

// Four 24x32 frames of a figure that steps right, side by side.
function figures(cols = 4) {
  const [w, h] = [24 * cols, 32];
  const rgba = new Uint8Array(w * h * 4);
  for (let f = 0; f < cols; f++) for (let y = 4; y < 30; y++) for (let x = 6 + f; x < 18 + f; x++) rgba.set([200 - f * 30, 60 + y * 4, 40 + x * 2, 255], (y * w + f * 24 + x) * 4);
  return { width: w, height: h, rgba };
}
// The same as a Ludo-stamped 4x1 sheet, or with no stamp (its grid detected).
function sheet(dir, name = "walk.png", stamped = true) {
  const chunks = stamped ? [textChunk("ludo:grid", JSON.stringify({ cols: 4, rows: 1, frames: 4, fps: 8 }))] : [];
  fs.writeFileSync(path.join(dir, name), encodePng(figures(), { chunks }));
  return name;
}
const still = (dir, name = "rock.png") => (fs.copyFileSync(path.join(NORMALS, "islands.png"), path.join(dir, name)), name);
const read = (dir, f) => fs.readFileSync(path.join(dir, f), "utf8");
const listed = dir => fs.readdirSync(dir).filter(f => !f.startsWith(".")).sort();
const field = (text, name) => [...text.matchAll(new RegExp(`^ *${name}: (.*)$`, "gm"))].map(m => m[1]);
// Every line but the secondaryTextures list.
const withoutSecondary = meta => meta.replace(/^ {4}secondaryTextures:.*\n(?: {4}- .*\n| {6}.*\n)*/m, "");

test("--engine writes the map beside the art, stamped, with each engine's files when the art has none", async () => {
  const grid = { cols: 4, rows: 1, frames: 4, fps: 8 };
  const godot = tmp();
  sheet(godot);
  const g = await normals(godot, ["walk.png", "--engine", "godot"]);
  assert.equal(g.code, 0, g.stderr);
  assert.deepEqual([g.out.image, g.out.engine_files, g.out.patched, g.out.replaced], ["walk_n.png", ["walk.tres"], undefined, undefined]);
  assert.equal(read(godot, "walk.tres"), spriteFramesTres("walk.png", 96, 32, grid, "default", {}, "walk_n.png"));
  assert.match(readText(fs.readFileSync(path.join(godot, "walk_n.png")))["ludo:normal"], /^opengl rgba-sha256:[0-9a-f]{16}$/);
  assert.ok(!fs.existsSync(path.join(godot, "ludo-output")), "nothing in --out");

  const unity = tmp();
  sheet(unity);
  const u = await normals(unity, ["walk.png", "--engine", "unity"]);
  assert.deepEqual(u.out.engine_files, ["walk.png.meta", "walk_n.png.meta", "walk.anim"]);
  const mapGuid = readUnityMeta(read(unity, "walk_n.png.meta")).guid;
  assert.ok(read(unity, "walk.png.meta").includes(`    - texture: {fileID: 2800000, guid: ${mapGuid}, type: 3}\n      name: _NormalMap\n`));
  assert.match(u.out.notes.join("\n"), /Light 2D whose Normal Maps quality is Fast or Accurate \(it is Disabled by default\)/);

  const tp = tmp();
  sheet(tp);
  const t = await normals(tp, ["walk.png", "--engine", "texturepacker"]);
  assert.deepEqual(t.out.engine_files, ["walk.json"]);
  assert.match(t.out.notes[0], /this\.load\.atlas\(\{ key: "walk", textureURL: "walk\.png", atlasURL: "walk\.json", normalMap: "walk_n\.png" \}\)/);
  assert.match(t.out.notes[0], /setPipeline\("Light2D"\) in Phaser 3 or setLighting\(true\) in Phaser 4/);
  // An atlas already there is used as it is.
  const again = await normals(tp, ["walk.png", "--engine", "texturepacker"]);
  assert.deepEqual([again.out.engine_files, again.out.replaced], [undefined, true]);
  assert.deepEqual(listed(tp), ["walk.json", "walk.png", "walk_n.png"]);

  // A still image: a CanvasTexture for Godot, no clip for Unity, no atlas.
  const s = tmp();
  still(s);
  const sg = await normals(s, ["rock.png", "--engine", "godot"]);
  assert.equal(read(s, "rock.tres"), canvasTextureTres("rock.png", "rock_n.png"));
  const su = await normals(s, ["rock.png", "--engine", "unity", "--normal-format", "directx"]);
  assert.deepEqual([su.out.engine_files, su.out.replaced], [["rock.png.meta", "rock_n.png.meta"], true]);
  assert.match(read(s, "rock_n.png.meta"), /flipGreenChannel: 1\n/);
  // The Godot file still points at rock_n.png, now the DirectX map.
  assert.equal(read(s, "rock.tres"), canvasTextureTres("rock.png", "rock_n.png"));
  assert.ok(sg.out.engine_files.length === 1);
  const st = await normals(s, ["rock.png", "--engine", "texturepacker"]);
  assert.equal(st.out.engine_files, undefined);
  assert.match(st.out.notes[0], /this\.load\.image\(\{ key: "rock", url: "rock\.png", normalMap: "rock_n\.png" \}\)/);

  // --out is not where the map goes with --engine, and --name cannot rename it.
  const o = await normals(s, ["rock.png", "--engine", "godot", "--out", "elsewhere"]);
  assert.match(o.out.notes.join("\n"), /--out is not used with --engine/);
  assert.ok(!fs.existsSync(path.join(s, "elsewhere")));
  const named = await normals(s, ["rock.png", "--engine", "godot", "--name", "x"]);
  assert.equal(named.code, EXIT.USAGE);
  // Without --engine the map goes to --out, numbered, as before.
  const plain = await normals(s, ["rock.png", "--out", "maps"]);
  assert.deepEqual([plain.code, plain.out.image, plain.out.engine_files], [0, "maps/rock_n.png", undefined]);
});

test("Unity: a .meta already there keeps every line but its secondaryTextures, and no clip is added", async () => {
  // An unstamped sheet: export detects 4 frames, with a pivot and PPU.
  const dir = tmp();
  sheet(dir, "walk.png", false);
  const e = await exportSheet(dir, ["walk.png", "--engine", "unity", "--pivot", "feet", "--ppu", "16"]);
  assert.equal(e.code, 0, e.stderr);
  assert.equal(e.out.grid.frames, 4);
  const meta = read(dir, "walk.png.meta");
  const anim = read(dir, "walk.anim");
  const n = await normals(dir, ["walk.png", "--engine", "unity"]);
  assert.equal(n.code, 0, n.stderr);
  assert.deepEqual([n.out.engine_files, n.out.patched], [["walk.png.meta", "walk_n.png.meta"], ["walk.png.meta"]]);
  const lit = read(dir, "walk.png.meta");
  assert.equal(withoutSecondary(lit), withoutSecondary(meta), "slicing, pivots, PPU and IDs as export wrote them");
  assert.equal(field(lit, "      name").filter(x => x.startsWith("walk_")).length, 4);
  assert.deepEqual(field(lit, "  spritePixelsToUnits"), ["16"]);
  assert.equal(read(dir, "walk.anim"), anim);
  assert.deepEqual(listed(dir).filter(f => f.endsWith(".anim")), ["walk.anim"]);
  // A second run: the map replaced, both guids kept, nothing else changes.
  const guid = readUnityMeta(read(dir, "walk_n.png.meta")).guid;
  const again = await normals(dir, ["walk.png", "--engine", "unity"]);
  assert.deepEqual([again.out.replaced, again.out.patched], [true, ["walk.png.meta", "walk_n.png.meta"]]);
  assert.equal(read(dir, "walk.png.meta"), lit);
  assert.equal(readUnityMeta(read(dir, "walk_n.png.meta")).guid, guid);
  assert.deepEqual(listed(dir).filter(f => f.endsWith(".anim")), ["walk.anim"]);

  // A .meta Unity wrote for a Single sprite, with a mask already listed and
  // Windows line endings: only the list changes; the map's own .meta (a
  // sliced one Unity wrote) keeps its sprites and guid.
  const u = tmp();
  still(u);
  const single = fs
    .readFileSync(path.join(UNITY, "normalmap.png.meta"), "utf8")
    .replace("guid: b012569a94369804db3e912822cb96cd", "guid: 0123456789abcdef0123456789abcdef")
    .replace("  textureType: 1", "  textureType: 8")
    .replace("    sRGBTexture: 0", "    sRGBTexture: 1")
    .replace("  spriteMode: 2", "  spriteMode: 1")
    .replace("    secondaryTextures: []", "    secondaryTextures:\n    - texture: {fileID: 2800000, guid: ffffffffffffffffffffffffffffffff, type: 3}\n      name: _MaskTex")
    .replace(/\n/g, "\r\n");
  fs.writeFileSync(path.join(u, "rock.png.meta"), single);
  const mapMeta = fs.readFileSync(path.join(UNITY, "normalmap.png.meta"), "utf8").replace("  textureType: 1", "  textureType: 0").replace("    sRGBTexture: 0", "    sRGBTexture: 1");
  const r = await normals(u, ["rock.png", "--engine", "unity", "--normal-format", "directx"]);
  assert.equal(r.code, 0, r.stderr);
  // The map's .meta was written by this run, so it was not there before; put Unity's in and run again.
  fs.writeFileSync(path.join(u, "rock_n.png.meta"), mapMeta);
  const r2 = await normals(u, ["rock.png", "--engine", "unity", "--normal-format", "directx"]);
  assert.deepEqual(r2.out.patched, ["rock.png.meta", "rock_n.png.meta"]);
  const after = read(u, "rock.png.meta");
  const lines = after.split("\r\n");
  const before = single.split("\r\n");
  const at = before.indexOf("    secondaryTextures:");
  assert.deepEqual(lines.slice(0, at + 3), before.slice(0, at + 3), "up to the mask, as it was");
  assert.deepEqual(lines.slice(at + 3, at + 5), ["    - texture: {fileID: 2800000, guid: b012569a94369804db3e912822cb96cd, type: 3}", "      name: _NormalMap"]);
  assert.deepEqual(lines.slice(at + 5), before.slice(at + 3), "and after it");
  const map = read(u, "rock_n.png.meta");
  assert.equal(map, mapMeta.replace("  textureType: 0", "  textureType: 1").replace("    sRGBTexture: 1", "    sRGBTexture: 0").replace("    flipGreenChannel: 0", "    flipGreenChannel: 1"));
});

test("Godot: every .tres that uses the art is lit in place, frames and animation as they were; another art's is not touched", async () => {
  const dir = tmp();
  sheet(dir, "walk.png", false);
  const plainExport = await exportSheet(dir, ["walk.png", "--engine", "godot", "--fps", "12", "--animation", "run"]);
  const pivoted = await exportSheet(dir, ["walk.png", "--engine", "godot", "--pivot", "feet"]);
  assert.deepEqual([plainExport.out.engine_files, pivoted.out.engine_files], [["walk.tres"], ["walk-2.tres", "walk-2.tscn"]]);
  const scene = read(dir, "walk-2.tscn");
  const n = await normals(dir, ["walk.png", "--engine", "godot"]);
  assert.equal(n.code, 0, n.stderr);
  assert.deepEqual([n.out.engine_files, n.out.patched], [["walk.tres", "walk-2.tres"], ["walk.tres", "walk-2.tres"]]);
  assert.equal(read(dir, "walk.tres"), spriteFramesTres("walk.png", 96, 32, { cols: 4, rows: 1, frames: 4, fps: 12 }, "run", {}, "walk_n.png"));
  assert.equal(read(dir, "walk-2.tres"), spriteFramesTres("walk.png", 96, 32, { cols: 4, rows: 1, frames: 4, fps: 10 }, "default", {}, "walk_n.png"));
  assert.equal(read(dir, "walk-2.tscn"), scene);
  // Again: the same files, the map replaced.
  const lit = read(dir, "walk.tres");
  const again = await normals(dir, ["walk.png", "--engine", "godot"]);
  assert.equal(again.out.replaced, true);
  assert.equal(read(dir, "walk.tres"), lit);
  assert.deepEqual(listed(dir).filter(f => f.endsWith(".tres")), ["walk-2.tres", "walk.tres"]);

  // One Godot saved back (uids, its own ids, "loop": 1) is lit in place too.
  const other = tmp();
  sheet(other);
  await exportSheet(other, ["walk.png", "--engine", "godot"]);
  const saved = read(other, "walk.tres")
    .replace('[gd_resource type="SpriteFrames" format=3]', '[gd_resource type="SpriteFrames" format=3 uid="uid://b1x"]')
    .replace('[ext_resource type="Texture2D" path="walk.png" id="1_sheet"]', '[ext_resource type="Texture2D" uid="uid://c5t" path="walk.png" id="1_p3elh"]')
    .replaceAll('ExtResource("1_sheet")', 'ExtResource("1_p3elh")')
    .replace('"loop": true', '"loop": 1')
    .replace(/\n$/, "");
  fs.writeFileSync(path.join(other, "walk.tres"), saved);
  const f = await normals(other, ["walk.png", "--engine", "godot"]);
  assert.equal(f.code, 0, f.stderr);
  assert.deepEqual([f.out.patched, f.out.notes], [["walk.tres"], undefined]);
  assert.equal(
    read(other, "walk.tres"),
    saved
      .replace('id="1_p3elh"]\n', 'id="1_p3elh"]\n[ext_resource type="Texture2D" path="walk_n.png" id="2_normal"]\n')
      .replace('[sub_resource type="AtlasTexture" id="AtlasTexture_0"]', '[sub_resource type="CanvasTexture" id="CanvasTexture_lit"]\ndiffuse_texture = ExtResource("1_p3elh")\nnormal_texture = ExtResource("2_normal")\n\n[sub_resource type="AtlasTexture" id="AtlasTexture_0"]')
      .replaceAll('atlas = ExtResource("1_p3elh")', 'atlas = SubResource("CanvasTexture_lit")')
  );
  // A file it cannot rewire (a StyleBoxTexture) is left, with advice for
  // what it is, and the art then gets no new file.
  const style = tmp();
  sheet(style);
  fs.writeFileSync(path.join(style, "panel.tres"), '[gd_resource type="StyleBoxTexture" format=3]\n\n[ext_resource type="Texture2D" path="walk.png" id="1"]\n\n[resource]\ntexture = ExtResource("1")\n');
  const t = await normals(style, ["walk.png", "--engine", "godot"]);
  assert.equal(t.out.engine_files, undefined);
  assert.match(t.out.notes[0], /panel\.tres uses the art but is left as it is \(a StyleBoxTexture, not a SpriteFrames, TileSet, AtlasTexture or CanvasTexture\): in Godot, where it uses walk\.png, use a CanvasTexture with walk\.png as its diffuse_texture and walk_n\.png as its normal_texture\./);
  assert.match(t.out.notes[1], /So no Godot file was written: the \.tres file above already uses the art, and no new one is made beside it\./);
  // One it cannot read is skipped with a note; the rest goes on.
  const locked = tmp();
  sheet(locked);
  await exportSheet(locked, ["walk.png", "--engine", "godot"]);
  fs.writeFileSync(path.join(locked, "other.tres"), "x");
  fs.chmodSync(path.join(locked, "other.tres"), 0o000);
  const lr = await normals(locked, ["walk.png", "--engine", "godot"]);
  assert.equal(lr.code, 0, lr.stderr);
  assert.deepEqual(lr.out.patched, ["walk.tres"]);
  assert.match(lr.out.notes[0], /other\.tres could not be read \(EACCES\), so it was not looked at/);
  fs.chmodSync(path.join(locked, "other.tres"), 0o644);

  // Another art's .tres, even one named like a take of this art (Ludo's
  // hero-2.png beside hero.png), neither blocks nor is touched; and back.
  const takes = tmp();
  sheet(takes, "hero.png");
  sheet(takes, "hero-2.png");
  await exportSheet(takes, ["hero-2.png", "--engine", "godot"]);
  const theirs = read(takes, "hero-2.tres");
  const h = await normals(takes, ["hero.png", "--engine", "godot"]);
  assert.deepEqual([h.out.engine_files, h.out.patched, h.out.notes], [["hero.tres"], undefined, undefined]);
  assert.equal(read(takes, "hero-2.tres"), theirs);
  const mine = read(takes, "hero.tres");
  const h2 = await normals(takes, ["hero-2.png", "--engine", "godot"]);
  assert.deepEqual([h2.out.patched, h2.out.notes], [["hero-2.tres"], undefined]);
  assert.equal(read(takes, "hero.tres"), mine);
  assert.match(read(takes, "hero-2.tres"), /path="hero-2_n\.png" id="2_normal"/);

  // A still's CanvasTexture is ours too.
  const s = tmp();
  still(s);
  await normals(s, ["rock.png", "--engine", "godot"]);
  const twice = await normals(s, ["rock.png", "--engine", "godot"]);
  assert.deepEqual(twice.out.patched, ["rock.tres"]);
  assert.equal(read(s, "rock.tres"), canvasTextureTres("rock.png", "rock_n.png"));
});

test("the map beside the art: one this tool made is replaced; any other file of that name stops it, before anything is written", async () => {
  const dir = tmp();
  sheet(dir);
  fs.copyFileSync(path.join(NORMALS, "islands_n.png"), path.join(dir, "walk_n.png"));
  const before = listed(dir);
  for (const engine of ["godot", "unity", "texturepacker"]) {
    const r = await normals(dir, ["walk.png", "--engine", engine]);
    assert.equal(r.code, EXIT.BAD_INPUT, engine);
    assert.match(r.out.error.message, /walk_n\.png is beside the art and has no stamp from ludo toolbox image normals \(made before 0\.2\.5, or with another tool\), so it is not replaced/);
    assert.match(r.out.error.hint, /If it is a map this tool made earlier, delete it and run this again/);
    assert.deepEqual(listed(dir), before, `${engine}: nothing written`);
  }
  // A PNG that is not the art (webp) with --engine: an error, nothing written.
  fs.writeFileSync(path.join(dir, "walk.webp"), encodeWebp(figures()));
  const webp = await normals(dir, ["walk.webp", "--engine", "godot"]);
  assert.equal(webp.code, EXIT.USAGE);
  assert.match(webp.out.error.message, /Engine files point at a PNG/);
  assert.deepEqual(listed(dir), [...before, "walk.webp"].sort());

  // On a file system that ignores case, walk_N.png (a sprite facing north) is walk_n.png.
  const north = tmp();
  sheet(north);
  sheet(north, "walk_N.png");
  if (fs.existsSync(path.join(north, "walk_n.png"))) {
    const r = await normals(north, ["walk.png", "--engine", "godot"]);
    assert.equal(r.code, EXIT.BAD_INPUT);
    assert.match(r.out.error.message, /walk_N\.png is beside the art, and this file system takes it for walk_n\.png/);
    // sprite export does not take it for the map either.
    const e = await exportSheet(north, ["walk.png", "--engine", "godot"]);
    assert.deepEqual([e.code, e.out.normal_map, e.out.notes], [0, undefined, undefined]);
  }

  // The size-mismatch hint, followed, clears the error.
  const stale = tmp();
  sheet(stale);
  still(stale, "tmp.png");
  await normals(stale, ["tmp.png", "--engine", "godot"]);
  fs.renameSync(path.join(stale, "tmp_n.png"), path.join(stale, "walk_n.png"));
  const bad = await exportSheet(stale, ["walk.png", "--engine", "godot"]);
  assert.equal(bad.code, EXIT.BAD_INPUT);
  const command = /ludo toolbox image normals \S+ --engine godot/.exec(bad.out.error.hint)[0];
  const fix = await normals(stale, command.split(" ").slice(4));
  assert.deepEqual([fix.code, fix.out.replaced], [0, true]);
  const ok = await exportSheet(stale, ["walk.png", "--engine", "godot"]);
  assert.deepEqual([ok.code, ok.out.normal_map], [0, "walk_n.png"]);
});

test("sprite export: the map has to be where the engine finds it; --normal-map is not the sheet; TexturePacker never fails on one", async () => {
  // Godot: a map outside the art's project, or in another one inside it.
  const game = tmp();
  fs.writeFileSync(path.join(game, "project.godot"), "config_version=5\n");
  fs.mkdirSync(path.join(game, "art"));
  sheet(path.join(game, "art"));
  const outside = tmp();
  await normals(path.join(game, "art"), ["walk.png"]);
  fs.renameSync(path.join(game, "art", "ludo-output", "walk_n.png"), path.join(outside, "walk_n.png"));
  const before = listed(path.join(game, "art"));
  const o = await exportSheet(game, ["art/walk.png", "--engine", "godot", "--normal-map", path.join(outside, "walk_n.png")]);
  assert.equal(o.code, EXIT.BAD_INPUT);
  assert.match(o.out.error.message, /is outside the Godot project of art\/walk\.png/);
  assert.deepEqual(listed(path.join(game, "art")), before, "nothing written");
  fs.mkdirSync(path.join(game, "art", "nested"));
  fs.writeFileSync(path.join(game, "art", "nested", "project.godot"), "config_version=5\n");
  fs.copyFileSync(path.join(outside, "walk_n.png"), path.join(game, "art", "nested", "walk_n.png"));
  const nested = await exportSheet(game, ["art/walk.png", "--engine", "godot", "--normal-map", "art/nested/walk_n.png"]);
  assert.equal(nested.code, EXIT.BAD_INPUT);
  assert.match(nested.out.error.message, /in another Godot project/);
  // In the same project, elsewhere: a res:// path.
  fs.mkdirSync(path.join(game, "maps"));
  fs.copyFileSync(path.join(outside, "walk_n.png"), path.join(game, "maps", "walk_n.png"));
  const inside = await exportSheet(game, ["art/walk.png", "--engine", "godot", "--normal-map", "maps/walk_n.png"]);
  assert.equal(inside.code, 0, inside.stderr);
  assert.match(read(game, inside.out.engine_files[0]), /path="res:\/\/maps\/walk_n\.png" id="2_normal"/);

  // Unity: the map under the art's project's Assets.
  const project = tmp();
  fs.mkdirSync(path.join(project, "ProjectSettings"));
  fs.writeFileSync(path.join(project, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 6000.3.3f1\n");
  fs.mkdirSync(path.join(project, "Assets"));
  sheet(path.join(project, "Assets"));
  const u = await exportSheet(project, ["Assets/walk.png", "--engine", "unity", "--normal-map", path.join(outside, "walk_n.png")]);
  assert.equal(u.code, EXIT.BAD_INPUT);
  assert.match(u.out.error.message, /is not under the Assets folder of Assets\/walk\.png's Unity project/);
  assert.ok(!fs.existsSync(path.join(project, "Assets", "walk.png.meta")));
  fs.copyFileSync(path.join(outside, "walk_n.png"), path.join(project, "Assets", "lit.png"));
  const uok = await exportSheet(project, ["Assets/walk.png", "--engine", "unity", "--normal-map", "Assets/lit.png"]);
  assert.equal(uok.code, 0, uok.stderr);

  // --normal-map naming the sheet itself.
  const self = await exportSheet(project, ["Assets/walk.png", "--engine", "godot", "--normal-map", "Assets/walk.png"]);
  assert.equal(self.code, EXIT.USAGE);
  assert.match(self.out.error.message, /--normal-map names the sheet itself/);

  // TexturePacker: a beside map of the wrong size is not this run's concern
  // (exit 0, the output as without it); a fitting one is mentioned.
  const tp = tmp();
  sheet(tp);
  const plain = await exportSheet(tp, ["walk.png", "--engine", "texturepacker"]);
  fs.copyFileSync(path.join(NORMALS, "islands_n.png"), path.join(tp, "walk_n.png"));
  const wrong = await exportSheet(tp, ["walk.png", "--engine", "texturepacker"]);
  assert.equal(wrong.code, 0, wrong.stderr);
  assert.deepEqual(Object.keys(wrong.out), Object.keys(plain.out));
  sheet(tp, "walk_n.png");
  const picture = await exportSheet(tp, ["walk.png", "--engine", "texturepacker"]);
  assert.deepEqual(Object.keys(picture.out), Object.keys(plain.out), "a picture named _n: not mentioned");
  fs.rmSync(path.join(tp, "walk_n.png"));
  await normals(tp, ["walk.png", "--engine", "texturepacker"]);
  const fits = await exportSheet(tp, ["walk.png", "--engine", "texturepacker"]);
  assert.equal(fits.out.normal_map, "walk_n.png");
  assert.match(fits.out.notes[0], /normalMap: "walk_n\.png"/);
  // Given explicitly, a wrong size is still an error.
  fs.copyFileSync(path.join(NORMALS, "islands_n.png"), path.join(tp, "small.png"));
  const given = await exportSheet(tp, ["walk.png", "--engine", "texturepacker", "--normal-map", "small.png"]);
  assert.equal(given.code, EXIT.BAD_INPUT);
});

test("sprite export picks up the map beside the sheet and wires it in; a picture named _n is left out", async () => {
  const dir = tmp();
  sheet(dir);
  const before = await exportSheet(dir, ["walk.png", "--engine", "godot"]);
  assert.equal(before.out.normal_map, undefined);
  assert.doesNotMatch(read(dir, "walk.tres"), /CanvasTexture|2_normal/);
  await normals(dir, ["walk.png", "--engine", "godot"]);
  const found = await exportSheet(dir, ["walk.png", "--engine", "godot", "--pivot", "feet"]);
  assert.deepEqual([found.out.normal_map, found.out.normal_map_from], ["walk_n.png", "beside"]);
  assert.match(read(dir, found.out.engine_files[0]), /normal_texture = ExtResource\("2_normal"\)/);
  const none = await exportSheet(dir, ["walk.png", "--engine", "godot", "--no-normal-map"]);
  assert.doesNotMatch(read(dir, none.out.engine_files[0]), /CanvasTexture/);
  const both = await exportSheet(dir, ["walk.png", "--engine", "godot", "--normal-map", "walk_n.png", "--no-normal-map"]);
  assert.equal(both.code, EXIT.USAGE);

  const north = tmp();
  sheet(north);
  sheet(north, "walk_n.png");
  const n = await exportSheet(north, ["walk.png", "--engine", "godot"]);
  assert.equal(n.out.normal_map, undefined);
  assert.match(n.out.notes[0], /walk_n\.png is beside the sheet but does not look like a normal map, so it is left out/);
  const forced = await exportSheet(north, ["walk.png", "--engine", "godot", "--normal-map", "walk_n.png"]);
  assert.equal(forced.out.normal_map, "walk_n.png");
  assert.match(forced.out.notes[0], /does not look like a normal map .* but it is used as one/);
});

// A sheet of figures standing on a ground strip as wide as the sheet:
// mapped as one image, the strip is one shape running through every cell.
function edgeSheet(dir, name = "walk.png") {
  const [w, h] = [96, 32];
  const rgba = new Uint8Array(w * h * 4);
  for (let f = 0; f < 4; f++) {
    for (let y = 0; y < h; y++) for (let x = 0; x < 24; x++) if ((y >= 4 && y < 26 && x >= 6 && x < 18) || (y >= 28 && y < 30)) rgba.set([180 - f * 20, 40 + y * 6, 30 + x * 5, 255], (y * w + f * 24 + x) * 4);
  }
  fs.writeFileSync(path.join(dir, name), encodePng({ width: w, height: h, rgba }));
}

test("with --engine the map is made frame by frame on the grid the engine files use, and says so", async () => {
  const dir = tmp();
  edgeSheet(dir);
  const g = await normals(dir, ["walk.png", "--engine", "godot"]);
  assert.equal(g.code, 0, g.stderr);
  assert.deepEqual(g.out.grid, { cols: 4, rows: 1, frames: 4, frame_width: 24, frame_height: 32, fps: 10 });
  assert.match(read(dir, "walk.tres"), /AtlasTexture_3/);
  const map = fs.readFileSync(path.join(dir, "walk_n.png"));
  assert.deepEqual(JSON.parse(readText(map)["ludo:grid"]), { cols: 4, rows: 1, frames: 4, fps: 10 });
  const byGrid = await normals(dir, ["walk.png", "--grid", "4x1", "--out", "check"]);
  const whole = await normals(dir, ["walk.png", "--out", "whole"]);
  const rgba = f => Buffer.from(readPng(fs.readFileSync(path.join(dir, f))).image.rgba);
  assert.ok(rgba("walk_n.png").equals(rgba(byGrid.out.image)), "the --grid 4x1 map");
  assert.ok(!rgba("walk_n.png").equals(rgba(whole.out.image)), "not the one-image map");
});

test("nothing is written when a file to write is read-only; the error names no clip", async () => {
  const dir = tmp();
  sheet(dir);
  await normals(dir, ["walk.png", "--engine", "unity"]);
  const before = Object.fromEntries(listed(dir).map(f => [f, fs.readFileSync(path.join(dir, f))]));
  fs.chmodSync(path.join(dir, "walk_n.png.meta"), 0o444);
  const r = await normals(dir, ["walk.png", "--engine", "unity", "--normal-strength", "3"]);
  assert.equal(r.code, EXIT.BAD_INPUT);
  assert.match(r.out.error.message, /^Could not light walk\.png in Unity: .*walk_n\.png\.meta cannot be written/);
  assert.doesNotMatch(r.out.error.message, /AnimationClip/);
  for (const [f, buf] of Object.entries(before)) assert.ok(fs.readFileSync(path.join(dir, f)).equals(buf), `${f} unchanged`);

  // The second of two .tres read-only: the first is not touched either.
  const g = tmp();
  sheet(g);
  await exportSheet(g, ["walk.png", "--engine", "godot"]);
  await exportSheet(g, ["walk.png", "--engine", "godot"]);
  const tres = [read(g, "walk.tres"), read(g, "walk-2.tres")];
  fs.chmodSync(path.join(g, "walk-2.tres"), 0o444);
  const rg = await normals(g, ["walk.png", "--engine", "godot"]);
  assert.equal(rg.code, EXIT.BAD_INPUT);
  assert.deepEqual([read(g, "walk.tres"), read(g, "walk-2.tres")], tres);
  assert.ok(!fs.existsSync(path.join(g, "walk_n.png")), "no map either");
});

test("wiring the map in place of another says which one it was", async () => {
  // Godot: SpriteFrames sprite export lit with maps/lit.png.
  const dir = tmp();
  sheet(dir);
  fs.mkdirSync(path.join(dir, "maps"));
  await normals(dir, ["walk.png", "--out", "maps"]);
  fs.renameSync(path.join(dir, "maps", "walk_n.png"), path.join(dir, "maps", "lit.png"));
  await exportSheet(dir, ["walk.png", "--engine", "godot", "--normal-map", "maps/lit.png"]);
  const g = await normals(dir, ["walk.png", "--engine", "godot"]);
  assert.match(g.out.notes.join("\n"), /walk\.tres had maps\/lit\.png as its normal map: it now has walk_n\.png/);
  assert.match(read(dir, "walk.tres"), /path="walk_n\.png" id="2_normal"/);
  assert.doesNotMatch(read(dir, "walk.tres"), /lit\.png/);
  // Unity: the .meta listed another map's guid.
  const u = tmp();
  sheet(u);
  fs.copyFileSync(path.join(dir, "maps", "lit.png"), path.join(u, "lit.png"));
  await exportSheet(u, ["walk.png", "--engine", "unity", "--normal-map", "lit.png"]);
  const r = await normals(u, ["walk.png", "--engine", "unity"]);
  assert.match(r.out.notes.join("\n"), /walk\.png\.meta had lit\.png as its normal map: it now has walk_n\.png/);
  assert.equal((read(u, "walk.png.meta").match(/name: _NormalMap/g) ?? []).length, 1);
  // Named by the .meta that declares the guid, not the art's own, which
  // only refers to it (and sorts first here).
  const a = tmp();
  sheet(a, "aaa.png");
  fs.copyFileSync(path.join(dir, "maps", "lit.png"), path.join(a, "zz_lit.png"));
  await exportSheet(a, ["aaa.png", "--engine", "unity", "--normal-map", "zz_lit.png"]);
  const ra = await normals(a, ["aaa.png", "--engine", "unity"]);
  assert.match(ra.out.notes.join("\n"), /aaa\.png\.meta had zz_lit\.png as its normal map: it now has aaa_n\.png/);
});

test("a DirectX map on an older Unity .meta without Flip Green Channel is not claimed to be flipped", async () => {
  const dir = tmp();
  still(dir);
  await normals(dir, ["rock.png", "--engine", "unity"]);
  fs.writeFileSync(path.join(dir, "rock_n.png.meta"), read(dir, "rock_n.png.meta").replace("    flipGreenChannel: 0\n", ""));
  const r = await normals(dir, ["rock.png", "--engine", "unity", "--normal-format", "directx"]);
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(read(dir, "rock_n.png.meta"), /flipGreenChannel/);
  assert.match(r.out.notes.join("\n"), /rock_n\.png is a DirectX normal map, and its \.meta .* cannot flip it, so Unity reads it upside down: make it again without --normal-format directx/);
  assert.doesNotMatch(r.out.notes.join("\n"), /turns on Flip Green Channel/);
});

test("a map made here but retouched since (its stamp kept, its pixels not) is not replaced", async () => {
  const dir = tmp();
  still(dir);
  await normals(dir, ["rock.png", "--engine", "godot"]);
  const buf = fs.readFileSync(path.join(dir, "rock_n.png"));
  const { image } = readPng(buf);
  image.rgba[0] ^= 1;
  // An editor that keeps the PNG's text, the stamp too.
  fs.writeFileSync(path.join(dir, "rock_n.png"), encodePng(image, { chunks: [textChunk("ludo:normal", readText(buf)["ludo:normal"])] }));
  const retouched = fs.readFileSync(path.join(dir, "rock_n.png"));
  const r = await normals(dir, ["rock.png", "--engine", "godot"]);
  assert.equal(r.code, EXIT.BAD_INPUT);
  assert.match(r.out.error.message, /rock_n\.png is beside the art, made by ludo toolbox image normals but changed since/);
  assert.ok(fs.readFileSync(path.join(dir, "rock_n.png")).equals(retouched));
  // sprite export still uses it, as a map; its size-mismatch hint would not promise a replace.
  const e = await exportSheet(dir, ["rock.png", "--grid", "1x1", "--engine", "godot"]);
  assert.equal(e.out.normal_map, "rock_n.png");
});

test("the map is made on the grid of the engine files it patches, and a TileSet is lit through its tiles", async () => {
  // Detection says 4x1; the files there cut 2x1: the map follows the files.
  for (const engine of ["godot", "unity"]) {
    const dir = tmp();
    edgeSheet(dir);
    await exportSheet(dir, ["walk.png", "--engine", engine, "--grid", "2x1"]);
    const n = await normals(dir, ["walk.png", "--engine", engine]);
    assert.equal(n.code, 0, n.stderr);
    assert.deepEqual([n.out.grid.cols, n.out.grid.rows], [2, 1], engine);
    assert.equal(n.out.notes?.filter(x => /grid/.test(x)).length ?? 0, 0, `${engine}: files that agree need no note`);
    const byGrid = await normals(dir, ["walk.png", "--grid", "2x1", "--out", "check"]);
    const rgba = f => Buffer.from(readPng(fs.readFileSync(path.join(dir, f))).image.rgba);
    assert.ok(rgba("walk_n.png").equals(rgba(byGrid.out.image)), `${engine}: the --grid 2x1 map`);
  }
  // Two SpriteFrames that disagree: the one most of them cut, and a note.
  const both = tmp();
  edgeSheet(both);
  await exportSheet(both, ["walk.png", "--engine", "godot", "--grid", "2x1"]);
  await exportSheet(both, ["walk.png", "--engine", "godot", "--grid", "2x1"]);
  await exportSheet(both, ["walk.png", "--engine", "godot", "--grid", "4x1"]);
  const b = await normals(both, ["walk.png", "--engine", "godot"]);
  assert.deepEqual([b.out.grid.cols, b.out.patched.length], [2, 3]);
  assert.match(b.out.notes.join("\n"), /The map follows the 2x1 grid of walk\.tres, walk-2\.tres; walk-3\.tres cuts it 4x1/);

  // A Godot TileSet made by image tiles: rewired, and the map made tile by tile.
  const t = tmp();
  edgeSheet(t, "ground.png");
  const tiles = await cli(t, ["toolbox", "image", "tiles", "ground.png", "--size", "24x32", "--engine", "godot"]);
  assert.equal(tiles.code, 0, tiles.stderr);
  const before = read(t, "ground.tres");
  const lit = await normals(t, ["ground.png", "--engine", "godot"]);
  assert.equal(lit.code, 0, lit.stderr);
  assert.deepEqual([lit.out.patched, lit.out.grid.cols, lit.out.grid.rows], [["ground.tres"], 4, 1]);
  assert.match(read(t, "ground.tres"), /^\[sub_resource type="CanvasTexture" id="CanvasTexture_lit"\]\ndiffuse_texture = ExtResource\("1_tiles"\)\nnormal_texture = ExtResource\("2_normal"\)$/m);
  assert.match(read(t, "ground.tres"), /^texture = SubResource\("CanvasTexture_lit"\)$/m);
  assert.equal(read(t, "ground.tres").replace(/\[ext_resource[^\n]*2_normal[^\n]*\n/, "").replace(/\[sub_resource type="CanvasTexture"[^]*?\n\n/, "").replace(/^texture = SubResource\("CanvasTexture_lit"\)$/m, 'texture = ExtResource("1_tiles")'), before);
  // Tiles with spacing are no grid, but each is mapped on its own.
  const sp = tmp();
  sheet(sp, "ground.png", false);
  await cli(sp, ["toolbox", "image", "tiles", "ground.png", "--size", "22x32", "--spacing", "2", "--engine", "godot"]);
  const s2 = await normals(sp, ["ground.png", "--engine", "godot"]);
  assert.equal(s2.code, 0, s2.stderr);
  assert.deepEqual([s2.out.grid, s2.out.tiles, s2.out.patched], [undefined, 4, ["ground.tres"]]);
  assert.match(s2.out.notes.join("\n"), /The map is made tile by tile, on the 4 tiles of ground\.tres \(its tiles have margins or spacing\)/);
  const { normalMap, NORMAL_DEFAULTS } = await import("../dist/toolbox/normals.js");
  const { crop, blit } = await import("../dist/toolbox/sheet.js");
  const art = readPng(fs.readFileSync(path.join(sp, "ground.png"))).image;
  const want = { width: 96, height: 32, rgba: new Uint8Array(96 * 32 * 4) };
  for (let i = 0; i < 96 * 32; i++) want.rgba.set([128, 128, 255, art.rgba[i * 4 + 3]], i * 4);
  for (let c = 0; c < 4; c++) blit(want, normalMap(crop(art, { x: c * 24, y: 0, w: 22, h: 32 }), NORMAL_DEFAULTS), c * 24, 0);
  assert.ok(Buffer.from(readPng(fs.readFileSync(path.join(sp, "ground_n.png"))).image.rgba).equals(Buffer.from(want.rgba)), "each tile mapped on its own");
  // Art in the spacing (the ground strip runs through it): the tiles are
  // not the whole art, said so, and the map's grid is detected instead.
  const st = tmp();
  edgeSheet(st, "ground.png");
  await cli(st, ["toolbox", "image", "tiles", "ground.png", "--size", "22x32", "--spacing", "2", "--engine", "godot"]);
  const s3 = await normals(st, ["ground.png", "--engine", "godot"]);
  assert.match(s3.out.notes.join("\n"), /ground\.tres: there is art outside its tiles, so they are not a grid of the whole art\. The map follows the 4x1 grid detection finds instead\./);
  assert.deepEqual([s3.out.grid.cols, s3.out.grid.rows], [4, 1]);
});

test("frames that cut only part of a packed atlas are not its grid; a standalone AtlasTexture is lit too", async () => {
  // A 64x64 atlas: a 12x12 coin and a 56x40 sprite; atlas.tres cuts the coin.
  const dir = tmp();
  const rgba = new Uint8Array(64 * 64 * 4);
  for (let y = 2; y < 14; y++) for (let x = 2; x < 14; x++) rgba.set([230, 190, 40, 255], (y * 64 + x) * 4);
  for (let y = 20; y < 60; y++) for (let x = 4; x < 60; x++) rgba.set([60 + x, 120, 200 - y, 255], (y * 64 + x) * 4);
  fs.writeFileSync(path.join(dir, "atlas.png"), encodePng({ width: 64, height: 64, rgba }));
  const frames = '[gd_resource type="SpriteFrames" format=3]\n\n[ext_resource type="Texture2D" path="atlas.png" id="1"]\n\n[sub_resource type="AtlasTexture" id="A"]\natlas = ExtResource("1")\nregion = Rect2(0, 0, 16, 16)\n\n[resource]\nanimations = [{\n"frames": [{\n"duration": 1.0,\n"texture": SubResource("A")\n}],\n"loop": true,\n"name": &"coin",\n"speed": 5.0\n}]\n';
  fs.writeFileSync(path.join(dir, "atlas.tres"), frames);
  // And a standalone AtlasTexture of the sprite.
  const sprite = '[gd_resource type="AtlasTexture" format=3]\n\n[ext_resource type="Texture2D" path="atlas.png" id="1"]\n\n[resource]\natlas = ExtResource("1")\nregion = Rect2(0, 16, 64, 48)\n';
  fs.writeFileSync(path.join(dir, "ship.tres"), sprite);
  const r = await normals(dir, ["atlas.png", "--engine", "godot"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.out.grid, undefined, "mapped as one image");
  assert.match(r.out.notes.join("\n"), /atlas\.tres: there is art outside its frames, so they are not a grid of the whole art/);
  const whole = await normals(dir, ["atlas.png", "--out", "whole"]);
  const rgbaOf = f => Buffer.from(readPng(fs.readFileSync(path.join(dir, f))).image.rgba);
  assert.ok(rgbaOf("atlas_n.png").equals(rgbaOf(whole.out.image)));
  assert.equal(readText(fs.readFileSync(path.join(dir, "atlas_n.png")))["ludo:grid"], undefined, "no grid stamped");
  assert.deepEqual(r.out.patched, ["atlas.tres", "ship.tres"]);
  assert.equal(
    read(dir, "ship.tres"),
    sprite
      .replace('id="1"]\n', 'id="1"]\n[ext_resource type="Texture2D" path="atlas_n.png" id="2_normal"]\n')
      .replace('[resource]\natlas = ExtResource("1")', '[sub_resource type="CanvasTexture" id="CanvasTexture_lit"]\ndiffuse_texture = ExtResource("1")\nnormal_texture = ExtResource("2_normal")\n\n[resource]\natlas = SubResource("CanvasTexture_lit")')
  );
});

test("a replaced Unity wiring whose old map is gone is named as such", async () => {
  const dir = tmp();
  sheet(dir);
  await exportSheet(dir, ["walk.png", "--engine", "unity"]);
  const meta = read(dir, "walk.png.meta").replace("    secondaryTextures: []", "    secondaryTextures:\n    - texture: {fileID: 2800000, guid: 0123456789abcdef0123456789abcdef, type: 3}\n      name: _NormalMap");
  fs.writeFileSync(path.join(dir, "walk.png.meta"), meta);
  const r = await normals(dir, ["walk.png", "--engine", "unity"]);
  assert.match(r.out.notes.join("\n"), /walk\.png\.meta had an asset no longer beside the art \(guid 0123456789abcdef0123456789abcdef\) as its normal map: it now has walk_n\.png/);
});
