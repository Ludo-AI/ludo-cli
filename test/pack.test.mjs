// `ludo toolbox sprite pack`: geometry against the web app's math (ported in
// packMath.ts, whose own tests are test/web-math/), the resampler against
// Pillow, and the command's flags, outputs and manifest.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildPack, layoutSheet } from "../dist/toolbox/pack.js";
import { resizeNearest, resizeSmooth } from "../dist/toolbox/resample.js";
import { computeFramePlacement, computePackNormalization } from "../dist/toolbox/packMath.js";
import { encodePng, readPng, readText } from "../dist/tty/png.js";
import { sliceSheet } from "../dist/toolbox/sheet.js";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ludo-pack-test-"));
const PILLOW = spawnSync("python3", ["-I", "-c", "import PIL"], { stdio: "ignore" }).status === 0;
const sha = buf => crypto.createHash("sha256").update(buf).digest("hex");
// RGB under a fully transparent pixel is not kept; compare without it.
function canonical(rgba) {
  const out = Buffer.from(rgba);
  for (let i = 0; i < out.length; i += 4) if (out[i + 3] === 0) out.fill(0, i, i + 3);
  return out;
}

// The web's ground snap counts the space below frame 1's character from its
// last row (inclusive) to the box height (exclusive), so feet resting on
// the box bottom get a ground offset of 1, not 0: every animation's box sits
// 1 scaled pixel below the ground line. Kept as the web does it.

// A character: a w x h block standing with its feet `lift` pixels above the
// bottom of a W x H frame, centred at cx, in a colour that changes per frame.
function character(W, H, { w, h, lift = 0, cx = W / 2, k = 0 }) {
  const rgba = new Uint8Array(W * H * 4);
  const x0 = Math.round(cx - w / 2);
  for (let y = H - lift - h; y < H - lift; y++) {
    for (let x = x0; x < x0 + w; x++) rgba.set([(40 + 30 * k) & 255, 90 + ((y * 3) & 63), 160 + ((x * 5) & 63), 255], (y * W + x) * 4);
  }
  return { width: W, height: H, rgba };
}

// The box around a frame's visible pixels.
function contentBox(img) {
  let [x0, y0, x1, y1] = [img.width, img.height, -1, -1];
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.rgba[(y * img.width + x) * 4 + 3] <= 10) continue;
      [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
    }
  }
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// A short character standing still, a tall one whose first frame is 2 px
// above its lowest, and a medium one whose first frame is crouched.
const short = Array.from({ length: 4 }, (_, k) => character(40, 50, { w: 12, h: 30, lift: 2, k }));
const tall = Array.from({ length: 6 }, (_, k) => character(80, 100, { w: 24, h: 60, lift: 4 + ((k + 2) % 3), k }));
const medium = Array.from({ length: 3 }, (_, k) => character(64, 64, { w: 18, h: k === 0 ? 40 : 45, lift: k === 0 ? 1 : 5, k }));

