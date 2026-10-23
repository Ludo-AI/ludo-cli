// Measures `toolbox sprite gif` on real spritesheets: every PNG under the
// given folders that carries a ludo:grid stamp. For each sheet:
//
//   decode     ImageMagick's decoder (-coalesce) must give back exactly the
//              frames ours does, and the frame count and delays asked;
//   alpha      a pixel is transparent in the GIF exactly when its alpha in
//              the sheet is below 128;
//   error      the mean and worst RGB distance of the opaque pixels from the
//              sheet's, against ImageMagick's and Pillow's own 256-colour
//              quantizers (no dithering) on the same pixels.
//
//   npm run build && node scripts/gif-eval.mjs ~/some/folder [...]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { encodePng, readPng } from "../dist/tty/png.js";
import { readGrid } from "../dist/tty/preview.js";
import { sliceSheet } from "../dist/toolbox/sheet.js";
import { makeGif } from "../dist/toolbox/gif.js";
import { decodeGif } from "../dist/tty/gif.js";

function* pngs(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    const stat = e.isSymbolicLink() ? fs.statSync(p, { throwIfNoEntry: false }) : e;
    if (!stat) continue;
    if (stat.isDirectory() && e.name !== "node_modules" && !e.name.startsWith(".")) yield* pngs(p);
    else if (stat.isFile() && /\.png$/i.test(e.name)) yield p;
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gif-eval-"));
const dist = (a, b, i, j) => Math.hypot(a[i] - b[j], a[i + 1] - b[j + 1], a[i + 2] - b[j + 2]);

// The opaque pixels of every frame in one opaque image, for the other
// quantizers to work on.
function keptImage(frames) {
  const kept = [];
  for (const f of frames) for (let i = 0; i < f.rgba.length; i += 4) if (f.rgba[i + 3] >= 128) kept.push(f.rgba[i], f.rgba[i + 1], f.rgba[i + 2]);
  const n = kept.length / 3;
  const width = Math.ceil(Math.sqrt(n));
  const height = Math.ceil(n / width);
  const rgba = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const q = Math.min(p, n - 1) * 3; // pad with the last pixel
    rgba.set([kept[q], kept[q + 1], kept[q + 2], 255], p * 4);
  }
  return { img: { width, height, rgba }, n };
}

function errorOf(orig, rgb, n, stride) {
  let sum = 0;
  let max = 0;
  for (let p = 0; p < n; p++) {
    const d = dist(orig, rgb, p * 4, p * stride);
    sum += d;
    if (d > max) max = d;
  }
  return { mean: sum / n, max };
}

