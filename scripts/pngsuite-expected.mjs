// Writes test/corpus/pngsuite/expected.json: the sha256 of each valid PngSuite
// image decoded to 8-bit RGBA by ImageMagick, which the PNG decoder's tests
// must match byte for byte. Pillow decodes each file too, as a second opinion;
// it must agree except where Pillow is known to differ:
//   - 16-bit colour: Pillow keeps the high byte, ImageMagick rounds (off by 1);
//   - 16-bit grey: Pillow clips to 255 instead of scaling;
//   - tRNS on 1/2/4-bit grey: Pillow ignores it.
// Needs `magick` (ImageMagick 7) and python3 with Pillow. Run it after
// changing the corpus; commit the result.
import fs from "node:fs";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const dir = new URL("../test/corpus/pngsuite/", import.meta.url).pathname;
const PILLOW_QUIRKS = /^(.{4}[0-6][ag]16|.{4}[0-6]c16|tbbn0g04|tbwn0g16)\.png$/;
const pillowCode = "import sys;from PIL import Image;sys.stdout.buffer.write(Image.open(sys.argv[1]).convert('RGBA').tobytes())";

// RGB under a fully transparent pixel is invisible and decoders disagree on
// it, so it is zeroed before hashing (the tests do the same).
const canonical = rgba => {
  const out = Buffer.from(rgba);
  for (let i = 0; i < out.length; i += 4) if (out[i + 3] === 0) out.fill(0, i, i + 3);
  return out;
};
const sha = buf => crypto.createHash("sha256").update(canonical(buf)).digest("hex");

const expected = {};
let disagreements = 0;
for (const file of fs.readdirSync(dir).filter(f => f.endsWith(".png")).sort()) {
  if (file.startsWith("x")) continue; // deliberately corrupt: must be refused
  const magick = sha(execFileSync("magick", [dir + file, "-depth", "8", "RGBA:-"]));
  const pillow = sha(execFileSync("python3", ["-I", "-c", pillowCode, dir + file]));
  if (magick !== pillow && !PILLOW_QUIRKS.test(file)) {
    console.error(`${file}: ImageMagick and Pillow disagree`);
    disagreements++;
  }
  expected[file] = magick;
}
if (disagreements) process.exit(1);
fs.writeFileSync(dir + "expected.json", JSON.stringify(expected, null, 2) + "\n");
console.log(`${Object.keys(expected).length} images written to ${dir}expected.json`);
