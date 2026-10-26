import fs from "node:fs";
import path from "node:path";
import { CliError, EXIT } from "../errors.js";
import { printJson, type Ctx } from "../generate.js";
import { findGodotProject } from "../tty/godot.js";
import { fft, nextPow2 } from "./fft.js";
import { baseOf, shown } from "./io.js";
import { textFlag } from "./flags.js";
import { loadAudioFile, type LoadedAudio } from "./audio-io.js";
import { audibleRange, frames, fromDb, loudness, samplePeak, toDb, toMono } from "./sound.js";
import type { Audio } from "./wav.js";
import { hint, TOOLS, type ToolCall } from "./registry.js";

// `ludo toolbox audio onsets|randomizer`: when a sound hits, and sets of
// takes. Both only measure: no tool here levels, trims, cuts or re-pitches a
// sound (Ludo's come loudness-matched and trimmed already), and the
// randomizer's engine files point at the takes as they are.

const usage = (message: string) => new CliError(message, EXIT.USAGE);

// ---- Spectra ----

// 23 ms frames (1024 samples at 44.1 and 48 kHz) a quarter frame apart:
// short enough that two hits 30 ms apart are two peaks, and 172 frames a
// second, which the beat tracker's tempo search needs no finer.
const FRAME_SECONDS = 0.023;
// Magnitudes are compressed as log(1 + GAMMA m), m normalised so a
// full-scale sine reads 0.5: near-logarithmic down to about -40 dBFS, so a
// quiet hit rises as far as a loud one, while an MP3's noise floor (-90
// dBFS and below) adds next to nothing.
const GAMMA = 100;
// Log-spaced bands from 40 Hz to 12 kHz (or near the Nyquist frequency):
// in their flux an octave of bass counts as much as an octave of treble
// (summed over linear bins, a hi-hat's flux dwarfs a kick's), which the beat
// tracker needs, and what changes in them from one beat to the next (a
// chord, a bass note) says where bars start.
const BANDS = 24;

export interface Spectrum {
  rate: number;
  hop: number; // samples from one frame to the next; frame k is centred on sample k * hop
  size: number;
  flux: Float64Array; // per frame: how far the log spectrum rose since the frame before
  low: Float64Array; // the same under 200 Hz (kicks, bass notes)
  pulse: Float64Array; // the rise of the band levels, summed over the bands
  bands: Float32Array; // BANDS log levels per frame
  centroid: number; // Hz: the centre of mass of the magnitude spectrum, over the frames louder than the gate
}

/**
 * Spectral flux (Masri 1996; the half-wave rectified, log-compressed form
 * of Dixon 2006 "Onset Detection Revisited"), with the previous frame
 * max-filtered across 3 bins, as Böck & Widmer's SuperFlux (DAFx 2013) does
 * to keep vibrato from reading as a string of onsets. `gate` is linear: only
 * frames whose RMS reaches it count toward the centroid.
 */
export function spectrum(a: Audio, gate: number): Spectrum {
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
  const low = new Float64Array(count);
  const pulse = new Float64Array(count);
  const bands = new Float32Array(count * BANDS);
  const lowBins = Math.max(2, Math.round((200 * size) / rate));
  const top = Math.min(12000, 0.45 * rate);
  const edge = (i: number) => Math.min(half, Math.max(1, Math.round(((40 * (top / 40) ** (i / BANDS)) * size) / rate)));
  const bandEdges = Array.from({ length: BANDS + 1 }, (_, i) => edge(i));
  const magSum = new Float64Array(bins);
  const gatePower = gate * gate;
  for (let k = 0; k < count; k++) {
    const start = k * hop - half;
    let power = 0;
    for (let i = 0; i < size; i++) {
      const at = start + i;
      const v = at >= 0 && at < x.length ? x[at] * win[i] : 0;
      re[i] = v;
      im[i] = 0;
      power += v * v;
    }
    fft(re, im);
    // The window's mean square is 3/8: the frame's RMS before windowing.
    const loud = power / size / 0.375 >= gatePower;
    for (let b = 0; b < bins; b++) {
      const m = Math.hypot(re[b], im[b]) * norm;
      cur[b] = Math.log1p(GAMMA * m);
      if (loud) magSum[b] += m;
    }
    let f = 0;
    let l = 0;
    for (let b = 1; b < bins; b++) {
      const ref = Math.max(prev[b - 1], prev[b], b + 1 < bins ? prev[b + 1] : 0);
      const d = cur[b] - ref;
      if (d > 0) {
        f += d;
        if (b < lowBins) l += d;
      }
    }
    flux[k] = f;
    low[k] = l;
    for (let i = 0; i < BANDS; i++) {
      let s = 0;
      for (let b = bandEdges[i]; b < Math.max(bandEdges[i] + 1, bandEdges[i + 1]); b++) s += cur[b];
      const v = s / Math.max(1, bandEdges[i + 1] - bandEdges[i]);
      bands[k * BANDS + i] = v;
      if (v > (k ? bands[(k - 1) * BANDS + i] : 0)) pulse[k] += v - (k ? bands[(k - 1) * BANDS + i] : 0);
    }
    [prev, cur] = [cur, prev];
  }
  let num = 0;
  let den = 0;
  for (let b = 1; b < bins; b++) {
    num += magSum[b] * ((b * rate) / size);
    den += magSum[b];
  }
  return { rate, hop, size, flux, low, pulse, bands, centroid: den > 0 ? num / den : NaN };
}

// ---- Envelopes ----

export interface Envelope {
  rate: number;
  step: number; // samples per value: a millisecond, to the nearest sample
  rms: Float64Array; // 10 ms RMS (over every channel's power), one value a millisecond
  fine: Float32Array; // the largest |sample| in each 0.25 ms, for placing an onset to the millisecond
  fineStep: number;
}

