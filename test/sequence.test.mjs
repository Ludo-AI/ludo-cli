// `ludo toolbox sprite sequence`: the aligner on cases with known answers,
// the geometry against the web app's math (ported in sequenceMath.ts, whose
// own tests are test/web-math/), and the command's modes, flags and manifest.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { alignGround, alignSprites, groundAlignment } from "../dist/toolbox/align.js";
import { buildSequence } from "../dist/toolbox/sequence.js";
import { cropBounds, nextSequenceSlot, paddedFrameLayout, sequenceCanvasBounds, sequenceGrid } from "../dist/toolbox/sequenceMath.js";
import { resizeNearest, resizeSmooth } from "../dist/toolbox/resample.js";
import { blit, sliceSheet } from "../dist/toolbox/sheet.js";
import { encodePng, readPng, readText } from "../dist/tty/png.js";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ludo-sequence-test-"));
const sha = buf => crypto.createHash("sha256").update(buf).digest("hex");
const same = (a, b) => a.width === b.width && a.height === b.height && Buffer.compare(Buffer.from(a.rgba), Buffer.from(b.rgba)) === 0;

// A character with some texture to match on: an egg-shaped body and a head,
// shaded and patterned, on transparency.
function character(w = 60, h = 90) {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const body = ((x - w / 2) / (w / 2)) ** 2 + ((y - h * 0.62) / (h * 0.38)) ** 2 <= 1;
      const head = ((x - w * 0.55) / (w * 0.3)) ** 2 + ((y - h * 0.2) / (h * 0.2)) ** 2 <= 1;
      if (!body && !head) continue;
      const stripe = ((x * 7 + y * 13) >> 3) & 1;
      rgba.set([head ? 220 : 60 + 3 * y, 90 + 2 * x + 40 * stripe, head ? 80 : 200 - y, 255], (y * w + x) * 4);
    }
  }
  return { width: w, height: h, rgba };
}
const HERO = character();

