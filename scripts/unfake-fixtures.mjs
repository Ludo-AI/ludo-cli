// Writes test/corpus/unfake/expected.json: what unfake.js's own pipeline
// (browser-tool/lib/pixel.js processImage, its defaults, no quantization) on
// its own wasm core gives for each image of test/unfake-corpus.mjs, and the
// sha256 of what ours gives. Ours must agree on the grid, the size and every
// pixel except where a cell's two most common colours tie (Rust takes one in
// HashMap order); the script stops if anything else differs.
//
//   npm run build && node scripts/unfake-fixtures.mjs <unfake.js checkout>
//
// (git clone https://github.com/jenissimo/unfake.js; v1.4.0, 6636868.)
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { corpus } from "../test/unfake-corpus.mjs";
import { unfake } from "../dist/toolbox/unfake.js";

const dir = process.argv[2];
if (!dir) throw new Error("usage: node scripts/unfake-fixtures.mjs <unfake.js checkout>");
const W = path.resolve(dir, "browser-tool/vendor/unfake-core");
const core = await import(path.join(W, "unfake_wasm.js"));
core.initSync({ module: fs.readFileSync(path.join(W, "unfake_wasm_bg.wasm")) });

const unpack = v => {
  const dv = new DataView(v.buffer, v.byteOffset);
  const w = dv.getUint32(0, true);
  const h = dv.getUint32(4, true);
  return { width: w, height: h, rgba: v.slice(8, 8 + w * h * 4) };
};
const crop = (img, x, y, w, h) => {
  const out = new Uint8Array(w * h * 4);
  for (let r = 0; r < h; r++) out.set(img.rgba.subarray(((y + r) * img.width + x) * 4, ((y + r) * img.width + x + w) * 4), r * w * 4);
  return { width: w, height: h, rgba: out };
};

// pixel.js processImage, step by step, on the wasm core.
function theirs(src) {
  const rgba = src.rgba.slice();
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = rgba[i] >= 128 ? 255 : 0;
  let cur = { width: src.width, height: src.height, rgba };
  let scale = cur.width * cur.height > 8_000_000 ? core.detect_runs(rgba, cur.width, cur.height) : core.detect_tiled(rgba, cur.width, cur.height);
  const gv = core.detect_grid(rgba, cur.width, cur.height);
  const grid = gv.length >= 6 ? { px: gv[0], py: gv[1], ox: gv[2], oy: gv[3] } : null;
  if (grid) scale = (grid.px + grid.py) / 2;
  if (!grid && !Number.isInteger(scale)) scale = Math.max(1, Math.round(scale));
  let bounds = null;
  if (scale >= 8) {
    let base = grid;
    if (!base) {
      const off = core.crop_offset(rgba, cur.width, cur.height, scale);
      base = { px: scale, py: scale, ox: off[0], oy: off[1] };
    }
    const v = core.elastic_bounds_vec(rgba, cur.width, cur.height, base.px, base.py, base.ox, base.oy);
    if (v.length) bounds = { x: v.slice(3, 3 + v[2]), y: v.slice(3 + v[2]) };
  }
  if (scale <= 1) return { scale: 1, image: cur };
  if (!grid && !bounds) {
    const off = core.crop_offset(rgba, cur.width, cur.height, scale);
    const w = Math.floor((cur.width - off[0]) / scale) * scale;
    const h = Math.floor((cur.height - off[1]) / scale) * scale;
    if (w >= scale && h >= scale) cur = crop(cur, off[0], off[1], w, h);
  }
  const out = bounds
    ? unpack(core.downscale_bounds_packed(cur.rgba, cur.width, cur.height, bounds.x, bounds.y, 3, 0.15))
    : grid
      ? unpack(core.downscale_grid_packed(cur.rgba, cur.width, cur.height, grid.px, grid.py, grid.ox, grid.oy, 3, 0.15))
      : unpack(core.downscale_rgba_packed(cur.rgba, cur.width, cur.height, scale, 3, 0.15, 0));
  for (let i = 0; i < out.rgba.length; i += 4) {
    if (out.rgba[i + 3] < 128) out.rgba.fill(0, i, i + 4);
    else out.rgba[i + 3] = 255;
  }
  return { scale, image: out, elastic: !!bounds, fractional: !!grid };
}

const sha = b => crypto.createHash("sha256").update(b).digest("hex");
const expected = {};
for (const c of corpus()) {
  const a = theirs(c.img);
  const tied = new Map();
  const b = unfake(c.img, { exact: false, ties: tied });
  if (Math.abs(a.scale - b.scale) > 1e-9 || a.image.width !== b.image.width || a.image.height !== b.image.height) {
    throw new Error(`${c.name}: unfake.js ${a.scale} ${a.image.width}x${a.image.height}, ours ${b.scale} ${b.image.width}x${b.image.height}`);
  }
  let ties = 0;
  for (let i = 0; i < a.image.rgba.length; i += 4) {
    if (a.image.rgba.subarray(i, i + 4).every((v, k) => v === b.image.rgba[i + k])) continue;
    // Ours took another of the cell's equally most common colours.
    const top = tied.get(i / 4);
    const colour = (a.image.rgba[i] << 16) | (a.image.rgba[i + 1] << 8) | a.image.rgba[i + 2];
    if (!top || !top.includes(colour) || a.image.rgba[i + 3] !== b.image.rgba[i + 3]) throw new Error(`${c.name}: pixel ${i / 4} differs and is not a tie`);
    ties++;
  }
  const exactRun = unfake(c.img);
  expected[c.name] = {
    unfake: { scale: Math.round(a.scale * 1e6) / 1e6, width: a.image.width, height: a.image.height, fractional: !!a.fractional, elastic: !!a.elastic, sha256: sha(a.image.rgba), tie_pixels: ties },
    ours: { sha256: sha(b.image.rgba) },
    exact_first: { scale: Math.round(exactRun.scale * 1e6) / 1e6, width: exactRun.image.width, height: exactRun.image.height, exact: !!exactRun.exact, sha256: sha(exactRun.image.rgba) }
  };
  console.log(c.name.padEnd(26), `scale ${a.scale.toFixed(3)} ${a.image.width}x${a.image.height}`, ties ? `${ties} tie pixels` : "identical", exactRun.exact ? `| exact ${exactRun.scale}` : "");
}
fs.writeFileSync(new URL("../test/corpus/unfake/expected.json", import.meta.url), JSON.stringify({ unfake_js: "v1.4.0 (6636868)", cases: expected }, null, 1) + "\n");
