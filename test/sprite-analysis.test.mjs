import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { encodePng, readPng, withText } from "../dist/tty/png.js";
import { EXIT } from "../dist/errors.js";
import { bodyBox, capsuleOf, components, convexHull, dilate, erode, framesLayout, MAX_SIDE, measureFrame, opening, outlineOf, reduceConvex, signedArea, simplifyClosed, traceOutline } from "../dist/toolbox/sprite-analysis.js";

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

test("Douglas-Peucker keeps corners further than the tolerance, hulls are convex and cut to 8 corners", () => {
  // A square's outline with a 1 px notch: kept at tolerance 0.5, dropped at 2.
  const notched = [[0, 0], [5, 0], [5, 1], [6, 1], [6, 0], [10, 0], [10, 10], [0, 10]];
  assert.equal(simplifyClosed(notched, 0.5).length, 8);
  assert.deepEqual(simplifyClosed(notched, 2), [[0, 0], [10, 0], [10, 10], [0, 10]]);
  const hull = convexHull([[0, 0], [4, 0], [4, 4], [0, 4], [2, 2], [1, 3]]);
  assert.equal(hull.length, 4);
  assert.ok(signedArea(hull) === 16);
  // A 16-gon cut to 8 corners stays convex and inside.
  const gon = range(16).map(i => [Math.cos((i * Math.PI) / 8) * 10, Math.sin((i * Math.PI) / 8) * 10]);
  const eight = reduceConvex(gon, 8);
  assert.equal(eight.length, 8);
  assert.equal(convexHull(eight).length, 8);
});

test("erosion, dilation and opening; the outline leaves specks out", () => {
  const [w, h] = [40, 40];
  const m = new Uint8Array(w * h);
  for (let y = 5; y < 35; y++) for (let x = 10; x < 20; x++) m[y * w + x] = 1; // a 10 x 30 body
  for (let x = 20; x < 32; x++) m[15 * w + x] = 1; // a 1 px tall sword held out
  m[2 * w + 38] = 1; // a speck
  const o = outlineOf(m, w, h, 0.5);
  assert.equal(o.specks, 1);
  assert.equal(o.polygons.length, 1);
  assert.equal(o.polygons[0].length, 8);
  // Eroding by 1 takes the 1 px sword away and a pixel off every side
  // (the pixel where the sword met the body keeps a diagonal neighbour of empty, so it stays).
  assert.deepEqual(measureFrame(erode(m, w, h, 1), w, h).bounds, { x: 11, y: 6, w: 9, h: 28 });
  assert.deepEqual(measureFrame(dilate(m, w, h, 1), w, h).bounds, { x: 9, y: 1, w: 31, h: 35 });
  // Opening by 1 loses the sword and the speck, and keeps the body's box
  // (and the sword's root, which erosion kept).
  assert.deepEqual(measureFrame(opening(m, w, h, 1), w, h).bounds, { x: 10, y: 5, w: 11, h: 30 });
  assert.deepEqual(capsuleOf({ x: 10, y: 5, w: 10, h: 30 }), { x: 15, y: 20, radius: 5, height: 30, direction: "vertical" });
  assert.deepEqual(capsuleOf({ x: 0, y: 0, w: 30, h: 10 }), { x: 15, y: 5, radius: 5, height: 30, direction: "horizontal" });
});

test("the body leaves out a raised spike and a sword held out, and keeps the feet", () => {
  const [w, h] = [64, 100];
  const m = new Uint8Array(w * h);
  const set = (x0, y0, x1, y1) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m[y * w + x] = 1;
  };
  set(10, 20, 30, 80); // the body, 20 x 60
  set(30, 40, 60, 46); // a sword held out, 6 rows thick: too thick to open away, too few rows to widen the median
  set(18, 5, 20, 20); // a 2 px spike raised over the head
  set(12, 80, 16, 82); // a 4 x 2 foot, thinner than the opening
  const bounds = measureFrame(m, w, h).bounds;
  assert.deepEqual(bounds, { x: 10, y: 5, w: 50, h: 77 });
  // Opening by 3% of 77 (2 px) takes the spike but its root (1 px over the
  // head); the median row ignores the sword; the foot stays the bottom.
  assert.deepEqual(bodyBox(m, w, h, 2), { x: 10, y: 19, w: 20, h: 63 });
  // A floor (the ground line) keeps what hangs below it out.
  assert.deepEqual(bodyBox(m, w, h, 2, 79), { x: 10, y: 19, w: 20, h: 61 });
  assert.equal(bodyBox(new Uint8Array(w * h), w, h, 2), null);
});

