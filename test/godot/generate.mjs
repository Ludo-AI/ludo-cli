// Writes spritesheet PNG fixtures and their SpriteFrames .tres files with the
// compiled dist/tty/godot.js, plus out/cases.json describing what validate.gd
// must find when Godot loads them. Every frame is a solid, distinct color so a
// wrong region samples the wrong color.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

// `node --test` (npm test) picks up every .mjs under test/; this driver belongs
// to run.sh only, so it does nothing when the test runner spawns it.
if (process.env.NODE_TEST_CONTEXT) process.exit(0);

const { spriteFramesTres, writeGodotSpriteFrames, writeGodotScene, godotTexturePath } = await import("../../dist/tty/godot.js");

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "out");
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

// --- tiny PNG writer (RGBA8, no deps) ---
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(width, height, pixel) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x++) raw.set(pixel(x, y), row + 1 + x * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const color = i => [10 + i * 6, 255 - i * 5, (i * 97) % 256, 255];

function writeSheet(file, grid, fw, fh) {
  const width = grid.cols * fw;
  const height = grid.rows * fh;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    png(width, height, (x, y) => {
      const i = Math.floor(y / fh) * grid.cols + Math.floor(x / fw);
      return i < grid.frames ? color(i) : [0, 0, 0, 0];
    }),
  );
  return { width, height };
}

function expected(name, tres, sheetRes, grid, fw, fh, animation = "default") {
  const frames = Array.from({ length: grid.frames }, (_, i) => ({
    region: [(i % grid.cols) * fw, Math.floor(i / grid.cols) * fh, fw, fh],
    color: color(i).map(c => c / 255),
  }));
  return {
    name,
    tres: "res://" + path.relative(here, tres).split(path.sep).join("/"),
    sheet: sheetRes,
    animation,
    fps: grid.fps,
    loop: grid.loop !== false,
    frames,
  };
}

const cases = [];

// 1. 6x6 grid, 36 frames, sheet inside the project -> res:// path.
{
  const grid = { cols: 6, rows: 6, frames: 36, fps: 12 };
  const sheet = path.join(out, "res", "hero_idle.png");
  const { width, height } = writeSheet(sheet, grid, 16, 16);
  const tres = writeGodotSpriteFrames(sheet, width, height, grid);
  cases.push(expected("6x6 full grid (res://)", tres, "res://out/res/hero_idle.png", grid, 16, 16));
}

// 2. 4x2 grid, 7 frames (partial last row), nested folder, custom name, no loop, fractional fps.
{
  const grid = { cols: 4, rows: 2, frames: 7, fps: 7.5, loop: false };
  const sheet = path.join(out, "res", "nested dir", "walk.png");
  const { width, height } = writeSheet(sheet, grid, 24, 16);
  const tres = writeGodotSpriteFrames(sheet, width, height, grid, "walk");
  cases.push(expected("4x2 partial row, 7 frames (res://, nested)", tres, "res://out/res/nested dir/walk.png", grid, 24, 16, "walk"));
}

// 3. Same sheet written twice -> second .tres gets the -2 suffix, both load.
{
  const grid = { cols: 2, rows: 2, frames: 4, fps: 4 };
  const sheet = path.join(out, "res", "twice.png");
  const { width, height } = writeSheet(sheet, grid, 8, 8);
  writeGodotSpriteFrames(sheet, width, height, grid);
  const tres = writeGodotSpriteFrames(sheet, width, height, grid);
  if (path.basename(tres) !== "twice-2.tres") throw new Error(`expected twice-2.tres, got ${tres}`);
  cases.push(expected("collision suffix twice-2.tres", tres, "res://out/res/twice.png", grid, 8, 8));
}