export function envelope(a: Audio): Envelope {
  const n = frames(a);
  const step = Math.max(1, Math.round(a.rate / 1000));
  const fineStep = Math.max(1, Math.round(a.rate / 4000));
  const blocks = Math.ceil(n / step);
  const power = new Float64Array(blocks);
  const fine = new Float32Array(Math.ceil(n / fineStep));
  for (const ch of a.channels) {
    for (let i = 0; i < n; i++) {
      const v = ch[i];
      power[(i / step) | 0] += (v * v) / a.channels.length;
      const f = (i / fineStep) | 0;
      if (Math.abs(v) > fine[f]) fine[f] = Math.abs(v);
    }
  }
  // Each value is centred on its millisecond: 5 blocks either side.
  const rms = new Float64Array(blocks);
  for (let j = 0; j < blocks; j++) {
    let s = 0;
    let len = 0;
    for (let b = Math.max(0, j - 5); b < Math.min(blocks, j + 5); b++) {
      s += power[b];
      len += b === blocks - 1 ? n - b * step : step;
    }
    rms[j] = Math.sqrt(s / Math.max(1, len));
  }
  return { rate: a.rate, step, rms, fine, fineStep };
}

// A loop, not Math.max(...v): ten minutes of milliseconds is more
// arguments than a call takes.
const maxOf = (v: ArrayLike<number>) => {
  let m = 0;
  for (let i = 0; i < v.length; i++) if (v[i] > m) m = v[i];
  return m;
};

const percentile = (v: ArrayLike<number>, q: number) => {
  const s = Float64Array.from(v).sort();
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0;
};

// ---- Onsets ----

export interface Onset {
  at: number; // seconds
  strength: number; // its flux peak, against the strongest onset's
}

/**
 * Onsets: peaks of the flux that are the largest within 30 ms either side,
 * stand above the flux's mean over the 100 ms before and 70 ms after by half
 * that mean and by a fixed share of its strong peaks (Dixon 2006's adaptive
 * threshold; the half keeps the churn of a noisy texture, a crackle or a
 * spell's shimmer, from reading as a string of hits), are 30 ms or more
 * after the last one, and get louder, to over `gate` (linear, on the 10 ms
 * RMS), in the 30 ms after them. Each is then placed on the
 * samples: where the signal first passes a tenth of the way from the level
 * before it to the peak after it, which is where the hit starts to the
 * millisecond, not to the 23 ms frame.
 */
export function onsets(s: Spectrum, env: Envelope, gate: number): Onset[] {
  const f = s.flux;
  const fps = s.rate / s.hop;
  const near = Math.max(1, Math.round(0.03 * fps));
  const [pre, post] = [Math.round(0.1 * fps), Math.round(0.07 * fps)];
  // The frames that hang over the file's start see silence before it, so
  // a sound that starts at full level has its largest flux there: the scale
  // comes from the rest, and that onset's strength is capped at 1.
  const edge = Math.ceil(s.size / 2 / s.hop);
  const scale = percentile(f.length > 4 * edge ? f.subarray(edge) : f, 0.99) || 1;
  const delta = 0.06 * scale;
  // And a floor at a share of the largest flux, the start's included: a
  // coin's ding fades through flux a hundredth of its hit's, whose ripples
  // are not hits.
  const floor = 0.03 * maxOf(f);
  // A hit gets louder: the 10 ms RMS somewhere in the 30 ms after it is
  // 1.5 dB over the 10 ms before it, and over the gate. The corner where a
  // swell turns to its decay has flux (its spectrum smears), but no rise.
  const rises = (t: number) => {
    const j0 = Math.max(0, Math.floor((t * env.rate) / env.step));
    const before = j0 >= 6 ? env.rms[j0 - 6] : 0;
    let after = 0;
    for (let j = j0 + 2; j < Math.min(env.rms.length, j0 + 30); j++) after = Math.max(after, env.rms[j]);
    return after >= gate && after >= before * fromDb(1.5);
  };
  const found: { frame: number; at: number; flux: number }[] = [];
  let last = -Infinity;
  for (let k = 0; k < f.length; k++) {
    if (f[k] <= 0) continue;
    let isMax = true;
    for (let j = Math.max(0, k - near); j <= Math.min(f.length - 1, k + near) && isMax; j++) {
      if (j < k ? f[j] >= f[k] : j > k && f[j] > f[k]) isMax = false;
    }
    if (!isMax) continue;
    let mean = 0;
    const [lo, hi] = [Math.max(0, k - pre), Math.min(f.length - 1, k + post)];
    for (let j = lo; j <= hi; j++) mean += f[j];
    mean /= hi - lo + 1;
    if (f[k] < mean + Math.max(delta, 0.5 * mean) || f[k] < floor || k - last < near) continue;
    const at = place(s, env, k, found.length ? found[found.length - 1].at : 0);
    if (!rises(at)) continue;
    found.push({ frame: k, at, flux: f[k] });
    last = k;
  }
  const strongest = maxOf(found.filter(o => o.frame >= edge).map(o => o.flux)) || maxOf(found.map(o => o.flux));
  return found.map(o => ({ at: o.at, strength: strongest ? Math.min(1, o.flux / strongest) : 0 }));
}

// Where in frame k (centred on k * hop, `size` long) the hit starts.
function place(s: Spectrum, env: Envelope, k: number, after: number): number {
  const { fine, fineStep } = env;
  const toBlock = (sample: number) => Math.max(0, Math.min(fine.length - 1, Math.floor(sample / fineStep)));
  const centre = k * s.hop;
  // The flux rises as soon as the new sound enters the window, so it starts
  // within the frame, never after its centre by more than a hop.
  const from = Math.max(toBlock(centre - s.size / 2), toBlock(after * s.rate) + 1);
  const to = toBlock(centre + s.hop);
  if (from > to) return centre / s.rate;
  let peak = 0;
  for (let b = from; b <= Math.min(fine.length - 1, toBlock(centre + s.size / 2 + 0.02 * s.rate)); b++) peak = Math.max(peak, fine[b]);
  // The level before: the median of the 10 ms before the search, as a
  // sound still ringing from the last hit has one.
  const before = Array.from(fine.subarray(Math.max(0, from - Math.round(0.01 * s.rate / fineStep)), from)).sort((p, q) => p - q);
  const floor = before.length ? before[before.length >> 1] : 0;
  if (peak <= floor * 1.5) return centre / s.rate;
  const level = floor + 0.1 * (peak - floor);
  for (let b = from; b <= to; b++) if (fine[b] >= level) return (b * fineStep) / s.rate;
  return centre / s.rate;
}

