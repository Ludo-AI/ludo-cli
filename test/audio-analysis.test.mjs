// audio onsets and audio randomizer: onsets against clicks at known times,
// tempo against synthetic drum patterns built to fall into the half- and
// double-tempo traps, the envelope against a known attack and decay, the
// kind of sound, and the randomizer's engine files, which must point at the
// takes without touching them.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { encodeWav } from "../dist/toolbox/wav.js";
import { fromDb } from "../dist/toolbox/sound.js";
import { envelope, godotRandomizer, onsets, setName, shape, spectrum, tempo } from "../dist/toolbox/audio-analysis.js";
import { EXIT } from "../dist/errors.js";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ludo-audio-analysis-test-"));

function run(args, opts = {}) {
  const cwd = opts.cwd ?? tmp();
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...process.env, LUDO_SPEC: path.join(cwd, "no-spec.json"), LUDO_API_KEY: "", LUDO_CONFIG_DIR: path.join(cwd, ".config"), LUDO_TELEMETRY: "0" }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", d => (stdout += d));
    child.stderr.on("data", d => (stderr += d));
    child.on("close", code => resolve({ code, stdout, stderr, json: () => JSON.parse(stdout) }));
  });
}

const rnd = seed => () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

// Mixes `sound` into `into` at `at` seconds.
function place(into, rate, at, sound, gain = 1) {
  const o = Math.round(at * rate);
  for (let i = 0; i < sound.length && o + i < into.length; i++) into[o + i] += gain * sound[i];
}

// Drums: a kick (a sine falling from 120 to 50 Hz), a snare (noise and a
// 190 Hz body), a hi-hat (differenced noise: all top end), each decaying.
const kick = rate => Float32Array.from({ length: Math.round(rate * 0.25) }, (_, i) => {
  const t = i / rate;
  return 0.9 * Math.exp(-t / 0.06) * Math.sin(2 * Math.PI * (50 * t + (70 * 0.03) * (1 - Math.exp(-t / 0.03))));
});
const snare = (rate, seed = 3) => {
  const r = rnd(seed);
  return Float32Array.from({ length: Math.round(rate * 0.18) }, (_, i) => {
    const t = i / rate;
    return Math.exp(-t / 0.05) * (0.5 * (r() * 2 - 1) + 0.3 * Math.sin(2 * Math.PI * 190 * t));
  });
};
const hat = (rate, seed = 5) => {
  const r = rnd(seed);
  let last = 0;
  return Float32Array.from({ length: Math.round(rate * 0.04) }, (_, i) => {
    const v = r() * 2 - 1;
    const out = (v - last) * 0.5 * Math.exp(-i / rate / 0.012);
    last = v;
    return out;
  });
};

// `seconds` of a pattern at `bpm`: `steps(beat)` lists [offset in beats, sound, gain].
function beat(rate, bpm, seconds, steps) {
  const out = new Float32Array(Math.round(rate * seconds));
  const spb = 60 / bpm;
  for (let b = 0; b * spb < seconds; b++) for (const [offset, sound, gain] of steps(b)) place(out, rate, (b + offset) * spb, sound, gain);
  return out;
}

const write = (dir, name, rate, ...channels) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, encodeWav({ rate, channels }));
  return file;
};

const analyse = (rate, ch) => {
  const audio = { rate, channels: [ch] };
  const env = envelope(audio);
  const s = spectrum(audio, fromDb(-50));
  return { env, s, found: onsets(s, env, fromDb(-50)) };
};

// ---- Onsets ----