// 4. Sheet outside any Godot project -> relative path; the pair is then copied
//    into the project the way a user would drop it in.
{
  const grid = { cols: 4, rows: 2, frames: 7, fps: 10 };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-godot-"));
  try {
    const sheet = path.join(tmp, "slash.png");
    const { width, height } = writeSheet(sheet, grid, 12, 20);
    if (godotTexturePath(sheet) !== "slash.png") throw new Error(`expected relative texture path, got ${godotTexturePath(sheet)}`);
    const tres = writeGodotSpriteFrames(sheet, width, height, grid);
    const dest = path.join(out, "rel");
    fs.mkdirSync(dest, { recursive: true });
    fs.copyFileSync(sheet, path.join(dest, "slash.png"));
    fs.copyFileSync(tres, path.join(dest, path.basename(tres)));
    cases.push(expected("4x2 relative path (copied into project)", path.join(dest, path.basename(tres)), "res://out/rel/slash.png", grid, 12, 20));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// 5. A trimmed and extruded sheet (ludo toolbox image trim, then extrude --by
//    2): regions keep the repeated border out, and a margin puts each frame
//    back at its untrimmed size and offset.
{
  const grid = { cols: 3, rows: 2, frames: 5, fps: 8 };
  const sheet = path.join(out, "res", "packed.png");
  const { width, height } = writeSheet(sheet, grid, 16, 14);
  const trim = { x: 3, y: 2, w: 12, h: 10, source_w: 20, source_h: 16 };
  const tres = writeGodotSpriteFrames(sheet, width, height, grid, "jump", { trim, extrude: 2 });
  const c = expected("trimmed + extruded (margin, inset regions)", tres, "res://out/res/packed.png", grid, 16, 14, "jump");
  c.frames = c.frames.map((f, i) => ({ ...f, region: [(i % 3) * 16 + 2, Math.floor(i / 3) * 14 + 2, 12, 10], margin: [3, 2, 8, 6] }));
  cases.push(c);
}

// 6. A grid that does not divide the sheet must throw.
try {
  spriteFramesTres("x.png", 100, 64, { cols: 3, rows: 2, frames: 6, fps: 10 });
  throw new Error("non-divisible grid did not throw");
} catch (err) {
  if (!/does not divide/.test(err.message)) throw err;
}

fs.writeFileSync(path.join(out, "cases.json"), JSON.stringify(cases, null, 2));
console.log(`generated ${cases.length} cases; non-divisible grid throws as expected`);

// Scenes (sprite export --pivot): an AnimatedSprite2D playing the .tres
// whose offset puts the pivot at the node's origin, plain and trimmed +
// extruded (where the frame Godot draws is the untrimmed one).
const scenes = [];
for (const [name, grid, fw, fh, layout, pivot] of [
  ["pivot", { cols: 2, rows: 2, frames: 4, fps: 8 }, 20, 30, {}, { x: 9, y: 28 }],
  ["pivot-trimmed", { cols: 3, rows: 2, frames: 5, fps: 8 }, 16, 14, { trim: { x: 3, y: 2, w: 12, h: 10, source_w: 20, source_h: 16 }, extrude: 2 }, { x: 11, y: 15 }]
]) {
  const sheet = path.join(out, "res", `${name}.png`);
  const { width, height } = writeSheet(sheet, grid, fw, fh);
  const tres = writeGodotSpriteFrames(sheet, width, height, grid, "run", layout);
  const tscn = writeGodotScene(tres, width, height, grid, pivot, "run", layout);
  scenes.push({ name, tscn: "res://" + path.relative(here, tscn).split(path.sep).join("/"), animation: "run", frames: grid.frames, pivot: [pivot.x, pivot.y] });
}
fs.writeFileSync(path.join(out, "scenes.json"), JSON.stringify(scenes, null, 2));
console.log(`generated ${scenes.length} scenes`);

// TileSets (src/toolbox/tiles.ts godotTileSet): tiles of distinct colours,
// some left empty, with and without spacing and margin.
const { godotTileSet, tileLayout, tileRects } = await import("../../dist/toolbox/tiles.js");
const { encodePng } = await import("../../dist/tty/png.js");
const tilesets = [];
for (const [name, tw, th, spacing, margin, cols, rows] of [["plain", 16, 16, 0, 0, 4, 3], ["spaced", 12, 10, 2, 3, 5, 2]]) {
  const width = margin * 2 + cols * (tw + spacing) - spacing;
  const height = margin * 2 + rows * (th + spacing) - spacing;
  const img = { width, height, rgba: new Uint8Array(width * height * 4) };
  const layout = tileLayout(width, height, tw, th, spacing, margin);
  const kept = [];
  for (const t of tileRects(layout)) {
    if ((t.col + t.row) % 3 === 2) continue; // left empty
    const color = [(t.col * 50) % 256, (t.row * 90 + 40) % 256, 200, 255];
    for (let y = t.y; y < t.y + t.h; y++) for (let x = t.x; x < t.x + t.w; x++) img.rgba.set(color, (y * width + x) * 4);
    kept.push({ ...t, color: color.map(v => v / 255) });
  }
  const png = path.join(out, "tiles", `${name}.png`);
  fs.mkdirSync(path.dirname(png), { recursive: true });
  fs.writeFileSync(png, encodePng(img));
  const tres = path.join(out, "tiles", `${name}.tres`);
  fs.writeFileSync(tres, godotTileSet(`res://out/tiles/${name}.png`, layout, kept));
  tilesets.push({ name, tres: `res://out/tiles/${name}.tres`, tile: [tw, th], spacing, margin, tiles: kept.map(t => ({ coords: [t.col, t.row], region: [t.x, t.y, t.w, t.h], color: t.color })) });
}
fs.writeFileSync(path.join(out, "tilesets.json"), JSON.stringify(tilesets, null, 2));
console.log(`generated ${tilesets.length} tilesets`);

// Sounds (src/toolbox/wav.ts encodeWav): WAVs with and without a smpl
// loop, which Godot's importer should
// turn into a forward loop ("Detect From WAV", its default).
const { encodeWav } = await import("../../dist/toolbox/wav.js");
const sounds = [];
for (const [name, rate, channels, bits, loop] of [["loop-stereo", 44100, 2, 16, true], ["mono-24", 48000, 1, 24, false], ["loop-float", 22050, 2, 32, true]]) {
  const n = Math.round(rate * 0.75);
  const chans = Array.from({ length: channels }, (_, c) => Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin((2 * Math.PI * (220 + 110 * c) * i) / rate)));
  const file = path.join(out, "sounds", `${name}.wav`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, encodeWav({ rate, channels: chans }, { bits, ...(loop ? { loop: { start: 0, end: n } } : {}) }));
  sounds.push({ name, path: `res://out/sounds/${name}.wav`, rate, stereo: channels === 2, samples: n, loop });
}
fs.writeFileSync(path.join(out, "sounds.json"), JSON.stringify(sounds, null, 2));
console.log(`generated ${sounds.length} sounds`);