// ---- The envelope's shape ----

export interface Shape {
  peak: number; // seconds: the loudest sample within the loudest 10 ms
  peakDb: number; // that 10 ms's RMS, dBFS
  hit?: number; // seconds: the onset that starts the loudest moment
  attack?: number; // seconds from the hit until it first comes within 6 dB of the peak and turns
  decay20?: number; // seconds after the peak until it is 20 dB down
  decay40?: number;
}

export function shape(env: Envelope, found: Onset[]): Shape {
  const { rms, fine, fineStep, step, rate } = env;
  const time = (j: number) => (j * step) / rate;
  let p = 0;
  for (let j = 1; j < rms.length; j++) if (rms[j] > rms[p]) p = j;
  // Within the loudest 10 ms, its loudest sample: a click's RMS is flat
  // over every window that holds it, the sample is not.
  const perMs = step / fineStep;
  let b = Math.floor(Math.max(0, p - 5) * perMs);
  for (let i = b; i < Math.min(fine.length, Math.ceil((p + 5) * perMs)); i++) if (fine[i] > fine[b]) b = i;
  const peak = (b * fineStep) / rate;
  const fall = (db: number) => {
    const level = rms[p] * fromDb(db);
    for (let j = p + 1; j < rms.length; j++) if (rms[j] < level) return Math.max(0, time(j) - peak);
    return undefined;
  };
  const hits = found.filter(o => o.at <= peak + 0.0005);
  const hit = hits.length ? hits[hits.length - 1].at : found[0]?.at;
  // The attack ends at the first turn of the envelope within 6 dB of the
  // peak: a sword's hit rises in 10 ms and then roughens along for 100 ms,
  // and the loudest of that roughness is not its attack.
  let attack: number | undefined;
  if (hit !== undefined) {
    const near = rms[p] * fromDb(-6);
    let j = Math.max(0, Math.round((hit * rate) / step));
    while (j < p && !(rms[j] >= near && rms[j] >= rms[j + 1])) j++;
    attack = Math.max(0, (j < p ? time(j) : peak) - hit);
  }
  return { peak, peakDb: toDb(rms[p]), hit, attack, decay20: fall(-20), decay40: fall(-40) };
}

// ---- Tempo, beats and bars ----

export interface Tempo {
  bpm: number;
  confidence: number; // the onsets' autocorrelation at one beat, 0-1
  alternatives: { bpm: number; score: number }[]; // half, two thirds, three halves and double, scored against the choice
  period: number; // seconds per beat
  beats: number[]; // seconds
  beatsConfidence: number; // 0-1: the share of beat-to-beat gaps within 4% of the median gap
  barBeats: number;
  barConfidence: number;
  downbeats: number[];
  downbeatConfidence: number;
}

// The tempo prior: log-normal around 120 BPM, one octave wide (Ellis 2007;
// librosa's default). It only settles octaves the onsets cannot: a clear
// 140 BPM pulse is not moved toward 120.
const prior = (bpm: number) => Math.exp(-0.5 * Math.log2(bpm / 120) ** 2);

/**
 * The tempo from the autocorrelation of the onset strength (less its 0.5 s
 * running mean, half-wave rectified), weighted by the prior; the
 * beats by Ellis's dynamic programme ("Beat Tracking by Dynamic
 * Programming", JNMR 2007, as librosa implements it); the BPM then fitted to
 * the beats (a line through beat time against beat number), which is exact
 * to a fraction of a percent where one autocorrelation lag is over 1%.
 * Undefined under 4 s, or when no beat is found.
 */
