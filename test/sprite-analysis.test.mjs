import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { encodePng, withText } from "../dist/tty/png.js";
import { EXIT } from "../dist/errors.js";
import { components, convexHull, enclosingCircle, erode, reduceConvex, shapesOf, signedArea, simplifyClosed, traceOutline } from "../dist/toolbox/sprite-analysis.js";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

function run(args) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-sprite-analysis-"));
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...process.env, LUDO_API_URL: "http://127.0.0.1:9", LUDO_API_KEY: "", LUDO_CONFIG_DIR: path.join(cwd, ".config"), LUDO_CACHE_DIR: path.join(cwd, ".cache"), LUDO_TELEMETRY: "0", CLAUDECODE: "", CLAUDE_CODE_ENTRYPOINT: "" }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", d => (stdout += d));
    child.stderr.on("data", d => (stderr += d));
    child.on("close", code => resolve({ code, stdout, stderr, cwd }));
  });
}

const json = async args => {
  const r = await run([...args, "--json"]);
  assert.equal(r.code, EXIT.OK, r.stderr);
  return JSON.parse(r.stdout);
};

// ---- Synthetic frames: solid rectangles and discs with known answers ----

const blank = (w, h) => ({ width: w, height: h, rgba: new Uint8Array(w * h * 4) });
function rect(img, x0, y0, w, h, rgb = [200, 60, 40], a = 255) {
  for (let y = Math.max(0, y0); y < Math.min(img.height, y0 + h); y++) for (let x = Math.max(0, x0); x < Math.min(img.width, x0 + w); x++) img.rgba.set([...rgb, a], (y * img.width + x) * 4);
  return img;
}
function disc(img, cx, cy, r, rgb = [40, 180, 80]) {
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r) img.rgba.set([...rgb, 255], (y * img.width + x) * 4);
  return img;
}

function sheetOf(frames, cols = frames.length) {
  const { width: fw, height: fh } = frames[0];
  const rows = Math.ceil(frames.length / cols);
  const sheet = blank(fw * cols, fh * rows);
  frames.forEach((f, i) => {
    const [ox, oy] = [(i % cols) * fw, Math.floor(i / cols) * fh];
    for (let y = 0; y < fh; y++) sheet.rgba.set(f.rgba.subarray(y * fw * 4, (y + 1) * fw * 4), ((oy + y) * sheet.width + ox) * 4);
  });
  return { sheet, grid: { cols, rows, frames: frames.length, fps: 10 } };
}

function writeSheet(dir, name, frames, { cols, fps = 10 } = {}) {
  const { sheet, grid } = sheetOf(frames, cols);
  const file = path.join(dir, name);
  fs.writeFileSync(file, withText(encodePng(sheet), "ludo:grid", JSON.stringify({ ...grid, fps })));
  return file;
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ludo-sa-"));
const range = n => Array.from({ length: n }, (_, i) => i);

// A figure standing on row 57 of a 64x64 frame: a 20x40 body whose left edge
// is at x0, two 6x6 feet under it, and a ball bobbing over its head (up and
// down only, so it changes every frame but never reaches sideways).
// `lift` raises a foot (or both) off the ground.
function figure(t, { x0 = 22, liftA = 0, liftB = 0, rise = 0, sword = 0, bob = true, period = 8 } = {}) {
  const img = blank(64, 64);
  const top = 12 - rise;
  rect(img, x0, top, 20, 40);
  rect(img, x0 + 1, top + 40 - liftA, 6, 6, [60, 60, 140]);
  rect(img, x0 + 13, top + 40 - liftB, 6, 6, [60, 60, 140]);
  if (bob) disc(img, x0 + 10, top - 6 + 3 * Math.sin((2 * Math.PI * t) / period), 3);
  if (sword) rect(img, x0 + 20, top + 18, sword, 3, [220, 220, 240]);
  return img;
}

// ---- Pure geometry ----

test("the outline follows pixel edges: holes filled, diagonal touches apart, corners only", () => {
  const w = 12;
  const h = 10;
  const m = new Uint8Array(w * h);
  const set = (x0, y0, x1, y1) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m[y * w + x] = 1;
  };
  // An L: 4 wide, 6 tall, with a 3 x 2 foot to the right.
  set(1, 1, 5, 7);
  set(5, 5, 8, 7);
  // A square touching the L's corner only diagonally.
  set(8, 7, 10, 9);
  const { labels, areas } = components(m, w, h);
  assert.deepEqual(areas, [30, 4]);
  const l = traceOutline(labels, w, h, 0);
  assert.deepEqual(l, [[5, 1], [5, 5], [8, 5], [8, 7], [1, 7], [1, 1]]);
  assert.ok(signedArea(l) > 0, "clockwise on screen");
  assert.equal(signedArea(l), 30);
  assert.deepEqual(traceOutline(labels, w, h, 1), [[10, 7], [10, 9], [8, 9], [8, 7]]);

  // A ring: its outline is the outside only.
  const ring = new Uint8Array(64);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) ring[y * 8 + x] = x === 0 || y === 0 || x === 7 || y === 7 ? 1 : 0;
  const r = components(ring, 8, 8);
  assert.equal(signedArea(traceOutline(r.labels, 8, 8, 0)), 64);
});

