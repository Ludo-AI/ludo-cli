import type { Audio } from "./wav.js";

// The sound work behind `ludo toolbox audio`, on planar float samples:
// loudness and true peak as ITU-R BS.1770-4 measures them (the filter and
// gating as libebur128 implements them, which ffmpeg's ebur128 filter
// agrees with), silence at the ends, fades, and loops. Pure functions; the
// files are audio-io.ts's.

export const toDb = (v: number) => (v > 0 ? 20 * Math.log10(v) : -Infinity);
export const fromDb = (db: number) => 10 ** (db / 20);

export const frames = (a: Audio) => a.channels[0]?.length ?? 0;
export const seconds = (a: Audio) => frames(a) / a.rate;

export function samplePeak(a: Audio): number {
  let peak = 0;
  for (const ch of a.channels) for (let i = 0; i < ch.length; i++) if (Math.abs(ch[i]) > peak) peak = Math.abs(ch[i]);
  return peak;
}

// The peak between the samples too, as a DAC rebuilds the wave: 4x
// oversampled under 96 kHz (2x under 192 kHz) through a 49-tap
// Hann-windowed sinc, libebur128's interpolator. Never below the sample
// peak.
export const truePeak = (a: Audio): number => truePeakAt(a).peak;

// The sample peak and where it is (a frame index; the first, on a tie).
function samplePeakAt(a: Audio): { peak: number; at: number } {
  let peak = 0;
  let at = 0;
  for (const ch of a.channels) {
    for (let i = 0; i < ch.length; i++) {
      if (Math.abs(ch[i]) > peak) [peak, at] = [Math.abs(ch[i]), i];
    }
  }
  return { peak, at };
}

// The true peak and where it is, in frames (fractional: between two
// samples). The interpolator's output at input i, phase f, is the
// oversampled signal at i * factor + f, which lags by its (taps - 1) / 2
// taps: so it stands for frame i + f / factor - (taps - 1) / 2 / factor.
function truePeakAt(a: Audio): { peak: number; at: number } {
  const factor = a.rate < 96000 ? 4 : a.rate < 192000 ? 2 : 1;
  let { peak, at } = samplePeakAt(a);
  if (factor === 1) return { peak, at };
  const taps = 49;
  // Each output phase f is a sum over input samples i - index[k] with weights coeff[k].
  const phases = Array.from({ length: factor }, () => ({ coeff: [] as number[], index: [] as number[] }));
  for (let j = 0; j < taps; j++) {
    const m = j - (taps - 1) / 2;
    let c = Math.abs(m) > 1e-6 ? Math.sin((m * Math.PI) / factor) / ((m * Math.PI) / factor) : 1;
    c *= 0.5 * (1 - Math.cos((2 * Math.PI * j) / (taps - 1)));
    if (Math.abs(c) > 1e-6) {
      phases[j % factor].coeff.push(c);
      phases[j % factor].index.push(Math.floor(j / factor));
    }
  }
  const lag = (taps - 1) / 2 / factor;
  const last = frames(a) - 1;
  for (const ch of a.channels) {
    for (let i = 0; i < ch.length; i++) {
      for (let f = 0; f < factor; f++) {
        const { coeff, index } = phases[f];
        let acc = 0;
        for (let k = 0; k < coeff.length; k++) {
          const j = i - index[k];
          if (j >= 0) acc += coeff[k] * ch[j];
        }
        if (Math.abs(acc) > peak) [peak, at] = [Math.abs(acc), Math.min(last, Math.max(0, i + f / factor - lag))];
      }
    }
  }
  return { peak, at };
}

// BS.1770's channel weights: 1 for left, right and centre, 1.41 for the
// surrounds, 0 for the LFE, in the WAV order of 5.1 (L R C LFE Ls Rs).
const weights = (n: number) => (n === 6 ? [1, 1, 1, 0, 1.41, 1.41] : n === 5 ? [1, 1, 1, 1.41, 1.41] : new Array(n).fill(1));

