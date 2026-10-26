import { CliError, EXIT } from "../errors.js";
import { printJson, type Ctx } from "../generate.js";
import { baseOf, freeName, shown } from "./io.js";
import { textFlag } from "./flags.js";
import { fft, nextPow2 } from "./fft.js";
import { loadAudioFile, outputBits, outputFormat, writeAudio, type LoadedAudio } from "./audio-io.js";
import { audibleRange, clippedSamples, fade, frames, fromDb, loopClicks, loudness, repeats, samplePeak, seconds, slice, toDb, toMono, truePeak } from "./sound.js";
import type { Audio } from "./wav.js";
import { hint, TOOLS, type Hint, type ToolCall, type ToolFlag } from "./registry.js";

// `ludo toolbox audio`: sound effects, music and voices. The sound work is
// in sound.ts, the files in audio-io.ts; music's tempo is found here.

const usage = (message: string) => new CliError(message, EXIT.USAGE);

// A number flag in its own unit, with bounds; undefined when not given.
function numberFlag(call: ToolCall, flag: string, unit: string, min: number, max: number): number | undefined {
  const raw = textFlag(call, flag);
  if (raw === undefined) {
    if (call.flags.has(flag)) throw usage(`${flag} takes a number of ${unit}`);
    return undefined;
  }
  const v = Number(raw.trim().replace(/(ms|s|dbfs|dbtp|db|lufs)$/i, ""));
  if (!Number.isFinite(v) || v < min || v > max) throw usage(`${flag} takes ${unit} from ${min} to ${max} (got "${raw}")`);
  return v;
}

const round = (v: number, places = 2) => (Number.isFinite(v) ? Math.round(v * 10 ** places) / 10 ** places : null);
const secs = (n: number, rate: number) => round(n / rate, 3);
const dbText = (v: number, unit: string) => (Number.isFinite(v) ? `${v.toFixed(1)} ${unit}` : `silent`);
const describe = (a: Audio) => `${round(a.rate / 1000, 3)} kHz ${a.channels.length === 1 ? "mono" : a.channels.length === 2 ? "stereo" : `${a.channels.length} channels`}, ${seconds(a).toFixed(2)} s`;

const OUTPUT: ToolFlag[] = [
  { flag: "--to", value: "format", description: "wav, ogg, mp3 or flac (default: the input's; WAV is written in-process, the rest through ffmpeg)" },
  { flag: "--in-place", description: "Replace the input instead of saving a new file" }
];

interface Result {
  audio: Audio;
  facts: Record<string, unknown>;
  says: string;
  next: (file: string) => Hint; // the "Next:" line, for the file written
}

// The output side every editing tool shares: --to, --in-place, the file, and
// what is printed.
function save(ctx: Ctx, call: ToolCall, src: LoadedAudio, done: Result): number {
  const format = outputFormat(src, textFlag(call, "--to"));
  const inPlace = call.flags.has("--in-place");
  if (inPlace && format !== src.format) throw usage(`--in-place keeps the format: ${shown(src.file)} is ${src.format}, not ${format}`);
  const file = inPlace ? src.file : freeName(ctx.outDir, ctx.globals.name || baseOf(src.file), `.${format}`);
  const { channels, notes } = writeAudio(file, done.audio, format, { bits: outputBits(src) });
  const a = done.audio;
  const next = done.next(shown(file));
  if (ctx.jsonOut) {
    printJson(
      {
        audio: shown(file),
        format,
        rate: a.rate,
        channels,
        duration: secs(frames(a), a.rate),
        ...done.facts,
        ...(notes.length ? { notes } : {}),
        ...(ctx.globals.quiet ? {} : { hint: next })
      },
      false
    );
  } else {
    process.stdout.write(`${done.says}\n`);
    process.stdout.write(`${inPlace ? "Replaced" : "Saved"} ${shown(file)} (${describe(a)})\n`);
    for (const n of notes) process.stderr.write(`Note: ${n}\n`);
    if (!ctx.globals.quiet) process.stderr.write(`Next: ${next.text}: ${next.command}\n`);
  }
  return EXIT.OK;
}

function one(call: ToolCall, usageLine: string): LoadedAudio {
  if (call.args.length !== 1) throw usage(`Usage: ${usageLine}`);
  return loadAudioFile(call.args[0]);
}

// ---- Tempo, for music

