// toolbox/unfake.ts: the port of unfake.js's core against unfake.js itself
// (expected.json, from scripts/unfake-fixtures.mjs running its own wasm), the
// unit tests of its Rust crate, known answers, and `ludo toolbox image snap`.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { corpus, art, drawn } from "./unfake-corpus.mjs";
import {
  unfake,
  exactGrid,
  fractionalGridDetect,
  gridForScale,
  elasticBounds,
  integerGrid,
  tiledEdgeDetect,
  runsBasedDetect,
  axisCells
} from "../dist/toolbox/unfake.js";
import { encodePng, readPng, withText } from "../dist/tty/png.js";
import { readGrid } from "../dist/tty/preview.js";
import { joinFrames, sliceSheet } from "../dist/toolbox/sheet.js";

const exec = promisify(execFile);
const expected = JSON.parse(fs.readFileSync(new URL("./corpus/unfake/expected.json", import.meta.url), "utf8")).cases;
const sha = b => crypto.createHash("sha256").update(b).digest("hex");
const CASES = corpus();

test("every corpus image gives what unfake.js gives (ties aside) and the same as when the fixtures were made", () => {
  assert.deepEqual(Object.keys(expected).sort(), CASES.map(c => c.name).sort());
  for (const c of CASES) {
    const want = expected[c.name];
    const r = unfake(c.img, { exact: false });
    assert.ok(Math.abs(r.scale - want.unfake.scale) < 1e-6, `${c.name}: scale ${r.scale} vs unfake.js ${want.unfake.scale}`);
    assert.deepEqual([r.image.width, r.image.height], [want.unfake.width, want.unfake.height], c.name);
    assert.equal(!!r.grid, want.unfake.fractional, `${c.name}: fractional grid`);
    assert.equal(!!r.elastic, want.unfake.elastic, `${c.name}: elastic`);
    assert.equal(sha(r.image.rgba), want.ours.sha256, `${c.name}: pixels`);
    if (!want.unfake.tie_pixels) assert.equal(sha(r.image.rgba), want.unfake.sha256, `${c.name}: identical to unfake.js`);
    const e = unfake(c.img);
    assert.deepEqual([e.scale, e.image.width, e.image.height, !!e.exact, sha(e.image.rgba)], [want.exact_first.scale, want.exact_first.width, want.exact_first.height, want.exact_first.exact, want.exact_first.sha256], `${c.name}: exact first`);
  }
});

test("an exact upscale comes back as the art it was made from, whatever its phase and a few stray pixels", () => {
  for (const c of CASES.filter(c => c.name.startsWith("whole-"))) {
    const r = unfake(c.img);
    assert.equal(r.exact, true, c.name);
    assert.equal(r.scale, c.scale, c.name);
    assert.equal(r.fit, c.name.endsWith("strays") ? r.fit : 1, c.name);
    if (!c.name.includes("phase") && !c.name.endsWith("strays")) assert.ok(Buffer.from(r.image.rgba).equals(Buffer.from(c.cells.rgba)), c.name);
  }
  // unfake.js's own detector reads 2x art as 6 or 5; the exact step reads 2.
  const two = CASES.find(c => c.name === "whole-2");
  assert.notEqual(unfake(two.img, { exact: false }).scale, 2);
  assert.equal(unfake(two.img).scale, 2);
});

test("a canvas resampled to a fractional cell size comes back cell for cell", () => {
  for (const c of CASES.filter(c => c.name.startsWith("resampled-"))) {
    const r = unfake(c.img);
    assert.ok(Math.abs(r.scale - c.scale) < 1e-9, `${c.name}: ${r.scale}`);
    assert.deepEqual([r.image.width, r.image.height], [c.cells.width, c.cells.height], c.name);
    assert.ok(Buffer.from(r.image.rgba).equals(Buffer.from(c.cells.rgba)), c.name);
  }
});

test("hand-drawn cells that wander around 43 px are followed edge to edge", () => {
  const c = CASES.find(c => c.name === "hand-drawn-43");
  const r = unfake(c.img);
  assert.deepEqual(r.elastic, [true, true]);
  assert.deepEqual([r.image.width, r.image.height], [c.cells.width, c.cells.height]);
  assert.ok(Buffer.from(r.image.rgba).equals(Buffer.from(c.cells.rgba)));
});

test("exactGrid finds nothing where there is no exact upscale", () => {
  for (const name of ["soft-6-bilinear", "soft-8-bicubic", "noise", "native-art", "resampled-100-to-1024"]) assert.equal(exactGrid(CASES.find(c => c.name === name).img), undefined, name);
});

// ---- unfake-core's own unit tests (Rust), ported ----

// detect/grid.rs fractional_sprite: hashed colours per cell, `cells` cells
// resampled nearest-style to `size` px.
function fractionalSprite(cells, size) {
  const p = size / cells;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = Math.min(Math.floor((x + 0.5) / p), cells - 1);
      const cy = Math.min(Math.floor((y + 0.5) / p), cells - 1);
      const h = ((Math.imul(cx, 73_856_093) ^ Math.imul(cy, 19_349_663)) >>> 0) % 5;
      data.set([h * 60, 255 - h * 50, (h * 23) % 256, 255], (y * size + x) * 4);
    }
  }
  return { width: size, height: size, rgba: data };
}