test("onsets: clicks land within 2 ms of where they are, at 44.1, 48 and 22.05 kHz", () => {
  const times = [0.1, 0.35, 0.6, 0.613 + 0.6, 1.9, 2.05];
  for (const rate of [44100, 48000, 22050]) {
    const ch = new Float32Array(rate * 2.5);
    const r = rnd(11);
    // A 3 ms tick of noise, then a 40 ms ring at 2 kHz, as a UI click is.
    const click = Float32Array.from({ length: Math.round(rate * 0.04) }, (_, i) => (i < rate * 0.003 ? 0.6 * (r() * 2 - 1) : 0) + 0.3 * Math.exp(-i / rate / 0.01) * Math.sin((2 * Math.PI * 2000 * i) / rate));
    times.forEach((t, i) => place(ch, rate, t, click, i % 2 ? 0.25 : 1));
    // A noise floor at -70 dBFS, as a lossy file has.
    for (let i = 0; i < ch.length; i++) ch[i] += fromDb(-70) * (r() * 2 - 1);
    const { found } = analyse(rate, ch);
    assert.equal(found.length, times.length, `${rate} Hz: ${found.map(o => o.at.toFixed(4))}`);
    found.forEach((o, i) => assert.ok(Math.abs(o.at - times[i]) <= 0.002, `${rate} Hz onset ${i}: ${(o.at * 1000).toFixed(1)} ms, not ${times[i] * 1000}`));
    // The quieter clicks are weaker onsets, and none is over 1.
    assert.ok(found.every(o => o.strength > 0 && o.strength <= 1));
    assert.ok(found[1].strength < found[0].strength);
  }
});

test("onsets: a sound that starts at its first sample hits at 0, and a noisy texture is not a string of hits", () => {
  const rate = 44100;
  const r = rnd(2);
  // Noise at an even level for 1.5 s: one onset, where it starts.
  const hiss = Float32Array.from({ length: rate * 1.5 }, () => 0.3 * (r() * 2 - 1));
  const { found } = analyse(rate, hiss);
  assert.equal(found.length, 1, found.map(o => o.at).join(", "));
  assert.equal(Math.round(found[0].at * 1000), 0);
});

// ---- The envelope ----

test("shape: hit, attack, peak and the decay to -20 and -40 dB of a known envelope", async () => {
  const rate = 48000;
  // 200 ms of silence, a 20 ms linear rise to 0.8, then e^(-t / 100 ms):
  // -20 dB after 100 ms x ln 10 = 230 ms, -40 dB after 461 ms, under -50
  // dBFS (0.8 -> 0.00316) after 100 ms x ln 253 = 553 ms.
  const tau = 0.1;
  const ch = Float32Array.from({ length: Math.round(rate * 1.2) }, (_, i) => {
    const t = i / rate - 0.2;
    const amp = t < 0 ? 0 : t < 0.02 ? 0.8 * (t / 0.02) : 0.8 * Math.exp(-(t - 0.02) / tau);
    return amp * Math.sin(2 * Math.PI * 440 * (i / rate));
  });
  const { env, found } = analyse(rate, ch);
  const sh = shape(env, found);
  assert.ok(Math.abs(sh.hit - 0.2) <= 0.004, `hit ${sh.hit}`);
  assert.ok(Math.abs(sh.peak - 0.22) <= 0.006, `peak ${sh.peak}`);
  assert.ok(Math.abs(sh.attack - 0.02) <= 0.006, `attack ${sh.attack}`);
  assert.ok(Math.abs(sh.decay20 - tau * Math.log(10)) <= 0.01, `decay20 ${sh.decay20}`);
  assert.ok(Math.abs(sh.decay40 - tau * Math.log(100)) <= 0.015, `decay40 ${sh.decay40}`);
  // The same through the CLI, in milliseconds.
  const dir = tmp();
  write(dir, "pluck.wav", rate, ch);
  const { code, stderr, json } = await run(["toolbox", "audio", "onsets", "pluck.wav", "--json"], { cwd: dir });
  assert.equal(code, EXIT.OK, stderr);
  const out = json();
  assert.equal(out.kind, "one-shot");
  assert.match(out.kind_reasons[0], /starts from silence.*dies away to silence/);
  assert.ok(Math.abs(out.start_ms - 200) <= 1);
  assert.ok(Math.abs(out.end_ms - (220 + 553)) <= 6, `end ${out.end_ms}`);
  assert.ok(Math.abs(out.tail_ms - (553 - 230)) <= 15, `tail ${out.tail_ms}`);
  assert.equal(out.tempo, undefined);
  assert.match(out.hint.command, /^ludo toolbox audio info pluck\.wav$/);
  // A short sweep of the gap between: a long attack is measured as one.
  const swell = Float32Array.from({ length: rate }, (_, i) => Math.min(1, i / (rate * 0.3)) * Math.exp(-Math.max(0, i / rate - 0.3) / 0.05) * 0.5 * Math.sin((2 * Math.PI * 300 * i) / rate));
  const s2 = analyse(rate, swell);
  const sh2 = shape(s2.env, s2.found);
  assert.ok(sh2.hit < 0.03 && Math.abs(sh2.attack + sh2.hit - 0.3) <= 0.03, `swell hit ${sh2.hit} attack ${sh2.attack}`);
});

