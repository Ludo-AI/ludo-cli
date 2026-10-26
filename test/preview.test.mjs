// The picture tools: `sprite contact`, `audio waveform` and `image contact`.
// Synthetic inputs whose answers are known (a square sliding along the
// ground, a click at a set time), so the overlays and markers can be checked
// where they land, pixel by pixel.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { encodePng, readPng, withText } from "../dist/tty/png.js";
import { encodeWav } from "../dist/toolbox/wav.js";
import { contactLayout, drawContact, fitScale, imageContactLayout, MAX_SIDE, timeColour } from "../dist/toolbox/preview.js";
import { canvas, fitText, text, textWidth } from "../dist/toolbox/draw.js";
import { GLYPHS } from "../dist/toolbox/font.js";
import { momentaryLoudness, truePeak, truePeakAt } from "../dist/toolbox/sound.js";
import { EXIT } from "../dist/errors.js";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ludo-preview-"));

function run(args, cwd = tmp()) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...process.env, LUDO_SPEC: path.join(cwd, "no-spec.json"), LUDO_API_KEY: "", LUDO_CONFIG_DIR: path.join(cwd, ".config"), LUDO_TELEMETRY: "0" }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", d => (stdout += d));
    child.stderr.on("data", d => (stderr += d));
    child.on("close", code => resolve({ code, stdout, stderr, cwd, json: () => JSON.parse(stdout) }));
  });
}

const BOUNDS = [0, 200, 255];
const GROUND = [255, 64, 96];
const PIVOT = [255, 214, 0];
const CENTRE = [255, 64, 255];
const INK = [232, 232, 240];
const PEAK = [255, 159, 26];

const px = (img, x, y) => Array.from(img.rgba.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 3));

// `count` frames of w x h, each a 10x10 opaque square on transparency,
// sliding right 6 px a frame (back to the start every 4), its bottom on row 30.
function slidingSquare(count = 4, w = 40, h = 40) {
  return Array.from({ length: count }, (_, k) => {
    const rgba = new Uint8Array(w * h * 4);
    const at = 5 + 6 * (k % 4);
    for (let y = 20; y < 30; y++) for (let x = at; x < at + 10; x++) rgba.set([200, 90, 30, 255], (y * w + x) * 4);
    return { width: w, height: h, rgba };
  });
}

// Frames side by side in a stamped sheet.
function writeSheet(dir, frames, cols, name = "slide.png") {
  const { width: w, height: h } = frames[0];
  const rows = Math.ceil(frames.length / cols);
  const sheet = { width: w * cols, height: h * rows, rgba: new Uint8Array(w * cols * h * rows * 4) };
  frames.forEach((f, i) => {
    for (let y = 0; y < h; y++) sheet.rgba.set(f.rgba.subarray(y * w * 4, (y + 1) * w * 4), ((Math.floor(i / cols) * h + y) * sheet.width + (i % cols) * w) * 4);
  });
  const file = path.join(dir, name);
  fs.writeFileSync(file, withText(encodePng(sheet), "ludo:grid", JSON.stringify({ cols, rows, frames: frames.length, fps: 12 })));
  return file;
}

test("the font draws its glyphs where it says, and text is measured and cut to fit", () => {
  const img = canvas(20, 10, [0, 0, 0, 255]);
  text(img, 1, 1, "1", [255, 255, 255, 255]);
  const rows = GLYPHS.get("1");
  for (let r = 0; r < 7; r++) for (let c = 0; c < 5; c++) assert.equal(px(img, 1 + c, 1 + r)[0] === 255, !!(rows[r] & (1 << (4 - c))), `row ${r} col ${c}`);
  assert.equal(textWidth("ab", 2), 22);
  assert.equal(fitText("a long file name.png", textWidth("a long...", 1)), "a long...");
  assert.equal(fitText("short", 100), "short");
});