test("grid.rs: detects 10.24 on 2048 and 2.5 on 500", () => {
  const g = fractionalGridDetect(fractionalSprite(200, 2048));
  assert.ok(Math.abs(g.x.period - 10.24) < 1e-9 && Math.abs(g.y.period - 10.24) < 1e-9, JSON.stringify(g));
  assert.deepEqual([axisCells(g.x, 2048), axisCells(g.y, 2048)], [200, 200]);
  const h = fractionalGridDetect(fractionalSprite(200, 500));
  assert.ok(Math.abs((h.x.period + h.y.period) / 2 - 2.5) < 1e-9, JSON.stringify(h));
  assert.deepEqual([axisCells(h.x, 500), axisCells(h.y, 500)], [200, 200]);
});

test("grid.rs: a nearest 2x of a fractional grid keeps the cell size; an integer grid is left alone", () => {
  const src = fractionalSprite(200, 1024);
  const big = { width: 2048, height: 2048, rgba: new Uint8Array(2048 * 2048 * 4) };
  for (let y = 0; y < 2048; y++) for (let x = 0; x < 2048; x++) big.rgba.set(src.rgba.subarray(((y >> 1) * 1024 + (x >> 1)) * 4, ((y >> 1) * 1024 + (x >> 1)) * 4 + 4), (y * 2048 + x) * 4);
  const g = fractionalGridDetect(big);
  assert.ok(Math.abs((g.x.period + g.y.period) / 2 - 10.24) < 1e-9, JSON.stringify(g));
  assert.equal(fractionalGridDetect(fractionalSprite(64, 512)), undefined);
});

test("grid.rs: a manual scale snaps to whole cells", () => {
  const g = gridForScale(fractionalSprite(200, 2048), 10.24);
  assert.deepEqual([axisCells(g.x, 2048), axisCells(g.y, 2048)], [200, 200]);
  assert.ok(g.x.offset < 0.5 || g.x.offset > g.x.period - 0.5, JSON.stringify(g.x));
});

// detect/elastic.rs tests: cells with given widths, hashed colours.
function drawnCells(widths, heights) {
  const colour = (cx, cy) => {
    const h = ((Math.imul(cx, 73_856_093) ^ Math.imul(cy, 19_349_663)) >>> 0) % 7;
    return [h * 36, 250 - h * 30, (h * 91) % 256, 255];
  };
  const cells = { width: widths.length, height: heights.length, rgba: new Uint8Array(widths.length * heights.length * 4) };
  for (let y = 0; y < heights.length; y++) for (let x = 0; x < widths.length; x++) cells.rgba.set(colour(x, y), (y * widths.length + x) * 4);
  const acc = a => a.reduce((b, v) => [...b, b.at(-1) + v], [0]);
  return drawn(cells, acc(widths), acc(heights));
}
const jitter = (n, seed) => Array.from({ length: n }, (_, i) => 40 + ((Math.imul(i + seed, 2_654_435_761) >>> 0) >>> 7) % 10);

test("elastic.rs: follows hand-drawn cells; regular grids stay regular", () => {
  const widths = jitter(24, 1);
  const img = drawnCells(widths, jitter(24, 7));
  const fit = elasticBounds(img, integerGrid(43, 0, 0));
  assert.deepEqual(fit.adapted, [true, true]);
  assert.deepEqual([fit.bounds.x.length - 1, fit.bounds.y.length - 1], [24, 24]);
  let edge = 0;
  fit.bounds.x.slice(1, -1).forEach((b, i) => {
    edge += widths[i];
    assert.ok(Math.abs(b - edge) <= 1, `boundary ${b} vs edge ${edge}`);
  });
  assert.equal(elasticBounds(drawnCells(Array(32).fill(16), Array(32).fill(16)), integerGrid(16, 0, 0)), undefined);
});

test("detect/mod.rs: tiled detection on a 4 px checker; runs on clean art", () => {
  const img = { width: 64, height: 64, rgba: new Uint8Array(64 * 64 * 4) };
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    const c = ((x >> 2) + (y >> 2)) % 2 ? 50 : 200;
    img.rgba.set([c, c, c, 255], (y * 64 + x) * 4);
  }
  assert.equal(tiledEdgeDetect(img), 4);
  assert.equal(runsBasedDetect(img), 4);
});

// ---- ludo toolbox image snap ----

const CLI = path.join(import.meta.dirname, "..", "dist", "cli.js");
const env = dir => ({ ...process.env, LUDO_CONFIG_DIR: path.join(dir, ".config"), LUDO_TELEMETRY: "0", LUDO_API_URL: "http://127.0.0.1:9" });
const snap = async (dir, ...args) => {
  try {
    const { stdout } = await exec(process.execPath, [CLI, "toolbox", "image", "snap", ...args, "--out", dir, "--json"], { env: env(dir), cwd: dir });
    return { code: 0, out: JSON.parse(stdout) };
  } catch (err) {
    return { code: err.code, stderr: err.stderr, out: err.stdout ? JSON.parse(err.stdout) : undefined };
  }
};

