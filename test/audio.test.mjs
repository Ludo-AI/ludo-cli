// The audio tools: WAV in and out (against ffmpeg's reading and writing where
// it is installed), loudness against EBU Tech 3341's test signals and ffmpeg's
// ebur128 filter, the sound functions, hostile WAVs, and the CLI. Checks
// that need ffmpeg skip without it, except where LUDO_REQUIRE_WEBP_TOOLS=1
// (CI installs it).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { decodeWav, encodeWav, isWav, WavError } from "../dist/toolbox/wav.js";
import { audibleRange, crossfadeLoop, fade, fromDb, loopClicks, loudness, repeats, samplePeak, toDb, truePeak } from "../dist/toolbox/sound.js";
import { EXIT } from "../dist/errors.js";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const REQUIRE = process.env.LUDO_REQUIRE_WEBP_TOOLS === "1";
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ludo-audio-test-"));
const MAX = 48000 * 60 * 10 * 2;

const ffmpeg = (() => {
  try {
    return spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;
  } catch {
    return false;
  }
})();
const needFfmpeg = t => {
  if (ffmpeg) return true;
  if (REQUIRE) assert.fail("ffmpeg is required here (LUDO_REQUIRE_WEBP_TOOLS=1)");
  t.skip("ffmpeg is not installed");
  return false;
};

// ffmpeg's own decode of a file, as planar float.
function ffmpegDecode(file, channels) {
  const res = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-f", "f32le", "-acodec", "pcm_f32le", "pipe:1"], { maxBuffer: 1 << 30 });
  assert.equal(res.status, 0, res.stderr.toString());
  const raw = new Float32Array(res.stdout.buffer, res.stdout.byteOffset, res.stdout.length / 4);
  const n = raw.length / channels;
  return Array.from({ length: channels }, (_, c) => Float32Array.from({ length: n }, (_, i) => raw[i * channels + c]));
}

// ffmpeg's ebur128 summary: integrated loudness, to 0.1.
function ebur128(file) {
  const res = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-af", "ebur128=framelog=quiet", "-f", "null", "-"]);
  const text = res.stderr.toString();
  return { lufs: Number(/I:\s+(-?[\d.]+|-inf) LUFS/.exec(text.slice(text.lastIndexOf("Summary:")))?.[1]) };
}

const rnd = seed => () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const sine = (rate, seconds, freq, db, phase = 0) => Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => fromDb(db) * Math.sin((2 * Math.PI * freq * i) / rate + phase));
const noise = (n, level, seed = 1) => {
  const r = rnd(seed);
  return Float32Array.from({ length: n }, () => level * (r() * 2 - 1));
};
const concat = (...parts) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const stereo = (rate, ch) => ({ rate, channels: [ch, Float32Array.from(ch)] });

// ---- WAV ----

test("WAV: what it writes reads back, at every depth and channel count", () => {
  const r = rnd(7);
  for (const n of [1, 2, 6]) {
    for (const bits of [16, 24, 32]) {
      const channels = Array.from({ length: n }, () => Float32Array.from({ length: 1001 }, () => r() * 2 - 1));
      const wav = decodeWav(encodeWav({ rate: 44100, channels }, { bits }), { maxSamples: MAX });
      assert.equal(wav.rate, 44100);
      assert.equal(wav.channels.length, n);
      assert.equal(wav.bits, bits);
      assert.equal(wav.float, bits === 32);
      const step = bits === 16 ? 1 / 32768 : bits === 24 ? 1 / 8388608 : 0;
      for (let c = 0; c < n; c++) for (let i = 0; i < 1001; i++) assert.ok(Math.abs(wav.channels[c][i] - channels[c][i]) <= step / 2 + 1e-7, `${n} ch ${bits} bits [${c}][${i}]`);
    }
  }
  // Full scale and past it clip, the steps round to the nearest.
  const loud = decodeWav(encodeWav({ rate: 8000, channels: [Float32Array.from([1, -1, 1.5, -2, 0.5 / 32768 + 1e-6])] }), { maxSamples: MAX });
  assert.deepEqual([...loud.channels[0]], [32767 / 32768, -1, 32767 / 32768, -1, 1 / 32768]);
});

