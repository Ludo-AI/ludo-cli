import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { decodePng, encodePng, readPng, readText, textChunk, PngError } from "../dist/tty/png.js";

const SUITE = new URL("./corpus/pngsuite/", import.meta.url).pathname;
const EXPECTED = JSON.parse(fs.readFileSync(SUITE + "expected.json", "utf8"));
const suiteFiles = fs.readdirSync(SUITE).filter(f => f.endsWith(".png")).sort();

// Seeded, so a failure reproduces.
function rng(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// RGB under a fully transparent pixel is invisible; compare without it.
function canonical(rgba) {
  const out = Buffer.from(rgba);
  for (let i = 0; i < out.length; i += 4) if (out[i + 3] === 0) out.fill(0, i, i + 3);
  return out;
}
const sha = rgba => crypto.createHash("sha256").update(canonical(rgba)).digest("hex");

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function ihdr(width, height, depth, colorType, interlace = 0) {
  const d = Buffer.alloc(13);
  d.writeUInt32BE(width, 0);
  d.writeUInt32BE(height, 4);
  d[8] = depth;
  d[9] = colorType;
  d[12] = interlace;
  return chunk("IHDR", d);
}
const png = (...chunks) => Buffer.concat([SIG, ...chunks, chunk("IEND", Buffer.alloc(0))]);

function randomImage(r, width, height, colours, alpha) {
  const palette = Array.from({ length: colours }, () => [
    (r() * 256) | 0,
    (r() * 256) | 0,
    (r() * 256) | 0,
    alpha === "opaque" ? 255 : alpha === "binary" ? (r() < 0.3 ? 0 : 255) : (r() * 256) | 0
  ]);
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) rgba.set(palette[(r() * colours) | 0], i * 4);
  return { width, height, rgba };
}

function encoderCases() {
  const r = rng(7);
  const cases = [];
  for (const [w, h] of [[1, 1], [3, 5], [17, 9], [64, 64], [301, 7]]) {
    for (const colours of [1, 2, 3, 5, 16, 17, 256, 2000]) {
      for (const alpha of ["opaque", "binary", "soft"]) cases.push({ name: `${w}x${h} ${colours} ${alpha}`, img: randomImage(r, w, h, colours, alpha) });
    }
  }
  return cases;
}

// ---- Decoder: PngSuite ----

test("PngSuite: every valid image decodes exactly as ImageMagick does", () => {
  const valid = suiteFiles.filter(f => !f.startsWith("x"));
  assert.equal(valid.length, Object.keys(EXPECTED).length);
  for (const file of valid) {
    const { image } = readPng(fs.readFileSync(SUITE + file));
    assert.equal(sha(image.rgba), EXPECTED[file], file);
  }
});

test("PngSuite: every corrupt image is refused with a PngError", () => {
  const corrupt = suiteFiles.filter(f => f.startsWith("x"));
  assert.ok(corrupt.length >= 14);
  for (const file of corrupt) {
    const buf = fs.readFileSync(SUITE + file);
    assert.throws(() => readPng(buf), PngError, file);
    assert.equal(decodePng(buf), undefined, file);
  }
});

test("PngSuite: says what kind of file it read", () => {
  const info = file => readPng(fs.readFileSync(SUITE + file)).info;
  assert.deepEqual([info("basi0g16.png").sourceDepth, info("basi0g16.png").interlaced], [16, true]);
  assert.deepEqual([info("basn3p02.png").sourceDepth, info("basn3p02.png").colorType], [2, 3]);
  // Colour space and text survive the read.
  assert.ok(info("g03n2c08.png").chunks.some(c => c.type === "gAMA"));
  assert.ok(info("ct1n0g04.png").chunks.filter(c => c.type === "tEXt").length >= 4);
  assert.ok(info("cdfn2c08.png").chunks.some(c => c.type === "pHYs"));
});

test("names the problem with a damaged signature", () => {
  const err = (() => {
    try {
      readPng(fs.readFileSync(SUITE + "xcrn0g04.png"));
    } catch (e) {
      return e;
    }
  })();
  assert.equal(err.code, "NOT_PNG");
  assert.match(err.message, /text mode/);
});

// ---- Decoder: hostile and unusual input ----

