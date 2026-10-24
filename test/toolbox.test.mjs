import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseToolArgv } from "../dist/toolbox/index.js";
import { CONFIDENT, guessGrid } from "../dist/toolbox/grid.js";
import { encodePng, readPng, withText } from "../dist/tty/png.js";
import { readGrid } from "../dist/tty/preview.js";
import { applyFrameOps, parseFrameList, parseHolds } from "../dist/toolbox/frames.js";
import { analyseLoop, frameDifferences } from "../dist/toolbox/loop.js";
import { backgroundOf } from "../dist/toolbox/grid.js";
import { contentBox, emptiness, extrude, flip, pad, rotate, scaleDown, scaleUp } from "../dist/toolbox/pixels.js";
import { crop } from "../dist/toolbox/sheet.js";
import { textureAtlas } from "../dist/tty/texturepacker.js";
import { parseArgv } from "../dist/args.js";
import { EXIT } from "../dist/errors.js";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

// A server that accepts connections and never answers: an API that hangs.
let blackhole;
// One that records the usage events it is sent.
let collector;
const events = [];
before(async () => {
  blackhole = net.createServer(() => {});
  await new Promise(resolve => blackhole.listen(0, "127.0.0.1", resolve));
  collector = http.createServer((req, res) => {
    let body = "";
    req.on("data", d => (body += d));
    req.on("end", () => {
      if (req.url === "/api/cli/events") events.push(...JSON.parse(body).events);
      res.end("{}");
    });
  });
  await new Promise(resolve => collector.listen(0, "127.0.0.1", resolve));
});
after(() => {
  blackhole.close();
  collector.close();
});

// RGB under a fully transparent pixel is not kept; compare without it.
function canonical(rgba) {
  const out = Buffer.from(rgba);
  for (let i = 0; i < out.length; i += 4) if (out[i + 3] === 0) out.fill(0, i, i + 3);
  return out;
}

function run(args, extraEnv = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-toolbox-test-"));
  // A spec file that would crash the CLI if anything tried to load it.
  const badSpec = path.join(cwd, "spec.json");
  fs.writeFileSync(badSpec, "{ not json");
  const started = Date.now();
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: {
        ...process.env,
        LUDO_SPEC: badSpec,
        LUDO_API_URL: `http://127.0.0.1:${blackhole.address().port}`,
        LUDO_API_KEY: "",
        LUDO_CONFIG_DIR: path.join(cwd, ".config"),
        LUDO_CACHE_DIR: path.join(cwd, ".cache"),
        LUDO_TELEMETRY: "0",
        CLAUDECODE: "",
        CLAUDE_CODE_ENTRYPOINT: "",
        ...extraEnv
      }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", d => (stdout += d));
    child.stderr.on("data", d => (stderr += d));
    child.on("close", code => resolve({ code, stdout, stderr, cwd, ms: Date.now() - started }));
  });
}

test("ludo toolbox runs without the API spec, an API key or the network", async () => {
  const help = await run(["toolbox", "--help"]);
  assert.equal(help.code, EXIT.OK, help.stderr);
  assert.match(help.stdout, /offline, with no account and no credits/);
  const bare = await run(["toolbox"]);
  assert.equal(bare.code, EXIT.USAGE);
});

test("an API that hangs costs a toolbox command at most the telemetry timeout", async () => {
  const quiet = await run(["toolbox", "--help"]);
  const hanging = await run(["toolbox", "--help"], { LUDO_TELEMETRY: "", DO_NOT_TRACK: "" });
  assert.equal(hanging.code, EXIT.OK, hanging.stderr);
  // The send gives up after 1 s; the rest is slack for slow CI machines.
  assert.ok(hanging.ms - quiet.ms < 2000, `${hanging.ms} ms vs ${quiet.ms} ms`);
});

test("an unknown group is a usage error that lists the groups", async () => {
  const { code, stderr } = await run(["toolbox", "nope"]);
  assert.equal(code, EXIT.USAGE);
  assert.match(stderr, /Unknown toolbox group: nope/);
});

test("toolbox runs are counted as toolbox in usage telemetry", async () => {
  const from = events.length;
  const { code } = await run(["toolbox", "--help"], { LUDO_TELEMETRY: "", DO_NOT_TRACK: "", LUDO_API_URL: `http://127.0.0.1:${collector.address().port}` });
  assert.equal(code, EXIT.OK);
  assert.equal(events.slice(from)[0]?.command, "toolbox");
});

test("tool flags keep the positionals in order and reject what the tool does not know", () => {
  const tool = {
    group: "sprite",
    name: "join",
    flags: [
      { flag: "--cols", value: "n", description: "" },
      { flag: "--pingpong", description: "" }
    ]
  };
  const argv = ["--json", "toolbox", "sprite", "join", "--pingpong", "a.png", "--out", "dir", "b.png", "--cols=3", "c.png"];
  assert.equal(parseArgv(argv).globals.out, "dir");
  const call = parseToolArgv(argv, tool);
  assert.deepEqual(call.args, ["a.png", "b.png", "c.png"]);
  assert.deepEqual([...call.flags], [["--pingpong", true], ["--cols", "3"]]);
  assert.throws(() => parseToolArgv(["toolbox", "sprite", "join", "--grid", "2x2"], tool), /Unknown flag .*--grid/);
  assert.throws(() => parseToolArgv(["toolbox", "sprite", "join", "--cols"], tool), /--cols needs a value/);
  assert.throws(() => parseToolArgv(["toolbox", "sprite", "join", "--pingpong=yes"], tool), /does not take a value/);
});

// ---- Synthetic sheets: a figure that walks, drawn with soft edges ----

// A pixel's coverage by the figure in frame t of n, 0..1 per shape, as RGBA.
function figurePixel(u, v, t, n) {
  // u, v in 0..1 across the sprite's box.
  const phase = (2 * Math.PI * t) / n;
  const shapes = [
    // [inside(u, v), colour]
    [(x, y) => ((x - 0.5) / 0.2) ** 2 + ((y - 0.5) / 0.22) ** 2 <= 1, [200, 60, 40]], // body
    [(x, y) => (x - 0.5 - 0.04 * Math.sin(phase)) ** 2 + (y - 0.18) ** 2 <= 0.11 ** 2, [240, 200, 160]], // head
    ...[-1, 1].map(side => {
      const a = side * 0.45 * Math.sin(phase);
      const [hx, hy] = [0.5 + side * 0.08, 0.68];
      const [fx, fy] = [hx + Math.sin(a) * 0.28, hy + Math.cos(a) * 0.28];
      const seg = (x, y) => {
        const [dx, dy] = [fx - hx, fy - hy];
        const k = Math.max(0, Math.min(1, ((x - hx) * dx + (y - hy) * dy) / (dx * dx + dy * dy)));
        return Math.hypot(x - hx - k * dx, y - hy - k * dy) <= 0.05;
      };
      return [seg, [60, 60, 140]];
    })
  ];
  // 3 x 3 supersampling for anti-aliased edges.
  let r = 0, g = 0, b = 0, a = 0;
  for (let sy = 0; sy < 3; sy++) {
    for (let sx = 0; sx < 3; sx++) {
      const hit = shapes.find(([inside]) => inside(u + (sx - 1) / 300, v + (sy - 1) / 300));
      if (hit) (r += hit[1][0]), (g += hit[1][1]), (b += hit[1][2]), a++;
    }
  }
  return a ? [Math.round(r / a), Math.round(g / a), Math.round(b / a), Math.round((a / 9) * 255)] : [0, 0, 0, 0];
}

