// GIF: the encoder (toolbox/gif.ts on tty/gif.ts), Wu's quantizer, the
// decoder, and `ludo toolbox sprite gif`. Every GIF written here is also
// decoded by ImageMagick, Pillow and ffmpeg when they are installed (CI
// installs them); the decoder is checked against the image-rs corpus.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { gifDelays, gifFps, makeGif } from "../dist/toolbox/gif.js";
import { PaletteMap, WuQuantizer } from "../dist/toolbox/quantize.js";
import { decodeGif, encodeGif, GifError } from "../dist/tty/gif.js";
import { parseGif } from "../dist/tty/omggif.js";
import { encodePng, readPng } from "../dist/tty/png.js";
import { joinFrames } from "../dist/toolbox/sheet.js";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const CORPUS = fileURLToPath(new URL("./corpus/gif/", import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ludo-gif-test-"));

const has = (cmd, args) => spawnSync(cmd, args, { stdio: "ignore" }).status === 0;
const MAGICK = has("magick", ["-version"]);
const PILLOW = has("python3", ["-I", "-c", "import PIL"]);
const FFMPEG = has("ffmpeg", ["-version"]);

// RGB under a fully transparent pixel is not kept; compare without it.
function canonical(rgba) {
  const out = Buffer.from(rgba);
  for (let i = 0; i < out.length; i += 4) if (out[i + 3] === 0) out.fill(0, i, i + 3);
  return out;
}
const sha = buf => crypto.createHash("sha256").update(canonical(buf)).digest("hex");

// A deterministic random source (mulberry32).
function random(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Frames of a small sprite moving over transparency, in `colours` colours,
// some of them semi-transparent at the edges.
function walker(n, w = 24, h = 20, colours = 12) {
  const rnd = random(7);
  const palette = Array.from({ length: colours }, () => [Math.floor(rnd() * 256), Math.floor(rnd() * 256), Math.floor(rnd() * 256)]);
  return Array.from({ length: n }, (_, k) => {
    const rgba = new Uint8Array(w * h * 4);
    for (let y = 3; y < h - 3; y++) {
      for (let x = 2 + k; x < 10 + k && x < w; x++) {
        const c = palette[(x * 3 + y * 5 + k) % colours];
        const edge = x === 2 + k || y === 3;
        rgba.set([...c, edge ? 90 + k * 20 : 255], (y * w + x) * 4);
      }
    }
    return { width: w, height: h, rgba };
  });
}

// What the GIF must show: alpha under the threshold gone, the rest opaque.
function expectedFrames(frames, threshold = 128) {
  return frames.map(f => {
    const out = Buffer.from(f.rgba);
    for (let i = 0; i < out.length; i += 4) {
      if (out[i + 3] < threshold) out.fill(0, i, i + 4);
      else out[i + 3] = 255;
    }
    return out;
  });
}

// The frames of a GIF file as ImageMagick, Pillow and ffmpeg show them (the
// ones installed), as one buffer each.
function oracleDecodes(file) {
  const out = {};
  if (MAGICK) out.ImageMagick = execFileSync("magick", [file, "-coalesce", "-depth", "8", "RGBA:-"], { maxBuffer: 1 << 28 });
  if (PILLOW) {
    const code = "import sys\nfrom PIL import Image, ImageSequence\nfor f in ImageSequence.Iterator(Image.open(sys.argv[1])): sys.stdout.buffer.write(f.convert('RGBA').tobytes())";
    out.Pillow = execFileSync("python3", ["-I", "-c", code, file], { maxBuffer: 1 << 28 });
  }
  if (FFMPEG) out.ffmpeg = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgba", "-"], { maxBuffer: 1 << 28 });
  return out;
}

test("delays are whole centiseconds that keep the frame rate on average", () => {
  assert.deepEqual(gifDelays(6, 12), [8, 9, 8, 8, 9, 8]);
  assert.deepEqual(gifDelays(4, 10), [10, 10, 10, 10]);
  assert.deepEqual(gifDelays(3, 50), [2, 2, 2]);
  assert.deepEqual(gifDelays(3, 100), [2, 2, 2], "never under 2 cs: browsers play 0-1 cs as 10");
  for (const fps of [7, 12, 15, 24, 30]) {
    const d = gifDelays(fps * 3, fps);
    assert.equal(d.reduce((a, b) => a + b, 0), 300, `${fps} fps: 3 seconds`);
    assert.ok(Math.max(...d) - Math.min(...d) <= 1, `${fps} fps: delays differ by at most 1 cs`);
  }
});

test("a GIF's frame rate is read back from its delays", () => {
  for (const fps of [5, 8, 10, 12, 15, 24, 25, 30, 50]) for (const n of [5, 7, 24]) assert.equal(gifFps(gifDelays(n, fps)), fps, `${n} frames at ${fps} fps`);
  // Two frames of 4 cs fit 24 and 25 fps alike: either plays the same.
  for (const fps of [7, 24, 33]) assert.deepEqual(gifDelays(2, gifFps(gifDelays(2, fps))), gifDelays(2, fps));
  assert.equal(gifFps([0, 1, 0]), 10, "0-1 cs play as 10");
  assert.equal(gifFps([7, 13, 10]), 10);
  assert.equal(gifFps([3, 50]), 3.77, "no whole fps fits: the average");
});

test("Wu's quantizer keeps colours that fit and finds the clusters of those that don't", () => {
  // Colours in different histogram cells come back exactly.
  const few = [
    [0, 0, 0],
    [255, 255, 255],
    [200, 16, 40],
    [16, 200, 40],
    [40, 16, 200]
  ];
  const q = new WuQuantizer();
  few.forEach((c, i) => q.add(...c, i + 1));
  assert.deepEqual(new Set(q.palette(8).map(String)), new Set(few.map(String)));

  // Three tight clusters into three colours: each cluster's mean.
  const rnd = random(3);
  const centres = [
    [40, 60, 200],
    [220, 200, 30],
    [120, 20, 60]
  ];
  const q3 = new WuQuantizer();
  const sums = centres.map(() => [0, 0, 0, 0]);
  for (let i = 0; i < 3000; i++) {
    const k = i % 3;
    const c = centres[k].map(v => v + Math.floor(rnd() * 9) - 4);
    q3.add(...c);
    c.forEach((v, j) => (sums[k][j] += v));
    sums[k][3]++;
  }
  const means = sums.map(s => s.slice(0, 3).map(v => Math.round(v / s[3])));
  assert.deepEqual(new Set(q3.palette(3).map(String)), new Set(means.map(String)));

  // More colours never fit worse.
  const pixels = Array.from({ length: 5000 }, () => [rnd() * 256, rnd() * 256, rnd() * 256].map(Math.floor));
  const error = n => {
    const w = new WuQuantizer();
    pixels.forEach(p => w.add(...p));
    const palette = w.palette(n);
    const map = new PaletteMap(palette);
    return pixels.reduce((s, p) => {
      const c = palette[map.index(...p)];
      return s + (c[0] - p[0]) ** 2 + (c[1] - p[1]) ** 2 + (c[2] - p[2]) ** 2;
    }, 0);
  };
  const errors = [4, 16, 64, 256].map(error);
  for (let i = 1; i < errors.length; i++) assert.ok(errors[i] < errors[i - 1], `error falls with more colours: ${errors}`);
});

test("Wu's quantizer is as good as ImageMagick's on a photo-like image", { skip: !MAGICK && "ImageMagick is not installed" }, () => {
  // Smooth gradients with noise: hundreds of thousands of colours.
  const w = 256;
  const h = 192;
  const rnd = random(11);
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const n = () => Math.floor(rnd() * 12);
      rgba.set([Math.min(255, x + n()), Math.min(255, ((y * 4) / 3) | 0) + 0 * n(), Math.min(255, Math.abs(128 - x) + y / 2 + n()) | 0, 255], (y * w + x) * 4);
    }
  }
  const dir = tmp();
  const file = path.join(dir, "photo.png");
  fs.writeFileSync(file, encodePng({ width: w, height: h, rgba }));
  const im = execFileSync("magick", [file, "-dither", "None", "-colors", "256", "-depth", "8", "RGB:-"]);
  const gif = makeGif([{ width: w, height: h, rgba }], { fps: 10, alphaThreshold: 128, loop: false });
  assert.equal(gif.exact, false);
  const ours = decodeGif(gif.bytes, Infinity).frames[0].rgba;
  let oursErr = 0;
  let imErr = 0;
  for (let p = 0; p < w * h; p++) {
    for (let c = 0; c < 3; c++) {
      oursErr += (ours[p * 4 + c] - rgba[p * 4 + c]) ** 2;
      imErr += (im[p * 3 + c] - rgba[p * 4 + c]) ** 2;
    }
  }
  assert.ok(oursErr <= imErr * 1.1, `mean squared error: ours ${(oursErr / w / h).toFixed(1)}, ImageMagick ${(imErr / w / h).toFixed(1)}`);
});

test("a GIF with few colours plays the frames exactly, in every decoder", () => {
  const frames = walker(6);
  const gif = makeGif(frames, { fps: 12, alphaThreshold: 128, loop: true });
  assert.equal(gif.exact, true);
  assert.equal(gif.transparent, true);
  assert.equal(gif.colours, 12);
  const want = expectedFrames(frames);
  const ours = decodeGif(gif.bytes, Infinity);
  assert.deepEqual(ours.frames.map(f => sha(f.rgba)), want.map(sha), "our decoder");
  assert.deepEqual(ours.delays, [8, 9, 8, 8, 9, 8]);
  assert.equal(ours.loops, 0, "loops forever");

  // Each frame stores only the box around its visible pixels, cleared after.
  const parsed = parseGif(gif.bytes);
  for (const [k, f] of parsed.frames.entries()) {
    assert.equal(f.disposal, 2);
    let [x0, y0, x1, y1] = [99, 99, -1, -1];
    for (let p = 0; p < 24 * 20; p++) {
      if (!want[k][p * 4 + 3]) continue;
      const [x, y] = [p % 24, Math.floor(p / 24)];
      [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
    }
    assert.deepEqual([f.x, f.y, f.width, f.height], [x0, y0, x1 - x0 + 1, y1 - y0 + 1], `frame ${k + 1}`);
  }
  assert.deepEqual([parsed.frames[0].width, parsed.frames[5].width], [7, 8], "the faint edge of frame 1 is gone, frame 6's kept");

  const dir = tmp();
  const file = path.join(dir, "walk.gif");
  fs.writeFileSync(file, gif.bytes);
  const size = 24 * 20 * 4;
  for (const [name, raw] of Object.entries(oracleDecodes(file))) {
    assert.equal(raw.length, size * 6, `${name}: 6 frames`);
    want.forEach((f, k) => assert.equal(sha(raw.subarray(k * size, (k + 1) * size)), sha(f), `${name}: frame ${k + 1}`));
  }
  if (MAGICK) {
    const info = execFileSync("magick", ["identify", "-format", "%T %[gif:dispose]\n", file]).toString();
    assert.match(info, /^8 /);
    assert.deepEqual(info.trim().split("\n").map(l => Number(l.split(" ")[0])), [8, 9, 8, 8, 9, 8], "ImageMagick reads the delays");
  }
  if (PILLOW) {
    const code = "import sys\nfrom PIL import Image\nim = Image.open(sys.argv[1])\nprint(im.info.get('loop'), im.n_frames)";
    assert.equal(execFileSync("python3", ["-I", "-c", code, file]).toString().trim(), "0 6", "Pillow: loops forever, 6 frames");
  }
});

test("an opaque GIF stores only what changed between frames", () => {
  const w = 16;
  const h = 12;
  const base = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) base.set([30, 40, 50, 255], i * 4);
  const frames = [0, 1, 2, 3].map(k => {
    const rgba = Uint8Array.from(base);
    for (let y = 4; y < 7; y++) for (let x = 3 + k * 2; x < 6 + k * 2; x++) rgba.set([250, 200, 10, 255], (y * w + x) * 4);
    return { width: w, height: h, rgba };
  });
  frames.push({ width: w, height: h, rgba: Uint8Array.from(frames[3].rgba) }); // a held frame
  const gif = makeGif(frames, { fps: 10, alphaThreshold: 128, loop: true });
  assert.equal(gif.transparent, false);
  const parsed = parseGif(gif.bytes);
  assert.deepEqual(
    parsed.frames.map(f => [f.disposal, f.x, f.y, f.width, f.height]),
    [
      [1, 0, 0, 16, 12],
      [1, 3, 4, 5, 3],
      [1, 5, 4, 5, 3],
      [1, 7, 4, 5, 3],
      [1, 0, 0, 1, 1]
    ]
  );
  const want = frames.map(f => Buffer.from(f.rgba));
  assert.deepEqual(decodeGif(gif.bytes, Infinity).frames.map(f => sha(f.rgba)), want.map(sha));
  const file = path.join(tmp(), "slide.gif");
  fs.writeFileSync(file, gif.bytes);
  const size = w * h * 4;
  for (const [name, raw] of Object.entries(oracleDecodes(file))) {
    // ffmpeg drops a frame identical to the one before; the others keep it.
    const n = raw.length / size;
    assert.ok(n === 5 || (name === "ffmpeg" && n === 4), `${name}: ${n} frames`);
    for (let k = 0; k < n; k++) assert.equal(sha(raw.subarray(k * size, (k + 1) * size)), sha(want[k]), `${name}: frame ${k + 1}`);
  }
});

test("alpha threshold and matte", () => {
  const px = (r, g, b, a) => ({ width: 1, height: 1, rgba: Uint8Array.from([r, g, b, a]) });
  const shown = (frame, opts) => [...decodeGif(makeGif([frame], { fps: 10, alphaThreshold: 128, loop: false, ...opts }).bytes, Infinity).frames[0].rgba];
  assert.deepEqual(shown(px(200, 0, 0, 127)), [0, 0, 0, 0], "127 is under the threshold");
  assert.deepEqual(shown(px(200, 0, 0, 128)), [200, 0, 0, 255], "128 is kept, as it is");
  assert.deepEqual(shown(px(200, 0, 0, 40), { alphaThreshold: 30 }), [200, 0, 0, 255]);
  assert.deepEqual(shown(px(200, 0, 0, 255), { alphaThreshold: 255 }), [200, 0, 0, 255]);
  assert.deepEqual(shown(px(200, 0, 0, 254), { alphaThreshold: 255 }), [0, 0, 0, 0]);
  // Blended over the matte: 200 * 0.6 + 0 * 0.4 = 120; 0 * 0.6 + 100 * 0.4 = 40.
  assert.deepEqual(shown(px(200, 0, 0, 153), { matte: [0, 100, 0] }), [120, 40, 0, 255]);
  assert.deepEqual(shown(px(200, 0, 0, 255), { matte: [0, 100, 0] }), [200, 0, 0, 255], "opaque pixels keep their colour");
  // Everything transparent still makes a valid GIF.
  const empty = makeGif([px(0, 0, 0, 0), px(9, 9, 9, 0)], { fps: 10, alphaThreshold: 128, loop: true });
  assert.equal(empty.colours, 0);
  assert.deepEqual(decodeGif(empty.bytes, Infinity).frames.map(f => [...f.rgba]), [
    [0, 0, 0, 0],
    [0, 0, 0, 0]
  ]);
});

test("one frame has no loop block; --once style output has none either", () => {
  const frames = walker(3);
  assert.equal(decodeGif(makeGif(frames.slice(0, 1), { fps: 10, alphaThreshold: 128, loop: true }).bytes, Infinity).loops, null);
  assert.equal(decodeGif(makeGif(frames, { fps: 10, alphaThreshold: 128, loop: false }).bytes, Infinity).loops, null);
  assert.equal(decodeGif(makeGif(frames, { fps: 10, alphaThreshold: 128, loop: true }).bytes, Infinity).loops, 0);
});

test("over 256 colours across frames: one shared palette within a bounded error", () => {
  // Every frame a different gradient: 4096 colours on a lattice 8 apart, so
  // 256 colours leave each about 16 lattice points to stand for.
  const w = 32;
  const h = 32;
  const frames = [0, 1, 2, 3].map(k => {
    const rgba = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rgba.set([x * 8, y * 8, k * 60 + ((x + y) & 7), 255], (y * w + x) * 4);
    return { width: w, height: h, rgba };
  });
  const gif = makeGif(frames, { fps: 10, alphaThreshold: 128, loop: true });
  assert.equal(gif.exact, false);
  assert.ok(gif.colours <= 256);
  const parsed = parseGif(gif.bytes);
  assert.ok(parsed.frames.every(f => !f.has_local_palette), "one palette for all frames");
  const decoded = decodeGif(gif.bytes, Infinity).frames;
  let sum = 0;
  let max = 0;
  decoded.forEach((f, k) => {
    for (let i = 0; i < f.rgba.length; i += 4) {
      const d = Math.hypot(f.rgba[i] - frames[k].rgba[i], f.rgba[i + 1] - frames[k].rgba[i + 1], f.rgba[i + 2] - frames[k].rgba[i + 2]);
      sum += d;
      max = Math.max(max, d);
    }
  });
  const mean = sum / (w * h * 4);
  assert.ok(mean < 14 && max < 32, `RGB error: mean ${mean.toFixed(2)}, worst ${max.toFixed(1)}`);
});

test("the encoder refuses what GIF cannot hold", () => {
  const frame = { x: 0, y: 0, width: 1, height: 1, indices: Uint8Array.of(0), delay: 10, disposal: 1 };
  assert.throws(() => encodeGif({ width: 1, height: 1, palette: [], loop: true, frames: [frame] }), /1-256 colours/);
  assert.throws(() => encodeGif({ width: 70000, height: 1, palette: [[0, 0, 0]], loop: true, frames: [frame] }), /1-65535/);
  assert.throws(() => encodeGif({ width: 1, height: 1, palette: [[0, 0, 0]], loop: true, frames: [{ ...frame, x: 1 }] }), /inside the image/);
});

test("the decoder matches ImageMagick and Pillow on the image-rs GIF corpus", () => {
  const expected = JSON.parse(fs.readFileSync(path.join(CORPUS, "expected.json"), "utf8"));
  assert.ok(Object.keys(expected).length >= 16);
  for (const [file, want] of Object.entries(expected)) {
    const buf = fs.readFileSync(path.join(CORPUS, file));
    if (want.refused) {
      assert.throws(() => decodeGif(buf, 64e6), GifError, `${file} is refused`);
      continue;
    }
    const gif = decodeGif(buf, 64e6);
    assert.deepEqual([gif.width, gif.height], [want.width, want.height], file);
    assert.deepEqual(gif.delays, want.delays, `${file} delays`);
    assert.deepEqual(gif.frames.map(f => sha(f.rgba)), want.frames, `${file} frames`);
  }
});

test("the decoder matches ImageMagick on its own GIFs: disposals, sub-frames, interlace, local palettes", { skip: !MAGICK && "ImageMagick is not installed" }, () => {
  const dir = tmp();
  const frames = walker(5, 20, 16, 40);
  // Opaque frames on a coloured ground, so ImageMagick's optimizer has
  // something to subtract.
  const opaque = frames.map(f => {
    const rgba = Uint8Array.from(f.rgba);
    for (let i = 0; i < rgba.length; i += 4) if (rgba[i + 3] < 255) rgba.set([20, 90, 60, 255], i);
    return { ...f, rgba };
  });
  const files = (set, name) =>
    set.map((f, k) => {
      const p = path.join(dir, `${name}-${k}.png`);
      fs.writeFileSync(p, encodePng(f));
      return p;
    });
  const t = files(frames, "t");
  const o = files(opaque, "o");
  const cases = {
    "dispose previous": ["-dispose", "Previous", "-delay", "7", ...t],
    "dispose background": ["-dispose", "Background", "-delay", "3", ...t],
    "dispose none": ["-dispose", "None", ...t],
    "mixed disposals": ["-dispose", "None", t[0], "-dispose", "Previous", t[1], "-dispose", "Background", t[2], "-dispose", "None", t[3], t[4]],
    "optimized layers": [...o, "-layers", "Optimize"],
    "optimized transparency": [...t, "-layers", "OptimizeTransparency"],
    interlaced: [...o, "-interlace", "GIF"],
    "local palettes": [...o, "+map"],
    "an offset sub-frame": [o[0], "(", o[1], "-crop", "8x6+5+4", ")", "-dispose", "None"]
  };
  for (const [name, args] of Object.entries(cases)) {
    const out = path.join(dir, `${name.replace(/\W+/g, "-")}.gif`);
    execFileSync("magick", [...args, "-loop", "0", out]);
    const im = execFileSync("magick", [out, "-coalesce", "-depth", "8", "RGBA:-"], { maxBuffer: 1 << 28 });
    const gif = decodeGif(fs.readFileSync(out), Infinity);
    const size = gif.width * gif.height * 4;
    assert.equal(gif.frames.length, im.length / size, `${name}: frame count`);
    gif.frames.forEach((f, k) => assert.equal(sha(f.rgba), sha(im.subarray(k * size, (k + 1) * size)), `${name}: frame ${k + 1}`));
  }
});

test("broken GIFs fail with GifError, never crash or hang", () => {
  const good = makeGif(walker(4, 24, 20, 30), { fps: 12, alphaThreshold: 128, loop: true }).bytes;
  const tolerated = buf => {
    try {
      decodeGif(buf, 1e6);
    } catch (err) {
      if (!(err instanceof GifError)) throw err;
    }
  };
  // Cut at every length.
  for (let n = 0; n < good.length; n++) tolerated(good.subarray(0, n));
  // Bytes flipped at random, deterministically.
  const rnd = random(42);
  for (let i = 0; i < 3000; i++) {
    const bad = Uint8Array.from(good);
    for (let k = 1 + Math.floor(rnd() * 4); k--; ) bad[Math.floor(rnd() * bad.length)] = Math.floor(rnd() * 256);
    tolerated(bad);
  }
  // Random LZW data after a valid header and image descriptor.
  const head = [...Buffer.from("GIF89a"), 8, 0, 8, 0, 0x80, 0, 0, 0, 0, 0, 255, 255, 255, 0x2c, 0, 0, 0, 0, 8, 0, 8, 0, 0];
  for (let i = 0; i < 500; i++) {
    const data = Array.from({ length: 1 + Math.floor(rnd() * 200) }, () => Math.floor(rnd() * 256));
    tolerated(Uint8Array.from([...head, 2, ...data]));
  }
  // A huge canvas is refused before anything is allocated for it.
  const huge = Uint8Array.from([...Buffer.from("GIF89a"), 255, 255, 255, 255, 0, 0, 0, 0x2c, 0, 0, 0, 0, 255, 255, 255, 255, 0, 2, 2, 0x4c, 1, 0, 0x3b]);
  assert.throws(() => decodeGif(huge, 64e6), err => err instanceof GifError && err.code === "TOO_LARGE");
  assert.throws(() => decodeGif(Buffer.from("GIF89a"), 64e6), GifError);
});

// ---- The command ----

function cli(args, cwd) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, LUDO_TELEMETRY: "0", LUDO_API_KEY: "", LUDO_API_URL: "http://127.0.0.1:9", LUDO_CONFIG_DIR: path.join(cwd, ".config"), LUDO_CACHE_DIR: path.join(cwd, ".cache") }
  });
  return { code: r.status, out: r.stdout, err: r.stderr, json: r.stdout.trim().startsWith("{") ? JSON.parse(r.stdout) : undefined };
}

