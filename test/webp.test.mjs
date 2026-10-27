// WebP: the decoder (lossy, lossless, alpha, animation) against libwebp's own
// decodes of a corpus and of fresh cwebp files, the lossless encoder against
// dwebp, Pillow, ffmpeg and ImageMagick, hostile input, and the CLI reading
// WebP with no converter on PATH. The corpus (test/corpus/webp) needs no
// tools; the live checks run where the tools are installed and are required
// where LUDO_REQUIRE_WEBP_TOOLS=1 (CI installs them).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { decodeWebp, encodeWebp, isWebp, readWebp, WebpError } from "../dist/tty/webp.js";
import { encodePng, readPng } from "../dist/tty/png.js";
import { convertToPng, loadImage } from "../dist/tty/image.js";
import { webpFps } from "../dist/toolbox/io.js";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const CORPUS = fileURLToPath(new URL("./corpus/webp/", import.meta.url));
const EXPECTED = JSON.parse(fs.readFileSync(path.join(CORPUS, "expected.json"), "utf8"));
const REQUIRE = process.env.LUDO_REQUIRE_WEBP_TOOLS === "1";
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ludo-webp-test-"));
const sha = buf => crypto.createHash("sha256").update(buf).digest("hex");

// ---- Tools ----

const runs = (cmd, args) => {
  try {
    return spawnSync(cmd, args, { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
};
const out = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { stdio: ["ignore", "pipe", "ignore"] }).toString();
  } catch {
    return "";
  }
};
const DWEBP = runs("dwebp", ["-version"]);
const CWEBP = runs("cwebp", ["-version"]);
const WEBPINFO = runs("webpinfo", ["-version"]);
const PILLOW = runs("python3", ["-I", "-c", "import sys\nfrom PIL import features\nsys.exit(0 if features.check('webp') else 1)"]);
const FFMPEG = / webp /.test(out("ffmpeg", ["-hide_banner", "-decoders"]));
// ImageMagick 7 is `magick`; 6 (Ubuntu's) is `convert`, never called on
// Windows (where it is the FAT-to-NTFS tool). Either may lack WebP.
const IM = ["magick", ...(process.platform === "win32" ? [] : ["convert"])].find(cmd => /^\s*WEBP\*?\s+\S+\s+r/m.test(out(cmd, ["-list", "format"])));

// Skips a test whose tool is missing, unless the tools are required.
function need(t, ok, name) {
  if (ok) return true;
  if (REQUIRE) assert.fail(`${name} is required (LUDO_REQUIRE_WEBP_TOOLS) but not installed`);
  t.skip(`${name} is not installed`);
  return false;
}