function makeSheet({ cols, rows, frames = cols * rows, cw = 48, ch = 64, margin = 0.12, background, extraW = 0 }) {
  const width = cols * cw + extraW;
  const height = rows * ch;
  const rgba = new Uint8Array(width * height * 4);
  for (let f = 0; f < cols * rows; f++) {
    const x0 = Math.round(((f % cols) * width) / cols);
    const y0 = Math.floor(f / cols) * ch;
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const u = (x / cw - margin) / (1 - 2 * margin);
        const v = (y / ch - margin) / (1 - 2 * margin);
        const px = f < frames && u >= 0 && u <= 1 && v >= 0 && v <= 1 ? figurePixel(u, v, f, frames) : [0, 0, 0, 0];
        rgba.set(px, ((y0 + y) * width + x0 + x) * 4);
      }
    }
  }
  if (background) {
    for (let i = 0; i < rgba.length; i += 4) {
      const a = rgba[i + 3] / 255;
      for (let k = 0; k < 3; k++) rgba[i + k] = Math.round(rgba[i + k] * a + background[k] * (1 - a));
      rgba[i + 3] = 255;
    }
  }
  return { width, height, rgba };
}

test("detects the grid of sheets with and without padding cells, on clear and solid backgrounds", () => {
  const cases = [
    { cols: 4, rows: 4 },
    { cols: 6, rows: 6, cw: 40, ch: 40 },
    { cols: 8, rows: 2 },
    { cols: 5, rows: 3, frames: 13 },
    { cols: 6, rows: 1 },
    { cols: 12, rows: 1, cw: 32, ch: 32 },
    { cols: 4, rows: 3, frames: 10, background: [40, 90, 160] },
    { cols: 6, rows: 2, background: [255, 255, 255] },
    { cols: 6, rows: 2, extraW: 3 } // does not divide evenly
  ];
  for (const c of cases) {
    const g = guessGrid(makeSheet(c));
    const want = `${c.cols}x${c.rows}/${c.frames ?? c.cols * c.rows}`;
    assert.equal(`${g.cols}x${g.rows}/${g.frames}`, want, JSON.stringify(c));
    assert.ok(g.confidence >= CONFIDENT, `${want}: confidence ${g.confidence}`);
  }
});

test("frames that barely move are not mistaken for half as many or twice as many", () => {
  const sheet = makeSheet({ cols: 6, rows: 1, frames: 6 });
  // Every frame the same pose: an idle that does not move at all.
  const first = sheetCrop(sheet, 0, 0, 48, 64);
  for (let c = 1; c < 6; c++) pasteInto(sheet, first, c * 48, 0);
  const g = guessGrid(sheet);
  assert.equal(`${g.cols}x${g.rows}`, "6x1");
  assert.ok(g.confidence >= CONFIDENT);
});

test("refuses to guess on a packed atlas or a single picture", () => {
  // Differently sized figures scattered without a grid.
  const r = (seed => () => ((seed = (seed * 16807) % 2147483647) / 2147483647))(9);
  const atlas = { width: 400, height: 300, rgba: new Uint8Array(400 * 300 * 4) };
  for (let i = 0; i < 9; i++) {
    const w = 24 + Math.floor(r() * 70);
    const h = 30 + Math.floor(r() * 80);
    const sprite = makeSheet({ cols: 1, rows: 1, cw: w, ch: h, margin: 0.02 });
    pasteInto(atlas, sprite, Math.floor(r() * (400 - w)), Math.floor(r() * (300 - h)));
  }
  assert.ok(guessGrid(atlas).confidence < CONFIDENT);
  assert.ok(guessGrid(makeSheet({ cols: 1, rows: 1, cw: 200, ch: 200 })).confidence < CONFIDENT);
});

function sheetCrop(img, x0, y0, w, h) {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) rgba.set(img.rgba.subarray(((y0 + y) * img.width + x0) * 4, ((y0 + y) * img.width + x0 + w) * 4), y * w * 4);
  return { width: w, height: h, rgba };
}

function pasteInto(dst, src, x0, y0) {
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const s = (y * src.width + x) * 4;
      if (src.rgba[s + 3]) dst.rgba.set(src.rgba.subarray(s, s + 4), ((y0 + y) * dst.width + x0 + x) * 4);
    }
  }
}

// ---- ludo toolbox sprite slice ----

function writeSheet(dir, name, img, grid) {
  let buf = encodePng(img);
  if (grid) buf = withText(buf, "ludo:grid", JSON.stringify(grid));
  const file = path.join(dir, name);
  fs.writeFileSync(file, buf);
  return file;
}

test("slice cuts a stamped sheet into frames that match the sheet pixel for pixel", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-slice-"));
  const sheet = makeSheet({ cols: 4, rows: 2, frames: 7 });
  const file = writeSheet(dir, "walk.png", sheet, { cols: 4, rows: 2, frames: 7, fps: 12 });
  const { code, stdout, stderr } = await run(["toolbox", "sprite", "slice", file, "--out", path.join(dir, "out"), "--json"]);
  assert.equal(code, EXIT.OK, stderr);
  const out = JSON.parse(stdout);
  assert.equal(out.grid_from, "stamp");
  assert.deepEqual(out.grid, { cols: 4, rows: 2, frames: 7, frame_width: 48, frame_height: 64, fps: 12 });
  assert.equal(out.files.length, 7);
  assert.match(out.files[6], /walk-07\.png$/);
  out.files.forEach((f, i) => {
    const frame = readPng(fs.readFileSync(path.resolve(f))).image;
    const want = sheetCrop(sheet, (i % 4) * 48, Math.floor(i / 4) * 64, 48, 64);
    assert.deepEqual(Buffer.from(frame.rgba), Buffer.from(canonical(want.rgba)), `frame ${i + 1}`);
  });
  assert.equal(out.hint.command.startsWith("ludo sprite animate"), true);
});

test("slice detects an unstamped sheet, and --grid and --frames override", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-slice-"));
  const file = writeSheet(dir, "run.png", makeSheet({ cols: 6, rows: 1 }));
  const out = path.join(dir, "out");
  const detected = JSON.parse((await run(["toolbox", "sprite", "slice", file, "--out", out])).stdout);
  assert.equal(detected.grid_from, "detected");
  assert.equal(detected.files.length, 6);
  assert.ok(detected.confidence >= CONFIDENT);
  const forced = JSON.parse((await run(["toolbox", "sprite", "slice", file, "--grid", "3x1", "--frames", "2", "--out", out])).stdout);
  assert.deepEqual([forced.grid_from, forced.grid.frame_width, forced.files.length], ["flag", 96, 2]);
  // The first run's folder is never overwritten.
  assert.notEqual(forced.dir, detected.dir);
  assert.match(forced.dir, /run-2$/);
});