export function tempo(s: Spectrum, from = 0, to = Infinity): Tempo | undefined {
  const fps = s.rate / s.hop;
  const k0 = Math.max(0, Math.floor(from * fps));
  const k1 = Math.min(s.pulse.length, Math.ceil(to * fps) + 1);
  const n = k1 - k0;
  if (n < 4 * fps) return undefined;
  // The onset strength: the flux over its mean plus the band flux over its
  // mean. Either alone falls for a trap the other does not: the flux follows
  // the hats and snares (a kick and snare bar reads as half its tempo), the
  // band flux the bass (a busy ambience reads as a beat).
  const raw = new Float64Array(k1 - k0);
  {
    let [mf, mp] = [0, 0];
    for (let k = k0; k < k1; k++) [mf, mp] = [mf + s.flux[k], mp + s.pulse[k]];
    [mf, mp] = [mf / raw.length || 1, mp / raw.length || 1];
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
    r[l] = (acc / (n - l)) / (energy / n);
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
  // halved when every other beat carries under half of the rest. Either way
  // both are listed, as a listener can tap either.
  let period = choice.lag;
  let beats = track(period);
  const bpm0 = bpmOf(period);
  if (beats.length >= 8 && bpm0 < 85 && strengthAt(beats, 0.5) >= 0.5 * strengthAt(beats, 0)) {
    const faster = track(period / 2);
    if (faster.length >= 8) [period, beats] = [period / 2, faster];
  } else if (beats.length >= 8 && bpm0 > 170) {
    const [even, odd] = [strengthAt(beats, 0, 2, 0), strengthAt(beats, 0, 2, 1)];
    if (Math.min(even, odd) < 0.5 * Math.max(even, odd)) {
      const slower = track(period * 2);
      if (slower.length >= 4) [period, beats] = [period * 2, slower];
    }
  }
  if (beats.length < 4) return undefined;
  const chosen = peakNear(period) ?? { lag: period, r: choice.r };
  const chosenScore = Math.max(1e-9, chosen.r * prior(bpmOf(chosen.lag)));
  // Half and double, and the 3:2 pair a shuffle or a 6/8 bar leaves open.
  const alternatives = [0.5, 2 / 3, 1.5, 2]
    .map(m => ({ bpm: bpmOf(chosen.lag) * m, at: peakNear(chosen.lag / m) }))
    .filter(a => a.bpm >= 30 && a.bpm <= 300)
    .map(a => ({ bpm: a.bpm, score: a.at && a.at.r > 0 ? (a.at.r * prior(a.bpm)) / chosenScore : 0 }));

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
      let sxy = 0;
      let sxx = 0;
      run.forEach((b, i) => {
        sxy += (i - xm) * (b - ym);
        sxx += (i - xm) ** 2;
      });
      const slope = sxy / sxx;
      if (Math.abs(slope / period - 1) < 0.05) fitted = slope;
    }
  }
  // The share of beat-to-beat gaps within 4% of the median: near 1 for a
  // beat that keeps time, low where the tracker only found a path through
  // a texture or speech.
  const beatsConfidence = gaps.length ? steady.filter(Boolean).length / gaps.length : 0;

  // Bars: each beat's accent is its bass onset plus how much the spectrum
  // changes across it (the mean bands over the beat before against the beat
  // after: chords and bass notes change on the bar more than within it),
  // each in standard units. For 4 and 3 beats a bar, the phase whose beats
  // are most accented is the downbeat; 3 wins only by a clear margin, as
  // game music is mostly in 4.
  const m = beats.length;
  const lowAt = beats.map(b => {
    let v = 0;
    for (let i = Math.max(0, b - 2); i <= Math.min(n - 1, b + 2); i++) v = Math.max(v, s.low[k0 + i]);
    return v;
  });
  const meanBands = (a: number, b: number) => {
    const v = new Float64Array(BANDS);
    for (let i = a; i < b; i++) for (let j = 0; j < BANDS; j++) v[j] += s.bands[(k0 + i) * BANDS + j] / Math.max(1, b - a);
    return v;
  };
  const segs = beats.map((b, i) => meanBands(b, i + 1 < m ? beats[i + 1] : Math.min(n, b + Math.round(period))));
  const change = beats.map((_, i) => (i ? Math.sqrt(segs[i].reduce((acc, v, j) => acc + (v - segs[i - 1][j]) ** 2, 0)) : 0));
  const z = (v: number[]) => {
    const mu = v.reduce((x, y) => x + y, 0) / v.length;
    const sdv = Math.sqrt(v.reduce((x, y) => x + (y - mu) ** 2, 0) / v.length) || 1;
    return v.map(x => (x - mu) / sdv);
  };
  const [zl, zc] = [z(lowAt), z(change.slice(1))];
  const accent = lowAt.map((_, i) => zl[i] + (i ? zc[i - 1] : 0));
  const meter = (beatsPerBar: number) => {
    const means = Array.from({ length: beatsPerBar }, (_, p) => {
      // Not the first beat: it has no beat before it to change from.
      const at = accent.filter((_, i) => i && i % beatsPerBar === p);
      return at.length ? at.reduce((x, y) => x + y, 0) / at.length : -Infinity;
    });
    const order = [...means.keys()].sort((p, q) => means[q] - means[p]);
    const rest = means.filter((_, p) => p !== order[0]);
    const all = means.reduce((x, y) => x + y, 0) / beatsPerBar;
    return {
      beatsPerBar,
      phase: order[0],
      contrast: means[order[0]] - rest.reduce((x, y) => x + y, 0) / rest.length,
      // How far the strongest beat of the bar stands above the runner-up,
      // against how far it stands above the bar's mean.
      sure: means[order[0]] - all > 0 ? Math.max(0, Math.min(1, (means[order[0]] - means[order[1]]) / (means[order[0]] - all))) : 0
    };
  };
  const [four, three] = [meter(4), meter(3)];
  const bar = m >= 8 && three.contrast > 1.25 * four.contrast && three.contrast > 0 ? three : four;
  const other = bar === four ? three : four;
  const barConfidence = bar.contrast > 0 ? Math.max(0, Math.min(1, (bar.contrast - Math.max(0, other.contrast)) / bar.contrast)) : 0;
  const t = (frame: number) => (k0 + frame) / fps;
  return {
    bpm: bpmOf(fitted),
    confidence: Math.max(0, Math.min(1, chosen.r)),
    alternatives,
    period: fitted / fps,
    beats: beats.map(t),
    beatsConfidence,
    barBeats: bar.beatsPerBar,
    barConfidence: m >= 2 * bar.beatsPerBar ? barConfidence : 0,
    downbeats: beats.filter((_, i) => i % bar.beatsPerBar === bar.phase).map(t),
    downbeatConfidence: m >= 2 * bar.beatsPerBar ? bar.sure : 0
  };
}

// ---- What kind of sound it is ----

export type Kind = "one-shot" | "loop-like" | "music";

// What decides music: 8 s or more (a jingle is a one-shot), 12 onsets, and
// a beat that both repeats (autocorrelation 0.2) and keeps time (65% of its
// gaps within 4%). Over Ludo's own sounds, every music track clears both,
// the weakest only just (0.21 and 69%), and no voice, creature or ambience
// clears both: those that repeat do not keep time, and the reverse.
const MUSIC = { seconds: 8, onsets: 12, autocorrelation: 0.2, steady: 0.65 };

/**
 * Music has a steady beat; a loop-like sound has no clear start or end: it
 * neither starts from silence nor dies away, and either starts near its
 * typical (median) level or at the level it ends at, so the end runs into
 * the start; anything else is a one-shot. Returns the reasons in words.
 */