test("WAV: a loop point is a smpl chunk, which reads back", () => {
  const audio = { rate: 22050, channels: [sine(22050, 0.5, 440, -6)] };
  const buf = encodeWav(audio, { loop: { start: 100, end: 11025 } });
  assert.equal(Buffer.from(buf).indexOf("smpl"), 36);
  assert.deepEqual(decodeWav(buf, { maxSamples: MAX }).loop, { start: 100, end: 11025 });
  assert.equal(decodeWav(encodeWav(audio), { maxSamples: MAX }).loop, undefined);
});

test("WAV: 8-bit, 64-bit float, extensible and streamed files read; µ-law is refused by name", () => {
  // Built byte by byte, as other writers lay them out.
  const wav = (tag, bits, channels, samples, { extensible = false, dataSize } = {}) => {
    const fmt = Buffer.alloc(extensible ? 40 : 16);
    fmt.writeUInt16LE(extensible ? 0xfffe : tag, 0);
    fmt.writeUInt16LE(channels, 2);
    fmt.writeUInt32LE(8000, 4);
    fmt.writeUInt32LE((8000 * channels * bits) / 8, 8);
    fmt.writeUInt16LE((channels * bits) / 8, 12);
    fmt.writeUInt16LE(bits, 14);
    if (extensible) {
      fmt.writeUInt16LE(22, 16);
      fmt.writeUInt16LE(bits, 18);
      fmt.writeUInt16LE(tag, 24);
      Buffer.from([0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71]).copy(fmt, 26);
    }
    const head = Buffer.alloc(12);
    head.write("RIFF", 0);
    head.writeUInt32LE(0xffffffff, 4);
    head.write("WAVE", 8);
    const chunk = (id, body, size = body.length) => {
      const h = Buffer.alloc(8);
      h.write(id, 0);
      h.writeUInt32LE(size, 4);
      return Buffer.concat([h, body, body.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
    };
    return Buffer.concat([head, chunk("fmt ", fmt), chunk("LIST", Buffer.from("INFOx")), chunk("data", samples, dataSize ?? samples.length)]);
  };
  const u8 = decodeWav(wav(1, 8, 1, Buffer.from([0, 64, 128, 192, 255])), { maxSamples: MAX });
  assert.deepEqual([...u8.channels[0]], [-1, -0.5, 0, 0.5, 127 / 128]);
  const f64 = Buffer.alloc(32);
  [0.25, -0.5, NaN, Infinity].forEach((v, i) => f64.writeDoubleLE(v, i * 8));
  const d = decodeWav(wav(3, 64, 2, f64, { extensible: true }), { maxSamples: MAX });
  assert.deepEqual([[...d.channels[0]], [...d.channels[1]]], [[0.25, 0], [-0.5, 1]]);
  assert.equal(d.float, true);
  // A data size of -1 (a writer that streamed it) means "to the end".
  const s16 = Buffer.alloc(8);
  [1000, -1000, 32767, -32768].forEach((v, i) => s16.writeInt16LE(v, i * 2));
  assert.equal(decodeWav(wav(1, 16, 2, s16, { dataSize: 0xffffffff }), { maxSamples: MAX }).channels[0].length, 2);
  assert.throws(() => decodeWav(wav(7, 8, 1, Buffer.from([1, 2])), { maxSamples: MAX }), e => e instanceof WavError && e.code === "UNSUPPORTED" && /µ-law/.test(e.message));
  assert.throws(() => decodeWav(wav(1, 16, 2, s16), { maxSamples: 3 }), e => e instanceof WavError && e.code === "TOO_LARGE");
  assert.equal(isWav(Buffer.from("RIFF\0\0\0\0AVI ")), false);
});

test("WAV: cut or damaged files give a WavError or samples, nothing else", () => {
  const good = encodeWav({ rate: 16000, channels: [noise(300, 0.5), noise(300, 0.5, 2)] }, { bits: 24, loop: { start: 10, end: 200 } });
  const tryRead = buf => {
    try {
      decodeWav(buf, { maxSamples: MAX });
    } catch (err) {
      if (!(err instanceof WavError)) throw err;
    }
  };
  for (let cut = 0; cut < good.length; cut++) tryRead(good.subarray(0, cut));
  const r = rnd(11);
  for (let k = 0; k < 3000; k++) {
    const bad = Uint8Array.from(good);
    for (let j = 1 + Math.floor(r() * 8); j > 0; j--) bad[Math.floor(r() * 80)] = Math.floor(r() * 256);
    tryRead(bad);
  }
});

test("WAV: ffmpeg reads ours as we wrote them, and we read ffmpeg's as it does", t => {
  if (!needFfmpeg(t)) return;
  const dir = tmp();
  const src = { rate: 48000, channels: [sine(48000, 0.2, 440, -3), noise(9600, 0.7, 5)] };
  for (const bits of [16, 24, 32]) {
    const file = path.join(dir, `ours-${bits}.wav`);
    fs.writeFileSync(file, encodeWav(src, { bits, loop: { start: 0, end: 9600 } }));
    const ours = decodeWav(fs.readFileSync(file), { maxSamples: MAX });
    const theirs = ffmpegDecode(file, 2);
    assert.deepEqual(theirs.map(c => [...c]), ours.channels.map(c => [...c]), `${bits}-bit`);
  }
  for (const codec of ["pcm_u8", "pcm_s16le", "pcm_s24le", "pcm_s32le", "pcm_f32le", "pcm_f64le"]) {
    const file = path.join(dir, `${codec}.wav`);
    const res = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=330:duration=0.3:sample_rate=32000", "-af", "pan=stereo|c0=c0|c1=-0.5*c0", "-c:a", codec, file]);
    assert.equal(res.status, 0, res.stderr.toString());
    const ours = decodeWav(fs.readFileSync(file), { maxSamples: MAX });
    assert.deepEqual(ours.channels.map(c => [...c]), ffmpegDecode(file, 2).map(c => [...c]), codec);
  }
});

// ---- Loudness and peaks ----

test("loudness: EBU Tech 3341's test signals measure what it says, at 48 and 44.1 kHz", () => {
  for (const rate of [48000, 44100]) {
    const s = (sec, db) => sine(rate, sec, 1000, db);
    const cases = [
      ["1: -23 dBFS for 20 s", s(20, -23), -23],
      ["2: -33 dBFS for 20 s", s(20, -33), -33],
      ["3: -36, -23, -36 dBFS", concat(s(10, -36), s(60, -23), s(10, -36)), -23],
      ["4: -72, -36, -23, -36, -72 dBFS", concat(s(10, -72), s(10, -36), s(60, -23), s(10, -36), s(10, -72)), -23],
      ["5: -26, -20, -26 dBFS", concat(s(20, -26), s(20.1, -20), s(20, -26)), -23]
    ];
    for (const [name, ch, want] of cases) {
      const got = loudness(stereo(rate, ch));
      assert.ok(Math.abs(got.lufs - want) <= 0.1, `${rate} Hz case ${name}: ${got.lufs.toFixed(2)} LUFS`);
      assert.equal(got.short, false);
    }
  }
  // Silence has no loudness; a sound under 400 ms is one block of its own length.
  assert.equal(loudness({ rate: 48000, channels: [new Float32Array(48000)] }).lufs, -Infinity);
  const blip = loudness(stereo(48000, sine(48000, 0.2, 1000, -23)));
  assert.equal(blip.short, true);
  assert.ok(Math.abs(blip.lufs + 23) < 0.1, String(blip.lufs));
});

test("true peak: the peak between the samples, which the samples miss", () => {
  // A sine at a quarter of the rate, shifted 45 degrees: every sample is at
  // 0.707 (-3 dB) while the wave reaches 1.
  const ch = sine(48000, 0.5, 12000, 0, Math.PI / 4);
  const a = stereo(48000, ch);
  assert.ok(Math.abs(toDb(samplePeak(a)) + 3.01) < 0.01);
  assert.ok(Math.abs(toDb(truePeak(a))) < 0.2, String(toDb(truePeak(a))));
  // Sines that fade in and out (a sudden start really does overshoot),
  // across the band: within Tech 3341's +0.2/-0.4 dB of their amplitude.
  for (const rate of [44100, 48000]) {
    for (const f of [100, 1000, 5000, 10000, 12000, 15000, 18000, 20000]) {
      for (let k = 0; k < 8; k++) {
        const n = rate / 5;
        const ramp = rate / 50;
        const wave = Float32Array.from({ length: n }, (_, i) => 0.5 * Math.min(1, i / ramp, (n - 1 - i) / ramp) * Math.sin((2 * Math.PI * f * i) / rate + (k * Math.PI) / 8));
        const err = toDb(truePeak({ rate, channels: [wave] })) - toDb(0.5);
        assert.ok(err <= 0.2 && err >= -0.4, `${rate} Hz, ${f} Hz, phase ${k}/8: ${err.toFixed(2)} dB`);
      }
    }
  }
  // Never under the sample peak.
  const square = { rate: 48000, channels: [Float32Array.from({ length: 4800 }, (_, i) => (i % 100 < 50 ? 0.5 : -0.5))] };
  assert.ok(truePeak(square) >= samplePeak(square));
});

// Not its true peak: ffmpeg's reads high near the top of the band (a 12 kHz
// sine peaking at -20.0 dB reads -19.4), outside EBU Tech 3341's tolerance.
test("loudness agrees with ffmpeg's ebur128 filter", t => {
  if (!needFfmpeg(t)) return;
  const dir = tmp();
  const r = rnd(3);
  for (const [rate, channels] of [[48000, 2], [44100, 2], [44100, 1], [22050, 2], [32000, 6]]) {
    for (let k = 0; k < 2; k++) {
      // Bursts of noise and tones at random levels, with gaps: the gates matter.
      const parts = [];
      for (let p = 0; p < 6; p++) {
        const sec = 0.3 + r() * 1.5;
        const n = Math.round(sec * rate);
        parts.push(r() < 0.3 ? new Float32Array(n) : r() < 0.5 ? noise(n, fromDb(-40 + r() * 38), Math.floor(r() * 1e6)) : sine(rate, sec, 50 + r() * 8000, -40 + r() * 38));
      }
      const ch = concat(...parts);
      const audio = { rate, channels: Array.from({ length: channels }, (_, c) => (c === 3 ? ch.map(v => v * 0.3) : Float32Array.from(ch, (v, i) => v * (1 - 0.1 * c) * (i % 7 === c ? -1 : 1)))) };
      const file = path.join(dir, `${rate}-${channels}-${k}.wav`);
      fs.writeFileSync(file, encodeWav(audio, { bits: 32 }));
      const want = ebur128(file);
      const ours = decodeWav(fs.readFileSync(file), { maxSamples: MAX });
      const got = loudness(ours);
      assert.ok(Math.abs(got.lufs - want.lufs) <= 0.11, `${rate} Hz ${channels} ch #${k}: ${got.lufs.toFixed(2)} vs ffmpeg ${want.lufs}`);
    }
  }
});

// ---- Silence, fades and loops ----

test("the audible range starts and ends where the sound does", () => {
  const ch = concat(new Float32Array(1000), noise(10, fromDb(-55)), sine(8000, 0.1, 500, -6), noise(300, fromDb(-60)), new Float32Array(50));
  const a = { rate: 8000, channels: [ch, new Float32Array(ch.length)] };
  const range = audibleRange(a, fromDb(-50));
  assert.equal(range.start, 1011); // the sine's first sample is 0
  assert.equal(range.end, 1010 + 800);
  assert.equal(audibleRange({ rate: 8000, channels: [noise(500, fromDb(-60))] }, fromDb(-50)), undefined);
});

test("a fade goes all the way without a jump", () => {
  const a = { rate: 8000, channels: [new Float32Array(800).fill(0.5)] };
  fade(a, 0, 400, "in");
  fade(a, 400, 400, "out");
  const ch = a.channels[0];
  assert.ok(ch[0] < 0.01 && ch[799] < 0.01 && ch[399] > 0.49 && ch[400] > 0.49);
  for (let i = 1; i < 800; i++) assert.ok(Math.abs(ch[i] - ch[i - 1]) < 0.005, `step at ${i}`);
});

test("a crossfaded loop wraps around without a click; one written several times is found", () => {
  const rate = 22050;
  // Noise with a slow swell and a tone: it does not end where it started.
  const n = rate * 2;
  const r = rnd(9);
  const ch = Float32Array.from({ length: n }, (_, i) => 0.4 * Math.sin((2 * Math.PI * 97 * i) / rate) + 0.01 * (r() * 2 - 1) + 0.2 * (i / n));
  const a = stereo(rate, ch);
  assert.equal(loopClicks(a), true);
  // Loud noise hides the same jump.
  assert.equal(loopClicks(stereo(rate, ch.map((v, i) => v + 0.3 * Math.sin(i * 1.7) * (r() * 2 - 1)))), false);
  const looped = crossfadeLoop(a, rate / 2);
  assert.equal(looped.channels[0].length, n - rate / 2);
  assert.equal(loopClicks(looped), false);
  // The seam: the loop's last sample runs into its first as the source ran on.
  assert.equal(looped.channels[0][0], ch[n - rate / 2]);
  assert.equal(looped.channels[0][rate], ch[rate]);
  for (const k of [2, 3, 4]) assert.equal(repeats(stereo(rate, concat(...new Array(k).fill(ch)))), k);
  assert.equal(repeats(a), 1);
  assert.equal(repeats(stereo(rate, concat(ch, noise(n, 0.5, 4)))), 1);
});

// ---- The CLI ----

// opts.noPath: no PATH under any spelling (Windows has Path), so no ffmpeg.
function run(args, opts = {}) {
  const cwd = opts.cwd ?? tmp();
  const base = opts.noPath ? { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toUpperCase() !== "PATH")), PATH: "" } : process.env;
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...base, LUDO_SPEC: path.join(cwd, "no-spec.json"), LUDO_API_KEY: "", LUDO_CONFIG_DIR: path.join(cwd, ".config"), LUDO_TELEMETRY: "0", ...opts.env }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", d => (stdout += d));
    child.stderr.on("data", d => (stderr += d));
    child.on("close", code => resolve({ code, stdout, stderr, cwd, json: () => JSON.parse(stdout) }));
  });
}

