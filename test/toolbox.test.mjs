import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseToolArgv } from "../dist/toolbox/index.js";
import { CONFIDENT, guessGrid } from "../dist/toolbox/grid.js";
import { encodePng, readPng, withText } from "../dist/tty/png.js";
import { readGrid } from "../dist/tty/preview.js";
import { applyFrameOps, parseFrameList, parseHolds } from "../dist/toolbox/frames.js";
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
