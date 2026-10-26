// `ludo toolbox asset ...` on synthetic folders: what manifest says each file
// is, the loader code it writes (Phaser's type-checked against Phaser's own
// types and loaded in Phaser 3 and 4, PixiJS's manifest loaded in PixiJS 8,
// both in headless Chromium when one is installed), lint's engine rules,
// budget's limits, scale's factors and diff's verdicts.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { encodePng, withText, readPng } from "../dist/tty/png.js";
import { encodeWav } from "../dist/toolbox/wav.js";
import { EXIT } from "../dist/errors.js";
import { assetKeys, characterOf, dHash, gpuBytes, lintAssets, parseBudget, parseBytes, parseSize, soundKind } from "../dist/toolbox/asset.js";

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

// A .gltf with one triangle of the given height, joints and clips.
function writeGltf(file, { height = 1.8, minY = 0, joints = [], clips = [], scenes = 1, scene = 0 }) {
  const nodes = [{ mesh: 0, name: "body", ...(joints.length ? { skin: 0 } : {}) }, ...joints.map(name => ({ name }))];
  const accessors = [{ count: 3, componentType: 5126, type: "VEC3", min: [0, minY, 0], max: [0.5, minY + height, 0.2] }, { count: 2, componentType: 5126, type: "SCALAR", min: [0], max: [1] }];
  const json = {
    asset: { version: "2.0" },
    ...(scene === null ? {} : { scene }),
    scenes: Array.from({ length: scenes }, () => ({ nodes: [0] })),
    nodes,
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors,
    ...(joints.length ? { skins: [{ joints: joints.map((_, i) => i + 1) }] } : {}),
    ...(clips.length ? { animations: clips.map(name => ({ name, channels: [{ sampler: 0, target: { node: 1, path: "rotation" } }], samplers: [{ input: 1, output: 1 }] })) } : {})
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(json));
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
  assert.ok(!m.assets.some(a => "file" in a || "phash" in a));
  assert.equal(r.json.hint.command.startsWith("ludo toolbox asset lint"), true);
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
        { path: "sprites/hero_idle.png", action: "idle", frames: 6 },
        { path: "sprites/hero_walk.png", action: "walk", frames: 8 },
        { path: "sprites/hero_walk2.png", action: "walk", take: 2, frames: 8 }
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
  assert.deepEqual(characterOf("fp_hero_walk2/animateSprite-61b55cee-1.png"), { character: "fp_hero", action: "walk", take: 2 });
  assert.deepEqual(characterOf("knight/attack_heavy.png"), { character: "knight", action: "attack_heavy" });
  assert.equal(soundKind("audio/voice-wizard.mp3", 4, false, 1, { low: 0.1, pauses: 0 }).kind, "voice");
  assert.equal(soundKind("a/x.wav", 0.4, false, 1, { low: 0, pauses: 0 }).kind, "sfx");
  assert.equal(soundKind("a/x.wav", 4, false, 1, { low: 0.45, pauses: 0.3 }).kind, "voice");
  assert.equal(soundKind("a/x.wav", 30, true, 1, { low: 0.1, pauses: 0.01 }).kind, "music");
  assert.equal(soundKind("a/x.wav", 10, true, 1, { low: 0.1, pauses: 0 }).kind, "ambience");
  assert.equal(soundKind("a/x.wav", 20, false, 2, { low: 0.1, pauses: 0 }).reason, "2 copies of one loop written out");
  const a = disc(40, 40);
  assert.equal(dHash(a).length, 64);
  // Twice the size: (nearly) the same bits.
  const diff = dHash(a).reduce((n, v, i) => n + (v !== dHash(disc(80, 80))[i] ? 1 : 0), 0);
  assert.ok(diff <= 4, `${diff} bits differ`);
});

// ---- --emit ----