export function kindOf(a: Audio, env: Envelope, found: Onset[], beat: Tempo | undefined, gate: number): { kind: Kind; reasons: string[] } {
  const dur = frames(a) / a.rate;
  const { rms } = env;
  const audible = Array.from(rms).filter(v => v >= gate);
  const median = percentile(audible.length ? audible : rms, 0.5);
  const peak = maxOf(rms);
  const edgeLevel = (from: number, to: number) => {
    let v = 0;
    for (let j = Math.max(0, from); j < Math.min(rms.length, to); j++) v = Math.max(v, rms[j]);
    return v;
  };
  // Against the median, in dB; 30 ms at the start (as long as a hit
  // takes) and 50 ms at the end.
  const head = toDb(edgeLevel(0, 30)) - toDb(median);
  const last = toDb(edgeLevel(rms.length - 50, rms.length));
  const tail = last - toDb(median);
  const db = (v: number) => `${Math.abs(v).toFixed(0)} dB`;
  const beatWords = (b: Tempo) => `${Math.round(b.bpm)} BPM, autocorrelation ${b.confidence.toFixed(2)}, ${Math.round(b.beatsConfidence * 100)}% of its beat gaps steady`;
  if (beat && dur >= MUSIC.seconds && found.length >= MUSIC.onsets && beat.confidence >= MUSIC.autocorrelation && beat.beatsConfidence >= MUSIC.steady) {
    return { kind: "music", reasons: [`a steady beat (${beatWords(beat)})`, `${found.length} onsets over ${dur.toFixed(1)} s`] };
  }
  const reasons: string[] = [];
  if (beat && dur >= MUSIC.seconds) reasons.push(`no steady beat (the best is ${beatWords(beat)})`);
  const fromSilence = head < -12;
  const diesAway = tail < -12;
  const runsOn = !fromSilence && !diesAway && (head <= 6 || Math.abs(head - tail) <= 6);
  if (runsOn && dur >= 1) {
    reasons.unshift(`no clear start or end: its first 30 ms are ${head >= 0 ? "+" : "-"}${db(head)} and its last 50 ms ${tail >= 0 ? "+" : "-"}${db(tail)} against its median level`);
    return { kind: "loop-like", reasons };
  }
  const why = [
    fromSilence ? (head < -40 ? "it starts from silence" : `it starts quietly (its first 30 ms are ${db(head)} under its median level)`) : "",
    !fromSilence && head > 6 ? `it starts on a hit (its first 30 ms are ${db(head)} over its median level)` : "",
    diesAway ? (tail < -40 ? `it dies away to silence` : `it dies away (its last 50 ms are ${db(tail)} under its median level, ${db(last - toDb(peak))} under its peak)`) : "",
    runsOn ? `it is only ${Math.round(dur * 1000)} ms long` : ""
  ].filter(Boolean);
  reasons.unshift(why.join(", and "));
  return { kind: "one-shot", reasons };
}

// ---- Shared ----

// A number flag in its own unit, with bounds; undefined when not given.
function numberFlag(call: ToolCall, flag: string, unit: string, min: number, max: number): number | undefined {
  const raw = textFlag(call, flag);
  if (raw === undefined) {
    if (call.flags.has(flag)) throw usage(`${flag} takes a number of ${unit}`);
    return undefined;
  }
  const v = Number(raw.trim().replace(/(dbfs|db)$/i, ""));
  if (!Number.isFinite(v) || v < min || v > max) throw usage(`${flag} takes ${unit} from ${min} to ${max} (got "${raw}")`);
  return v;
}

const ms = (seconds: number | undefined) => (seconds === undefined || !Number.isFinite(seconds) ? null : Math.round(seconds * 1000));
const round = (v: number, places = 2) => (Number.isFinite(v) ? Math.round(v * 10 ** places) / 10 ** places : null);
const msText = (seconds: number | undefined) => (seconds === undefined ? "never" : seconds < 10 ? `${Math.round(seconds * 1000)} ms` : `${seconds.toFixed(2)} s`);

const THRESHOLD = { flag: "--threshold", value: "dB", description: "Quieter than this counts as silence, in dBFS (default -50, as audio info)" };

function silent(src: LoadedAudio, threshold: number): never {
  throw new CliError(`${shown(src.file)} is silent: nothing in it is louder than ${threshold} dBFS`, EXIT.BAD_INPUT, "Lower --threshold, or check it with ludo toolbox audio info.");
}

// Onsets quieter than this under the loudest moment are its noise, not hits.
const ONSET_RANGE_DB = -45;

interface Analysis {
  env: Envelope;
  spec: Spectrum;
  found: Onset[];
  shape: Shape;
  range: { start: number; end: number };
}

function analyse(src: LoadedAudio, threshold: number): Analysis {
  const a = src.audio;
  const range = audibleRange(a, fromDb(threshold));
  if (!range) silent(src, threshold);
  const env = envelope(a);
  const gate = Math.max(fromDb(threshold), maxOf(env.rms) * fromDb(ONSET_RANGE_DB));
  const spec = spectrum(a, fromDb(threshold));
  const found = onsets(spec, env, gate);
  return { env, spec, found, shape: shape(env, found), range };
}

// ---- onsets ----

