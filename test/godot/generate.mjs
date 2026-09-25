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

const { spriteFramesTres, writeGodotSpriteFrames, godotTexturePath } = await import("../../dist/tty/godot.js");

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

// 5. A grid that does not divide the sheet must throw.
try {
  spriteFramesTres("x.png", 100, 64, { cols: 3, rows: 2, frames: 6, fps: 10 });
  throw new Error("non-divisible grid did not throw");
} catch (err) {
  if (!/does not divide/.test(err.message)) throw err;
}

fs.writeFileSync(path.join(out, "cases.json"), JSON.stringify(cases, null, 2));
console.log(`generated ${cases.length} cases; non-divisible grid throws as expected`);
