// The aligner of `toolbox sprite sequence` (src/toolbox/align.ts) is the ML
// service's (ai-server ludo_utils/image_alignment.py), so the CLI places
// animations where the web does. Each piece is checked against the library
// the ML runs: Pillow's resizes (resample.ts's resizePillow), OpenCV's
// nearest resize, warpAffine, dilate and matchTemplate (cv.ts), and the
// whole aligner against the ML's own results on real frame pairs. The
// expected values come from scripts/align-fixtures.py (Pillow 13.0.0,
// opencv-python 5.0.0); see there to regenerate them.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { alignSprites, premultipliedGray } from "../dist/toolbox/align.js";
import { cleanMask, dilateEllipse, nccMatchAll, resizeNearestMask, roundEven, warpAffineNearest } from "../dist/toolbox/cv.js";
import { fft2d } from "../dist/toolbox/fft.js";
import { resizePillow } from "../dist/toolbox/resample.js";
import { readPng } from "../dist/tty/png.js";

const DIR = fileURLToPath(new URL("./corpus/align/", import.meta.url));
const expected = JSON.parse(fs.readFileSync(`${DIR}expected.json`, "utf8"));
const sha = a => crypto.createHash("sha256").update(a).digest("hex");

// scripts/align-fixtures.py's generator: x = x * 1664525 + 1013904223
// (mod 2^32), the top 8 bits of each.
function take(seed, n) {
  let x = seed >>> 0;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}
const sizes = (seed, n, lo, hi) => [...take(seed, n)].map(v => lo + (v % (hi - lo + 1)));
function sprite(seed, w, h) {
  const rgba = take(seed, w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (y < Math.floor(h / 3)) rgba[(y * w + x) * 4 + 3] = 0;
      else if (y >= Math.floor(h / 2) && x < Math.floor(w / 2)) rgba[(y * w + x) * 4 + 3] = 255;
    }
  }
  return { width: w, height: h, rgba };
}
function blobMask(seed, w, h, density) {
  const m = take(seed, w * h).map(v => (v < density ? 1 : 0));
  for (let y = Math.floor(h / 4); y < Math.floor(h / 2) + 1; y++) for (let x = Math.floor(w / 4); x < Math.floor(w / 2) + 1; x++) m[y * w + x] = 1;
  return m;
}

test("the generator matches the fixtures' sizes", () => {
  // A cheap guard that the JS and Python generators agree.
  expected.resize.forEach((c, i) => assert.deepEqual(sizes(1000 + i, 4, 2, 70), [c.w, c.h, c.tw, c.th]));
});

test("roundEven is cvRound's and Python's round: ties to even", () => {
  assert.deepEqual([0.5, 1.5, 2.5, -0.5, -1.5, 2.4999, 2.5001, 3].map(roundEven), [0, 2, 2, -0, -2, 2, 3, 3]);
});

test("resizePillow is Pillow's Image.resize on RGBA, to the byte", () => {
  for (const c of expected.resize) {
    const out = resizePillow(sprite(c.seed, c.w, c.h), c.tw, c.th, c.filter);
    assert.equal(sha(out.rgba), c.sha, `${c.filter} ${c.w}x${c.h} -> ${c.tw}x${c.th}`);
  }
});

test("cv2.resize INTER_NEAREST", () => {
  for (const c of expected.nearest) {
    assert.equal(sha(resizeNearestMask(blobMask(c.seed, c.w, c.h, 128), c.w, c.h, c.tw, c.th)), c.sha, `${c.w}x${c.h} -> ${c.tw}x${c.th}`);
  }
});

test("cv2.warpAffine INTER_NEAREST, both ways", () => {
  for (const c of expected.warp) {
    const out = warpAffineNearest(blobMask(c.seed, c.w, c.h, 100), c.w, c.h, c.m, c.tw, c.th, c.inverse);
    assert.equal(sha(out), c.sha, `${JSON.stringify(c.m)} ${c.inverse ? "inverse" : ""} ${c.w}x${c.h} -> ${c.tw}x${c.th}`);
  }
});

test("cv2.dilate by an ellipse, and the ML's speck cleaning", () => {
  for (const c of expected.dilate) assert.equal(sha(dilateEllipse(blobMask(c.seed, c.w, c.h, 8), c.w, c.h, c.r)), c.sha, `r ${c.r}`);
  for (const c of expected.clean) assert.equal(sha(cleanMask(blobMask(c.seed, c.w, c.h, 20), c.w, c.h, 0.005)), c.sha, `${c.w}x${c.h}`);
});

