// Measures grid detection on real spritesheets whose answer is known: every
// PNG under the given folders that carries a ludo:grid stamp (the CLI stamps
// the sheets it downloads). For each sheet it also tries a flattened copy on
// an opaque background, a copy with its last cells blanked, and its first row
// alone. A wrong answer given with confidence is the number that must stay
// at zero; refusals only cost a --grid flag.
//
//   npm run build && node scripts/grid-eval.mjs ~/some/folder [...]
import fs from "node:fs";
import path from "node:path";
import { readPng, readText } from "../dist/tty/png.js";
import { CONFIDENT, countFrames, guessGrid } from "../dist/toolbox/grid.js";
import { frameRects } from "../dist/toolbox/sheet.js";

function* pngs(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    const stat = e.isSymbolicLink() ? fs.statSync(p, { throwIfNoEntry: false }) : e;
    if (!stat) continue;
    if (stat.isDirectory() && e.name !== "node_modules" && !e.name.startsWith(".")) yield* pngs(p);
    else if (stat.isFile() && /\.png$/i.test(e.name)) yield p;
  }
}

const variants = {
  plain: (img, g) => [img, g],
  opaque: (img, g) => {
    const px = Uint8Array.from(img.rgba);
    for (let i = 0; i < px.length; i += 4) {
      const a = px[i + 3] / 255;
      [40, 90, 160].forEach((c, k) => (px[i + k] = Math.round(px[i + k] * a + c * (1 - a))));
      px[i + 3] = 255;
    }
    return [{ ...img, rgba: px }, g];
  },
  trailing: (img, g, i) => {
    const px = Uint8Array.from(img.rgba);
    const drop = 1 + (i % Math.max(1, g.cols - 1));
    for (const r of frameRects(img.width, img.height, g.cols, g.rows).slice(-drop)) {
      for (let y = r.y; y < r.y + r.h; y++) px.fill(0, (y * img.width + r.x) * 4, (y * img.width + r.x + r.w) * 4);
    }
    return [{ ...img, rgba: px }, g];
  },
  strip: (img, g) => {
    if (g.rows < 2) return undefined;
    const h = Math.floor(img.height / g.rows);
    return [{ width: img.width, height: h, rgba: img.rgba.slice(0, img.width * h * 4) }, { cols: g.cols, rows: 1 }];
  }
};

const sheets = [];
for (const dir of process.argv.slice(2)) {
  for (const file of pngs(dir)) {
    const buf = fs.readFileSync(file);
    if (!readText(buf)["ludo:grid"]) continue;
    try {
      const g = JSON.parse(readText(buf)["ludo:grid"]);
      sheets.push({ file, image: readPng(buf).image, grid: { cols: g.cols, rows: g.rows } });
    } catch {}
  }
}
if (!sheets.length) {
  console.error("No stamped spritesheets found. Usage: node scripts/grid-eval.mjs <folder>...");
  process.exit(2);
}
let wrongTotal = 0;
for (const [name, make] of Object.entries(variants)) {
  const tally = { sheets: 0, right: 0, wrong: 0, refused: 0 };
  const wrong = [];
  let ms = 0;
  sheets.forEach((s, i) => {
    const v = make(s.image, s.grid, i);
    if (!v) return;
    const [img, truth] = v;
    tally.sheets++;
    const t0 = Date.now();
    const g = guessGrid(img);
    ms += Date.now() - t0;
    const frames = countFrames(img, truth.cols, truth.rows);
    if (g.confidence < CONFIDENT) return tally.refused++;
    if (g.cols === truth.cols && g.rows === truth.rows && g.frames === frames) return tally.right++;
    tally.wrong++;
    wrong.push(`  ${s.file}: ${truth.cols}x${truth.rows}/${frames}, got ${g.cols}x${g.rows}/${g.frames} (${g.confidence.toFixed(2)})`);
  });
  wrongTotal += tally.wrong;
  console.log(name.padEnd(8), JSON.stringify(tally), `${Math.round(ms / tally.sheets)} ms a sheet`);
  if (wrong.length) console.log(wrong.join("\n"));
}
process.exit(wrongTotal ? 1 : 0);