test("the contact layout stays within its size, enlarges by whole factors and shrinks by any", () => {
  const small = contactLayout(16, 16, 8);
  assert.ok(Number.isInteger(small.scale) && small.scale > 1, `scale ${small.scale}`);
  const big = contactLayout(512, 512, 64);
  assert.ok(big.width <= MAX_SIDE && big.height <= MAX_SIDE, `${big.width}x${big.height}`);
  assert.ok(big.scale < 1);
  // 16 frames in a full 4x4 rather than a ragged row when it costs little.
  const sixteen = contactLayout(100, 100, 16);
  assert.equal(sixteen.cols * sixteen.rows - 16, 0);
  assert.deepEqual(timeColour(0), [64, 128, 255, 255]);
  assert.deepEqual(timeColour(1), [255, 70, 60, 255]);
});

test("contact: bounds, ground, pivot and centre of mass land on the frame where they are", () => {
  const frames = slidingSquare();
  const c = drawContact({ frames, shown: [0, 1, 2, 3], title: "slide", maxSide: MAX_SIDE });
  const l = c.layout;
  assert.equal(c.ground, 30);
  assert.deepEqual(c.pivot, { x: 19, y: 30 }); // under 5..33, the squares' span
  assert.deepEqual(c.facts.map(f => f.box), [0, 1, 2, 3].map(k => ({ x: 5 + 6 * k, y: 20, w: 10, h: 10 })));
  const s = l.scale;
  for (let k = 0; k < 4; k++) {
    const cx = l.gridX + (k % l.cols) * l.pitchX;
    const cy = l.gridY + Math.floor(k / l.cols) * l.pitchY;
    const box = c.facts[k].box;
    assert.deepEqual(px(c.image, cx + box.x * s, cy + (box.y + 5) * s), BOUNDS, `frame ${k + 1}: the bounds' left edge`);
    assert.deepEqual(px(c.image, cx + 1, cy + 30 * s - 1), GROUND, `frame ${k + 1}: the ground line`);
    assert.deepEqual(px(c.image, cx + 19 * s, cy + 30 * s - 3), PIVOT, `frame ${k + 1}: the pivot's upright`);
    assert.deepEqual(px(c.image, cx + (box.x + 5) * s, cy + 25 * s), CENTRE, `frame ${k + 1}: the centre of mass`);
    // Its number is in the strip above it.
    let ink = 0;
    for (let y = cy - 20; y < cy; y++) for (let x = cx; x < cx + 30; x++) if (px(c.image, x, y).join() === INK.join()) ink++;
    assert.ok(ink > 5, `frame ${k + 1}: a label`);
  }
  // The onion skin outlines the first frame's square in the first frame's colour.
  const ps = l.panelScale;
  assert.deepEqual(px(c.image, 12 + 5 * ps, l.panelY + 25 * ps), timeColour(0).slice(0, 3));
});

test("sprite contact: a stamped sheet in, a PNG and its layout out, with the hint to look at it", async () => {
  const dir = tmp();
  const sheet = writeSheet(dir, slidingSquare(6), 3);
  const r = await run(["toolbox", "sprite", "contact", sheet, "--json", "--out", "out"], dir);
  assert.equal(r.code, EXIT.OK, r.stderr);
  const out = r.json();
  const png = readPng(fs.readFileSync(path.join(dir, out.image))).image;
  assert.deepEqual([png.width, png.height], [out.width, out.height]);
  assert.equal(out.grid_from, "stamp");
  assert.deepEqual(out.shown, [1, 2, 3, 4, 5, 6]);
  assert.equal(out.ground_y, 30);
  assert.ok(out.layout.cols * out.layout.rows >= 6);
  assert.equal(out.hint.command, out.image);
  assert.match(out.legend.bounds, /alpha over 127/);

  const every = (await run(["toolbox", "sprite", "contact", sheet, "--every", "2", "--json", "--quiet", "--out", "out"], dir)).json();
  assert.deepEqual(every.shown, [1, 3, 5]);
  assert.equal(every.hint, undefined);
  const tooMany = await run(["toolbox", "sprite", "contact", sheet, "--every", "9"], dir);
  assert.equal(tooMany.code, EXIT.USAGE);
});