// 23 ms frames (1024 samples at 44.1 and 48 kHz) a quarter frame apart:
// 172 frames a second, which the tempo search needs no finer.
const FRAME_SECONDS = 0.023;
// Magnitudes are compressed as log(1 + GAMMA m), m normalised so a
// full-scale sine reads 0.5: near-logarithmic down to about -40 dBFS, so a
// quiet beat rises as far as a loud one, while an MP3's noise floor (-90
// dBFS and below) adds next to nothing.
const GAMMA = 100;
// Log-spaced bands from 40 Hz to 12 kHz (or near the Nyquist frequency): in
// their flux an octave of bass counts as much as an octave of treble (summed
// over linear bins, a hi-hat's flux dwarfs a kick's).
const BANDS = 24;

export interface Flux {
  rate: number;
  hop: number; // samples from one frame to the next; frame k is centred on sample k * hop
  flux: Float64Array; // per frame: how far the log spectrum rose since the frame before
  pulse: Float64Array; // the rise of the band levels, summed over the bands
}

/**
 * Spectral flux (Masri 1996; the half-wave rectified, log-compressed form
 * of Dixon 2006 "Onset Detection Revisited"), with the previous frame
 * max-filtered across 3 bins, as Böck & Widmer's SuperFlux (DAFx 2013) does
 * to keep vibrato from reading as a string of onsets.
 */
export function spectralFlux(a: Audio): Flux {
  const x = toMono(a).channels[0];
  const rate = a.rate;
  const size = Math.max(64, nextPow2(rate * FRAME_SECONDS));
  const hop = size / 4;
  const half = size / 2;
  const bins = half + 1;
  const count = Math.ceil(x.length / hop) + 1;
  const win = Float64Array.from({ length: size }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size));
  // A Hann window's gain is half its length; m = |X| / (size / 4) reads 0.5 for a full-scale sine.
  const norm = 4 / size;
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  let prev = new Float64Array(bins);
  let cur = new Float64Array(bins);
  const flux = new Float64Array(count);
  const pulse = new Float64Array(count);
  const top = Math.min(12000, 0.45 * rate);
  const edges = Array.from({ length: BANDS + 1 }, (_, i) => Math.min(half, Math.max(1, Math.round((40 * (top / 40) ** (i / BANDS) * size) / rate))));
  let bandsBefore = new Float64Array(BANDS);
  let bands = new Float64Array(BANDS);
  for (let k = 0; k < count; k++) {
    const start = k * hop - half;
    for (let i = 0; i < size; i++) {
      const at = start + i;
      re[i] = at >= 0 && at < x.length ? x[at] * win[i] : 0;
      im[i] = 0;
    }
    fft(re, im);
    for (let b = 0; b < bins; b++) cur[b] = Math.log1p(GAMMA * Math.hypot(re[b], im[b]) * norm);
    let f = 0;
    for (let b = 1; b < bins; b++) {
      const d = cur[b] - Math.max(prev[b - 1], prev[b], b + 1 < bins ? prev[b + 1] : 0);
      if (d > 0) f += d;
    }
    flux[k] = f;
    for (let i = 0; i < BANDS; i++) {
      let s = 0;
      for (let b = edges[i]; b < Math.max(edges[i] + 1, edges[i + 1]); b++) s += cur[b];
      bands[i] = s / Math.max(1, edges[i + 1] - edges[i]);
      if (bands[i] > bandsBefore[i]) pulse[k] += bands[i] - bandsBefore[i];
    }
    [prev, cur] = [cur, prev];
    [bandsBefore, bands] = [bands, bandsBefore];
  }
  return { rate, hop, flux, pulse };
}

const percentile = (v: ArrayLike<number>, q: number) => {
  const s = Float64Array.from(v).sort();
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0;
};

export interface Tempo {
  bpm: number;
  confidence: number; // the onsets' autocorrelation at one beat, 0-1
  steady: number; // 0-1: the share of beat-to-beat gaps within 4% of the median gap
  alternatives: { bpm: number; score: number }[]; // half, two thirds, three halves and double: each one's support against the pick's
}

// The tempo prior: log-normal around 120 BPM, one octave wide (Ellis 2007;
// librosa's default). It only settles octaves the onsets cannot: a clear
// 140 BPM pulse is not moved toward 120.
const prior = (bpm: number) => Math.exp(-0.5 * Math.log2(bpm / 120) ** 2);