// The K-weighting: a high shelf (the head's effect) then a high-pass (the
// "RLB" curve), each a biquad, with BS.1770's analog prototypes brought to
// the sample rate by the bilinear transform (libebur128's coefficients,
// which give BS.1770's own table at 48 kHz). Returns the sum of squares of
// the weighted signal over each `step` samples and over all of them, so a
// long sound needs no second copy of its samples.
function kWeightedPower(ch: Float32Array, rate: number, step: number): { steps: Float64Array; total: number } {
  let f0 = 1681.974450955533;
  const G = 3.999843853973347;
  let Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / rate);
  const Vh = 10 ** (G / 20);
  const Vb = Vh ** 0.4996667741545416;
  let a0 = 1 + K / Q + K * K;
  const [sb0, sb1, sb2] = [(Vh + (Vb * K) / Q + K * K) / a0, (2 * (K * K - Vh)) / a0, (Vh - (Vb * K) / Q + K * K) / a0];
  const [sa1, sa2] = [(2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0];
  f0 = 38.13547087602444;
  Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / rate);
  a0 = 1 + K / Q + K * K;
  // The high-pass's numerator is 1, -2, 1.
  const [ha1, ha2] = [(2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0];
  const steps = new Float64Array(Math.floor(ch.length / step));
  let [x1, x2, y1, y2, z1, z2] = [0, 0, 0, 0, 0, 0];
  let total = 0;
  let sum = 0;
  for (let i = 0, k = 0, s = 0; i < ch.length; i++) {
    const x = ch[i];
    const y = sb0 * x + sb1 * x1 + sb2 * x2 - sa1 * y1 - sa2 * y2;
    const z = y - 2 * y1 + y2 - ha1 * z1 - ha2 * z2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    z2 = z1;
    z1 = z;
    sum += z * z;
    if (++k === step) {
      if (s < steps.length) steps[s++] = sum;
      total += sum;
      sum = 0;
      k = 0;
    }
  }
  return { steps, total: total + sum };
}

export interface Loudness {
  lufs: number; // integrated loudness, -Infinity for silence
  short: boolean; // under 400 ms: measured as one block over the whole sound
}

// Integrated loudness: the mean of 400 ms blocks (75% overlap) of K-weighted
// power, gated at -70 LUFS and then at 10 LU under the mean of what passed.
// A sound shorter than one block (most sound effects are) has no block, so
// BS.1770 gives it no loudness; it is measured as one block of its own
// length instead.
export function loudness(a: Audio): Loudness {
  const n = frames(a);
  const w = weights(a.channels.length);
  const step = Math.round(a.rate / 10);
  const block = 4 * step;
  const lufsOf = (p: number) => (p > 0 ? -0.691 + 10 * Math.log10(p) : -Infinity);
  const powers = a.channels.map((ch, c) => (w[c] ? kWeightedPower(ch, a.rate, step) : undefined));
  if (n < block) {
    let p = 0;
    powers.forEach((pw, c) => pw && (p += (w[c] * pw.total) / n));
    return { lufs: n && lufsOf(p) > -70 ? lufsOf(p) : -Infinity, short: true };
  }
  // Each block's power from the 100 ms sums, so every sample is squared once.
  const steps = Math.floor(n / step);
  const stepPower = new Float64Array(steps);
  powers.forEach((pw, c) => {
    if (pw) for (let s = 0; s < steps; s++) stepPower[s] += (w[c] * pw.steps[s]) / block;
  });
  const blocks: number[] = [];
  for (let s = 0; s + 4 <= steps; s++) blocks.push(stepPower[s] + stepPower[s + 1] + stepPower[s + 2] + stepPower[s + 3]);
  const loud = blocks.filter(p => lufsOf(p) > -70);
  if (!loud.length) return { lufs: -Infinity, short: false };
  const relative = lufsOf(loud.reduce((x, y) => x + y, 0) / loud.length) - 10;
  const gated = loud.filter(p => lufsOf(p) > relative);
  return { lufs: lufsOf(gated.reduce((x, y) => x + y, 0) / gated.length), short: false };
}