TOOLS.push({
  group: "audio",
  name: "onsets",
  args: "<sound>",
  summary: "When a sound actually hits, how it rises and dies away, and for music the beat grid",
  details: [
    "Onsets are where the spectrum jumps and the sound gets louder (spectral flux, adaptive threshold),",
    "each placed on the samples to the millisecond. hit is the onset that starts the loudest moment:",
    "the time to line up with an impact frame, rather than the file's start. attack runs from the hit",
    "until it first comes within 6 dB of its peak (the loudest 10 ms); decay is how long after the",
    "peak it takes to fall 20 and 40 dB; tail runs from the -20 dB point to where it ends (under",
    "--threshold).",
    "kind is one-shot, loop-like (no clear start or end) or music (a steady beat over 8 s or more),",
    "with the reasons. For music: the BPM (onset autocorrelation with a prior around 120 BPM, and a",
    "check between half and double; the half, double and 3:2 readings are listed with scores), the",
    "beats, the bar length and downbeats, each with a 0-1 confidence. --beats tracks a beat in any",
    "sound of 4 s or more.",
    "All times in JSON are milliseconds from the file's start. It measures only: nothing is written."
  ],
  flags: [THRESHOLD, { flag: "--beats", description: "Track the beat even when the sound is not judged to be music" }],
  async run(ctx, call) {
    if (call.args.length !== 1) throw usage("Usage: ludo toolbox audio onsets <sound>");
    const src = loadAudioFile(call.args[0]);
    const threshold = numberFlag(call, "--threshold", "dB", -120, 0) ?? -50;
    const a = src.audio;
    const dur = frames(a) / a.rate;
    const { env, spec, found, shape: sh, range } = analyse(src, threshold);
    const beat = dur >= 4 ? tempo(spec, range.start / a.rate, range.end / a.rate) : undefined;
    const { kind, reasons } = kindOf(a, env, found, beat, fromDb(threshold));
    const showBeat = beat && (kind === "music" || call.flags.has("--beats"));
    const end = range.end / a.rate;
    const tail = sh.decay20 !== undefined ? Math.max(0, end - (sh.peak + sh.decay20)) : undefined;
    const next =
      kind === "music"
        ? hint("Check its loop seam and loudness", `ludo toolbox audio info ${shown(src.file)}`)
        : hint("Check its loudness and peaks", `ludo toolbox audio info ${shown(src.file)}`);
    if (ctx.jsonOut) {
      printJson(
        {
          audio: shown(src.file),
          duration_ms: ms(dur),
          kind,
          kind_reasons: reasons,
          start_ms: ms(range.start / a.rate),
          end_ms: ms(end),
          hit_ms: ms(sh.hit),
          peak_ms: ms(sh.peak),
          peak_db: round(sh.peakDb),
          attack_ms: ms(sh.attack),
          decay_20db_ms: ms(sh.decay20),
          decay_40db_ms: ms(sh.decay40),
          tail_ms: ms(tail),
          onset_count: found.length,
          onsets: found.map(o => ({ ms: ms(o.at), strength: round(o.strength) })),
          ...(showBeat
            ? {
                tempo: {
                  bpm: round(beat.bpm, 1),
                  confidence: round(beat.confidence),
                  alternatives: beat.alternatives.map(x => ({ bpm: round(x.bpm, 1), score: round(x.score) })),
                  beat_ms: round(beat.period * 1000, 1),
                  beats_confidence: round(beat.beatsConfidence),
                  beats_ms: beat.beats.map(ms),
                  bar_beats: beat.barBeats,
                  bar_ms: round(beat.period * beat.barBeats * 1000, 1),
                  bar_confidence: round(beat.barConfidence),
                  downbeat_ms: ms(beat.downbeats[0]),
                  downbeat_confidence: round(beat.downbeatConfidence),
                  downbeats_ms: beat.downbeats.map(ms)
                }
              }
            : {}),
          ...(ctx.globals.quiet ? {} : { hint: next })
        },
        false
      );
      return EXIT.OK;
    }
    const listed = found.slice(0, 8).map(o => msText(o.at));
    const down = (db: number, t: number | undefined) => (t === undefined ? `never ${db} dB down` : `${db} dB down ${msText(t)} after the peak`);
    const lines = [
      `${shown(src.file)}: ${kind}, ${dur.toFixed(2)} s, sounding from ${msText(range.start / a.rate)} to ${msText(end)}`,
      `  Kind       ${reasons.join("; ")}`,
      // A track's loudest moment says little about it; a sound effect's is its hit.
      ...(kind === "music"
        ? []
        : [
            `  Hit        ${msText(sh.hit)}, peak at ${msText(sh.peak)} (${sh.peakDb.toFixed(1)} dBFS)`,
            `  Envelope   attack ${msText(sh.attack)}; ${down(20, sh.decay20)}${sh.decay20 !== undefined ? `, ${down(40, sh.decay40)}` : ""}${tail !== undefined ? `; tail ${msText(tail)}` : ""}`
          ]),
      `  Onsets     ${found.length}${found.length ? `: ${listed.join(", ")}${found.length > listed.length ? ", ..." : ""}` : ""}`
    ];
    if (showBeat) {
      const alt = beat.alternatives.filter(x => x.score > 0.05).map(x => `${x.bpm.toFixed(0)} (${x.score.toFixed(2)})`).join(", ");
      lines.push(
        `  Tempo      ${beat.bpm.toFixed(1)} BPM (confidence ${beat.confidence.toFixed(2)})${alt ? `; other readings, scored against it: ${alt}` : ""}`,
        `  Beats      ${beat.beats.length}, every ${Math.round(beat.period * 1000)} ms from ${msText(beat.beats[0])} (confidence ${beat.beatsConfidence.toFixed(2)})`,
        `  Bars       ${beat.barBeats} beats (confidence ${beat.barConfidence.toFixed(2)}), first downbeat at ${msText(beat.downbeats[0])} (confidence ${beat.downbeatConfidence.toFixed(2)})`
      );
    }
    process.stdout.write(lines.join("\n") + "\n");
    if (!ctx.globals.quiet) process.stderr.write(`Next: ${next.text}: ${next.command}\n`);
    return EXIT.OK;
  }
});

// ---- randomizer ----

export interface Take {
  file: string;
  duration: number; // seconds
  lufs: number;
  short: boolean; // loudness measured as one block of its own length
  peakDb: number; // sample peak, dBFS
  peak: number; // seconds: the loudest 10 ms
  hit?: number; // seconds: the onset that starts it
  centroid: number; // Hz
}

export function measureTake(src: LoadedAudio, threshold: number): Take {
  const { spec, shape: sh } = analyse(src, threshold);
  const l = loudness(src.audio);
  return { file: src.file, duration: frames(src.audio) / src.audio.rate, lufs: l.lufs, short: l.short, peakDb: toDb(samplePeak(src.audio)), peak: sh.peak, hit: sh.hit, centroid: spec.centroid };
}

export type Order = "shuffle" | "random" | "sequence";
// Godot 4's AudioStreamRandomizer.PlaybackMode.
const GODOT_MODE: Record<Order, number> = { shuffle: 0, random: 1, sequence: 2 };

const quote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/**
 * A Godot 4 AudioStreamRandomizer (text resource format 3, no uids: Godot
 * assigns them on import), one stream per take at weight 1. Godot saves no
 * property left at its default, so neither does this: playback_mode only
 * when not shuffle (Godot's "Random (Avoid Repeats)"), and random_pitch and
 * random_volume_offset_db never, which keeps every take at its own pitch and
 * level.
 */