test("Douglas-Peucker keeps corners further than the tolerance, hulls are convex, the circle is the smallest", () => {
  // A square's outline with a 1 px notch: kept at tolerance 0.5, dropped at 2.
  const notched = [[0, 0], [5, 0], [5, 1], [6, 1], [6, 0], [10, 0], [10, 10], [0, 10]];
  assert.equal(simplifyClosed(notched, 0.5).length, 8);
  assert.deepEqual(simplifyClosed(notched, 2), [[0, 0], [10, 0], [10, 10], [0, 10]]);
  const hull = convexHull([[0, 0], [4, 0], [4, 4], [0, 4], [2, 2], [1, 3]]);
  assert.equal(hull.length, 4);
  assert.ok(signedArea(hull) === 16);
  const c = enclosingCircle([[0, 0], [6, 0], [3, 1]]);
  assert.deepEqual([c.x, c.y, c.r], [3, 0, 3]);
  // A 16-gon cut to 8 corners stays convex and inside.
  const gon = range(16).map(i => [Math.cos((i * Math.PI) / 8) * 10, Math.sin((i * Math.PI) / 8) * 10]);
  const eight = reduceConvex(gon, 8);
  assert.equal(eight.length, 8);
  assert.equal(convexHull(eight).length, 8);
});

test("shapes of a mask: box, circle, capsule along the body, specks left out, inset by erosion", () => {
  const [w, h] = [40, 40];
  const m = new Uint8Array(w * h);
  for (let y = 5; y < 35; y++) for (let x = 10; x < 20; x++) m[y * w + x] = 1; // a 10 x 30 body
  for (let x = 20; x < 32; x++) m[15 * w + x] = 1; // a 1 px tall sword held out
  m[2 * w + 38] = 1; // a speck
  const s = shapesOf(m, w, h, 0.5);
  assert.deepEqual(s.box, { x: 10, y: 5, w: 22, h: 30 });
  assert.equal(s.specks, 1);
  assert.equal(s.polygons.length, 1);
  assert.equal(s.polygons[0].length, 8);
  // The capsule follows the body's rows, not the sword's.
  assert.deepEqual(s.capsule, { x: 15, y: 20, radius: 5, height: 30, direction: "vertical" });
  // Every corner of the art is inside the circle.
  for (const [x, y] of s.hull) assert.ok(Math.hypot(x - s.circle.x, y - s.circle.y) <= s.circle.r + 1e-6);
  // Eroding by 1 takes the 1 px sword away and a pixel off every side.
  const thin = shapesOf(erode(m, w, h, 1), w, h, 0.5);
  // (the pixel where the sword met the body keeps a diagonal neighbour of empty, so it stays)
  assert.deepEqual(thin.box, { x: 11, y: 6, w: 9, h: 28 });
});

// ---- sprite metrics ----