test("frames are sized and placed by the web's math, feet on one ground line", () => {
  const pack = buildPack([{ frames: short }, { frames: tall }, { frames: medium }], { art: "pixel" });

  // What the web computes for the same inputs (trim box = union of content).
  const web = computePackNormalization([
    { animCharHeight: 30, frameBounds: short.map(() => ({ width: 12, height: 30 })), groundOffset: 1 },
    { animCharHeight: 60, frameBounds: tall.map(() => ({ width: 24, height: 62 })), groundOffset: 3 },
    { animCharHeight: 40, frameBounds: medium.map(() => ({ width: 18, height: 49 })), groundOffset: 1 }
  ]);
  assert.deepEqual([pack.frameWidth, pack.frameHeight], [web.frameSize.width, web.frameSize.height]);
  assert.equal(pack.targetHeight, 30, "the shortest character sets the height");
  assert.deepEqual(
    pack.animations.map(a => a.scale),
    web.scales
  );
  assert.deepEqual(
    pack.animations.map(a => a.groundAuto),
    [-1, -3, -1],
    "the tall one's first frame stands 2 px above its box's bottom (+1, see above)"
  );

  // Frame 1 of every animation: the same character height, feet on the same row.
  const firsts = pack.animations.map(a => contentBox(a.frames[0]));
  assert.deepEqual(
    firsts.map(b => b.h),
    [30, 30, 30]
  );
  // On the ground line, give or take the web's 1 scaled pixel and rounding:
  // at scales 1 and 0.5 the feet land a pixel apart.
  const feet = firsts.map(b => b.y + b.h);
  const groundRow = pack.frameHeight - pack.groundLine;
  assert.ok(Math.max(...feet) - Math.min(...feet) <= 1, `feet rows ${feet}`);
  assert.ok(feet.every(f => Math.abs(f - groundRow) <= 1.5), `feet rows ${feet}, ground line at ${groundRow}`);

  // Every frame where the web's placement puts it.
  pack.animations.forEach((a, i) => {
    const { charX, charY } = computeFramePlacement({
      frameWidth: pack.frameWidth,
      frameHeight: pack.frameHeight,
      maxGroundOffset: pack.groundLine,
      groundOffset: -a.ground * a.scale,
      scaledWidth: a.trim.width * a.scale,
      scaledHeight: a.trim.height * a.scale,
      scale: a.scale
    });
    const box = contentBox(a.frames.reduce((acc, f) => ({ ...f, rgba: acc.rgba.map((v, j) => Math.max(v, f.rgba[j])) })));
    assert.deepEqual([box.x, box.y, box.w, box.h], [charX, charY, Math.round(a.trim.width * a.scale), Math.round(a.trim.height * a.scale)], `animation ${i + 1}`);
  });
});

test("size, ground and horizontal offsets move an animation as the web's do", () => {
  const base = buildPack([{ frames: short }, { frames: tall }], { art: "pixel" });
  const moved = buildPack([{ frames: short }, { frames: tall, size: 1.5, ground: 6, offsetX: 4 }], { art: "pixel" });
  // Raised from the snap (-3) to 6: 9 source px at scale 0.75, against the
  // short one standing still.
  const lift = p => {
    const [a, b] = [contentBox(p.animations[0].frames[0]), contentBox(p.animations[1].frames[0])];
    return a.y + a.h - (b.y + b.h);
  };
  const m = contentBox(moved.animations[1].frames[0]);
  assert.equal(m.h, 45, "1.5 x the matched 30 px");
  assert.ok(Math.abs(lift(moved) - lift(base) - 6.75) <= 1, `raised by ${lift(moved) - lift(base)}`);
  // Centred, then 4 source px right at scale 0.75 (3 px).
  const centre = box => box.x + box.w / 2;
  assert.ok(Math.abs(centre(m) - moved.frameWidth / 2 - 3) <= 0.5, `centre ${centre(m)} in ${moved.frameWidth}`);
  // Nothing is clipped: room was made for the offset.
  assert.ok(m.x >= 0 && m.x + m.w <= moved.frameWidth && m.y >= 0);
});

test("a frame size grows the frame; the sprites stay centred on the ground line", () => {
  const auto = buildPack([{ frames: short }, { frames: tall }], { art: "pixel" });
  const grown = buildPack([{ frames: short }, { frames: tall }], { art: "pixel", frameSize: { w: 100, h: 120 } });
  assert.deepEqual([grown.frameWidth, grown.frameHeight], [100, 120]);
  const a = contentBox(auto.animations[0].frames[0]);
  const g = contentBox(grown.animations[0].frames[0]);
  assert.equal(grown.frameHeight - (g.y + g.h), auto.frameHeight - (a.y + a.h), "same distance from the bottom");
  assert.ok(Math.abs(g.x + g.w / 2 - 50) <= 0.5);
  // A size smaller than the content never crops it.
  const small = buildPack([{ frames: short }], { art: "pixel", frameSize: { w: 4, h: 4 } });
  assert.deepEqual([small.frameWidth, small.frameHeight], [12, 31], "30 px plus the 1 px ground offset");
});