test("slice refuses a sheet whose grid it cannot tell, with exit code 12 and its best guess", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-slice-"));
  const file = writeSheet(dir, "one.png", makeSheet({ cols: 1, rows: 1, cw: 120, ch: 120 }));
  const { code, stdout, stderr } = await run(["toolbox", "sprite", "slice", file, "--out", path.join(dir, "out")]);
  assert.equal(code, EXIT.BAD_INPUT);
  assert.match(stderr, /Could not tell the grid/);
  assert.match(stderr, /--grid/);
  assert.ok(JSON.parse(stdout).error.details.guess);
  assert.ok(!fs.existsSync(path.join(dir, "out")));
});

test("slice reports unreadable input and impossible flags clearly", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-slice-"));
  const bad = path.join(dir, "bad.png");
  fs.writeFileSync(bad, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("garbage")]));
  const unreadable = await run(["toolbox", "sprite", "slice", bad]);
  assert.equal(unreadable.code, EXIT.BAD_INPUT);
  assert.match(unreadable.stderr, /Cannot read .*bad\.png/);
  assert.equal((await run(["toolbox", "sprite", "slice", path.join(dir, "missing.png")])).code, EXIT.USAGE);
  const sheet = writeSheet(dir, "s.png", makeSheet({ cols: 2, rows: 1 }));
  assert.match((await run(["toolbox", "sprite", "slice", sheet, "--grid", "4"])).stderr, /--grid takes columns x rows/);
  assert.match((await run(["toolbox", "sprite", "slice", sheet, "--grid", "2x1", "--frames", "3"])).stderr, /more than the 2 cells/);
});

// ---- ludo toolbox sprite join ----

test("join puts sliced frames back into the very same sheet, and stamps its grid", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-join-"));
  const sheet = makeSheet({ cols: 5, rows: 2 });
  const file = writeSheet(dir, "hop.png", sheet, { cols: 5, rows: 2, frames: 10, fps: 8 });
  const out = path.join(dir, "out");
  const sliced = JSON.parse((await run(["toolbox", "sprite", "slice", file, "--out", out])).stdout);
  const joined = await run(["toolbox", "sprite", "join", path.resolve(sliced.dir), "--cols", "5", "--fps", "8", "--out", out]);
  assert.equal(joined.code, EXIT.OK, joined.stderr);
  const res = JSON.parse(joined.stdout);
  assert.match(res.sheet, /hop\.png$/);
  assert.deepEqual(res.grid, { cols: 5, rows: 2, frames: 10, frame_width: 48, frame_height: 64, fps: 8 });
  const buf = fs.readFileSync(path.resolve(res.sheet));
  assert.deepEqual(Buffer.from(readPng(buf).image.rgba), canonical(sheet.rgba));
  assert.deepEqual(readGrid(buf), { cols: 5, rows: 2, frames: 10, fps: 8 });
});

test("join takes folders in natural order, centres smaller frames and never overwrites", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-join-"));
  const frames = path.join(dir, "frames");
  fs.mkdirSync(frames);
  const solid = (w, h, v) => ({ width: w, height: h, rgba: new Uint8Array(w * h * 4).fill(v) });
  // Named so that plain sorting would put 10 before 2.
  for (const [i, img] of [solid(4, 4, 10), solid(4, 4, 20), solid(2, 2, 30)].entries()) {
    fs.writeFileSync(path.join(frames, `f-${[1, 2, 10][i]}.png`), encodePng(img));
  }
  const out = path.join(dir, "out");
  const res = JSON.parse((await run(["toolbox", "sprite", "join", frames, "--cols", "3", "--out", out])).stdout);
  assert.equal(res.centred, true);
  const { image } = readPng(fs.readFileSync(path.resolve(res.sheet)));
  assert.deepEqual([image.width, image.height], [12, 4]);
  const px = (x, y) => image.rgba[(y * 12 + x) * 4];
  assert.deepEqual([px(0, 0), px(4, 0), px(8, 0), px(9, 1), px(8, 0)], [10, 20, 0, 30, 0]);
  const again = JSON.parse((await run(["toolbox", "sprite", "join", frames, "--out", out])).stdout);
  assert.notEqual(again.sheet, res.sheet);
  assert.match(again.sheet, /f-2\.png$/);
});

// ---- ludo toolbox sprite frames ----

test("frame edits apply in a fixed order on the original numbers", () => {
  assert.deepEqual(parseFrameList("1,3,5-7,9-8", 9, "--x"), [1, 3, 5, 6, 7, 9, 8]);
  assert.throws(() => parseFrameList("0", 9, "--drop"), /frame 0 does not exist/);
  assert.throws(() => parseFrameList("2-", 9, "--drop"), /takes frame numbers/);
  assert.deepEqual([...parseHolds("4x3, 9x2", 9, "--hold")], [[4, 3], [9, 2]]);
  assert.deepEqual(applyFrameOps(5, { drop: [2] }), [1, 3, 4, 5]);
  assert.deepEqual(applyFrameOps(5, { reverse: true, drop: [1] }), [5, 4, 3, 2]);
  assert.deepEqual(applyFrameOps(4, { pingpong: true }), [1, 2, 3, 4, 3, 2]);
  assert.deepEqual(applyFrameOps(4, { pingpong: true, hold: new Map([[4, 3]]) }), [1, 2, 3, 4, 4, 4, 3, 2]);
  assert.deepEqual(applyFrameOps(6, { order: [6, 1, 1], drop: [6] }), [1, 1]);
});

test("frames rebuilds the sheet in the new order, and --in-place replaces it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-frames-"));
  // Frame i is filled with the value 10 * i, so the result's order can be read back.
  const cells = [1, 2, 3, 4].map(i => ({ width: 4, height: 4, rgba: new Uint8Array(64).fill(10 * i) }));
  const sheet = { width: 16, height: 4, rgba: new Uint8Array(16 * 4 * 4) };
  cells.forEach((c, i) => pasteInto(sheet, c, i * 4, 0));
  const file = writeSheet(dir, "s.png", sheet, { cols: 4, rows: 1, frames: 4, fps: 12 });
  const values = buf => {
    const { image } = readPng(buf);
    const grid = readGrid(buf);
    return Array.from({ length: grid.frames }, (_, f) => image.rgba[(Math.floor(f / grid.cols) * 4 * image.width + (f % grid.cols) * 4) * 4] / 10);
  };
  const res = await run(["toolbox", "sprite", "frames", file, "--hold", "2x2", "--drop", "4", "--pingpong", "--out", path.join(dir, "out")]);
  assert.equal(res.code, EXIT.OK, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.order, [1, 2, 2, 3, 2, 2]);
  assert.deepEqual(values(fs.readFileSync(path.resolve(out.sheet))), [1, 2, 2, 3, 2, 2]);
  assert.equal(out.grid.fps, 12);

  const inPlace = await run(["toolbox", "sprite", "frames", file, "--reverse", "--in-place"]);
  assert.equal(inPlace.code, EXIT.OK, inPlace.stderr);
  assert.deepEqual(values(fs.readFileSync(file)), [4, 3, 2, 1]);
  assert.equal((await run(["toolbox", "sprite", "frames", file])).code, EXIT.USAGE);
  assert.match((await run(["toolbox", "sprite", "frames", file, "--drop", "1-4"])).stderr, /No frames left/);
});

