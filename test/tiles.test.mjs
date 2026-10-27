// `ludo toolbox image tiles` and `repeat`. The Godot TileSet is also loaded
// by a real Godot in test/godot (run.sh, CI's Godot job).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { encodePng, readPng } from "../dist/tty/png.js";
import { tileLayout, tileRects, tiledTsx, godotTileSet, seams } from "../dist/toolbox/tiles.js";
import { readUnityMeta } from "../dist/tty/unity.js";

const exec = promisify(execFile);
const CLI = path.join(import.meta.dirname, "..", "dist", "cli.js");
const ludo = async (dir, args) => {
  try {
    const { stdout } = await exec(process.execPath, [CLI, "toolbox", "image", ...args, "--json"], { cwd: dir, env: { ...process.env, LUDO_TELEMETRY: "0", LUDO_CONFIG_DIR: path.join(dir, ".config") } });
    return { code: 0, out: JSON.parse(stdout) };
  } catch (err) {
    return { code: err.code, stderr: err.stderr };
  }
};

// 5x3 tiles of 12x10, 2 px apart, 3 px margin; every third tile empty.
function tileset(dir) {
  const [tw, th, sp, mg, cols, rows] = [12, 10, 2, 3, 5, 3];
  const width = mg * 2 + cols * (tw + sp) - sp;
  const height = mg * 2 + rows * (th + sp) - sp;
  const img = { width, height, rgba: new Uint8Array(width * height * 4) };
  for (const t of tileRects(tileLayout(width, height, tw, th, sp, mg))) {
    if ((t.col + t.row * cols) % 3 === 2) continue;
    for (let y = t.y; y < t.y + t.h; y++) for (let x = t.x; x < t.x + t.w; x++) img.rgba.set([t.col * 40, t.row * 70, 120, 255], (y * width + x) * 4);
  }
  fs.writeFileSync(path.join(dir, "tiles.png"), encodePng(img));
  return { width, height };
}

test("tile layout follows Tiled's count: floor((size - 2 margin + spacing) / (tile + spacing))", () => {
  const l = tileLayout(70, 39, 12, 10, 2, 3);
  // 70 - 6 + 2 = 66 holds 4 tiles of 14; 39 - 6 + 2 = 35, 2 of 12.
  assert.deepEqual([l.columns, l.rows], [4, 2]);
  const r = tileRects(l);
  assert.equal(r.length, 8);
  assert.deepEqual(r[5], { x: 17, y: 15, w: 12, h: 10, col: 1, row: 1 });
  assert.match(tiledTsx("t", "t.png", 70, 39, l), /tilewidth="12" tileheight="10" spacing="2" margin="3" tilecount="8" columns="4">\n <image source="t.png" width="70" height="39"\/>/);
  assert.match(godotTileSet("res://t.png", l, r.slice(0, 2)), /margins = Vector2i\(3, 3\)\nseparation = Vector2i\(2, 2\)\ntexture_region_size = Vector2i\(12, 10\)\n0:0\/0 = 0\n1:0\/0 = 0\n/);
});

test("tiles: split (empty skipped), --tiled, --engine godot and unity", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-tiles-"));
  const { width, height } = tileset(dir);
  const split = await ludo(dir, ["tiles", "tiles.png", "--size", "12x10", "--spacing", "2", "--margin", "3", "--out", dir]);
  assert.equal(split.code, 0, split.stderr);
  assert.deepEqual([split.out.columns, split.out.rows, split.out.tiles, split.out.empty, split.out.saved], [5, 3, 15, 5, 10]);
  const names = fs.readdirSync(path.resolve(dir, split.out.folder)).sort();
  assert.equal(names.length, 10);
  assert.equal(names[0], "tile-00.png");
  assert.ok(!names.includes("tile-02.png"), "an empty tile is skipped");
  const t6 = readPng(fs.readFileSync(path.resolve(dir, split.out.folder, "tile-06.png"))).image;
  assert.deepEqual([t6.width, t6.height, ...t6.rgba.subarray(0, 4)], [12, 10, 40, 70, 120, 255]);
  assert.match(split.out.hint.command, /repeat .*tile-00\.png$/);

  const files = await ludo(dir, ["tiles", "tiles.png", "--size", "12x10", "--spacing", "2", "--margin", "3", "--tiled", "--engine", "godot"]);
  assert.deepEqual(files.out.files, ["tiles.tsx", "tiles.tres"]);
  assert.equal(files.out.folder, undefined);
  assert.match(fs.readFileSync(path.join(dir, "tiles.tsx"), "utf8"), new RegExp(`tilecount="15" columns="5">\\n <image source="tiles.png" width="${width}" height="${height}"/>`));
  assert.equal((fs.readFileSync(path.join(dir, "tiles.tres"), "utf8").match(/^\d+:\d+\/0 = 0$/gm) ?? []).length, 10);

  const unity = await ludo(dir, ["tiles", "tiles.png", "--size", "12x10", "--spacing", "2", "--margin", "3", "--engine", "unity"]);
  assert.deepEqual(unity.out.files, ["tiles.png.meta"]);
  const meta = fs.readFileSync(path.join(dir, "tiles.png.meta"), "utf8");
  assert.equal(Object.keys(readUnityMeta(meta).fileIds).length, 10);
  // The first tile: x 3, and y counted from the bottom.
  assert.match(meta, new RegExp(`name: tiles_0\\n      rect:\\n        serializedVersion: 2\\n        x: 3\\n        y: ${height - 3 - 10}\\n        width: 12\\n        height: 10`));

  const bad = await ludo(dir, ["tiles", "tiles.png", "--size", "500"]);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /do not fit/);
  const tp = await ludo(dir, ["tiles", "tiles.png", "--size", "12x10", "--engine", "texturepacker"]);
  assert.match(tp.stderr, /not TexturePacker/);
});

test("repeat: a tile that wraps cleanly is seamless, one that does not shows its seam", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-repeat-"));
  const make = f => {
    const img = { width: 32, height: 32, rgba: new Uint8Array(32 * 32 * 4) };
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) img.rgba.set([...f(x, y), 255], (y * 32 + x) * 4);
    return img;
  };
  // A wave with whole periods across the tile, and a ramp that jumps back.
  const wave = make((x, y) => [128 + Math.round(100 * Math.sin((2 * Math.PI * x) / 16)), 128 + Math.round(100 * Math.cos((2 * Math.PI * y) / 32)), 90]);
  const ramp = make((x, y) => [x * 8, y * 8, 90]);
  assert.ok(seams(wave).x < 1.5 && seams(wave).y < 1.5, JSON.stringify(seams(wave)));
  assert.ok(seams(ramp).x > 2.5 && seams(ramp).y > 2.5, JSON.stringify(seams(ramp)));
  fs.writeFileSync(path.join(dir, "ramp.png"), encodePng(ramp));
  const r = await ludo(dir, ["repeat", "ramp.png", "--times", "2x3", "--out", dir]);
  assert.deepEqual([r.out.width, r.out.height, r.out.verdict.across], [64, 96, "a visible seam"]);
  const out = readPng(fs.readFileSync(path.resolve(dir, path.basename(r.out.image)))).image;
  assert.deepEqual([...out.rgba.subarray((40 * 64 + 33) * 4, (40 * 64 + 33) * 4 + 4)], [8, 64, 90, 255]);
});
