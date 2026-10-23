// Writes test/corpus/gif/expected.json: for each GIF in the corpus (image-rs's
// image-gif test files), the sha256 of every frame as ImageMagick shows it
// (-coalesce, 8-bit RGBA) and the delays, or that ImageMagick refuses the
// file. The GIF decoder's tests must match it. Pillow decodes each file too,
// as a second opinion, and must agree. Needs `magick` (ImageMagick 7) and
// python3 with Pillow. Run it after changing the corpus; commit the result.
import fs from "node:fs";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const dir = new URL("../test/corpus/gif/", import.meta.url).pathname;
const pillowCode =
  "import sys\nfrom PIL import Image, ImageSequence\nfor f in ImageSequence.Iterator(Image.open(sys.argv[1])): sys.stdout.buffer.write(f.convert('RGBA').tobytes())";

// RGB under a fully transparent pixel is invisible and decoders disagree on
// it, so it is zeroed before hashing (the tests do the same).
const canonical = rgba => {
  const out = Buffer.from(rgba);
  for (let i = 0; i < out.length; i += 4) if (out[i + 3] === 0) out.fill(0, i, i + 3);
  return out;
};
const sha = buf => crypto.createHash("sha256").update(canonical(buf)).digest("hex");
const run = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1 << 28 });
  } catch {
    return undefined;
  }
};
const frames = (raw, size) => Array.from({ length: raw.length / size }, (_, k) => sha(raw.subarray(k * size, (k + 1) * size)));

const expected = {};
let disagreements = 0;
for (const file of fs.readdirSync(dir).filter(f => f.endsWith(".gif")).sort()) {
  const path = dir + file;
  const info = run("magick", ["identify", "-format", "%W %H %T\n", path]);
  const raw = info && run("magick", [path, "-coalesce", "-depth", "8", "RGBA:-"]);
  const pil = run("python3", ["-I", "-c", pillowCode, path]);
  if (!raw) {
    expected[file] = { refused: true };
    if (pil) {
      console.log(`${file}: ImageMagick refuses it, Pillow reads it`);
      disagreements++;
    }
    continue;
  }
  const lines = info.toString().trim().split("\n");
  const [width, height] = lines[0].split(" ").map(Number);
  const hashes = frames(raw, width * height * 4);
  expected[file] = { width, height, delays: lines.map(l => Number(l.split(" ")[2])), frames: hashes };
  if (!pil || frames(pil, width * height * 4).join() !== hashes.join()) {
    console.log(`${file}: Pillow ${pil ? "decodes it differently" : "refuses it"}`);
    disagreements++;
  }
}
fs.writeFileSync(dir + "expected.json", JSON.stringify(expected, null, 2) + "\n");
console.log(`${Object.keys(expected).length} files, ${disagreements} disagreements`);
