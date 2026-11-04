// Writes test/corpus/normals: small synthetic sprites, the normal maps
// Sprite Fusion Sprite Normals makes of them (<name>_n.png), and
// expected.json, the sha256 of its RGBA for more cases (flags, real sprites
// from ../align, a GIF) without keeping their PNGs. `ludo toolbox image
// normals` must match every one to the byte (test/normals.test.mjs).
//
//   node scripts/normals-corpus-expected.mjs <spritefusion-sprite-normals>
//
// The binary is built from https://github.com/hugo-dz/spritefusion-sprite-normals
// at commit d14b067 with `cargo build --release --locked` (macOS arm64 here:
// its powf, expf and log1pf are the system's, see src/toolbox/normals.ts).
// Run `npm run build` first; run it after changing the corpus, and commit the
// result.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { encodePng, readPng, textChunk } from "../dist/tty/png.js";

const bin = process.argv[2];
if (!bin) throw new Error("Usage: node scripts/normals-corpus-expected.mjs <spritefusion-sprite-normals>");
const dir = new URL("../test/corpus/normals/", import.meta.url).pathname;
const corpus = new URL("../test/corpus/", import.meta.url).pathname;
fs.mkdirSync(dir, { recursive: true });

const image = (w, h, fn) => {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rgba.set(fn(x, y) ?? [0, 0, 0, 0], (y * w + x) * 4);
  return { width: w, height: h, rgba };
};
// A ball shaded lighter to the top left, as pixel art is painted.
const ball = (cx, cy, r, base) => (x, y) => {
  if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) return undefined;
  const k = 1.2 * (1 - 0.5 * ((x - cx + y - cy) / (2 * r) + 0.5));
  return [...base.map(c => Math.min(255, Math.round(c * k))), 255];
};

const sprites = {
  // Three shaded balls, a block and a one-pixel speck: separate islands.
  islands: image(32, 30, (x, y) => {
    for (const b of [ball(6, 6, 4, [200, 90, 60]), ball(20, 7, 5, [60, 150, 220]), ball(10, 20, 6, [100, 200, 90])]) {
      const v = b(x, y);
      if (v) return v;
    }
    if (x >= 24 && x <= 29 && y >= 20 && y <= 27) return [150, 100, 200, 255];
    if (x === 28 && y === 2) return [255, 255, 255, 255];
  }),
  // A disc whose edge fades out: soft alpha.
  soft: image(32, 32, (x, y) => {
    const d = Math.hypot(x - 15.5, y - 15.5);
    if (d <= 14) return [180 - Math.round(d * 4), 120, 80 + Math.round(d * 5), d < 8 ? 255 : Math.round(255 * (1 - (d - 8) / 6))];
  }),
  // Alpha 7 (at or below the 0.03 threshold), 8 (above) and 255.
  threshold: image(20, 10, (x, y) => (y >= 2 && y <= 7 && x >= 1 && x <= 18 ? [200, 100, 50, x < 7 ? 7 : x < 13 ? 8 : 255] : undefined)),
  // A lone pixel, a 1 px line, a diagonal stroke, and art touching the edge.
  strokes: image(24, 24, (x, y) => {
    if (x === 3 && y === 3) return [220, 40, 40, 255];
    if (y === 20 && x >= 2 && x < 22) return [90 + x * 5, 160, 80, 255];
    if (x === y && x >= 6 && x < 17) return [240, 220, 80, 255];
    if (x >= 21 && y < 12) return [60, 60, 200 - y * 8, 255];
  }),
  // A Ludo-stamped 3x2 sheet of 16x16 cells, the art filling each cell to
  // its border (the last one half), so cells must not bleed into each other.
  sheet: image(48, 32, (x, y) => {
    const i = Math.floor(y / 16) * 3 + Math.floor(x / 16);
    if (!(i === 5 && x % 16 > 7)) return [40 * i + 30, 255 - (x % 16) * 12, 100 + (y % 16) * 9, 255];
  }),
  // A 3x3 sheet stamped with 6 frames: its last row is empty, and its map
  // keeps that row.
  "sheet-rows": image(48, 48, (x, y) => {
    const i = Math.floor(y / 16) * 3 + Math.floor(x / 16);
    if (i < 6 && (x % 16) - 7.5 + ((y % 16) - 7.5) ** 2 / 8 < 5) return [60 + 30 * i, 140, 200 - (y % 16) * 6, 255];
  }),
  // A 2x2 sheet (given --grid 2x2) whose last cell holds only a 3 px speck,
  // which a frame count would drop.
  speck: image(32, 32, (x, y) => {
    if (x >= 16 && y >= 16) return x === 20 && y >= 20 && y <= 22 ? [250, 250, 250, 255] : undefined;
    const d = Math.hypot((x % 16) - 7.5, (y % 16) - 7.5);
    if (d < 6) return [200 - Math.round(d * 10), 80 + (x % 16) * 5, 90, 255];
  })
};
// The grid each sheet has, as the reference's --frame-size.
const frameSize = { sheet: "16x16", "sheet-rows": "16x16", speck: "16x16" };
const stamps = { sheet: { cols: 3, rows: 2, frames: 6, fps: 10 }, "sheet-rows": { cols: 3, rows: 3, frames: 6, fps: 10 } };

