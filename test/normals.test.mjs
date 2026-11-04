// `ludo toolbox image normals`, a port of Sprite Fusion Sprite Normals: its
// output must be the original's to the byte. test/corpus/normals holds the
// original's normal maps of small sprites, and the sha256 of more of them
// (scripts/normals-corpus-expected.mjs writes both).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { encodePng, readPng, textChunk } from "../dist/tty/png.js";
import { readGrid } from "../dist/tty/preview.js";
import { encodeWebp } from "../dist/tty/webp-encode.js";
import { NORMAL_DEFAULTS, normalMap, normalSettingsError } from "../dist/toolbox/normals.js";
import { EXIT } from "../dist/errors.js";

const exec = promisify(execFile);
const CLI = path.join(import.meta.dirname, "..", "dist", "cli.js");
const CORPUS = path.join(import.meta.dirname, "corpus");
const NORMALS = path.join(CORPUS, "normals");

const normals = async (dir, args) => {
  try {
    const { stdout } = await exec(process.execPath, [CLI, "toolbox", "image", "normals", ...args, "--out", dir, "--json", "--quiet"], {
      cwd: dir,
      env: { ...process.env, LUDO_TELEMETRY: "0", LUDO_CONFIG_DIR: path.join(dir, ".config") },
      maxBuffer: 1 << 24
    });
    const out = JSON.parse(stdout);
    const file = path.resolve(dir, out.image);
    return { code: 0, out, file, buf: fs.readFileSync(file) };
  } catch (err) {
    return { code: err.code, stderr: err.stderr };
  }
};

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ludo-normals-"));
const rgbaOf = file => readPng(fs.readFileSync(file)).image.rgba;
const chunkTypes = buf => readPng(buf).info.chunks.map(c => c.type);