// ---- Tempo ----

test("tempo: 120 BPM within 1%, through the half- and double-tempo traps", () => {
  const rate = 22050;
  const patterns = {
    // A kick on every beat.
    "four on the floor": (r => b => [[0, kick(r), 1]])(rate),
    // Loud hi-hats on every eighth: the autocorrelation also peaks at 240.
    "eighth hats": (r => b => [[0, kick(r), 1], [0, hat(r), 0.9], [0.5, hat(r, 7), 0.9]])(rate),
    // Kick on 1 and 3, snare on 2 and 4: kicks line up with kicks two beats
    // apart, so the autocorrelation also peaks at 60.
    "kick and snare": (r => b => [[0, b % 2 ? snare(r) : kick(r), 1]])(rate),
    // The same with eighth hats and a quieter snare.
    "backbeat with hats": (r => b => [[0, b % 2 ? snare(r) : kick(r), b % 2 ? 0.6 : 1], [0, hat(r), 0.3], [0.5, hat(r, 9), 0.3]])(rate)
  };
  for (const [name, steps] of Object.entries(patterns)) {
    const ch = beat(rate, 120, 20, steps);
    const { s } = analyse(rate, ch);
    const t = tempo(s);
    assert.ok(t, name);
    assert.ok(Math.abs(t.bpm / 120 - 1) < 0.01, `${name}: ${t.bpm.toFixed(2)} BPM`);
    assert.ok(t.confidence > 0.3 && t.beatsConfidence > 0.9, `${name}: confidence ${t.confidence}, beats ${t.beatsConfidence}`);
    // The beats sit on the pattern's beats, every 500 ms from 0.
    for (const b of t.beats) assert.ok(Math.abs(b / 0.5 - Math.round(b / 0.5)) * 0.5 < 0.015, `${name}: beat at ${b}`);
    assert.deepEqual(t.alternatives.map(a => Math.round(a.bpm)), [60, 80, 180, 240]);
  }
});

test("tempo: 150 BPM kick and snare (where the prior leans to 75) and 90 BPM with eighth hats (not 180)", () => {
  const rate = 22050;
  const fast = analyse(rate, beat(rate, 150, 16, b => [[0, b % 2 ? snare(rate) : kick(rate), 1], [0.5, hat(rate), 0.4]]));
  const t150 = tempo(fast.s);
  assert.ok(Math.abs(t150.bpm / 150 - 1) < 0.01, `${t150.bpm}`);
  const slow = analyse(rate, beat(rate, 90, 20, b => [[0, b % 2 ? snare(rate) : kick(rate), 1], [0.5, hat(rate), 0.8], [0, hat(rate, 8), 0.8]]));
  const t90 = tempo(slow.s);
  assert.ok(Math.abs(t90.bpm / 90 - 1) < 0.01, `${t90.bpm}`);
  // An odd tempo is measured, not rounded to a lag: 1 frame is 1.2% at 120 BPM.
  const odd = tempo(analyse(rate, beat(rate, 127.3, 20, b => [[0, kick(rate), 1]])).s);
  assert.ok(Math.abs(odd.bpm / 127.3 - 1) < 0.003, `${odd.bpm}`);
});