// `img` placed at (x, y) in a W x H frame.
function frame(W, H, img, x, y) {
  const out = { width: W, height: H, rgba: new Uint8Array(W * H * 4) };
  blit(out, img, x, y);
  return out;
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

// Walking right, 5 px a frame, in 160x200 frames (over the aligner's 128 px,
// so it downsamples and refines).
const walk = Array.from({ length: 4 }, (_, k) => frame(160, 200, HERO, 20 + 5 * k, 60));
// The same character in a bigger frame, starting somewhere else.
const jump = Array.from({ length: 5 }, (_, k) => frame(180, 220, HERO, 50 + 2 * k, 40 - 6 * k));
// Drawn at 0.8 the size.
const SMALL = resizeSmooth(HERO, 48, 72);
const small = Array.from({ length: 3 }, (_, k) => frame(140, 170, SMALL, 30 + 4 * k, 30));

// ---- The aligner ----

test("a shifted copy aligns by that shift, at scale 1", () => {
  const a = walk[3]; // the character at (35, 60)
  for (const [x, y] of [[35, 60], [50, 40], [0, 100], [90, 10]]) {
    const b = frame(180, 220, HERO, x, y);
    const r = alignSprites(a, b);
    assert.deepEqual([r.dx, r.dy, r.scale, r.method], [35 - x, 60 - y, 1, "ncc"], `character at ${x},${y}`);
    assert.ok(r.confidence > 0.999, `confidence ${r.confidence}`);
  }
  // Small frames are matched as they are, without downsampling.
  const r = alignSprites(frame(100, 120, HERO, 10, 20), frame(100, 120, HERO, 30, 5));
  assert.deepEqual([r.dx, r.dy, r.scale], [-20, 15, 1]);
});

test("a smaller copy aligns at the scale that matches it", () => {
  const r = alignSprites(walk[3], small[0]);
  assert.equal(r.method, "ncc");
  assert.ok(Math.abs(r.scale - 1.25) < 0.01, `scale ${r.scale}`);
  // Its top-left lands where the big one's is, give or take resampling.
  assert.ok(Math.abs(r.dx - (35 - 30 * 1.25)) <= 1 && Math.abs(r.dy - (60 - 30 * 1.25)) <= 1, `dx ${r.dx}, dy ${r.dy}`);
});

test("a poor match falls back to lining up the feet and the centres", () => {
  // Forced: no match is good enough.
  const r = alignSprites(walk[3], small[0], { confidenceThreshold: 1.01 });
  assert.equal(r.method, "ground");
  assert.ok(r.confidence > 0.9, "the score measured is kept");
  assert.equal(r.scale, contentBox(walk[3]).h / contentBox(small[0]).h, "the content-height ratio");
  assert.deepEqual({ dx: r.dx, dy: r.dy }, alignGround(walk[3], small[0], r.scale));
  // Nothing to match on: an empty frame scores 0.
  const blank = { width: 160, height: 200, rgba: new Uint8Array(160 * 200 * 4) };
  const e = alignSprites(walk[3], blank);
  assert.deepEqual([e.method, e.confidence], ["ground", 0]);
});

test("ground alignment lines up bottom edges and centres of mass, at B's scale", () => {
  const b = frame(180, 220, HERO, 50, 40);
  assert.deepEqual(alignGround(walk[3], b), { dx: -15, dy: 20 });
  // B at 2x by nearest neighbour: its edges and centre scale exactly.
  const b2 = resizeNearest(b, 360, 440);
  const { dx, dy } = alignGround(walk[3], b, 2);
  const [ba, bb] = [contentBox(walk[3]), contentBox(b2)];
  assert.equal(bb.y + bb.h + dy, ba.y + ba.h, "bottoms meet");
  assert.ok(Math.abs(bb.x + bb.w / 2 + dx - (ba.x + ba.w / 2)) <= 1, "centres meet");
  const g = groundAlignment(walk[3], b);
  assert.deepEqual([g.dx, g.dy, g.scale, g.method], [-15, 20, 1, "ground"]);
  assert.ok(Number.isNaN(g.confidence));
});

// ---- The sequence ----

test("the sequence is chained, cropped and laid out by the web's math", () => {
  const seq = buildSequence([walk, jump, small], { art: "pixel", align: "auto" });
  // What the web computes from the same transitions.
  const slots = [{ x: 0, y: 0, w: 160, h: 200 }];
  const raw = [jump[0], small[0]];
  seq.transitions.forEach((t, i) => slots.push(nextSequenceSlot(slots[i], t, raw[i].width, raw[i].height)));
  assert.deepEqual(seq.slots, slots);
  assert.deepEqual(seq.transitions.slice(0, 1).map(t => [t.dx, t.dy, t.scale]), [[-15, 20, 1]]);
  const { canvasW, canvasH, shiftX, shiftY } = sequenceCanvasBounds(slots);
  // Every frame's content, on the canvas.
  const boxes = [walk, jump, small].flatMap((frames, i) =>
    frames.map(f => {
      const scaled = i === 2 ? resizeNearest(f, slots[2].w, slots[2].h) : f;
      const b = contentBox(scaled);
      return { minX: b.x + slots[i].x + shiftX, minY: b.y + slots[i].y + shiftY, maxX: b.x + b.w - 1 + slots[i].x + shiftX, maxY: b.y + b.h - 1 + slots[i].y + shiftY };
    })
  );
  const crop = cropBounds(boxes, canvasW, canvasH);
  assert.deepEqual([seq.content.width, seq.content.height], [crop.cropW, crop.cropH]);
  assert.deepEqual([seq.layout.frameW, seq.layout.frameH], [crop.cropW, crop.cropH]);

  // The transitions don't jump: the last frame of one and the first of the
  // next are the same picture in the same place.
  assert.ok(same(seq.frames[0][3], seq.frames[1][0]), "walk -> jump");
  const [a, b] = [contentBox(seq.frames[1][4]), contentBox(seq.frames[2][0])];
  assert.ok(Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1 && Math.abs(a.h - b.h) <= 1, `jump -> small: ${JSON.stringify([a, b])}`);
  // Every frame keeps its own motion: the walk moves 5 px a frame.
  assert.deepEqual(
    seq.frames[0].map(f => contentBox(f).x),
    [0, 5, 10, 15].map(x => x + contentBox(seq.frames[0][0]).x)
  );
});

test("--align none and ground, and saved transitions", () => {
  const none = buildSequence([walk, jump], { art: "pixel", align: "none" });
  assert.deepEqual(none.transitions.map(t => [t.dx, t.dy, t.scale, t.method]), [[0, 0, 1, "none"]]);
  assert.deepEqual(none.slots[1], { x: 0, y: 0, w: 180, h: 220 });
  const ground = buildSequence([walk, jump], { art: "pixel", align: "ground" });
  assert.deepEqual(ground.transitions.map(t => [t.dx, t.dy, t.scale, t.method]), [[-15, 20, 1, "ground"]]);
  // A given transition is used as it is.
  const fixed = buildSequence([walk, jump], { art: "pixel", align: "auto", transitions: [{ dx: 7, dy: -3, scale: 1, confidence: Number.NaN, method: "ncc" }] });
  assert.deepEqual(fixed.slots[1], { x: 7, y: -3, w: 180, h: 220 });
});

test("frame size, size, vertical and horizontal place the content as paddedFrameLayout says", () => {
  const plain = buildSequence([walk, jump], { art: "pixel", align: "auto" });
  const { width: cw, height: ch } = plain.content;
  const placement = { size: 60, vertical: 4, horizontal: -6 };
  const seq = buildSequence([walk, jump], { art: "pixel", align: "auto", frameSize: { w: 200, h: 120 }, placement });
  const layout = paddedFrameLayout(cw, ch, 200, 120, placement);
  assert.deepEqual([seq.layout.frameW, seq.layout.frameH, seq.layout.drawH, seq.layout.vertical, seq.layout.horizontal], [200, 120, 60, 4, -6]);
  assert.deepEqual(seq.layout, layout);
  // The union of all frames fills the drawn box, 4 px above the bottom.
  const union = seq.frames.flat().reduce((acc, f) => ({ ...f, rgba: acc.rgba.map((v, i) => Math.max(v, f.rgba[i])) }));
  // (Nearest neighbour may skip a thin edge row: within a pixel.)
  const box = contentBox(union);
  [
    [box.x, layout.offsetX],
    [box.y, layout.offsetY],
    [box.x + box.w, layout.offsetX + layout.drawW],
    [box.y + box.h, layout.offsetY + layout.drawH]
  ].forEach(([got, want]) => assert.ok(Math.abs(got - want) <= 1, `${got} vs ${want}`));
  assert.ok(Math.abs(120 - (box.y + box.h) - 4) <= 1);
  // A frame size smaller than the content grows to fit it.
  const grown = buildSequence([walk, jump], { art: "pixel", align: "auto", frameSize: { w: 10, h: 10 } });
  assert.deepEqual([grown.layout.frameW, grown.layout.frameH], [cw, ch]);
});

test("one animation: cropped to its content; an empty frame keeps the whole canvas", () => {
  const seq = buildSequence([walk], { art: "smooth", align: "auto" });
  assert.deepEqual(seq.transitions, []);
  const hero = contentBox(HERO);
  assert.deepEqual([seq.content.width, seq.content.height], [hero.w + 15, hero.h]);
  const blank = { width: 160, height: 200, rgba: new Uint8Array(160 * 200 * 4) };
  const withBlank = buildSequence([[...walk, blank]], { art: "smooth", align: "auto" });
  assert.deepEqual([withBlank.content.width, withBlank.content.height], [160, 200], "as the web's bounds scan does");
});

test("golden output: the same sequence gives the same pixels", () => {
  // Pixels are ours (the web's canvas resampling differs by browser), so they
  // are pinned here: a change to them must be deliberate.
  const digest = art => {
    const h = crypto.createHash("sha256");
    const seq = buildSequence([walk, jump, small, walk], { art, align: "auto", frameSize: { h: 150 }, placement: { size: 100 } });
    h.update(JSON.stringify(seq.transitions.map(t => [t.dx, t.dy, t.scale.toFixed(6), t.method])));
    for (const f of seq.frames.flat()) h.update(f.rgba);
    return h.digest("hex");
  };
  assert.equal(digest("pixel"), "0a4ecdc56e062b007abde09165f33099f09ecdd5522fc372e90b8775b02a3c83");
  assert.equal(digest("smooth"), "8e03ad6c2a9c86ccdc48a022a120724a62bcda9f1500e513c9b5b1f1d6162010");
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

// Each animation as a Ludo-stamped sheet (via join), and the jump also as a
// folder of frames.
function inputs(dir) {
  const write = (name, frames, cols, fps) => {
    const folder = path.join(dir, `${name}-frames`);
    fs.mkdirSync(folder, { recursive: true });
    frames.forEach((f, k) => fs.writeFileSync(path.join(folder, `${name}-${k + 1}.png`), encodePng(f)));
    const r = cli(["toolbox", "sprite", "join", folder, "--cols", String(cols), "--fps", String(fps), "--name", name, "--out", "art", "--json"], dir);
    assert.equal(r.code, 0, r.err);
    return r.json.sheet;
  };
  return { walk: write("walk", walk, 2, 12), jump: write("jump", jump, 3, 12), small: write("small", small, 3, 8), jumpFrames: "jump-frames" };
}

const filesUnder = dir =>
  fs
    .readdirSync(dir, { recursive: true })
    .filter(f => fs.statSync(path.join(dir, f)).isFile())
    .sort();

test("toolbox sprite sequence: one sheet, engine files and a manifest that re-runs it exactly", () => {
  const dir = tmp();
  const s = inputs(dir);
  const r = cli(["toolbox", "sprite", "sequence", s.walk, s.jump, s.walk, "--name", "Hero Moves", "--art", "pixel", "--engine", "texturepacker", "--out", "out", "--json"], dir);
  assert.equal(r.code, 0, r.err);
  const j = r.json;
  assert.equal(j.sequence, path.join("out", "hero-moves"));
  assert.equal(j.frames, 13);
  assert.deepEqual(j.grid, sequenceGrid(13));
  assert.deepEqual(
    j.transitions.map(t => [t.from, t.to, t.dx, t.dy, t.scale, t.method]),
    [
      ["walk", "jump", -15, 20, 1, "ncc"],
      ["jump", "walk-1", 38, -44, 1, "ncc"]
    ]
  );
  assert.ok(j.transitions.every(t => t.confidence > 0.99));
  assert.deepEqual(filesUnder(path.join(dir, j.sequence)), ["hero-moves.json", "hero-moves.png", "sequence.json"]);
  const buf = fs.readFileSync(path.join(dir, j.sheet));
  const { image } = readPng(buf);
  assert.deepEqual([image.width, image.height], [j.frame_width * j.grid.cols, j.frame_height * j.grid.rows]);
  assert.deepEqual(JSON.parse(readText(buf)["ludo:grid"]), { cols: j.grid.cols, rows: j.grid.rows, frames: 13, fps: 12 });
  const atlas = JSON.parse(fs.readFileSync(path.join(dir, j.engine_files[0]), "utf8"));
  assert.deepEqual(Object.keys(atlas.animations), ["hero-moves"]);
  // The sheet's frames are the sequence's: walk's last is jump's first.
  const frames = sliceSheet(image, j.grid.cols, j.grid.rows, 13);
  assert.ok(same(frames[3], frames[4]));

  // The manifest re-runs it to the same bytes, without aligning again.
  const again = cli(["toolbox", "sprite", "sequence", "--manifest", j.manifest, "--engine", "texturepacker", "--out", "out", "--json"], dir);
  assert.equal(again.code, 0, again.err);
  assert.equal(again.json.sequence, path.join("out", "hero-moves-2"));
  assert.ok(again.json.transitions.every(t => t.saved));
  for (const f of filesUnder(path.join(dir, j.sequence))) {
    if (f === "sequence.json") continue;
    assert.equal(sha(fs.readFileSync(path.join(dir, again.json.sequence, f))), sha(fs.readFileSync(path.join(dir, j.sequence, f))), f);
  }
  const m = JSON.parse(fs.readFileSync(path.join(dir, j.manifest), "utf8"));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, again.json.manifest), "utf8")).transitions, m.transitions);
  assert.equal(m.animations[0].input, "../../art/walk.png", "inputs relative to the manifest");

  // A transition edited by hand is used.
  m.transitions[0].dx = -5;
  fs.writeFileSync(path.join(dir, j.manifest), JSON.stringify(m));
  const edited = cli(["toolbox", "sprite", "sequence", "--manifest", j.manifest, "--out", "out", "--json"], dir);
  assert.equal(edited.code, 0, edited.err);
  assert.equal(edited.json.transitions[0].dx, -5);
  assert.equal(edited.json.frame_width, j.frame_width + 10, "jump starts 10 px further right");

  // --align with --manifest aligns again; other flags override it.
  const realigned = cli(["toolbox", "sprite", "sequence", "--manifest", j.manifest, "--align", "auto", "--mode", "frames", "--out", "out", "--json"], dir);
  assert.equal(realigned.code, 0, realigned.err);
  assert.equal(realigned.json.transitions[0].dx, -15);
  assert.equal(realigned.json.transitions[0].saved, undefined);
  assert.equal(realigned.json.mode, "frames");

  // A changed input is noted.
  fs.copyFileSync(path.join(dir, s.jump), path.join(dir, s.walk));
  const changed = cli(["toolbox", "sprite", "sequence", "--manifest", j.manifest, "--out", "out", "--json"], dir);
  assert.equal(changed.code, 0, changed.err);
  assert.deepEqual(changed.json.warnings.slice(0, 1), [`${path.join("art", "walk.png")} changed since the manifest was written`]);
  assert.match(changed.json.warnings.at(-1), /--align auto to align again/);
});