export function godotRandomizer(paths: string[], order: Order): string {
  const out = [`[gd_resource type="AudioStreamRandomizer" format=3]`, ""];
  paths.forEach((p, i) => out.push(`[ext_resource type="AudioStream" path=${quote(p)} id="${i + 1}_take"]`));
  out.push("", "[resource]");
  if (GODOT_MODE[order]) out.push(`playback_mode = ${GODOT_MODE[order]}`);
  out.push(`streams_count = ${paths.length}`);
  paths.forEach((_, i) => out.push(`stream_${i}/stream = ExtResource("${i + 1}_take")`, `stream_${i}/weight = 1.0`));
  return out.join("\n") + "\n";
}

// Where a file sits for a Unity project: Assets/... inside one, with the
// asset's GUID when Unity has written its .meta; else relative to `from`.
function unityRef(file: string, from: string): { path: string; guid?: string } {
  const abs = real(file);
  for (let dir = path.dirname(abs); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "Assets")) && fs.existsSync(path.join(dir, "ProjectSettings"))) {
      const rel = path.relative(dir, abs);
      if (rel.split(path.sep)[0] !== "Assets") break;
      let guid: string | undefined;
      try {
        guid = /^guid:\s*([0-9a-f]{32})/m.exec(fs.readFileSync(`${abs}.meta`, "utf8"))?.[1];
      } catch {
        guid = undefined;
      }
      return { path: rel.split(path.sep).join("/"), ...(guid ? { guid } : {}) };
    }
    if (path.dirname(dir) === dir) break;
  }
  return { path: posixRelative(from, abs) };
}

// A path with its links resolved (macOS's /var is /private/var), as far as
// it exists: the folder a set is written to may not yet.
function real(p: string): string {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync(abs);
  } catch {
    const parent = path.dirname(abs);
    return parent === abs ? abs : path.join(real(parent), path.basename(abs));
  }
}

const posixRelative = (from: string, file: string) => path.relative(real(from), real(file)).split(path.sep).join("/");

function godotRef(file: string, from: string): string {
  const abs = real(file);
  const project = findGodotProject(real(from));
  if (project) {
    const rel = path.relative(project, abs);
    if (!rel.startsWith("..") && !path.isAbsolute(rel)) return `res://${rel.split(path.sep).join("/")}`;
  }
  return posixRelative(from, abs);
}

// The name the takes share: hit_a, hit_b -> hit; step_01_0, step_02_0 ->
// step. Their base names less a trailing take number or letter, else the
// longest common prefix.
export function setName(files: string[]): string {
  const bases = files.map(baseOf);
  const strip = (b: string) => b.replace(/[-_ .]?(\d+|[a-z])$/i, "");
  let names = bases.map(strip);
  // A Ludo download's own _0 suffix, then the take number.
  if (names.some(x => x !== names[0])) names = names.map(strip);
  if (names.every(x => x === names[0]) && names[0]) return names[0];
  let prefix = bases[0];
  for (const b of bases) while (!b.startsWith(prefix)) prefix = prefix.slice(0, -1);
  return prefix.replace(/[-_ .]+$/, "") || "takes";
}

const commonDir = (files: string[]) => {
  let dir = path.dirname(path.resolve(files[0]));
  for (const f of files) while (path.relative(dir, path.resolve(f)).startsWith("..")) dir = path.dirname(dir);
  return dir;
};

// Spreads that are worth a sentence. None of them changes a file: the
// volume, timing and choice of takes stay the developer's.
const LOUDNESS_SPREAD_LU = 3;
const HIT_SPREAD_S = 0.015;
const BRIGHTNESS_SPREAD_OCTAVES = 1;

// Where a level would go in each engine, as the files leave it unset.
const VOLUME = {
  godot: "Godot's AudioStreamRandomizer has no per-stream volume: the player's volume_db sets one for all takes, and random_volume_offset_db only adds random variation",
  unity: "Unity's AudioSource.volume (or a per-clip volume your component applies)",
  web: "Howler's volume option and Phaser's volume sound config"
};
const VOLUME_FIELDS = `These files set no volume. Where one would go: ${VOLUME.godot}; ${VOLUME.unity}; ${VOLUME.web}`;

