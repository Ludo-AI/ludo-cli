import { test } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { decodePng, encodePng, readText, withText } from "../dist/tty/png.js";
import { renderLines, fit } from "../dist/tty/halfblock.js";
import { gridFromResult, parseGrid, readGrid, GRID_KEY } from "../dist/tty/preview.js";
import { visuals } from "../dist/tty/visuals.js";
import { nextStep, creditsBar } from "../dist/tty/flair.js";

function img(w, h, fill) {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rgba.set(fill(x, y), (y * w + x) * 4);
  return { width: w, height: h, rgba };
}

// Hand-built PNGs for the colour types the encoder does not write.
function rawPng({ width, height, depth, colorType, rows, plte, trns, interlace = 0 }) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = b => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "latin1");
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = depth;
  ihdr[9] = colorType;
  ihdr[12] = interlace;
  const raw = Buffer.concat(rows.map(r => Buffer.concat([Buffer.from([0]), Buffer.from(r)])));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    ...(plte ? [chunk("PLTE", Buffer.from(plte))] : []),
    ...(trns ? [chunk("tRNS", Buffer.from(trns))] : []),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

test("decodes RGBA round trip", () => {
  const src = img(5, 3, (x, y) => [x * 50, y * 80, 7, x === 0 ? 0 : 255]);
  const out = decodePng(encodePng(src));
  assert.equal(out.width, 5);
  assert.deepEqual(Array.from(out.rgba), Array.from(src.rgba));
});

test("decodes a 2-bit palette PNG with transparency", () => {
  // 4 pixels: indices 0,1,2,3 packed in one byte.
  const png = rawPng({ width: 4, height: 1, depth: 2, colorType: 3, rows: [[0b00011011]], plte: [255, 0, 0, 0, 255, 0, 0, 0, 255, 9, 9, 9], trns: [0] });
  const out = decodePng(png);
  assert.deepEqual(Array.from(out.rgba), [255, 0, 0, 0, 0, 255, 0, 255, 0, 0, 255, 255, 9, 9, 9, 255]);
});

test("takes the high byte of 16-bit RGB", () => {
  const png = rawPng({ width: 1, height: 1, depth: 16, colorType: 2, rows: [[0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc]] });
  assert.deepEqual(Array.from(decodePng(png).rgba), [0x12, 0x56, 0x9a, 255]);
});

test("declines interlaced PNGs and non-PNG input", () => {
  const png = rawPng({ width: 1, height: 1, depth: 8, colorType: 0, rows: [[1]], interlace: 1 });
  assert.equal(decodePng(png), undefined);
  assert.equal(decodePng(Buffer.from("GIF89a....")), undefined);
});

test("stores and reads the grid in a tEXt chunk, keeping the image intact", () => {
  const png = encodePng(img(4, 2, () => [1, 2, 3, 255]));
  const stamped = withText(png, GRID_KEY, JSON.stringify({ cols: 2, rows: 1, frames: 2, fps: 8 }));
  assert.deepEqual(readGrid(stamped), { cols: 2, rows: 1, frames: 2, fps: 8 });
  assert.deepEqual(Array.from(decodePng(stamped).rgba), Array.from(decodePng(png).rgba));
  // Re-stamping replaces rather than duplicates.
  const again = withText(stamped, GRID_KEY, JSON.stringify({ cols: 1, rows: 2, frames: 2, fps: 4 }));
  assert.equal(readText(again)[GRID_KEY], JSON.stringify({ cols: 1, rows: 2, frames: 2, fps: 4 }));
});

test("reads the grid from an API result, falling back to a square", () => {
  assert.deepEqual(gridFromResult({ num_frames: 36, num_cols: 6, num_rows: 6, duration: 3 }), { cols: 6, rows: 6, frames: 36, fps: 12 });
  assert.deepEqual(gridFromResult({ num_frames: 16 }), { cols: 4, rows: 4, frames: 16, fps: 10 });
  assert.equal(gridFromResult({ num_frames: 7 }), undefined);
  assert.equal(gridFromResult({}), undefined);
  assert.deepEqual(parseGrid("8x4"), { cols: 8, rows: 4 });
  assert.equal(parseGrid("8 by 4"), undefined);
});