/**
 * The tempo from the autocorrelation of the onset strength (less its 0.5 s
 * running mean, half-wave rectified), weighted by the prior; the beats by
 * Ellis's dynamic programme ("Beat Tracking by Dynamic Programming", JNMR
 * 2007, as librosa implements it), which settle the octave the prior cannot
 * and give the BPM to a fraction of a percent (a line through beat time
 * against beat number), where one autocorrelation lag is over 1%. Undefined
 * under 4 s, or when no beat is found.
 */
export function tempo(s: Flux, from = 0, to = Infinity): Tempo | undefined {
  const fps = s.rate / s.hop;
  const k0 = Math.max(0, Math.floor(from * fps));
  const k1 = Math.min(s.pulse.length, Math.ceil(to * fps) + 1);
  const n = k1 - k0;
  if (n < 4 * fps) return undefined;
  // The onset strength: the flux over its mean plus the band flux over its
  // mean. Either alone falls for a trap the other does not: the flux follows
  // the hats and snares (a kick and snare bar reads as half its tempo), the
  // band flux the bass (a busy ambience reads as a beat).
  const raw = new Float64Array(n);
  {
    let [mf, mp] = [0, 0];
    for (let k = k0; k < k1; k++) [mf, mp] = [mf + s.flux[k], mp + s.pulse[k]];
    [mf, mp] = [mf / n || 1, mp / n || 1];
    for (let k = k0; k < k1; k++) raw[k - k0] = s.flux[k] / mf + s.pulse[k] / mp;
  }
  const half = Math.round(0.25 * fps);
  const o = new Float64Array(n);
  {
    let sum = 0;
    for (let i = 0; i < Math.min(n, half); i++) sum += raw[i];
    for (let i = 0; i < n; i++) {
      if (i + half < n) sum += raw[i + half];
      if (i - half - 1 >= 0) sum -= raw[i - half - 1];
      const len = Math.min(n - 1, i + half) - Math.max(0, i - half) + 1;
      o[i] = Math.max(0, raw[i] - sum / len);
    }
  }
  let mean = 0;
  for (let i = 0; i < n; i++) mean += o[i];
  mean /= n;
  const xc = Float64Array.from(o, v => v - mean);
  let energy = 0;
  for (let i = 0; i < n; i++) energy += xc[i] * xc[i];
  if (energy <= 0) return undefined;
  const maxLag = Math.min(n - 1, Math.ceil((60 / 30) * fps));
  const r = new Float64Array(maxLag + 2);
  for (let l = 0; l <= maxLag + 1 && l < n; l++) {
    let acc = 0;
    for (let i = 0; i + l < n; i++) acc += xc[i] * xc[i + l];
    // Unbiased: a lag is not marked down for overlapping less of the sound.
    r[l] = acc / (n - l) / (energy / n);
  }
  const bpmOf = (lag: number) => (60 * fps) / lag;
  const lagOf = (bpm: number) => (60 * fps) / bpm;
  // The best local maximum near a lag (within 4%), refined between lags by a parabola.
  const peakNear = (lag: number) => {
    let best = -1;
    for (let l = Math.max(2, Math.floor(lag * 0.96)); l <= Math.min(maxLag, Math.ceil(lag * 1.04)); l++) {
      if (r[l] >= r[l - 1] && r[l] >= r[l + 1] && (best < 0 || r[l] > r[best])) best = l;
    }
    if (best < 0) return undefined;
    const [a, b, c] = [r[best - 1], r[best], r[best + 1]];
    const d = a - 2 * b + c;
    const shift = d < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / d)) : 0;
    return { lag: best + shift, r: b - 0.25 * (a - c) * shift };
  };
  // A reading's support: its autocorrelation peak, weighted by the prior.
  const support = (lag: number) => {
    const p = peakNear(lag);
    return p && p.r > 0 ? p.r * prior(bpmOf(p.lag)) : 0;
  };
  let choice: { lag: number; r: number } | undefined;
  let score = 0;
  for (let l = Math.max(2, Math.floor(lagOf(300))); l <= Math.min(maxLag, Math.ceil(lagOf(30))); l++) {
    if (!(r[l] > 0 && r[l] >= r[l - 1] && r[l] >= r[l + 1])) continue;
    const sc = r[l] * prior(bpmOf(l));
    if (sc > score) {
      score = sc;
      choice = peakNear(l);
    }
  }
  if (!choice) return undefined;

  // Beats: Ellis's dynamic programme over the onset strength in units of
  // its standard deviation, smoothed over a 32nd of a beat. Each frame's
  // score is its onset strength plus the best earlier beat's score, less
  // tightness x log(gap / period)^2: beats keep to the period, but follow
  // the music where it pushes or drags.
  let sd = 0;
  for (let i = 0; i < n; i++) sd += xc[i] * xc[i];
  sd = Math.sqrt(sd / Math.max(1, n - 1)) || 1;
  const track = (period: number): number[] => {
    const sigma = period / 32;
    const width = Math.ceil(3 * sigma);
    const local = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let acc = 0;
      for (let j = -width; j <= width; j++) if (i + j >= 0 && i + j < n) acc += (o[i + j] / sd) * Math.exp(-0.5 * (j / sigma) ** 2);
      local[i] = acc;
    }
    const TIGHTNESS = 100;
    const cum = new Float64Array(n);
    const back = new Int32Array(n).fill(-1);
    const [near, far] = [Math.max(1, Math.round(period / 2)), Math.round(2 * period)];
    for (let i = 0; i < n; i++) {
      let best = -Infinity;
      for (let j = Math.max(0, i - far); j <= i - near; j++) {
        const v = cum[j] - TIGHTNESS * Math.log((i - j) / period) ** 2;
        if (v > best) {
          best = v;
          back[i] = j;
        }
      }
      cum[i] = local[i] + (best > -Infinity ? best : 0);
    }
    // The last beat: the last local maximum of the score that is at least
    // half the median local maximum (librosa's rule), then back to the first.
    const maxima: number[] = [];
    for (let i = 1; i < n - 1; i++) if (cum[i] > cum[i - 1] && cum[i] >= cum[i + 1]) maxima.push(i);
    if (!maxima.length) return [];
    const med = percentile(maxima.map(i => cum[i]), 0.5);
    let end = maxima[maxima.length - 1];
    for (let m = maxima.length - 1; m >= 0; m--) {
      if (cum[maxima[m]] >= 0.5 * med) {
        end = maxima[m];
        break;
      }
    }
    const beats: number[] = [];
    for (let i = end; i >= 0; i = back[i]) beats.unshift(i);
    // Beats at either end where nothing is playing are the programme's
    // padding, not the music's: under half the RMS of the smoothed strength.
    let ms = 0;
    for (let i = 0; i < n; i++) ms += local[i] * local[i];
    const weak = 0.5 * Math.sqrt(ms / n);
    while (beats.length && local[beats[0]] < weak) beats.shift();
    while (beats.length && local[beats[beats.length - 1]] < weak) beats.pop();
    // And beats off the period at either end: with nothing after it to
    // keep it in step, the last beat can land on an offbeat hat.
    const off = (a: number, b: number) => Math.abs((b - a) / period - 1) > 0.08;
    while (beats.length > 4 && off(beats[beats.length - 2], beats[beats.length - 1])) beats.pop();
    while (beats.length > 4 && off(beats[0], beats[1])) beats.shift();
    return beats;
  };
  // The onset strength a share `at` of the way from each beat to the next
  // (within a frame), averaged over the beats; `every` 2 takes every other.
  const strengthAt = (beats: number[], at: number, every = 1, first = 0) => {
    let sum = 0;
    let count = 0;
    for (let i = first; i + 1 < beats.length; i += every) {
      const c = Math.round(beats[i] + at * (beats[i + 1] - beats[i]));
      sum += Math.max(o[Math.max(0, c - 1)], o[c], o[Math.min(n - 1, c + 1)]);
      count++;
    }
    return count ? sum / count : 0;
  };

  // Octaves. The prior alone halves a beat whose bars alternate a kick
  // and a snare (the kicks line up with kicks a bar apart, so the
  // autocorrelation peaks at twice the period): a tempo under 85 BPM (where
  // the prior prefers its double) is doubled when the points halfway
  // between its beats carry half the onset its beats do, and one over 170 is
  // halved when every other beat carries under half of the rest. The
  // reading passed over keeps its support, less how far the halfway points
  // or the alternate beats went past that half: from all of it at the line
  // to half of it, so the pick always scores highest.
  let period = choice.lag;
  let beats = track(period);
  const bpm0 = bpmOf(period);
  let passedOver: { lag: number; factor: number } | undefined;
  if (beats.length >= 8 && bpm0 < 85) {
    const q = strengthAt(beats, 0.5) / Math.max(1e-12, strengthAt(beats, 0));
    const faster = q >= 0.5 ? track(period / 2) : [];
    if (faster.length >= 8) {
      passedOver = { lag: period, factor: Math.max(0.5, Math.min(1, 1.5 - q)) };
      [period, beats] = [period / 2, faster];
    }
  } else if (beats.length >= 8 && bpm0 > 170) {
    const [even, odd] = [strengthAt(beats, 0, 2, 0), strengthAt(beats, 0, 2, 1)];
    const w = Math.min(even, odd) / Math.max(1e-12, even, odd);
    const slower = w < 0.5 ? track(period * 2) : [];
    if (slower.length >= 4) {
      passedOver = { lag: period, factor: Math.max(0.5, Math.min(1, 0.5 + w)) };
      [period, beats] = [period * 2, slower];
    }
  }
  if (beats.length < 4) return undefined;
  const chosen = peakNear(period) ?? { lag: period, r: choice.r };
  // Half and double, and the 3:2 pair a shuffle or a 6/8 bar leaves open,
  // each scored against the pick's support (or the reading it was picked
  // over, if that had more).
  const top = Math.max(1e-9, chosen.r * prior(bpmOf(chosen.lag)), passedOver ? support(passedOver.lag) : 0);
  const alternatives = [0.5, 2 / 3, 1.5, 2]
    .map(m => ({ m, lag: chosen.lag / m }))
    .filter(a => bpmOf(a.lag) >= 30 && bpmOf(a.lag) <= 300)
    .map(a => {
      const over = passedOver && Math.abs(a.lag / passedOver.lag - 1) < 0.04 ? passedOver.factor : 1;
      return { m: a.m, score: Math.min(0.99, (support(a.lag) / top) * over) };
    });

  // The BPM from a least-squares line through the longest run of beats
  // whose gaps keep within 4% of the median gap: an intro the tracker
  // wanders through before the drums come in does not bend it. Where no
  // run of 8 beats keeps steady, or the line strays over 5% from the
  // autocorrelation's period, that period stands.
  const gaps = beats.slice(1).map((b, i) => b - beats[i]);
  const medianGap = percentile(gaps, 0.5);
  const steady = gaps.map(g => Math.abs(g / medianGap - 1) < 0.04);
  let fitted = period;
  {
    let [best, bestLen] = [0, 0];
    for (let i = 0; i < steady.length; ) {
      if (!steady[i]) {
        i++;
        continue;
      }
      let j = i;
      while (j < steady.length && steady[j]) j++;
      if (j - i > bestLen) [best, bestLen] = [i, j - i];
      i = j;
    }
    const run = beats.slice(best, best + bestLen + 1);
    const m = run.length;
    if (m >= 8) {
      const xm = (m - 1) / 2;
      const ym = run.reduce((x, y) => x + y, 0) / m;
      let [sxy, sxx] = [0, 0];
      run.forEach((b, i) => {
        sxy += (i - xm) * (b - ym);
        sxx += (i - xm) ** 2;
      });
      const slope = sxy / sxx;
      if (Math.abs(slope / period - 1) < 0.05) fitted = slope;
    }
  }
  return {
    bpm: bpmOf(fitted),
    confidence: Math.max(0, Math.min(1, chosen.r)),
    // Near 1 for a beat that keeps time, low where the tracker only found
    // a path through a texture or speech.
    steady: gaps.length ? steady.filter(Boolean).length / gaps.length : 0,
    alternatives: alternatives.map(a => ({ bpm: bpmOf(fitted) * a.m, score: a.score }))
  };
}