test("the frames' picture stays within its size, enlarges by whole factors and shrinks by any", () => {
  const small = framesLayout(16, 16, 8);
  assert.ok(Number.isInteger(small.scale) && small.scale > 1, `scale ${small.scale}`);
  const big = framesLayout(512, 512, 64);
  assert.ok(big.width <= MAX_SIDE && big.height <= MAX_SIDE, `${big.width}x${big.height}`);
  assert.ok(big.scale < 1);
  // 16 frames in a full 4x4 rather than a ragged row when it costs little.
  const sixteen = framesLayout(100, 100, 16);
  assert.equal(sixteen.cols * sixteen.rows - 16, 0);
});

// ---- sprite metrics ----

const px = (img, x, y) => Array.from(img.rgba.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 3));

test("metrics: bounds, body, ground, a pivot between the feet, and engine values; the picture shows them", async () => {
  const dir = tmp();
  // Foot A planted in frames 1-4, foot B in 5-8: between them is x 32.
  const frames = range(8).map(t => figure(t, { liftA: t < 4 ? 0 : 4, liftB: t < 4 ? 4 : 0, sword: 20 }));
  const file = writeSheet(dir, "walk.png", frames, { cols: 4 });
  const out = await json(["toolbox", "sprite", "metrics", file, "--out", dir, "--overlay"]);
  assert.equal(out.grid_from, "stamp");
  assert.equal(out.frames.length, 8);
  // The feet bottom out on row 57 (top 12 + 40 + 6 - 1), 6 px above the frame's bottom.
  assert.deepEqual([out.ground.row, out.ground.above_bottom], [57, 6]);
  assert.equal(out.ground.feet, "the feet are 6 px above the frame's bottom edge");
  assert.equal(out.character, true);
  assert.equal(out.frames[0].bounds.w, 40, "the art with its sword");
  assert.deepEqual([out.frames[0].body.x, out.frames[0].body.w], [22, 20], "the body without it");
  assert.equal(out.body.width, 20);
  assert.deepEqual(out.pivot, { ...out.pivot, x: 32, y: 58, kind: "feet" });
  assert.deepEqual(out.godot.offset, [32 - 32, 32 - 58]);
  assert.deepEqual(out.godot.uncentered.offset, [-32, -58]);
  assert.deepEqual(out.unity, { pivot: [0.5, 0.0938] });
  assert.match(out.pixels_per_unit, /sprite compare/);
  assert.deepEqual(out.phaser.origin, [0.5, 0.9063]);
  assert.deepEqual(out.sort_point.from_pivot, [0, 0]);
  assert.equal(out.drift.verdict, "in place");
  assert.equal(out.hint.command, `ludo toolbox sprite export ${file} --engine unity --pivot feet`);

  // The picture: each frame under its number, the ground line and the pivot on it.
  const o = out.overlay;
  assert.deepEqual(o.shown, range(8).map(i => i + 1));
  const img = readPng(fs.readFileSync(o.image)).image;
  assert.deepEqual([img.width, img.height], [o.width, o.height]);
  const s = o.layout.scale;
  for (let k = 0; k < 8; k++) {
    const cx = o.layout.first_cell.x + (k % o.layout.cols) * o.layout.pitch.x;
    const cy = o.layout.first_cell.y + Math.floor(k / o.layout.cols) * o.layout.pitch.y;
    assert.deepEqual(px(img, cx + 1, cy + 58 * s), [255, 0, 200], `frame ${k + 1}: the ground line`);
    assert.deepEqual(px(img, cx + 32 * s, cy + 58 * s - 3), [255, 40, 40], `frame ${k + 1}: the pivot's upright`);
    assert.deepEqual(px(img, cx + 22 * s, cy + 30 * s), [255, 210, 0], `frame ${k + 1}: the body's left edge`);
    let ink = 0;
    for (let y = cy - 20; y < cy; y++) for (let x = cx; x < cx + 30; x++) if (px(img, x, y).join() === "232,232,240") ink++;
    assert.ok(ink > 5, `frame ${k + 1}: its number`);
  }
  const every = await json(["toolbox", "sprite", "metrics", file, "--out", dir, "--overlay", "--every", "3", "--quiet"]);
  assert.deepEqual(every.overlay.shown, [1, 4, 7]);
  assert.equal(every.hint, undefined);
  assert.equal((await run(["toolbox", "sprite", "metrics", file, "--every", "3"])).code, EXIT.USAGE);
  assert.equal((await run(["toolbox", "sprite", "metrics", file, "--out", dir, "--overlay", "--every", "9"])).code, EXIT.USAGE);

  // Feet on the frame's last row are said to be there.
  const low = writeSheet(dir, "low.png", range(4).map(t => {
    const f = figure(t);
    return { width: 64, height: 58, rgba: f.rgba.slice(0, 64 * 58 * 4) };
  }));
  assert.equal((await json(["toolbox", "sprite", "metrics", low])).ground.feet, "the feet are already at the frame's bottom edge");
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
  assert.equal(f.ground.feet, "it does not stand on a ground line");
  // The Y-sort point is the bottom of its art, under the pivot.
  assert.equal(f.sort_point.y, 20 + 9);
  const forced = await json(["toolbox", "sprite", "metrics", fx, "--pivot", "10,40"]);
  assert.deepEqual([forced.pivot.x, forced.pivot.y, forced.pivot.kind], [10, 40, "flag"]);
  assert.equal(forced.hint.command, `ludo toolbox sprite export ${fx} --engine unity --pivot 10,40`);
  const bad = await run(["toolbox", "sprite", "metrics", fx, "--pivot", "somewhere"]);
  assert.equal(bad.code, EXIT.USAGE);
  const empty = writeSheet(dir, "empty.png", [blank(16, 16), blank(16, 16)]);
  assert.equal((await run(["toolbox", "sprite", "metrics", empty])).code, EXIT.BAD_INPUT);
});

