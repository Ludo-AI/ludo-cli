// Writes the WebP corpus files that do not come from libwebp-test-data
// (test/corpus/webp/made-*.webp): animations with every blend and dispose
// combination, sub-frames, lossy frames with alpha and mixed lossy/lossless
// frames, built by libwebp's own tools (img2webp, webpmux, cwebp, gif2webp)
// from synthetic frames and from two GIFs of test/corpus/gif. Run it after
// `npm run build`; then run scripts/webp-corpus-expected.mjs. The files are
// committed, so the tests need none of these tools. Written with libwebp 1.6.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { encodePng } from "../dist/tty/png.js";
import { encodeGif } from "../dist/tty/gif.js";

const out = new URL("../test/corpus/webp/", import.meta.url).pathname;
const gifs = new URL("../test/corpus/gif/", import.meta.url).pathname;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "webp-corpus-"));
const run = (cmd, args) => execFileSync(cmd, args, { stdio: ["ignore", "ignore", "inherit"] });

// A deterministic random source (mulberry32), as the tests use.
function random(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A sprite-like frame: a blob with soft (semi-transparent) edges moving over
// transparency, or over an opaque backdrop.
function frame(w, h, k, { backdrop = false, seed = 1 } = {}) {
  const rnd = random(seed + k);
  const rgba = new Uint8Array(w * h * 4);
  const cx = w * (0.3 + 0.08 * k);
  const cy = h * (0.5 + 0.05 * Math.sin(k));
  const r = Math.min(w, h) * 0.28;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (backdrop) rgba.set([40 + ((x * 3) % 60), 90 + ((y * 5) % 50), 160, 255], i);
      const d = Math.hypot(x - cx, y - cy);
      if (d < r + 2) {
        const a = d < r ? 255 : Math.round(255 * (r + 2 - d) * 0.5);
        const c = [200 + Math.floor(rnd() * 40), 60 + ((x + k * 7) % 90), 30 + ((y * 9) % 120)];
        if (backdrop) {
          for (let j = 0; j < 3; j++) rgba[i + j] = Math.round((c[j] * a + rgba[i + j] * (255 - a)) / 255);
        } else rgba.set([...c, a], i);
      }
    }
  }
  return { width: w, height: h, rgba };
}

// A rectangle of one colour and alpha, with a few stripes so it compresses
// to more than one symbol.
function patch(w, h, rgba4, stripe) {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rgba.set((x + y) % 5 === 0 ? stripe : rgba4, (y * w + x) * 4);
  return { width: w, height: h, rgba };
}

const png = (name, img) => {
  const file = path.join(tmp, `${name}.png`);
  fs.writeFileSync(file, encodePng(img));
  return file;
};

// img2webp: libwebp's animation encoder picks sub-rectangles, blending and
// disposal itself.
const sprite = Array.from({ length: 6 }, (_, k) => png(`s${k}`, frame(64, 48, k)));
run("img2webp", ["-loop", "0", "-lossless", ...sprite.flatMap(f => ["-d", "83", f]), "-o", path.join(out, "made-anim-lossless.webp")]);
run("img2webp", ["-loop", "2", "-lossy", "-q", "60", ...sprite.flatMap((f, k) => ["-d", String(k % 2 ? 40 : 120), f]), "-o", path.join(out, "made-anim-lossy-alpha.webp")]);
const scene = Array.from({ length: 5 }, (_, k) => png(`b${k}`, frame(57, 43, k, { backdrop: true, seed: 9 })));
run("img2webp", ["-loop", "1", "-mixed", "-kmax", "3", ...scene.flatMap(f => ["-d", "100", f]), "-o", path.join(out, "made-anim-mixed.webp")]);