// What decides music: 8 s or more (a jingle is a one-shot), and a beat that
// both repeats (autocorrelation 0.2) and keeps time (65% of its gaps within
// 4%). Over Ludo's own sounds, every music track clears both, the weakest
// only just (0.21 and 69%), and no voice, creature or ambience clears both:
// those that repeat do not keep time, and the reverse.
const MUSIC = { seconds: 8, autocorrelation: 0.2, steady: 0.65 };

// The tempo of a sound that is music, over its audible span; undefined for
// anything else.
export function musicTempo(a: Audio, range: { start: number; end: number } | undefined): Tempo | undefined {
  if (!range || (range.end - range.start) / a.rate < MUSIC.seconds) return undefined;
  const t = tempo(spectralFlux(a), range.start / a.rate, range.end / a.rate);
  return t && t.confidence >= MUSIC.autocorrelation && t.steady >= MUSIC.steady ? t : undefined;
}

// A reading scored under 0.05 of the pick has no support worth naming. One
// at 0.8 or more is near enough a tie that the pick could have gone to it:
// over Ludo's music, a chiptune reads 160 on some excerpts and 80 on others,
// and a 128 BPM track scores 85.3 at 0.93.
const SUPPORTED = 0.05;
const NEAR_TIE = 0.8;

// The readings with support worth naming, best first.
export const supported = (t: Tempo) => t.alternatives.filter(x => x.score >= SUPPORTED).sort((p, q) => q.score - p.score);

