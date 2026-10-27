// Loads the TexturePacker JSON atlases the CLI writes in real engines: Phaser
// 4, Phaser 3 and PixiJS 8, each in headless Chromium (playwright-core, a dev
// dependency like the engines). Skipped when no Chromium is installed:
// `npx playwright-core install chromium`.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { encodePng } from "../dist/tty/png.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const CLI = path.join(root, "dist", "cli.js");

const LIBS = {
  phaser4: path.join(root, "node_modules/phaser/dist/phaser.min.js"),
  phaser3: path.join(root, "node_modules/phaser3/dist/phaser.min.js"),
  pixi8: path.join(root, "node_modules/pixi.js/dist/pixi.min.js")
};

let browser;
let server;
let base;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-engines-"));

before(async () => {
  try {
    const { chromium } = await import("playwright-core");
    browser = await chromium.launch();
  } catch (err) {
    // CI's engines job must not pass by skipping.
    if (process.env.LUDO_REQUIRE_ENGINES) throw err;
    browser = undefined;
    return;
  }
  server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const lib = url.pathname.match(/^\/lib\/(\w+)\.js$/)?.[1];
    const file = lib ? LIBS[lib] : path.join(dir, decodeURIComponent(url.pathname));
    if (!file || !file.startsWith(lib ? root : dir) || !fs.existsSync(file)) return res.writeHead(404).end();
    const type = file.endsWith(".js") ? "text/javascript" : file.endsWith(".json") ? "application/json" : file.endsWith(".png") ? "image/png" : "text/html";
    res.writeHead(200, { "content-type": type }).end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><body></body>");
});

after(async () => {
  await browser?.close();
  server?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function cli(args) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, ...args, "--json"], {
      cwd: dir,
      env: { ...process.env, LUDO_TELEMETRY: "0", LUDO_API_KEY: "", LUDO_CONFIG_DIR: path.join(dir, ".config"), LUDO_CACHE_DIR: path.join(dir, ".cache") }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", d => (stdout += d));
    child.stderr.on("data", d => (stderr += d));
    child.on("close", code => {
      assert.equal(code, 0, stderr);
      resolve(JSON.parse(stdout));
    });
  });
}

const colour = i => [40 + i * 25, 230 - i * 20, (i * 70) % 256, 255];

// Frame i: its colour over a box at (bx, by) of bw x bh, the rest clear.
function writeFrames(name, n, w, h, box = { x: 0, y: 0, w, h }) {
  const folder = path.join(dir, name);
  fs.mkdirSync(folder, { recursive: true });
  for (let i = 0; i < n; i++) {
    const rgba = new Uint8Array(w * h * 4);
    for (let y = box.y; y < box.y + box.h; y++) for (let x = box.x; x < box.x + box.w; x++) rgba.set(colour(i), (y * w + x) * 4);
    fs.writeFileSync(path.join(folder, `${name}-${i + 1}.png`), encodePng({ width: w, height: h, rgba }));
  }
  return folder;
}

// Builds the two atlases once: a plain 4x2 sheet of 7 frames, and one that
// was trimmed and then extruded.
let plain;
let packed;
async function fixtures() {
  if (plain) return;
  const a = await cli(["toolbox", "sprite", "join", writeFrames("walk", 7, 16, 12), "--cols", "4", "--fps", "12", "--engine", "texturepacker", "--out", "out"]);
  plain = { sheet: a.sheet, atlas: a.engine_files[0], frames: 7, cell: [16, 12], extrude: 0, trim: undefined };
  const b = await cli(["toolbox", "sprite", "join", writeFrames("jump", 5, 20, 16, { x: 3, y: 2, w: 12, h: 10 }), "--cols", "3", "--fps", "8", "--out", "out"]);
  const trimmed = await cli(["toolbox", "image", "trim", b.sheet, "--out", "out"]);
  const extruded = await cli(["toolbox", "image", "extrude", trimmed.image, "--by", "2", "--out", "out"]);
  const exported = await cli(["toolbox", "sprite", "export", extruded.image, "--engine", "texturepacker", "--animation", "jump"]);
  packed = { sheet: extruded.image, atlas: exported.engine_files[0], frames: 5, cell: [16, 14], extrude: 2, trim: { x: 3, y: 2, w: 12, h: 10, sw: 20, sh: 16 } };
}

// What every engine must find in an atlas.
function expected(f, cols, animation, fps) {
  return Array.from({ length: f.frames }, (_, i) => {
    const [cw, ch] = f.cell;
    const e = f.extrude;
    const t = f.trim;
    return {
      name: String(i),
      frame: [(i % cols) * cw + e, Math.floor(i / cols) * ch + e, cw - 2 * e, ch - 2 * e],
      source: t ? [t.sw, t.sh] : [cw, ch],
      offset: t ? [t.x, t.y] : [0, 0],
      colour: colour(i),
      animation,
      duration: Math.round(1000 / fps)
    };
  });
}

