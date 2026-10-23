// Measures loop analysis on real spritesheets: every PNG under the given
// folders that carries a ludo:grid stamp. Real sheets come with no answer, so
// the sheets that already loop are damaged in known ways and must be
// diagnosed and repaired:
//
//   first     the first frame appended again      -> repeat 1, a loop of n frames
//   three     the first three appended again      -> repeat 3, a loop of n frames
//   far       the frame least like the first added -> a jump, a loop without it
//   reversed  played backwards                    -> still loops
//
// A loop of n frames may start anywhere: any n in a row of a cycle loop. A
// different answer is wrong; a sheet called smooth when it was damaged is
// missed. The verdicts on the untouched sheets are printed for reference.
//
//   npm run build && node scripts/loop-eval.mjs ~/some/folder [...]
import fs from "node:fs";
import path from "node:path";
import { readPng } from "../dist/tty/png.js";
import { readGrid } from "../dist/tty/preview.js";
import { sliceSheet } from "../dist/toolbox/sheet.js";
import { backgroundOf } from "../dist/toolbox/grid.js";
import { analyseLoop, frameDifferences } from "../dist/toolbox/loop.js";

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
  first: f => [[...f, f[0]], { verdict: "repeat", repeats: 1 }],
  three: f => [[...f, f[0], f[1], f[2]], { verdict: "repeat", repeats: 3 }],
  far: (f, D) => [[...f, f[D[0].indexOf(Math.max(...D[0]))]], { verdict: "jump" }],
  reversed: f => [[...f].reverse(), { verdict: "smooth" }]
};

const sheets = [];
const verdicts = {};
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
    verdicts[r.seam.verdict] = (verdicts[r.seam.verdict] || 0) + 1;
    if (r.seam.verdict === "smooth" && r.best.frames === frames.length) sheets.push({ file, frames, bg, D: r.matrix });
  }
}
const total = Object.values(verdicts).reduce((a, b) => a + b, 0);
if (!total) {
  console.error("No stamped spritesheets found. Usage: node scripts/loop-eval.mjs <folder>...");
  process.exit(2);
}
console.log("as found ", JSON.stringify(verdicts), `${Math.round(ms / total)} ms a sheet`);

let wrongTotal = 0;
for (const [name, make] of Object.entries(variants)) {
  const tally = { sheets: 0, right: 0, missed: 0, wrong: 0 };
  const wrong = [];
  for (const s of sheets) {
    const [frames, want] = make(s.frames, s.D);
    const n = s.frames.length;
    const r = analyse(frames, s.bg);
    tally.sheets++;
    const best = r.best ? `${r.best.start}-${r.best.end}` : "none";
    if (want.verdict === "smooth") {
      if (r.seam.verdict === "smooth" && r.best.frames === n) tally.right++;
      else (tally.wrong++, wrong.push(`  ${s.file}: ${r.seam.verdict} ${r.seam.ratio}, best ${best}`));
      continue;
    }
    if (r.seam.verdict === "smooth" && r.best.frames === frames.length) {
      tally.missed++;
      continue;
    }
    const verdictOk = r.seam.verdict === want.verdict && (want.repeats === undefined || r.seam.repeats === want.repeats);
    const bestOk = r.best && (want.verdict === "repeat" ? r.best.frames === n : r.best.end <= n);
    if (verdictOk && bestOk) tally.right++;
    else (tally.wrong++, wrong.push(`  ${s.file}: ${r.seam.verdict}${r.seam.repeats ? ` x${r.seam.repeats}` : ""} ${r.seam.ratio}, best ${best} (${n} frames)`));
  }
  wrongTotal += tally.wrong;
  console.log(name.padEnd(9), JSON.stringify(tally));
  if (wrong.length) console.log(wrong.join("\n"));
}
process.exit(wrongTotal ? 1 : 0);