// The octave a listener could tap instead: half or double, whichever has
// more support, inside 40 to 240 BPM.
export function octaveOf(t: Tempo): { bpm: number; score: number } | undefined {
  const octaves = supported(t).filter(x => (Math.abs(x.bpm / t.bpm - 0.5) < 0.01 || Math.abs(x.bpm / t.bpm - 2) < 0.01) && x.bpm >= 40 && x.bpm <= 240);
  return octaves.sort((p, q) => q.score - p.score || Math.abs(Math.log2(p.bpm / 120)) - Math.abs(Math.log2(q.bpm / 120)))[0];
}

// The readings to name beside the pick: its octave, then any near tie.
export function readingsOf(t: Tempo): { bpm: number; score: number }[] {
  const octave = octaveOf(t);
  return [...(octave ? [octave] : []), ...supported(t).filter(x => x !== octave && x.score >= NEAR_TIE)];
}

const THRESHOLD: ToolFlag = { flag: "--threshold", value: "dB", description: "Quieter than this counts as silence, in dBFS (default -50)" };

TOOLS.push({
  group: "audio",
  name: "info",
  args: "<sound>",
  summary: "How long and how loud a sound is, and whether it loops cleanly",
  details: [
    "Its format, length, peak and true peak (dBTP, between the samples, as a player rebuilds the wave),",
    "loudness (LUFS, ITU-R BS.1770, as streaming services and consoles measure it), silence at either",
    "end, clipped samples, and whether it clicks where it loops. A sound under 0.4 s is measured as one",
    "block of its own length.",
    "Music (8 s or more with a beat that repeats and keeps time) gets its tempo, from the onsets'",
    "autocorrelation and a beat tracker, with the octave a listener could tap instead (half or double)",
    "and any other reading that scores 0.8 of the pick or more, such as one at 3:2. On a near tie like",
    "that, which reading is picked can change with the length of the excerpt. In JSON,",
    "bpm_alternatives scores each other reading with support (0.05 or more) against the pick, under 1.",
    "Reads WAV and MP3 itself; OGG, FLAC and the rest through ffmpeg."
  ],
  flags: [THRESHOLD],
  async run(ctx, call) {
    const src = one(call, "ludo toolbox audio info <sound>");
    const threshold = numberFlag(call, "--threshold", "dB", -120, 0) ?? -50;
    const a = src.audio;
    const n = frames(a);
    const peak = toDb(samplePeak(a));
    const tp = toDb(truePeak(a));
    const loud = loudness(a);
    const range = audibleRange(a, fromDb(threshold));
    const lead = range ? range.start : n;
    const tail = range ? n - range.end : 0;
    const clicks = loopClicks(a);
    const copies = repeats(a);
    const clipped = clippedSamples(a);
    const beat = musicTempo(a, range);
    const others = beat ? readingsOf(beat) : [];
    const bpmText = (v: number) => String(+v.toFixed(1));
    const next =
      !range || lead + tail < a.rate / 50
        ? hint("Save it for the engine", `ludo toolbox audio convert ${shown(src.file)} --to ogg`)
        : hint("Cut the silence off its ends", `ludo toolbox audio trim ${shown(src.file)}`);
    if (ctx.jsonOut) {
      printJson(
        {
          audio: shown(src.file),
          format: src.format,
          codec: src.codec,
          rate: a.rate,
          channels: a.channels.length,
          samples: n,
          duration: secs(n, a.rate),
          peak_db: round(peak),
          true_peak_db: round(tp),
          loudness_lufs: round(loud.lufs),
          ...(loud.short ? { loudness_short: true } : {}),
          silence_start: secs(lead, a.rate),
          silence_end: secs(tail, a.rate),
          silence_threshold_db: threshold,
          clipped_samples: clipped,
          loop_clicks: clicks,
          ...(copies > 1 ? { repeats: copies } : {}),
          ...(src.loop ? { wav_loop: { start: secs(src.loop.start, a.rate), end: secs(src.loop.end, a.rate) } } : {}),
          ...(beat
            ? {
                bpm: round(beat.bpm, 1),
                bpm_alternatives: supported(beat).map(x => ({ bpm: round(x.bpm, 1), score: round(x.score) }))
              }
            : {}),
          ...(ctx.globals.quiet ? {} : { hint: next })
        },
        false
      );
      return EXIT.OK;
    }
    const lines = [
      `${shown(src.file)}: ${src.format.toUpperCase()}, ${src.codec}, ${describe(a)}`,
      `  Loudness   ${dbText(loud.lufs, "LUFS")}${loud.short ? " (under 0.4 s: one block of its own length)" : ""}`,
      `  Peak       ${dbText(peak, "dBFS")}, true peak ${dbText(tp, "dBTP")}${clipped ? `, ${clipped} clipped samples` : ""}`,
      `  Silence    ${range ? `${(lead / a.rate).toFixed(2)} s at the start, ${(tail / a.rate).toFixed(2)} s at the end` : "all of it"} (under ${threshold} dBFS)`,
      ...(beat ? [`  Tempo      ${bpmText(beat.bpm)} BPM${others.length ? ` (or ${others.map(x => bpmText(x.bpm)).join(", ")})` : ""}`] : []),
      `  Looping    ${copies > 1 ? `it is ${copies} copies of one ${(n / copies / a.rate).toFixed(2)} s stretch; ` : ""}${clicks ? "clicks where it wraps around" : "no click where it wraps around"}${src.loop ? `; its WAV loop runs ${(src.loop.start / a.rate).toFixed(2)}-${(src.loop.end / a.rate).toFixed(2)} s` : ""}`
    ];
    process.stdout.write(lines.join("\n") + "\n");
    if (!ctx.globals.quiet) process.stderr.write(`Next: ${next.text}: ${next.command}\n`);
    return EXIT.OK;
  }
});

