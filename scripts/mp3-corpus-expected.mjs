// Writes test/corpus/mp3/expected.json: for each file of the corpus, what a
// reference decoder gives, in a form the tests can check with no tools:
//  - rate, channels and samples (per channel), exactly;
//  - 40 samples a channel at fixed positions (the first and last 8, the rest
//    at random), as decoded, to 7 significant digits;
//  - each channel's sum of squares.
// The reference is ffmpeg (`ffmpeg -i f -f f32le -`; for layers I and II
// its float decoders, mp1float and mp2float, since its default ones there
// are fixed-point and round to 16 bits). Two files take LAME's decoder
// (`lame --decode`, 16-bit) instead: the free-format one, which ffmpeg
// cannot read, and the one that switches windows without start and stop
// blocks, where ffmpeg drops part of the previous window (see mp3.ts); for
// that one, how far ffmpeg is from us is recorded under `ffmpeg`.
// Our decoder's whole-file max abs error and SNR against the reference are
// recorded too, for the record. Needs ffmpeg and lame; run after
// `npm run build`, commit the result.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { decodeMp3 } from "../dist/toolbox/mp3.js";

const dir = new URL("../test/corpus/mp3/", import.meta.url).pathname;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mp3-expected-"));
const LAME_REFERENCE = new Set(["lame-44k-free-format.mp3", "rewrite-44k-no-start-stop.mp3"]);

function random(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Planar float channels of `ffmpeg -f f32le` (clamped to [-1, 1], as ours).
function ffmpeg(file) {
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-of", "json", file]).toString()).streams[0];
  const codec = probe.codec_name === "mp3" ? [] : ["-c:a", `${probe.codec_name}float`];
  const raw = execFileSync("ffmpeg", ["-v", "error", ...codec, "-i", file, "-f", "f32le", "-"], { maxBuffer: 1 << 30 });
  const pcm = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
  return { rate: +probe.sample_rate, channels: planar(pcm, probe.channels), name: codec.length ? `ffmpeg ${codec[1]}` : "ffmpeg" };
}

function lame(file) {
  const raw = path.join(tmp, "out.raw");
  execFileSync("lame", ["--quiet", "--decode", "-t", file, raw]);
  const buf = fs.readFileSync(raw);
  const s16 = new Int16Array(buf.buffer, buf.byteOffset, buf.length >> 1);
  const ours = decodeMp3(fs.readFileSync(file), { maxSamples: 1e9 });
  const nch = ours.channels.length; // lame's raw output does not say
  const pcm = Float32Array.from(s16, v => v / 32768);
  return { rate: ours.rate, channels: planar(pcm, nch), name: "lame --decode" };
}

function planar(pcm, nch) {
  const n = pcm.length / nch;
  return Array.from({ length: nch }, (_, c) => Float32Array.from({ length: n }, (_, i) => Math.max(-1, Math.min(1, pcm[i * nch + c]))));
}

function compare(a, b) {
  let max = 0;
  let sig = 0;
  let err = 0;
  for (let c = 0; c < a.length; c++) {
    for (let i = 0; i < Math.min(a[c].length, b[c].length); i++) {
      const e = a[c][i] - b[c][i];
      max = Math.max(max, Math.abs(e));
      sig += b[c][i] * b[c][i];
      err += e * e;
    }
  }
  return { maxErr: +max.toExponential(2), snr: sig ? +(10 * Math.log10(sig / Math.max(err, 1e-30))).toFixed(1) : null };
}

const expected = {};
for (const file of fs.readdirSync(dir).filter(f => /\.mp[123]$/.test(f)).sort()) {
  const full = path.join(dir, file);
  const ref = LAME_REFERENCE.has(file) ? lame(full) : ffmpeg(full);
  const n = ref.channels[0].length;
  const r = random(file.length * 7919 + n);
  const at = [...Array.from({ length: 8 }, (_, i) => i), ...Array.from({ length: 24 }, () => Math.floor(r() * n)), ...Array.from({ length: 8 }, (_, i) => n - 8 + i)].filter(i => i >= 0 && i < n);
  const ours = decodeMp3(fs.readFileSync(full), { maxSamples: 1e9 });
  const entry = {
    reference: ref.name,
    rate: ref.rate,
    channels: ref.channels.length,
    samples: n,
    points: at,
    values: ref.channels.map(ch => at.map(i => +ch[i].toPrecision(7))),
    energy: ref.channels.map(ch => +ch.reduce((s, v) => s + v * v, 0).toPrecision(9)),
    ours: { samples: ours.channels[0].length, ...compare(ours.channels, ref.channels) }
  };
  if (LAME_REFERENCE.has(file)) {
    try {
      const f = ffmpeg(full);
      entry.ffmpeg = { samples: f.channels[0].length, ...compare(ours.channels, f.channels) };
    } catch {
      entry.ffmpeg = "cannot decode it";
    }
  }
  expected[file] = entry;
  console.log(file, entry.reference, n, JSON.stringify(entry.ours), entry.ffmpeg ? JSON.stringify(entry.ffmpeg) : "");
}
// One line a file.
const lines = Object.entries(expected).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
fs.writeFileSync(path.join(dir, "expected.json"), `{\n${lines.join(",\n")}\n}\n`);
fs.rmSync(tmp, { recursive: true });
