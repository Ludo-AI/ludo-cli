// Fast checks of the Godot SpriteFrames writer. The real-Godot load check is
// test/godot/run.sh (CI: .github/workflows/godot.yml).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { animatedSpriteScene, canvasTextureTres, rewireTres, tresSlicing, spriteFramesTres, writeGodotCanvasTexture, writeGodotScene, writeGodotSpriteFrames, findGodotProject, godotNeighbourPath, godotTexturePath } from "../dist/tty/godot.js";
import { encodePng } from "../dist/tty/png.js";
import { godotTileSet, tileLayout, tileRects } from "../dist/toolbox/tiles.js";

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ludo-godot-test-"));
}

test("snapshot: 2x2 grid with 3 frames", () => {
  const tres = spriteFramesTres("res://sprites/hero.png", 64, 32, { cols: 2, rows: 2, frames: 3, fps: 12 });
  assert.equal(
    tres,
    `[gd_resource type="SpriteFrames" format=3]

[ext_resource type="Texture2D" path="res://sprites/hero.png" id="1_sheet"]

[sub_resource type="AtlasTexture" id="AtlasTexture_0"]
atlas = ExtResource("1_sheet")
region = Rect2(0, 0, 32, 16)

[sub_resource type="AtlasTexture" id="AtlasTexture_1"]
atlas = ExtResource("1_sheet")
region = Rect2(32, 0, 32, 16)

[sub_resource type="AtlasTexture" id="AtlasTexture_2"]
atlas = ExtResource("1_sheet")
region = Rect2(0, 16, 32, 16)

[resource]
animations = [{
"frames": [{
"duration": 1.0,
"texture": SubResource("AtlasTexture_0")
}, {
"duration": 1.0,
"texture": SubResource("AtlasTexture_1")
}, {
"duration": 1.0,
"texture": SubResource("AtlasTexture_2")
}],
"loop": true,
"name": &"default",
"speed": 12.0
}]
`,
  );
});

