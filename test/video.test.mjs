// `ludo toolbox sprite video` and `from-video`, through the system's ffmpeg
// (skipped without it; CI installs it), read back with ffprobe.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { encodePng, readPng, withText } from "../dist/tty/png.js";
import { readGrid } from "../dist/tty/preview.js";
import { joinFrames, sliceSheet } from "../dist/toolbox/sheet.js";

const exec = promisify(execFile);
const CLI = path.join(import.meta.dirname, "..", "dist", "cli.js");
const FFMPEG = spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;
const skip = !FFMPEG && "ffmpeg is not installed";

const ludo = async (dir, args, env = {}) => {
  try {
    const { stdout } = await exec(process.execPath, [CLI, "toolbox", "sprite", ...args, "--out", dir, "--json"], { cwd: dir, env: { ...process.env, LUDO_TELEMETRY: "0", LUDO_CONFIG_DIR: path.join(dir, ".config"), ...env } });
    return { code: 0, out: JSON.parse(stdout) };
  } catch (err) {
    return { code: err.code, stderr: err.stderr };
  }
};
const probe = file => JSON.parse(execFileSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=codec_name,pix_fmt,width,height,nb_read_frames,avg_frame_rate:stream_tags=alpha_mode", "-of", "json", file]).toString()).streams[0];

// Four 33x21 frames (odd, so MP4 has to pad): a moving disc on transparency.
function sheet(dir) {
  const frames = [0, 1, 2, 3].map(k => {
    const img = { width: 33, height: 21, rgba: new Uint8Array(33 * 21 * 4) };
    for (let y = 0; y < 21; y++) for (let x = 0; x < 33; x++) if ((x - 8 - 5 * k) ** 2 + (y - 10) ** 2 <= 36) img.rgba.set([220, 60 + 40 * k, 40, 255], (y * 33 + x) * 4);
    return img;
  });
  const file = path.join(dir, "disc.png");
  fs.writeFileSync(file, withText(encodePng(joinFrames(frames, 2).sheet), "ludo:grid", JSON.stringify({ cols: 2, rows: 2, frames: 4, fps: 8 })));
  return { file, frames };
}

test("a sheet to WebM with alpha and back gives the same frames", { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-video-"));
  const { file, frames } = sheet(dir);
  const webm = await ludo(dir, ["video", file]);
  assert.equal(webm.code, 0, webm.stderr);
  const s = probe(path.resolve(dir, path.basename(webm.out.video)));
  assert.deepEqual([s.codec_name, s.width, s.height, s.nb_read_frames, s.avg_frame_rate, s.tags?.alpha_mode], ["vp9", 33, 21, "4", "8/1", "1"]);

  const back = await ludo(dir, ["from-video", path.resolve(dir, path.basename(webm.out.video)), "--name", "back"]);
  assert.equal(back.code, 0, back.stderr);
  assert.deepEqual(back.out.grid, { cols: 2, rows: 2, frames: 4, frame_width: 33, frame_height: 21, fps: 8 });
  assert.equal(back.out.source.alpha, true);
  const buf = fs.readFileSync(path.resolve(dir, path.basename(back.out.sheet)));
  assert.deepEqual(readGrid(buf), { cols: 2, rows: 2, frames: 4, fps: 8 });
  // Lossy, so close: the transparent corner stays transparent, the disc's
  // centre keeps its colour within a few levels.
  sliceSheet(readPng(buf).image, 2, 2, 4).forEach((f, k) => {
    assert.ok(f.rgba[3] < 16, `frame ${k} corner alpha ${f.rgba[3]}`);
    const c = ((10 * 33) + 8 + 5 * k) * 4;
    const want = frames[k].rgba.subarray(c, c + 4);
    for (let ch = 0; ch < 4; ch++) assert.ok(Math.abs(f.rgba[c + ch] - want[ch]) <= 12, `frame ${k} channel ${ch}: ${f.rgba[c + ch]} vs ${want[ch]}`);
  });
});

test("MP4 is padded to even sizes on its background and loops; MOV is ProRes 4444 with alpha", { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-video-mp4-"));
  const { file } = sheet(dir);
  const mp4 = await ludo(dir, ["video", file, "--format", "mp4", "--loops", "3", "--background", "#203040"]);
  assert.equal(mp4.code, 0, mp4.stderr);
  assert.deepEqual([mp4.out.width, mp4.out.height, mp4.out.frames, mp4.out.transparent], [34, 22, 12, false]);
  const s = probe(path.resolve(dir, path.basename(mp4.out.video)));
  assert.deepEqual([s.codec_name, s.pix_fmt, s.width, s.height, s.nb_read_frames], ["h264", "yuv420p", 34, 22, "12"]);
  const corner = execFileSync("ffmpeg", ["-v", "error", "-i", path.resolve(dir, path.basename(mp4.out.video)), "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]).subarray(0, 3);
  assert.ok(Math.abs(corner[0] - 0x20) <= 6 && Math.abs(corner[1] - 0x30) <= 6 && Math.abs(corner[2] - 0x40) <= 6, [...corner].join());

  const mov = await ludo(dir, ["video", file, "--format", "mov", "--scale", "2"]);
  assert.equal(mov.code, 0, mov.stderr);
  const m = probe(path.resolve(dir, path.basename(mov.out.video)));
  assert.equal(m.codec_name, "prores");
  assert.match(m.pix_fmt, /^yuva444p/);
  assert.deepEqual([m.width, m.height], [66, 42]);
});

test("from-video resamples with --fps and --width", { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-video-from-"));
  const { file } = sheet(dir);
  const mp4 = await ludo(dir, ["video", file, "--format", "mp4", "--background", "#c8c8c8", "--loops", "2"]);
  const clip = path.resolve(dir, path.basename(mp4.out.video));
  const back = await ludo(dir, ["from-video", clip, "--fps", "4", "--width", "68", "--name", "back"]);
  assert.equal(back.code, 0, back.stderr);
  // 8 frames at 8 fps is 1 s: 4 frames at 4 fps.
  assert.equal(back.out.grid.frames, 4);
  assert.deepEqual([back.out.grid.frame_width, back.out.grid.frame_height, back.out.grid.fps], [68, 44, 4]);
  assert.equal((await ludo(dir, ["from-video", clip, "--key"])).code, 2);
});

test("without ffmpeg the video tools say how to get it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-video-none-"));
  const { file } = sheet(dir);
  const r = await ludo(dir, ["video", file], { PATH: path.join(dir, "no-such-bin") });
  assert.equal(r.code, 12);
  assert.match(r.stderr, /needs ffmpeg/);
  assert.match(r.stderr, /Install it:/);
});