// ---- ludo toolbox sprite loop ----

// A body, a ball on a wide orbit and a leg swinging, at phase t of an n-frame
// cycle. Unlike the walker above it is never the same pose twice in a cycle,
// and it does not play the same backwards, so seams and mirrors are known.
function orbitFrame(t, n, background) {
  const [w, h] = [48, 64];
  const rgba = new Uint8Array(w * h * 4);
  const ph = (2 * Math.PI * t) / n;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [u, v] = [x / w, y / h];
      let c = background;
      if (((u - 0.5) / 0.15) ** 2 + ((v - 0.55) / 0.2) ** 2 <= 1) c = [200, 60, 40];
      if (Math.abs(u - (0.5 + 0.2 * Math.cos(ph))) < 0.06 && v > 0.75) c = [60, 60, 140];
      if ((u - 0.5 - 0.32 * Math.cos(ph)) ** 2 + (v - 0.4 - 0.28 * Math.sin(ph)) ** 2 <= 0.14 ** 2) c = [40, 180, 80];
      if (c) rgba.set([...c, 255], (y * w + x) * 4);
    }
  }
  return { width: w, height: h, rgba };
}

const range = (a, b) => Array.from({ length: b - a }, (_, i) => a + i);

function loopOf(phases, n, background) {
  const frames = phases.map(t => orbitFrame(t, n, background));
  return analyseLoop(frameDifferences(frames, backgroundOf(frames[0])));
}

test("loop analysis finds the seam and the best loop on sheets with known answers", () => {
  for (const background of [undefined, [30, 120, 90]]) {
    const at = background ? "opaque" : "clear";
    const perfect = loopOf(range(0, 8), 8, background);
    assert.equal(perfect.seam.verdict, "smooth", at);
    assert.deepEqual([perfect.best.start, perfect.best.end], [1, 8], at);
    assert.equal(perfect.mirrored, false, at);

    // The last frame is the first again: the loop shows that pose twice.
    const repeat = loopOf(range(0, 9), 8, background);
    assert.deepEqual([repeat.seam.verdict, repeat.seam.repeats], ["repeat", 1], at);
    assert.deepEqual([repeat.best.start, repeat.best.end], [1, 8], at);

    // A glitched last frame, from the middle of the cycle.
    const glitch = loopOf([...range(0, 8), 4], 8, background);
    assert.equal(glitch.seam.verdict, "jump", at);
    assert.deepEqual(glitch.jumps, [9], at);
    assert.deepEqual([glitch.best.start, glitch.best.end], [1, 8], at);

    // Three frames past the loop point: they repeat the first three.
    const over = loopOf(range(0, 19), 16, background);
    assert.deepEqual([over.seam.verdict, over.seam.repeats], ["repeat", 3], at);
    assert.deepEqual([over.best.start, over.best.end], [1, 16], at);

    // Half a cycle has no loop inside it.
    const half = loopOf(range(0, 4), 8, background);
    assert.equal(half.seam.verdict, "jump", at);
    assert.equal(half.best, undefined, at);
  }
});

test("a sheet that already loops is left whole unless a loop inside it is clearly better", () => {
  // Two whole cycles: it loops, and both cycles stay.
  const twice = loopOf(range(0, 16), 8);
  assert.equal(twice.seam.verdict, "smooth");
  assert.deepEqual([twice.best.start, twice.best.end], [1, 16]);
  assert.equal(loopOf(range(0, 24), 8).seam.verdict, "smooth");
  // Two cycles and two frames too many.
  assert.deepEqual(loopOf(range(0, 18), 8).seam.repeats, 2);
  // Two frames past the loop point: the seam is an ordinary-sized step, but
  // backwards, and two poses show twice.
  const drift = loopOf(range(0, 10), 8);
  assert.deepEqual([drift.seam.verdict, drift.seam.repeats], ["repeat", 2]);
  assert.deepEqual([drift.best.start, drift.best.end, drift.best.cost], [1, 8, 0]);
  // Starting mid-cycle: whichever loop it picks must close cleanly.
  const late = loopOf([5.3, 6.6, ...range(0, 8)], 8);
  assert.equal(late.seam.verdict, "jump");
  assert.ok(late.best.cost <= 0.5 && late.best.frames >= 5, JSON.stringify(late.best));
});

test("held frames are not steps, a ping-pong is mirrored, and a still sheet is static", () => {
  const held = loopOf([0, 1, 2, 3, 3, 3, 4, 5, 6, 7], 8);
  assert.deepEqual(held.holds, [5, 6]);
  assert.equal(held.seam.verdict, "smooth");
  // The held steps are 0, and the rest are measured against the moving ones.
  assert.deepEqual(held.steps.slice(3, 5), [0, 0]);
  assert.ok(Math.abs(held.seam.ratio - 1) < 0.2, String(held.seam.ratio));

  const pingpong = loopOf([0, 1, 2, 3, 4, 3, 2, 1], 8);
  assert.equal(pingpong.mirrored, true);
  assert.equal(pingpong.seam.verdict, "smooth");

  const still = loopOf([2, 2, 2, 2], 8);
  assert.equal(still.seam.verdict, "static");
  assert.deepEqual([still.holds, still.jumps], [[], []]);

  // The matrix: symmetric, 0 on the diagonal, about 1 for one step.
  const { matrix } = loopOf(range(0, 8), 8);
  assert.equal(matrix.length, 8);
  for (let i = 0; i < 8; i++) {
    assert.equal(matrix[i][i], 0);
    for (let j = 0; j < 8; j++) assert.equal(matrix[i][j], matrix[j][i]);
  }
  assert.ok(matrix[0][1] > 0.7 && matrix[0][1] < 1.3, String(matrix[0][1]));
  assert.ok(matrix[0][4] > 1.5, `half a cycle apart: ${matrix[0][4]}`);
});

function strip(frames, cols = frames.length) {
  const sheet = { width: 48 * cols, height: 64 * Math.ceil(frames.length / cols), rgba: new Uint8Array(48 * cols * 64 * Math.ceil(frames.length / cols) * 4) };
  frames.forEach((f, i) => pasteInto(sheet, f, (i % cols) * 48, Math.floor(i / cols) * 64));
  return sheet;
}