test("normals are Sprite Fusion Sprite Normals' to the byte, RGB under clear pixels included", async () => {
  const dir = tmp();
  for (const name of ["islands", "soft", "threshold", "strokes"]) {
    const r = await normals(dir, [path.join(NORMALS, `${name}.png`)]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(path.basename(r.file), `${name}_n.png`);
    const ours = readPng(r.buf).image;
    const theirs = readPng(fs.readFileSync(path.join(NORMALS, `${name}_n.png`))).image;
    assert.deepEqual([ours.width, ours.height], [theirs.width, theirs.height], name);
    assert.ok(Buffer.from(ours.rgba).equals(Buffer.from(theirs.rgba)), `${name}: the bytes differ from the reference's`);
    assert.equal(r.out.normal_format, "opengl");
  }
  // A clear pixel keeps the flat normal, as the original writes it.
  const clear = rgbaOf(path.join(dir, "threshold_n.png")).subarray(0, 4);
  assert.deepEqual([...clear], [128, 128, 255, 0]);
});

test("normals match the reference's sha256 for every flag, real sprites and a GIF", async () => {
  const { cases } = JSON.parse(fs.readFileSync(path.join(NORMALS, "expected.json"), "utf8"));
  const dir = tmp();
  for (const c of cases) {
    const r = await normals(dir, [path.join(CORPUS, c.input), ...c.flags]);
    const what = `${c.input} ${c.flags.join(" ")}`;
    assert.equal(r.code, 0, `${what}: ${r.stderr}`);
    const img = readPng(r.buf).image;
    assert.deepEqual([img.width, img.height], [c.width, c.height], what);
    assert.equal(crypto.createHash("sha256").update(img.rgba).digest("hex"), c.sha256, what);
  }
});

test("a sheet is mapped frame by frame and keeps its grid; --grid and a WebP do the same", async () => {
  const dir = tmp();
  const golden = Buffer.from(rgbaOf(path.join(NORMALS, "sheet_n.png")));
  // Its Ludo stamp: the original's --frame-size 16x16.
  const stamped = await normals(dir, [path.join(NORMALS, "sheet.png")]);
  assert.equal(stamped.code, 0, stamped.stderr);
  assert.ok(Buffer.from(readPng(stamped.buf).image.rgba).equals(golden), "cells bleed into each other");
  assert.deepEqual(readGrid(stamped.buf), { cols: 3, rows: 2, frames: 6, fps: 10 });
  assert.deepEqual(stamped.out.grid, { cols: 3, rows: 2, frames: 6, frame_width: 16, frame_height: 16, fps: 10 });

  // The same pixels with no stamp: one image unless --grid says otherwise.
  const plain = readPng(fs.readFileSync(path.join(NORMALS, "sheet.png"))).image;
  fs.writeFileSync(path.join(dir, "plain.png"), encodePng(plain));
  const whole = await normals(dir, [path.join(dir, "plain.png")]);
  assert.equal(whole.code, 0, whole.stderr);
  assert.ok(!Buffer.from(readPng(whole.buf).image.rgba).equals(golden), "read as one image, the cells are one island");
  const gridded = await normals(dir, [path.join(dir, "plain.png"), "--grid", "3x2"]);
  assert.ok(Buffer.from(readPng(gridded.buf).image.rgba).equals(golden));

  fs.writeFileSync(path.join(dir, "sheet.webp"), encodeWebp(plain));
  const webp = await normals(dir, [path.join(dir, "sheet.webp"), "--grid", "3x2"]);
  assert.equal(webp.code, 0, webp.stderr);
  assert.ok(Buffer.from(readPng(webp.buf).image.rgba).equals(golden));
  assert.match(path.basename(webp.file), /^sheet_n(-\d+)?\.png$/);
});

test("the normal map is data: no colour-space chunks carry over, and an APNG or huge frame is refused", async () => {
  const dir = tmp();
  const art = readPng(fs.readFileSync(path.join(NORMALS, "islands.png"))).image;
  const gama = { type: "gAMA", data: Buffer.from([0, 0, 0xb1, 0x8f]) };
  const srgb = { type: "sRGB", data: Buffer.from([0]) };
  const phys = { type: "pHYs", data: Buffer.from([0, 0, 0x0b, 0x13, 0, 0, 0x0b, 0x13, 1]) };
  fs.writeFileSync(path.join(dir, "tagged.png"), encodePng(art, { chunks: [gama, srgb, phys] }));
  const r = await normals(dir, [path.join(dir, "tagged.png")]);
  assert.equal(r.code, 0, r.stderr);
  const types = chunkTypes(r.buf);
  assert.ok(!types.includes("gAMA") && !types.includes("sRGB"), types.join(","));
  assert.ok(types.includes("pHYs"), "the pixel size still carries");
  assert.ok(Buffer.from(readPng(r.buf).image.rgba).equals(Buffer.from(rgbaOf(path.join(NORMALS, "islands_n.png")))));

  // An APNG is refused, as by every image tool.
  fs.writeFileSync(path.join(dir, "anim.png"), encodePng(art, { chunks: [{ type: "acTL", data: Buffer.from([0, 0, 0, 1, 0, 0, 0, 0]) }] }));
  const apng = await normals(dir, [path.join(dir, "anim.png")]);
  assert.equal(apng.code, EXIT.BAD_INPUT);
  assert.match(apng.stderr, /animated PNG/);

  // The original's limit, 4,194,304 pixels with the border, holds per frame.
  const big = { width: 2048, height: 2048, rgba: new Uint8Array(2048 * 2048 * 4).fill(255) };
  fs.writeFileSync(path.join(dir, "big.png"), encodePng(big));
  const huge = await normals(dir, [path.join(dir, "big.png")]);
  assert.equal(huge.code, EXIT.BAD_INPUT);
  assert.match(huge.stderr, /too large for a normal map/);
  const quartered = await normals(dir, [path.join(dir, "big.png"), "--grid", "2x2"]);
  assert.equal(quartered.code, 0, quartered.stderr);
});

test("normals flags: the original's ranges, read as it reads them", async () => {
  const dir = tmp();
  const art = path.join(NORMALS, "strokes.png");
  for (const [args, message] of [
    [["--normal-strength", "8.5"], /--normal-strength takes a number from 0 to 8 \(got "8.5"\)/],
    [["--normal-strength", "-1"], /from 0 to 8/],
    [["--detail-strength", "lots"], /--detail-strength takes a number from 0 to 8/],
    [["--detail-scale", "0.5"], /--detail-scale takes a number from 0.6 to 8/],
    [["--shape-strength", "0x2"], /--shape-strength takes a number/],
    [["--shape-strength"], /--shape-strength takes a number/],
    [["--normal-format", "vulkan"], /--normal-format takes opengl or directx/]
  ]) {
    const r = await normals(dir, [art, ...args]);
    assert.equal(r.code, EXIT.USAGE, args.join(" "));
    assert.match(r.stderr, message, args.join(" "));
  }
  const edges = await normals(dir, [art, "--detail-scale", "0.6", "--normal-strength", "8", "--shape-strength", "0", "--detail-strength", "8", "--normal-format", "DirectX"]);
  assert.equal(edges.code, 0, edges.stderr);
  assert.deepEqual([edges.out.detail_scale, edges.out.normal_strength, edges.out.normal_format], [0.6, 8, "directx"]);

  assert.equal(normalSettingsError(NORMAL_DEFAULTS), undefined);
  assert.match(normalSettingsError({ ...NORMAL_DEFAULTS, shapeRadius: 0.25 }), /shape-radius must be from 0.5 to 512/);
  assert.match(normalSettingsError({ ...NORMAL_DEFAULTS, alphaThreshold: NaN }), /alpha-threshold/);
});

test("clear art, and art at or below the threshold, is the flat normal with its alpha", () => {
  const img = { width: 3, height: 2, rgba: new Uint8Array([9, 9, 9, 0, 9, 9, 9, 7, 200, 10, 10, 0, 1, 2, 3, 7, 0, 0, 0, 0, 5, 5, 5, 1]) };
  const out = normalMap(img);
  for (let p = 0; p < 6; p++) assert.deepEqual([...out.rgba.subarray(p * 4, p * 4 + 4)], [128, 128, 255, img.rgba[p * 4 + 3]]);
  // A lone opaque pixel rises evenly: it faces the viewer.
  assert.deepEqual([...normalMap({ width: 1, height: 1, rgba: new Uint8Array([50, 60, 70, 255]) }).rgba], [128, 128, 255, 255]);
});

// The art's own size, pixel positions and alpha, whatever the grid.
const sameGeometry = (art, map, what) => {
  assert.deepEqual([map.width, map.height], [art.width, art.height], `${what}: size`);
  for (let i = 3; i < art.rgba.length; i += 4) if (art.rgba[i] !== map.rgba[i]) assert.fail(`${what}: alpha differs at pixel ${(i - 3) / 4}`);
};

test("a normal map lies on its art: an empty last row and a 3 px last frame are mapped, an uneven grid refused", async () => {
  const dir = tmp();
  // A 3x3 grid stamped with 6 frames: the empty last row stays (48x48, not 48x32).
  const rows = await normals(dir, [path.join(NORMALS, "sheet-rows.png")]);
  assert.equal(rows.code, 0, rows.stderr);
  const rowsArt = readPng(fs.readFileSync(path.join(NORMALS, "sheet-rows.png"))).image;
  sameGeometry(rowsArt, readPng(rows.buf).image, "stamped 3x3 of 6");
  assert.ok(Buffer.from(readPng(rows.buf).image.rgba).equals(Buffer.from(rgbaOf(path.join(NORMALS, "sheet-rows_n.png")))));
  assert.deepEqual(readGrid(rows.buf), { cols: 3, rows: 3, frames: 6, fps: 10 });
  fs.writeFileSync(path.join(dir, "rows-plain.png"), encodePng(rowsArt));
  const rowsFlag = await normals(dir, [path.join(dir, "rows-plain.png"), "--grid", "3x3"]);
  assert.equal(rowsFlag.code, 0, rowsFlag.stderr);
  assert.ok(Buffer.from(readPng(rowsFlag.buf).image.rgba).equals(Buffer.from(rgbaOf(path.join(NORMALS, "sheet-rows_n.png")))));

  // A last cell of 3 opaque pixels, which a frame count leaves out, is mapped too.
  const speckArt = readPng(fs.readFileSync(path.join(NORMALS, "speck.png"))).image;
  const speck = await normals(dir, [path.join(NORMALS, "speck.png"), "--grid", "2x2"]);
  assert.equal(speck.code, 0, speck.stderr);
  const speckMap = readPng(speck.buf).image;
  sameGeometry(speckArt, speckMap, "2x2 with a speck");
  assert.deepEqual([...speckMap.rgba.subarray((21 * 32 + 20) * 4, (21 * 32 + 20) * 4 + 4)], [128, 128, 255, 255]);
  assert.ok(Buffer.from(speckMap.rgba).equals(Buffer.from(rgbaOf(path.join(NORMALS, "speck_n.png")))));

  // 50x32 does not split into 3x2 cells of one size: refused, as the original refuses it.
  const uneven = { width: 50, height: 32, rgba: new Uint8Array(50 * 32 * 4).fill(200) };
  fs.writeFileSync(path.join(dir, "uneven.png"), encodePng(uneven));
  const byFlag = await normals(dir, [path.join(dir, "uneven.png"), "--grid", "3x2"]);
  assert.equal(byFlag.code, EXIT.USAGE);
  assert.match(byFlag.stderr, /A 50x32 image does not split into 3x2 frames of one whole size/);
  fs.writeFileSync(path.join(dir, "uneven-stamped.png"), encodePng(uneven, { chunks: [textChunk("ludo:grid", JSON.stringify({ cols: 3, rows: 2, frames: 6, fps: 10 }))] }));
  const byStamp = await normals(dir, [path.join(dir, "uneven-stamped.png")]);
  assert.equal(byStamp.code, EXIT.BAD_INPUT);
  assert.match(byStamp.stderr, /multiple of 3/);
});

test("normals writes no engine files, even with --engine", async () => {
  const dir = tmp();
  const art = { width: 32, height: 16, rgba: new Uint8Array(32 * 16 * 4) };
  for (let y = 3; y < 13; y++) for (let x = 0; x < 32; x++) if (x % 16 > 3 && x % 16 < 12) art.rgba.set([180, 90 + x, 60, 255], (y * 32 + x) * 4);
  fs.writeFileSync(path.join(dir, "walk.png"), encodePng(art, { chunks: [textChunk("ludo:grid", JSON.stringify({ cols: 2, rows: 1, frames: 2 }))] }));
  for (const engine of ["unity", "godot", "texturepacker"]) {
    const out = fs.mkdtempSync(path.join(dir, `${engine}-`));
    const r = await normals(out, [path.join(dir, "walk.png"), "--engine", engine]);
    assert.equal(r.code, 0, `${engine}: ${r.stderr}`);
    assert.deepEqual(fs.readdirSync(out).filter(f => !f.startsWith(".")), ["walk_n.png"], engine);
    assert.equal(r.out.engine_files, undefined, engine);
    assert.match(r.out.notes.join("\n"), /No .* files for a normal map/, engine);
  }
});

test("--shape-radius: the original's flag and range, and big art gets a value to try", async () => {
  const dir = tmp();
  const small = path.join(NORMALS, "islands.png");
  for (const bad of ["0.4", "513", "wide"]) {
    const r = await normals(dir, [small, "--shape-radius", bad]);
    assert.equal(r.code, EXIT.USAGE, bad);
    assert.match(r.stderr, /--shape-radius takes a number from 0.5 to 512/, bad);
  }
  const plain = await normals(dir, [small]);
  assert.equal(plain.out.shape_radius, 4);
  assert.equal(plain.out.notes, undefined, "small art: no note");
  const wide = await normals(dir, [small, "--shape-radius", "16"]);
  assert.equal(wide.out.shape_radius, 16);
  assert.ok(!wide.buf.equals(plain.buf), "the radius changes the map");

  // A 300x200 blob: the note suggests the longer side / 48 (at least 8),
  // with --detail-scale 3 unless one was given; an explicit radius silences it.
  const art = { width: 300, height: 200, rgba: new Uint8Array(300 * 200 * 4) };
  for (let y = 0; y < 200; y++) for (let x = 0; x < 300; x++) if (((x - 150) / 140) ** 2 + ((y - 100) / 90) ** 2 < 1) art.rgba.set([150, 100 + (x % 50), 80, 255], (y * 300 + x) * 4);
  const big = path.join(dir, "big.png");
  fs.writeFileSync(big, encodePng(art));
  const hinted = await normals(dir, [big]);
  assert.match(hinted.out.notes.join("\n"), /This art is 300x200: at the default --shape-radius 4 .* Try --shape-radius 8 --detail-scale 3/);
  const scaled = await normals(dir, [big, "--detail-scale", "2"]);
  assert.match(scaled.out.notes.join("\n"), /Try --shape-radius 8 \(see --help\)/);
  const chosen = await normals(dir, [big, "--shape-radius", "4"]);
  assert.equal(chosen.out.notes, undefined, "an explicit radius, even the default, is a choice");
  const sheet = await normals(dir, [big, "--grid", "2x1"]);
  assert.doesNotMatch(JSON.stringify(sheet.out.notes ?? []), /shape-radius/, "150x200 frames are under 256 px");
});

test("normals never replaces its art: --in-place is refused and not offered", async () => {
  const dir = tmp();
  const file = path.join(dir, "art.png");
  fs.copyFileSync(path.join(NORMALS, "islands.png"), file);
  const before = fs.readFileSync(file);
  const r = await normals(dir, [file, "--in-place"]);
  assert.equal(r.code, EXIT.USAGE);
  assert.match(r.stderr, /A normal map does not replace its art: it is saved beside it, as <name>_n\.png/);
  assert.ok(fs.readFileSync(file).equals(before), "the art is untouched");
  const { stdout } = await exec(process.execPath, [CLI, "toolbox", "image", "normals", "--help"], { env: { ...process.env, LUDO_TELEMETRY: "0" } });
  assert.doesNotMatch(stdout, /--in-place/);
  assert.match(stdout, /--grid/);
});