function writeSheet(dir, name, frames, cols, fps = 12) {
  const folder = path.join(dir, `${name}-frames`);
  fs.mkdirSync(folder, { recursive: true });
  frames.forEach((f, k) => fs.writeFileSync(path.join(folder, `${name}-${k + 1}.png`), encodePng(f)));
  const r = cli(["toolbox", "sprite", "join", folder, "--cols", String(cols), "--fps", String(fps), "--name", name, "--out", ".", "--json"], dir);
  assert.equal(r.code, 0, r.err);
  return r.json.sheet;
}

test("toolbox sprite gif: a sheet becomes a GIF of its frames", () => {
  const dir = tmp();
  const frames = walker(6);
  const sheet = writeSheet(dir, "walk", frames, 3);
  const r = cli(["toolbox", "sprite", "gif", sheet, "--out", ".", "--json"], dir);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.gif, "walk.gif");
  assert.equal(r.json.grid_from, "stamp");
  assert.deepEqual([r.json.width, r.json.height, r.json.fps, r.json.colours, r.json.palette, r.json.transparent, r.json.loops], [24, 20, 12, 12, "exact", true, true]);
  assert.ok(r.json.hint.command.startsWith("ludo sprite animate"));
  const gif = decodeGif(fs.readFileSync(path.join(dir, "walk.gif")), Infinity);
  assert.deepEqual(gif.frames.map(f => sha(f.rgba)), expectedFrames(frames).map(sha));
  assert.deepEqual(gif.delays, [8, 9, 8, 8, 9, 8]);

  // Never overwrites; --scale, --fps, --once.
  const r2 = cli(["toolbox", "sprite", "gif", sheet, "--out", ".", "--scale", "3", "--fps", "60", "--once", "--json"], dir);
  assert.equal(r2.code, 0, r2.err);
  assert.equal(r2.json.gif, "walk-2.gif");
  assert.deepEqual([r2.json.width, r2.json.height, r2.json.fps, r2.json.fps_asked, r2.json.loops], [72, 60, 50, 60, false]);
  const big = decodeGif(fs.readFileSync(path.join(dir, "walk-2.gif")), Infinity);
  assert.equal(big.loops, null);
  assert.deepEqual(big.delays, [2, 2, 2, 2, 2, 2]);
  // Pixel (3x, 3y) of the scaled frame is pixel (x, y) of the original.
  const want = expectedFrames(frames)[2];
  for (const [x, y] of [
    [4, 5],
    [9, 9],
    [0, 0]
  ]) {
    const i = (y * 3 * 72 + x * 3) * 4;
    const j = (y * 24 + x) * 4;
    assert.deepEqual([...big.frames[2].rgba.subarray(i, i + 4)], [...want.subarray(j, j + 4)]);
  }

});