test("--emit writes Phaser, Godot, Unity, PixiJS and JSON loaders with stable keys", async () => {
  const dir = gameFolder();
  const out = path.join(tmp(), "gen");
  const r = await run(["toolbox", "asset", "manifest", dir, "--emit", "phaser", "--emit", "godot", "--emit", "unity", "--emit", "pixi", "--emit", "json", "--base", "assets", "--out", out]);
  assert.equal(r.code, EXIT.OK, r.stderr);
  assert.deepEqual(r.json.emitted.map(f => path.basename(f)), ["assets.ts", "assets.gd", "LudoAssets.cs", "assets-manifest.json", "assets.json"]);
  const phaser = fs.readFileSync(path.join(out, "assets.ts"), "utf8");
  assert.match(phaser, /SpritesHeroWalk = "sprites_hero_walk",/);
  assert.match(phaser, /scene\.load\.spritesheet\(AssetKey\.SpritesHeroWalk, "sprites\/hero_walk\.png", \{ frameWidth: 32, frameHeight: 48, endFrame: 7 \}\);/);
  assert.match(phaser, /scene\.load\.audio\(AssetKey\.AudioOverworld, "audio\/overworld\.wav"\);/);
  assert.match(phaser, /path = "assets\/"/);
  assert.match(phaser, /\/\/ models\/knight\.gltf: a 3D model; Phaser has no glTF loader/);
  const godot = fs.readFileSync(path.join(out, "assets.gd"), "utf8");
  assert.match(godot, /"sprites_hero_walk": preload\("assets\/sprites\/hero_walk\.png"\),/);
  assert.match(godot, /"sprites_hero_walk": \{"hframes": 4, "vframes": 2, "frames": 8, "fps": 12\},/);
  const unity = fs.readFileSync(path.join(out, "LudoAssets.cs"), "utf8");
  assert.match(unity, /public const string SpritesHeroWalk = "assets\/sprites\/hero_walk\.png";/);
  assert.match(unity, /new Entry\("sprites_hero_walk", SpritesHeroWalk, Kind\.Spritesheet, 8, 4, 2, 12f\),/);
  const pixi = JSON.parse(fs.readFileSync(path.join(out, "assets-manifest.json"), "utf8"));
  assert.deepEqual(pixi.bundles.find(b => b.name === "textures").assets, [{ alias: "textures_lava", src: "assets/textures/lava.png" }]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, "assets.json"), "utf8")).count, 11);
  // Keys are the same run after run; the loader overwrites its own copy.
  const again = await run(["toolbox", "asset", "manifest", dir, "--emit", "phaser", "--base", "assets", "--out", out]);
  assert.equal(again.code, EXIT.OK);
  assert.equal(fs.readFileSync(path.join(out, "assets.ts"), "utf8"), phaser);
  assert.ok(!fs.existsSync(path.join(out, "assets-2.ts")));
});