// A short sound effect with silence around it, as Ludo's often come.
function sfx(dir, name = "zap.wav", rate = 44100) {
  const ch = concat(new Float32Array(rate / 2), sine(rate, 0.6, 660, -12), noise(rate / 5, fromDb(-70)), new Float32Array(rate / 4));
  const file = path.join(dir, name);
  fs.writeFileSync(file, encodeWav(stereo(rate, ch)));
  return file;
}

test("audio info: length, loudness, peaks, silence and the loop seam, in JSON", async () => {
  const dir = tmp();
  const { code, stderr, json } = await run(["toolbox", "audio", "info", sfx(dir), "--json"], { cwd: dir });
  assert.equal(code, EXIT.OK, stderr);
  const info = json();
  assert.equal(info.format, "wav");
  assert.equal(info.codec, "16-bit PCM");
  assert.equal(info.rate, 44100);
  assert.equal(info.channels, 2);
  assert.equal(info.duration, 1.55);
  assert.ok(Math.abs(info.peak_db + 12) < 0.01);
  assert.equal(info.silence_start, 0.5);
  assert.equal(info.silence_end, 0.45);
  assert.equal(info.loop_clicks, false);
  assert.match(info.hint.command, /^ludo toolbox audio trim /);
});

test("audio trim cuts the silence, keeps --pad of it and fades the cuts", async () => {
  const dir = tmp();
  const file = sfx(dir);
  const { code, stderr, json } = await run(["toolbox", "audio", "trim", file, "--json", "--out", "out"], { cwd: dir });
  assert.equal(code, EXIT.OK, stderr);
  const out = json();
  assert.equal(out.audio, path.join("out", "zap.wav"));
  assert.equal(out.duration, 0.62);
  assert.equal(out.cut_start, 0.49);
  assert.equal(out.cut_end, 0.44);
  const wav = decodeWav(fs.readFileSync(path.join(dir, out.audio)), { maxSamples: MAX });
  assert.equal(wav.channels[0][0], 0);
  // --only end keeps the start; --start and --end cut where they say.
  const end = (await run(["toolbox", "audio", "trim", file, "--only", "end", "--json"], { cwd: dir })).json();
  assert.equal(end.cut_start, 0);
  const exact = (await run(["toolbox", "audio", "trim", file, "--start", "0.25", "--end", "1s", "--json"], { cwd: dir })).json();
  assert.equal(exact.duration, 0.75);
  // Silence, and cuts that leave nothing, are refused.
  fs.writeFileSync(path.join(dir, "hush.wav"), encodeWav({ rate: 8000, channels: [noise(800, fromDb(-80))] }));
  const hush = await run(["toolbox", "audio", "trim", "hush.wav"], { cwd: dir });
  assert.equal(hush.code, EXIT.BAD_INPUT);
  assert.match(hush.stderr, /is silent: nothing in it is louder than -50 dBFS/);
  assert.equal((await run(["toolbox", "audio", "trim", file, "--start", "2"], { cwd: dir })).code, EXIT.USAGE);
});

