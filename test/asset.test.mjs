// `ludo toolbox asset manifest` on synthetic folders: what it says each file
// is, the gaps it finds and the Ludo commands it points to, and the loaders
// it writes (Phaser's TypeScript type-checked against Phaser's own types, it
// and the asset pack loaded in Phaser 3 and 4, PixiJS's manifest loaded in
// PixiJS 8, in headless Chromium when one is installed).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { encodePng, withText } from "../dist/tty/png.js";
import { encodeWav } from "../dist/toolbox/wav.js";
import { EXIT } from "../dist/errors.js";
import { assetKeys, characterOf, dHash, soundKind } from "../dist/toolbox/asset.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const CLI = path.join(root, "dist", "cli.js");

function run(args, cwd = os.tmpdir()) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...process.env, LUDO_TELEMETRY: "0", LUDO_API_KEY: "", LUDO_CONFIG_DIR: path.join(os.tmpdir(), "ludo-asset-config"), LUDO_CACHE_DIR: path.join(os.tmpdir(), "ludo-asset-cache"), CLAUDECODE: "", CLAUDE_CODE_ENTRYPOINT: "" }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", d => (stdout += d));
    child.stderr.on("data", d => (stderr += d));
    child.on("close", code => resolve({ code, stdout, stderr, json: (() => { try { return JSON.parse(stdout); } catch { return undefined; } })() }));
  });
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ludo-asset-"));

// ---- Synthetic assets ----

// A figure per frame: a box `figH` tall standing `ground` px above the
// cell's bottom, swaying sideways and changing colour so frames differ.
function figureSheet({ cols, rows, frames = cols * rows, cw = 32, ch = 48, figH = 32, ground = 2, hue = 0 }) {
  const width = cols * cw;
  const height = rows * ch;
  const rgba = new Uint8Array(width * height * 4);
  for (let f = 0; f < frames; f++) {
    const x0 = (f % cols) * cw;
    const y0 = Math.floor(f / cols) * ch;
    const sway = Math.round(3 * Math.sin((2 * Math.PI * f) / frames));
    const left = Math.floor(cw / 4) + sway;
    for (let y = ch - ground - figH; y < ch - ground; y++) {
      for (let x = left; x < left + Math.floor(cw / 2); x++) {
        const shade = (y * 5 + f * 20 + hue) % 200;
        rgba.set([40 + shade, 200 - shade / 2, 90 + ((f * 30 + hue) % 150), 255], ((y0 + y) * width + x0 + x) * 4);
      }
    }
  }
  return { width, height, rgba };
}

function writeSheet(file, img, grid) {
  let buf = encodePng(img);
  if (grid) buf = withText(buf, "ludo:grid", JSON.stringify(grid));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  return file;
}

// An opaque texture that repeats exactly: whole periods of sines both ways.
function tile(w, h) {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = 128 + 60 * Math.sin((2 * Math.PI * 3 * x) / w) + 50 * Math.cos((2 * Math.PI * 2 * y) / h);
      rgba.set([v, v * 0.6, 40, 255], (y * w + x) * 4);
    }
  }
  return { width: w, height: h, rgba };
}

// A picture with transparency: a disc.
function disc(w, h) {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if ((x - w / 2) ** 2 + (y - h / 2) ** 2 < (Math.min(w, h) / 2.5) ** 2) rgba.set([220, 120 + Math.round((60 * x) / w), 60, 255], (y * w + x) * 4);
  return { width: w, height: h, rgba };
}

// A sine of whole cycles (wraps without a click), or a decaying blip.
function writeSound(file, { seconds, rate = 44100, channels = 1, bits = 16, kind = "tone", loop }) {
  const n = Math.round(seconds * rate);
  const ch = Array.from({ length: channels }, () => new Float32Array(n));
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    // A melody: a note every 0.4 s from a fixed run of pitches, faded in and
    // out at the ends so it wraps without a click, and no two stretches alike.
    const note = Math.floor(t / 0.4);
    const edge = Math.min(1, t / 0.02, (seconds - t) / 0.02);
    const v =
      kind === "tone"
        ? 0.4 * Math.sin((2 * Math.PI * Math.round(220 * seconds) * i) / n)
        : kind === "melody"
          ? 0.3 * edge * Math.sin(2 * Math.PI * (220 + ((note * 37) % 13) * 23 + note) * t)
          : 0.6 * Math.exp(-t * 30) * Math.sin(2 * Math.PI * 880 * t);
    for (const c of ch) c[i] = v;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, encodeWav({ rate, channels: ch }, { bits, ...(loop ? { loop } : {}) }));
  return file;
}

// A .gltf (or, named .glb, a GLB) with one triangle of the given height,
// joints and clips; `mesh: false` leaves only the skeleton and its clips, as
// Ludo's animation files are.
function writeGltf(file, { height = 1.8, minY = 0, joints = [], clips = [], scenes = 1, scene = 0, mesh = true }) {
  const nodes = [mesh ? { mesh: 0, name: "body", ...(joints.length ? { skin: 0 } : {}) } : { name: "root" }, ...joints.map(name => ({ name }))];
  const accessors = [{ count: 3, componentType: 5126, type: "VEC3", min: [0, minY, 0], max: [0.5, minY + height, 0.2] }, { count: 2, componentType: 5126, type: "SCALAR", min: [0], max: [1] }];
  const json = {
    asset: { version: "2.0" },
    ...(scene === null ? {} : { scene }),
    scenes: Array.from({ length: scenes }, () => ({ nodes: [0] })),
    nodes,
    ...(mesh ? { meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }] } : {}),
    accessors,
    ...(joints.length && mesh ? { skins: [{ joints: joints.map((_, i) => i + 1) }] } : {}),
    ...(clips.length ? { animations: clips.map(name => ({ name, channels: [{ sampler: 0, target: { node: 1, path: "rotation" } }], samplers: [{ input: 1, output: 1 }] })) } : {})
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!file.endsWith(".glb")) fs.writeFileSync(file, JSON.stringify(json));
  else {
    // GLB: a 12-byte header, then the JSON chunk padded with spaces to 4 bytes.
    const text = Buffer.from(JSON.stringify(json).padEnd(Math.ceil(JSON.stringify(json).length / 4) * 4, " "));
    const head = Buffer.alloc(20);
    head.write("glTF", 0);
    head.writeUInt32LE(2, 4);
    head.writeUInt32LE(20 + text.length, 8);
    head.writeUInt32LE(text.length, 12);
    head.write("JSON", 16);
    fs.writeFileSync(file, Buffer.concat([head, text]));
  }
  return file;
}