test("snapshot: a normal map puts the frames on a CanvasTexture of the sheet and the map", () => {
  const grid = { cols: 2, rows: 1, frames: 2, fps: 8 };
  const tres = spriteFramesTres("hero.png", 64, 32, grid, "walk", {}, "hero_n.png");
  assert.equal(
    tres,
    `[gd_resource type="SpriteFrames" format=3]

[ext_resource type="Texture2D" path="hero.png" id="1_sheet"]
[ext_resource type="Texture2D" path="hero_n.png" id="2_normal"]

[sub_resource type="CanvasTexture" id="CanvasTexture_lit"]
diffuse_texture = ExtResource("1_sheet")
normal_texture = ExtResource("2_normal")

[sub_resource type="AtlasTexture" id="AtlasTexture_0"]
atlas = SubResource("CanvasTexture_lit")
region = Rect2(0, 0, 32, 32)

[sub_resource type="AtlasTexture" id="AtlasTexture_1"]
atlas = SubResource("CanvasTexture_lit")
region = Rect2(32, 0, 32, 32)

[resource]
animations = [{
"frames": [{
"duration": 1.0,
"texture": SubResource("AtlasTexture_0")
}, {
"duration": 1.0,
"texture": SubResource("AtlasTexture_1")
}],
"loop": true,
"name": &"walk",
"speed": 8.0
}]
`
  );
  // Without a map it is the plain SpriteFrames, byte for byte.
  assert.equal(
    spriteFramesTres("hero.png", 64, 32, grid, "walk"),
    tres.replace(/\[ext_resource[^\n]*2_normal[^\n]*\n/, "").replace(/\[sub_resource type="CanvasTexture"[^]*?\n\n/, "").replaceAll('SubResource("CanvasTexture_lit")', 'ExtResource("1_sheet")')
  );
  assert.equal(
    canvasTextureTres("boss.png", "boss_n.png"),
    `[gd_resource type="CanvasTexture" format=3]

[ext_resource type="Texture2D" path="boss.png" id="1_sheet"]
[ext_resource type="Texture2D" path="boss_n.png" id="2_normal"]

[resource]
diffuse_texture = ExtResource("1_sheet")
normal_texture = ExtResource("2_normal")
`
  );
});

test("rewireTres lights a .tres that uses the art, whoever wrote it, and leaves every other byte", () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, "project.godot"), "config_version=5\n");
  const art = path.join(dir, "art", "hero.png");
  const map = path.join(dir, "art", "hero_n.png");
  fs.mkdirSync(path.dirname(art));
  const tres = path.join(dir, "art", "hero.tres");
  const grid = { cols: 3, rows: 2, frames: 5, fps: 7.5, loop: false };
  const layout = { trim: { x: 3, y: 2, w: 12, h: 10, source_w: 20, source_h: 16 }, extrude: 2 };
  // Ours, plain: the very file spriteFramesTres writes with the map; again: the same.
  const plain = spriteFramesTres("res://art/hero.png", 48, 28, grid, 'say "hi"', layout);
  const lit = spriteFramesTres("res://art/hero.png", 48, 28, grid, 'say "hi"', layout, "res://art/hero_n.png");
  assert.deepEqual(rewireTres(plain, tres, art, map), { text: lit });
  assert.deepEqual(rewireTres(lit, tres, art, map), { text: lit });
  // Lit with another map (sprite export --normal-map): replaced, and said.
  const other = spriteFramesTres("res://art/hero.png", 48, 28, grid, "x", {}, "res://maps/lit.png");
  assert.deepEqual(rewireTres(other, tres, art, map), { text: other.replace("res://maps/lit.png", "res://art/hero_n.png"), oldNormal: "res://maps/lit.png" });
  // Another art's file: not this run's.
  assert.equal(rewireTres(plain, tres, path.join(dir, "art", "hero-2.png"), map), undefined);

  // As Godot saves it back (4.7 with uids; load_steps as before 4.5; no
  // last newline; "loop": 1; its own ids; a frame on the bare texture).
  const saved = [
    '[gd_resource type="SpriteFrames" load_steps=4 format=3 uid="uid://b1n8m3a5cayqf"]',
    "",
    '[ext_resource type="Texture2D" uid="uid://c5tm5u5xdsovp" path="res://art/hero.png" id="1_p3elh"]',
    '[ext_resource type="Texture2D" uid="uid://dother" path="res://art/other.png" id="2_q1"]',
    "",
    '[sub_resource type="AtlasTexture" id="AtlasTexture_0"]',
    'atlas = ExtResource("1_p3elh")',
    "region = Rect2(0, 0, 16, 14)",
    "",
    '[sub_resource type="AtlasTexture" id="AtlasTexture_1"]',
    'atlas = ExtResource("2_q1")',
    "region = Rect2(0, 0, 8, 8)",
    "",
    "[resource]",
    'animations = [{\n"frames": [{\n"duration": 1.0,\n"texture": SubResource("AtlasTexture_0")\n}, {\n"duration": 1.0,\n"texture": ExtResource("1_p3elh")\n}, {\n"duration": 1.0,\n"texture": SubResource("AtlasTexture_1")\n}],\n"loop": 1,\n"name": &"default",\n"speed": 5.0\n}]'
  ].join("\n");
  const r = rewireTres(saved, tres, art, map, "uid://cmap");
  assert.equal(
    r.text,
    saved
      .replace("load_steps=4", "load_steps=6")
      .replace('id="1_p3elh"]\n', 'id="1_p3elh"]\n[ext_resource type="Texture2D" uid="uid://cmap" path="res://art/hero_n.png" id="2_normal"]\n')
      .replace('[sub_resource type="AtlasTexture" id="AtlasTexture_0"]', '[sub_resource type="CanvasTexture" id="CanvasTexture_lit"]\ndiffuse_texture = ExtResource("1_p3elh")\nnormal_texture = ExtResource("2_normal")\n\n[sub_resource type="AtlasTexture" id="AtlasTexture_0"]')
      .replace('"texture": ExtResource("1_p3elh")', '"texture": SubResource("CanvasTexture_lit")')
      .replace('atlas = ExtResource("1_p3elh")', 'atlas = SubResource("CanvasTexture_lit")')
  );
  assert.equal(r.oldNormal, undefined);
  // Without a uid for the map, its ext_resource has none.
  assert.match(rewireTres(saved, tres, art, map).text, /\[ext_resource type="Texture2D" path="res:\/\/art\/hero_n\.png" id="2_normal"\]/);
  // Again on the rewired file: the same.
  assert.equal(rewireTres(r.text, tres, art, map, "uid://cmap").text, r.text);

  // CanvasTextures: ours, and one Godot wrote.
  assert.deepEqual(rewireTres(canvasTextureTres("res://art/hero.png", "res://art/old_n.png"), tres, art, map), { text: canvasTextureTres("res://art/hero.png", "res://art/hero_n.png"), oldNormal: "res://art/old_n.png" });
  const godotCanvas = '[gd_resource type="CanvasTexture" format=3 uid="uid://x"]\n\n[ext_resource type="Texture2D" uid="uid://c5" path="res://art/hero.png" id="1_ab"]\n\n[resource]\ndiffuse_texture = ExtResource("1_ab")\ntexture_filter = 1\n';
  assert.equal(
    rewireTres(godotCanvas, tres, art, map).text,
    godotCanvas.replace('id="1_ab"]\n', 'id="1_ab"]\n[ext_resource type="Texture2D" path="res://art/hero_n.png" id="2_normal"]\n').replace('diffuse_texture = ExtResource("1_ab")\n', 'diffuse_texture = ExtResource("1_ab")\nnormal_texture = ExtResource("2_normal")\n')
  );
  // What it cannot rewire: refused, with why.
  assert.deepEqual(rewireTres('[gd_resource type="StyleBoxTexture" format=3]\n\n[ext_resource type="Texture2D" path="res://art/hero.png" id="1"]\n\n[resource]\ntexture = ExtResource("1")\n', tres, art, map), { refused: "a StyleBoxTexture, not a SpriteFrames, TileSet, AtlasTexture or CanvasTexture", type: "StyleBoxTexture" });
  // A TileSet (image tiles --engine godot): its atlas source's texture.
  const tiles = tileLayout(64, 32, 16, 16, 0, 0);
  const tileset = godotTileSet("res://art/hero.png", tiles, tileRects(tiles));
  assert.equal(
    rewireTres(tileset, tres, art, map).text,
    tileset
      .replace(/^texture = ExtResource\("1_tiles"\)$/m, 'texture = SubResource("CanvasTexture_lit")')
      .replace('id="1_tiles"]\n', 'id="1_tiles"]\n[ext_resource type="Texture2D" path="res://art/hero_n.png" id="2_normal"]\n')
      .replace('[sub_resource type="TileSetAtlasSource"', '[sub_resource type="CanvasTexture" id="CanvasTexture_lit"]\ndiffuse_texture = ExtResource("1_tiles")\nnormal_texture = ExtResource("2_normal")\n\n[sub_resource type="TileSetAtlasSource"')
  );
  assert.deepEqual(tresSlicing(tileset, tres, art), { tiles: { w: 16, h: 16, margin: 0, separation: 0, coords: [[0, 0], [1, 0], [2, 0], [3, 0], [0, 1], [1, 1], [2, 1], [3, 1]] } });
  assert.deepEqual(tresSlicing(saved, tres, art), { rects: [{ x: 0, y: 0, w: 16, h: 14 }] });
  // Outside a project, a relative path.
  const loose = tmpdir();
  const looseArt = path.join(loose, "boss.png");
  assert.equal(rewireTres(canvasTextureTres("boss.png", "old.png"), path.join(loose, "boss.tres"), looseArt, path.join(loose, "boss_n.png")).text, canvasTextureTres("boss.png", "boss_n.png"));
});