test("random damage to real files never escapes as anything but a PngError", () => {
  const r = rng(42);
  const started = Date.now();
  let refused = 0;
  for (const file of suiteFiles.filter(f => !f.startsWith("x"))) {
    const original = fs.readFileSync(SUITE + file);
    for (let k = 0; k < 40; k++) {
      let buf = Buffer.from(original);
      const kind = k % 4;
      if (kind === 0) buf = buf.subarray(0, 8 + Math.floor(r() * (buf.length - 8))); // truncate
      else if (kind === 1) for (let n = 0; n < 1 + r() * 4; n++) buf[8 + Math.floor(r() * (buf.length - 8))] = (r() * 256) | 0; // flip bytes
      else if (kind === 2) buf.writeUInt32BE((r() * 0xffffffff) >>> 0, 8 + 4 * Math.floor(r() * ((buf.length - 12) / 4))); // a wild 32-bit field
      else buf = Buffer.concat([buf.subarray(0, 33), buf.subarray(33 + Math.floor(r() * 40))]); // drop bytes after IHDR
      try {
        const { image } = readPng(buf);
        assert.equal(image.rgba.length, image.width * image.height * 4);
      } catch (e) {
        if (!(e instanceof PngError)) throw new Error(`${file} mutation ${k}: ${e.stack}`);
        refused++;
      }
    }
  }
  assert.ok(refused > 1000);
  assert.ok(Date.now() - started < 30_000);
});

test("a zip bomb is refused without inflating it", () => {
  // 1x1 grey claims 2 bytes of image data; this IDAT holds 64 MB of zeros.
  const bomb = zlib.deflateSync(Buffer.alloc(64 * 1024 * 1024), { level: 9 });
  const before = process.memoryUsage().arrayBuffers;
  const err = (() => {
    try {
      readPng(png(ihdr(1, 1, 8, 0), chunk("IDAT", bomb)));
    } catch (e) {
      return e;
    }
  })();
  assert.equal(err.code, "CORRUPT");
  assert.match(err.message, /larger than its header/);
  assert.ok(process.memoryUsage().arrayBuffers - before < 8 * 1024 * 1024);
});

test("refuses an image over the pixel limit before reading its data", () => {
  const huge = png(ihdr(100_000, 100_000, 8, 6), chunk("IDAT", zlib.deflateSync(Buffer.alloc(10))));
  assert.equal((() => { try { readPng(huge); } catch (e) { return e.code; } })(), "TOO_LARGE");
  assert.equal((() => { try { readPng(png(ihdr(100, 100, 8, 6)), { maxPixels: 9999 }); } catch (e) { return e.code; } })(), "TOO_LARGE");
});

test("refuses truncated image data and unknown row filters", () => {
  const short = png(ihdr(4, 4, 8, 0), chunk("IDAT", zlib.deflateSync(Buffer.alloc(10))));
  assert.match((() => { try { readPng(short); } catch (e) { return e.message; } })(), /truncated/);
  const badFilter = png(ihdr(1, 1, 8, 0), chunk("IDAT", zlib.deflateSync(Buffer.from([9, 0]))));
  assert.match((() => { try { readPng(badFilter); } catch (e) { return e.message; } })(), /filter 9/);
});

test("refuses an animated PNG, but a preview shows its first frame", () => {
  const actl = Buffer.alloc(8);
  actl.writeUInt32BE(2, 0);
  const apng = png(ihdr(1, 1, 8, 0), chunk("acTL", actl), chunk("IDAT", zlib.deflateSync(Buffer.from([0, 77]))));
  assert.equal((() => { try { readPng(apng); } catch (e) { return e.code; } })(), "ANIMATED");
  assert.deepEqual(Array.from(decodePng(apng).rgba), [77, 77, 77, 255]);
});

test("16-bit tRNS matches the whole value, not only the high byte", () => {
  // Two colours a single low byte apart; only the first is transparent.
  const trns = Buffer.from([0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc]);
  const rows = Buffer.from([0, 0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0x12, 0x34, 0x56, 0x78, 0x9a, 0xbd]);
  const { image } = readPng(png(ihdr(2, 1, 16, 2), chunk("tRNS", trns), chunk("IDAT", zlib.deflateSync(rows))));
  assert.deepEqual(Array.from(image.rgba), [0x12, 0x56, 0x9a, 0, 0x12, 0x56, 0x9a, 255]);
});