// 8-bit RGBA from dwebp's PAM output (its default, "fancy" upsampling).
function dwebp(file) {
  const pam = path.join(path.dirname(file), "dwebp.pam");
  execFileSync("dwebp", ["-quiet", file, "-pam", "-o", pam]);
  const buf = fs.readFileSync(pam);
  return buf.subarray(buf.indexOf("ENDHDR\n") + 7);
}
const decoders = () =>
  [
    DWEBP && { name: "dwebp", decode: dwebp },
    PILLOW && {
      name: "Pillow",
      decode: file =>
        execFileSync("python3", ["-I", "-c", "import sys\nfrom PIL import Image\nsys.stdout.buffer.write(Image.open(sys.argv[1]).convert('RGBA').tobytes())", file], { maxBuffer: 1 << 28 })
    },
    FFMPEG && { name: "ffmpeg", decode: file => execFileSync("ffmpeg", ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgba", "-"], { maxBuffer: 1 << 28 }) },
    IM && { name: "ImageMagick", decode: file => execFileSync(IM, [file, "-depth", "8", "RGBA:-"], { maxBuffer: 1 << 28 }) }
  ].filter(Boolean);

// RGB under a fully transparent pixel is not kept; compare without it.
function canonical(rgba) {
  const b = Buffer.from(rgba);
  for (let i = 0; i < b.length; i += 4) if (b[i + 3] === 0) b.fill(0, i, i + 3);
  return b;
}

// A deterministic random source (mulberry32).
function random(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Images of every kind the encoder distinguishes, and sizes that end
// mid-block. RGB under alpha 0 is 0 (the encoder writes it so).
function image(kind, width, height, seed = 1) {
  const r = random(seed);
  const rgba = new Uint8Array(width * height * 4);
  const palette = Array.from({ length: 6 }, () => [r() * 256, r() * 256, r() * 256, 255].map(Math.floor));
  for (let i = 0; i < width * height; i++) {
    const x = i % width;
    const y = Math.floor(i / width);
    const g = Math.floor(r() * 256);
    let p;
    if (kind === "opaque") p = [g, (x * 7) & 255, (y * 5) & 255, 255];
    else if (kind === "binary-alpha") p = [g, x & 255, y & 255, r() < 0.4 ? 0 : 255];
    else if (kind === "soft-alpha") p = [g, (x * 3) & 255, 90, Math.floor(r() * 256)];
    else if (kind === "few-colours") p = palette[(x >> 2) % 6].slice();
    else if (kind === "many-colours") p = [g, Math.floor(r() * 256), Math.floor(r() * 256), Math.floor(r() * 256)];
    else if (kind === "grey") p = [g, g, g, 255];
    else if (kind === "grey-alpha") p = [g, g, g, (x * 9) & 255];
    else if (kind === "solid") p = [12, 200, 77, 255];
    else p = [0, 0, 0, 0]; // transparent
    rgba.set(p, i * 4);
  }
  return { width, height, rgba: canonical(rgba) };
}

function encoderCases() {
  return [
    ["opaque", 64, 48],
    ["binary-alpha", 61, 33],
    ["soft-alpha", 97, 65],
    ["few-colours", 128, 32],
    ["many-colours", 512, 512],
    ["grey", 255, 3],
    ["grey-alpha", 31, 77],
    ["solid", 300, 300], // runs longer than one backward reference
    ["transparent", 17, 9],
    ["soft-alpha", 1, 1],
    ["opaque", 1, 7],
    ["many-colours", 7, 1],
    ["binary-alpha", 257, 256]
  ].map(([kind, w, h], k) => ({ name: `${kind} ${w}x${h}`, img: image(kind, w, h, k + 1) }));
}

// ---- The corpus ----

test("the decoder matches libwebp on its test corpus and on animations libwebp made", () => {
  const seen = { lossy: 0, lossless: 0, alpha: 0, animated: 0, refused: 0 };
  for (const [file, want] of Object.entries(EXPECTED)) {
    const buf = fs.readFileSync(path.join(CORPUS, file));
    if (want.refused) {
      assert.throws(() => decodeWebp(buf), WebpError, `${file}: libwebp refuses it`);
      seen.refused++;
      continue;
    }
    const got = decodeWebp(buf);
    assert.deepEqual([got.width, got.height], [want.width, want.height], file);
    assert.deepEqual(
      got.frames.map(f => sha(f.rgba)),
      want.frames,
      `${file}: ${want.durations ? "the frames Pillow (libwebp's WebPAnimDecoder) shows" : "the RGBA dwebp decodes"}`
    );
    if (want.durations) {
      assert.deepEqual(got.durations, want.durations, `${file}: durations`);
      assert.equal(got.loops, want.loops, `${file}: loop count`);
      seen.animated++;
    } else if (got.lossy) seen.lossy++;
    else seen.lossless++;
    if (got.frames.some(f => f.rgba.some((v, i) => i % 4 === 3 && v !== 255))) seen.alpha++;
  }
  // What the corpus covers: libwebp-test-data's lossy conformance vectors
  // (vp80-*), every VP8L transform combination (lossless_vec_*), alpha
  // filters and compression, odd sizes, and our libwebp-made animations.
  assert.ok(seen.lossy >= 70 && seen.lossless >= 40 && seen.alpha >= 40 && seen.animated >= 8, JSON.stringify(seen));
});

test("an animation's frames, timing and first frame alone", () => {
  const buf = fs.readFileSync(path.join(CORPUS, "made-anim-mux.webp"));
  const all = decodeWebp(buf);
  assert.equal(all.animated, true);
  assert.deepEqual(all.durations, [100, 70, 50, 60, 40, 0]);
  assert.equal(all.loops, 3);
  assert.equal(all.lossy, true, "frames 4 and 5 are lossy");
  const first = decodeWebp(buf, { firstFrame: true });
  assert.equal(first.frames.length, 1);
  assert.deepEqual(first.frames[0].rgba, all.frames[0].rgba);
  assert.deepEqual(readWebp(buf).rgba, all.frames[0].rgba);
  const still = decodeWebp(fs.readFileSync(path.join(CORPUS, "test.webp")));
  assert.deepEqual([still.animated, still.frames.length, still.loops], [false, 1, 1]);
});

test("a WebP's frame rate is read back from its durations", () => {
  assert.equal(webpFps([83, 83, 83, 83]), 12);
  assert.equal(webpFps([83, 84, 83, 84]), 12, "however the encoder rounded");
  assert.equal(webpFps([100, 100]), 10);
  assert.equal(webpFps([33, 34, 33]), 30);
  assert.equal(webpFps([17, 16, 17]), 60);
  assert.equal(webpFps([0, 0, 5]), 10, "10 ms or less play as 100 ms");
  assert.equal(webpFps([40, 120]), 12.5, "no whole fps fits: the average");
  assert.equal(webpFps(EXPECTED["made-anim-lossless.webp"].durations), 12);
});

// ---- Live: fresh files from cwebp, decoded like dwebp ----

test("lossy files cwebp writes with every option that changes the bitstream decode exactly as dwebp does", t => {
  if (!need(t, CWEBP && DWEBP, "cwebp and dwebp")) return;
  const dir = tmp();
  const src = path.join(dir, "src.png");
  const options = [
    ["-q", "1"],
    ["-q", "100", "-m", "6"],
    ["-q", "50", "-f", "0"],
    ["-q", "50", "-f", "100", "-sharpness", "7"],
    ["-q", "60", "-segments", "1"],
    ["-q", "60", "-segments", "4", "-sns", "100"],
    ["-q", "60", "-nostrong"],
    ["-q", "60", "-partition_limit", "100"],
    ["-q", "75", "-sharp_yuv"],
    ["-q", "70", "-alpha_q", "100", "-alpha_filter", "best"],
    ["-q", "70", "-alpha_q", "50", "-alpha_filter", "fast", "-alpha_method", "0"],
    ["-q", "70", "-alpha_method", "1", "-exact"]
  ];
  let n = 0;
  for (const [w, h] of [
    [1, 1],
    [3, 5],
    [17, 33],
    [100, 1],
    [129, 67]
  ]) {
    for (const kind of ["opaque", "soft-alpha", "few-colours"]) {
      fs.writeFileSync(src, encodePng(image(kind, w, h, w * h)));
      for (const opt of options) {
        const file = path.join(dir, "out.webp");
        execFileSync("cwebp", ["-quiet", ...opt, src, "-o", file]);
        assert.deepEqual(Buffer.from(decodeWebp(fs.readFileSync(file)).frames[0].rgba), Buffer.from(dwebp(file)), `${kind} ${w}x${h} cwebp ${opt.join(" ")}`);
        n++;
      }
    }
  }
  t.diagnostic(`${n} lossy files`);
});

test("lossless files cwebp writes at every effort level decode to their source exactly", t => {
  if (!need(t, CWEBP, "cwebp")) return;
  const dir = tmp();
  const src = path.join(dir, "src.png");
  for (const [kind, w, h] of [
    ["few-colours", 37, 21],
    ["soft-alpha", 64, 64],
    ["grey", 50, 3],
    ["many-colours", 1, 9],
    ["binary-alpha", 130, 70]
  ]) {
    const img = image(kind, w, h, w + h);
    fs.writeFileSync(src, encodePng(img));
    for (let z = 0; z <= 9; z++) {
      const file = path.join(dir, "out.webp");
      execFileSync("cwebp", ["-quiet", "-lossless", "-exact", "-z", String(z), src, "-o", file]);
      assert.deepEqual(canonical(decodeWebp(fs.readFileSync(file)).frames[0].rgba), Buffer.from(img.rgba), `${kind} ${w}x${h} -z ${z}`);
    }
  }
});

// ---- The encoder ----

test("files the encoder writes decode exactly in dwebp, Pillow, ffmpeg and ImageMagick, and pass webpinfo", t => {
  if (!need(t, DWEBP && PILLOW && WEBPINFO, "dwebp, webpinfo and Pillow")) return;
  const list = decoders();
  t.diagnostic(`decoders: ${list.map(o => o.name).join(", ")}`);
  const dir = tmp();
  for (const { name, img } of encoderCases()) {
    const buf = encodeWebp(img);
    assert.ok(isWebp(buf));
    const file = path.join(dir, name.replace(/\W+/g, "_") + ".webp");
    fs.writeFileSync(file, buf);
    assert.match(out("webpinfo", [file]), /No error detected/, `${name}: webpinfo`);
    assert.deepEqual(canonical(decodeWebp(buf).frames[0].rgba), Buffer.from(img.rgba), `${name}: our decoder`);
    for (const o of list) assert.deepEqual(canonical(o.decode(file)), Buffer.from(img.rgba), `${name} in ${o.name}`);
  }
});

// At most 512x384 of the top left, to keep cwebp -z 9 quick.
function corner(img) {
  const width = Math.min(img.width, 512);
  const height = Math.min(img.height, 384);
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) rgba.set(img.rgba.subarray(y * img.width * 4, (y * img.width + width) * 4), y * width * 4);
  return { width, height, rgba };
}

test("encoder size next to cwebp -lossless -z 0, 6 and 9 (a report, not a check)", t => {
  if (!need(t, CWEBP, "cwebp")) return;
  const dir = tmp();
  const rows = [];
  for (const [label, file] of [
    ["sprite sheet", "made-sheet-lossless.webp"],
    ["animation frame", "made-anim-lossless.webp"],
    ["photo (decoded lossy)", "vp80-00-comprehensive-008.webp"],
    ["lossy + alpha (decoded)", "lossy_alpha1.webp"],
    ["synthetic", "lossless_color_transform.webp"]
  ]) {
    const img = corner(decodeWebp(fs.readFileSync(path.join(CORPUS, file))).frames[0]);
    const flat = { ...img, rgba: canonical(img.rgba) };
    const png = path.join(dir, "in.png");
    fs.writeFileSync(png, encodePng(flat));
    const sizes = {};
    for (const z of [0, 6, 9]) {
      const o = path.join(dir, "c.webp");
      execFileSync("cwebp", ["-quiet", "-lossless", "-z", String(z), png, "-o", o]);
      sizes[z] = fs.statSync(o).size;
    }
    const ours = encodeWebp(flat).length;
    rows.push(
      `${label} ${img.width}x${img.height}: ours ${ours} B; cwebp -z 0 ${sizes[0]}, -z 6 ${sizes[6]}, -z 9 ${sizes[9]} (ours is ${(ours / sizes[9]).toFixed(2)}x -z 9); our PNG ${encodePng(flat).length}`
    );
  }
  for (const r of rows) t.diagnostic(r);
});

test("the encoder refuses what a WebP cannot hold", () => {
  assert.throws(() => encodeWebp({ width: 16385, height: 1, rgba: new Uint8Array(16385 * 4) }), WebpError);
  assert.throws(() => encodeWebp({ width: 0, height: 0, rgba: new Uint8Array(0) }), WebpError);
});

// ffmpeg (its own decoder, webp_anim since 8.0) and ImageMagick 7 composite
// with their own code: they match libwebp's frames exactly only where no
// semi-transparent pixel is blended and nothing is lossy, so these are the
// files they are held to. Elsewhere they differ by rounding (and in colour
// under transparent pixels, which is ignored).
test("animations without blending of soft alpha match ffmpeg and ImageMagick too", t => {
  const FFMPEG_ANIM = / webp_anim /.test(out("ffmpeg", ["-hide_banner", "-decoders"]));
  const MAGICK7 = IM === "magick";
  if (!FFMPEG_ANIM && !MAGICK7) return t.skip("neither ffmpeg 8 nor ImageMagick 7 with WebP is installed");
  for (const file of ["made-anim-lossless.webp", "made-gif-dispose.webp", "made-gif-anim-gr.webp"]) {
    const p = path.join(CORPUS, file);
    const ours = decodeWebp(fs.readFileSync(p));
    const want = Buffer.concat(ours.frames.map(f => canonical(f.rgba)));
    if (FFMPEG_ANIM) {
      const raw = execFileSync("ffmpeg", ["-v", "error", "-i", p, "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgba", "-"], { maxBuffer: 1 << 28 });
      assert.ok(canonical(raw).equals(want), `${file} in ffmpeg`);
    }
    if (MAGICK7) assert.ok(canonical(execFileSync("magick", [p, "-coalesce", "-depth", "8", "RGBA:-"], { maxBuffer: 1 << 28 })).equals(want), `${file} in ImageMagick`);
  }
});

// ---- Hostile input ----

// Mutations of a file: cut, cut with the sizes patched to match (so the
// decoders, not the RIFF check, meet the end), bytes changed, a wild 32-bit
// field, bytes dropped.
function mutate(original, k, r) {
  let buf = Buffer.from(original);
  const kind = k % 5;
  const at = n => 12 + Math.floor(r() * Math.max(1, n - 12));
  if (kind === 0) buf = buf.subarray(0, at(buf.length));
  else if (kind === 1) {
    buf = Buffer.from(buf.subarray(0, at(buf.length)));
    if (buf.length >= 8) buf.writeUInt32LE(buf.length - 8, 4);
    if (buf.length >= 20) buf.writeUInt32LE(Math.min(buf.readUInt32LE(16), buf.length - 20), 16);
  } else if (kind === 2) for (let n = 0; n < 1 + r() * 4; n++) buf[at(buf.length)] = (r() * 256) | 0;
  else if (kind === 3) {
    if (buf.length >= 16) buf.writeUInt32LE((r() * 0xffffffff) >>> 0, 12 + 4 * Math.floor(r() * ((buf.length - 16) / 4)));
  } else {
    const from = at(buf.length);
    buf = Buffer.concat([buf.subarray(0, from), buf.subarray(from + 1 + Math.floor(r() * 40))]);
    buf.writeUInt32LE(buf.length - 8, 4);
  }
  return buf;
}

test("random damage to real files never escapes as anything but a WebpError, nor passes the pixel budget", () => {
  const r = random(42);
  const started = Date.now();
  const maxPixels = 2_000_000;
  let refused = 0;
  let read = 0;
  for (const file of Object.keys(EXPECTED)) {
    const original = fs.readFileSync(path.join(CORPUS, file));
    if (original.length > 50_000) continue;
    for (let k = 0; k < 30; k++) {
      const buf = mutate(original, k, r);
      try {
        const got = decodeWebp(buf, { maxPixels });
        assert.ok(got.width * got.height * got.frames.length <= maxPixels);
        for (const f of got.frames) assert.equal(f.rgba.length, got.width * got.height * 4);
        read++;
      } catch (e) {
        if (!(e instanceof WebpError)) throw new Error(`${file} mutation ${k}: ${e.stack}`);
        refused++;
      }
    }
  }
  assert.ok(refused > 1000, `${refused} refused, ${read} read`);
  assert.ok(Date.now() - started < 60_000);
});

test("random bytes behind each kind of header are refused with a WebpError", () => {
  const r = random(7);
  const riff = (fourcc, body) => {
    const chunk = Buffer.concat([Buffer.from(fourcc, "latin1"), Buffer.alloc(4), body, Buffer.alloc(body.length & 1)]);
    chunk.writeUInt32LE(body.length, 4);
    const head = Buffer.from("RIFF\0\0\0\0WEBP", "latin1");
    head.writeUInt32LE(4 + chunk.length, 4);
    return Buffer.concat([head, chunk]);
  };
  const lossyHead = (w, h) => Buffer.from([0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a, w & 255, w >> 8, h & 255, h >> 8]);
  for (let i = 0; i < 400; i++) {
    const junk = Buffer.from(Array.from({ length: 1 + Math.floor(r() * 300) }, () => Math.floor(r() * 256)));
    const w = 1 + Math.floor(r() * 64);
    const h = 1 + Math.floor(r() * 64);
    const vp8l = Buffer.alloc(5);
    vp8l[0] = 0x2f;
    vp8l.writeUInt32LE((w - 1) | ((h - 1) << 14), 1);
    for (const buf of [riff("VP8 ", Buffer.concat([lossyHead(w, h), junk])), riff("VP8L", Buffer.concat([vp8l, junk])), riff("VP8X", junk), riff("ANMF", junk)]) {
      try {
        decodeWebp(buf, { maxPixels: 1_000_000 });
      } catch (e) {
        if (!(e instanceof WebpError)) throw new Error(`case ${i}: ${e.stack}`);
      }
    }
  }
});

test("absurd sizes are refused before anything is allocated for them", () => {
  const vp8l = (w, h) => {
    const b = Buffer.from("RIFF\0\0\0\0WEBPVP8L\x06\0\0\0\x2f\0\0\0\0\0", "latin1");
    b.writeUInt32LE(b.length - 8, 4);
    b.writeUInt32LE((w - 1) | ((h - 1) << 14), 21);
    return b;
  };
  const vp8x = (w, h, flags, extra = Buffer.alloc(0)) => {
    const b = Buffer.concat([Buffer.from("RIFF\0\0\0\0WEBPVP8X\x0a\0\0\0", "latin1"), Buffer.alloc(10), extra]);
    b[20] = flags;
    b.writeUIntLE(w - 1, 24, 3);
    b.writeUIntLE(h - 1, 27, 3);
    b.writeUInt32LE(b.length - 8, 4);
    return b;
  };
  const before = process.memoryUsage().arrayBuffers;
  const code = fn => {
    try {
      fn();
    } catch (e) {
      assert.ok(e instanceof WebpError, e.stack);
      return e.code;
    }
    return "read";
  };
  assert.equal(code(() => decodeWebp(vp8l(16384, 16384))), "TOO_LARGE");
  assert.equal(code(() => decodeWebp(vp8x(1 << 24, 1 << 24, 0))), "TOO_LARGE");
  assert.equal(code(() => decodeWebp(vp8x(16384, 16384, 0, Buffer.from("VP8L\x05\0\0\0\x2f\xff\xff\xff\x0f\0", "latin1")))), "TOO_LARGE");
  const lossy = Buffer.from("RIFF\0\0\0\0WEBPVP8 \x0a\0\0\0\x10\x02\0\x9d\x01\x2a\xff\x3f\xff\x3f", "latin1");
  lossy.writeUInt32LE(lossy.length - 8, 4);
  assert.equal(code(() => decodeWebp(lossy)), "TOO_LARGE");
  // 2000 frames of 2000x2000: over the budget in all, refused before any is decoded.
  const anmf = Buffer.from("ANMF\x18\0\0\0" + "\0".repeat(24), "latin1");
  anmf.writeUIntLE(1999, 14, 3);
  anmf.writeUIntLE(1999, 17, 3);
  const frames = Buffer.concat([Buffer.from("ANIM\x06\0\0\0\0\0\0\0\0\0", "latin1"), ...Array(2000).fill(anmf)]);
  assert.equal(code(() => decodeWebp(vp8x(2000, 2000, 0x12, frames))), "TOO_LARGE");
  assert.ok(process.memoryUsage().arrayBuffers - before < 64 * 1024 * 1024);
  // And the rest of the error codes.
  assert.equal(code(() => decodeWebp(Buffer.from("RIFF\x04\0\0\0WEBM", "latin1"))), "NOT_WEBP");
  assert.equal(code(() => decodeWebp(fs.readFileSync(path.join(CORPUS, "test.webp")).subarray(0, 100))), "CORRUPT");
  const outside = Buffer.from(anmf);
  outside.writeUIntLE(5, 8, 3); // x offset 10
  outside.writeUIntLE(7, 14, 3); // 8 wide
  outside.writeUIntLE(7, 17, 3); // 8 high
  assert.equal(code(() => decodeWebp(vp8x(16, 16, 0x12, Buffer.concat([Buffer.from("ANIM\x06\0\0\0\0\0\0\0\0\0", "latin1"), outside])))), "CORRUPT");
  const interFrame = Buffer.from("RIFF\0\0\0\0WEBPVP8 \x0a\0\0\0\x11\x02\0\x9d\x01\x2a\x01\0\x01\0", "latin1");
  interFrame.writeUInt32LE(interFrame.length - 8, 4);
  assert.equal(code(() => decodeWebp(interFrame)), "UNSUPPORTED");
});

// ---- The CLI, with no converter to fall back on ----

let collector;
const events = [];
before(async () => {
  collector = http.createServer((req, res) => {
    let body = "";
    req.on("data", d => (body += d));
    req.on("end", () => {
      if (req.url === "/api/cli/events") events.push(...JSON.parse(body).events);
      res.end("{}");
    });
  });
  await new Promise(resolve => collector.listen(0, "127.0.0.1", resolve));
});
after(() => collector.close());

// Runs the CLI without blocking this process, which serves its telemetry.
function cli(args, cwd, env = {}) {
  // No PATH (under any spelling, for Windows): no dwebp, sips, ImageMagick
  // or ffmpeg can run.
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toUpperCase() !== "PATH"));
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...base, PATH: "", LUDO_TELEMETRY: "0", LUDO_API_KEY: "", LUDO_API_URL: "http://127.0.0.1:9", LUDO_CONFIG_DIR: path.join(cwd, ".config"), LUDO_CACHE_DIR: path.join(cwd, ".cache"), ...env }
    });
    let stdout = "";
    let err = "";
    child.stdout.on("data", d => (stdout += d));
    child.stderr.on("data", d => (err += d));
    child.on("close", code => resolve({ code, err, json: stdout.trim().startsWith("{") ? JSON.parse(stdout) : undefined }));
  });
}