test("tempo: four beats a bar, with the downbeat where the bass changes", () => {
  const rate = 22050;
  // Hats on every beat; a kick and a new bass note on each bar's first
  // beat, which starts on beat 1 (0.5 s), not 0.
  const bass = f => Float32Array.from({ length: Math.round(rate * 1.9) }, (_, i) => 0.4 * Math.exp(-i / rate / 1.2) * Math.sin((2 * Math.PI * f * i) / rate));
  const notes = [55, 73.4, 65.4, 49];
  const ch = beat(rate, 120, 24, b => [[0, hat(rate, b + 3), 0.6], ...(b % 4 === 1 ? [[0, kick(rate), 1], [0, bass(notes[((b - 1) / 4) % 4]), 1]] : [])]);
  const t = tempo(analyse(rate, ch).s);
  assert.equal(t.barBeats, 4);
  assert.ok(Math.abs(t.downbeats[0] - 0.5) < 0.015, `downbeat ${t.downbeats[0]}`);
  for (const d of t.downbeats) assert.ok(Math.abs(((d - 0.5) / 2) % 1) < 0.01 || Math.abs(((d - 0.5) / 2) % 1) > 0.99, `downbeat ${d}`);
  assert.ok(t.downbeatConfidence > 0.5 && t.barConfidence > 0.5, `${t.downbeatConfidence} ${t.barConfidence}`);
});

