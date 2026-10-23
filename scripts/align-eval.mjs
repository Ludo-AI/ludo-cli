// Measures the aligner of `toolbox sprite sequence` (src/toolbox/align.ts) on
// real spritesheets: every PNG under the given folders that carries a
// ludo:grid stamp. For each sheet, a frame from its middle is moved (and
// for some cases resized) inside a frame of its own size, with the content
// kept in view, and the aligner must find that move:
//
//   shift      moved by up to 20% of the frame, same size
//   smaller    shrunk to 0.8 and moved
//   bigger     enlarged to 1.2 and moved
//
// A case is right when dx and dy are within 1 px of the answer and the scale
// within 2%. It also reports the last frame against the first (a looping
// sheet should give about 0, 0, 1) and the time per alignment.
//
//   npm run build && node scripts/align-eval.mjs ~/some/folder [...]
import fs from "node:fs";
import path from "node:path";
import { readPng } from "../dist/tty/png.js";
import { readGrid } from "../dist/tty/preview.js";
import { blit, sliceSheet } from "../dist/toolbox/sheet.js";
import { resizeSmooth } from "../dist/toolbox/resample.js";
import { alignSprites } from "../dist/toolbox/align.js";

function* pngs(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    const stat = e.isSymbolicLink() ? fs.statSync(p, { throwIfNoEntry: false }) : e;
    if (!stat) continue;
    if (stat.isDirectory() && e.name !== "node_modules" && !e.name.startsWith(".")) yield* pngs(p);
    else if (stat.isFile() && /\.png$/i.test(e.name)) yield p;
  }
}

function contentBox(img) {
  let [x0, y0, x1, y1] = [img.width, img.height, -1, -1];
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.rgba[(y * img.width + x) * 4 + 3] <= 10) continue;
      [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

let seed = 7;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = (lo, hi) => (hi < lo ? Math.round((lo + hi) / 2) : Math.round(lo + rnd() * (hi - lo)));

// `a`'s content resized by f and moved, in a frame of a's size; and the
// alignment that undoes it: B at scale 1/f, its top-left at (dx, dy).
function moved(a, box, f) {
  const img = f === 1 ? a : resizeSmooth(a, Math.round(a.width * f), Math.round(a.height * f));
  const [bx, by, bw, bh] = [box.x * f, box.y * f, box.w * f, box.h * f];
  const reach = 0.2 * Math.max(a.width, a.height);
  // Where img's origin may go so its content stays in the frame.
  const px = pick(Math.max(-bx, -reach), Math.min(a.width - bx - bw, reach));
  const py = pick(Math.max(-by, -reach), Math.min(a.height - by - bh, reach));
  const b = { width: a.width, height: a.height, rgba: new Uint8Array(a.rgba.length) };
  blit(b, img, px, py);
  const clipped = bw > a.width || bh > a.height;
  return { b, clipped, want: { dx: -px / f, dy: -py / f, scale: 1 / f } };
}

const cases = { shift: 1, smaller: 0.8, bigger: 1.2 };
const tally = Object.fromEntries(Object.keys(cases).map(k => [k, { n: 0, right: 0, within3: 0, ground: 0, worst: 0, clipped: 0, scaleOff: 0 }]));
const loops = [];
const times = [];
let sheets = 0;
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
    const a = frames[Math.floor(frames.length / 2)];
    const box = contentBox(a);
    if (!box || box.w < 8 || box.h < 8) continue;
    sheets++;
    for (const [name, f] of Object.entries(cases)) {
      const { b, want, clipped } = moved(a, box, f);
      const t0 = performance.now();
      const r = alignSprites(a, b);
      times.push(performance.now() - t0);
      const err = Math.max(Math.abs(r.dx - want.dx), Math.abs(r.dy - want.dy));
      const t = tally[name];
      t.n++;
      if (err <= 1.5 && Math.abs(r.scale / want.scale - 1) <= 0.02) t.right++;
      if (err <= 3 && Math.abs(r.scale / want.scale - 1) <= 0.03) t.within3++;
      if (r.method === "ground") t.ground++;
      const right = err <= 1.5 && Math.abs(r.scale / want.scale - 1) <= 0.02;
      if (!right && clipped) t.clipped++;
      if (!right && !clipped && Math.abs(r.scale / want.scale - 1) > 0.02) t.scaleOff++;
      if (err > t.worst) [t.worst, t.worstFile] = [err, path.relative(process.cwd(), file)];
    }
    const r = alignSprites(frames[frames.length - 1], frames[0]);
    loops.push(r);
  }
}

console.log(`${sheets} sheets`);
for (const [name, t] of Object.entries(tally)) {
  console.log(`  ${name.padEnd(8)} right ${t.right}/${t.n}, within 3 px ${t.within3}/${t.n}, ground fallback ${t.ground}; of the misses, content cut off ${t.clipped}, scale off by over 2% ${t.scaleOff}; worst ${t.worst.toFixed(1)} px${t.worstFile ? ` (${t.worstFile})` : ""}`);
}
const near = loops.filter(r => Math.abs(r.dx) <= 2 && Math.abs(r.dy) <= 2 && Math.abs(r.scale - 1) <= 0.02).length;
console.log(`  last -> first: ${near}/${loops.length} within 2 px and 2% of no move; ${loops.filter(r => r.method === "ground").length} ground fallbacks`);
times.sort((x, y) => x - y);
console.log(`  time per alignment: median ${times[times.length >> 1].toFixed(0)} ms, max ${times[times.length - 1].toFixed(0)} ms`);