test("audio normalize reaches the loudness, stops at the ceiling, or sets the peak", async () => {
  const dir = tmp();
  const file = path.join(dir, "bed.wav");
  fs.writeFileSync(file, encodeWav(stereo(48000, concat(noise(48000 * 3, 0.05, 2), sine(48000, 2, 220, -30))), { bits: 24 }));
  const a = (await run(["toolbox", "audio", "normalize", file, "--json"], { cwd: dir })).json();
  const out = decodeWav(fs.readFileSync(path.join(dir, a.audio)), { maxSamples: MAX });
  assert.equal(out.bits, 24);
  assert.ok(Math.abs(loudness(out).lufs + 16) < 0.05, String(loudness(out).lufs));
  assert.equal(a.loudness_after, -16);
  assert.equal(a.limited_by_ceiling, undefined);
  // A sound whose peaks are far above its loudness stops at the ceiling.
  const spiky = path.join(dir, "spiky.wav");
  const ch = noise(48000 * 2, 0.01, 3);
  for (let i = 0; i < ch.length; i += 9600) ch[i] = 0.9;
  fs.writeFileSync(spiky, encodeWav(stereo(48000, ch), { bits: 32 }));
  const b = (await run(["toolbox", "audio", "normalize", spiky, "--lufs", "-14", "--json"], { cwd: dir })).json();
  assert.equal(b.limited_by_ceiling, true);
  assert.equal(b.true_peak_after, -1);
  assert.ok(b.loudness_after < -14);
  const c = (await run(["toolbox", "audio", "normalize", spiky, "--peak", "-3", "--json"], { cwd: dir })).json();
  assert.equal(c.true_peak_after, -3);
  assert.equal((await run(["toolbox", "audio", "normalize", spiky, "--peak", "-3", "--lufs", "-16"], { cwd: dir })).code, EXIT.USAGE);
});