test("sprite contact caps a big sheet at the longest side asked for", async () => {
  const dir = tmp();
  const sheet = writeSheet(dir, slidingSquare(64, 300, 300), 8, "big.png");
  const r = await run(["toolbox", "sprite", "contact", sheet, "--json", "--out", "out"], dir);
  assert.equal(r.code, EXIT.OK, r.stderr);
  const out = r.json();
  assert.ok(out.width <= 2048 && out.height <= 2048, `${out.width}x${out.height}`);
  assert.ok(out.layout.scale < 1);
  const capped = (await run(["toolbox", "sprite", "contact", sheet, "--max-size", "400", "--json", "--out", "out"], dir)).json();
  assert.ok(capped.width <= 400 && capped.height <= 400, `${capped.width}x${capped.height}`);
  // At 400 px, 64 cells would be specks: every other frame or more is shown.
  assert.ok(capped.every > 1 && capped.shown.length < 64);
});

test("the true peak is found where it is, between the samples", () => {
  // A quarter-rate sine at 45 degrees: every sample is +-0.707, and the wave
  // reaches +-1 halfway between samples 0 and 1, then every 2 samples.
  const n = 4000;
  const ch = Float32Array.from({ length: n }, (_, i) => Math.sin((Math.PI / 2) * i + Math.PI / 4));
  const a = { rate: 48000, channels: [ch] };
  const { peak, at } = truePeakAt(a);
  assert.ok(Math.abs(peak - 1) < 0.02, `peak ${peak}`);
  assert.ok(Math.max(...ch) < 0.71);
  // |sin| peaks at 0.5, 2.5, 4.5...: on that grid, to the interpolator's quarter sample.
  const off = ((((at - 0.5) % 2) + 2) % 2);
  assert.ok(Math.min(off, 2 - off) < 0.01, `at ${at}`);
  assert.equal(truePeak(a), peak);
});

test("momentary loudness finds the loud second after the quiet one", () => {
  const rate = 48000;
  const ch = Float32Array.from({ length: 2 * rate }, (_, i) => Math.sin((2 * Math.PI * 1000 * i) / rate) * (i < rate ? 0.03 : 0.3));
  const m = momentaryLoudness({ rate, channels: [ch] });
  const loudest = m.lufs.indexOf(Math.max(...m.lufs));
  assert.ok(loudest * m.step >= rate, `starts at ${(loudest * m.step) / rate} s`);
  assert.ok(m.lufs[loudest] - m.lufs[0] > 19);
});

// 1.5 s: 0.5 s of silence, a 0.2 s tone at -12 dBFS with one click at 0.6 s,
// then 0.8 s of silence.
function clickWav(dir) {
  const rate = 44100;
  const ch = new Float32Array(rate * 1.5);
  for (let i = rate / 2; i < rate * 0.7; i++) ch[i] = 0.25 * Math.sin((2 * Math.PI * 440 * (i - rate / 2)) / rate);
  ch[Math.round(rate * 0.6)] = 0.9;
  const file = path.join(dir, "click.wav");
  fs.writeFileSync(file, encodeWav({ rate, channels: [ch] }));
  return file;
}