TOOLS.push({
  group: "audio",
  name: "trim",
  args: "<sound>",
  summary: "Cut the silence off a sound's start and end",
  details: [
    "Silence is everything quieter than --threshold before the first louder sample and after the last.",
    "--pad keeps a little of it, and --fade eases the cut edges so they do not click. --start and --end",
    "cut at given times instead of where the silence ends, and --only keeps one end as it is.",
    "Ludo's sound effects come trimmed already: this is for sounds from elsewhere."
  ],
  flags: [
    THRESHOLD,
    { flag: "--pad", value: "ms", description: "Silence to keep at each cut end (default 10)" },
    { flag: "--fade", value: "ms", description: "Fade over this much at each cut end (default 5)" },
    { flag: "--start", value: "seconds", description: "Cut here instead of where the sound starts" },
    { flag: "--end", value: "seconds", description: "Cut here instead of where the sound ends" },
    { flag: "--only", value: "start|end", description: "Cut only this end" },
    ...OUTPUT
  ],
  async run(ctx, call) {
    const src = one(call, "ludo toolbox audio trim <sound> [--threshold -50]");
    const threshold = numberFlag(call, "--threshold", "dB", -120, 0) ?? -50;
    const pad = numberFlag(call, "--pad", "milliseconds", 0, 10000) ?? 10;
    const fadeMs = numberFlag(call, "--fade", "milliseconds", 0, 10000) ?? 5;
    const startAt = numberFlag(call, "--start", "seconds", 0, 36000);
    const endAt = numberFlag(call, "--end", "seconds", 0, 36000);
    const only = textFlag(call, "--only");
    if (only !== undefined && only !== "start" && only !== "end") throw usage(`--only takes start or end (got "${only}")`);
    const a = src.audio;
    const n = frames(a);
    const rate = a.rate;
    const range = audibleRange(a, fromDb(threshold));
    const padding = Math.round((pad / 1000) * rate);
    let start = startAt !== undefined ? Math.round(startAt * rate) : range ? Math.max(0, range.start - padding) : 0;
    let end = endAt !== undefined ? Math.round(endAt * rate) : range ? Math.min(n, range.end + padding) : n;
    if (only === "end") start = 0;
    if (only === "start") end = n;
    if (startAt === undefined && endAt === undefined && !range) {
      throw new CliError(`${shown(src.file)} is silent: nothing in it is louder than ${threshold} dBFS`, EXIT.BAD_INPUT, "Lower --threshold, or check it with ludo toolbox audio info.");
    }
    start = Math.min(start, n);
    end = Math.min(end, n);
    if (end <= start) throw usage(`That leaves nothing: it would start at ${(start / rate).toFixed(3)} s and end at ${(end / rate).toFixed(3)} s`);
    const out = slice(a, start, end);
    const fadeLen = Math.round((fadeMs / 1000) * rate);
    if (start > 0) fade(out, 0, fadeLen, "in");
    if (end < n) fade(out, frames(out) - fadeLen, fadeLen, "out");
    const cut = [start ? `${(start / rate).toFixed(2)} s from the start` : "", end < n ? `${((n - end) / rate).toFixed(2)} s from the end` : ""].filter(Boolean);
    return save(ctx, call, src, {
      audio: out,
      facts: { source_duration: secs(n, rate), cut_start: secs(start, rate), cut_end: secs(n - end, rate) },
      says: cut.length ? `Cut ${cut.join(" and ")}: ${(n / rate).toFixed(2)} s to ${((end - start) / rate).toFixed(2)} s` : `Nothing to cut: no silence under ${threshold} dBFS at its ends`,
      next: file => hint("Save it for the engine", `ludo toolbox audio convert ${file} --to ogg`)
    });
  }
});

