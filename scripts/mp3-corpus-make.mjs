// Writes the MP3 corpus (test/corpus/mp3): short synthetic signals (a
// sweep with clicks, which make LAME switch to short blocks, a tone with
// noise, silence; no recorded audio) encoded with LAME, with ffmpeg's
// libmp3lame and mp2 encoders, by scripts/mp3-synth.mjs (layers I and II
// in modes ffmpeg cannot write), and rewritten by scripts/mp3-rewrite.py
// into kinds no common encoder writes (intensity stereo, mixed blocks,
// window switching without start and stop blocks); then ID3v2, ID3v1, APE
// tags and junk around some. Run it, then scripts/mp3-corpus-expected.mjs
// (after `npm run build`). The files are committed, so the tests need none
// of these tools. Written with LAME 4.0 and ffmpeg 9.0.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const out = new URL("../test/corpus/mp3/", import.meta.url).pathname;
const scripts = new URL(".", import.meta.url).pathname;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mp3-corpus-"));
const run = (cmd, args) => execFileSync(cmd, args, { stdio: ["ignore", "ignore", "inherit"] });
fs.mkdirSync(out, { recursive: true });
for (const f of fs.readdirSync(out)) if (/\.mp[123]$/.test(f)) fs.rmSync(path.join(out, f));

// The signal at a rate: left a sweep up to about a third of the rate with a
// click every 0.3 s, right a tone with noise. Mono files take the left.
const wavs = new Map();
function wav(rate, { seconds = 0.6, channels = 2, kind = "sweep" } = {}) {
  const key = `${rate}-${seconds}-${channels}-${kind}`;
  if (wavs.has(key)) return wavs.get(key);
  const file = path.join(tmp, `${key}.wav`);
  const sweep = `0.5*sin(2*PI*(100+${rate * 0.15}*t)*t)+if(lt(mod(t,0.3),0.004),0.8*sin(2*PI*${Math.min(3000, rate / 4)}*t),0)`;
  const tone = "0.3*sin(2*PI*330*t)+0.15*(random(0)*2-1)";
  const expr = kind === "silence" ? "0" : kind === "loud" ? `0.98*sin(2*PI*220*t)*if(lt(mod(t,0.2),0.1),1.3,1)` : sweep;
  const right = kind === "sweep" ? tone : expr;
  run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `aevalsrc='${expr}|${right}':d=${seconds}:s=${rate}`, "-ac", String(channels), "-c:a", "pcm_s16le", file]);
  wavs.set(key, file);
  return file;
}
const lame = (name, rate, args, opts) => run("lame", ["--quiet", ...args, wav(rate, opts), path.join(out, name)]);
const lameTmp = (name, rate, args, opts) => {
  const file = path.join(tmp, name);
  run("lame", ["--quiet", ...args, wav(rate, opts), file]);
  return file;
};
const rewrite = (cmd, src, name, ...rest) => run("python3", ["-I", path.join(scripts, "mp3-rewrite.py"), cmd, src, path.join(out, name), ...rest]);
const synth = (name, ...args) => run(process.execPath, [path.join(scripts, "mp3-synth.mjs"), path.join(out, name), ...args.map(String)]);

// LAME across the sample rates, modes and rate controls.
lame("lame-44k-js-cbr192.mp3", 44100, ["-b", "192"]);
lame("lame-44k-js-v2.mp3", 44100, ["-V", "2"], { kind: "loud" });
lame("lame-48k-st-abr96.mp3", 48000, ["-m", "s", "--abr", "96"]);
lame("lame-32k-mono-cbr48.mp3", 32000, ["-m", "m", "-b", "48"]);
lame("lame-32k-ms-cbr96.mp3", 32000, ["-m", "f", "-b", "96"]);
lame("lame-24k-js-v4.mp3", 24000, ["-V", "4"]);
lame("lame-22k-js-cbr48-crc.mp3", 22050, ["-p", "-b", "48"]);
lame("lame-16k-mono-abr32.mp3", 16000, ["-m", "m", "--abr", "32"]);
lame("lame-12k-dual-cbr32.mp3", 12000, ["-m", "d", "-b", "32"]);
lame("lame-11k-js-v6.mp3", 11025, ["-V", "6"]);
lame("lame-8k-mono-cbr16.mp3", 8000, ["-m", "m", "-b", "16"]);
lame("lame-8k-js-v7.mp3", 8000, ["-V", "7"]);
lame("lame-44k-silence-v5.mp3", 44100, ["-V", "5"], { kind: "silence" });
lame("lame-44k-no-tag.mp3", 44100, ["-t", "-b", "96"]);
lame("lame-44k-nores.mp3", 44100, ["--nores", "-b", "112"]);
lame("lame-44k-free-format.mp3", 44100, ["--freeformat", "-b", "160"]);

// ffmpeg's encoders: libmp3lame (an Info tag that says Lavf) and mp2.
const ff = (name, args, src) => run("ffmpeg", ["-v", "error", "-y", "-i", src, ...args, path.join(out, name)]);
ff("lavf-44k-cbr128.mp3", ["-c:a", "libmp3lame", "-b:a", "128k"], wav(44100));
ff("lavf-48k-mono-vbr.mp3", ["-c:a", "libmp3lame", "-q:a", "3", "-ac", "1"], wav(48000));
ff("ffmpeg-44k-l2-192.mp2", ["-c:a", "mp2", "-b:a", "192k"], wav(44100));
ff("ffmpeg-24k-l2-mono-64.mp2", ["-c:a", "mp2", "-b:a", "64k", "-ac", "1"], wav(24000));