test("loop reports a sheet's seam, and --apply saves it trimmed to its best loop", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-loop-"));
  const frames = range(0, 9).map(t => orbitFrame(t, 8));
  const file = writeSheet(dir, "spin.png", strip(frames, 3), { cols: 3, rows: 3, frames: 9, fps: 12 });
  const out = path.join(dir, "out");

  const checked = await run(["toolbox", "sprite", "loop", file, "--out", out]);
  assert.equal(checked.code, EXIT.OK, checked.stderr);
  const report = JSON.parse(checked.stdout);
  assert.equal(report.seam.verdict, "repeat");
  assert.deepEqual([report.best.start, report.best.end], [1, 8]);
  assert.equal(report.matrix.length, 9);
  assert.equal(report.hint.command, `ludo toolbox sprite loop ${file} --apply`);
  assert.ok(!fs.existsSync(out), "checking writes nothing");

  const applied = await run(["toolbox", "sprite", "loop", file, "--apply", "--out", out]);
  assert.equal(applied.code, EXIT.OK, applied.stderr);
  const res = JSON.parse(applied.stdout);
  const buf = fs.readFileSync(path.resolve(res.applied));
  assert.deepEqual(readGrid(buf), { cols: 3, rows: 3, frames: 8, fps: 12 });
  assert.deepEqual(Buffer.from(readPng(buf).image.rgba), canonical(strip(frames.slice(0, 8), 3).rgba));

  // The trimmed sheet loops: --apply has nothing left to do.
  const again = await run(["toolbox", "sprite", "loop", path.resolve(res.applied), "--apply", "--out", out]);
  assert.equal(again.code, EXIT.OK, again.stderr);
  const second = JSON.parse(again.stdout);
  assert.equal(second.seam.verdict, "smooth");
  assert.equal(second.applied, null);
  assert.equal(second.hint.command.startsWith("ludo preview"), true);
});

test("loop --apply on a sheet with no loop inside exits 12, and --in-place replaces the input", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-loop-"));
  const half = writeSheet(dir, "half.png", strip(range(0, 4).map(t => orbitFrame(t, 8))), { cols: 4, rows: 1, frames: 4, fps: 10 });
  const refused = await run(["toolbox", "sprite", "loop", half, "--apply", "--out", path.join(dir, "out")]);
  assert.equal(refused.code, EXIT.BAD_INPUT);
  assert.match(refused.stderr, /No run of frames .* loops cleanly/);
  assert.match(refused.stderr, /sprite adjust/);
  const told = await run(["toolbox", "sprite", "loop", half]);
  assert.equal(told.code, EXIT.OK, told.stderr);
  const report = JSON.parse(told.stdout);
  assert.deepEqual([report.seam.verdict, report.best], ["jump", null]);
  assert.match(report.hint.command, /^ludo sprite adjust .* --loop$/);

  const glitch = writeSheet(dir, "glitch.png", strip([...range(0, 8), 4].map(t => orbitFrame(t, 8)), 9), { cols: 9, rows: 1, frames: 9, fps: 10 });
  assert.equal((await run(["toolbox", "sprite", "loop", glitch, "--in-place"])).code, EXIT.USAGE);
  const inPlace = await run(["toolbox", "sprite", "loop", glitch, "--apply", "--in-place", "--cols", "4"]);
  assert.equal(inPlace.code, EXIT.OK, inPlace.stderr);
  assert.deepEqual(readGrid(fs.readFileSync(glitch)), { cols: 4, rows: 2, frames: 8, fps: 10 });
  assert.match((await run(["toolbox", "sprite", "loop", glitch, "--min-frames", "9"])).stderr, /more than the sheet's 8 frames/);
});

test("a ping-pong made by sprite frames is reported as mirrored, with a smooth seam", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-loop-"));
  const file = writeSheet(dir, "swing.png", strip(range(0, 5).map(t => orbitFrame(t, 8))), { cols: 5, rows: 1, frames: 5, fps: 10 });
  const out = path.join(dir, "out");
  const made = JSON.parse((await run(["toolbox", "sprite", "frames", file, "--pingpong", "--out", out])).stdout);
  const report = JSON.parse((await run(["toolbox", "sprite", "loop", path.resolve(made.sheet)])).stdout);
  assert.equal(report.mirrored, true);
  assert.equal(report.seam.verdict, "smooth");
});

// ---- ludo toolbox image ----

// Random pixels, each channel 0-255, with a clear border of the given width.
function noise(w, h, border = 0, seed = 7) {
  const rnd = (s => () => ((s = (s * 16807) % 2147483647) / 2147483647))(seed);
  const rgba = new Uint8Array(w * h * 4);
  for (let y = border; y < h - border; y++) for (let x = border; x < w - border; x++) for (let k = 0; k < 4; k++) rgba[(y * w + x) * 4 + k] = Math.floor(rnd() * 256);
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] === 0 && rgba[i - 1] + rgba[i - 2] + rgba[i - 3]) rgba[i] = 1;
  return { width: w, height: h, rgba };
}

const same = (a, b) => a.width === b.width && a.height === b.height && Buffer.from(a.rgba).equals(Buffer.from(b.rgba));

test("pixel edits undo each other exactly", () => {
  const img = noise(13, 7);
  assert.ok(same(scaleDown(scaleUp(img, 3), 3), img), "scale 3x and back");
  assert.ok(same(flip(flip(img, "horizontal"), "horizontal"), img), "two horizontal flips");
  assert.ok(same(flip(flip(img, "vertical"), "vertical"), img), "two vertical flips");
  assert.ok(same(rotate(rotate(img, 1), 3), img), "90 then -90");
  assert.ok(same(rotate(rotate(rotate(rotate(img, 1), 1), 1), 1), img), "four quarter turns");
  assert.ok(same(rotate(img, 2), flip(flip(img, "horizontal"), "vertical")), "180 is both flips");
  const r = rotate(img, 1);
  assert.deepEqual([r.width, r.height], [7, 13]);
  // Clockwise: the top-left pixel ends up top-right.
  assert.deepEqual([...r.rgba.subarray((0 * 7 + 6) * 4, (0 * 7 + 6) * 4 + 4)], [...img.rgba.subarray(0, 4)]);
  const p = pad(img, { top: 1, right: 2, bottom: 3, left: 4 });
  assert.deepEqual([p.width, p.height], [19, 11]);
  const box = contentBox([p], emptiness([p]));
  assert.deepEqual(box, { x: 4, y: 1, w: 13, h: 7 });
  assert.ok(same(scaleDown(scaleUp(img, 2), 2), img));
  const d = scaleDown(noise(9, 9), 2);
  assert.deepEqual([d.width, d.height], [4, 4]);
});

test("extrude repeats the edge pixels outward", () => {
  const img = { width: 2, height: 1, rgba: Uint8Array.from([10, 20, 30, 255, 40, 50, 60, 255]) };
  const e = extrude(img, 2);
  assert.deepEqual([e.width, e.height], [6, 5]);
  const at = (x, y) => [...e.rgba.subarray((y * 6 + x) * 4, (y * 6 + x) * 4 + 4)];
  assert.deepEqual([at(0, 0), at(2, 2), at(3, 2), at(5, 4)], [[10, 20, 30, 255], [10, 20, 30, 255], [40, 50, 60, 255], [40, 50, 60, 255]]);
});

