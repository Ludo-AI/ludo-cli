// Measures the loop quality on real spritesheets: every PNG under the given
// folders that carries a ludo:grid stamp. Real sheets come with no answer, so
// the sheets that loop cleanly as found are damaged in known ways, and each
// damage must take the quality under VISIBLE:
//
//   first     the first frame appended again       -> repeat 1
//   three     the first three appended again       -> repeat 3
//   far       the frame least like the first added -> a jump
//   reversed  played backwards                     -> still clean
//
// A damaged sheet that still scores VISIBLE or more is missed; a reversed
// one under CLEAN is wrong. The scores as found are printed for reference.
//
//   npm run build && node scripts/loop-eval.mjs ~/some/folder [...]
import fs from "node:fs";
import path from "node:path";
import { readPng } from "../dist/tty/png.js";
import { readGrid } from "../dist/tty/preview.js";
import { sliceSheet } from "../dist/toolbox/sheet.js";
import { backgroundOf } from "../dist/toolbox/grid.js";
import { analyseLoop, CLEAN, frameDifferences, VISIBLE } from "../dist/toolbox/loop.js";

function* pngs(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    const stat = e.isSymbolicLink() ? fs.statSync(p, { throwIfNoEntry: false }) : e;
    if (!stat) continue;
    if (stat.isDirectory() && e.name !== "node_modules" && !e.name.startsWith(".")) yield* pngs(p);
    else if (stat.isFile() && /\.png$/i.test(e.name)) yield p;
  }
}

const analyse = (frames, bg) => analyseLoop(frameDifferences(frames, bg));

const variants = {
  first: f => [[...f, f[0]], false],
  three: f => [[...f, f[0], f[1], f[2]], false],
  far: (f, D) => [[...f, f[D[0].indexOf(Math.max(...D[0]))]], false],
  reversed: f => [[...f].reverse(), true]
};

const sheets = [];
const bands = { clean: 0, hitch: 0, visible: 0, static: 0 };
let ms = 0;
for (const dir of process.argv.slice(2)) {
  for (const file of pngs(dir)) {
    let buf;
    try {
      buf = fs.readFileSync(file);
    } catch {
      continue;
    }
    const grid = readGrid(buf);
    if (!grid || grid.frames < 6) continue;
    let image;
    try {
      image = readPng(buf).image;
    } catch {
      continue;
    }
    const frames = sliceSheet(image, grid.cols, grid.rows, grid.frames);
    const bg = backgroundOf(image);
    const t0 = Date.now();
    const r = analyse(frames, bg);
    ms += Date.now() - t0;
    bands[r.quality === null ? "static" : r.quality >= CLEAN ? "clean" : r.quality >= VISIBLE ? "hitch" : "visible"]++;
    if (r.quality !== null && r.quality >= CLEAN) sheets.push({ file, frames, bg, D: r.matrix });
  }
}
const total = Object.values(bands).reduce((a, b) => a + b, 0);
if (!total) {
  console.error("No stamped spritesheets found. Usage: node scripts/loop-eval.mjs <folder>...");
  process.exit(2);
}
console.log("as found ", JSON.stringify(bands), `${Math.round(ms / total)} ms a sheet`);

let wrongTotal = 0;
for (const [name, make] of Object.entries(variants)) {
  const tally = { sheets: 0, right: 0, missed: 0 };
  const wrong = [];
  for (const s of sheets) {
    const [frames, stillClean] = make(s.frames, s.D);
    const r = analyse(frames, s.bg);
    tally.sheets++;
    const ok = stillClean ? r.quality >= CLEAN : r.quality < VISIBLE;
    if (ok) tally.right++;
    else (tally.missed++, wrong.push(`  ${s.file}: quality ${r.quality}, seam ${r.seam.ratio}`));
  }
  wrongTotal += tally.missed;
  console.log(name.padEnd(9), JSON.stringify(tally));
  if (wrong.length) console.log(wrong.slice(0, 8).join("\n"));
}
process.exit(wrongTotal ? 1 : 0);