test("toolbox sprite slice reads an animated WebP as a sheet of its frames, with no converter on PATH", async () => {
  const dir = tmp();
  fs.copyFileSync(path.join(CORPUS, "made-anim-lossless.webp"), path.join(dir, "walk.webp"));
  const r = await cli(["toolbox", "sprite", "slice", "walk.webp", "--out", ".", "--json"], dir, {
    LUDO_TELEMETRY: "",
    DO_NOT_TRACK: "",
    LUDO_API_URL: `http://127.0.0.1:${collector.address().port}`
  });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.grid_from, "webp");
  assert.deepEqual(r.json.grid, { cols: 3, rows: 2, frames: 6, frame_width: 64, frame_height: 48, fps: 12 });
  const want = decodeWebp(fs.readFileSync(path.join(dir, "walk.webp"))).frames;
  r.json.files.forEach((f, k) => assert.deepEqual(Buffer.from(readPng(fs.readFileSync(path.join(dir, f))).image.rgba), canonical(want[k].rgba), `frame ${k + 1}`));
  const event = events.find(e => e.command === "toolbox sprite slice");
  assert.equal(event?.props.input_format, "webp");
});

test("a still WebP sheet slices, and a broken one is bad input (exit 12), with no converter on PATH", async () => {
  const dir = tmp();
  fs.copyFileSync(path.join(CORPUS, "made-sheet-lossy-alpha.webp"), path.join(dir, "sheet.webp"));
  const r = await cli(["toolbox", "sprite", "slice", "sheet.webp", "--grid", "2x2", "--out", ".", "--json"], dir);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.files.length, 4);
  const sheet = readWebp(fs.readFileSync(path.join(dir, "sheet.webp")));
  const frame = readPng(fs.readFileSync(path.join(dir, r.json.files[3]))).image;
  assert.deepEqual([frame.width, frame.height], [sheet.width / 2, sheet.height / 2]);
  fs.writeFileSync(path.join(dir, "bad.webp"), fs.readFileSync(path.join(CORPUS, "test.webp")).subarray(0, 300));
  const bad = await cli(["toolbox", "sprite", "slice", "bad.webp", "--json"], dir);
  assert.equal(bad.code, 12, bad.err);
  assert.match(bad.err, /Cannot read bad\.webp: the file is truncated/);
});

test("previews and PNG copies read WebP in-process", () => {
  const file = path.join(CORPUS, "lossy_alpha1.webp");
  const want = decodeWebp(fs.readFileSync(file)).frames[0];
  const saved = process.env.PATH;
  process.env.PATH = "";
  try {
    const img = loadImage(file);
    assert.deepEqual(img.rgba, want.rgba);
    const dst = path.join(tmp(), "copy.png");
    assert.equal(convertToPng(path.join(CORPUS, "made-anim-mux.webp"), dst), true);
    const first = decodeWebp(fs.readFileSync(path.join(CORPUS, "made-anim-mux.webp")), { firstFrame: true }).frames[0];
    assert.deepEqual(Buffer.from(readPng(fs.readFileSync(dst)).image.rgba), canonical(first.rgba), "an animation's first frame");
    const cut = path.join(tmp(), "cut.webp");
    fs.writeFileSync(cut, fs.readFileSync(file).subarray(0, 500));
    assert.equal(loadImage(cut), undefined, "unreadable: no preview, no error");
    assert.equal(convertToPng(cut, dst + "2"), false);
  } finally {
    process.env.PATH = saved;
  }
});
