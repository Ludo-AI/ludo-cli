// MP3 (MPEG audio layers I-III): the decoder against ffmpeg's decodes of a
// corpus (test/corpus/mp3, made by scripts/mp3-corpus-make.mjs), live
// against fresh libmp3lame encodes, hostile input, and its speed. The
// corpus check needs no tools; the live checks run where ffmpeg is
// installed and are required where LUDO_REQUIRE_MP3_TOOLS=1.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { decodeMp3, isMp3, Mp3Error } from "../dist/toolbox/mp3.js";

const CORPUS = fileURLToPath(new URL("./corpus/mp3/", import.meta.url));
const EXPECTED = JSON.parse(fs.readFileSync(path.join(CORPUS, "expected.json"), "utf8"));
const REQUIRE = process.env.LUDO_REQUIRE_MP3_TOOLS === "1";
const read = file => fs.readFileSync(path.join(CORPUS, file));
const BIG = 1e9;

// How far our samples may be from the reference's. Against ffmpeg's float
// decoders the two float pipelines differ by rounding: we measured at most
// 5.4e-6 on the corpus (2e-6 on real music), so 1e-5. Against LAME's
// 16-bit decoder add its rounding: two steps of 2^-15.
const BOUND = { ffmpeg: 1e-5, "ffmpeg mp1float": 1e-5, "ffmpeg mp2float": 1e-5, "lame --decode": 2 / 32768 };

const runs = (cmd, args) => {
  try {
    return spawnSync(cmd, args, { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
};
const out = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { stdio: ["ignore", "pipe", "ignore"] }).toString();
  } catch {
    return "";
  }
};
const FFMPEG = runs("ffmpeg", ["-version"]) && / libmp3lame /.test(out("ffmpeg", ["-hide_banner", "-encoders"]));
const LAME = runs("lame", ["--version"]);

function need(t, ok, name) {
  if (ok) return true;
  if (REQUIRE) assert.fail(`${name} is required (LUDO_REQUIRE_MP3_TOOLS) but not installed`);
  t.skip(`${name} is not installed`);
  return false;
}