test("toolbox sprite gif: bad flags are usage errors", () => {
  const dir = tmp();
  const sheet = writeSheet(dir, "walk", walker(4), 2);
  for (const [args, message] of [
    [["--alpha-threshold", "0"], /--alpha-threshold must be a whole number from 1 to 255/],
    [["--alpha-threshold", "256"], /--alpha-threshold/],
    [["--matte", "blue"], /--matte takes a hex colour/],
    [["--matte"], /--matte needs a value/],
    [["--matte", "#00ff0080"], /opaque colour/],
    [["--scale", "17"], /--scale goes up to 16/],
    [["--fps", "0"], /--fps must be a number above 0/]
  ]) {
    const r = cli(["toolbox", "sprite", "gif", sheet, "--json", ...args], dir);
    assert.equal(r.code, 2, `${args.join(" ")}: ${r.err}`);
    assert.match(r.err + r.out, message);
  }
  assert.equal(cli(["toolbox", "sprite", "gif", "--json"], dir).code, 2);
});

test("toolbox sprite gif: an extruded sheet plays without its border", () => {
  const dir = tmp();
  const frames = walker(4);
  const sheet = writeSheet(dir, "walk", frames, 2);
  const ex = cli(["toolbox", "image", "extrude", sheet, "--by", "2", "--out", ".", "--json"], dir);
  assert.equal(ex.code, 0, ex.err);
  const r = cli(["toolbox", "sprite", "gif", ex.json.image, "--out", ".", "--name", "ex", "--json"], dir);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual([r.json.width, r.json.height], [24, 20]);
  const gif = decodeGif(fs.readFileSync(path.join(dir, "ex.gif")), Infinity);
  assert.deepEqual(gif.frames.map(f => sha(f.rgba)), expectedFrames(frames).map(sha));
});