test("a damaged ancillary chunk is dropped, a damaged critical one refused", () => {
  const good = encodePng({ width: 1, height: 1, rgba: new Uint8Array([1, 2, 3, 255]) }, { chunks: [textChunk("k", "v")] });
  const at = good.indexOf("tEXt") + 4;
  const badText = Buffer.from(good);
  badText[at] ^= 1;
  assert.deepEqual(readPng(badText).info.chunks, []);
  const badIhdr = Buffer.from(good);
  badIhdr[16] ^= 1;
  assert.equal((() => { try { readPng(badIhdr); } catch (e) { return e.code; } })(), "CORRUPT");
});

// ---- Encoder ----

test("encoder round-trips every layout it chooses", () => {
  const layouts = new Set();
  for (const { name, img } of encoderCases()) {
    const buf = encodePng(img);
    layouts.add(`${buf[25]}/${buf[24]}`);
    assert.deepEqual(canonical(readPng(buf).image.rgba), canonical(img.rgba), name);
    assert.deepEqual(canonical(readPng(encodePng(img, { fast: true })).image.rgba), canonical(img.rgba), name);
  }
  // Palette at 1, 2, 4 and 8 bits, RGB and RGBA.
  assert.deepEqual([...layouts].sort(), ["2/8", "3/1", "3/2", "3/4", "3/8", "6/8"]);
});

test("encoder writes pixel art as a small palette PNG", () => {
  const r = rng(3);
  const img = randomImage(r, 256, 256, 12, "binary");
  const indexed = encodePng(img);
  const rgba = encodePng(img, { fast: true });
  assert.equal(indexed[25], 3);
  assert.ok(indexed.length * 2 < rgba.length, `${indexed.length} vs ${rgba.length}`);
});

test("encoder places carried-over chunks where the PNG spec wants them", () => {
  const src = readPng(fs.readFileSync(SUITE + "cdfn2c08.png"));
  const chunks = [
    { type: "gAMA", data: Buffer.from([0, 0, 0xb1, 0x8f]) },
    ...src.info.chunks,
    textChunk("ludo:grid", '{"cols":2}'),
    textChunk("ludo:grid", '{"cols":4}')
  ];
  const out = encodePng({ width: 2, height: 1, rgba: new Uint8Array([1, 2, 3, 255, 4, 5, 6, 128]) }, { chunks });
  const order = [];
  for (let pos = 8; pos < out.length; pos += 12 + out.readUInt32BE(pos)) order.push(out.toString("latin1", pos + 4, pos + 8));
  assert.deepEqual(order, ["IHDR", "gAMA", "PLTE", "tRNS", "pHYs", "IDAT", "tEXt", "IEND"]);
  assert.deepEqual(readText(out), { "ludo:grid": '{"cols":4}' });
});

// ---- Encoder, checked by other decoders ----

function oracles() {
  const has = (cmd, args) => {
    try {
      execFileSync(cmd, args, { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
  const list = [];
  // ImageMagick 7 is `magick`; 6 (Ubuntu's package) is `convert`.
  const im = has("magick", ["-version"]) ? "magick" : has("convert", ["-version"]) ? "convert" : undefined;
  if (im) list.push({ name: "ImageMagick", decode: file => execFileSync(im, [file, "-depth", "8", "RGBA:-"], { maxBuffer: 1 << 26 }) });
  if (has("python3", ["-I", "-c", "import PIL"])) {
    const code = "import sys;from PIL import Image;sys.stdout.buffer.write(Image.open(sys.argv[1]).convert('RGBA').tobytes())";
    list.push({ name: "Pillow", decode: file => execFileSync("python3", ["-I", "-c", code, file], { maxBuffer: 1 << 26 }) });
  }
  return list;
}

test("files the encoder writes decode identically in ImageMagick and Pillow", t => {
  const list = oracles();
  if (!list.length) return t.skip("neither ImageMagick nor Pillow is installed");
  if (list.length < 2) t.diagnostic(`only ${list[0].name} is installed`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-png-"));
  try {
    for (const { name, img } of encoderCases()) {
      const file = path.join(dir, name.replace(/\W+/g, "_") + ".png");
      fs.writeFileSync(file, encodePng(img, { chunks: [textChunk("ludo:grid", "{}"), { type: "gAMA", data: Buffer.from([0, 0, 0xb1, 0x8f]) }] }));
      for (const o of list) assert.deepEqual(canonical(o.decode(file)), canonical(img.rgba), `${name} in ${o.name}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