// ---- sprite collide ----

test("collide: the body's box and capsule from the pivot, the outline on request, and each engine's convention", async () => {
  const dir = tmp();
  const box = () => rect(blank(48, 48), 10, 5, 20, 30);
  const file = writeSheet(dir, "crate.png", [box(), box()]);
  const out = await json(["toolbox", "sprite", "collide", file, "--ppu", "10"]);
  assert.deepEqual([out.pivot.x, out.pivot.y], [20, 35]);
  assert.deepEqual(out.shapes, { box: { x: -10, y: -30, w: 20, h: 30 }, capsule: { x: 0, y: -15, radius: 10, height: 30, direction: "vertical" } });
  const { godot, unity, phaser, box2d } = out.engines;
  assert.deepEqual(godot.box, { position: [0, -15], size: [20, 30] });
  assert.match(godot.tres.box, /\[gd_resource type="RectangleShape2D" format=3\]\n\n\[resource\]\nsize = Vector2\(20, 30\)/);
  assert.equal(godot.polygon_node, undefined);
  // Unity and Box2D: units at --ppu, y up.
  assert.deepEqual(unity.box, { offset: [0, 1.5], size: [2, 3] });
  assert.deepEqual(unity.capsule, { offset: [0, 1.5], size: [2, 3], direction: "Vertical" });
  assert.deepEqual(box2d.capsule, { centre1: [0, 2], centre2: [0, 1], radius: 1 });
  // Phaser Arcade: the body's size and its offset from the frame's top-left.
  assert.deepEqual(phaser.arcade.size, [20, 30]);
  assert.deepEqual(phaser.arcade.offset, [10, 5]);
  assert.match(phaser.arcade.snippet, /setOrigin\(0\.4167, 0\.7292\);\nsprite\.body\.setSize\(20, 30, false\)\.setOffset\(10, 5\);/);
  assert.equal(phaser.matter, undefined);

  const all = await json(["toolbox", "sprite", "collide", file, "--ppu", "10", "--tolerance", "0.5", "--shapes", "box,capsule,hull,polygon"]);
  assert.deepEqual(all.shapes.polygons, [[[10, -30], [10, 0], [-10, 0], [-10, -30]]]);
  assert.equal(all.shapes.hull.length, 4);
  assert.match(all.engines.godot.polygon_node, /polygon = PackedVector2Array\(10, -30, 10, 0, -10, 0, -10, -30\)/);
  assert.ok(signedArea(all.engines.unity.polygon_paths[0]) > 0, "counter-clockwise in y-up");
  assert.equal(all.engines.box2d.hull.length, 4);
  // Matter: frame pixels, and the origin at the polygon's centre.
  assert.deepEqual(all.engines.phaser.matter.origin, [20 / 48, 20 / 48].map(v => Math.round(v * 1e4) / 1e4));
  assert.deepEqual(all.engines.phaser.matter.pivot_from_body, [0, 15]);

  const inset = await json(["toolbox", "sprite", "collide", file, "--inset", "2"]);
  assert.deepEqual(inset.shapes.box, { x: -8, y: -28, w: 16, h: 26 });
  assert.equal((await run(["toolbox", "sprite", "collide", file, "--inset", "40"])).code, EXIT.USAGE);
  assert.equal((await run(["toolbox", "sprite", "collide", file, "--shapes", "circle"])).code, EXIT.USAGE);
});