// The folder most tests read: a character's animations, a picture, a
// texture, duplicates, sounds and a model.
function gameFolder() {
  const dir = tmp();
  writeSheet(path.join(dir, "sprites/hero_walk.png"), figureSheet({ cols: 4, rows: 2 }), { cols: 4, rows: 2, frames: 8, fps: 12 });
  writeSheet(path.join(dir, "sprites/hero_walk2.png"), figureSheet({ cols: 4, rows: 2, hue: 40 }), { cols: 4, rows: 2, frames: 8, fps: 12 });
  writeSheet(path.join(dir, "sprites/hero_idle.png"), figureSheet({ cols: 3, rows: 2, frames: 6, hue: 80 }), { cols: 3, rows: 2, frames: 6, fps: 8 });
  writeSheet(path.join(dir, "sprites/slime_hop.png"), figureSheet({ cols: 4, rows: 1, cw: 64, ch: 32, figH: 12 }), { cols: 4, rows: 1, frames: 4, fps: 10 });
  writeSheet(path.join(dir, "ui/coin.png"), disc(40, 40));
  fs.copyFileSync(path.join(dir, "ui/coin.png"), path.join(dir, "ui/coin-copy.png"));
  // The same picture again with a tiny colour change: a different file
  // that looks the same.
  const almost = disc(40, 40);
  for (let i = 0; i < almost.rgba.length; i += 4) if (almost.rgba[i + 3]) almost.rgba[i] -= 3;
  writeSheet(path.join(dir, "ui/coin-old.png"), almost);
  writeSheet(path.join(dir, "textures/lava.png"), tile(96, 96));
  writeSound(path.join(dir, "audio/blip.wav"), { seconds: 0.3, kind: "blip" });
  writeSound(path.join(dir, "audio/overworld.wav"), { seconds: 24, kind: "melody" });
  writeGltf(path.join(dir, "models/knight.gltf"), { joints: ["Hips", "Spine", "Head"], clips: ["Walk"] });
  fs.writeFileSync(path.join(dir, "notes.txt"), "not an asset");
  fs.mkdirSync(path.join(dir, ".git"));
  fs.writeFileSync(path.join(dir, ".git/HEAD.png"), "hidden");
  return dir;
}

// ---- manifest ----

test("manifest says what each file is, with its grid, sizes and hashes", async () => {
  const dir = gameFolder();
  const r = await run(["toolbox", "asset", "manifest", dir]);
  assert.equal(r.code, EXIT.OK, r.stderr);
  const m = r.json;
  const by = Object.fromEntries(m.assets.map(a => [a.path, a]));
  assert.equal(m.count, 11);
  assert.deepEqual(m.skipped, ["notes.txt"]);
  assert.equal(by["sprites/hero_walk.png"].kind, "spritesheet");
  assert.deepEqual(by["sprites/hero_walk.png"].grid, { cols: 4, rows: 2, frames: 8, frame_width: 32, frame_height: 48, fps: 12, from: "stamp" });
  assert.equal(by["sprites/hero_walk.png"].duration, 0.667);
  assert.equal(by["ui/coin.png"].kind, "image");
  assert.equal(by["textures/lava.png"].kind, "texture");
  assert.match(by["textures/lava.png"].reason, /edges meet/);
  assert.equal(by["audio/blip.wav"].kind, "sfx");
  assert.equal(by["audio/overworld.wav"].kind, "music");
  assert.match(by["audio/overworld.wav"].reason, /wraps without a click/);
  assert.equal(by["models/knight.gltf"].kind, "model");
  assert.deepEqual(by["models/knight.gltf"].model.joints, ["Hips", "Spine", "Head"]);
  assert.match(by["ui/coin.png"].sha256, /^[0-9a-f]{64}$/);
  assert.equal(by["ui/coin.png"].bytes, fs.statSync(path.join(dir, "ui/coin.png")).size);
  assert.ok(!m.assets.some(a => "file" in a || "phash" in a || "clipTargets" in a));
  // One character, one of each thing: nothing to compare, so no gaps.
  assert.deepEqual(m.gaps, []);
  assert.match(r.json.hint.command, /^ludo toolbox sprite export .*--engine godot$/);
});

test("manifest groups a character's animations and finds duplicates", async () => {
  const r = await run(["toolbox", "asset", "manifest", gameFolder()]);
  const { groups, duplicates } = r.json;
  assert.deepEqual(groups, [
    {
      character: "hero",
      frame_width: 32,
      frame_height: 48,
      animations: [
        { path: "sprites/hero_idle.png", action: "idle", frames: 6, frame_width: 32, frame_height: 48 },
        { path: "sprites/hero_walk.png", action: "walk", frames: 8, frame_width: 32, frame_height: 48 },
        { path: "sprites/hero_walk2.png", action: "walk", take: 2, frames: 8, frame_width: 32, frame_height: 48 }
      ]
    }
  ]);
  assert.deepEqual(duplicates.find(d => d.match === "identical").files, ["ui/coin-copy.png", "ui/coin.png"]);
  const look = duplicates.find(d => d.match === "looks the same");
  // Byte-identical copies are listed with the picture they look like.
  assert.deepEqual(look.files, ["ui/coin-copy.png", "ui/coin.png", "ui/coin-old.png"]);
  // Two takes of a walk are alike but not duplicates.
  assert.ok(!duplicates.some(d => d.files.includes("sprites/hero_walk2.png")));
});

test("a sheet without a stamp is detected, and a file that does not read is listed with its error", async () => {
  const dir = tmp();
  writeSheet(path.join(dir, "run.png"), figureSheet({ cols: 6, rows: 1 }));
  fs.writeFileSync(path.join(dir, "broken.png"), "not a png");
  const r = await run(["toolbox", "asset", "manifest", dir]);
  assert.equal(r.code, EXIT.OK, r.stderr);
  const [broken, sheet] = r.json.assets;
  assert.equal(broken.reason, "could not be read");
  assert.ok(broken.error);
  assert.equal(sheet.grid.from, "detected");
  assert.equal(sheet.grid.frames, 6);
  assert.ok(sheet.grid.confidence >= 0.5);
  assert.equal(sheet.fps, undefined);
});