test("trim finds the content of every frame, on clear and on solid backgrounds", () => {
  const a = pad(noise(4, 4), { top: 2, right: 5, bottom: 1, left: 3 });
  const b = pad(noise(6, 2), { top: 5, right: 1, bottom: 0, left: 5 });
  // One shared box holds both.
  assert.deepEqual(contentBox([a, b], emptiness([a, b])), { x: 3, y: 2, w: 8, h: 5 });
  const solid = pad({ width: 3, height: 3, rgba: new Uint8Array(36).fill(255) }, { top: 1, right: 1, bottom: 1, left: 1 }, [20, 40, 60, 255]);
  solid.rgba.set([200, 10, 10, 255], (1 * 5 + 1) * 4);
  assert.deepEqual(contentBox([solid], emptiness([solid])), { x: 1, y: 1, w: 3, h: 3 });
  // A threshold treats faint pixels as empty.
  const faint = pad(noise(2, 2), { top: 1, right: 1, bottom: 1, left: 1 });
  faint.rgba.set([255, 255, 255, 5], 0);
  assert.deepEqual(contentBox([faint], emptiness([faint], 0)), { x: 0, y: 0, w: 3, h: 3 });
  assert.deepEqual(contentBox([faint], emptiness([faint], 5)), { x: 1, y: 1, w: 2, h: 2 });
});

function imageRun(args) {
  return run(["toolbox", "image", ...args]).then(r => ({ ...r, out: r.stdout ? JSON.parse(r.stdout) : undefined }));
}

const readImage = file => readPng(fs.readFileSync(path.resolve(file))).image;

test("trim then pad --restore gives back the very same sheet, through rotate, flip and scale", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-image-"));
  const out = path.join(dir, "out");
  const sheet = makeSheet({ cols: 3, rows: 2, frames: 5, margin: 0.2 });
  const file = writeSheet(dir, "walk.png", sheet, { cols: 3, rows: 2, frames: 5, fps: 12 });
  const original = canonical(sheet.rgba);

  const trimmed = await imageRun(["trim", file, "--out", out]);
  assert.equal(trimmed.code, EXIT.OK, trimmed.stderr);
  const t = trimmed.out;
  assert.equal(t.grid.frames, 5);
  assert.ok(t.grid.frame_width < 48 && t.grid.frame_height < 64);
  assert.deepEqual([t.trim.source_width, t.trim.source_height], [48, 64]);
  assert.deepEqual(readGrid(fs.readFileSync(path.resolve(t.image))), { cols: 3, rows: 2, frames: 5, fps: 12 });

  const restored = await imageRun(["pad", path.resolve(t.image), "--restore", "--out", out]);
  assert.equal(restored.code, EXIT.OK, restored.stderr);
  // Five frames in a 3x2 grid: the empty sixth cell stays empty.
  assert.deepEqual(Buffer.from(readImage(restored.out.image).rgba), original);

  // An edit in between, its inverse after the restore: the trim record has
  // to follow the pixels through each one.
  const pairs = [
    [["rotate", "--by", "90"], ["rotate", "--by", "-90"]],
    [["rotate", "--by", "180"], ["rotate", "--by", "180"]],
    [["flip"], ["flip"]],
    [["flip", "--vertical"], ["flip", "--vertical"]],
    [["scale", "--by", "2"], ["scale", "--by", "1/2"]]
  ];
  for (const [edit, undo] of pairs) {
    const a = await imageRun([edit[0], path.resolve(t.image), ...edit.slice(1), "--out", out]);
    assert.equal(a.code, EXIT.OK, a.stderr);
    assert.ok(a.out.trim, `${edit.join(" ")} keeps the trim record`);
    const b = await imageRun(["pad", path.resolve(a.out.image), "--restore", "--out", out]);
    assert.equal(b.code, EXIT.OK, b.stderr);
    const c = await imageRun([undo[0], path.resolve(b.out.image), ...undo.slice(1), "--out", out]);
    assert.equal(c.code, EXIT.OK, c.stderr);
    assert.deepEqual(Buffer.from(readImage(c.out.image).rgba), original, edit.join(" "));
  }
});

test("rotate swaps the cells of a sheet with frames that are not square, and re-stamps it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-image-"));
  const file = writeSheet(dir, "s.png", makeSheet({ cols: 4, rows: 1 }), { cols: 4, rows: 1, frames: 4, fps: 8 });
  const { code, out, stderr } = await imageRun(["rotate", file, "--out", path.join(dir, "out")]);
  assert.equal(code, EXIT.OK, stderr);
  assert.deepEqual([out.width, out.height, out.grid.frame_width, out.grid.frame_height], [256, 48, 64, 48]);
  assert.deepEqual(readGrid(fs.readFileSync(path.resolve(out.image))), { cols: 4, rows: 1, frames: 4, fps: 8 });
});

test("an image without a grid is one image, and --grid makes it a sheet", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-image-"));
  const out = path.join(dir, "out");
  // Two different frames side by side, unstamped.
  const pair = { width: 16, height: 8, rgba: new Uint8Array(16 * 8 * 4) };
  pasteInto(pair, noise(8, 8, 0, 3), 0, 0);
  pasteInto(pair, noise(8, 8, 0, 5), 8, 0);
  const file = writeSheet(dir, "pair.png", pair);
  const whole = await imageRun(["flip", file, "--out", out]);
  assert.equal(whole.out.grid, undefined);
  assert.match(whole.out.hint.command, /^ludo sprite animate --initial-image/);
  const flipped = readImage(whole.out.image);
  const perFrame = await imageRun(["flip", file, "--grid", "2x1", "--out", out]);
  assert.deepEqual([perFrame.out.grid.cols, perFrame.out.grid.frames], [2, 2]);
  // Flipped as one image the figures swap places; flipped per frame they do not.
  const a = readImage(perFrame.out.image);
  assert.deepEqual(Buffer.from(flipped.rgba), canonical(flip(pair, "horizontal").rgba));
  const halves = { width: 16, height: 8, rgba: new Uint8Array(16 * 8 * 4) };
  pasteInto(halves, flip(noise(8, 8, 0, 3), "horizontal"), 0, 0);
  pasteInto(halves, flip(noise(8, 8, 0, 5), "horizontal"), 8, 0);
  assert.deepEqual(Buffer.from(a.rgba), canonical(halves.rgba));
  assert.ok(readGrid(fs.readFileSync(path.resolve(perFrame.out.image))));
});

test("pad grows to a size with an anchor and a colour, and extrude grows every frame", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-image-"));
  const out = path.join(dir, "out");
  const file = writeSheet(dir, "dot.png", { width: 2, height: 2, rgba: new Uint8Array(16).fill(200) });
  const grown = await imageRun(["pad", file, "--to", "6x4", "--anchor", "bottom", "--color", "#102030", "--out", out]);
  assert.equal(grown.code, EXIT.OK, grown.stderr);
  assert.deepEqual(grown.out.added, { top: 2, right: 2, bottom: 0, left: 2 });
  const img = readImage(grown.out.image);
  const at = (x, y) => [...img.rgba.subarray((y * 6 + x) * 4, (y * 6 + x) * 4 + 4)];
  assert.deepEqual([at(0, 0), at(2, 2), at(3, 3)], [[16, 32, 48, 255], [200, 200, 200, 200], [200, 200, 200, 200]]);

  const sheet = writeSheet(dir, "s.png", makeSheet({ cols: 3, rows: 1 }), { cols: 3, rows: 1, frames: 3, fps: 10 });
  const ex = await imageRun(["extrude", sheet, "--by", "2", "--out", out]);
  assert.deepEqual([ex.out.grid.frame_width, ex.out.grid.frame_height, ex.out.width], [52, 68, 156]);
});

