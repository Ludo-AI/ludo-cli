// The picture tool `image contact`, and the drawing it is made with.
// Synthetic inputs whose answers are known (a square sliding along the
// ground, a click at a set time), so the overlays and markers can be checked
// where they land, pixel by pixel.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { encodePng, readPng } from "../dist/tty/png.js";
import { makeGif } from "../dist/toolbox/gif.js";
import { drawableName, fitMiddle, fitScale, imageContactLayout, MAX_SIDE } from "../dist/toolbox/preview.js";
import { canvas, fitText, text, textWidth } from "../dist/toolbox/draw.js";
import { GLYPHS } from "../dist/toolbox/font.js";
import { EXIT } from "../dist/errors.js";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ludo-preview-"));

function run(args, cwd = tmp()) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...process.env, LUDO_SPEC: path.join(cwd, "no-spec.json"), LUDO_API_KEY: "", LUDO_CONFIG_DIR: path.join(cwd, ".config"), LUDO_TELEMETRY: "0" }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", d => (stdout += d));
    child.stderr.on("data", d => (stderr += d));
    child.on("close", code => resolve({ code, stdout, stderr, cwd, json: () => JSON.parse(stdout) }));
  });
}


const px = (img, x, y) => Array.from(img.rgba.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 3));

test("the font draws its glyphs where it says, and text is measured and cut to fit", () => {
  const img = canvas(20, 10, [0, 0, 0, 255]);
  text(img, 1, 1, "1", [255, 255, 255, 255]);
  const rows = GLYPHS.get("1");
  for (let r = 0; r < 7; r++) for (let c = 0; c < 5; c++) assert.equal(px(img, 1 + c, 1 + r)[0] === 255, !!(rows[r] & (1 << (4 - c))), `row ${r} col ${c}`);
  assert.equal(textWidth("ab", 2), 22);
  assert.equal(fitText("a long file name.png", textWidth("a long...", 1)), "a long...");
  assert.equal(fitText("short", 100), "short");
});

test("image contact: each image fitted to its cell, whole factors up, its size under it", async () => {
  const dir = tmp();
  const solid = (w, h, c) => {
    const rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < rgba.length; i += 4) rgba.set(c, i);
    return { width: w, height: h, rgba };
  };
  fs.mkdirSync(path.join(dir, "set"));
  fs.writeFileSync(path.join(dir, "set", "icon-2.png"), encodePng(solid(16, 16, [255, 0, 0, 255])));
  fs.writeFileSync(path.join(dir, "set", "icon-10.png"), encodePng(solid(600, 300, [0, 0, 255, 255])));
  fs.writeFileSync(path.join(dir, "wide.png"), encodePng(solid(100, 50, [0, 255, 0, 128])));
  const r = await run(["toolbox", "image", "contact", "set", "wide.png", "--json", "--out", "out"], dir);
  assert.equal(r.code, EXIT.OK, r.stderr);
  const out = r.json();
  assert.deepEqual(out.images.map(i => path.basename(i.file)), ["icon-2.png", "icon-10.png", "wide.png"]);
  assert.deepEqual(out.images.map(i => [i.width, i.height]), [[16, 16], [600, 300], [100, 50]]);
  assert.equal(out.layout.cell, 256);
  assert.deepEqual(out.images.map(i => i.scale), [16, 0.427, 2]);
  const img = readPng(fs.readFileSync(path.join(dir, out.image))).image;
  // The 16 px icon fills its cell in red.
  const first = out.images[0].at;
  assert.deepEqual([first.width, first.height], [256, 256]);
  assert.deepEqual(px(img, first.x + 128, first.y + 128), [255, 0, 0]);
  // Its caption is under the cell.
  let ink = 0;
  for (let y = out.layout.first_cell.y + 256; y < out.layout.first_cell.y + 256 + 40; y++) for (let x = first.x; x < first.x + 100; x++) if (px(img, x, y)[0] > 140) ink++;
  assert.ok(ink > 20, "a caption");
  assert.equal(fitScale(16, 16, 256), 16);
  assert.equal(fitScale(17, 16, 256), 15);
  assert.equal(out.hint.command, `ludo image edit --image <one of them> --prompt "<the change>"`);
  const many = imageContactLayout(400);
  assert.ok(many.width <= MAX_SIDE && many.height <= MAX_SIDE);
});

test("image contact: takes stay apart (numbered, cut in the middle), other scripts too, a GIF shows its own size, a broken file is left out", async () => {
  const dir = tmp();
  const solid = (w, h, c) => {
    const rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < rgba.length; i += 4) rgba.set(c, i);
    return { width: w, height: h, rgba };
  };
  for (let k = 1; k <= 4; k++) fs.writeFileSync(path.join(dir, `createImage-9f3a2b1c0d4e5f60-${k}.png`), encodePng(solid(32, 32, [40 * k, 0, 0, 255])));
  fs.writeFileSync(path.join(dir, "héros_ドラゴン.png"), encodePng(solid(8, 8, [0, 255, 0, 255])));
  fs.writeFileSync(path.join(dir, "héros_ゴブリン.png"), encodePng(solid(8, 8, [0, 0, 255, 255])));
  fs.writeFileSync(path.join(dir, "anim.gif"), makeGif([solid(20, 10, [255, 0, 0, 255]), solid(20, 10, [0, 255, 0, 255]), solid(20, 10, [0, 0, 255, 255])], { fps: 10, alphaThreshold: 128, loop: true }).bytes);
  fs.writeFileSync(path.join(dir, "broken.png"), "not a png");
  const r = await run(["toolbox", "image", "contact", ".", "--json", "--out", "out"], dir);
  assert.equal(r.code, EXIT.OK, r.stderr);
  const out = r.json();
  assert.deepEqual(out.skipped.map(x => x.file), ["broken.png"]);
  const labels = out.images.map(i => i.label);
  assert.equal(new Set(labels).size, labels.length, labels.join(" | "));
  const takes = out.images.filter(i => i.file.startsWith("createImage"));
  for (const t of takes) assert.match(t.label, new RegExp(`^${t.number} creat.*\\.\\.\\..*-${t.file.slice(-5, -4)}$`), t.label);
  const gif = out.images.find(i => i.file === "anim.gif");
  assert.deepEqual([gif.width, gif.height, gif.frames], [20, 10, 3]);
  // Accents go, other scripts become a hash that keeps the names apart.
  assert.equal(drawableName("héros.png"), "heros.png");
  assert.match(drawableName("héros_ドラゴン.png"), /^heros_~[0-9a-f]{4}\.png$/);
  assert.notEqual(drawableName("héros_ドラゴン.png"), drawableName("héros_ゴブリン.png"));
  assert.equal(fitMiddle("abcdefghij", textWidth("a...ghij")), "a...ghij");
  // In a narrow cell the extension goes before the end of the name does.
  assert.equal(fitMiddle("attack__0390027a99.png", textWidth("att...7a99")), "at...27a99");
  // Nothing readable is an error.
  const none = tmp();
  fs.writeFileSync(path.join(none, "broken.png"), "not a png");
  assert.equal((await run(["toolbox", "image", "contact", "broken.png", "--json"], none)).code, EXIT.BAD_INPUT);
});