test("unit: keys, characters, sound kinds and the difference hash", () => {
  assert.deepEqual(assetKeys(["sprites/Hero Walk.png", "sprites/hero_walk.webp", "fp_hero/animateSprite-29402c81-1.png", "3d/knight.glb", "a.png", "a.PNG"]), [
    "sprites_hero_walk_png",
    "sprites_hero_walk_webp",
    "fp_hero",
    "asset_3d_knight",
    "a_png",
    "a_png_2"
  ]);
  // A folder of one generation names it; a models/ with other files in it does not.
  assert.deepEqual(assetKeys(["knight_walk/animateSprite-29402c81-1.png", "knight_walk/animateSprite-29402c81-1.gif", "models/create3DModel-2f4066c5-1.glb", "models/goblin.glb"]), [
    "knight_walk_png",
    "knight_walk_gif",
    "models_create3dmodel_2f4066c5_1",
    "models_goblin"
  ]);
  assert.deepEqual(characterOf("fp_hero_walk2/animateSprite-61b55cee-1.png"), { character: "fp_hero", action: "walk", take: 2 });
  assert.deepEqual(characterOf("knight/attack_heavy.png"), { character: "knight", action: "attack_heavy" });
  assert.equal(soundKind("audio/voice-wizard.mp3", 4, false, 1, { low: 0.1, pauses: 0 }).kind, "voice");
  assert.equal(soundKind("a/x.wav", 0.4, false, 1, { low: 0, pauses: 0 }).kind, "sfx");
  assert.equal(soundKind("a/x.wav", 4, false, 1, { low: 0.45, pauses: 0.3 }).kind, "voice");
  assert.equal(soundKind("a/x.wav", 30, true, 1, { low: 0.1, pauses: 0.01 }).kind, "music");
  assert.equal(soundKind("a/x.wav", 10, true, 1, { low: 0.1, pauses: 0 }).kind, "ambience");
  assert.equal(soundKind("a/x.wav", 20, false, 2, { low: 0.1, pauses: 0 }).reason, "2 copies of one 10 s loop written out");
  // Ludo's ambiences are a 10 s loop written twice: 20 s, still an ambience,
  // renamed or not. A 30 s loop written twice is music.
  assert.equal(soundKind("audio/city.mp3", 20, true, 2, { low: 0.1, pauses: 0 }).kind, "ambience");
  assert.equal(soundKind("audio/theme2.mp3", 60, true, 2, { low: 0.1, pauses: 0 }).kind, "music");
  const a = disc(40, 40);
  assert.equal(dHash(a).length, 64);
  // Twice the size: (nearly) the same bits.
  const diff = dHash(a).reduce((n, v, i) => n + (v !== dHash(disc(80, 80))[i] ? 1 : 0), 0);
  assert.ok(diff <= 4, `${diff} bits differ`);
});

// ---- --emit ----

// A small figure in a big empty frame, its arm in another place in each
// frame: `raise` lifts it, else it reaches forward. Two such sheets are two
// moves of one character, not copies of one picture.
function smallMoveSheet(raise) {
  const [cols, rows, cw, ch] = [4, 2, 128, 128];
  const width = cols * cw;
  const height = rows * ch;
  const rgba = new Uint8Array(width * height * 4);
  const box = (x0, y0, w, h, c) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) rgba.set(c, (y * width + x) * 4);
  };
  for (let f = 0; f < cols * rows; f++) {
    const [fx, fy] = [(f % cols) * cw, Math.floor(f / cols) * ch];
    box(fx + 56, fy + 94, 16, 30, [70, 90, 160, 255]);
    const t = f / (cols * rows - 1);
    if (raise) box(fx + 72, fy + Math.round(94 - 50 * t), 10, 50, [220, 200, 60, 255]);
    else box(fx + 72, fy + 98, Math.round(10 + 50 * t), 10, [220, 200, 60, 255]);
  }
  return { width, height, rgba };
}

test("two moves of a small figure in big frames are not taken for copies", async () => {
  const dir = tmp();
  const grid = { cols: 4, rows: 2, frames: 8, fps: 10 };
  writeSheet(path.join(dir, "knight_attack.png"), smallMoveSheet(true), grid);
  writeSheet(path.join(dir, "knight_reach.png"), smallMoveSheet(false), grid);
  const r = await run(["toolbox", "asset", "manifest", dir]);
  assert.equal(r.code, EXIT.OK, r.stderr);
  assert.deepEqual(r.json.duplicates, []);
});

test("--emit writes Phaser, PixiJS and JSON loaders with stable keys, one file of each set of duplicates", async () => {
  const dir = gameFolder();
  const out = path.join(tmp(), "gen");
  const r = await run(["toolbox", "asset", "manifest", dir, "--emit", "phaser", "--emit", "pixi", "--emit", "json", "--base", "assets", "--out", out]);
  assert.equal(r.code, EXIT.OK, r.stderr);
  assert.deepEqual(r.json.emitted.map(f => path.basename(f)), ["assets-pack.json", "assets.ts", "assets-manifest.json", "assets.json"]);
  const phaser = fs.readFileSync(path.join(out, "assets.ts"), "utf8");
  assert.match(phaser, /SpritesHeroWalk = "sprites_hero_walk",/);
  assert.match(phaser, /scene\.load\.spritesheet\(AssetKey\.SpritesHeroWalk, "sprites\/hero_walk\.png", \{ frameWidth: 32, frameHeight: 48, endFrame: 7 \}\);/);
  assert.match(phaser, /scene\.load\.audio\(AssetKey\.AudioOverworld, "audio\/overworld\.wav"\);/);
  assert.match(phaser, /path = "assets\/"/);
  assert.match(phaser, /\/\/ models\/knight\.gltf: a 3D model; Phaser has no glTF loader/);
  const pack = JSON.parse(fs.readFileSync(path.join(out, "assets-pack.json"), "utf8"));
  assert.equal(pack.assets.path, "assets/");
  assert.deepEqual(pack.assets.files.find(f => f.key === "sprites_hero_walk"), { type: "spritesheet", key: "sprites_hero_walk", url: "sprites/hero_walk.png", frameConfig: { frameWidth: 32, frameHeight: 48, endFrame: 7 } });
  assert.deepEqual(pack.meta.sheets.sprites_hero_walk, { frames: 8, frameRate: 12 });
  // Of the byte-identical coins each loader queues one; the coin that only
  // looks the same, under another name, is a file of its own and loads.
  const coins = ["ui/coin.png", "ui/coin-copy.png", "ui/coin-old.png"];
  assert.equal(pack.assets.files.filter(f => coins.includes(f.url)).length, 2);
  assert.ok(pack.assets.files.some(f => f.url === "ui/coin-old.png"));
  assert.equal(coins.filter(c => phaser.includes(`, "${c}");`)).length, 2);
  assert.equal(coins.filter(c => phaser.includes(`// ${c}: left out, the same picture as`)).length, 1);
  const pixi = JSON.parse(fs.readFileSync(path.join(out, "assets-manifest.json"), "utf8"));
  assert.deepEqual(pixi.bundles.find(b => b.name === "textures").assets, [{ alias: "textures_lava", src: "assets/textures/lava.png" }]);
  assert.equal(pixi.bundles.find(b => b.name === "images").assets.length, 2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, "assets.json"), "utf8")).count, 11);
  // Keys are the same run after run; the loader overwrites its own copy.
  const again = await run(["toolbox", "asset", "manifest", dir, "--emit", "phaser", "--base", "assets", "--out", out]);
  assert.equal(again.code, EXIT.OK);
  assert.equal(fs.readFileSync(path.join(out, "assets.ts"), "utf8"), phaser);
  assert.ok(!fs.existsSync(path.join(out, "assets-2.ts")));
});