test("image tools refuse bad flags and empty images clearly", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-image-"));
  const file = writeSheet(dir, "x.png", noise(8, 8));
  const empty = writeSheet(dir, "empty.png", { width: 4, height: 4, rgba: new Uint8Array(64) });
  const cases = [
    [["pad", file], /Pass one of --by, --to or --restore/],
    [["pad", file, "--by", "1,2,3"], /--by takes pixels/],
    [["pad", file, "--to", "4x4"], /smaller than the 8x8 image/],
    [["pad", file, "--by", "2", "--anchor", "top"], /--anchor only goes with --to/],
    [["pad", file, "--by", "2", "--color", "red"], /hex colour/],
    [["scale", file, "--by", "1"], /--by takes a factor from 1\/16 to 16/],
    [["scale", file, "--by", "17"], /--by takes a factor/],
    [["scale", file, "--by", "1/20"], /--by takes a factor/],
    [["scale", file, "--by", "1.5", "--filter", "box"], /--filter takes nearest, bilinear/],
    [["scale", file, "--by", "1/16"], /too small to scale/],
    [["rotate", file, "--by", "45"], /--by takes 90, 180, 270/],
    [["trim", file, "--threshold", "300"], /--threshold must be/]
  ];
  for (const [args, msg] of cases) {
    const r = await run(["toolbox", "image", ...args]);
    assert.equal(r.code, EXIT.USAGE, args.join(" "));
    assert.match(r.stderr, msg, args.join(" "));
  }
  const nothing = await run(["toolbox", "image", "trim", empty]);
  assert.equal(nothing.code, EXIT.BAD_INPUT);
  assert.match(nothing.stderr, /is empty/);
  const noRecord = await run(["toolbox", "image", "pad", file, "--restore"]);
  assert.equal(noRecord.code, EXIT.BAD_INPUT);
  assert.match(noRecord.stderr, /no trim record/);
});