const rgbaSha = file => crypto.createHash("sha256").update(readPng(fs.readFileSync(file)).image.rgba).digest("hex");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-normals-corpus-"));
// Only the normal map is kept: with --frame-size or an animation it also
// writes the colour atlas and frames.json, which the toolbox does not.
const reference = (input, flags, out) => {
  execFileSync(bin, [input, "-o", out, "--force", ...flags], { stdio: ["ignore", "ignore", "pipe"] });
  for (const extra of [".color.png", ".frames.json"]) fs.rmSync(out.replace(/\.png$/, extra), { force: true });
};

for (const [name, img] of Object.entries(sprites)) {
  const chunks = stamps[name] ? [textChunk("ludo:grid", JSON.stringify(stamps[name]))] : [];
  fs.writeFileSync(path.join(dir, `${name}.png`), encodePng(img, { chunks }));
  reference(path.join(dir, `${name}.png`), frameSize[name] ? ["--frame-size", frameSize[name]] : [], path.join(dir, `${name}_n.png`));
}

// Each flag the toolbox takes, on its own; real sprites; a GIF (both read it
// as its frames side by side).
const cases = [
  ...[["--normal-strength", "4"], ["--normal-strength", "0"], ["--detail-strength", "0"], ["--detail-strength", "8"], ["--detail-scale", "2.5"], ["--shape-strength", "3"], ["--normal-format", "directx"]].map(flags => ({ input: "normals/islands.png", flags })),
  { input: "normals/soft.png", flags: ["--detail-scale", "1.7", "--shape-strength", "0.5", "--normal-format", "directx"] },
  { input: "align/real-hero-walk-hit-b.png", flags: [] },
  { input: "align/real-skel-rise-idle-a.png", flags: [] },
  { input: "align/real-skel-rise-idle-a.png", flags: ["--normal-strength", "2.75", "--detail-strength", "3"] },
  { input: "gif/anim-gr.gif", flags: [] }
];
const expected = {
  reference: "spritefusion-sprite-normals 0.1.0 (github.com/hugo-dz/spritefusion-sprite-normals d14b067), macOS arm64",
  cases: cases.map(c => {
    const out = path.join(tmp, "out_n.png");
    reference(path.join(corpus, c.input), c.flags, out);
    const { width, height } = readPng(fs.readFileSync(out)).image;
    return { ...c, width, height, sha256: rgbaSha(out) };
  })
};
fs.writeFileSync(path.join(dir, "expected.json"), `${JSON.stringify(expected, null, 1)}\n`);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`Wrote ${Object.keys(sprites).length} sprites with their normal maps and ${cases.length} cases to ${dir}`);