test("snap: a still, its pixel size, --keep-size, --colors, --scale", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-snap-"));
  const c = CASES.find(c => c.name === "whole-6");
  fs.writeFileSync(path.join(dir, "still.png"), encodePng(c.img));
  const r = await snap(dir, "still.png");
  assert.deepEqual([r.out.width, r.out.height, r.out.pixel_size, r.out.exact, r.out.fit], [48, 40, 6, true, 1]);
  assert.ok(Buffer.from(readPng(fs.readFileSync(path.join(dir, path.basename(r.out.image)))).image.rgba).equals(Buffer.from(c.cells.rgba)));

  const kept = await snap(dir, "still.png", "--keep-size");
  assert.deepEqual([kept.out.width, kept.out.height, kept.out.drawn_at], [288, 240, 6]);

  const few = await snap(dir, "still.png", "--colors", "3");
  const img = readPng(fs.readFileSync(path.join(dir, path.basename(few.out.image)))).image;
  const colours = new Set();
  for (let i = 0; i < img.rgba.length; i += 4) if (img.rgba[i + 3]) colours.add(img.rgba.slice(i, i + 3).join());
  assert.ok(colours.size <= 3, `${colours.size} colours`);
  assert.deepEqual(few.out.colors, { before: 6, after: 3 });

  const forced = await snap(dir, "still.png", "--scale", "3");
  assert.deepEqual([forced.out.width, forced.out.pixel_size], [96, 3]);
});

test("snap: a sheet keeps its grid, every frame cut on the sheet's own phase", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-snap-sheet-"));
  // Four frames of 3x art on one grid, the grid starting a pixel in.
  const frames = [11, 12, 13, 14].map(seed => drawn(art(30, 30, seed), [0, ...Array.from({ length: 30 }, (_, i) => (i + 1) * 3 - 1)].filter((v, i) => i === 0 || v > 0), [0, ...Array.from({ length: 30 }, (_, i) => (i + 1) * 3 - 1)].filter((v, i) => i === 0 || v > 0)));
  const padded = frames.map(f => {
    const o = { width: 90, height: 90, rgba: new Uint8Array(90 * 90 * 4) };
    for (let y = 0; y < f.height; y++) o.rgba.set(f.rgba.subarray(y * f.width * 4, (y + 1) * f.width * 4), y * 90 * 4);
    return o;
  });
  const { sheet } = joinFrames(padded, 2);
  fs.writeFileSync(path.join(dir, "sheet.png"), withText(encodePng(sheet), "ludo:grid", JSON.stringify({ cols: 2, rows: 2, frames: 4, fps: 8 })));
  const r = await snap(dir, "sheet.png");
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.out.pixel_size, 3);
  // The first cell of each frame is cut short (the grid starts a pixel in),
  // so 29 whole cells a side are left.
  assert.deepEqual(r.out.grid, { cols: 2, rows: 2, frames: 4, frame_width: 29, frame_height: 29, fps: 8 });
  const outBuf = fs.readFileSync(path.join(dir, path.basename(r.out.image)));
  assert.deepEqual(readGrid(outBuf), { cols: 2, rows: 2, frames: 4, fps: 8 });
  // Every frame is its art's cells 1..29, on the same grid.
  sliceSheet(readPng(outBuf).image, 2, 2, 4).forEach((f, i) => {
    const cells = art(30, 30, 11 + i);
    for (let y = 0; y < 29; y++) for (let x = 0; x < 29; x++) {
      const a = f.rgba.subarray((y * 29 + x) * 4, (y * 29 + x) * 4 + 4);
      const b = cells.rgba.subarray(((y + 1) * 30 + x + 1) * 4, ((y + 1) * 30 + x + 1) * 4 + 4);
      assert.deepEqual([...a], [...b], `frame ${i} at ${x},${y}`);
    }
  });
});

test("snap: an image with no pixel grid is refused; a doubtful one is warned about", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-snap-no-"));
  const flat = { width: 64, height: 64, rgba: new Uint8Array(64 * 64 * 4).fill(200) };
  fs.writeFileSync(path.join(dir, "flat.png"), encodePng(flat));
  const none = await snap(dir, "flat.png");
  assert.equal(none.code, 12);
  assert.match(none.stderr, /no pixel grid to snap to/);
  fs.writeFileSync(path.join(dir, "native.png"), encodePng(CASES.find(c => c.name === "native-art").img));
  const doubt = await snap(dir, "native.png");
  assert.equal(doubt.code, 0);
  assert.ok(doubt.out.fit < 0.7, String(doubt.out.fit));
  assert.match(doubt.out.warning, /may already be one pixel per pixel/);
});