test("pixel edits match ImageMagick's", t => {
  // ImageMagick 7 is `magick`; 6 is `convert`, which on Windows is another tool entirely.
  const im = ["magick", ...(process.platform === "win32" ? [] : ["convert"])].find(cmd => {
    try {
      execFileSync(cmd, ["-version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  });
  if (!im) return t.skip("ImageMagick is not installed");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-image-im-"));
  try {
    const img = noise(9, 6, 0, 11);
    const big = noise(12, 12, 0, 13);
    const padded = pad(img, { top: 2, right: 3, bottom: 1, left: 4 });
    for (const [name, x] of Object.entries({ img, big, padded })) fs.writeFileSync(path.join(dir, `${name}.png`), encodePng(x));
    const magick = (name, ...ops) => execFileSync(im, [path.join(dir, `${name}.png`), ...ops, "-depth", "8", "RGBA:-"]);
    const cases = [
      ["-flop", magick("img", "-flop"), flip(img, "horizontal")],
      ["-flip", magick("img", "-flip"), flip(img, "vertical")],
      ["-rotate 90", magick("img", "-rotate", "90"), rotate(img, 1)],
      ["-rotate 180", magick("img", "-rotate", "180"), rotate(img, 2)],
      ["-rotate 270", magick("img", "-rotate", "270"), rotate(img, 3)],
      ["-sample 300%", magick("img", "-sample", "300%"), scaleUp(img, 3)],
      ...[2, 3, 4].map(n => [`-sample 1/${n}`, magick("big", "-sample", `${12 / n}x${12 / n}`), scaleDown(big, n)]),
      ["-trim", magick("padded", "-trim", "+repage"), crop(padded, contentBox([padded], emptiness([padded])))],
      ["-gravity center -extent", magick("img", "-background", "none", "-gravity", "center", "-extent", "14x9"), pad(img, { top: 1, right: 3, bottom: 2, left: 2 })]
    ];
    for (const [name, theirs, ours] of cases) assert.deepEqual(canonical(theirs), canonical(ours.rgba), name);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("scaling by any factor is Pillow's resize, to the byte", async t => {
  const pillow = (() => {
    try {
      execFileSync("python3", ["-I", "-c", "import PIL"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();
  if (!pillow) return t.skip("Pillow is not installed");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-scale-pil-"));
  try {
    const file = writeSheet(dir, "in.png", noise(9, 7, 0, 5));
    const PIL = { nearest: "NEAREST", bilinear: "BILINEAR", bicubic: "BICUBIC", lanczos: "LANCZOS" };
    const cases = [
      ["1.5", "nearest"],
      ["2/3", "nearest"],
      ["0.75", "bilinear"],
      ["1.5", "bicubic"],
      ["2/3", "lanczos"],
      ["2", "lanczos"],
      ["1/2", "bicubic"],
      ["3.25", "lanczos"]
    ];
    for (const [by, filter] of cases) {
      const out = path.join(dir, `out-${by.replace("/", "_")}-${filter}`);
      const r = await run(["toolbox", "image", "scale", file, "--by", by, "--filter", filter, "--out", out, "--json"]);
      assert.equal(r.code, 0, r.stderr);
      const ours = readPng(fs.readFileSync(path.resolve(out, path.basename(JSON.parse(r.stdout).image)))).image;
      const [a, b = 1] = by.split("/").map(Number);
      assert.deepEqual([ours.width, ours.height], [Math.round((9 * a) / b), Math.round((7 * a) / b)], by);
      const script = `import sys\nfrom PIL import Image\nim = Image.open(sys.argv[1]).convert("RGBA").resize((${ours.width}, ${ours.height}), Image.Resampling.${PIL[filter]})\nsys.stdout.buffer.write(im.tobytes())`;
      const theirs = execFileSync("python3", ["-I", "-c", script, file]);
      assert.deepEqual(canonical(ours.rgba), canonical(theirs), `--by ${by} --filter ${filter}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a fractional scale keeps a trimmed sheet's record in step", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-scale-trim-"));
  // Two 12x10 frames whose content is a 4x4 block at (6, 4).
  const img = { width: 24, height: 10, rgba: new Uint8Array(24 * 10 * 4) };
  for (const ox of [0, 12]) for (let y = 4; y < 8; y++) for (let x = 6; x < 10; x++) img.rgba.set([200, 40, 40, 255], ((y * 24) + ox + x) * 4);
  const file = writeSheet(dir, "s.png", img, { cols: 2, rows: 1, frames: 2, fps: 8 });
  const trimmed = JSON.parse((await run(["toolbox", "image", "trim", file, "--out", dir, "--json"])).stdout);
  const r = await run(["toolbox", "image", "scale", path.resolve(dir, path.basename(trimmed.image)), "--by", "1.5", "--out", dir, "--json"]);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.trim, { x: 9, y: 6, width: 6, height: 6, source_width: 18, source_height: 15 });
  assert.equal(out.scale, 1.5);
  assert.equal(out.filter, "nearest");
});

// ---- Engine exports ----

test("a TexturePacker atlas has frames keyed in playing order, animations and frameTags", () => {
  const atlas = textureAtlas("hero.png", 64, 32, { cols: 2, rows: 2, frames: 3, fps: 12 }, "hero");
  assert.deepEqual(Object.keys(atlas.frames), ["0", "1", "2"]);
  assert.deepEqual(atlas.frames["2"], {
    frame: { x: 0, y: 16, w: 32, h: 16 },
    rotated: false,
    trimmed: false,
    spriteSourceSize: { x: 0, y: 0, w: 32, h: 16 },
    sourceSize: { w: 32, h: 16 },
    duration: 83
  });
  assert.deepEqual(atlas.animations, { hero: ["0", "1", "2"] });
  assert.deepEqual(atlas.meta.frameTags, [{ name: "hero", from: 0, to: 2, direction: "forward" }]);
  assert.deepEqual([atlas.meta.image, atlas.meta.size, atlas.meta.scale], ["hero.png", { w: 64, h: 32 }, "1"]);
  // A sheet whose size does not divide: frames are cut as everywhere else in
  // the CLI, floor(W / cols) wide at round(col * W / cols).
  const odd = textureAtlas("odd.png", 100, 10, { cols: 3, rows: 1, frames: 3, fps: 10 }, "odd");
  assert.deepEqual(Object.values(odd.frames).map(f => [f.frame.x, f.frame.w]), [[0, 33], [33, 33], [67, 33]]);
  // Trimmed and extruded: the frame rect skips the border, the rest says where it sat.
  const packed = textureAtlas("p.png", 48, 28, { cols: 3, rows: 2, frames: 5, fps: 8 }, "p", { trim: { x: 3, y: 2, w: 12, h: 10, source_w: 20, source_h: 16 }, extrude: 2 });
  assert.deepEqual(packed.frames["4"], {
    frame: { x: 18, y: 16, w: 12, h: 10 },
    rotated: false,
    trimmed: true,
    spriteSourceSize: { x: 3, y: 2, w: 12, h: 10 },
    sourceSize: { w: 20, h: 16 },
    duration: 125
  });
  assert.throws(() => textureAtlas("x.png", 8, 8, { cols: 2, rows: 1, frames: 3, fps: 10 }, "x"), /do not fit/);
  assert.throws(() => textureAtlas("x.png", 8, 8, { cols: 2, rows: 1, frames: 2, fps: 10 }, "x", { extrude: 2 }), /leaves nothing/);
});

test("sprite export writes the engine file next to the sheet, and other sheet tools take --engine", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-export-"));
  const file = writeSheet(dir, "run.png", makeSheet({ cols: 3, rows: 2, frames: 5 }), { cols: 3, rows: 2, frames: 5, fps: 12 });
  assert.match((await run(["toolbox", "sprite", "export", file])).stderr, /Pass --engine texturepacker, godot or unity/);

  const tp = await run(["toolbox", "sprite", "export", file, "--engine", "texturepacker"]);
  assert.equal(tp.code, EXIT.OK, tp.stderr);
  const atlasFile = path.resolve(JSON.parse(tp.stdout).engine_files[0]);
  assert.equal(atlasFile, path.join(dir, "run.json"));
  const atlas = JSON.parse(fs.readFileSync(atlasFile, "utf8"));
  assert.deepEqual([atlas.meta.image, Object.keys(atlas.frames).length, atlas.frames["0"].duration], ["run.png", 5, 83]);

  // Never overwrites, takes a name and a frame rate.
  const again = JSON.parse((await run(["toolbox", "sprite", "export", file, "--engine", "texturepacker", "--animation", "dash", "--fps", "20"])).stdout);
  const second = JSON.parse(fs.readFileSync(path.resolve(again.engine_files[0]), "utf8"));
  assert.match(again.engine_files[0], /run-2\.json$/);
  assert.deepEqual([Object.keys(second.animations), second.frames["0"].duration], [["dash"], 50]);

  const godot = JSON.parse((await run(["toolbox", "sprite", "export", file, "--engine", "godot"])).stdout);
  const tres = fs.readFileSync(path.resolve(godot.engine_files[0]), "utf8");
  assert.match(tres, /path="run\.png"/);
  assert.equal((tres.match(/type="AtlasTexture"/g) || []).length, 5);
  assert.match(tres, /"speed": 12\.0/);

  const out = path.join(dir, "out");
  const framed = JSON.parse((await run(["toolbox", "sprite", "frames", file, "--reverse", "--engine", "texturepacker", "--out", out])).stdout);
  assert.equal(path.dirname(path.resolve(framed.engine_files[0])), path.dirname(path.resolve(framed.sheet)), "the atlas sits next to its sheet");
  const flipped = JSON.parse((await run(["toolbox", "image", "flip", file, "--engine", "godot", "--out", out])).stdout);
  assert.match(flipped.engine_files[0], /\.tres$/);
  // A single image (no grid) is not a sheet: nothing to export.
  const single = writeSheet(dir, "one.png", noise(8, 8));
  assert.equal(JSON.parse((await run(["toolbox", "image", "flip", single, "--engine", "godot", "--out", out])).stdout).engine_files, undefined);
});

test("trim and extrude records survive slicing, frame edits and joining, and other edits refuse an extruded file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-records-"));
  const out = path.join(dir, "out");
  const file = writeSheet(dir, "hop.png", makeSheet({ cols: 3, rows: 1, margin: 0.2 }), { cols: 3, rows: 1, frames: 3, fps: 10 });
  const trimmed = JSON.parse((await run(["toolbox", "image", "trim", file, "--out", out])).stdout);
  const extruded = JSON.parse((await run(["toolbox", "image", "extrude", path.resolve(trimmed.image), "--by", "3", "--out", out])).stdout);
  assert.deepEqual(extruded.trim, trimmed.trim, "extrude keeps the trim record");
  assert.equal(extruded.extruded, 3);

  const refused = await run(["toolbox", "image", "scale", path.resolve(extruded.image), "--by", "2"]);
  assert.equal(refused.code, EXIT.BAD_INPUT);
  assert.match(refused.stderr, /is extruded/);

  // Frame edits keep both: the cells do not change.
  const reversed = JSON.parse((await run(["toolbox", "sprite", "frames", path.resolve(extruded.image), "--reverse", "--engine", "texturepacker", "--out", out])).stdout);
  const atlas = JSON.parse(fs.readFileSync(path.resolve(reversed.engine_files[0]), "utf8"));
  assert.equal(atlas.frames["0"].trimmed, true);
  assert.deepEqual(atlas.frames["0"].frame, { x: 3, y: 3, w: trimmed.trim.width, h: trimmed.trim.height });

  // Slicing drops the repeated border; joining the frames brings the trim record back.
  const sliced = JSON.parse((await run(["toolbox", "sprite", "slice", path.resolve(extruded.image), "--out", out])).stdout);
  assert.deepEqual([sliced.grid.frame_width, sliced.grid.frame_height], [trimmed.grid.frame_width, trimmed.grid.frame_height]);
  const joined = JSON.parse((await run(["toolbox", "sprite", "join", path.resolve(sliced.dir), "--cols", "3", "--out", out])).stdout);
  const restored = JSON.parse((await run(["toolbox", "image", "pad", path.resolve(joined.sheet), "--restore", "--out", out])).stdout);
  assert.deepEqual(Buffer.from(readImage(restored.image).rgba), canonical(makeSheet({ cols: 3, rows: 1, margin: 0.2 }).rgba));
});