TOOLS.push({
  group: "audio",
  name: "randomizer",
  args: "<take> <take>...",
  summary: "Measure several takes of one sound effect and write engine files that pick among them",
  details: [
    "Each take's length, loudness (LUFS), peak time, hit time and brightness (spectral centroid), and",
    "how far they spread. Then a Godot 4 AudioStreamRandomizer .tres, a Unity JSON list for a",
    "round-robin component (Assets/ paths and GUIDs inside a Unity project) and a Howler/Phaser-style",
    "sounds list, all pointing at the takes as they are (res:// paths inside a Godot project, else",
    "relative to the files). They are written in the takes' folder, or --out. --engine godot, unity or",
    "texturepacker (the web list) writes only that one.",
    "No audio is changed: when the takes' loudness differs it says by how much, and the volume is",
    "yours to set. --order shuffle (default: random, never the same take twice in a row), random or",
    "sequence."
  ],
  flags: [THRESHOLD, { flag: "--order", value: "shuffle|random|sequence", description: "How the engine picks the next take (default shuffle)" }],
  async run(ctx, call) {
    if (call.args.length < 2) throw usage("Usage: ludo toolbox audio randomizer <take> <take>... (two takes or more)");
    if (call.args.length > 64) throw usage(`A randomizer takes up to 64 takes (got ${call.args.length})`);
    const threshold = numberFlag(call, "--threshold", "dB", -120, 0) ?? -50;
    const order = (textFlag(call, "--order") ?? "shuffle") as Order;
    if (!(order in GODOT_MODE)) throw usage(`--order takes shuffle, random or sequence (got "${textFlag(call, "--order") ?? ""}")`);
    const seen = new Set<string>();
    for (const f of call.args) {
      if (seen.has(path.resolve(f))) throw usage(`${f} is given twice: each take once`);
      seen.add(path.resolve(f));
    }
    const takes = call.args.map(f => measureTake(loadAudioFile(f), threshold));

    const span = (v: number[]) => ({ min: Math.min(...v), max: Math.max(...v) });
    const lufs = span(takes.map(t => t.lufs));
    const hits = span(takes.map(t => t.hit ?? t.peak));
    const peaks = span(takes.map(t => t.peak));
    const durs = span(takes.map(t => t.duration));
    const cents = span(takes.map(t => t.centroid).filter(Number.isFinite));
    const octaves = cents.min > 0 ? Math.log2(cents.max / cents.min) : NaN;
    const named = (pick: (t: Take) => number, v: number) => shown(takes.find(t => pick(t) === v)!.file);
    const notes: string[] = [];
    if (lufs.max - lufs.min >= LOUDNESS_SPREAD_LU) {
      notes.push(
        `The takes' loudness differs by ${(lufs.max - lufs.min).toFixed(1)} LU (${named(t => t.lufs, lufs.min)} at ${lufs.min.toFixed(1)} LUFS, ${named(t => t.lufs, lufs.max)} at ${lufs.max.toFixed(1)}): a random pick will jump in volume. ${VOLUME_FIELDS}.`
      );
    }
    if (hits.max - hits.min >= HIT_SPREAD_S) {
      notes.push(`They hit at different times after their start (${Math.round(hits.min * 1000)} to ${Math.round(hits.max * 1000)} ms): to land every take's hit on one frame, start each its own hit_ms before it.`);
    }
    if (octaves >= BRIGHTNESS_SPREAD_OCTAVES) {
      notes.push(`Their brightness differs by ${octaves.toFixed(1)} octaves (spectral centroid ${Math.round(cents.min)} to ${Math.round(cents.max)} Hz): check they are takes of one sound.`);
    }
    if (durs.max >= 2 * durs.min) notes.push(`Their lengths differ over twice (${durs.min.toFixed(2)} to ${durs.max.toFixed(2)} s).`);

    const dir = ctx.globals.out ? ctx.outDir : commonDir(call.args);
    const name = ctx.globals.name || setName(call.args);
    const engine = ctx.globals.engine;
    const kinds = (engine ? [engine === "texturepacker" ? "web" : engine] : ["godot", "unity", "web"]) as ("godot" | "unity" | "web")[];
    const ext = { godot: ".tres", unity: ".unity.json", web: ".sounds.json" };
    // One suffix for the set: never overwrites, and the files stay a set.
    let base = name;
    for (let n = 2; kinds.some(k => fs.existsSync(path.join(dir, base + ext[k]))); n++) base = `${name}-${n}`;
    fs.mkdirSync(dir, { recursive: true });
    const perTake = (t: Take) => ({ name: baseOf(t.file), duration_ms: ms(t.duration), loudness_lufs: round(t.lufs), hit_ms: ms(t.hit), peak_ms: ms(t.peak) });
    const files: { kind: string; file: string }[] = [];
    for (const k of kinds) {
      const file = path.join(dir, base + ext[k]);
      let text: string;
      if (k === "godot") text = godotRandomizer(takes.map(t => godotRef(t.file, dir)), order);
      else if (k === "unity") {
        text = JSON.stringify(
          {
            name: base,
            order,
            clips: takes.map(t => ({ ...unityRef(t.file, dir), ...perTake(t) })),
            note: `Measured, not levelled: loudness_lufs is each take's own, and no volume is set. A level would go in ${VOLUME.unity}.`
          },
          null,
          2
        );
      } else {
        text = JSON.stringify(
          {
            name: base,
            order,
            // Howler: new Howl({ src }); Phaser: this.load.audio(key, src). Paths are relative to this file.
            sounds: takes.map(t => ({ key: baseOf(t.file), src: [posixRelative(dir, t.file)], ...perTake(t) })),
            note: `Measured, not levelled: loudness_lufs is each take's own, and no volume is set. A level would go in ${VOLUME.web}.`
          },
          null,
          2
        );
      }
      fs.writeFileSync(file, k === "godot" ? text : text + "\n", { flag: "wx" });
      files.push({ kind: k, file });
    }
    const next = hint("See when a take hits", `ludo toolbox audio onsets ${shown(takes[0].file)}`);
    if (ctx.jsonOut) {
      printJson(
        {
          takes: takes.map(t => ({
            audio: shown(t.file),
            duration_ms: ms(t.duration),
            loudness_lufs: round(t.lufs),
            ...(t.short ? { loudness_short: true } : {}),
            peak_db: round(t.peakDb),
            hit_ms: ms(t.hit),
            peak_ms: ms(t.peak),
            centroid_hz: Number.isFinite(t.centroid) ? Math.round(t.centroid) : null
          })),
          spread: {
            loudness_lu: round(lufs.max - lufs.min),
            hit_ms: ms(hits.max - hits.min),
            peak_ms: ms(peaks.max - peaks.min),
            duration_ms: ms(durs.max - durs.min),
            centroid_octaves: round(octaves)
          },
          order,
          files: Object.fromEntries(files.map(f => [f.kind, shown(f.file)])),
          ...(notes.length ? { notes } : {}),
          ...(ctx.globals.quiet ? {} : { hint: next })
        },
        false
      );
      return EXIT.OK;
    }
    const width = Math.max(...takes.map(t => shown(t.file).length));
    const lines = [
      `${takes.length} takes of ${base}:`,
      ...takes.map(
        t =>
          `  ${shown(t.file).padEnd(width)}  ${t.duration.toFixed(2)} s  ${Number.isFinite(t.lufs) ? `${t.lufs.toFixed(1)} LUFS` : "silent"}  hit ${msText(t.hit)}  peak ${msText(t.peak)}  ${Number.isFinite(t.centroid) ? `${Math.round(t.centroid)} Hz` : ""}`
      ),
      `  Spread     loudness ${(lufs.max - lufs.min).toFixed(1)} LU, hits ${Math.round((hits.max - hits.min) * 1000)} ms apart, length ${durs.min.toFixed(2)}-${durs.max.toFixed(2)} s, brightness ${Number.isFinite(octaves) ? octaves.toFixed(1) : "?"} octaves`
    ];
    process.stdout.write(lines.join("\n") + "\n");
    for (const n of notes) process.stderr.write(`Note: ${n}\n`);
    for (const f of files) process.stdout.write(`Saved ${shown(f.file)}\n`);
    if (!ctx.globals.quiet) process.stderr.write(`Next: ${next.text}: ${next.command}\n`);
    return EXIT.OK;
  }
});