test("audio loop crossfades, keeps one copy of a repeated loop, and marks the WAV loop", async () => {
  const dir = tmp();
  const rate = 32000;
  const r = rnd(5);
  const ch = Float32Array.from({ length: rate * 3 }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 61 * i) / rate) + (0.2 * i) / (rate * 3) * (r() * 2 - 1) + 0.1);
  fs.writeFileSync(path.join(dir, "hum.wav"), encodeWav(stereo(rate, ch)));
  const a = (await run(["toolbox", "audio", "loop", "hum.wav", "--json"], { cwd: dir })).json();
  // A 1 s crossfade, at most a quarter of the sound.
  assert.equal(a.loop_duration, 2.25);
  assert.equal(a.crossfade, 0.75);
  assert.equal(a.loop_clicks, false);
  const wav = decodeWav(fs.readFileSync(path.join(dir, a.audio)), { maxSamples: MAX });
  assert.deepEqual(wav.loop, { start: 0, end: rate * 2.25 });
  // Ludo has served loops written out twice: one copy is the loop.
  fs.writeFileSync(path.join(dir, "twice.wav"), encodeWav(stereo(rate, concat(ch, ch))));
  const b = (await run(["toolbox", "audio", "loop", "twice.wav", "--json", "--count", "3"], { cwd: dir })).json();
  assert.equal(b.repeats, 2);
  assert.equal(b.crossfade, 0);
  assert.equal(b.loop_duration, 3);
  assert.equal(b.duration, 9);
  // --in-place keeps the format.
  const c = await run(["toolbox", "audio", "loop", "hum.wav", "--in-place", "--to", "ogg"], { cwd: dir });
  assert.equal(c.code, EXIT.USAGE);
  assert.match(c.stderr, /--in-place keeps the format/);
});