test("toolbox sprite sequence: separate sheets, frames, labels and folders", () => {
  const dir = tmp();
  const s = inputs(dir);
  const sep = cli(["toolbox", "sprite", "sequence", s.walk, s.jumpFrames, s.small, "--mode", "separate", "--label", "1=stroll", "--fps", "small=10", "--out", "out", "--json"], dir);
  assert.equal(sep.code, 0, sep.err);
  assert.deepEqual(filesUnder(path.join(dir, sep.json.sequence)), ["01-stroll.png", "02-jump-frames.png", "03-small.png", "sequence.json"]);
  assert.deepEqual(
    sep.json.animations.map(a => [a.label, a.frames, a.fps]),
    [
      ["stroll", 4, 12],
      ["jump-frames", 5, 10],
      ["small", 3, 10]
    ]
  );
  for (const a of sep.json.animations) {
    const buf = fs.readFileSync(path.join(dir, a.sheet));
    const g = sequenceGrid(a.frames);
    assert.deepEqual(JSON.parse(readText(buf)["ludo:grid"]), { cols: g.cols, rows: g.rows, frames: a.frames, fps: a.fps });
    assert.deepEqual([readPng(buf).image.width, readPng(buf).image.height], [sep.json.frame_width * g.cols, sep.json.frame_height * g.rows]);
  }

  const frames = cli(["toolbox", "sprite", "sequence", s.walk, s.jump, "--mode", "frames", "--frame-size", "200x", "--vertical", "0", "--out", "out", "--json"], dir);
  assert.equal(frames.code, 0, frames.err);
  const list = filesUnder(path.join(dir, frames.json.sequence));
  assert.deepEqual(list, [...Array.from({ length: 9 }, (_, k) => `frame_${String(k).padStart(4, "0")}.png`), "sequence.json"]);
  assert.equal(frames.json.frame_width, 200);
  assert.equal(frames.json.vertical, 0);
  const f = readPng(fs.readFileSync(path.join(dir, frames.json.sequence, "frame_0000.png"))).image;
  assert.equal(f.width, 200);
});