test("the normal map's path: beside the sheet its name, elsewhere relative, in a project res://", () => {
  const dir = tmpdir();
  const sheet = path.join(dir, "art", "hero.png");
  assert.equal(godotNeighbourPath(sheet, path.join(dir, "art", "hero_n.png")), "hero_n.png");
  assert.equal(godotNeighbourPath(sheet, path.join(dir, "maps", "hero_n.png")), "../maps/hero_n.png");
  fs.writeFileSync(path.join(dir, "project.godot"), "config_version=5\n");
  assert.equal(godotNeighbourPath(sheet, path.join(dir, "maps", "hero_n.png")), "res://maps/hero_n.png");
  fs.mkdirSync(path.join(dir, "art"));
  const still = writeGodotCanvasTexture(sheet, path.join(dir, "art", "hero_n.png"));
  assert.equal(path.basename(still), "hero.tres");
  assert.match(fs.readFileSync(still, "utf8"), /path="res:\/\/art\/hero_n.png" id="2_normal"/);
  assert.equal(path.basename(writeGodotCanvasTexture(sheet, path.join(dir, "art", "hero_n.png"))), "hero-2.tres", "never overwrites");
});

test("animation name, loop=false and fractional fps", () => {
  const tres = spriteFramesTres("a.png", 8, 8, { cols: 1, rows: 1, frames: 1, fps: 7.5, loop: false }, 'run "fast"');
  assert.match(tres, /"loop": false,/);
  assert.match(tres, /"name": &"run \\"fast\\"",/);
  assert.match(tres, /"speed": 7\.5\n/);
});