test("renders half blocks: two pixels per cell, transparency left to the terminal", () => {
  const src = img(2, 2, (x, y) => (x === 1 && y === 1 ? [0, 0, 0, 0] : [255, 0, 0, 255]));
  // A 2x2 sprite is scaled up 2x to 4x4 pixels: 4 columns, 2 rows.
  const lines = renderLines(src, { x: 0, y: 0, w: 2, h: 2 }, { maxCols: 4, maxRows: 2, truecolor: true });
  assert.equal(lines.length, 2);
  assert.match(lines[0], /\x1b\[38;2;255;0;0m\x1b\[48;2;255;0;0m▀/);
  // Bottom-right pixel is transparent: its cells fall back to the terminal.
  assert.equal(lines[1], "\x1b[38;2;255;0;0m\x1b[48;2;255;0;0m▀".repeat(2) + "\x1b[0m ".repeat(2) + "\x1b[0m");
});

test("scales small pixel art up by whole steps and big sheets down to fit", () => {
  assert.equal(fit({ x: 0, y: 0, w: 16, h: 16 }, { maxCols: 48, maxRows: 20, truecolor: true }).cols, 32);
  const big = fit({ x: 0, y: 0, w: 1024, h: 1024 }, { maxCols: 48, maxRows: 20, truecolor: true });
  assert.ok(big.cols <= 48 && big.rows <= 20);
});

test("visuals stay off for agents, pipes, CI and opt-outs", () => {
  const saved = { out: process.stdout.isTTY, err: process.stderr.isTTY, env: { ...process.env } };
  const set = (o, v) => Object.defineProperty(o, "isTTY", { value: v, configurable: true });
  try {
    set(process.stdout, true);
    set(process.stderr, true);
    for (const k of ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CODEX_SANDBOX", "CODEX_CI", "CURSOR_AGENT", "GEMINI_CLI", "AIDER_MODEL", "AGENT", "CI", "NO_COLOR", "LUDO_PREVIEW"]) delete process.env[k];
    process.env.TERM = "xterm-256color";
    const on = { json: false, quiet: false, plain: false };
    if (process.platform !== "win32") assert.equal(visuals(on).enabled, true);
    assert.equal(visuals({ ...on, json: true }).enabled, false);
    assert.equal(visuals({ ...on, plain: true }).enabled, false);
    for (const [k, v] of [["CLAUDECODE", "1"], ["CI", "true"], ["NO_COLOR", ""], ["LUDO_PREVIEW", "0"], ["TERM", "dumb"]]) {
      process.env[k] = v;
      assert.equal(visuals(on).enabled, false, `${k} should turn visuals off`);
      delete process.env[k];
      process.env.TERM = "xterm-256color";
    }
    set(process.stdout, false);
    assert.equal(visuals(on).enabled, false, "a pipe on stdout turns visuals off");
  } finally {
    set(process.stdout, saved.out);
    set(process.stderr, saved.err);
    process.env = saved.env;
  }
});

test("suggests the next step in the pipeline", () => {
  assert.match(nextStep("createImage", [{ path: "ludo-output/a.png" }], { image_type: "sprite" }), /ludo sprite animate --initial-image ludo-output\/a\.png/);
  assert.match(nextStep("create3DModel", [{ path: "out/m.glb" }]), /ludo model rig --model out\/m\.glb/);
  assert.match(nextStep("rigModel", [{ path: "out/r.glb" }]), /ludo model animate --model out\/r\.glb/);
  assert.equal(nextStep("createMusic", [{ path: "a.mp3" }]), undefined);
  assert.match(nextStep("createImage", [{ path: "my dir/a.png" }], {}), /"my dir\/a\.png"/);
});

test("draws a credits bar", () => {
  assert.equal(creditsBar(50, 100, 10), "▰▰▰▰▰▱▱▱▱▱");
  assert.equal(creditsBar(0, 0, 4), "▱▱▱▱");
});

const { detectProtocol, kittySequence, itermSequence, cellSize } = await import("../dist/tty/graphics.js");
const { isPixelArt } = await import("../dist/tty/preview.js");

test("detects the terminal's image protocol, and none inside tmux", () => {
  assert.equal(detectProtocol({ TERM_PROGRAM: "ghostty" }), "kitty");
  assert.equal(detectProtocol({ KITTY_WINDOW_ID: "1" }), "kitty");
  assert.equal(detectProtocol({ TERM_PROGRAM: "WezTerm" }), "kitty");
  assert.equal(detectProtocol({ TERM_PROGRAM: "iTerm.app" }), "iterm");
  assert.equal(detectProtocol({ LC_TERMINAL: "iTerm2" }), "iterm");
  assert.equal(detectProtocol({ TERM_PROGRAM: "Apple_Terminal" }), undefined);
  assert.equal(detectProtocol({ TERM_PROGRAM: "iTerm.app", TMUX: "/tmp/tmux" }), undefined);
});

test("kitty images go out as PNG in 4096-byte chunks, keyed only on the first", () => {
  const seq = kittySequence(Buffer.alloc(5000, 7), 20, 10, 1);
  const chunks = seq.split("\x1b\\").filter(Boolean);
  assert.equal(chunks.length, 2);
  assert.match(chunks[0], /^\x1b_Ga=T,f=100,q=2,C=1,c=20,r=10,i=1,p=1,m=1;/);
  assert.match(chunks[1], /^\x1b_Gm=0;/);
});

test("iTerm2 images are one inline sequence sized in cells", () => {
  const seq = itermSequence(Buffer.from("png"), 20, 10);
  assert.equal(seq, `\x1b]1337;File=inline=1;size=3;width=20;height=10;preserveAspectRatio=1:${Buffer.from("png").toString("base64")}\x07`);
});

test("sizes images in cells, which are twice as tall as wide", () => {
  assert.deepEqual(cellSize({ width: 100, height: 100 }, 48, 16), { cols: 32, rows: 16 });
  assert.deepEqual(cellSize({ width: 400, height: 100 }, 48, 16), { cols: 48, rows: 6 });
});

test("only small or few-colour images count as pixel art", () => {
  const flat = img(256, 256, (x, y) => [(x >> 5) * 30, (y >> 5) * 30, 0, 255]); // 8x8 blocks of colour
  assert.equal(isPixelArt(flat, { x: 0, y: 0, w: 256, h: 256 }), true);
  const painted = img(256, 256, (x, y) => [x, y, (x * y) & 255, 255]);
  assert.equal(isPixelArt(painted, { x: 0, y: 0, w: 256, h: 256 }), false);
  assert.equal(isPixelArt(painted, { x: 0, y: 0, w: 96, h: 96 }), true);
});
