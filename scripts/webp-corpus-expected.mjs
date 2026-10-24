// Writes test/corpus/webp/expected.json: for each WebP in the corpus, what
// libwebp decodes it to, as the sha256 of the 8-bit RGBA of each frame.
//  - Still images: dwebp -pam (its default "fancy" chroma upsampling, which
//    is what our decoder does), checked against Pillow's decode.
//  - Animations: Pillow, whose WebP reader is libwebp's WebPAnimDecoder
//    (the compositing anim_dump and browsers use), each frame
//    .convert("RGBA"); the frame count, durations and loop count come from
//    `webpmux -info` and must agree with Pillow's.
//  - Files dwebp (and webpmux, for animations) refuse are { refused: true }.
// Hashes are of the RGBA exactly as decoded, colour under transparent pixels
// included. Needs dwebp, webpmux and python3 with Pillow. Run it after
// changing the corpus; commit the result. It reports one disagreement,
// bad_palette_index.webp (see the corpus README): dwebp's decode is kept.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const dir = new URL("../test/corpus/webp/", import.meta.url).pathname;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "webp-expected-"));
const sha = buf => crypto.createHash("sha256").update(buf).digest("hex");
const run = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1 << 28 });
  } catch {
    return undefined;
  }
};
const pillowCode = `
import sys, json, hashlib
from PIL import Image, ImageSequence
im = Image.open(sys.argv[1])
out = {"width": im.width, "height": im.height, "loop": im.info.get("loop"), "durations": [], "frames": []}
for f in ImageSequence.Iterator(im):
    rgba = f.convert("RGBA").tobytes()  # loading the frame sets its duration
    out["durations"].append(f.info.get("duration"))
    out["frames"].append(hashlib.sha256(rgba).hexdigest())
print(json.dumps(out))
`;

function dwebp(file) {
  const out = path.join(tmp, "out.pam");
  if (!run("dwebp", ["-quiet", file, "-pam", "-o", out])) return undefined;
  const buf = fs.readFileSync(out);
  const head = buf.toString("latin1", 0, 256);
  return { width: +/WIDTH (\d+)/.exec(head)[1], height: +/HEIGHT (\d+)/.exec(head)[1], rgba: buf.subarray(head.indexOf("ENDHDR\n") + 7) };
}

// `webpmux -info`: canvas, loop count and per-frame durations of an animation.
function muxInfo(file) {
  const text = run("webpmux", ["-info", file])?.toString();
  if (!text || !/Features present:.*animation/.test(text)) return undefined;
  const loop = Number(/Loop Count : (\d+)/.exec(text)[1]);
  const durations = [...text.matchAll(/^\s*\d+:\s+\d+\s+\d+\s+\w+\s+\d+\s+\d+\s+(\d+)/gm)].map(m => Number(m[1]));
  return { loop, durations };
}

const expected = {};
let disagreements = 0;
for (const file of fs.readdirSync(dir).filter(f => f.endsWith(".webp")).sort()) {
  const p = path.join(dir, file);
  const pil = run("python3", ["-I", "-c", pillowCode, p]);
  const pillow = pil && JSON.parse(pil.toString());
  const anim = muxInfo(p);
  if (anim) {
    if (!pillow) {
      expected[file] = { refused: true };
      console.log(`${file}: Pillow refuses this animation`);
      disagreements++;
      continue;
    }
    expected[file] = { width: pillow.width, height: pillow.height, loops: anim.loop, durations: anim.durations, frames: pillow.frames };
    if (pillow.loop !== anim.loop || pillow.durations.join() !== anim.durations.join()) {
      console.log(`${file}: Pillow reads loop ${pillow.loop}, durations ${pillow.durations}; webpmux ${anim.loop}, ${anim.durations}`);
      disagreements++;
    }
    continue;
  }
  const still = dwebp(p);
  if (!still) {
    expected[file] = { refused: true };
    if (pillow) {
      console.log(`${file}: dwebp refuses it, Pillow reads it`);
      disagreements++;
    }
    continue;
  }
  const hash = sha(still.rgba);
  expected[file] = { width: still.width, height: still.height, frames: [hash] };
  if (!pillow || pillow.frames[0] !== hash) {
    console.log(`${file}: Pillow ${pillow ? "decodes it differently" : "refuses it"}`);
    disagreements++;
  }
}
fs.writeFileSync(path.join(dir, "expected.json"), JSON.stringify(expected, null, 2) + "\n");
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${Object.keys(expected).length} files, ${disagreements} disagreements`);