test("a PNG and its WebP copy load once, under the plain key, with the stamp's frame rate", async () => {
  const dir = tmp();
  const png = writeSheet(path.join(dir, "sprites/hero_walk.png"), figureSheet({ cols: 4, rows: 2 }), { cols: 4, rows: 2, frames: 8, fps: 12 });
  const conv = await run(["toolbox", "image", "convert", png, "--to", "webp", "--out", path.join(dir, "sprites")]);
  assert.equal(conv.code, EXIT.OK, conv.stderr);
  const out = path.join(tmp(), "gen");
  const r = await run(["toolbox", "asset", "manifest", dir, "--emit", "phaser", "--base", "", "--out", out]);
  assert.equal(r.code, EXIT.OK, r.stderr);
  assert.deepEqual(r.json.duplicates.map(d => d.files), [["sprites/hero_walk.png", "sprites/hero_walk.webp"]]);
  const pack = JSON.parse(fs.readFileSync(path.join(out, "assets-pack.json"), "utf8"));
  assert.equal(pack.assets.files.length, 1);
  assert.equal(pack.assets.files[0].key, "sprites_hero_walk");
  assert.deepEqual(pack.meta.sheets.sprites_hero_walk, { frames: 8, frameRate: 12 });
  assert.equal(pack.assets.path, undefined, "an empty --base leaves the loader's own path");
  assert.ok(r.json.notes.some(n => /left out, the same picture as/.test(n)));
});

test("--emit godot and unity point to sprite export", async () => {
  const dir = tmp();
  writeSheet(path.join(dir, "a.png"), disc(16, 16));
  for (const engine of ["godot", "unity"]) {
    const r = await run(["toolbox", "asset", "manifest", dir, "--emit", engine]);
    assert.equal(r.code, EXIT.USAGE);
    assert.ok(r.stderr.includes(`--emit takes phaser, pixi, json (got "${engine}"). For ${engine === "godot" ? "Godot" : "Unity"}, write each sheet's engine files: ludo toolbox sprite export <sheet> --engine ${engine}`), r.stderr);
  }
  // --engine names only the engines files are written for.
  const other = await run(["toolbox", "sprite", "export", path.join(dir, "a.png"), "--engine", "unreal"]);
  assert.equal(other.code, EXIT.USAGE);
  assert.match(other.stderr, /--engine supports: godot, texturepacker, unity/);
});

test("the Phaser loader type-checks against Phaser 3's and Phaser 4's own types", async () => {
  const dir = gameFolder();
  const out = path.join(tmp(), "gen");
  await run(["toolbox", "asset", "manifest", dir, "--emit", "phaser", "--out", out]);
  for (const pkg of ["phaser", "phaser3"]) {
    const program = ts.createProgram([path.join(out, "assets.ts")], {
      strict: true,
      noEmit: true,
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      skipLibCheck: true,
      types: [],
      baseUrl: root,
      paths: { phaser: [`node_modules/${pkg}/types/phaser.d.ts`] }
    });
    const errors = ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    assert.deepEqual(errors, [], pkg);
  }
});

// Phaser and PixiJS loading the emitted files in headless Chromium.
let browser;
let server;
let served;
before(async () => {
  try {
    const { chromium } = await import("playwright-core");
    browser = await chromium.launch();
  } catch (err) {
    if (process.env.LUDO_REQUIRE_ENGINES) throw err;
    browser = undefined;
    return;
  }
  served = tmp();
  const LIBS = { phaser4: "node_modules/phaser/dist/phaser.min.js", phaser3: "node_modules/phaser3/dist/phaser.min.js", pixi8: "node_modules/pixi.js/dist/pixi.min.js" };
  server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const lib = url.pathname.match(/^\/lib\/(\w+)\.js$/)?.[1];
    const file = lib ? path.join(root, LIBS[lib]) : path.join(served, decodeURIComponent(url.pathname));
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end();
    const type = file.endsWith(".js") ? "text/javascript" : file.endsWith(".json") ? "application/json" : file.endsWith(".png") ? "image/png" : "text/html";
    res.writeHead(200, { "content-type": type }).end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  fs.writeFileSync(path.join(served, "index.html"), "<!doctype html><body></body>");
});
after(async () => {
  await browser?.close();
  server?.close();
});

async function inPage(lib, fn, arg) {
  const page = await browser.newPage();
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
    await page.addScriptTag({ url: `/lib/${lib}.js` });
    return await page.evaluate(fn, arg);
  } finally {
    await page.close();
  }
}

// Images only: headless pages have no audio to decode.
function pictureFolder() {
  const dir = path.join(served, "game");
  writeSheet(path.join(dir, "sprites/hero_walk.png"), figureSheet({ cols: 4, rows: 2 }), { cols: 4, rows: 2, frames: 7, fps: 12 });
  writeSheet(path.join(dir, "textures/lava.png"), tile(64, 64));
  return dir;
}