test("the FFT agrees with a direct DFT", () => {
  const [w, h] = [8, 4];
  const v = take(7, w * h * 2);
  const re = Float64Array.from(v.subarray(0, w * h), x => x / 255);
  const im = Float64Array.from(v.subarray(w * h), x => x / 255);
  const [r0, i0] = [re.slice(), im.slice()];
  fft2d(re, im, w, h);
  for (let ky = 0; ky < h; ky++) {
    for (let kx = 0; kx < w; kx++) {
      let [sr, si] = [0, 0];
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const a = -2 * Math.PI * ((kx * x) / w + (ky * y) / h);
          sr += r0[y * w + x] * Math.cos(a) - i0[y * w + x] * Math.sin(a);
          si += r0[y * w + x] * Math.sin(a) + i0[y * w + x] * Math.cos(a);
        }
      }
      assert.ok(Math.abs(re[ky * w + kx] - sr) < 1e-9 && Math.abs(im[ky * w + kx] - si) < 1e-9, `bin ${kx},${ky}`);
    }
  }
  // And back.
  fft2d(re, im, w, h, true);
  re.forEach((x, i) => assert.ok(Math.abs(x / (w * h) - r0[i]) < 1e-12));
});

test("matchTemplate TM_CCOEFF_NORMED: the ML's _ncc_match", () => {
  for (const c of expected.ncc) {
    const [w1, h1] = c.src;
    const src = sprite(c.seed, w1, h1);
    let tmpl;
    if (c.crop) {
      const [cw, ch] = c.tmpl;
      const [x, y] = [...take(6100 + c.seed, 2)];
      const [x0, y0] = [x % (w1 - cw + 1), y % (h1 - ch + 1)];
      const rgba = new Uint8Array(cw * ch * 4);
      for (let r = 0; r < ch; r++) rgba.set(src.rgba.subarray(((y0 + r) * w1 + x0) * 4, ((y0 + r) * w1 + x0 + cw) * 4), r * cw * 4);
      tmpl = { width: cw, height: ch, rgba };
    } else {
      tmpl = sprite(500 + c.seed, c.tmpl[0], c.tmpl[1]);
    }
    const [got] = nccMatchAll(premultipliedGray(src), w1, h1, [{ gray: premultipliedGray(tmpl), width: tmpl.width, height: tmpl.height }]);
    if (!c.result) {
      assert.equal(got, null);
      continue;
    }
    const [dx, dy, conf] = c.result;
    assert.deepEqual([got.dx, got.dy], [dx, dy], `case ${c.seed}`);
    assert.ok(Math.abs(got.confidence - conf) < 1e-5, `case ${c.seed}: ${got.confidence} vs ${conf}`);
  }
});

test("matching several templates at once gives what matching each alone does", () => {
  const src = sprite(11, 70, 60);
  const g = premultipliedGray(src);
  const ts = [[30, 20], [41, 33], [12, 50], [70, 60], [25, 25]].map(([w, h], i) => {
    const t = sprite(40 + i, w, h);
    return { gray: premultipliedGray(t), width: w, height: h };
  });
  const together = nccMatchAll(g, 70, 60, ts);
  ts.forEach((t, i) => assert.deepEqual(nccMatchAll(g, 70, 60, [t])[0], together[i], `template ${i}`));
});

test("the aligner gives what the ML service gives, on real frame pairs", () => {
  const load = f => readPng(fs.readFileSync(`${DIR}${f}`)).image;
  for (const c of expected.align) {
    const r = alignSprites(load(`${c.name}-a.png`), load(`${c.name}-b.png`));
    assert.deepEqual([r.dx, r.dy, r.scale], [c.dx, c.dy, c.scale], c.name);
    assert.ok(Math.abs(r.confidence - c.confidence) < 1e-4, `${c.name}: confidence ${r.confidence} vs ${c.confidence}`);
    const method = c.confidence > 0 ? "ncc" : c.dx === 0 && c.dy === 0 && c.scale === 1 ? "none" : "ground";
    assert.equal(r.method, method, c.name);
  }
});