test("a GIF reads as a sheet: slice, loop and the image tools take it", () => {
  const dir = tmp();
  const frames = expectedFrames(walker(5)).map(rgba => ({ width: 24, height: 20, rgba }));
  fs.writeFileSync(path.join(dir, "walk.gif"), makeGif(frames, { fps: 12, alphaThreshold: 128, loop: true }).bytes);

  const sliced = cli(["toolbox", "sprite", "slice", "walk.gif", "--out", ".", "--json"], dir);
  assert.equal(sliced.code, 0, sliced.err);
  assert.equal(sliced.json.grid_from, "gif");
  assert.deepEqual(sliced.json.grid, { cols: 3, rows: 2, frames: 5, frame_width: 24, frame_height: 20, fps: 12 });
  sliced.json.files.forEach((f, k) => assert.equal(sha(readPng(fs.readFileSync(path.join(dir, f))).image.rgba), sha(frames[k].rgba), `frame ${k + 1}`));

  const loop = cli(["toolbox", "sprite", "loop", "walk.gif", "--json"], dir);
  assert.equal(loop.code, 0, loop.err);
  assert.equal(loop.json.grid_from, "gif");

  const flipped = cli(["toolbox", "image", "flip", "walk.gif", "--out", ".", "--json"], dir);
  assert.equal(flipped.code, 0, flipped.err);
  assert.match(flipped.json.image, /\.png$/);
  const sheet = readPng(fs.readFileSync(path.join(dir, flipped.json.image))).image;
  assert.deepEqual([sheet.width, sheet.height], [72, 40], "the frames side by side, 3x2");

  // A GIF of one frame is a plain image.
  fs.writeFileSync(path.join(dir, "still.gif"), makeGif(frames.slice(0, 1), { fps: 10, alphaThreshold: 128, loop: false }).bytes);
  const trimmed = cli(["toolbox", "image", "trim", "still.gif", "--out", ".", "--json"], dir);
  assert.equal(trimmed.code, 0, trimmed.err);
  const still = readPng(fs.readFileSync(path.join(dir, trimmed.json.image))).image;
  assert.deepEqual([still.width, still.height], [7, 13], "frame 1 without its faint edge");

  // And back: a GIF from the GIF's own sheet is the same animation.
  const again = cli(["toolbox", "sprite", "gif", "walk.gif", "--name", "again", "--out", ".", "--json"], dir);
  assert.equal(again.code, 0, again.err);
  assert.deepEqual(decodeGif(fs.readFileSync(path.join(dir, "again.gif")), Infinity).frames.map(f => sha(f.rgba)), frames.map(f => sha(f.rgba)));
});

test("a broken GIF is bad input (exit 12), not a crash", () => {
  const dir = tmp();
  const good = makeGif(walker(3), { fps: 10, alphaThreshold: 128, loop: true }).bytes;
  fs.writeFileSync(path.join(dir, "bad.gif"), Buffer.concat([Buffer.from(good.subarray(0, 40)), Buffer.from([0x99, 1, 2, 3])]));
  const r = cli(["toolbox", "sprite", "slice", "bad.gif", "--json"], dir);
  assert.equal(r.code, 12, r.err);
  assert.match(r.err + r.out, /Cannot read bad\.gif/);
});

test("join and the GIF reader agree on layout", () => {
  // The reader lays frames out like `sprite join` does by default.
  const frames = walker(7).map(f => ({ ...f, rgba: expectedFrames([f])[0] }));
  const gif = decodeGif(makeGif(frames, { fps: 10, alphaThreshold: 128, loop: true }).bytes, Infinity);
  const { sheet } = joinFrames(gif.frames, 3);
  assert.equal(sha(sheet.rgba), sha(joinFrames(frames, 3).sheet.rgba));
});