test("escapes quotes and backslashes in the texture path", () => {
  const tres = spriteFramesTres('we"ird\\name.png', 8, 8, { cols: 1, rows: 1, frames: 1, fps: 1 });
  assert.match(tres, /path="we\\"ird\\\\name\.png"/);
});

test("rejects grids that do not divide the sheet or do not fit", () => {
  const grid = { cols: 3, rows: 2, frames: 6, fps: 10 };
  assert.throws(() => spriteFramesTres("x.png", 100, 64, grid), /does not divide/);
  assert.throws(() => spriteFramesTres("x.png", 96, 63, grid), /does not divide/);
  assert.throws(() => spriteFramesTres("x.png", 96, 64, { ...grid, frames: 7 }), /do not fit/);
  assert.throws(() => spriteFramesTres("x.png", 96, 64, { ...grid, frames: 0 }), /frames/);
  assert.throws(() => spriteFramesTres("x.png", 96, 64, { ...grid, cols: 1.5 }), /cols/);
  assert.throws(() => spriteFramesTres("x.png", 96, 64, { ...grid, fps: 0 }), /fps/);
  assert.throws(() => spriteFramesTres("x.png", 96, 64, { ...grid, fps: NaN }), /fps/);
});

test("outside a Godot project the texture path is the sheet's file name", () => {
  const dir = tmpdir();
  try {
    const sheet = path.join(dir, "hero.png");
    fs.writeFileSync(sheet, "");
    assert.equal(findGodotProject(dir), undefined);
    assert.equal(godotTexturePath(sheet), "hero.png");
    const tres = writeGodotSpriteFrames(sheet, 32, 16, { cols: 2, rows: 1, frames: 2, fps: 8 });
    assert.equal(tres, path.join(dir, "hero.tres"));
    assert.match(fs.readFileSync(tres, "utf8"), /path="hero\.png"/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("inside a Godot project the texture path is res:// relative to project.godot", () => {
  const dir = tmpdir();
  try {
    fs.writeFileSync(path.join(dir, "project.godot"), "config_version=5\n");
    const sub = path.join(dir, "art", "my sprites");
    fs.mkdirSync(sub, { recursive: true });
    const sheet = path.join(sub, "hero.png");
    fs.writeFileSync(sheet, "");
    assert.equal(findGodotProject(sub), dir);
    assert.equal(godotTexturePath(sheet), "res://art/my sprites/hero.png");
    const tres = writeGodotSpriteFrames(sheet, 32, 16, { cols: 2, rows: 1, frames: 2, fps: 8 });
    assert.match(fs.readFileSync(tres, "utf8"), /path="res:\/\/art\/my sprites\/hero\.png"/);
    // A sheet at the project root.
    const rootSheet = path.join(dir, "root.png");
    assert.equal(godotTexturePath(rootSheet), "res://root.png");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("never overwrites: adds -2, -3 like the CLI's downloads", () => {
  const dir = tmpdir();
  try {
    const sheet = path.join(dir, "walk.png");
    fs.writeFileSync(sheet, "");
    fs.writeFileSync(path.join(dir, "walk.tres"), "mine");
    const grid = { cols: 1, rows: 1, frames: 1, fps: 1 };
    assert.equal(writeGodotSpriteFrames(sheet, 8, 8, grid), path.join(dir, "walk-2.tres"));
    assert.equal(writeGodotSpriteFrames(sheet, 8, 8, grid), path.join(dir, "walk-3.tres"));
    assert.equal(fs.readFileSync(path.join(dir, "walk.tres"), "utf8"), "mine");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("IO failures surface as a plain Error with a clear message", () => {
  const dir = tmpdir();
  try {
    const sheet = path.join(dir, "missing-dir", "x.png");
    assert.throws(
      () => writeGodotSpriteFrames(sheet, 8, 8, { cols: 1, rows: 1, frames: 1, fps: 1 }),
      err => err instanceof Error && /Could not write Godot SpriteFrames .*x\.tres: ENOENT/.test(err.message),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a pivot comes as an AnimatedSprite2D scene whose offset puts it at the node's origin", () => {
  const grid = { cols: 2, rows: 2, frames: 3, fps: 8 };
  assert.equal(
    animatedSpriteScene("walk.tres", "walk", 64, 64, grid, { x: 10, y: 30 }, "walk"),
    [
      `[gd_scene format=3]`,
      ``,
      `[ext_resource type="SpriteFrames" path="walk.tres" id="1_frames"]`,
      ``,
      `[node name="walk" type="AnimatedSprite2D"]`,
      `sprite_frames = ExtResource("1_frames")`,
      `animation = &"walk"`,
      `autoplay = "walk"`,
      `offset = Vector2(6, -14)`,
      ``
    ].join("\n")
  );
  // Trimmed and extruded: Godot draws the untrimmed 20x16 frame.
  const layout = { trim: { x: 3, y: 2, w: 12, h: 10, source_w: 20, source_h: 16 }, extrude: 2 };
  assert.match(animatedSpriteScene("p.tres", "a.b", 48, 28, { cols: 3, rows: 2, frames: 5, fps: 8 }, { x: 11, y: 15 }, "default", layout), /\[node name="a_b" type="AnimatedSprite2D"\][^]*offset = Vector2\(-1, -7\)/);
  const dir = tmpdir();
  const tres = path.join(dir, "walk.tres");
  fs.writeFileSync(tres, "");
  assert.equal(path.basename(writeGodotScene(tres, 64, 64, grid, { x: 10, y: 30 })), "walk.tscn");
  assert.equal(path.basename(writeGodotScene(tres, 64, 64, grid, { x: 10, y: 30 })), "walk-2.tscn");
});

test("ludo toolbox sprite export --engine godot --pivot feet writes the scene too", async () => {
  const dir = tmpdir();
  const cli = path.join(import.meta.dirname, "..", "dist", "cli.js");
  const fig = { width: 64, height: 32, rgba: new Uint8Array(64 * 32 * 4) };
  for (let y = 4; y < 28; y++) for (let x = 0; x < 64; x++) if (x % 32 >= 8 && x % 32 < 24) fig.rgba.set([200, 60, 40, 255], (y * 64 + x) * 4);
  fs.writeFileSync(path.join(dir, "stand.png"), encodePng(fig));
  const env = { ...process.env, LUDO_CONFIG_DIR: dir, LUDO_TELEMETRY: "0" };
  const out = JSON.parse((await promisify(execFile)(process.execPath, [cli, "toolbox", "sprite", "export", "stand.png", "--grid", "2x1", "--engine", "godot", "--pivot", "feet", "--json"], { env, cwd: dir })).stdout);
  assert.deepEqual(out.engine_files, ["stand.tres", "stand.tscn"]);
  assert.match(fs.readFileSync(path.join(dir, "stand.tscn"), "utf8"), /path="stand.tres"[^]*offset = Vector2\(0, -12\)/);
  // One node per sheet: the output says when one AnimatedSprite2D can hold a character's moves.
  assert.match(out.godot_scene, /one frame size and pivot/);
});