test("toolbox sprite sequence: usage errors", () => {
  const dir = tmp();
  const s = inputs(dir);
  const fails = (args, code, pattern) => {
    const r = cli(["toolbox", "sprite", "sequence", ...args, "--json"], dir);
    assert.equal(r.code, code, `${args.join(" ")}: ${r.err}`);
    if (pattern) assert.match(r.err, pattern);
  };
  fails([], 2, /Usage: ludo toolbox sprite sequence/);
  fails([s.walk, "--mode", "sheets"], 2, /--mode is single, separate or frames/);
  fails([s.walk, "--align", "ncc"], 2, /--align is auto, ground or none/);
  fails([s.walk, "--size", "0"], 2, /--size takes whole pixels/);
  fails([s.walk, "--vertical", "-1"], 2, /--vertical takes whole pixels, 0 or more/);
  fails([s.walk, "--horizontal", "1.5"], 2, /--horizontal takes whole pixels/);
  fails([s.walk, "--frame-size", "5000x"], 2, /--frame-size goes up to 4096/);
  fails([s.walk, s.walk, "--label", "walk=a"], 2, /walk is animations 1 and 2; pick one by its number/);
  fails([s.walk, "--manifest", "x.json"], 2, /not both/);
  fs.writeFileSync(path.join(dir, "pack.json"), JSON.stringify({ ludo: "toolbox sprite pack", version: 1, animations: [{ input: "a.png", grid: { cols: 1, rows: 1, frames: 1 } }] }));
  fails(["--manifest", "pack.json"], 12, /not a sequence manifest/);
  fs.writeFileSync(path.join(dir, "bad.json"), JSON.stringify({ ludo: "toolbox sprite sequence", version: 1, animations: [{ input: s.walk, grid: { cols: 2, rows: 2, frames: 4 } }, { input: s.walk, grid: { cols: 2, rows: 2, frames: 4 } }], transitions: [{ dx: 1, dy: 2, scale: 0 }] }));
  fails(["--manifest", "bad.json"], 12, /transition 1 needs/);
});