test("metrics: bounds, ground, centre of mass, a pivot on the feet, and engine values", async () => {
  const dir = tmp();
  const frames = range(8).map(t => figure(t, { liftA: t < 4 ? 0 : 4, liftB: t < 4 ? 4 : 0 }));
  const file = writeSheet(dir, "walk.png", frames, { cols: 4 });
  const out = await json(["toolbox", "sprite", "metrics", file, "--out", dir, "--overlay"]);
  assert.equal(out.grid_from, "stamp");
  assert.equal(out.frames.length, 8);
  // The feet bottom out on row 57 (top 12 + 40 + 6 - 1).
  assert.equal(out.ground.row, 57);
  assert.equal(out.character, true);
  assert.equal(out.frames[0].bounds.x, 22);
  assert.equal(out.frames[0].bounds.w, 20);
  assert.deepEqual(out.pivot, { ...out.pivot, x: 32, y: 58, kind: "feet" });
  assert.deepEqual(out.godot.offset, [32 - 32, 32 - 58]);
  assert.deepEqual(out.godot.uncentered.offset, [-32, -58]);
  assert.deepEqual(out.unity.pivot, [0.5, 0.0938]);
  assert.deepEqual(out.phaser.origin, [0.5, 0.9063]);
  assert.deepEqual(out.sort_point.from_pivot, [0, 0]);
  assert.equal(out.drift.verdict, "in place");
  assert.ok(fs.existsSync(out.overlay));
  assert.match(out.hint.command, /^ludo toolbox sprite collide /);
});

test("metrics: art that travels across the frame is drift; a floating effect pivots on its centre of mass", async () => {
  const dir = tmp();
  const walker = writeSheet(dir, "travel.png", range(8).map(t => figure(t, { x0: 4 + 4 * t, bob: false })), { cols: 8 });
  const w = await json(["toolbox", "sprite", "metrics", walker]);
  assert.equal(w.drift.x, 28);
  assert.match(w.drift.verdict, /^moves right 28 px/);
  // A disc in mid-air, growing: no ground line to stand on.
  const fx = writeSheet(dir, "spark.png", range(6).map(t => disc(blank(48, 48), 24, 20, 4 + t)), { cols: 6 });
  const f = await json(["toolbox", "sprite", "metrics", fx]);
  assert.equal(f.character, false);
  assert.deepEqual([f.pivot.x, f.pivot.y, f.pivot.kind], [24, 20, "mass"]);
  // The Y-sort point is the bottom of its art, under the pivot.
  assert.equal(f.sort_point.y, 20 + 9);
  const forced = await json(["toolbox", "sprite", "metrics", fx, "--pivot", "10,40"]);
  assert.deepEqual([forced.pivot.x, forced.pivot.y, forced.pivot.kind], [10, 40, "flag"]);
  const bad = await run(["toolbox", "sprite", "metrics", fx, "--pivot", "somewhere"]);
  assert.equal(bad.code, EXIT.USAGE);
  const empty = writeSheet(dir, "empty.png", [blank(16, 16), blank(16, 16)]);
  assert.equal((await run(["toolbox", "sprite", "metrics", empty])).code, EXIT.BAD_INPUT);
});

// ---- sprite collide ----

test("collide: shapes from the pivot, and each engine's convention", async () => {
  const dir = tmp();
  const box = () => rect(blank(48, 48), 10, 5, 20, 30);
  const file = writeSheet(dir, "crate.png", [box(), box()]);
  const out = await json(["toolbox", "sprite", "collide", file, "--ppu", "10", "--tolerance", "0.5"]);
  assert.deepEqual([out.pivot.x, out.pivot.y], [20, 35]);
  const s = out.shapes;
  assert.deepEqual(s.box, { x: -10, y: -30, w: 20, h: 30 });
  assert.deepEqual(s.polygons, [[[10, -30], [10, 0], [-10, 0], [-10, -30]]]);
  assert.equal(s.hull.length, 4);
  assert.deepEqual(s.capsule, { x: 0, y: -15, radius: 10, height: 30, direction: "vertical" });
  assert.equal(s.circle.r, 18.03);
  const { godot, unity, phaser, box2d } = out.engines;
  assert.deepEqual(godot.box, { position: [0, -15], size: [20, 30] });
  assert.match(godot.tres.box, /\[gd_resource type="RectangleShape2D" format=3\]\n\n\[resource\]\nsize = Vector2\(20, 30\)/);
  assert.match(godot.polygon_node, /polygon = PackedVector2Array\(10, -30, 10, 0, -10, 0, -10, -30\)/);
  // Unity and Box2D: units at --ppu, y up.
  assert.deepEqual(unity.box, { offset: [0, 1.5], size: [2, 3] });
  assert.deepEqual(unity.capsule, { offset: [0, 1.5], size: [2, 3], direction: "Vertical" });
  assert.ok(signedArea(unity.polygon_paths[0]) > 0, "counter-clockwise in y-up");
  assert.deepEqual(box2d.capsule, { centre1: [0, 2], centre2: [0, 1], radius: 1 });
  assert.equal(box2d.hull.length, 4);
  // Phaser: frame pixels, and the origin at the polygon's centre.
  assert.deepEqual(phaser.polygon.origin, [20 / 48, 20 / 48].map(v => Math.round(v * 1e4) / 1e4));
  assert.deepEqual(phaser.polygon.pivot_from_body, [0, 15]);
  assert.match(phaser.snippet, /type: "fromVerts"/);

  const inset = await json(["toolbox", "sprite", "collide", file, "--inset", "2"]);
  assert.deepEqual(inset.shapes.box, { x: -8, y: -28, w: 16, h: 26 });
  assert.equal((await run(["toolbox", "sprite", "collide", file, "--inset", "40"])).code, EXIT.USAGE);
});