test("collide: a sword held out stays out of the box", async () => {
  const dir = tmp();
  const file = writeSheet(dir, "knight.png", range(4).map(t => figure(t, { sword: 20, bob: false })));
  const out = await json(["toolbox", "sprite", "collide", file]);
  // The body is x 22-42 from the pivot at 32; the sword reaches to 62.
  assert.deepEqual([out.shapes.box.x, out.shapes.box.w], [-10, 20]);
  assert.equal(out.hint.command, `ludo toolbox sprite export ${file} --engine unity --pivot feet --ppu 100`);
});

test("collide --per-frame prints each frame's box and saves the rest to a file; the union holds them all", async () => {
  const dir = tmp();
  const file = writeSheet(dir, "grow.png", [rect(blank(32, 32), 10, 20, 10, 10), rect(blank(32, 32), 6, 10, 20, 20)]);
  const per = await json(["toolbox", "sprite", "collide", file, "--per-frame", "--pivot", "16,30", "--out", dir]);
  assert.deepEqual(per.frames.map(f => f.box), [
    { x: -6, y: -10, w: 10, h: 10 },
    { x: -10, y: -20, w: 20, h: 20 }
  ]);
  assert.deepEqual(per.frames[1].phaser_arcade, { size: [20, 20], offset: [6, 10] });
  assert.equal(per.frames[0].engines, undefined, "engine values go to the file");
  const full = JSON.parse(fs.readFileSync(per.full, "utf8"));
  assert.deepEqual(full.frames[1].shapes.box, { x: -10, y: -20, w: 20, h: 20 });
  assert.equal(full.frames[0].engines.godot.tres, undefined, "no snippets per frame");
  const union = await json(["toolbox", "sprite", "collide", file, "--pivot", "16,30", "--out", dir, "--overlay"]);
  assert.deepEqual(union.shapes.box, { x: -10, y: -20, w: 20, h: 20 });
  assert.ok(fs.existsSync(union.overlay.image));
});

// ---- sprite compare ----

// The figure drawn at twice the size, in frames twice as big.
const doubled = t => {
  const small = figure(t);
  const out = blank(128, 128);
  for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) out.rgba.set(small.rgba.subarray(((y >> 1) * 64 + (x >> 1)) * 4, ((y >> 1) * 64 + (x >> 1)) * 4 + 4), (y * 128 + x) * 4);
  return out;
};