// Layers I and II written directly (layer, version, rate index, bitrate
// index, mode, mode extension, frames, seed).
synth("synth-44k-l1-st-192.mp1", 1, 1, 0, 6, 0, 0, 40, 1);
synth("synth-48k-l1-js-256.mp1", 1, 1, 1, 8, 1, 1, 40, 2);
synth("synth-22k-l1-mono-64.mp1", 1, 2, 0, 4, 3, 0, 24, 3);
synth("synth-44k-l2-js-192.mp2", 2, 1, 0, 10, 1, 2, 16, 4);
synth("synth-48k-l2-js-256.mp2", 2, 1, 1, 12, 1, 3, 12, 7);
synth("synth-24k-l2-js-64.mp2", 2, 2, 1, 8, 1, 0, 16, 5);
synth("synth-32k-l2-mono-48.mp2", 2, 1, 2, 2, 3, 0, 16, 6);

// Rewritten LAME streams.
rewrite("intensity1", lameTmp("js32.mp3", 32000, ["-b", "96"]), "rewrite-32k-intensity.mp3");
rewrite("intensity2", lameTmp("nr22.mp3", 22050, ["--nores", "-m", "j", "-b", "48"]), "rewrite-22k-intensity.mp3", "1");
rewrite("intensity2", lameTmp("nr16.mp3", 16000, ["--nores", "-m", "j", "-b", "40"]), "rewrite-16k-intensity-t5.mp3", "3", "t5");
rewrite("mixed", lameTmp("nrc44.mp3", 44100, ["--nores", "-b", "128"]), "rewrite-44k-mixed.mp3");
rewrite("mixed", lameTmp("nrc22.mp3", 22050, ["--nores", "-b", "64"]), "rewrite-22k-mixed.mp3");
rewrite("noswitch", lameTmp("sw44.mp3", 44100, ["-V", "4"]), "rewrite-44k-no-start-stop.mp3");

// Tags and junk around a LAME stream.
const base = fs.readFileSync(lameTmp("tags.mp3", 44100, ["-b", "64"], { seconds: 0.5 }));
const syncsafe = n => [(n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127];
const frame23 = (id, body) => Buffer.concat([Buffer.from(id, "latin1"), Buffer.from([body.length >>> 24, (body.length >> 16) & 255, (body.length >> 8) & 255, body.length & 255, 0, 0]), body]);
const text = s => Buffer.concat([Buffer.from([0]), Buffer.from(s, "latin1")]);
function id3(version, frames, { footer = false, padding = 0 } = {}) {
  const body = Buffer.concat([...frames, Buffer.alloc(padding)]);
  const head = Buffer.from([0x49, 0x44, 0x33, version, 0, footer ? 0x10 : 0, ...syncsafe(body.length)]);
  const foot = footer ? Buffer.from([0x33, 0x44, 0x49, version, 0, 0x10, ...syncsafe(body.length)]) : Buffer.alloc(0);
  return Buffer.concat([head, body, foot]);
}
// A cover picture: a JPEG with sync-like bytes (0xFFFB...) all through it.
const jpeg = path.join(tmp, "cover.jpg");
run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "mandelbrot=s=320x240:end_pts=1", "-frames:v", "1", "-q:v", "3", jpeg]);
const pic = fs.readFileSync(jpeg);
const apic = frame23("APIC", Buffer.concat([Buffer.from([0]), Buffer.from("image/jpeg\0\x03\0", "latin1"), pic]));
fs.writeFileSync(path.join(out, "tags-id3v23-picture.mp3"), Buffer.concat([id3(3, [frame23("TIT2", text("Sweep")), frame23("TPE1", text("Ludo test")), apic], { padding: 512 }), base]));
fs.writeFileSync(path.join(out, "tags-two-id3v2-footer.mp3"), Buffer.concat([id3(4, [frame23("TIT2", text("One"))], { footer: true }), id3(3, [frame23("TIT2", text("Two"))]), base]));
const apeItem = (k, v) => Buffer.concat([Buffer.from([v.length, 0, 0, 0, 0, 0, 0, 0]), Buffer.from(k + "\0" + v, "latin1")]);
const items = Buffer.concat([apeItem("Title", "Sweep"), apeItem("Artist", "Ludo test")]);
const apeBlock = (flags, size) => {
  const b = Buffer.alloc(32);
  b.write("APETAGEX", 0, "latin1");
  b.writeUInt32LE(2000, 8);
  b.writeUInt32LE(size, 12);
  b.writeUInt32LE(2, 16);
  b.writeUInt32LE(flags, 20);
  return b;
};
const ape = Buffer.concat([apeBlock(0xa0000000, items.length + 32), items, apeBlock(0x80000000, items.length + 32)]);
const id3v1 = Buffer.alloc(128);
id3v1.write("TAGSweep", 0, "latin1");
id3v1.write("Ludo test", 33, "latin1");
fs.writeFileSync(path.join(out, "tags-ape-id3v1.mp3"), Buffer.concat([base, ape, id3v1]));
// Junk ahead of the first frame (so no Info tag is read, as in ffmpeg) and
// behind the last.
let s = 7;
const junk = n => Buffer.from(Array.from({ length: n }, () => (s = (s * 16807) % 2147483647) & 255));
fs.writeFileSync(path.join(out, "junk-around.mp3"), Buffer.concat([junk(700), base, Buffer.from("LYRICSBEGIN"), junk(90)]));
fs.rmSync(tmp, { recursive: true });