const rel = p => "/" + path.relative(dir, path.resolve(dir, p)).split(path.sep).join("/");

async function inPage(lib, fn, arg) {
  const page = await browser.newPage();
  try {
    await page.goto(`${base}/index.html`);
    await page.addScriptTag({ url: `${base}/lib/${lib}.js` });
    return await page.evaluate(fn, arg);
  } finally {
    await page.close();
  }
}

// Runs in the page: loads the atlas in Phaser and reports what it made of it.
// load.atlas gives the frames; load.aseprite (the same files) also keeps the
// JSON that anims.createFromAseprite reads.
const phaserProbe = ({ png, json, loader }) =>
  new Promise((resolve, reject) => {
    setTimeout(() => reject(new Error("Phaser did not finish loading")), 15000);
    // eslint-disable-next-line no-undef
    new Phaser.Game({
      // eslint-disable-next-line no-undef
      type: Phaser.CANVAS,
      width: 32,
      height: 32,
      banner: false,
      audio: { noAudio: true },
      scene: {
        preload() {
          this.load[loader]("a", png, json);
        },
        create() {
          const tex = this.textures.get("a");
          const names = tex.getFrameNames().sort((x, y) => Number(x) - Number(y));
          const frames = names.map(n => {
            const f = tex.get(n);
            const c = this.textures.getPixel(f.x + Math.floor(f.cutWidth / 2), f.y + Math.floor(f.cutHeight / 2), "a", n);
            return { name: n, frame: [f.cutX, f.cutY, f.cutWidth, f.cutHeight], source: [f.realWidth, f.realHeight], offset: [f.x, f.y], colour: c && [c.red, c.green, c.blue, c.alpha] };
          });
          const anims = (loader === "aseprite" ? this.anims.createFromAseprite("a") : []).map(a => ({ key: a.key, frames: a.frames.map(fr => fr.textureFrame), durations: a.frames.map(fr => fr.duration) }));
          resolve({ frames, anims });
        }
      }
    });
  });

// Runs in the page: loads the atlas in PixiJS and samples each frame's
// centre from the image it is cut from.
const pixiProbe = async ({ json }) => {
  // eslint-disable-next-line no-undef
  const sheet = await PIXI.Assets.load(json);
  const names = Object.keys(sheet.textures).sort((x, y) => Number(x) - Number(y));
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const frames = names.map(n => {
    const t = sheet.textures[n];
    const img = t.source.resource;
    canvas.width = img.width;
    canvas.height = img.height;
    ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(Math.floor(t.frame.x + t.frame.width / 2), Math.floor(t.frame.y + t.frame.height / 2), 1, 1).data;
    return {
      name: n,
      frame: [t.frame.x, t.frame.y, t.frame.width, t.frame.height],
      source: [t.orig.width, t.orig.height],
      offset: t.trim ? [t.trim.x, t.trim.y] : [0, 0],
      colour: [...px]
    };
  });
  const animations = Object.fromEntries(Object.entries(sheet.animations).map(([k, list]) => [k, list.map(t => names.find(n => sheet.textures[n] === t))]));
  return { frames, animations };
};

for (const lib of ["phaser4", "phaser3"]) {
  test(`${lib} loads the atlases and builds the animation from its frameTags`, async t => {
    if (!browser) return t.skip("no Chromium for playwright-core (npx playwright-core install chromium)");
    await fixtures();
    for (const [f, cols, animation, fps] of [
      [plain, 4, "walk", 12],
      [packed, 3, "jump", 8]
    ]) {
      const want = expected(f, cols, animation, fps);
      for (const loader of ["atlas", "aseprite"]) {
        const got = await inPage(lib, phaserProbe, { png: rel(f.sheet), json: rel(f.atlas), loader });
        assert.deepEqual(got.frames, want.map(({ name, frame, source, offset, colour }) => ({ name, frame, source, offset, colour })), `${lib} load.${loader} ${animation} frames`);
        if (loader === "aseprite") {
          assert.deepEqual(got.anims, [{ key: animation, frames: want.map(w => w.name), durations: want.map(w => w.duration) }], `${lib} ${animation} animation`);
        }
      }
    }
  });
}

test("pixi8 loads the atlases with their animations", async t => {
  if (!browser) return t.skip("no Chromium for playwright-core (npx playwright-core install chromium)");
  await fixtures();
  for (const [f, cols, animation, fps] of [
    [plain, 4, "walk", 12],
    [packed, 3, "jump", 8]
  ]) {
    const got = await inPage("pixi8", pixiProbe, { json: rel(f.atlas) });
    const want = expected(f, cols, animation, fps);
    assert.deepEqual(got.frames, want.map(({ name, frame, source, offset, colour }) => ({ name, frame, source, offset, colour })), `pixi ${animation} frames`);
    assert.deepEqual(got.animations, { [animation]: want.map(w => w.name) }, `pixi ${animation} animation`);
  }
});