test("collide --per-frame gives each frame its own shapes; the union holds them all", async () => {
  const dir = tmp();
  const file = writeSheet(dir, "grow.png", [rect(blank(32, 32), 10, 20, 10, 10), rect(blank(32, 32), 6, 10, 20, 20)]);
  const per = await json(["toolbox", "sprite", "collide", file, "--per-frame", "--pivot", "16,30"]);
  assert.deepEqual(per.frames.map(f => f.shapes.box), [
    { x: -6, y: -10, w: 10, h: 10 },
    { x: -10, y: -20, w: 20, h: 20 }
  ]);
  assert.equal(per.frames[0].engines.godot.tres, undefined, "no snippets per frame");
  const union = await json(["toolbox", "sprite", "collide", file, "--pivot", "16,30", "--out", dir, "--overlay"]);
  assert.deepEqual(union.shapes.box, { x: -10, y: -20, w: 20, h: 20 });
  assert.ok(fs.existsSync(union.overlay));
});

// ---- sprite events ----

test("events: foot contacts in a walk cycle, on the right frames, as suggestions", async () => {
  const dir = tmp();
  // Foot A down for frames 1-5, foot B for 6-10, each lifting and lowering
  // in even steps: each plants when it comes down.
  const swing = [0, 0, 0, 0, 0, 2, 4, 6, 4, 2];
  const frames = range(10).map(t => figure(t, { liftA: swing[t], liftB: swing[(t + 5) % 10], period: 10 }));
  const file = writeSheet(dir, "walk.png", frames, { cols: 5, fps: 10 });
  const out = await json(["toolbox", "sprite", "events", file]);
  assert.equal(out.looping, true);
  assert.equal(out.fps, 10);
  assert.deepEqual(out.frames.map(f => f.time_ms), range(10).map(i => i * 100));
  const feet = out.events.filter(e => e.type === "foot_contact");
  assert.deepEqual(feet.map(e => [e.frame, e.side]), [[1, "left"], [6, "right"]]);
  assert.ok(out.events.every(e => e.suggestion === true && e.confidence > 0 && e.confidence <= 1));
  assert.ok(!out.events.some(e => e.type === "impact"), "no strike in a walk");
  assert.match(out.godot.animation_tres, /tracks\/0\/type = "method"/);
  assert.match(out.godot.animation_tres, /"times": PackedFloat32Array\(0, 0.5\)/);
  assert.match(out.godot.animation_tres, /"args": \["left"\],\n"method": &"_on_foot_contact"/);
  assert.deepEqual(out.unity.events, [
    { time: 0, functionName: "OnFootContact", stringParameter: "left" },
    { time: 0.5, functionName: "OnFootContact", stringParameter: "right" }
  ]);
  assert.match(out.unity.anim_yaml, /- time: 0.5\n {4}functionName: OnFootContact\n {4}data: right/);
});

