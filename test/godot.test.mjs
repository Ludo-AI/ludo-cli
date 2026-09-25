// Fast checks of the Godot SpriteFrames writer. The real-Godot load check is
// test/godot/run.sh (CI: .github/workflows/godot.yml).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spriteFramesTres, writeGodotSpriteFrames, findGodotProject, godotTexturePath } from "../dist/tty/godot.js";

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