test("compare: one character's sheets at one size share a pixels per unit; one drawn bigger is flagged, with Ludo's re-export", async () => {
  const dir = tmp();
  const idle = writeSheet(dir, "hero_idle.png", range(4).map(t => figure(t)));
  const walk = writeSheet(dir, "hero_walk.png", range(4).map(t => figure(t, { liftA: t % 2 ? 4 : 0 })));
  const same = await json(["toolbox", "sprite", "compare", idle, walk]);
  assert.equal(same.consistent, true, JSON.stringify(same.characters));
  const [hero] = same.characters;
  assert.equal(hero.character, "hero");
  const h = hero.sheets[0].body_height;
  assert.deepEqual(hero.sheets.map(s => s.size_vs_reference), [1, 1]);
  assert.equal(hero.pixels_per_unit, h / 2);
  assert.match(hero.reference.assumed, /^2 units/);
  assert.equal(same.hint.command, `ludo toolbox sprite export ${hero.reference.sheet} --engine unity --pivot feet --ppu ${h / 2}`);

  const attack = writeSheet(dir, "hero_attack.png", range(4).map(doubled), { fps: 12 });
  const diff = await json(["toolbox", "sprite", "compare", idle, attack, "--reference", "hero_idle.png=1.8m"]);
  assert.equal(diff.consistent, false);
  const c = diff.characters[0];
  assert.deepEqual(c.outliers, [attack]);
  assert.ok(Math.abs(c.sheets[1].size_vs_reference - 2) < 0.03, String(c.sheets[1].size_vs_reference));
  assert.match(c.sheets[1].outlier, /^drawn \d+% larger than the reference/);
  assert.equal(c.pixels_per_unit, Math.round((h / 1.8) * 100) / 100);
  assert.equal(c.reference.assumed, undefined);
  assert.equal(c.checks.frame_size.same, false);
  assert.equal(c.checks.fps.same, false);
  // Palettes of pixel art are compared: these share every colour.
  assert.deepEqual(c.checks.palette.pixels_in_shared_colours, [1, 1]);
  assert.equal(diff.hint.command, "ludo sprite adjust --spritesheet-url <its spritesheet_url> --frame-size -9");

  // Another character is never an outlier of this one, unless they are said to be one.
  const slime = writeSheet(dir, "slime_idle.png", range(4).map(() => rect(blank(32, 32), 8, 20, 16, 10)));
  const two = await json(["toolbox", "sprite", "compare", idle, walk, slime]);
  assert.deepEqual(two.characters.map(x => [x.character, x.sheets.length]), [["hero", 2], ["slime", 1]]);
  assert.equal(two.consistent, true);
  const one = await json(["toolbox", "sprite", "compare", idle, walk, slime, "--character", "hero"]);
  assert.deepEqual(one.characters[0].outliers, [slime]);

  assert.equal((await run(["toolbox", "sprite", "compare", idle, "--reference", "nope.png=1.8m"])).code, EXIT.USAGE);
  assert.equal((await run(["toolbox", "sprite", "compare", idle, "--reference", "hero_idle.png=tall"])).code, EXIT.USAGE);
  assert.equal((await run(["toolbox", "sprite", "compare"])).code, EXIT.USAGE);
});

test("the tools are listed, have help, and the commands their hints name exist", async () => {
  const list = await run(["toolbox"]);
  for (const t of ["metrics", "collide", "compare"]) assert.match(list.stdout, new RegExp(`sprite .*\\b${t}\\b`));
  assert.doesNotMatch(list.stdout, /\bevents\b|sprite contact|waveform/);
  for (const cmd of [["toolbox", "sprite", "metrics"], ["toolbox", "sprite", "collide"], ["toolbox", "sprite", "compare"], ["toolbox", "sprite", "export"], ["sprite", "adjust"], ["image", "edit"]]) {
    const r = await run([...cmd, "--help"]);
    assert.equal(r.code, EXIT.OK, `${cmd.join(" ")}: ${r.stderr}`);
  }
  const help = (await run(["sprite", "adjust", "--help"])).stdout.replace(/\s+/g, " ");
  assert.match(help, /-9 is True Size: frames keep the size and position of the source's input image/);
  assert.notEqual((await run(["toolbox", "sprite", "events", "--help"])).code, EXIT.OK);
});