test("pixel art resizes by nearest neighbour; smooth art matches Pillow", () => {
  const w = 37;
  const h = 29;
  let seed = 9;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < rgba.length; i += 4) rgba.set([rnd() * 256, rnd() * 256, rnd() * 256, rnd() < 0.3 ? 0 : rnd() < 0.5 ? 255 : rnd() * 256].map(Math.floor), i);
  const img = { width: w, height: h, rgba };
  // Nearest: the source pixel under each output pixel's centre.
  const half = resizeNearest(img, 18, 14);
  for (const [x, y] of [
    [0, 0],
    [17, 13],
    [9, 5]
  ]) {
    const sx = Math.floor(((x + 0.5) * w) / 18);
    const sy = Math.floor(((y + 0.5) * h) / 14);
    assert.deepEqual([...half.rgba.subarray((y * 18 + x) * 4, (y * 18 + x) * 4 + 4)], [...rgba.subarray((sy * w + sx) * 4, (sy * w + sx) * 4 + 4)]);
  }
  assert.deepEqual(resizeSmooth(img, w, h).rgba.filter((_, i) => rgba[i - (i % 4) + 3] === 255), rgba.filter((_, i) => rgba[i - (i % 4) + 3] === 255), "same size: opaque pixels unchanged");
  if (!PILLOW) return;
  const dir = tmp();
  const file = path.join(dir, "noise.png");
  fs.writeFileSync(file, encodePng(img));
  for (const [W, H] of [
    [18, 14],
    [25, 20],
    [55, 43],
    [100, 80]
  ]) {
    const filter = W < w ? "BOX" : "BICUBIC";
    const code = `import sys\nfrom PIL import Image\nfor f in ("NEAREST", "${filter}"):\n  sys.stdout.buffer.write(Image.open(sys.argv[1]).convert("RGBA").resize((${W}, ${H}), getattr(Image.Resampling, f)).tobytes())`;
    const out = execFileSync("python3", ["-I", "-c", code, file]);
    const size = W * H * 4;
    assert.equal(sha(canonical(resizeNearest(img, W, H).rgba)), sha(canonical(out.subarray(0, size))), `${W}x${H} nearest: Pillow's NEAREST exactly`);
    const ours = resizeSmooth(img, W, H).rgba;
    const pil = out.subarray(size);
    for (let i = 0; i < size; i += 4) {
      assert.ok(Math.abs(ours[i + 3] - pil[i + 3]) <= 1, `${W}x${H} ${filter}: alpha at ${i / 4}`);
      // Colour under low alpha is amplified by the un-premultiply.
      if (pil[i + 3] >= 128) for (let c = 0; c < 3; c++) assert.ok(Math.abs(ours[i + c] - pil[i + c]) <= 2, `${W}x${H} ${filter}: colour at ${i / 4}: ${ours[i + c]} vs ${pil[i + c]}`);
    }
  }
});

test("layoutSheet keeps the source grid, empty cells included", () => {
  const frames = short.slice(0, 3);
  const sheet = layoutSheet(frames, 2, 3);
  assert.deepEqual([sheet.width, sheet.height], [80, 150]);
  sliceSheet(sheet, 2, 3, 3).forEach((f, i) => assert.equal(sha(Buffer.from(f.rgba)), sha(Buffer.from(frames[i].rgba))));
  assert.ok(sliceSheet(sheet, 2, 3)[5].rgba.every(v => v === 0));
});

// ---- The command ----

function cli(args, cwd) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, LUDO_TELEMETRY: "0", LUDO_API_KEY: "", LUDO_API_URL: "http://127.0.0.1:9", LUDO_CONFIG_DIR: path.join(cwd, ".config"), LUDO_CACHE_DIR: path.join(cwd, ".cache") }
  });
  return { code: r.status, out: r.stdout, err: r.stderr, json: r.stdout.trim().startsWith("{") ? JSON.parse(r.stdout) : undefined };
}

function sheets(dir) {
  const write = (name, frames, cols) => {
    const folder = path.join(dir, `${name}-frames`);
    fs.mkdirSync(folder, { recursive: true });
    frames.forEach((f, k) => fs.writeFileSync(path.join(folder, `${name}-${k + 1}.png`), encodePng(f)));
    const r = cli(["toolbox", "sprite", "join", folder, "--cols", String(cols), "--fps", "12", "--name", name, "--out", "art", "--json"], dir);
    assert.equal(r.code, 0, r.err);
    return r.json.sheet;
  };
  return { idle: write("idle", short, 2), walk: write("walk", tall, 3), jump: write("jump", medium, 3) };
}

const filesUnder = dir =>
  fs
    .readdirSync(dir, { recursive: true })
    .filter(f => fs.statSync(path.join(dir, f)).isFile())
    .sort();