for (const lib of ["phaser4", "phaser3"]) {
  test(`${lib} loads what the emitted preload() queues, with each sheet's frames`, async t => {
    if (!browser) return t.skip("no Chromium for playwright-core (npx playwright-core install chromium)");
    const dir = pictureFolder();
    const out = path.join(served, "gen");
    const r = await run(["toolbox", "asset", "manifest", dir, "--emit", "phaser", "--base", "/game", "--out", out]);
    assert.equal(r.code, EXIT.OK, r.stderr);
    const js = ts.transpileModule(fs.readFileSync(path.join(out, "assets.ts"), "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText;
    fs.writeFileSync(path.join(out, "assets.js"), js);
    const got = await inPage(
      lib,
      async () => {
        const mod = await import("/gen/assets.js");
        return new Promise((resolve, reject) => {
          setTimeout(() => reject(new Error("Phaser did not finish loading")), 15000);
          // eslint-disable-next-line no-undef
          new Phaser.Game({
            // eslint-disable-next-line no-undef
            type: Phaser.CANVAS,
            width: 16,
            height: 16,
            banner: false,
            audio: { noAudio: true },
            scene: {
              preload() {
                mod.preload(this);
              },
              create() {
                const keys = Object.values(mod.AssetKey);
                const textures = keys.map(k => [k, this.textures.exists(k) ? this.textures.get(k).frameTotal - 1 : -1]);
                // The asset pack, in a fresh loader run: the same textures.
                for (const k of keys) this.textures.remove(k);
                this.load.pack("ludo", "/gen/assets-pack.json");
                this.load.once("complete", () => resolve({ path: this.load.path, textures, packed: keys.map(k => [k, this.textures.exists(k) ? this.textures.get(k).frameTotal - 1 : -1]), sheets: mod.SHEETS, packSheets: this.cache.json.get("ludo").meta.sheets }));
                this.load.start();
              }
            }
          });
        });
      },
      undefined
    );
    // frameTotal counts the __BASE frame too.
    assert.deepEqual(got.textures, [
      ["sprites_hero_walk", 7],
      ["textures_lava", 0]
    ]);
    assert.deepEqual(got.packed, got.textures);
    assert.deepEqual(got.sheets, { sprites_hero_walk: { frames: 7, frameRate: 12 } });
    assert.deepEqual(got.packSheets, got.sheets);
    assert.equal(got.path, "", "preload() puts the loader's path back");
  });
}

test("pixi8 loads the emitted manifest's bundles", async t => {
  if (!browser) return t.skip("no Chromium for playwright-core (npx playwright-core install chromium)");
  const dir = pictureFolder();
  const out = path.join(served, "gen-pixi");
  // With an atlas next to the sheet, the manifest points at the atlas.
  await run(["toolbox", "sprite", "export", path.join(dir, "sprites/hero_walk.png"), "--engine", "texturepacker"]);
  const r = await run(["toolbox", "asset", "manifest", dir, "--emit", "pixi", "--base", "/game", "--out", out]);
  assert.equal(r.code, EXIT.OK, r.stderr);
  const manifest = JSON.parse(fs.readFileSync(path.join(out, "assets-manifest.json"), "utf8"));
  assert.deepEqual(manifest.bundles.find(b => b.name === "spritesheets").assets, [{ alias: "sprites_hero_walk", src: "/game/sprites/hero_walk.json" }]);
  const got = await inPage(
    "pixi8",
    async m => {
      // eslint-disable-next-line no-undef
      await PIXI.Assets.init({ manifest: m });
      // eslint-disable-next-line no-undef
      const sheets = await PIXI.Assets.loadBundle("spritesheets");
      // eslint-disable-next-line no-undef
      const textures = await PIXI.Assets.loadBundle("textures");
      return { frames: Object.keys(sheets.sprites_hero_walk.textures).length, lava: [textures.textures_lava.width, textures.textures_lava.height] };
    },
    manifest
  );
  assert.deepEqual(got, { frames: 7, lava: [64, 64] });
});

// ---- gaps ----

test("gaps: a move most other characters have, sheets without their sound, an unrigged and an unanimated model", async () => {
  const dir = tmp();
  // Each move its own frame count, so none passes for another's duplicate.
  const MOVES = { idle: 3, walk: 4, attack: 5 };
  for (const c of ["hero", "rogue"]) for (const [move, cols] of Object.entries(MOVES)) writeSheet(path.join(dir, `sprites/${c}_${move}.png`), figureSheet({ cols, rows: 1, hue: c.length * 40 }), { cols, rows: 1, frames: cols, fps: 8 });
  // The slime walks only: hero and rogue both idle and attack.
  writeSheet(path.join(dir, "sprites/slime_walk.png"), figureSheet({ cols: 4, rows: 1, cw: 40, ch: 20, figH: 10 }));
  // Some sheets have their sounds, by name.
  writeSound(path.join(dir, "audio/hero_walk_steps.wav"), { seconds: 0.3, kind: "blip" });
  writeSound(path.join(dir, "audio/rogue_attack.wav"), { seconds: 0.3, kind: "blip" });
  writeGltf(path.join(dir, "models/knight.glb"), { joints: ["Hips", "Spine", "Head"] });
  writeGltf(path.join(dir, "models/barrel.glb"), { height: 0.9 });
  const r = await run(["toolbox", "asset", "manifest", dir]);
  assert.equal(r.code, EXIT.OK, r.stderr);
  const gaps = r.json.gaps.map(g => `${g.kind} ${g.subject} ${g.missing}`);
  assert.deepEqual(gaps, [
    "animation slime attack",
    "animation slime idle",
    "sound sprites/hero_attack.png sound",
    "sound sprites/hero_idle.png sound",
    "sound sprites/rogue_idle.png sound",
    "sound sprites/rogue_walk.png sound",
    // The slime has no sound of its own, and nothing says it should.
    "rig models/barrel.glb rig",
    "3d-animation models/knight.glb animation"
  ]);
  const by = Object.fromEntries(r.json.gaps.map(g => [`${g.kind} ${g.subject} ${g.missing}`, g]));
  assert.equal(by["animation slime idle"].detail, "slime has walk but no idle, which hero and rogue have");
  assert.deepEqual(by["animation slime idle"].evidence, ["sprites/hero_idle.png", "sprites/rogue_idle.png"]);
  assert.equal(by["animation slime idle"].hint.command, 'ludo sprite animate --initial-image <a frame of slime> --motion-prompt "idle"');
  // A Ludo sheet (its stamp) gets create-audio, the evidence its character's own sound.
  assert.equal(by["sound sprites/hero_idle.png sound"].hint.command, "ludo sprite create-audio --spritesheet-video-url <its video_url>");
  assert.deepEqual(by["sound sprites/hero_idle.png sound"].evidence, ["audio/hero_walk_steps.wav"]);
  assert.equal(by["sound sprites/hero_idle.png sound"].detail, "sprites/hero_idle.png has no sound, while 1 other sheet of hero has its");
  assert.match(by["rig models/barrel.glb rig"].hint.command, /^ludo model rig --model .*barrel\.glb$/);
  assert.match(by["3d-animation models/knight.glb animation"].hint.command, /^ludo model animate-preset --model .*knight\.glb --preset-id <id>$/);
  assert.equal(r.json.hint.command, by["animation slime attack"].hint.command);
});

test("gaps need evidence: an animation file for the rig, Ludo's download keeping the video but no audio", async () => {
  const dir = tmp();
  // Ludo's download of a forge sheet: the sheet and its video, no audio.
  const job = path.join(dir, "sprites/bat_fly");
  writeSheet(path.join(job, "animateSprite-1a2b3c4d-1.png"), figureSheet({ cols: 4, rows: 1 }), { cols: 4, rows: 1, frames: 4, fps: 10 });
  fs.writeFileSync(path.join(job, "animateSprite-1a2b3c4d-2.mp4"), "not really a video");
  // A hydra download: its audio sits with it.
  const hydra = path.join(dir, "sprites/bat_dive");
  writeSheet(path.join(hydra, "animateSprite-9f8e7d6c-1.png"), figureSheet({ cols: 4, rows: 1, hue: 90 }), { cols: 4, rows: 1, frames: 4, fps: 10 });
  fs.writeFileSync(path.join(hydra, "animateSprite-9f8e7d6c-2.mp4"), "not really a video");
  writeSound(path.join(hydra, "animateSprite-9f8e7d6c-3.wav"), { seconds: 0.3, kind: "blip" });
  // A rigged knight, and Ludo's animation file for its bones.
  writeGltf(path.join(dir, "models/knight.glb"), { joints: ["Hips", "Spine", "Head"] });
  writeGltf(path.join(dir, "models/knight_wave.glb"), { joints: ["Hips", "Spine", "Head"], clips: ["Wave"], mesh: false });
  const r = await run(["toolbox", "asset", "manifest", dir]);
  assert.equal(r.code, EXIT.OK, r.stderr);
  assert.deepEqual(r.json.gaps.map(g => `${g.kind} ${g.subject}`), ["sound sprites/bat_fly/animateSprite-1a2b3c4d-1.png"]);
  const [gap] = r.json.gaps;
  assert.equal(gap.detail, "sprites/bat_fly/animateSprite-1a2b3c4d-1.png has no sound: its Ludo download has its video (sprites/bat_fly/animateSprite-1a2b3c4d-2.mp4) but no audio");
  assert.equal(gap.hint.command, "ludo sprite create-audio --spritesheet-video-url <its video_url>");
  // One prop alone, one character with one move: nothing to compare.
  const alone = tmp();
  writeGltf(path.join(alone, "barrel.glb"), {});
  writeSheet(path.join(alone, "hero_walk.png"), figureSheet({ cols: 4, rows: 1 }), { cols: 4, rows: 1, frames: 4, fps: 10 });
  assert.deepEqual((await run(["toolbox", "asset", "manifest", alone])).json.gaps, []);
});

// ---- What the folder records, and the findings it settles ----

const DAY = 86400e3;
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
};
// One Ludo download as the CLI saves it: the sheet (stamped), its video, its
// sound when it has one, and the asset log beside them.
function download(dir, folder, { op = "animateSprite", job, model, days = 0, sound = false, cols = 4, hue = 0 }) {
  const at = path.join(dir, folder);
  const files = [`${op}-${job}-1.png`, `${op}-${job}-2.mp4`, ...(sound ? [`${op}-${job}-3.wav`] : [])];
  writeSheet(path.join(at, files[0]), figureSheet({ cols, rows: 1, hue }), { cols, rows: 1, frames: cols, fps: 10 });
  fs.writeFileSync(path.join(at, files[1]), "not really a video");
  if (sound) writeSound(path.join(at, files[2]), { seconds: 0.3, kind: "blip" });
  const created_at = new Date(Date.now() - days * DAY).toISOString();
  writeJson(path.join(at, "ludo-assets.json"), { assets: files.map(file => ({ file, command: "sprite animate", operation_id: op, body: model ? { model } : {}, job_id: `${job}-0000-0000-0000-000000000000`, created_at })) });
  return at;
}

test("loaders keep sheets that only look alike: distinct moves of one small character all load", async () => {
  const dir = tmp();
  // Three moves drawn alike enough that their hashes match frame by frame
  // (as True Size sheets of one small character can): a disc per frame,
  // shrinking, a shade darker in each.
  for (const [i, move] of ["idle", "walk", "attack"].entries()) {
    const cw = 40;
    const img = { width: 4 * cw, height: cw, rgba: new Uint8Array(4 * cw * cw * 4) };
    for (let f = 0; f < 4; f++) {
      const d = disc(cw - 4 * f, cw - 4 * f);
      for (let y = 0; y < d.height; y++) for (let x = 0; x < d.width; x++) if (d.rgba[(y * d.width + x) * 4 + 3]) img.rgba.set([d.rgba[(y * d.width + x) * 4] - 3 * i, d.rgba[(y * d.width + x) * 4 + 1], 60, 255], ((y + 2 * f) * img.width + f * cw + x + 2 * f) * 4);
    }
    writeSheet(path.join(dir, `knight_${move}.png`), img, { cols: 4, rows: 1, frames: 4, fps: 10 });
  }
  const out = path.join(tmp(), "gen");
  const r = await run(["toolbox", "asset", "manifest", dir, "--emit", "phaser", "--out", out]);
  assert.equal(r.code, EXIT.OK, r.stderr);
  assert.deepEqual(r.json.duplicates, [{ match: "looks the same", files: ["knight_attack.png", "knight_idle.png", "knight_walk.png"], difference: r.json.duplicates[0]?.difference }]);
  const pack = JSON.parse(fs.readFileSync(path.join(out, "assets-pack.json"), "utf8"));
  assert.deepEqual(pack.assets.files.map(f => f.url), ["knight_attack.png", "knight_idle.png", "knight_walk.png"]);
  assert.ok(!r.json.notes?.some(n => /left out/.test(n)));
});

test("a job saved beside its files: its sound is the sheet's sound, and Hydra's sound is a sound effect", async () => {
  const dir = tmp();
  const job = (name, { audio, days = 0 }) => {
    writeSheet(path.join(dir, `${name}_0.png`), figureSheet({ cols: 4, rows: 1, hue: name.charCodeAt(5) * 7 }), { cols: 4, rows: 1, frames: 4, fps: 10 });
    fs.writeFileSync(path.join(dir, `${name}_1.mp4`), "not really a video");
    const result = { spritesheet_url: `https://x/${name}.png`, video_url: `https://x/${name}.mp4`, ...(audio ? { audio_url: `https://x/${name}.wav` } : {}), num_frames: 4 };
    writeJson(path.join(dir, `${name}_job.json`), { id: `${name}-job`, task_type: "animateSprite", status: "succeeded", created_at: Date.now() - days * DAY, result });
  };
  job("anim_attack", { audio: true });
  writeSound(path.join(dir, "anim_attack_2.wav"), { seconds: 2.5, kind: "melody" });
  // Its sound not downloaded: the job still made one.
  job("anim_walk", { audio: true });
  // Forge's: no sound. One made today, one ten days ago.
  job("anim_idle", { audio: false });
  job("anim_jump", { audio: false, days: 10 });
  const r = await run(["toolbox", "asset", "manifest", dir]);
  assert.equal(r.code, EXIT.OK, r.stderr);
  const sound = r.json.assets.find(a => a.path === "anim_attack_2.wav");
  assert.equal(sound.kind, "sfx");
  assert.equal(sound.reason, "the sound Ludo's animateSprite made with its sheet (anim_attack_job.json)");
  assert.deepEqual(sound.made, { operation: "animateSprite", job: "anim_attack-job", created_at: sound.made.created_at, record: "anim_attack_job.json" });
  const by = Object.fromEntries(r.json.gaps.map(g => [g.subject, g]));
  assert.deepEqual(Object.keys(by), ["anim_idle_0.png", "anim_jump_0.png"]);
  // The job keeps the video_url: create-audio gets it, while it is new enough.
  assert.equal(by["anim_idle_0.png"].hint.command, "ludo sprite create-audio --spritesheet-video-url https://x/anim_idle.mp4");
  assert.equal(by["anim_jump_0.png"].hint.command, 'ludo audio sound-effect --description "<what it doing jump sounds like>"');
  assert.match(by["anim_jump_0.png"].hint.text, /create-audio takes only sheets made in the last 7 days, and this one was made on \d{4}-\d\d-\d\d$/);
});

test("the asset log: create-audio only for the sheets it takes, adjusted copies with their source, the PNG named", async () => {
  const dir = tmp();
  const walk = download(dir, "hero_walk", { job: "aaaaaaaa", model: "forge-pixel", cols: 4 });
  // The WebP Ludo sent, beside the PNG copy.
  const conv = await run(["toolbox", "image", "convert", path.join(walk, "animateSprite-aaaaaaaa-1.png"), "--to", "webp", "--out", walk]);
  assert.equal(conv.code, EXIT.OK, conv.stderr);
  download(dir, "hero_walk_ts", { op: "adjustSpritesheet", job: "bbbbbbbb", cols: 4, hue: 30 });
  download(dir, "hero_idle", { job: "cccccccc", model: "forge", days: 10, cols: 3 });
  download(dir, "hero_attack", { job: "dddddddd", model: "hydra", sound: true, cols: 5 });
  download(dir, "slime_hit_ts", { op: "adjustSpritesheet", job: "eeeeeeee", cols: 6 });
  const r = await run(["toolbox", "asset", "manifest", dir]);
  assert.equal(r.code, EXIT.OK, r.stderr);
  const hydra = r.json.assets.find(a => a.path === "hero_attack/animateSprite-dddddddd-3.wav");
  assert.equal(hydra.kind, "sfx");
  assert.match(hydra.reason, /^the sound Ludo's animateSprite made with its sheet/);
  const by = Object.fromEntries(r.json.gaps.map(g => [g.subject, g]));
  assert.deepEqual(Object.keys(by).sort(), ["hero_idle/animateSprite-cccccccc-1.png", "hero_walk/animateSprite-aaaaaaaa-1.png", "slime_hit_ts/adjustSpritesheet-eeeeeeee-1.png"]);
  // Named as the PNG the CLI stamped, not the WebP the loaders take.
  const w = by["hero_walk/animateSprite-aaaaaaaa-1.png"];
  assert.equal(w.detail, "hero_walk/animateSprite-aaaaaaaa-1.png has no sound: it was made with forge-pixel (nor has hero_walk_ts/adjustSpritesheet-bbbbbbbb-1.png, its sprite adjust copy by name)");
  assert.deepEqual(w.also, ["hero_walk_ts/adjustSpritesheet-bbbbbbbb-1.png"]);
  assert.equal(w.hint.command, "ludo sprite create-audio --spritesheet-video-url <its video_url>");
  // Ten days old: past create-audio's 7 days, so a sound effect, saying why.
  const idle = by["hero_idle/animateSprite-cccccccc-1.png"];
  assert.equal(idle.hint.command, 'ludo audio sound-effect --description "<what hero doing idle sounds like>"');
  assert.match(idle.hint.text, /create-audio takes only sheets made in the last 7 days, and this one was made on /);
  // An adjusted sheet whose source is not here: create-audio does not take it.
  const slime = by["slime_hit_ts/adjustSpritesheet-eeeeeeee-1.png"];
  assert.match(slime.detail, /sprite adjust made it, and a copy carries its source's sound only when the source has one/);
  assert.match(slime.hint.text, /create-audio takes the video_url of a sheet from animateSprite, animateSpriteKeyframes, transferMotion or editSpritesheet, and this one is from adjustSpritesheet$/);
  assert.ok(slime.hint.command.startsWith("ludo audio sound-effect"));
  // Groups name the PNG once, not the PNG and its WebP.
  const hero = r.json.groups.find(g => g.character.startsWith("hero"));
  assert.ok(!hero.animations.some(a => a.path.endsWith(".webp")));
});

test("one move's sheets lacking a sound are one gap", async () => {
  const dir = tmp();
  for (const [i, d] of ["N", "S", "W"].entries()) download(dir, `boss-smash-${d}`, { op: "transferMotion", job: `${i}a${i}b${i}c${i}d`, model: "forge", cols: 4 + i });
  const r = await run(["toolbox", "asset", "manifest", dir]);
  assert.equal(r.code, EXIT.OK, r.stderr);
  assert.equal(r.json.gaps.length, 1);
  const [gap] = r.json.gaps;
  assert.equal(gap.detail, "boss-smash-N/transferMotion-0a0b0c0d-1.png and 2 other sheets of boss's smash have no sound: they were made with forge");
  assert.deepEqual(gap.also, ["boss-smash-S/transferMotion-1a1b1c1d-1.png", "boss-smash-W/transferMotion-2a2b2c2d-1.png"]);
  assert.equal(gap.hint.command, "ludo sprite create-audio --spritesheet-video-url <its video_url>");
  assert.match(gap.hint.text, /^Give each a sound with Ludo/);
});

test("directions, loops and takes stay one character, and two characters are no evidence for an animation", async () => {
  assert.deepEqual(characterOf("mt_walk_forward/transferMotion-670e302d-1.png"), { character: "mt", action: "walk", variant: "forward" });
  assert.deepEqual(characterOf("mt_walk_loop/transferMotion-74aae041-1.png"), { character: "mt", action: "walk", variant: "loop" });
  assert.deepEqual(characterOf("mt_idle_neutral/transferMotion-0f3ce273-1.png"), { character: "mt", action: "idle", variant: "neutral" });
  assert.deepEqual(characterOf("sprites/hero_walk_left.png"), { character: "hero", action: "walk", variant: "left" });
  assert.deepEqual(characterOf("fp_hero_attack2_ts/adjustSpritesheet-01553176-1.png"), { character: "fp_hero", action: "attack", take: 2, variant: "ts" });
  assert.deepEqual(characterOf("boss-smash-NW.clip2/transferMotion-471f11cd-1.png"), { character: "boss", action: "smash", variant: "nw_clip2" });
  assert.deepEqual(characterOf("attack_goblin.png"), { character: "goblin", action: "attack" });
  // The file names the knight: its folders are not part of its name.
  assert.deepEqual(characterOf("collide/knight-walk.webp"), { character: "knight", action: "walk" });
  assert.deepEqual(characterOf("compare/knight-walk-ts.webp"), { character: "knight", action: "walk", variant: "ts" });
  const dir = tmp();
  const sheet = (name, cols, hue) => writeSheet(path.join(dir, name), figureSheet({ cols, rows: 1, hue }), { cols, rows: 1, frames: cols, fps: 8 });
  sheet("hero_walk_left.png", 4, 0);
  sheet("hero_walk_right.png", 4, 20);
  sheet("hero_attack_right.png", 5, 40);
  sheet("rogue_walk.png", 4, 60);
  sheet("rogue_attack.png", 5, 80);
  sheet("knight_walk.png", 4, 100);
  sheet("knight_attack.png", 5, 120);
  sheet("slime_walk_loop.png", 6, 140);
  sheet("slime_walk_forward.png", 6, 160);
  const r = await run(["toolbox", "asset", "manifest", dir]);
  assert.equal(r.code, EXIT.OK, r.stderr);
  // No hero_left without an attack: the hero is one character.
  assert.deepEqual(r.json.gaps.map(g => `${g.kind} ${g.subject} ${g.missing}`), ["animation slime attack"]);
  assert.equal(r.json.gaps[0].detail, "slime has walk but no attack, which hero, knight and rogue have");
  const hero = r.json.groups.find(g => g.character === "hero");
  assert.deepEqual(hero.animations.map(a => `${a.action} ${a.variant}`), ["attack right", "walk left", "walk right"]);
  // A hiker who walks, next to a hero who also attacks: a choice, not a gap.
  const two = tmp();
  writeSheet(path.join(two, "hiker_walk.png"), figureSheet({ cols: 4, rows: 1 }), { cols: 4, rows: 1, frames: 4, fps: 8 });
  for (const [move, cols] of [["walk", 4], ["attack", 5], ["idle", 3]]) writeSheet(path.join(two, `fp_hero_${move}.png`), figureSheet({ cols, rows: 1, hue: cols * 30 }), { cols, rows: 1, frames: cols, fps: 8 });
  assert.deepEqual((await run(["toolbox", "asset", "manifest", two])).json.gaps, []);
});

test("no rig suggested for a GLB whose rigged copy is here, by its geometry or the log", async () => {
  const dir = tmp();
  writeGltf(path.join(dir, "knight.glb"), { height: 1.8 });
  writeGltf(path.join(dir, "knight_rigged.glb"), { height: 1.8, joints: ["Hips", "Spine", "Head"], clips: ["Walk"] });
  // Rigged from statue.glb, as the log says, though its bounds moved.
  writeGltf(path.join(dir, "statue.glb"), { height: 2.4 });
  writeGltf(path.join(dir, "out/rigModel-1234abcd-1.glb"), { height: 1.2, joints: ["Root", "Arm"], clips: ["Wave"] });
  writeJson(path.join(dir, "out/ludo-assets.json"), { assets: [{ file: "rigModel-1234abcd-1.glb", command: "model rig", operation_id: "rigModel", body: { model: "../statue.glb" }, job_id: "1234abcd-0000", created_at: new Date().toISOString() }] });
  writeGltf(path.join(dir, "barrel.glb"), { height: 0.9 });
  const r = await run(["toolbox", "asset", "manifest", dir]);
  assert.equal(r.code, EXIT.OK, r.stderr);
  assert.deepEqual(r.json.gaps.map(g => `${g.kind} ${g.subject}`), ["rig barrel.glb"]);
});