TOOLS.push({
  group: "audio",
  name: "convert",
  args: "<sound>",
  summary: "Save a sound as WAV, OGG, MP3 or FLAC",
  details: [
    "OGG is Ogg Vorbis, which Godot and Unity import. WAV is written in-process; OGG, MP3 and FLAC",
    "through ffmpeg. --mono mixes the channels into one (3D sound in Unity and Godot is positioned from",
    "mono). A WAV keeps its sample depth unless --bits says otherwise."
  ],
  flags: [
    { flag: "--to", value: "format", description: "wav, ogg, mp3 or flac (default wav)" },
    { flag: "--mono", description: "Mix the channels into one" },
    { flag: "--bits", value: "16|24|32", description: "WAV and FLAC sample depth; 32 is float, WAV only (default: the input's, else 16)" }
  ],
  async run(ctx, call) {
    const src = one(call, "ludo toolbox audio convert <sound> --to ogg");
    const format = outputFormat({ ...src, format: "wav" }, textFlag(call, "--to"));
    const rawBits = textFlag(call, "--bits");
    if (call.flags.has("--bits") && !["16", "24", "32"].includes(rawBits ?? "")) throw usage(`--bits takes 16, 24 or 32 (got "${rawBits ?? ""}")`);
    const bits = rawBits ? (Number(rawBits) as 16 | 24 | 32) : outputBits(src);
    if (bits === 32 && format === "flac") throw usage("FLAC holds whole numbers up to 24 bits: use --bits 24, or --to wav for 32-bit float");
    const audio = call.flags.has("--mono") ? toMono(src.audio) : src.audio;
    const file = freeName(ctx.outDir, ctx.globals.name || baseOf(src.file), `.${format}`);
    const { channels, notes } = writeAudio(file, audio, format, { bits });
    const depth = format === "wav" || format === "flac" ? `${bits}-bit${bits === 32 ? " float" : ""} ` : "";
    if (ctx.jsonOut) {
      printJson({ audio: shown(src.file), saved: shown(file), format, rate: audio.rate, channels, duration: secs(frames(audio), audio.rate), ...(depth ? { bits } : {}), ...(notes.length ? { notes } : {}) }, false);
    } else {
      process.stdout.write(`Saved ${shown(file)} (${depth}${format.toUpperCase()}, ${describe(audio)})\n`);
      for (const n of notes) process.stderr.write(`Note: ${n}\n`);
    }
    return EXIT.OK;
  }
});