test("toolbox sprite pack: sheets, engine files and a manifest that re-runs it exactly", () => {
  const dir = tmp();
  const s = sheets(dir);
  const r = cli(["toolbox", "sprite", "pack", s.idle, s.walk, s.jump, "--name", "Hero Pack", "--engine", "texturepacker", "--size", "walk=1.2", "--offset-x", "3=2", "--out", "out", "--json"], dir);
  assert.equal(r.code, 0, r.err);
  const j = r.json;
  assert.equal(j.pack, path.join("out", "hero-pack"));
  assert.deepEqual(
    j.animations.map(a => [a.label, a.frames, a.grid.cols, a.grid.rows, a.size, a.offset_x]),
    [
      ["idle", 4, 2, 2, 1, 0],
      ["walk", 6, 3, 2, 1.2, 0],
      ["jump", 3, 3, 1, 1, 2]
    ]
  );
  assert.deepEqual(filesUnder(path.join(dir, j.pack)), ["idle.json", "idle.png", "jump.json", "jump.png", "pack.json", "walk.json", "walk.png"]);

  // Each sheet keeps its grid, in the shared frame size, and remembers it.
  for (const a of j.animations) {
    const buf = fs.readFileSync(path.join(dir, a.sheet));
    const { image } = readPng(buf);
    assert.deepEqual([image.width, image.height], [j.frame_width * a.grid.cols, j.frame_height * a.grid.rows]);
    assert.deepEqual(JSON.parse(readText(buf)["ludo:grid"]), { cols: a.grid.cols, rows: a.grid.rows, frames: a.frames, fps: 12 });
    const atlas = JSON.parse(fs.readFileSync(path.join(dir, a.engine_files[0]), "utf8"));
    assert.deepEqual(Object.keys(atlas.animations), [a.label]);
    assert.deepEqual(atlas.frames["1"].frame, { x: j.frame_width, y: 0, w: j.frame_width, h: j.frame_height });
  }

  // The manifest re-runs it to the same bytes.
  const again = cli(["toolbox", "sprite", "pack", "--manifest", j.manifest, "--engine", "texturepacker", "--out", "out", "--json"], dir);
  assert.equal(again.code, 0, again.err);
  assert.equal(again.json.pack, path.join("out", "hero-pack-2"));
  assert.equal(again.json.warnings, undefined);
  for (const f of filesUnder(path.join(dir, j.pack))) {
    if (f === "pack.json") continue;
    assert.equal(sha(fs.readFileSync(path.join(dir, again.json.pack, f))), sha(fs.readFileSync(path.join(dir, j.pack, f))), f);
  }
  const m1 = JSON.parse(fs.readFileSync(path.join(dir, j.manifest), "utf8"));
  const m2 = JSON.parse(fs.readFileSync(path.join(dir, again.json.manifest), "utf8"));
  assert.deepEqual(m2.animations.map(({ input, ...rest }) => rest), m1.animations.map(({ input, ...rest }) => rest));
  assert.equal(m1.animations[0].input, "../../art/idle.png", "inputs relative to the manifest");

  // Flags given with --manifest override it.
  const pixel = cli(["toolbox", "sprite", "pack", "--manifest", j.manifest, "--art", "pixel", "--ground", "idle=5", "--out", "out", "--json"], dir);
  assert.equal(pixel.code, 0, pixel.err);
  assert.equal(pixel.json.art, "pixel");
  assert.deepEqual(
    pixel.json.animations.map(a => [a.size, a.ground, a.offset_x]),
    [
      [1, 5, 0],
      [1.2, -3, 0],
      [1, -1, 2]
    ]
  );

  // A changed input is noted.
  fs.copyFileSync(path.join(dir, s.jump), path.join(dir, s.idle));
  const changed = cli(["toolbox", "sprite", "pack", "--manifest", j.manifest, "--out", "out", "--json"], dir);
  assert.equal(changed.code, 0, changed.err);
  assert.deepEqual(changed.json.warnings, [`${path.join("art", "idle.png")} changed since the manifest was written`]);
});