test("Godot paths come from project.godot, and files Godot cannot import are left out", async () => {
  const project = tmp();
  fs.writeFileSync(path.join(project, "project.godot"), "");
  const dir = path.join(project, "art");
  writeSheet(path.join(dir, "hero.png"), disc(16, 16));
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(root, "test/corpus/gif", fs.readdirSync(path.join(root, "test/corpus/gif")).find(f => f.endsWith(".gif"))), path.join(dir, "spin.gif"));
  // A WAV named .mp3, as some downloads are: Godot's MP3 importer fails on it.
  writeSound(path.join(dir, "fake.mp3"), { seconds: 0.5, kind: "blip" });
  const out = path.join(tmp(), "gen");
  const r = await run(["toolbox", "asset", "manifest", dir, "--emit", "godot", "--out", out]);
  assert.equal(r.code, EXIT.OK, r.stderr);
  const gd = fs.readFileSync(path.join(out, "assets.gd"), "utf8");
  assert.match(gd, /"hero": preload\("res:\/\/art\/hero\.png"\),/);
  assert.match(gd, /# "spin": spin\.gif left out: Godot does not import GIF/);
  assert.match(gd, /# "fake": fake\.mp3 left out: named \.mp3, but a WAV inside/);
  assert.ok(!/preload\("res:\/\/art\/spin\.gif"\)/.test(gd));
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
                resolve({ path: this.load.path, textures: keys.map(k => [k, this.textures.exists(k) ? this.textures.get(k).frameTotal - 1 : -1]), sheets: mod.SHEETS });
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
    assert.deepEqual(got.sheets, { sprites_hero_walk: { frames: 7, frameRate: 12 } });
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

// ---- lint ----

test("lint checks Godot's rules: GIF and Opus not imported, 16-bit PNGs, sample rates; errors exit 1", async () => {
  const dir = tmp();
  fs.copyFileSync(path.join(root, "test/corpus/gif", fs.readdirSync(path.join(root, "test/corpus/gif")).find(f => f.endsWith(".gif"))), path.join(dir, "spin.gif"));
  fs.copyFileSync(path.join(root, "test/corpus/pngsuite/basn6a16.png"), path.join(dir, "deep.png"));
  writeSound(path.join(dir, "hi_rate.wav"), { seconds: 0.5, rate: 96000, kind: "blip" });
  writeSheet(path.join(dir, "Hero.png"), disc(16, 16));
  const r = await run(["toolbox", "asset", "lint", dir, "--engine", "godot"]);
  assert.equal(r.code, EXIT.ERROR, r.stderr);
  const rules = r.json.issues.map(i => `${i.file} ${i.rule} ${i.severity}`);
  assert.deepEqual(rules, ["spin.gif format error", "deep.png 16-bit-png info", "Hero.png file-name info", "hi_rate.wav sample-rate info"]);
  const gif = r.json.issues[0];
  assert.match(gif.fix, /^ludo toolbox image convert .*spin\.gif --to png/);
  assert.match(gif.source, /^https:\/\/docs\.godotengine\.org\//);
  assert.equal(r.json.passed, false);
  assert.ok(r.json.hint.command.startsWith("ludo toolbox image convert"));
});

test("lint checks Unity, Unreal and the web: WebP, MP3 loops, bit depths, sizes, power of two, glTF scenes", async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "lava.webp"), fs.readFileSync(path.join(root, "test/corpus/webp", fs.readdirSync(path.join(root, "test/corpus/webp")).find(f => f.endsWith(".webp")))));
  writeSheet(path.join(dir, "floor_tile.png"), tile(96, 96));
  writeSheet(path.join(dir, "banner.png"), { width: 4100, height: 8, rgba: new Uint8Array(4100 * 8 * 4).fill(255) });
  fs.copyFileSync(path.join(root, "test/corpus/mp3/lame-24k-js-v4.mp3"), path.join(dir, "music_loop.mp3"));
  writeSound(path.join(dir, "float.wav"), { seconds: 0.3, bits: 32, kind: "blip" });
  writeSound(path.join(dir, "deep.wav"), { seconds: 0.3, bits: 24, kind: "blip" });
  writeGltf(path.join(dir, "level.gltf"), { scenes: 3, scene: 1 });
  const lint = async engine => {
    const r = await run(["toolbox", "asset", "lint", dir, "--engine", engine]);
    return { code: r.code, rules: r.json.issues.map(i => `${i.file} ${i.rule} ${i.severity}`) };
  };
  const unity = await lint("unity");
  assert.equal(unity.code, EXIT.ERROR);
  for (const want of ["lava.webp format error", "music_loop.mp3 mp3-loop warning", "floor_tile.png power-of-two warning", "level.gltf gltf-scenes warning"]) assert.ok(unity.rules.includes(want), `${want} in ${unity.rules}`);
  const unreal = await lint("unreal");
  for (const want of ["float.wav format error", "deep.wav format info", "floor_tile.png power-of-two warning"]) assert.ok(unreal.rules.includes(want), `${want} in ${unreal.rules}`);
  const web = await lint("web");
  assert.equal(web.code, EXIT.OK);
  for (const want of ["banner.png texture-size warning", "floor_tile.png power-of-two warning", "level.gltf gltf-scenes info"]) assert.ok(web.rules.includes(want), `${want} in ${web.rules}`);
  // --strict fails on warnings too.
  assert.equal((await run(["toolbox", "asset", "lint", dir, "--engine", "web", "--strict"])).code, EXIT.ERROR);
});

test("lint takes its own engines; other commands still refuse them", async () => {
  const dir = tmp();
  writeSheet(path.join(dir, "a.png"), disc(16, 16));
  assert.equal((await run(["toolbox", "asset", "lint", dir, "--engine", "phaser"])).code, EXIT.OK);
  const bad = await run(["toolbox", "asset", "lint", dir, "--engine", "texturepacker"]);
  assert.equal(bad.code, EXIT.USAGE);
  assert.match(bad.stderr, /asset lint checks godot, unity, unreal, phaser, web/);
  assert.equal((await run(["toolbox", "asset", "lint", dir])).code, EXIT.USAGE);
  const other = await run(["toolbox", "sprite", "export", path.join(dir, "a.png"), "--engine", "unreal"]);
  assert.equal(other.code, EXIT.USAGE);
  assert.match(other.stderr, /--engine supports: godot, texturepacker, unity/);
});

test("unit: names Windows rejects and names that differ only by case", () => {
  const asset = p => ({ path: p, file: p, type: "image", kind: "image", reason: "", format: "png", bytes: 1, sha256: "", width: 16, height: 16 });
  const issues = lintAssets([asset("ui/aux.png"), asset("ui/Hero.png"), asset("ui/hero.png"), asset("odd./x.png")], "web");
  assert.deepEqual(
    issues.map(i => `${i.file} ${i.rule} ${i.severity}`),
    ["odd./x.png file-name error", "ui/aux.png file-name error", "ui/Hero.png file-name error", "ui/hero.png file-name error"]
  );
  assert.match(issues[2].detail, /the same name as ui\/hero\.png but for case/);
});

// ---- budget ----

test("unit: bytes, GPU memory and the budget file", () => {
  assert.equal(parseBytes("4MB", "x"), 4 * 1024 * 1024);
  assert.equal(parseBytes("512 kb", "x"), 512 * 1024);
  assert.equal(parseBytes(1000, "x"), 1000);
  assert.throws(() => parseBytes("lots", "image.bytes"), /image\.bytes takes bytes/);
  assert.equal(gpuBytes(100, 60, false, false), 100 * 60 * 4);
  assert.equal(gpuBytes(100, 60, false, true), 128 * 64 * 4);
  assert.equal(gpuBytes(64, 64, true, false), Math.round(64 * 64 * 4 * (4 / 3)));
  const b = parseBudget({ total: { bytes: "1MB" }, image: { side: 256, total_gpu: "1MB" }, gpu: { mipmaps: true } }, "b.json");
  assert.deepEqual(b.sections.get("total"), { file: {}, total: { bytes: 1024 * 1024 } });
  assert.deepEqual(b.sections.get("image"), { file: { side: 256 }, total: { gpu: 1024 * 1024 } });
  assert.equal(b.gpu.mipmaps, true);
  assert.throws(() => parseBudget({ images: {} }, "b.json"), /unknown section "images"/);
  assert.throws(() => parseBudget({ image: { width: 3 } }, "b.json"), /unknown limit "image\.width"/);
});

test("budget reports totals and the biggest files, and with a config gates them (--ci exits 1)", async () => {
  const dir = gameFolder();
  const plain = await run(["toolbox", "asset", "budget", dir]);
  assert.equal(plain.code, EXIT.OK, plain.stderr);
  assert.equal(plain.json.config, null);
  assert.equal(plain.json.totals.total.files, 11);
  assert.equal(plain.json.totals.audio.seconds, 24.3);
  assert.equal(plain.json.totals.spritesheet.gpu, 128 * 96 * 4 * 2 + 96 * 96 * 4 + 256 * 32 * 4);
  assert.equal(plain.json.biggest.bytes[0].path, "audio/overworld.wav");
  assert.deepEqual(plain.json.violations, []);
  const config = path.join(tmp(), "ludo-budget.json");
  fs.writeFileSync(config, JSON.stringify({ total: { seconds: 20 }, image: { side: 100 }, sfx: { seconds: 0.2 }, model: { triangles: 0 }, gpu: { power_of_two: true } }));
  const gated = await run(["toolbox", "asset", "budget", dir, "--config", config, "--ci"]);
  assert.equal(gated.code, EXIT.ERROR);
  const v = gated.json.violations.map(x => `${x.file ?? "all"} ${x.limit}`);
  assert.deepEqual(v.sort(), ["all total_seconds", "audio/blip.wav seconds", "models/knight.gltf triangles", "sprites/hero_walk.png side", "sprites/hero_walk2.png side", "sprites/slime_hop.png side"].sort());
  assert.equal(gated.json.gpu.power_of_two, true);
  // Without --ci it reports and passes.
  assert.equal((await run(["toolbox", "asset", "budget", dir, "--config", config])).code, EXIT.OK);
  // A budget in the folder is found on its own.
  fs.copyFileSync(config, path.join(dir, "ludo-budget.json"));
  assert.equal((await run(["toolbox", "asset", "budget", dir, "--ci"])).code, EXIT.ERROR);
});

// ---- scale ----

test("scale gives Unity pixels per unit and Godot pixel_size from a reference, and flags outliers", async () => {
  const dir = tmp();
  const walk = writeSheet(path.join(dir, "hero_walk.png"), figureSheet({ cols: 4, rows: 1, figH: 36 }), { cols: 4, rows: 1, frames: 4, fps: 10 });
  const idle = writeSheet(path.join(dir, "hero_idle.png"), figureSheet({ cols: 4, rows: 1, figH: 30 }), { cols: 4, rows: 1, frames: 4, fps: 10 });
  const slime = writeSheet(path.join(dir, "slime.png"), figureSheet({ cols: 2, rows: 1, cw: 48, ch: 24, figH: 12 }), { cols: 2, rows: 1, frames: 2, fps: 10 });
  const model = writeGltf(path.join(dir, "knight.gltf"), { height: 180 });
  const r = await run(["toolbox", "asset", "scale", idle, `${slime}=0.5m`, model, "--reference", `${walk}=1.8m`]);
  assert.equal(r.code, EXIT.OK, r.stderr);
  const by = Object.fromEntries(r.json.assets.map(a => [a.path, a]));
  assert.deepEqual(r.json.reference, { path: "hero_walk.png", height: 1.8, unit: "m", measured: 36, measured_unit: "px" });
  assert.deepEqual(by["hero_walk.png"].unity, { pixels_per_unit: 20 });
  assert.deepEqual(by["hero_walk.png"].godot, { pixel_size: 0.05 });
  assert.equal(by["hero_idle.png"].assumed, true);
  // The idle is drawn smaller than the walk: the same character would shrink.
  assert.match(by["hero_idle.png"].outlier, /17% shorter.*hero changes size between animations/);
  assert.deepEqual(by["slime.png"].unity, { pixels_per_unit: 24 });
  assert.equal(by["slime.png"].outlier, undefined);
  assert.deepEqual(by["knight.gltf"].godot, { scale: 0.01 });
  assert.match(by["knight.gltf"].outlier, /centimetres/);
  assert.deepEqual(r.json.outliers.sort(), ["hero_idle.png", "knight.gltf"]);
  // In screen pixels: Godot's Sprite2D scale, Unity's PPU at --ppu.
  const px = await run(["toolbox", "asset", "scale", "--reference", `${walk}=72px`, "--ppu", "32"]);
  assert.deepEqual(px.json.assets[0].godot, { scale: 2 });
  assert.deepEqual(px.json.assets[0].unity, { pixels_per_unit: 16 });
  assert.equal((await run(["toolbox", "asset", "scale", walk])).code, EXIT.USAGE);
  assert.equal((await run(["toolbox", "asset", "scale", "--reference", `${walk}=tall`])).code, EXIT.USAGE);
});

test("unit: heights", () => {
  assert.deepEqual(parseSize("1.8m", "x"), { value: 1.8, unit: "m" });
  assert.deepEqual(parseSize("180cm", "x"), { value: 1.8, unit: "m" });
  assert.deepEqual(parseSize("32px", "x"), { value: 32, unit: "px" });
  assert.throws(() => parseSize("0m", "--reference"), /--reference takes a height/);
});

// ---- diff ----

test("diff of two sheets: frames, frame size and ground are breaking; --image draws both", async () => {
  const dir = tmp();
  const a = writeSheet(path.join(dir, "walk.png"), figureSheet({ cols: 4, rows: 2, ground: 2 }), { cols: 4, rows: 2, frames: 8, fps: 12 });
  const b = writeSheet(path.join(dir, "walk2.png"), figureSheet({ cols: 5, rows: 2, ground: 8, hue: 30 }), { cols: 5, rows: 2, frames: 10, fps: 10 });
  const r = await run(["toolbox", "asset", "diff", a, b, "--image", "--out", path.join(dir, "out")]);
  assert.equal(r.code, EXIT.OK, r.stderr);
  assert.equal(r.json.compatible, false);
  assert.deepEqual(r.json.breaking, ["frames 8→10", "ground moved 6 px up"]);
  assert.ok(r.json.changes.includes("fps 12→10"));
  assert.equal(r.json.a.ground, 2);
  assert.equal(r.json.b.ground, 8);
  assert.ok(r.json.similarity > 0 && r.json.similarity < 1);
  const png = readPng(fs.readFileSync(path.resolve(fs.realpathSync(os.tmpdir()), r.json.image))).image;
  assert.equal(png.height, 48 + 16);
  assert.equal(png.width, 32 * 3 + 8 * 4);
  // The same sheet against itself drops straight in.
  const same = await run(["toolbox", "asset", "diff", a, a]);
  assert.equal(same.json.compatible, true);
  assert.deepEqual(same.json.breaking, []);
  assert.equal(same.json.similarity, 1);
  assert.equal(same.json.palette.similarity, 1);
});

test("diff of sounds and models, and refusals", async () => {
  const dir = tmp();
  const a = writeSound(path.join(dir, "hit.wav"), { seconds: 0.4, kind: "blip" });
  const b = writeSound(path.join(dir, "hit2.wav"), { seconds: 0.8, kind: "blip" });
  const s = await run(["toolbox", "asset", "diff", a, b]);
  assert.equal(s.code, EXIT.OK, s.stderr);
  assert.deepEqual(s.json.breaking, ["duration 0.4→0.8 s"]);
  assert.equal(s.json.a.peak_at, s.json.b.peak_at);
  const m1 = writeGltf(path.join(dir, "knight.gltf"), { joints: ["Hips", "Spine", "Head"], clips: ["Walk", "Idle"] });
  const m2 = writeGltf(path.join(dir, "knight2.gltf"), { joints: ["Hips", "Head", "Tail"], clips: ["Walk"], height: 2.2, minY: 0.1 });
  const m = await run(["toolbox", "asset", "diff", m1, m2]);
  assert.equal(m.json.compatible, false);
  assert.deepEqual(m.json.breaking, ["bones missing: Spine", "clips missing: Idle", "height 1.8→2.2", "ground moved 0.1 up"]);
  assert.deepEqual(m.json.changes, ["bones added: Tail"]);
  assert.equal((await run(["toolbox", "asset", "diff", a, m1])).code, EXIT.USAGE);
  assert.equal((await run(["toolbox", "asset", "diff", a, b, "--image"])).code, EXIT.USAGE);
});