test("events: a jump's takeoff, apex and landing, then it settles", async () => {
  const dir = tmp();
  const rise = [0, 0, 0, 6, 12, 16, 10, 0, 0, 0];
  // Feet tucked (lifted from the body) while up, as in a jump.
  const frames = rise.map((r, t) => figure(t, { rise: r, bob: t < 7 }));
  const file = writeSheet(dir, "jump.png", frames, { cols: 5 });
  const out = await json(["toolbox", "sprite", "events", file]);
  const jump = out.events.find(e => e.type === "jump_apex");
  assert.ok(jump, JSON.stringify(out.events));
  assert.deepEqual([jump.takeoff, jump.frame, jump.landing], [4, 6, 8]);
  const settle = out.events.find(e => e.type === "settle");
  assert.equal(settle?.frame, 9);
  assert.ok(!out.events.some(e => e.type === "impact"));
});

test("events: an attack's impact is the frame of greatest reach, with its active window", async () => {
  const dir = tmp();
  const swing = [0, 0, 4, 30, 10, 0, 0, 0];
  const file = writeSheet(dir, "attack.png", swing.map((s, t) => figure(t, { sword: s })), { cols: 4 });
  const out = await json(["toolbox", "sprite", "events", file]);
  const hits = out.events.filter(e => e.type === "impact");
  assert.equal(hits.length, 1, JSON.stringify(out.events));
  assert.equal(hits[0].frame, 4);
  assert.deepEqual([hits[0].active.start, hits[0].active.end], [4, 4]);
  assert.ok(!out.events.some(e => e.type === "foot_contact"), "both feet stay planted");
  assert.deepEqual(
    out.unity.events.map(e => e.functionName),
    ["OnAttackActiveStart", "OnAttackImpact", "OnAttackActiveEnd", ...out.unity.events.slice(3).map(e => e.functionName)]
  );
  const one = writeSheet(dir, "one.png", [figure(0)]);
  assert.equal((await run(["toolbox", "sprite", "events", one])).code, EXIT.BAD_INPUT);
});

// ---- sprite compare ----

test("compare: matching animations are consistent; one twice the size is not, and pack is suggested with its scale", async () => {
  const dir = tmp();
  const idle = writeSheet(dir, "idle.png", range(4).map(t => figure(t)));
  const walk = writeSheet(dir, "walk.png", range(4).map(t => figure(t, { liftA: t % 2 ? 4 : 0 })));
  const same = await json(["toolbox", "sprite", "compare", idle, walk]);
  assert.equal(same.consistent, true, JSON.stringify(same.checks));
  assert.equal(same.hint, undefined);
  assert.deepEqual(same.sheets.map(s => s.pack_scale), [1, 1]);

  // The same figure drawn at twice the size, in frames twice as big.
  const big = range(4).map(t => {
    const small = figure(t);
    const out = blank(128, 128);
    for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) out.rgba.set(small.rgba.subarray(((y >> 1) * 64 + (x >> 1)) * 4, ((y >> 1) * 64 + (x >> 1)) * 4 + 4), (y * 128 + x) * 4);
    return out;
  });
  const attack = writeSheet(dir, "attack.png", big, { fps: 12 });
  const diff = await json(["toolbox", "sprite", "compare", idle, attack]);
  assert.equal(diff.consistent, false);
  assert.equal(diff.checks.frame_size.consistent, false);
  assert.equal(diff.checks.body_height.ratio, 2);
  assert.equal(diff.checks.fps.consistent, false);
  assert.deepEqual(diff.sheets.map(s => s.pack_scale), [1, 0.5]);
  assert.equal(diff.hint.command, `ludo toolbox sprite pack ${idle} ${attack}`);
  // Palettes of pixel art are compared: these share every colour.
  assert.deepEqual(diff.checks.palette.pixels_in_shared_colours, [1, 1]);
  assert.equal((await run(["toolbox", "sprite", "compare", idle])).code, EXIT.USAGE);
});

test("the new tools are listed, have help, and the commands their hints name exist", async () => {
  const list = await run(["toolbox"]);
  for (const t of ["metrics", "collide", "events", "compare"]) assert.match(list.stdout, new RegExp(`sprite .*\\b${t}\\b`));
  for (const cmd of [["toolbox", "sprite", "metrics"], ["toolbox", "sprite", "collide"], ["toolbox", "sprite", "events"], ["toolbox", "sprite", "compare"], ["toolbox", "sprite", "pack"], ["preview"]]) {
    const r = await run([...cmd, "--help"]);
    assert.equal(r.code, EXIT.OK, `${cmd.join(" ")}: ${r.stderr}`);
  }
});