test("audio waveform: the silence, the peak and the scale land where the sound has them", async () => {
  const dir = tmp();
  const r = await run(["toolbox", "audio", "waveform", clickWav(dir), "--json", "--out", "out"], dir);
  assert.equal(r.code, EXIT.OK, r.stderr);
  const out = r.json();
  assert.equal(out.width, 1200);
  assert.equal(out.duration, 1.5);
  assert.equal(out.silence.start, 0.5);
  assert.equal(out.silence.end, 0.8);
  assert.equal(out.markers.peak.time, 0.6);
  assert.ok(Math.abs(out.markers.peak.db - 20 * Math.log10(0.9)) < 0.01);
  assert.ok(out.markers.loudest.start <= 0.6 && out.markers.loudest.end >= 0.6);
  assert.ok(Math.abs(out.ms_per_pixel - 1500 / out.plot.width) < 0.001);
  assert.equal(out.hint.command, out.image);
  assert.equal(out.spectrogram, undefined);

  const img = readPng(fs.readFileSync(path.join(dir, out.image))).image;
  assert.deepEqual([img.width, img.height], [out.width, out.height]);
  const xAt = t => out.plot.x + Math.floor((t / out.duration) * out.plot.width);
  const column = (x, test) => {
    let hits = 0;
    for (let y = out.plot.y; y < out.plot.y + out.plot.height; y++) if (test(px(img, x, y))) hits++;
    return hits;
  };
  const isPeak = c => c.join() === PEAK.join();
  assert.ok(column(xAt(0.6), isPeak) > 10, "the peak's line at 0.6 s");
  assert.equal(column(xAt(0.6) - 30, isPeak), 0, "and nowhere else");
  const blue = c => c[2] > c[0] + 60;
  assert.ok(column(xAt(0.65), blue) > 20, "the tone is drawn");
  assert.equal(column(xAt(0.25), blue), 0, "the silence is empty");

  const spec = (await run(["toolbox", "audio", "waveform", clickWav(dir), "--spectrogram", "--width", "600", "--json", "--out", "out"], dir)).json();
  assert.equal(spec.width, 600);
  assert.ok(spec.height > out.height);
  assert.equal(spec.spectrogram.max_hz, 22050);
  const bad = await run(["toolbox", "audio", "waveform", clickWav(dir), "--width", "100"], dir);
  assert.equal(bad.code, EXIT.USAGE);
});

test("image contact: each image fitted to its cell, whole factors up, its size under it", async () => {
  const dir = tmp();
  const solid = (w, h, c) => {
    const rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < rgba.length; i += 4) rgba.set(c, i);
    return { width: w, height: h, rgba };
  };
  fs.mkdirSync(path.join(dir, "set"));
  fs.writeFileSync(path.join(dir, "set", "icon-2.png"), encodePng(solid(16, 16, [255, 0, 0, 255])));
  fs.writeFileSync(path.join(dir, "set", "icon-10.png"), encodePng(solid(600, 300, [0, 0, 255, 255])));
  fs.writeFileSync(path.join(dir, "wide.png"), encodePng(solid(100, 50, [0, 255, 0, 128])));
  const r = await run(["toolbox", "image", "contact", "set", "wide.png", "--json", "--out", "out"], dir);
  assert.equal(r.code, EXIT.OK, r.stderr);
  const out = r.json();
  assert.deepEqual(out.images.map(i => path.basename(i.file)), ["icon-2.png", "icon-10.png", "wide.png"]);
  assert.deepEqual(out.images.map(i => [i.width, i.height]), [[16, 16], [600, 300], [100, 50]]);
  assert.equal(out.layout.cell, 256);
  assert.deepEqual(out.images.map(i => i.scale), [16, 0.427, 2]);
  const img = readPng(fs.readFileSync(path.join(dir, out.image))).image;
  // The 16 px icon fills its cell in red.
  const first = out.images[0].at;
  assert.deepEqual([first.width, first.height], [256, 256]);
  assert.deepEqual(px(img, first.x + 128, first.y + 128), [255, 0, 0]);
  // Its caption is under the cell.
  let ink = 0;
  for (let y = out.layout.first_cell.y + 256; y < out.layout.first_cell.y + 256 + 40; y++) for (let x = first.x; x < first.x + 100; x++) if (px(img, x, y)[0] > 140) ink++;
  assert.ok(ink > 20, "a caption");
  assert.equal(fitScale(16, 16, 256), 16);
  assert.equal(fitScale(17, 16, 256), 15);
  const many = imageContactLayout(400);
  assert.ok(many.width <= MAX_SIDE && many.height <= MAX_SIDE);
});
