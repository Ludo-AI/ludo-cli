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
import { fitFrames } from "../dist/toolbox/video.js";

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

// LUDO_FFMPEG names a binary that is not there: with it set nothing else is
// tried, so the installers' folders don't supply one.
test("without ffmpeg the video tools say how to get it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-video-none-"));
  const { file } = sheet(dir);
  const r = await ludo(dir, ["video", file], { PATH: path.join(dir, "no-such-bin"), LUDO_FFMPEG: path.join(dir, "no-such-bin", "ffmpeg") });
  assert.equal(r.code, 12);
  assert.match(r.stderr, /needs ffmpeg/);
  assert.match(r.stderr, /Install it:/);
  assert.match(r.stderr, /LUDO_FFMPEG/);
});

test("LUDO_FFMPEG names an ffmpeg that is not on the PATH", { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-video-pinned-"));
  const { file } = sheet(dir);
  const where = spawnSync(process.platform === "win32" ? "where" : "which", ["ffmpeg"]).stdout.toString().split(/\r?\n/)[0].trim();
  assert.ok(where, "ffmpeg's path");
  const noPath = Object.fromEntries(Object.keys(process.env).filter(k => k.toUpperCase() === "PATH").map(k => [k, ""]));
  const r = await ludo(dir, ["video", file], { ...noPath, PATH: "", LUDO_FFMPEG: where });
  assert.equal(r.code, 0, r.stderr);
});

const HD = { width: 1920, height: 1080, fps: 30, duration: 3, codec: "h264", alpha: false };
const CAP = 8192 * 8192;

test("fitFrames keeps what fits, shrinks what does not, and refuses what would be tiny or was asked for", () => {
  // Half a second of 1080p (16 frames) fits as it is.
  assert.deepEqual(fitFrames(HD, { duration: 0.5, maxPixels: CAP }), { width: 1920, height: 1080, shrunk: false });
  // 3 s: 91 frames, shrunk to the largest even size that fits, aspect kept.
  const fit = fitFrames(HD, { maxPixels: CAP });
  assert.equal(fit.shrunk, true);
  assert.ok(fit.width % 2 === 0 && fit.height % 2 === 0);
  assert.ok(fit.width * fit.height * 91 <= CAP, "fits");
  assert.ok((fit.width + 2) * (Math.round(((fit.width + 2) * 1080) / 1920 / 2) * 2) * 91 > CAP, "and is the largest that does");
  assert.ok(Math.abs(fit.width / fit.height - 16 / 9) < 0.01);
  // A lower --fps is fewer frames, so less shrinking.
  assert.ok(fitFrames(HD, { fps: 10, maxPixels: CAP }).width > fit.width);
  // A --width the caller chose is never changed: too much is refused, with the seconds that fit.
  assert.throws(
    () => fitFrames(HD, { width: 1600, maxPixels: CAP }),
    err => err.exitCode === 2 && err.reason === "too-big" && /megapixels/.test(err.message) && /--duration 1\.5\b/.test(err.hint)
  );
  // Ten minutes would leave frames under 256 px wide: refused, not shrunk to a smudge.
  assert.throws(() => fitFrames({ ...HD, duration: 600 }, { maxPixels: CAP }), err => err.exitCode === 2 && err.reason === "too-big" && /--duration 1\b/.test(err.hint));
  // A container that does not say how long it is is left alone.
  assert.deepEqual(fitFrames({ ...HD, duration: 0 }, { maxPixels: CAP }), { width: 1920, height: 1080, shrunk: false });
});

test("from-video shrinks the frames of a clip too big for one sheet, and says so", { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-video-big-"));
  const clip = path.join(dir, "big.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=1920x1080:rate=30", "-t", "3", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", clip]);
  const r = await ludo(dir, ["from-video", clip]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.out.shrunk, true);
  assert.match(r.out.note, /shrunk from 1920x1080 to \d+x\d+/);
  assert.equal(r.out.grid.frames, 90);
  assert.ok(r.out.grid.frame_width < 1920 && r.out.grid.frame_width >= 256);
  assert.ok(r.out.width * r.out.height <= CAP);
  assert.deepEqual([r.out.source.width, r.out.source.height], [1920, 1080]);
  // The size the caller asked for is kept or refused, never changed.
  const asked = await ludo(dir, ["from-video", clip, "--width", "1600"]);
  assert.equal(asked.code, 2);
  assert.match(asked.stderr, /megapixels[\s\S]*--duration/);
  const part = await ludo(dir, ["from-video", clip, "--duration", "0.5", "--name", "part"]);
  assert.equal(part.code, 0, part.stderr);
  assert.equal(part.out.shrunk, undefined);
  assert.equal(part.out.grid.frame_width, 1920);
});

test("a failure's reason goes with the usage event, as a slug", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-video-why-"));
  const { file } = sheet(dir);
  const env = { LUDO_TELEMETRY: "1", DO_NOT_TRACK: "", CI: "", LUDO_API_URL: "http://127.0.0.1:9", PATH: path.join(dir, "no-such-bin"), LUDO_FFMPEG: path.join(dir, "no-such-bin", "ffmpeg") };
  assert.equal((await ludo(dir, ["video", file], env)).code, 12);
  assert.equal((await ludo(dir, ["from-video", path.join(dir, "missing.mp4")], env)).code, 2);
  assert.equal((await ludo(dir, ["from-video", file, "--speed", "2"], env)).code, 2);
  const events = fs.readFileSync(path.join(dir, ".config", "telemetry-queue.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l));
  assert.deepEqual(events.map(e => [e.command, e.props.exit_code, e.props.error_code]), [
    ["toolbox sprite video", 12, "no-ffmpeg"],
    ["toolbox sprite from-video", 2, "file-not-found"],
    ["toolbox sprite from-video", 2, "unknown-flag"]
  ]);
  assert.doesNotMatch(JSON.stringify(events), /missing|disc/);
});