// The first and last sample (end exclusive) louder than `threshold` (linear)
// in any channel; undefined when none is.
export function audibleRange(a: Audio, threshold: number): { start: number; end: number } | undefined {
  const n = frames(a);
  let start = n;
  let end = 0;
  for (const ch of a.channels) {
    for (let i = 0; i < start; i++) if (Math.abs(ch[i]) > threshold) {
      start = i;
      break;
    }
    for (let i = n - 1; i >= end; i--) if (Math.abs(ch[i]) > threshold) {
      end = i + 1;
      break;
    }
  }
  return start < end ? { start, end } : undefined;
}

export function slice(a: Audio, start: number, end: number): Audio {
  return { rate: a.rate, channels: a.channels.map(ch => ch.slice(start, end)) };
}

// A fade over `length` samples from `at`, in or out, along a quarter sine
// (equal power) so a fade sounds even rather than sudden at one end.
export function fade(a: Audio, at: number, length: number, direction: "in" | "out") {
  const len = Math.min(length, frames(a) - at);
  if (len <= 0) return;
  for (const ch of a.channels) {
    for (let i = 0; i < len; i++) {
      const t = (i + 1) / (len + 1);
      ch[at + i] *= Math.sin(((direction === "in" ? t : 1 - t) * Math.PI) / 2);
    }
  }
}

export function toMono(a: Audio): Audio {
  if (a.channels.length === 1) return a;
  const out = new Float32Array(frames(a));
  for (const ch of a.channels) for (let i = 0; i < out.length; i++) out[i] += ch[i] / a.channels.length;
  return { rate: a.rate, channels: [out] };
}

// Samples at full scale twice or more in a row: where the sound was clipped.
export function clippedSamples(a: Audio): number {
  let count = 0;
  for (const ch of a.channels) {
    for (let i = 1; i < ch.length; i++) if (Math.abs(ch[i]) >= 0.999 && Math.abs(ch[i - 1]) >= 0.999) count++;
  }
  return count;
}

// Whether playing it on a loop clicks: the step from the last sample back
// to the first is over twice the largest step within 10 ms either side of
// it (what the ear hears it against: noise hides a jump that a tone does
// not), and above -60 dBFS.
export function loopClicks(a: Audio): boolean {
  const n = frames(a);
  if (n < 2) return false;
  const near = Math.min(Math.round(a.rate / 100), Math.floor(n / 2));
  let jump = 0;
  let local = 0;
  for (const ch of a.channels) {
    jump = Math.max(jump, Math.abs(ch[0] - ch[n - 1]));
    for (let i = 1; i <= near; i++) local = Math.max(local, Math.abs(ch[i] - ch[i - 1]), Math.abs(ch[n - i] - ch[n - i - 1]));
  }
  return jump > Math.max(2 * local, fromDb(-60));
}

// How many copies of one stretch the sound is (2 for a loop written out
// twice), or 1: each copy matches the first within 20 dB under its level,
// which a lossy file's own error stays far inside and different material
// never comes near.
export function repeats(a: Audio): number {
  const n = frames(a);
  // The most copies first: four copies are also two of a doubled one.
  for (const k of [4, 3, 2]) {
    const period = Math.floor(n / k);
    if (period < a.rate / 4 || n - period * k > 2) continue;
    let level = 0;
    let error = 0;
    for (const ch of a.channels) {
      for (let i = 0; i < period; i++) {
        level += ch[i] * ch[i];
        for (let r = 1; r < k; r++) error += (ch[i + r * period] - ch[i]) ** 2 / (k - 1);
      }
    }
    if (level > 0 && error < level / 100) return k;
  }
  return 1;
}