test("a WAV named .mp3 is read as the WAV it is, with no ffmpeg", async () => {
  const dir = tmp();
  fs.copyFileSync(sfx(dir), path.join(dir, "ambiance.mp3"));
  const { code, stderr, json } = await run(["toolbox", "audio", "info", "ambiance.mp3", "--json"], { cwd: dir, noPath: true });
  assert.equal(code, EXIT.OK, stderr);
  assert.equal(json().format, "wav");
  // And with no ffmpeg, the formats it needs say how to get it.
  const ogg = await run(["toolbox", "audio", "convert", "ambiance.mp3", "--to", "ogg"], { cwd: dir, noPath: true });
  assert.equal(ogg.code, EXIT.BAD_INPUT);
  assert.match(ogg.stderr, /Writing OGG needs ffmpeg[\s\S]*--to wav/);
});

test("audio convert writes Ogg Vorbis, MP3 and FLAC that ffmpeg reads back; MP3 in through ffmpeg", async t => {
  if (!needFfmpeg(t)) return;
  const dir = tmp();
  const file = sfx(dir, "zap.wav", 48000);
  const probe = f => JSON.parse(spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,channels,sample_rate", "-of", "json", f]).stdout.toString()).streams[0];
  for (const [to, codec] of [["ogg", "vorbis"], ["mp3", "mp3"], ["flac", "flac"]]) {
    const { code, stderr, json } = await run(["toolbox", "audio", "convert", file, "--to", to, "--json"], { cwd: dir });
    assert.equal(code, EXIT.OK, stderr);
    const out = json();
    const p = probe(path.join(dir, out.saved));
    assert.equal(p.codec_name, codec);
    assert.equal(p.channels, out.channels);
    assert.equal(Number(p.sample_rate), 48000);
  }
  // MP3 in (through ffmpeg until the toolbox reads it itself), trimmed, out as MP3.
  const mp3 = path.join(dir, "ludo-output", "zap.mp3");
  const info = (await run(["toolbox", "audio", "info", mp3, "--json"], { cwd: dir })).json();
  assert.equal(info.format, "mp3");
  assert.equal(info.samples, 48000 * 1.55);
  const trimmed = (await run(["toolbox", "audio", "trim", mp3, "--json"], { cwd: dir })).json();
  assert.equal(trimmed.format, "mp3");
  assert.equal(probe(path.join(dir, trimmed.audio)).codec_name, "mp3");
  // --mono mixes the channels; FLAC takes 24 bits, not float.
  const mono = (await run(["toolbox", "audio", "convert", file, "--mono", "--json"], { cwd: dir })).json();
  assert.equal(mono.channels, 1);
  assert.equal((await run(["toolbox", "audio", "convert", file, "--to", "flac", "--bits", "32"], { cwd: dir })).code, EXIT.USAGE);
});