test("toolbox sprite pack: frames mode, labels and folders of frames", () => {
  const dir = tmp();
  const s = sheets(dir);
  const r = cli(["toolbox", "sprite", "pack", s.idle, "walk-frames", s.walk, "--mode", "frames", "--label", "1=stand", "--label", "3=stand", "--out", "out", "--json"], dir);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(
    r.json.animations.map(a => [a.label, a.frames, a.dir]),
    [
      ["stand", 4, path.join("out", "animation-pack", "stand")],
      ["walk-frames", 6, path.join("out", "animation-pack", "walk-frames")],
      ["stand-1", 6, path.join("out", "animation-pack", "stand-1")]
    ]
  );
  const files = filesUnder(path.join(dir, "out", "animation-pack"));
  assert.ok(files.includes(path.join("stand", "frame_000.png")) && files.includes(path.join("stand", "frame_003.png")) && !files.includes(path.join("stand", "frame_004.png")));
  // A label picks its animation in the other flags.
  const byLabel = cli(["toolbox", "sprite", "pack", s.idle, s.walk, "--label", "walk=hero-walk", "--size", "hero-walk=1.5", "--out", "out", "--json"], dir);
  assert.equal(byLabel.code, 0, byLabel.err);
  assert.deepEqual(
    byLabel.json.animations.map(a => [a.label, a.size]),
    [
      ["idle", 1],
      ["hero-walk", 1.5]
    ]
  );
  // A folder of frames and the sheet made from it pack the same.
  for (let k = 0; k < 6; k++) {
    const name = `frame_${String(k).padStart(3, "0")}.png`;
    const a = readPng(fs.readFileSync(path.join(dir, "out", "animation-pack", "walk-frames", name))).image;
    const b = readPng(fs.readFileSync(path.join(dir, "out", "animation-pack", "stand-1", name))).image;
    assert.equal(sha(Buffer.from(a.rgba)), sha(Buffer.from(b.rgba)), name);
  }
});

test("toolbox sprite pack: bad flags are usage errors", () => {
  const dir = tmp();
  const s = sheets(dir);
  for (const [args, message] of [
    [["--size", "run=2"], /no animation is called run/],
    [["--size", "4=2"], /there are 3 animations/],
    [["--size", "walk=0"], /--size takes a number above 0/],
    [["--ground", "1.5"], /--ground takes whole pixels/],
    [["--label", "walk"], /--label takes anim=name/],
    [["--mode", "zip"], /--mode is sheets or frames/],
    [["--art", "hd"], /--art is smooth or pixel/],
    [["--frame-size", "5000x10"], /--frame-size goes up to 4096/],
    [["--frame-size", "big"], /--frame-size takes width x height/]
  ]) {
    const r = cli(["toolbox", "sprite", "pack", s.idle, s.walk, s.jump, "--json", ...args], dir);
    assert.equal(r.code, 2, `${args.join(" ")}: ${r.err}`);
    assert.match(r.err + r.out, message);
  }
  // Two inputs with one name: pick by position.
  fs.mkdirSync(path.join(dir, "b"));
  fs.copyFileSync(path.join(dir, s.walk), path.join(dir, "b", "walk.png"));
  const twice = cli(["toolbox", "sprite", "pack", s.walk, path.join("b", "walk.png"), "--size", "walk=2", "--json"], dir);
  assert.equal(twice.code, 2);
  assert.match(twice.err, /walk is animations 1 and 2; pick one by its number/);
  assert.equal(cli(["toolbox", "sprite", "pack", s.walk, "--manifest", "x.json", "--json"], dir).code, 2);
  fs.writeFileSync(path.join(dir, "bad.json"), "{}");
  assert.equal(cli(["toolbox", "sprite", "pack", "--manifest", "bad.json", "--json"], dir).code, 12);
});

test("golden output: the same pack gives the same pixels", () => {
  // Pixels are ours (the web's canvas resampling differs by browser), so they
  // are pinned here: a change to them must be deliberate.
  const inputs = [{ frames: short }, { frames: tall, size: 1.3, offsetX: -3 }, { frames: medium, ground: 4 }];
  const digest = art => {
    const h = crypto.createHash("sha256");
    for (const a of buildPack(inputs, { art }).animations) for (const f of a.frames) h.update(f.rgba);
    return h.digest("hex");
  };
  assert.equal(digest("pixel"), "344ad47be2d61ca1cf93629eb94864a7c4049ed324101173e9e6127ba37f6fc3");
  assert.equal(digest("smooth"), "0a5ed77498889fc0c84f63d38708b13a661236ff57583f6f4ff87841dedf8b46");
});
