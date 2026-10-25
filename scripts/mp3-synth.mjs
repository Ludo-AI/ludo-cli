// Writes an MPEG audio layer I or layer II stream straight from subband
// samples (no analysis filterbank): a sine in each subband, scale factors
// that move from frame to frame, every scfsi pattern (layer II), quantized
// to an allocation chosen per band within the frame's bits. The streams
// are valid by ISO/IEC 11172-3 and 13818-3; what they sound like does not
// matter, only that decoders agree on them. ffmpeg has no layer I encoder,
// and its layer II encoder never writes joint (intensity) stereo, so
// scripts/mp3-corpus-make.mjs uses this for those files.
//
// node scripts/mp3-synth.mjs out layer(1|2) version(1|2) rateIndex bitrateIndex mode(0-3) modeExt frames seed
import fs from "node:fs";

const [out, layerS, versionS, rateS, brS, modeS, extS, framesS, seedS] = process.argv.slice(2);
const layer = +layerS;
const mpeg1 = versionS === "1";
const rateIdx = +rateS;
const brIdx = +brS;
const mode = +modeS; // 0 stereo, 1 joint, 2 dual, 3 mono
const modeExt = +extS;
const nframes = +framesS;

// A deterministic random source (mulberry32), as the tests use.
let seed = +seedS || 1;
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// prettier-ignore
const HALF = [
  [[0,4,8,12,16,20,24,28,32,40,48,56,64,72,80], [0,4,8,12,16,20,24,28,32,40,48,56,64,72,80], [0,16,24,28,32,40,48,56,64,72,80,88,96,112,128]],
  [[0,16,20,24,28,32,40,48,56,64,80,96,112,128,160], [0,16,24,28,32,40,48,56,64,80,96,112,128,160,192], [0,16,32,48,64,80,96,112,128,144,160,176,192,208,224]]
];
const layerBits = layer === 1 ? 3 : 2;
const kbps = 2 * HALF[mpeg1 ? 1 : 0][layerBits - 1][brIdx];
const hz = [44100, 48000, 32000][rateIdx] >> (mpeg1 ? 0 : 1);
const spf = layer === 1 ? 384 : 1152;
const nch = mode === 3 ? 1 : 2;
const bound = mode === 3 ? 0 : mode === 1 ? 4 * (modeExt + 1) : 32;

// The bit allocation codes (ISO tables B.2a-d and B.4, in minimp3's and
// ffmpeg's packing): a row per band class, code -> quantizer, where 1-16
// is that many bits a sample and 17, 18, 19 are 3, 5 and 9 levels grouped.
// prettier-ignore
const CODES = [
  0,17, 3, 4, 5,6,7, 8,9,10,11,12,13,14,15,16,
  0,17,18, 3,19,4,5, 6,7, 8, 9,10,11,12,13,16,
  0,17,18, 3,19,4,5,16,
  0,17,18,16,
  0,17,18,19, 4,5,6, 7,8, 9,10,11,12,13,14,15,
  0,17,18, 3,19,4,5, 6,7, 8, 9,10,11,12,13,14,
  0, 2, 3, 4, 5,6,7, 8,9,10,11,12,13,14,15,16
];
// [row offset, code width] per band.
function bandTable() {
  if (layer === 1) return Array.from({ length: 32 }, () => [76, 4]);
  let rows;
  let n;
  if (!mpeg1) {
    rows = [[60, 4, 4], [44, 3, 7], [44, 2, 19]];
    n = 30;
  } else {
    const perChannel = kbps >> (mode !== 3 ? 1 : 0);
    rows = [[0, 4, 3], [16, 4, 8], [32, 3, 12], [40, 2, 7]];
    n = 27;
    if (perChannel < 56) {
      rows = [[44, 4, 2], [44, 3, 10]];
      n = rateIdx === 2 ? 12 : 8;
    } else if (perChannel >= 96 && rateIdx !== 1) n = 30;
  }
  const bands = [];
  for (const [off, width, count] of rows) for (let i = 0; i < count; i++) bands.push([off, width]);
  return bands.slice(0, n);
}
const bands = bandTable();
const sblimit = bands.length;

class BitWriter {
  constructor(bytes) {
    this.buf = new Uint8Array(bytes);
    this.pos = 0;
  }
  put(v, n) {
    for (let i = n - 1; i >= 0; i--) {
      if ((v >> i) & 1) this.buf[this.pos >> 3] |= 0x80 >> (this.pos & 7);
      this.pos++;
    }
  }
}

// Bits of one band's samples in a frame, by quantizer.
const sampleBits = ba => (ba === 0 ? 0 : ba < 17 ? ba * (layer === 1 ? 12 : 36) : (ba === 17 ? 5 : ba === 18 ? 7 : 10) * 12);
// Code values: never all ones (forbidden for 1-16 bits).
const levels = ba => (ba < 17 ? (1 << ba) - 1 : ba === 17 ? 3 : ba === 18 ? 5 : 9);