// A deterministic random source (mulberry32).
function random(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The frames of a clean stream: [offset, size] by their headers.
const KBPS = {
  "1-1": [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  "1-2": [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  "1-3": [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  "0-1": [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  "0-2": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  "0-3": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
};
function frames(buf) {
  let i = 0;
  while (buf[i] !== 0xff && i < buf.length) i++;
  const list = [];
  while (i + 4 <= buf.length && buf[i] === 0xff && (buf[i + 1] & 0xe0) === 0xe0) {
    const mpeg1 = (buf[i + 1] >> 3) & 1;
    const layer = 4 - ((buf[i + 1] >> 1) & 3);
    const rate = [44100, 48000, 32000][(buf[i + 2] >> 2) & 3] >> (mpeg1 ? 0 : 1) >> ((buf[i + 1] >> 4) & 1 ? 0 : 1);
    const kbps = KBPS[`${mpeg1}-${layer}`][buf[i + 2] >> 4];
    if (!kbps) break;
    const spf = layer === 1 ? 384 : layer === 2 || mpeg1 ? 1152 : 576;
    const pad = (buf[i + 2] >> 1) & 1;
    const size = layer === 1 ? (Math.floor((12 * kbps * 1000) / rate) + pad) * 4 : Math.floor((spf * kbps * 125) / rate) + pad;
    list.push([i, size]);
    i += size;
  }
  return list;
}

// Ours vs a reference: max abs error and SNR over all samples.
function compare(got, ref) {
  let max = 0;
  let sig = 0;
  let err = 0;
  for (let c = 0; c < ref.length; c++) {
    for (let i = 0; i < ref[c].length; i++) {
      const r = Math.max(-1, Math.min(1, ref[c][i]));
      const e = got[c][i] - r;
      max = Math.max(max, Math.abs(e));
      sig += r * r;
      err += e * e;
    }
  }
  return { max, snr: 10 * Math.log10(sig / Math.max(err, 1e-30)) };
}

function ffmpegDecode(file) {
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-of", "json", file]).toString()).streams[0];
  const codec = probe.codec_name === "mp3" ? [] : ["-c:a", `${probe.codec_name}float`];
  const raw = execFileSync("ffmpeg", ["-v", "error", ...codec, "-i", file, "-f", "f32le", "-"], { maxBuffer: 1 << 30 });
  const pcm = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
  const nch = probe.channels;
  const n = pcm.length / nch;
  return { rate: +probe.sample_rate, channels: Array.from({ length: nch }, (_, c) => Float32Array.from({ length: n }, (_, i) => pcm[i * nch + c])) };
}

// ---- The corpus ----

test("the corpus decodes to the reference's sample count, and its samples within the measured bound", () => {
  for (const [file, e] of Object.entries(EXPECTED)) {
    const got = decodeMp3(read(file), { maxSamples: BIG });
    assert.equal(got.rate, e.rate, file);
    assert.equal(got.channels.length, e.channels, file);
    for (const ch of got.channels) assert.equal(ch.length, e.samples, `${file}: sample count`);
    assert.equal(got.layer, Number(file.slice(-1)), file);
    const bound = BOUND[e.reference];
    for (let c = 0; c < e.channels; c++) {
      const ch = got.channels[c];
      e.points.forEach((at, k) => assert.ok(Math.abs(ch[at] - e.values[c][k]) <= bound + 1e-7, `${file} ch ${c} sample ${at}: ${ch[at]} vs ${e.values[c][k]}`));
      let energy = 0;
      for (let i = 0; i < ch.length; i++) energy += ch[i] * ch[i];
      assert.ok(Math.abs(energy - e.energy[c]) <= 1e-4 * e.energy[c] + 1e-6, `${file} ch ${c} energy ${energy} vs ${e.energy[c]}`);
    }
  }
});

test("bitrate, VBR and layer come from the audio frames", () => {
  const info = file => {
    const { rate, layer, bitrate, vbr } = decodeMp3(read(file), { maxSamples: BIG });
    return { rate, layer, bitrate, vbr };
  };
  assert.deepEqual(info("lame-44k-js-cbr192.mp3"), { rate: 44100, layer: 3, bitrate: 192, vbr: false });
  assert.deepEqual(info("lavf-44k-cbr128.mp3"), { rate: 44100, layer: 3, bitrate: 128, vbr: false });
  assert.equal(info("lame-44k-js-v2.mp3").vbr, true);
  assert.equal(info("lame-48k-st-abr96.mp3").vbr, true);
  assert.deepEqual(info("lame-44k-free-format.mp3"), { rate: 44100, layer: 3, bitrate: 160, vbr: false });
  assert.deepEqual(info("synth-44k-l1-st-192.mp1"), { rate: 44100, layer: 1, bitrate: 192, vbr: false });
  assert.deepEqual(info("ffmpeg-44k-l2-192.mp2"), { rate: 44100, layer: 2, bitrate: 192, vbr: false });
  assert.deepEqual(info("lame-8k-mono-cbr16.mp3"), { rate: 8000, layer: 3, bitrate: 16, vbr: false });
});

test("isMp3: an ID3v2 tag, or a frame header the next frame confirms", () => {
  for (const file of Object.keys(EXPECTED)) assert.equal(isMp3(read(file)), file !== "junk-around.mp3", file);
  const cbr = read("lame-44k-js-cbr192.mp3");
  const [, size] = frames(cbr)[0];
  assert.equal(isMp3(cbr.subarray(0, size + 3)), false); // the next header is cut
  assert.equal(isMp3(Buffer.from("ID3\x04\0\0\0\0\0\0", "latin1")), true);
  assert.equal(isMp3(Buffer.from("RIFF\0\0\0\0WAVEfmt ", "latin1")), false);
  assert.equal(isMp3(new Uint8Array(0)), false);
  assert.equal(isMp3(Uint8Array.from([0xff, 0xfb, 0x90, 0x64])), false);
});

// ---- Live: ffmpeg ----

test("live: the corpus against ffmpeg's own decode, whole", t => {
  if (!need(t, FFMPEG, "ffmpeg")) return;
  for (const [file, e] of Object.entries(EXPECTED)) {
    if (!e.reference.startsWith("ffmpeg")) continue;
    const ref = ffmpegDecode(path.join(CORPUS, file));
    const got = decodeMp3(read(file), { maxSamples: BIG });
    assert.equal(got.channels[0].length, ref.channels[0].length, file);
    const { max, snr } = compare(got.channels, ref.channels);
    // The ffmpeg here may not be the one that made the references: Ubuntu's
    // older one rounds intensity stereo differently, up to 4e-5 (-88 dB).
    const bound = file.includes("intensity") ? 1e-4 : BOUND.ffmpeg;
    assert.ok(max <= bound, `${file}: max error ${max}`);
    if (!file.includes("silence")) assert.ok(snr >= 110, `${file}: SNR ${snr}`);
  }
});

test("live: fresh libmp3lame encodes decode to ffmpeg's sample count, within the bound", t => {
  if (!need(t, FFMPEG, "ffmpeg")) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-mp3-test-"));
  try {
    const cases = [
      ["44100", "2", ["-b:a", "128k"]],
      ["44100", "2", ["-q:a", "0"]],
      ["48000", "2", ["-b:a", "320k"]],
      ["48000", "1", ["-q:a", "5"]],
      ["32000", "2", ["-abr", "1", "-b:a", "96k"]],
      ["22050", "2", ["-q:a", "4"]],
      ["24000", "1", ["-b:a", "32k"]],
      ["16000", "2", ["-b:a", "48k", "-joint_stereo", "0"]],
      ["11025", "1", ["-q:a", "7"]],
      ["8000", "2", ["-b:a", "24k"]]
    ];
    for (const [rate, ch, args] of cases) {
      const file = path.join(dir, `${rate}-${ch}-${args.join("")}.mp3`);
      // Two seconds of a sweep, clicks and noise.
      const src = `aevalsrc='0.5*sin(2*PI*(80+${rate / 8}*t)*t)+if(lt(mod(t,0.37),0.003),0.7,0)+0.1*(random(0)-0.5)|0.4*sin(2*PI*440*t)+0.2*(random(1)-0.5)':d=2.3:s=${rate}`;
      execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", src, "-ac", ch, "-c:a", "libmp3lame", ...args, file]);
      const ref = ffmpegDecode(file);
      const got = decodeMp3(fs.readFileSync(file), { maxSamples: BIG });
      assert.equal(got.rate, ref.rate, file);
      assert.equal(got.channels.length, ref.channels.length, file);
      assert.equal(got.channels[0].length, ref.channels[0].length, `${file}: sample count`);
      const { max, snr } = compare(got.channels, ref.channels);
      assert.ok(max <= BOUND.ffmpeg && snr >= 110, `${file}: max error ${max}, SNR ${snr}`);
    }
    if (LAME) {
      // The LAME tool's own Info tag, VBR and the CRC.
      for (const args of [["-V", "2"], ["-p", "-b", "160"], ["--abr", "56", "-m", "m"]]) {
        const wav = path.join(dir, "src.wav");
        const file = path.join(dir, `lame${args.join("")}.mp3`);
        execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "aevalsrc='0.6*sin(2*PI*(200+3000*t)*t)':d=1.7:s=44100", "-ac", "2", wav]);
        execFileSync("lame", ["--quiet", ...args, wav, file]);
        const ref = ffmpegDecode(file);
        const got = decodeMp3(fs.readFileSync(file), { maxSamples: BIG });
        assert.equal(got.channels[0].length, ref.channels[0].length, `${file}: sample count`);
        assert.ok(compare(got.channels, ref.channels).max <= BOUND.ffmpeg, file);
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- Hostile input ----

// Decodes or refuses with an Mp3Error, within maxSamples, with samples in
// range; anything else (or our catch-all) fails the test.
function hostile(buf, label, maxSamples = 4_000_000) {
  try {
    const got = decodeMp3(buf, { maxSamples });
    assert.ok([1, 2].includes(got.channels.length), label);
    assert.ok(got.channels[0].length * got.channels.length <= maxSamples, label);
    for (const ch of got.channels) {
      assert.equal(ch.length, got.channels[0].length, label);
      for (let i = 0; i < ch.length; i += 13) if (!(ch[i] >= -1 && ch[i] <= 1)) assert.fail(`${label}: sample ${ch[i]}`);
    }
    return "read";
  } catch (e) {
    if (!(e instanceof Mp3Error)) throw new Error(`${label}: ${e.stack}`);
    assert.notEqual(e.message, "the MP3 data could not be decoded", `${label}: an internal error reached the catch-all`);
    return e.code;
  }
}

const HOSTILE_FILES = [
  "lame-44k-js-cbr192.mp3",
  "lame-44k-js-v2.mp3",
  "lame-22k-js-cbr48-crc.mp3",
  "lame-8k-js-v7.mp3",
  "lame-16k-mono-abr32.mp3",
  "lame-44k-free-format.mp3",
  "rewrite-22k-intensity.mp3",
  "rewrite-22k-mixed.mp3",
  "synth-48k-l1-js-256.mp1",
  "synth-24k-l2-js-64.mp2",
  "ffmpeg-44k-l2-192.mp2",
  "tags-id3v23-picture.mp3"
];

test("truncation at every frame boundary, a byte either side, and at random places", () => {
  const started = Date.now();
  const r = random(3);
  for (const file of HOSTILE_FILES) {
    const buf = read(file);
    const full = decodeMp3(buf, { maxSamples: BIG }).channels[0].length;
    const cuts = new Set();
    for (const [at, size] of frames(buf)) for (const d of [-1, 0, 1, size >> 1]) cuts.add(at + d);
    for (let k = 0; k < 40; k++) cuts.add(Math.floor(r() * buf.length));
    for (const cut of cuts) {
      if (cut < 0 || cut > buf.length) continue;
      const part = buf.subarray(0, cut);
      if (hostile(part, `${file} cut at ${cut}`) === "read") {
        // A cut never gives more than the whole.
        assert.ok(decodeMp3(part, { maxSamples: BIG }).channels[0].length <= full + 1152, `${file} cut at ${cut}`);
      }
    }
  }
  assert.ok(Date.now() - started < 60_000);
});

// Mutations: bytes changed, a run overwritten, bytes dropped, bit flips,
// random bytes over a stretch, a stretch repeated.
function mutate(original, k, r) {
  let b = Buffer.from(original);
  const at = () => Math.floor(r() * b.length);
  const kind = k % 6;
  if (kind === 0) for (let n = 0; n < 1 + r() * 20; n++) b[at()] = (r() * 256) | 0;
  else if (kind === 1) {
    const p = at();
    b.fill((r() * 256) | 0, p, Math.min(b.length, p + Math.floor(r() * 300)));
  } else if (kind === 2) {
    const p = at();
    b = Buffer.concat([b.subarray(0, p), b.subarray(p + 1 + Math.floor(r() * 500))]);
  } else if (kind === 3) for (let n = 0; n < 50; n++) b[at()] ^= 1 << ((r() * 8) | 0);
  else if (kind === 4) {
    const p = at();
    for (let i = p; i < Math.min(b.length, p + 2000); i++) b[i] = (r() * 256) | 0;
  } else {
    const p = at();
    const len = Math.floor(r() * 3000);
    b = Buffer.concat([b.subarray(0, p + len), b.subarray(p, p + len), b.subarray(p + len)]);
  }
  return b;
}

test("random damage to real files never escapes as anything but an Mp3Error", () => {
  const r = random(42);
  const started = Date.now();
  const codes = {};
  for (const file of HOSTILE_FILES) {
    const original = read(file);
    for (let k = 0; k < 120; k++) {
      const code = hostile(mutate(original, k, r), `${file} mutation ${k}`);
      codes[code] = (codes[code] || 0) + 1;
    }
  }
  assert.ok(codes.read > 1000, JSON.stringify(codes));
  assert.ok(Date.now() - started < 60_000);
});

test("random bytes behind real frame headers, and behind one valid header", () => {
  const r = random(7);
  const started = Date.now();
  for (const file of HOSTILE_FILES) {
    const original = read(file);
    const heads = new Set(frames(original).flatMap(([at]) => [at, at + 1, at + 2, at + 3]));
    // Every frame keeps its header and place; its payload is noise.
    for (let k = 0; k < 25; k++) {
      const b = Buffer.from(original);
      const density = r();
      for (let i = 0; i < b.length; i++) if (!heads.has(i) && r() < density) b[i] = (r() * 256) | 0;
      hostile(b, `${file} noisy payloads ${k}`);
    }
    // One header, then noise (the free-format file has no table bitrate to
    // walk its frames by: its first header).
    const [at] = frames(original)[1] || [original.indexOf(0xff, original[0] === 0x49 ? 10 : 0)];
    for (let k = 0; k < 25; k++) {
      const junk = Buffer.from(Array.from({ length: 1 + Math.floor(r() * 5000) }, () => (r() * 256) | 0));
      hostile(Buffer.concat([original.subarray(at, at + 4), junk]), `${file} header + junk ${k}`);
    }
  }
  // Headers of every kind, valid or not, repeated with noise between.
  for (let k = 0; k < 1500; k++) {
    const hdr = Buffer.from([0xff, 0xe0 | ((r() * 32) | 0), (r() * 256) | 0, (r() * 256) | 0]);
    const junk = Buffer.from(Array.from({ length: Math.floor(r() * 2500) }, () => (r() * 256) | 0));
    const parts = [];
    for (let j = 0, n = r() < 0.5 ? 1 : 30; j < n; j++) parts.push(hdr, junk.subarray(0, Math.floor(r() * junk.length)));
    hostile(Buffer.concat(parts), `header ${hdr.toString("hex")} ${k}`);
  }
  assert.ok(Date.now() - started < 60_000);
});

test("error codes, and TOO_LARGE before anything big is allocated", () => {
  const code = (buf, maxSamples = BIG) => {
    try {
      decodeMp3(buf, { maxSamples });
      return "read";
    } catch (e) {
      assert.ok(e instanceof Mp3Error, e.stack);
      return e.code;
    }
  };
  assert.equal(code(new Uint8Array(0)), "NOT_MP3");
  assert.equal(code(Buffer.from("not an mp3 at all, just some text")), "NOT_MP3");
  assert.equal(code(fs.readFileSync(new URL("./corpus/pngsuite/basn2c08.png", import.meta.url))), "NOT_MP3");
  assert.equal(code(Buffer.from("ID3\x03\0\0\0\0\0\x10" + "\0".repeat(16), "latin1")), "CORRUPT");
  // The limit counts samples times channels, after the gapless trim.
  const cbr = read("lame-44k-js-cbr192.mp3");
  const n = EXPECTED["lame-44k-js-cbr192.mp3"].samples;
  assert.equal(code(cbr, 2 * n), "read");
  assert.equal(code(cbr, 2 * n - 1), "TOO_LARGE");
  // An Info tag claiming 2^32 - 1 frames, and a long stream, with a large
  // limit and a small one: neither allocates for what the tag claims.
  const before = process.memoryUsage().arrayBuffers;
  const lying = Buffer.from(cbr);
  const [first] = frames(lying)[0];
  const info = lying.indexOf("Info", first, "latin1");
  lying.writeUInt32BE(0xffffffff, info + 8);
  assert.equal(code(lying, 4e9), "read");
  assert.equal(code(long(), 1000), "TOO_LARGE");
  assert.ok(process.memoryUsage().arrayBuffers - before < 64 * 1024 * 1024);
});

// ---- Speed ----

// Three minutes of 44.1 kHz stereo at 192 kbit/s: the audio frames of the
// corpus file over and over (the reservoir at each seam reads the previous
// copy's tail, which is still a valid stream to decode).
function long() {
  const buf = read("lame-44k-js-cbr192.mp3");
  const audio = frames(buf).slice(1);
  const body = buf.subarray(audio[0][0], audio.at(-1)[0] + audio.at(-1)[1]);
  const copies = Math.ceil((180 * 44100) / (audio.length * 1152));
  return Buffer.concat(Array(copies).fill(body));
}

test("speed: three minutes of 44.1 kHz stereo at 192 kbit/s", t => {
  const buf = long();
  decodeMp3(buf, { maxSamples: BIG }); // warm up
  const started = performance.now();
  const got = decodeMp3(buf, { maxSamples: BIG });
  const ms = performance.now() - started;
  const seconds = got.channels[0].length / got.rate;
  assert.ok(seconds >= 180);
  t.diagnostic(`decoded ${seconds.toFixed(0)} s of ${got.bitrate} kbit/s stereo in ${ms.toFixed(0)} ms`);
  assert.ok(ms < 10_000, `${ms} ms`);
});