const rows = [];
let failures = 0;
for (const dir of process.argv.slice(2)) {
  for (const file of pngs(dir)) {
    const buf = fs.readFileSync(file);
    const grid = readGrid(buf);
    if (!grid || grid.frames < 2) continue;
    let image;
    try {
      image = readPng(buf).image;
    } catch {
      continue;
    }
    const frames = sliceSheet(image, grid.cols, grid.rows, grid.frames);
    const t0 = performance.now();
    const gif = makeGif(frames, { fps: grid.fps, alphaThreshold: 128, loop: true });
    const ms = performance.now() - t0;
    const gifFile = path.join(tmp, "x.gif");
    fs.writeFileSync(gifFile, gif.bytes);
    const { width: w, height: h } = frames[0];
    const problems = [];

    // Our decoder and ImageMagick's.
    const ours = decodeGif(gif.bytes, Infinity);
    const im = execFileSync("magick", [gifFile, "-coalesce", "-depth", "8", "RGBA:-"], { maxBuffer: 1 << 30 });
    const delays = execFileSync("magick", ["identify", "-format", "%T,", gifFile]).toString().split(",").filter(Boolean).map(Number);
    if (ours.frames.length !== frames.length || im.length !== frames.length * w * h * 4) problems.push(`frames: ours ${ours.frames.length}, ImageMagick ${im.length / (w * h * 4)}`);
    if (delays.join() !== gif.delays.join()) problems.push(`delays ${delays.slice(0, 4)} != ${gif.delays.slice(0, 4)}`);
    let mismatch = 0;
    let alphaWrong = 0;
    const decoded = new Uint8Array(frames.length * w * h * 4);
    ours.frames.forEach((f, k) => decoded.set(f.rgba, k * w * h * 4));
    for (let i = 0; i < decoded.length && i < im.length; i += 4) {
      const a = decoded[i + 3];
      if (a !== im[i + 3] || (a && dist(decoded, im, i, i) !== 0)) mismatch++;
      const src = frames[Math.floor(i / (w * h * 4))].rgba[i % (w * h * 4) + 3];
      if ((src >= 128) !== (a === 255)) alphaWrong++;
    }
    if (mismatch) problems.push(`${mismatch} pixels differ from ImageMagick's decode`);
    if (alphaWrong) problems.push(`${alphaWrong} pixels with the wrong transparency`);

    // Our error against the sheet, on the opaque pixels.
    const origKept = [];
    const gifKept = [];
    for (let i = 0; i < decoded.length; i += 4) {
      const k = Math.floor(i / (w * h * 4));
      const o = i % (w * h * 4);
      if (frames[k].rgba[o + 3] < 128) continue;
      origKept.push(...frames[k].rgba.subarray(o, o + 3), 255);
      gifKept.push(decoded[i], decoded[i + 1], decoded[i + 2], 255);
    }
    const n = origKept.length / 4;
    const ourErr = errorOf(origKept, gifKept, n, 4);
    if (gif.exact && ourErr.max) problems.push("exact palette but colours changed");

    // ImageMagick's and Pillow's quantizers on the same opaque pixels.
    let imErr;
    let pilErr;
    if (!gif.exact) {
      const kept = keptImage(frames);
      const keptFile = path.join(tmp, "kept.png");
      fs.writeFileSync(keptFile, encodePng(kept.img));
      const colours = String(gif.colours);
      const imq = execFileSync("magick", [keptFile, "-dither", "None", "-colors", colours, "-depth", "8", "RGB:-"], { maxBuffer: 1 << 30 });
      imErr = errorOf(kept.img.rgba, imq, kept.n, 3);
      const py = `import sys; from PIL import Image; im = Image.open(sys.argv[1]).convert("RGB"); q = im.quantize(${colours}, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).convert("RGB"); sys.stdout.buffer.write(q.tobytes())`;
      const pq = execFileSync("python3", ["-I", "-c", py, keptFile], { maxBuffer: 1 << 30 });
      pilErr = errorOf(kept.img.rgba, pq, kept.n, 3);
    }
    if (problems.length) failures++;
    rows.push({ file, frames: frames.length, size: `${w}x${h}`, ms: Math.round(ms), kb: Math.round(gif.bytes.length / 1024), exact: gif.exact, transparent: gif.transparent, ours: ourErr, im: imErr, pil: pilErr, problems });
    const f2 = v => (v ? `${v.mean.toFixed(2)}/${v.max.toFixed(0)}` : "-");
    console.log(
      `${path.basename(file).slice(0, 40).padEnd(40)} ${String(frames.length).padStart(3)}f ${`${w}x${h}`.padStart(9)} ${String(Math.round(ms)).padStart(5)}ms ${String(rows.at(-1).kb).padStart(5)}KB ${gif.exact ? "exact    " : "quantized"} ours ${f2(ourErr).padEnd(9)} im ${f2(imErr).padEnd(9)} pil ${f2(pilErr).padEnd(9)} ${problems.join("; ")}`
    );
  }
}

const quantized = rows.filter(r => !r.exact);
const avg = pick => quantized.reduce((s, r) => s + pick(r), 0) / Math.max(1, quantized.length);
console.log(`\n${rows.length} sheets, ${failures} with problems; ${quantized.length} quantized`);
if (quantized.length) {
  console.log(`mean RGB error  ours ${avg(r => r.ours.mean).toFixed(2)}  ImageMagick ${avg(r => r.im.mean).toFixed(2)}  Pillow median cut ${avg(r => r.pil.mean).toFixed(2)}`);
  console.log(`worst RGB error ours ${avg(r => r.ours.max).toFixed(1)}  ImageMagick ${avg(r => r.im.max).toFixed(1)}  Pillow median cut ${avg(r => r.pil.max).toFixed(1)}`);
  console.log(`ours better than ImageMagick on ${quantized.filter(r => r.ours.mean <= r.im.mean).length}, than Pillow on ${quantized.filter(r => r.ours.mean <= r.pil.mean).length}`);
}
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