const frames = [];
let padAcc = 0;
const tone = Array.from({ length: 2 }, () => Array.from({ length: 32 }, () => ({ f: 0.02 + rnd() * 0.3, a: rnd(), p: rnd() * 6 })));
for (let fr = 0; fr < nframes; fr++) {
  // Padding spread as an encoder spreads it, for the exact average rate.
  const raw = (spf * kbps * 125) / hz;
  const slot = layer === 1 ? 4 : 1;
  let bytes = layer === 1 ? Math.floor(raw / 4) * 4 : Math.floor(raw);
  padAcc += raw - bytes;
  let padding = 0;
  if (padAcc >= slot) {
    padding = 1;
    padAcc -= slot;
    bytes += slot;
  }
  const w = new BitWriter(bytes);
  w.put(0xfff, 12);
  w.put(mpeg1 ? 1 : 0, 1);
  w.put(layerBits, 2);
  w.put(1, 1); // no CRC
  w.put(brIdx, 4);
  w.put(rateIdx, 2);
  w.put(padding, 1);
  w.put(0, 1);
  w.put(mode, 2);
  w.put(modeExt, 2);
  w.put(0, 1);
  w.put(1, 1);
  w.put(0, 2);

  // Allocations: lower bands get more, within the frame's bits (budgeting
  // three scale factors for every channel of an allocated band).
  let budget = bytes * 8 - 32;
  for (let sb = 0; sb < sblimit; sb++) budget -= bands[sb][1] * (sb < bound ? nch : 1);
  const alloc = [new Array(32).fill(0), new Array(32).fill(0)];
  const cls = [new Array(32).fill(0), new Array(32).fill(0)];
  for (let sb = 0; sb < sblimit; sb++) {
    for (let ch = 0; ch < (sb < bound ? nch : 1); ch++) {
      const [off, width] = bands[sb];
      const maxCode = (1 << width) - 1;
      let code = Math.max(0, Math.min(layer === 1 ? 14 : maxCode, Math.round(maxCode * (1 - sb / sblimit) * (0.4 + 0.6 * rnd()))));
      if (rnd() < 0.15) code = 0;
      for (; code > 0; code--) {
        const cost = sampleBits(CODES[off + code]) + (sb < bound ? 1 : nch) * (layer === 1 ? 6 : 2 + 18);
        if (cost <= budget) {
          budget -= cost;
          break;
        }
      }
      alloc[ch][sb] = code;
      cls[ch][sb] = code ? CODES[off + code] : 0;
      if (sb >= bound && nch === 2) {
        alloc[1][sb] = code;
        cls[1][sb] = cls[0][sb];
      }
    }
  }
  for (let sb = 0; sb < sblimit; sb++) for (let ch = 0; ch < (sb < bound ? nch : 1); ch++) w.put(alloc[ch][sb], bands[sb][1]);

  // Scale factors: indexes that move with the frame, and the scfsi
  // patterns (layer II) that share them.
  const scf = [[], []];
  const scfsi = [new Array(32).fill(0), new Array(32).fill(0)];
  for (let sb = 0; sb < sblimit; sb++) {
    for (let ch = 0; ch < nch; ch++) {
      if (!cls[ch][sb]) continue;
      const base = Math.max(0, Math.min(62, Math.floor(4 + sb * 1.5 + 6 * Math.sin(fr / 7 + sb + ch))));
      const s = [base, Math.min(62, base + Math.floor(rnd() * 3)), Math.max(0, base - Math.floor(rnd() * 3))];
      scfsi[ch][sb] = layer === 2 ? Math.floor(rnd() * 4) : 0;
      if (scfsi[ch][sb] === 1) s[1] = s[0];
      if (scfsi[ch][sb] === 2) s[1] = s[2] = s[0];
      if (scfsi[ch][sb] === 3) s[2] = s[1];
      scf[ch][sb] = s;
    }
  }
  if (layer === 2) for (let sb = 0; sb < sblimit; sb++) for (let ch = 0; ch < nch; ch++) if (cls[ch][sb]) w.put(scfsi[ch][sb], 2);
  for (let sb = 0; sb < sblimit; sb++) {
    for (let ch = 0; ch < nch; ch++) {
      if (!cls[ch][sb]) continue;
      const sel = layer === 1 ? [0] : [[0, 1, 2], [0, 2], [0], [0, 1]][scfsi[ch][sb]];
      for (const k of sel) w.put(scf[ch][sb][k], 6);
    }
  }

  // Samples: 12 granules of 1 (layer I) or 3 (layer II) samples a band;
  // bands above the joint stereo bound are shared.
  const per = layer === 1 ? 1 : 3;
  for (let gr = 0; gr < 12; gr++) {
    for (let sb = 0; sb < sblimit; sb++) {
      for (let ch = 0; ch < (sb < bound ? nch : 1); ch++) {
        const ba = cls[ch][sb];
        if (!ba) continue;
        const L = levels(ba);
        const tn = tone[ch][sb];
        const vals = [];
        for (let k = 0; k < per; k++) {
          const x = tn.a * Math.sin(2 * Math.PI * tn.f * ((fr * 12 + gr) * per + k) + tn.p);
          vals.push(Math.max(0, Math.min(L - 1, Math.round(((x + 1) / 2) * (L - 1)))));
        }
        if (ba < 17) for (const v of vals) w.put(v, ba);
        else w.put(vals[0] + L * vals[1] + L * L * vals[2], ba === 17 ? 5 : ba === 18 ? 7 : 10);
      }
    }
  }
  if (w.pos > bytes * 8) throw new Error(`frame ${fr} overflows: ${w.pos} > ${bytes * 8} bits`);
  frames.push(w.buf);
}
fs.writeFileSync(out, Buffer.concat(frames));