// webpmux: frames placed by hand, for each blend and dispose case.
const piece = (name, img, lossy) => {
  const file = path.join(tmp, `${name}.webp`);
  run("cwebp", ["-quiet", ...(lossy ? ["-q", "70", "-alpha_q", "100"] : ["-lossless", "-exact"]), png(name, img), "-o", file]);
  return file;
};
const full = (() => {
  const img = { width: 40, height: 32, rgba: new Uint8Array(40 * 32 * 4) };
  for (let y = 0; y < 32; y++) for (let x = 0; x < 40; x++) img.rgba.set([x * 6, y * 8, 120, 60 + x * 4], (y * 40 + x) * 4);
  return img;
})();
run("webpmux", [
  ...["-frame", piece("m1", full), "+100+0+0+0+b"],
  // Disposed to the background afterwards; blended over the first frame.
  ...["-frame", piece("m2", patch(16, 12, [250, 20, 20, 140], [20, 250, 20, 255])), "+70+4+6+1+b"],
  // Overlaps the cleared rectangle: blended only outside it.
  ...["-frame", piece("m3", patch(20, 10, [20, 20, 250, 100], [250, 250, 20, 30])), "+50+10+8+0+b"],
  // Lossy with alpha, not blended, then disposed.
  ...["-frame", piece("m4", patch(12, 12, [200, 120, 40, 90], [10, 10, 10, 0]), true), "+60+0+0+1-b"],
  // A full opaque lossy frame: a key frame.
  ...["-frame", piece("m5", frame(40, 32, 2, { backdrop: true }), true), "+40+0+0+0+b"],
  // Small, translucent, after the key frame.
  ...["-frame", piece("m6", patch(10, 10, [255, 255, 255, 128], [0, 0, 0, 255])), "+0+30+22+0+b"],
  ...["-loop", "3", "-bgcolor", "255,0,0,255", "-o", path.join(out, "made-anim-mux.webp")]
]);
run("webpmux", [
  // Every frame disposed, and blended over transparency the previous one
  // left: key frames after a full-canvas disposal.
  ...["-frame", piece("n1", full), "+30+0+0+1+b"],
  ...["-frame", piece("n2", patch(40, 32, [90, 200, 90, 200], [255, 255, 255, 10])), "+30+0+0+1+b"],
  ...["-frame", piece("n3", patch(18, 14, [10, 10, 200, 255], [200, 10, 10, 77])), "+30+2+2+1+b"],
  ...["-frame", piece("n4", patch(24, 20, [128, 128, 0, 50], [0, 128, 128, 250])), "+30+12+10+0+b"],
  ...["-loop", "0", "-o", path.join(out, "made-anim-dispose.webp")]
]);

// gif2webp: GIF sub-frames, transparency and all three disposals,
// translated by libwebp; and a GIF of the image-gif corpus.
const indices = (w, h, f) => Uint8Array.from({ length: w * h }, (_, i) => f(i % w, Math.floor(i / w)));
const gif = encodeGif({
  width: 32,
  height: 24,
  palette: [
    [0, 0, 0],
    [255, 40, 40],
    [40, 200, 60],
    [30, 60, 230],
    [250, 220, 30]
  ],
  transparentIndex: 0,
  loop: true,
  frames: [
    { x: 0, y: 0, width: 32, height: 24, indices: indices(32, 24, (x, y) => ((x >> 2) + (y >> 2)) % 3), delay: 10, disposal: 1 },
    { x: 4, y: 4, width: 12, height: 10, indices: indices(12, 10, (x, y) => (x + y) % 4 ? 3 : 0), delay: 8, disposal: 2 },
    { x: 10, y: 6, width: 16, height: 12, indices: indices(16, 12, x => (x % 3 ? 4 : 0)), delay: 8, disposal: 3 },
    { x: 2, y: 12, width: 28, height: 10, indices: indices(28, 10, (x, y) => (y % 2 ? 1 : 2)), delay: 12, disposal: 1 },
    { x: 0, y: 0, width: 8, height: 8, indices: indices(8, 8, () => 4), delay: 0, disposal: 2 }
  ]
});
const gifFile = path.join(tmp, "dispose.gif");
fs.writeFileSync(gifFile, gif);
run("gif2webp", ["-quiet", gifFile, "-o", path.join(out, "made-gif-dispose.webp")]);
run("gif2webp", ["-quiet", "-lossy", "-q", "50", gifFile, "-o", path.join(out, "made-gif-dispose-lossy.webp")]);
run("gif2webp", ["-quiet", "-mixed", path.join(gifs, "anim-gr.gif"), "-o", path.join(out, "made-gif-anim-gr.webp")]);

// Stills shaped like Ludo's spritesheets: a 2x2 sheet, lossless and lossy
// with alpha.
const sheet = { width: 128, height: 96, rgba: new Uint8Array(128 * 96 * 4) };
for (let k = 0; k < 4; k++) {
  const f = frame(64, 48, k, { seed: 5 });
  for (let y = 0; y < 48; y++) sheet.rgba.set(f.rgba.subarray(y * 256, (y + 1) * 256), ((Math.floor(k / 2) * 48 + y) * 128 + (k % 2) * 64) * 4);
}
const sheetPng = png("sheet", sheet);
run("cwebp", ["-quiet", "-lossless", "-z", "9", sheetPng, "-o", path.join(out, "made-sheet-lossless.webp")]);
run("cwebp", ["-quiet", "-q", "80", sheetPng, "-o", path.join(out, "made-sheet-lossy-alpha.webp")]);

fs.rmSync(tmp, { recursive: true, force: true });
console.log("wrote", fs.readdirSync(out).filter(f => f.startsWith("made-")).join(", "));