test("audio onsets: music gets its beat grid in milliseconds; a steady hum is loop-like", async () => {
  const rate = 22050;
  const dir = tmp();
  write(dir, "groove.wav", rate, beat(rate, 120, 12, b => [[0, b % 2 ? snare(rate) : kick(rate), 1], [0.5, hat(rate), 0.5]]));
  const music = await run(["toolbox", "audio", "onsets", "groove.wav"], { cwd: dir });
  assert.equal(music.code, EXIT.OK, music.stderr);
  const m = music.json();
  assert.equal(m.kind, "music");
  assert.match(m.kind_reasons[0], /^a steady beat \(120 BPM/);
  assert.ok(Math.abs(m.tempo.beat_ms - 500) <= 2, `${m.tempo.beat_ms}`);
  assert.equal(m.tempo.bar_beats, 4);
  assert.ok(Math.abs(m.tempo.bar_ms - 2000) <= 8, `${m.tempo.bar_ms}`);
  assert.ok(Math.abs(m.tempo.bpm - 120) < 1);
  assert.ok(m.tempo.beats_ms.every(b => Number.isInteger(b) && (b % 500 < 15 || b % 500 > 485)), m.tempo.beats_ms.join(" "));
  assert.ok(Math.abs(m.onsets[2].ms - 500) <= 2, JSON.stringify(m.onsets.slice(0, 4)));
  // A hum with a slow wobble: no clear start or end, and no beat.
  const hum = Float32Array.from({ length: rate * 10 }, (_, i) => 0.3 * (1 + 0.2 * Math.sin((2 * Math.PI * 0.3 * i) / rate)) * Math.sin((2 * Math.PI * 110 * i) / rate));
  write(dir, "hum.wav", rate, hum);
  const loop = (await run(["toolbox", "audio", "onsets", "hum.wav", "--quiet"], { cwd: dir })).json();
  assert.equal(loop.kind, "loop-like");
  assert.match(loop.kind_reasons[0], /^no clear start or end/);
  assert.equal(loop.tempo, undefined);
  assert.equal(loop.hint, undefined);
  // --beats tracks one anyway.
  const forced = (await run(["toolbox", "audio", "onsets", "hum.wav", "--beats"], { cwd: dir })).json();
  assert.equal(forced.kind, "loop-like");
  // Silence and a missing sound are refused.
  write(dir, "hush.wav", rate, new Float32Array(rate));
  const hush = await run(["toolbox", "audio", "onsets", "hush.wav"], { cwd: dir });
  assert.equal(hush.code, EXIT.BAD_INPUT);
  assert.match(hush.stderr, /is silent/);
  assert.equal((await run(["toolbox", "audio", "onsets"], { cwd: dir })).code, EXIT.USAGE);
  assert.equal((await run(["toolbox", "audio", "onsets", "nope.wav"], { cwd: dir })).code, EXIT.USAGE);
});

// ---- The randomizer ----

test("setName: what a set of takes is called", () => {
  assert.equal(setName(["sfx/hit_a.wav", "sfx/hit_b.wav"]), "hit");
  assert.equal(setName(["step_1_0.mp3", "step_2_0.mp3", "step_3_0.mp3"]), "step");
  assert.equal(setName(["sword-01.ogg", "sword-02.ogg"]), "sword");
  assert.equal(setName(["createSoundEffect-bb20f493.mp3", "createSoundEffect-438db768.mp3"]), "createSoundEffect");
  assert.equal(setName(["boom.wav", "zap.wav"]), "takes");
});

test("godotRandomizer: the resource text, with defaults left out as Godot leaves them", () => {
  assert.equal(
    godotRandomizer(["hit_a.wav", "res://sfx/hit \"b\".ogg"], "shuffle"),
    [
      `[gd_resource type="AudioStreamRandomizer" format=3]`,
      ``,
      `[ext_resource type="AudioStream" path="hit_a.wav" id="1_take"]`,
      `[ext_resource type="AudioStream" path="res://sfx/hit \\"b\\".ogg" id="2_take"]`,
      ``,
      `[resource]`,
      `streams_count = 2`,
      `stream_0/stream = ExtResource("1_take")`,
      `stream_0/weight = 1.0`,
      `stream_1/stream = ExtResource("2_take")`,
      `stream_1/weight = 1.0`,
      ``
    ].join("\n")
  );
  assert.match(godotRandomizer(["a.wav", "b.wav"], "sequence"), /\[resource\]\nplayback_mode = 2\nstreams_count = 2\n/);
  assert.match(godotRandomizer(["a.wav", "b.wav"], "random"), /playback_mode = 1\n/);
  assert.doesNotMatch(godotRandomizer(["a.wav", "b.wav"], "random"), /volume|pitch/);
});

const md5 = f => crypto.createHash("md5").update(fs.readFileSync(f)).digest("hex");

test("audio randomizer: measures the takes, writes the three engine files beside them, and leaves the audio alone", async () => {
  const rate = 44100;
  const dir = tmp();
  const sfx = path.join(dir, "sfx");
  fs.mkdirSync(sfx);
  // Three hits: the second 8 dB quieter, the third starting 40 ms late.
  const hit = (gain, delay) => {
    const ch = new Float32Array(rate * 0.6);
    place(ch, rate, delay, snare(rate, 4), gain);
    return ch;
  };
  const files = [write(sfx, "hit_1.wav", rate, hit(0.8, 0)), write(sfx, "hit_2.wav", rate, hit(0.8 * fromDb(-8), 0)), write(sfx, "hit_3.wav", rate, hit(0.8, 0.04))];
  const before = files.map(md5);
  const { code, stderr, json } = await run(["toolbox", "audio", "randomizer", "sfx/hit_1.wav", "sfx/hit_2.wav", "sfx/hit_3.wav"], { cwd: dir });
  assert.equal(code, EXIT.OK, stderr);
  const out = json();
  assert.deepEqual(files.map(md5), before);
  assert.deepEqual(out.takes.map(t => t.audio), ["sfx/hit_1.wav", "sfx/hit_2.wav", "sfx/hit_3.wav"]);
  assert.ok(Math.abs(out.spread.loudness_lu - 8) < 0.2, `${out.spread.loudness_lu}`);
  assert.ok(Math.abs(out.takes[2].hit_ms - 40) <= 2 && out.takes[0].hit_ms === 0);
  assert.ok(Math.abs(out.spread.hit_ms - 40) <= 2);
  assert.ok(out.spread.centroid_octaves < 0.1);
  assert.match(out.notes[0], /loudness differs by 8\.0 LU .* These files set no volume/);
  assert.match(out.notes[1], /hit at different times/);
  assert.deepEqual(out.files, { godot: "sfx/hit.tres", unity: "sfx/hit.unity.json", web: "sfx/hit.sounds.json" });
  assert.match(out.hint.command, /^ludo toolbox audio onsets sfx\/hit_1\.wav$/);
  const tres = fs.readFileSync(path.join(sfx, "hit.tres"), "utf8");
  assert.equal(tres, godotRandomizer(["hit_1.wav", "hit_2.wav", "hit_3.wav"], "shuffle"));
  const unity = JSON.parse(fs.readFileSync(path.join(sfx, "hit.unity.json"), "utf8"));
  assert.equal(unity.order, "shuffle");
  assert.deepEqual(unity.clips.map(c => [c.name, c.path]), [["hit_1", "hit_1.wav"], ["hit_2", "hit_2.wav"], ["hit_3", "hit_3.wav"]]);
  assert.ok(unity.clips.every(c => !("volume" in c)));
  const web = JSON.parse(fs.readFileSync(path.join(sfx, "hit.sounds.json"), "utf8"));
  assert.deepEqual(web.sounds.map(s => [s.key, s.src]), [["hit_1", ["hit_1.wav"]], ["hit_2", ["hit_2.wav"]], ["hit_3", ["hit_3.wav"]]]);
  assert.ok(web.sounds.every(s => !("volume" in s)));
  // Again: a new set beside the first, never over it.
  const rel = files.map(f => path.relative(dir, f));
  const again = (await run(["toolbox", "audio", "randomizer", ...rel, "--order", "sequence"], { cwd: dir })).json();
  assert.equal(again.files.godot, "sfx/hit-2.tres");
  assert.match(fs.readFileSync(path.join(sfx, "hit-2.tres"), "utf8"), /playback_mode = 2/);
  // Bad calls.
  assert.equal((await run(["toolbox", "audio", "randomizer", files[0]], { cwd: dir })).code, EXIT.USAGE);
  assert.equal((await run(["toolbox", "audio", "randomizer", files[0], files[0]], { cwd: dir })).code, EXIT.USAGE);
  assert.equal((await run(["toolbox", "audio", "randomizer", ...files, "--order", "loud"], { cwd: dir })).code, EXIT.USAGE);
});

test("audio randomizer: res:// paths in a Godot project, Assets/ paths and GUIDs in a Unity one, --engine for one file", async () => {
  const rate = 22050;
  const dir = tmp();
  const take = () => {
    const ch = new Float32Array(rate / 2);
    place(ch, rate, 0, snare(rate), 0.7);
    return ch;
  };
  fs.writeFileSync(path.join(dir, "project.godot"), "config_version=5\n");
  fs.mkdirSync(path.join(dir, "audio", "steps"), { recursive: true });
  const a = write(path.join(dir, "audio", "steps"), "step 1.wav", rate, take());
  const b = write(path.join(dir, "audio", "steps"), "step 2.wav", rate, take());
  const godot = await run(["toolbox", "audio", "randomizer", a, b, "--engine", "godot", "--out", "res"], { cwd: dir });
  assert.equal(godot.code, EXIT.OK, godot.stderr);
  assert.deepEqual(godot.json().files, { godot: "res/step.tres" });
  assert.match(fs.readFileSync(path.join(dir, "res", "step.tres"), "utf8"), /path="res:\/\/audio\/steps\/step 1\.wav"/);
  assert.equal(godot.json().notes, undefined);

  const unityDir = tmp();
  fs.mkdirSync(path.join(unityDir, "ProjectSettings"));
  fs.mkdirSync(path.join(unityDir, "Assets", "Audio"), { recursive: true });
  const u1 = write(path.join(unityDir, "Assets", "Audio"), "coin_a.wav", rate, take());
  const u2 = write(path.join(unityDir, "Assets", "Audio"), "coin_b.wav", rate, take());
  fs.writeFileSync(`${u1}.meta`, "fileFormatVersion: 2\nguid: 0123456789abcdef0123456789abcdef\nAudioImporter:\n");
  const unity = await run(["toolbox", "audio", "randomizer", u1, u2, "--engine", "unity"], { cwd: unityDir });
  assert.equal(unity.code, EXIT.OK, unity.stderr);
  const clips = JSON.parse(fs.readFileSync(path.join(unityDir, "Assets", "Audio", "coin.unity.json"), "utf8")).clips;
  assert.deepEqual(clips.map(c => [c.path, c.guid]), [["Assets/Audio/coin_a.wav", "0123456789abcdef0123456789abcdef"], ["Assets/Audio/coin_b.wav", undefined]]);
  const web = await run(["toolbox", "audio", "randomizer", "Assets/Audio/coin_a.wav", "Assets/Audio/coin_b.wav", "--engine", "texturepacker", "--name", "coins"], { cwd: unityDir });
  assert.deepEqual(web.json().files, { web: "Assets/Audio/coins.sounds.json" });
});
