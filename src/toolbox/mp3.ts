import {
  HUFF_TAB32,
  HUFF_TAB33,
  HUFF_TABINDEX,
  HUFF_TABS,
  L12_BITALLOC_CODES,
  LINBITS,
  POW43,
  SCF_PARTITIONS,
  SFB_LONG,
  SFB_MIXED,
  SFB_SHORT,
  SYNTH_WIN
} from "./mp3-tables.js";

// MPEG audio decoding, in-process: MPEG-1, MPEG-2 and MPEG-2.5, layers I,
// II and III, every channel mode (mono, stereo, dual channel, joint stereo
// with mid/side and intensity stereo), CBR, VBR and free format. Ported
// from minimp3 by lieff (minimp3.h, https://github.com/lieff/minimp3, commit
// ea99364), the plain C paths (its SIMD paths compute the same sums), with
// float output. The tag handling around it is minimp3_ex.h's, except where
// it follows FFmpeg (below). The tables are in mp3-tables.ts.
//
// The output is gapless, sample for sample what `ffmpeg -i f.mp3 -f f32le -`
// gives (FFmpeg 8 and 9, libavformat/mp3dec.c and libavcodec/
// mpegaudiodec_template.c):
//  - ID3v2 tags at the start are skipped, one after another, by ffmpeg's
//    test of a tag header (ff_id3v2_match), with the 10-byte footer only for
//    ID3v2.4;
//  - the Xing/Info and VBRI tags are looked for only in the frame right
//    after the ID3v2 tags (ffmpeg does not look past junk for them). A frame
//    holding one (with a frame count or byte count) is skipped, not decoded;
//  - when the Info tag's encoder string starts with LAME, Lavf or Lavc, its
//    encoder delay and padding apply: the first delay + 529 samples are
//    dropped (529 = 528 + 1, the decoder delay of the MPEG filterbanks), and
//    so are the samples from frames x spf - padding + 529 up to frames x spf
//    (spf: samples per frame; frames: the tag's count), which leaves
//    frames x spf - delay - padding when the stream has that many frames.
//    Samples past the tag's count (frames appended later) are kept, as
//    ffmpeg keeps them;
//  - the frame count is ignored, as ffmpeg ignores it, when the tag's byte
//    count is more than 1/16 short of the file ("invalid concatenated file");
//  - a frame cut off by the end of the data is decoded with the missing
//    bytes as zeros, and a last frame followed by junk is decoded, as ffmpeg
//    decodes both (minimp3 dropped them).
// Free-format streams, which ffmpeg cannot decode, follow the same rules,
// which is what `lame --decode` gives for them.
//
// Changes from minimp3, beyond those:
//  - a layer III frame whose bit reservoir reaches back past the data we
//    have still gives its samples: the granules whose main data starts in
//    the missing part are silent and the rest decode, which is what ffmpeg
//    does (minimp3 output nothing for the frame, so streams that start
//    mid-way, or resume after damage, came out a frame short);
//  - the private bits of MPEG-1 side info no longer leak into the first
//    granule's scale factor selection (scfsi); MPEG-1 has none for it;
//  - each IMDCT tail is weighted by the window of the block it came from,
//    tracked per subband; minimp3 weighted it by the current block's
//    window, which is only right for the normal-start-short-stop sequences
//    LAME writes. Mixed blocks and streams that switch windows without
//    start or stop blocks now decode as in mpg123/LAME's decoder (ffmpeg
//    agrees on mixed blocks; on the second kind ffmpeg drops part of the
//    previous tail, so there we differ from ffmpeg);
//  - Huffman region 0 of a mixed block is 36 lines (72 at 8 kHz), as in
//    ffmpeg and mpg123, not minimp3's 8 bands (48 lines for MPEG-2), and
//    the 8 kHz mixed band table is fixed (see mp3-tables.ts);
//  - the intensity-coded channel of MPEG-2 intensity stereo has no preflag
//    (minimp3 set it from scalefac_compress >= 500), as in ffmpeg;
//  - mid/side and intensity stereo apply only in joint stereo mode, as in
//    ffmpeg (minimp3 looked at the mode extension bits alone);
//  - an APEv2 tag at the end is cut by its own size, and its 32-byte header
//    only when its flags say it has one;
//  - samples are clamped to [-1, 1];
//  - kept from minimp3, where ffmpeg differs: an MPEG-2 intensity position
//    of 2^slen - 1 is illegal (the band is decoded as mid/side or left/
//    right), where ffmpeg only rejects positions >= 16;
//  - a stream whose sample rate, layer or channel count changes stops at
//    the change, as minimp3_ex.h's loader stops (it reported an error);
//  - errors are Mp3Error, and output is bounded by maxSamples.
//
// minimp3's licence:
//
//   To the extent possible under law, the author(s) have dedicated all
//   copyright and related and neighboring rights to this software to the
//   public domain worldwide. This software is distributed without any
//   warranty. See <http://creativecommons.org/publicdomain/zero/1.0/>.

export type Mp3ErrorCode = "NOT_MP3" | "CORRUPT" | "TOO_LARGE";

export class Mp3Error extends Error {
  constructor(
    readonly code: Mp3ErrorCode,
    message: string
  ) {
    super(message);
  }
}

export interface Mp3 {
  rate: number;
  channels: Float32Array[]; // planar, samples in [-1, 1]
  layer: 1 | 2 | 3;
  bitrate: number; // average kbit/s over the audio frames
  vbr: boolean;
}

export interface Mp3Options {
  maxSamples: number; // frames x channels; more is TOO_LARGE
}

// ---- Frame headers ----

const HDR_SIZE = 4;
const MAX_FREE_FORMAT_FRAME_SIZE = 2304; // more than ISO's
const MAX_FRAME_SYNC_MATCHES = 10;
const MAX_L3_FRAME_PAYLOAD_BYTES = MAX_FREE_FORMAT_FRAME_SIZE;
const MAX_BITRESERVOIR_BYTES = 511;
const SHORT_BLOCK_TYPE = 2;
const STOP_BLOCK_TYPE = 3;

// h is the header's first byte; b1-b3 the next three.
const isMono = (b3: number) => (b3 & 0xc0) === 0xc0;
const isJointStereo = (b3: number) => (b3 & 0xc0) === 0x40;
const isMsStereo = (b3: number) => (b3 & 0xe0) === 0x60;
const isFreeFormat = (b2: number) => (b2 & 0xf0) === 0;
const isCrc = (b1: number) => !(b1 & 1);
const isMpeg1 = (b1: number) => (b1 & 0x8) !== 0;
const notMpeg25 = (b1: number) => (b1 & 0x10) !== 0;
const isIStereo = (b3: number) => (b3 & 0x10) !== 0;
const testMsStereo = (b3: number) => (b3 & 0x20) !== 0;
const layerBits = (b1: number) => (b1 >> 1) & 3; // 3: layer I, 1: layer III
const bitrateIndex = (b2: number) => b2 >> 4;
const rateIndex = (b2: number) => (b2 >> 2) & 3;
// 0-8: MPEG-2.5, MPEG-2, MPEG-1, three rates each.
const myRateIndex = (b1: number, b2: number) => rateIndex(b2) + (((b1 >> 3) & 1) + ((b1 >> 4) & 1)) * 3;
const isFrame576 = (b1: number) => (b1 & 14) === 2;
const isLayer1 = (b1: number) => (b1 & 6) === 6;

function hdrValid(d: Uint8Array, o: number): boolean {
  const b1 = d[o + 1];
  const b2 = d[o + 2];
  return d[o] === 0xff && ((b1 & 0xf0) === 0xf0 || (b1 & 0xfe) === 0xe2) && layerBits(b1) !== 0 && bitrateIndex(b2) !== 15 && rateIndex(b2) !== 3;
}

// Whether the header at d2[o2] can follow the one at d1[o1] in a stream.
function hdrCompare(d1: Uint8Array, o1: number, d2: Uint8Array, o2: number): boolean {
  return hdrValid(d2, o2) && ((d1[o1 + 1] ^ d2[o2 + 1]) & 0xfe) === 0 && ((d1[o1 + 2] ^ d2[o2 + 2]) & 0x0c) === 0 && isFreeFormat(d1[o1 + 2]) === isFreeFormat(d2[o2 + 2]);
}

// prettier-ignore
const HALFRATE = [
  [[0,4,8,12,16,20,24,28,32,40,48,56,64,72,80], [0,4,8,12,16,20,24,28,32,40,48,56,64,72,80], [0,16,24,28,32,40,48,56,64,72,80,88,96,112,128]],
  [[0,16,20,24,28,32,40,48,56,64,80,96,112,128,160], [0,16,24,28,32,40,48,56,64,80,96,112,128,160,192], [0,16,32,48,64,80,96,112,128,144,160,176,192,208,224]]
];

const hdrBitrateKbps = (d: Uint8Array, o: number) => 2 * HALFRATE[isMpeg1(d[o + 1]) ? 1 : 0][layerBits(d[o + 1]) - 1][bitrateIndex(d[o + 2])];
const hdrSampleRate = (d: Uint8Array, o: number) => [44100, 48000, 32000][rateIndex(d[o + 2])] >> (isMpeg1(d[o + 1]) ? 0 : 1) >> (notMpeg25(d[o + 1]) ? 0 : 1);
const hdrFrameSamples = (d: Uint8Array, o: number) => (isLayer1(d[o + 1]) ? 384 : 1152 >> (isFrame576(d[o + 1]) ? 1 : 0));

function hdrFrameBytes(d: Uint8Array, o: number, freeFormatSize: number): number {
  let bytes = Math.floor((hdrFrameSamples(d, o) * hdrBitrateKbps(d, o) * 125) / hdrSampleRate(d, o));
  if (isLayer1(d[o + 1])) bytes &= ~3; // slot align
  return bytes || freeFormatSize;
}

const hdrPadding = (d: Uint8Array, o: number) => (d[o + 2] & 0x2 ? (isLayer1(d[o + 1]) ? 4 : 1) : 0);

// ---- Bits ----

// minimp3's bs_t over absolute bit positions: reading past the limit gives
// zeros (and moves pos past it, which callers check).
class Bits {
  buf: Uint8Array = new Uint8Array(0);
  pos = 0;
  limit = 0;
  init(buf: Uint8Array, start: number, bytes: number) {
    this.buf = buf;
    this.pos = start * 8;
    this.limit = (start + bytes) * 8;
  }
  get(n: number): number {
    const s = this.pos & 7;
    let shl = n + s;
    let p = this.pos >> 3;
    if ((this.pos += n) > this.limit) return 0;
    let cache = 0;
    let next = this.buf[p++] & (255 >> s);
    while ((shl -= 8) > 0) {
      cache |= next << shl;
      next = this.buf[p++];
    }
    return (cache | (next >> -shl)) >>> 0;
  }
}

// ---- Layers I and II ----

interface L12Info {
  scf: Float32Array; // 3 per band and channel
  totalBands: number;
  stereoBands: number;
  bitalloc: Uint8Array;
  scfcod: Uint8Array;
}

// [code table offset, code width, band count]
const ALLOC_L1 = [[76, 4, 32]];
const ALLOC_L2M2 = [
  [60, 4, 4],
  [44, 3, 7],
  [44, 2, 19]
];
const ALLOC_L2M1 = [
  [0, 4, 3],
  [16, 4, 8],
  [32, 3, 12],
  [40, 2, 7]
];
const ALLOC_L2M1_LOWRATE = [
  [44, 4, 2],
  [44, 3, 10]
];

function l12SubbandAllocTable(h: Uint8Array, sci: L12Info): number[][] {
  const mode = (h[3] >> 6) & 3;
  const stereoBands = mode === 3 ? 0 : mode === 1 ? (((h[3] >> 4) & 3) << 2) + 4 : 32;
  let alloc: number[][];
  let nbands: number;
  if (isLayer1(h[1])) {
    alloc = ALLOC_L1;
    nbands = 32;
  } else if (!isMpeg1(h[1])) {
    alloc = ALLOC_L2M2;
    nbands = 30;
  } else {
    const rateIdx = rateIndex(h[2]);
    let kbps = hdrBitrateKbps(h, 0) >> (mode !== 3 ? 1 : 0);
    if (!kbps) kbps = 192; // free format
    alloc = ALLOC_L2M1;
    nbands = 27;
    if (kbps < 56) {
      alloc = ALLOC_L2M1_LOWRATE;
      nbands = rateIdx === 2 ? 12 : 8;
    } else if (kbps >= 96 && rateIdx !== 1) {
      nbands = 30;
    }
  }
  sci.totalBands = nbands;
  sci.stereoBands = Math.min(stereoBands, nbands);
  return alloc;
}

// The scale factor values: 2^(1 - b/3) / (2^ba - 1) for the 6-bit index b,
// as minimp3 computes them, from three float steps and a power of two.
const DEQ_L12 = new Float32Array(
  [3, 7, 15, 31, 63, 127, 255, 511, 1023, 2047, 4095, 8191, 16383, 32767, 65535, 3, 5, 9].flatMap(x =>
    [9.53674316e-7, 7.56931807e-7, 6.00777173e-7].map(v => Math.fround(v) / x)
  )
);

function l12ReadScalefactors(bs: Bits, sci: L12Info, bands: number) {
  const { bitalloc, scfcod, scf } = sci;
  let o = 0;
  for (let i = 0; i < bands; i++) {
    let s = 0;
    const ba = bitalloc[i];
    const mask = ba ? 4 + ((19 >> scfcod[i]) & 3) : 0;
    for (let m = 4; m; m >>= 1) {
      if (mask & m) {
        const b = bs.get(6);
        s = DEQ_L12[ba * 3 - 6 + (b % 3)] * ((1 << 21) >> ((b / 3) | 0));
      }
      scf[o++] = s;
    }
  }
}

function l12ReadScaleInfo(h: Uint8Array, bs: Bits, sci: L12Info) {
  const alloc = l12SubbandAllocTable(h, sci);
  let k = 0;
  let a = 0;
  let baBits = 0;
  let codeTab = 0;
  for (let i = 0; i < sci.totalBands; i++) {
    if (i === k) {
      k += alloc[a][2];
      baBits = alloc[a][1];
      codeTab = alloc[a][0];
      a++;
    }
    let ba = L12_BITALLOC_CODES[codeTab + bs.get(baBits)];
    sci.bitalloc[2 * i] = ba;
    if (i < sci.stereoBands) ba = L12_BITALLOC_CODES[codeTab + bs.get(baBits)];
    sci.bitalloc[2 * i + 1] = sci.stereoBands ? ba : 0;
  }
  for (let i = 0; i < 2 * sci.totalBands; i++) sci.scfcod[i] = sci.bitalloc[i] ? (isLayer1(h[1]) ? 2 : bs.get(2)) : 6;
  l12ReadScalefactors(bs, sci, sci.totalBands * 2);
  for (let i = sci.stereoBands; i < sci.totalBands; i++) sci.bitalloc[2 * i + 1] = 0;
}

// Reads group size x 4 samples of every band into grbuf (channel 0 at 0,
// channel 1 at 576, band b at b x 18) from sample offset `at`.
function l12DequantizeGranule(grbuf: Float32Array, at: number, bs: Bits, sci: L12Info, groupSize: number): number {
  let choff = 576;
  for (let j = 0; j < 4; j++) {
    let dst = at + groupSize * j;
    for (let i = 0; i < 2 * sci.totalBands; i++) {
      const ba = sci.bitalloc[i];
      if (ba !== 0) {
        if (ba < 17) {
          const half = (1 << (ba - 1)) - 1;
          for (let k = 0; k < groupSize; k++) grbuf[dst + k] = bs.get(ba) - half;
        } else {
          const mod = (2 << (ba - 17)) + 1; // 3, 5, 9
          let code = bs.get(mod + 2 - (mod >> 3)); // 5, 7, 10 bits
          for (let k = 0; k < groupSize; k++, code = (code / mod) | 0) grbuf[dst + k] = (code % mod) - (mod >> 1);
        }
      }
      dst += choff;
      choff = 18 - choff;
    }
  }
  return groupSize * 4;
}

function l12ApplyScf384(sci: L12Info, scfAt: number, grbuf: Float32Array) {
  // Intensity bands: channel 1 takes channel 0's samples, with its own scale.
  grbuf.copyWithin(576 + sci.stereoBands * 18, sci.stereoBands * 18, sci.totalBands * 18);
  for (let i = 0, d = 0, s = scfAt; i < sci.totalBands; i++, d += 18, s += 6) {
    const s0 = sci.scf[s];
    const s1 = sci.scf[s + 3];
    for (let k = 0; k < 12; k++) {
      grbuf[d + k] *= s0;
      grbuf[d + k + 576] *= s1;
    }
  }
}

// ---- Layer III side info and scale factors ----

interface GrInfo {
  sfbtab: Uint8Array;
  part23Length: number;
  bigValues: number;
  scalefacCompress: number;
  globalGain: number;
  blockType: number;
  mixedBlockFlag: number;
  nLongSfb: number;
  nShortSfb: number;
  tableSelect: Uint8Array;
  regionCount: Uint8Array;
  subblockGain: Uint8Array;
  preflag: number;
  scalefacScale: number;
  count1Table: number;
  scfsi: number;
}

const newGrInfo = (): GrInfo => ({
  sfbtab: SFB_LONG[0],
  part23Length: 0,
  bigValues: 0,
  scalefacCompress: 0,
  globalGain: 0,
  blockType: 0,
  mixedBlockFlag: 0,
  nLongSfb: 0,
  nShortSfb: 0,
  tableSelect: new Uint8Array(3),
  regionCount: new Uint8Array(3),
  subblockGain: new Uint8Array(3),
  preflag: 0,
  scalefacScale: 0,
  count1Table: 0,
  scfsi: 0
});

// For mixed blocks, region 0's band count less one: the bands of the
// mixed table that make up 36 lines (72 at 8 kHz).
const MIXED_REGION0 = SFB_MIXED.map((t, k) => {
  let n = 0;
  for (let lines = 0; lines < (k === 1 ? 72 : 36); n++) lines += t[n];
  return n - 1;
});

// Returns main_data_begin, or -1 for side info no stream can have.
function l3ReadSideInfo(bs: Bits, grs: GrInfo[], h: Uint8Array): number {
  let rateIdx = myRateIndex(h[1], h[2]);
  rateIdx -= rateIdx !== 0 ? 1 : 0;
  const mono = isMono(h[3]);
  const mpeg1 = isMpeg1(h[1]);
  let grCount = mono ? 1 : 2;
  let scfsi = 0;
  let mainDataBegin: number;
  let part23Sum = 0;
  if (mpeg1) {
    grCount *= 2;
    mainDataBegin = bs.get(9);
    // The private bits come first; granule 0 has no scfsi (minimp3 let the
    // private bits through to it).
    scfsi = bs.get(7 + grCount) & (mono ? 0xf : 0xff);
  } else {
    mainDataBegin = bs.get(8 + grCount) >> grCount;
  }
  let g = 0;
  do {
    const gr = grs[g++];
    if (mono) scfsi <<= 4;
    gr.part23Length = bs.get(12);
    part23Sum += gr.part23Length;
    gr.bigValues = bs.get(9);
    if (gr.bigValues > 288) return -1;
    gr.globalGain = bs.get(8);
    gr.scalefacCompress = bs.get(mpeg1 ? 4 : 9);
    gr.sfbtab = SFB_LONG[rateIdx];
    gr.nLongSfb = 22;
    gr.nShortSfb = 0;
    let tables: number;
    if (bs.get(1)) {
      gr.blockType = bs.get(2);
      if (!gr.blockType) return -1;
      gr.mixedBlockFlag = bs.get(1);
      gr.regionCount[0] = 7;
      gr.regionCount[1] = 255;
      if (gr.blockType === SHORT_BLOCK_TYPE) {
        scfsi &= 0x0f0f;
        if (!gr.mixedBlockFlag) {
          gr.regionCount[0] = 8;
          gr.sfbtab = SFB_SHORT[rateIdx];
          gr.nLongSfb = 0;
          gr.nShortSfb = 39;
        } else {
          gr.sfbtab = SFB_MIXED[rateIdx];
          gr.nLongSfb = mpeg1 ? 8 : 6;
          gr.nShortSfb = 30;
          // Region 0 is the first 36 lines (72 at 8 kHz), as in ffmpeg and
          // mpg123; minimp3 took 8 bands, which is 48 lines for MPEG-2.
          gr.regionCount[0] = MIXED_REGION0[rateIdx];
        }
      }
      tables = bs.get(10) << 5;
      gr.subblockGain[0] = bs.get(3);
      gr.subblockGain[1] = bs.get(3);
      gr.subblockGain[2] = bs.get(3);
    } else {
      gr.blockType = 0;
      gr.mixedBlockFlag = 0;
      tables = bs.get(15);
      gr.regionCount[0] = bs.get(4);
      gr.regionCount[1] = bs.get(3);
      gr.regionCount[2] = 255;
    }
    gr.tableSelect[0] = tables >> 10;
    gr.tableSelect[1] = (tables >> 5) & 31;
    gr.tableSelect[2] = tables & 31;
    gr.preflag = mpeg1 ? bs.get(1) : gr.scalefacCompress >= 500 ? 1 : 0;
    gr.scalefacScale = bs.get(1);
    gr.count1Table = bs.get(1);
    gr.scfsi = (scfsi >> 12) & 15;
    scfsi <<= 4;
  } while (--grCount);
  if (part23Sum + bs.pos > bs.limit + mainDataBegin * 8) return -1;
  return mainDataBegin;
}

// Reads the scale factors into scf (and, for the intensity positions,
// istPos; 255 marks an illegal position) by the four slen fields.
function l3ReadScalefactors(scf: Uint8Array, istPos: Uint8Array, scfSize: Uint8Array, part: number, bs: Bits, scfsi: number) {
  let o = 0;
  for (let i = 0; i < 4 && SCF_PARTITIONS[part + i]; i++, scfsi *= 2) {
    const cnt = SCF_PARTITIONS[part + i];
    if (scfsi & 8) {
      scf.set(istPos.subarray(o, o + cnt), o);
    } else {
      const bits = scfSize[i];
      if (!bits) {
        scf.fill(0, o, o + cnt);
        istPos.fill(0, o, o + cnt);
      } else {
        const maxScf = scfsi < 0 ? (1 << bits) - 1 : -1;
        for (let k = 0; k < cnt; k++) {
          const s = bs.get(bits);
          istPos[o + k] = s === maxScf ? 255 : s;
          scf[o + k] = s;
        }
      }
    }
    o += cnt;
  }
  scf[o] = scf[o + 1] = scf[o + 2] = 0;
}

const EXPFRAC = new Float32Array([9.31322575e-10, 7.83145814e-10, 6.58544508e-10, 5.53767716e-10]);

// y x 2^(-exp/4), in steps of at most 2^-30.
function ldexpQ2(y: number, exp: number): number {
  let e: number;
  do {
    e = Math.min(30 * 4, exp);
    y *= EXPFRAC[e & 3] * ((1 << 30) >> (e >> 2));
  } while ((exp -= e) > 0);
  return y;
}

const SCFC_DECODE = new Uint8Array([0, 1, 2, 3, 12, 5, 6, 7, 9, 10, 11, 13, 14, 15, 18, 19]);
const SCF_MOD = new Uint8Array([5, 5, 4, 4, 5, 5, 4, 1, 4, 3, 1, 1, 5, 6, 6, 1, 4, 4, 4, 1, 4, 3, 1, 1]);
const PREAMP = new Uint8Array([1, 1, 1, 1, 2, 2, 3, 3, 3, 2]);
const MAX_SCFI = 44; // ((255 - 4 - 210) + 3) & ~3: the dequantizer's -1 bit of headroom

function l3DecodeScalefactors(h: Uint8Array, istPos: Uint8Array, bs: Bits, gr: GrInfo, scf: Float32Array, ch: number, t: Scratch) {
  let part = 28 * ((gr.nShortSfb ? 1 : 0) + (gr.nLongSfb ? 0 : 1));
  const scfSize = t.scfSize;
  const iscf = t.iscf;
  const scfShift = gr.scalefacScale + 1;
  let scfsi = gr.scfsi;
  let preflag = gr.preflag;
  if (isMpeg1(h[1])) {
    const p = SCFC_DECODE[gr.scalefacCompress];
    scfSize[1] = scfSize[0] = p >> 2;
    scfSize[3] = scfSize[2] = p & 3;
  } else {
    const ist = isIStereo(h[3]) && ch ? 1 : 0;
    // The intensity-coded channel has no preflag (its scalefac_compress
    // only picks the slen tables); minimp3 set it from scalefac_compress
    // >= 500 all the same.
    if (ist) preflag = 0;
    let sfc = gr.scalefacCompress >> ist;
    let k = ist * 3 * 4;
    let modprod = 1;
    for (; sfc >= 0; sfc -= modprod, k += 4) {
      modprod = 1;
      for (let i = 3; i >= 0; i--) {
        scfSize[i] = ((sfc / modprod) | 0) % SCF_MOD[k + i];
        modprod *= SCF_MOD[k + i];
      }
    }
    part += k;
    scfsi = -16;
  }
  l3ReadScalefactors(iscf, istPos, scfSize, part, bs, scfsi);
  if (gr.nShortSfb) {
    const sh = 3 - scfShift;
    for (let i = 0; i < gr.nShortSfb; i += 3) {
      iscf[gr.nLongSfb + i] += gr.subblockGain[0] << sh;
      iscf[gr.nLongSfb + i + 1] += gr.subblockGain[1] << sh;
      iscf[gr.nLongSfb + i + 2] += gr.subblockGain[2] << sh;
    }
  } else if (preflag) {
    for (let i = 0; i < 10; i++) iscf[11 + i] += PREAMP[i];
  }
  const gainExp = gr.globalGain - 4 - 210 - (isMsStereo(h[3]) ? 2 : 0);
  const gain = ldexpQ2(1 << (MAX_SCFI / 4), MAX_SCFI - gainExp);
  for (let i = 0, n = gr.nLongSfb + gr.nShortSfb; i < n; i++) scf[i] = ldexpQ2(gain, iscf[i] << scfShift);
}

// ---- Layer III Huffman decoding ----

// x^(4/3) for x up to 8206 (15 + 13 bits of linbits), from the table by a
// second-order expansion.
function pow43(x: number): number {
  if (x < 129) return POW43[16 + x];
  let mult = 256;
  if (x < 1024) {
    mult = 16;
    x <<= 3;
  }
  const sign = (2 * x) & 64;
  const frac = ((x & 63) - sign) / ((x & ~63) + sign);
  return POW43[16 + ((x + sign) >> 6)] * (1 + frac * (4 / 3 + frac * (2 / 9))) * mult;
}

// Decodes one granule of one channel into dst[at..at + 576], dequantized,
// reading the main data from bs up to limit (a bit position). The bit cache
// is 32 bits, signed; `sh` counts how far it is from needing a refill.
function l3Huffman(dst: Float32Array, at: number, bs: Bits, gr: GrInfo, scf: Float32Array, limit: number) {
  const tabs = HUFF_TABS;
  const buf = bs.buf;
  const sfb = gr.sfbtab;
  let one = 0;
  let ireg = 0;
  let bigValCnt = gr.bigValues;
  let sfbi = 0;
  let scfi = 0;
  let next = bs.pos >> 3;
  let cache = ((buf[next] << 24) | (buf[next + 1] << 16) | (buf[next + 2] << 8) | buf[next + 3]) << (bs.pos & 7);
  let sh = (bs.pos & 7) - 8;
  let d = at;
  let np = 0;
  next += 4;

  while (bigValCnt > 0) {
    const tabNum = gr.tableSelect[ireg];
    let sfbCnt = gr.regionCount[ireg++];
    const cb = HUFF_TABINDEX[tabNum];
    const linbits = LINBITS[tabNum];
    do {
      np = sfb[sfbi++] >> 1;
      let pairs = Math.min(bigValCnt, np);
      one = scf[scfi++];
      do {
        let w = 5;
        let leaf = tabs[cb + (cache >>> 27)];
        while (leaf < 0) {
          cache <<= w;
          sh += w;
          w = leaf & 7;
          leaf = tabs[cb + (cache >>> (32 - w)) - (leaf >> 3)];
        }
        cache <<= leaf >> 8;
        sh += leaf >> 8;
        for (let j = 0; j < 2; j++, d++, leaf >>= 4) {
          const lsb = leaf & 15;
          if (lsb === 15 && linbits) {
            const v = lsb + (cache >>> (32 - linbits));
            cache <<= linbits;
            sh += linbits;
            while (sh >= 0) {
              cache |= buf[next++] << sh;
              sh -= 8;
            }
            dst[d] = cache < 0 ? -one * pow43(v) : one * pow43(v);
          } else {
            dst[d] = POW43[16 + lsb - 16 * (cache >>> 31)] * one;
          }
          if (lsb) {
            cache <<= 1;
            sh++;
          }
        }
        while (sh >= 0) {
          cache |= buf[next++] << sh;
          sh -= 8;
        }
      } while (--pairs > 0);
    } while ((bigValCnt -= np) > 0 && --sfbCnt >= 0);
  }

  const cb1 = gr.count1Table ? HUFF_TAB33 : HUFF_TAB32;
  for (np = 1 - bigValCnt; ; d += 4) {
    let leaf = cb1[cache >>> 28];
    if (!(leaf & 8)) leaf = cb1[(leaf >> 3) + ((cache << 4) >>> (32 - (leaf & 3)))];
    cache <<= leaf & 7;
    sh += leaf & 7;
    if (next * 8 - 24 + sh > limit) break;
    if (!--np) {
      np = sfb[sfbi++] >> 1;
      if (!np) break;
      one = scf[scfi++];
    }
    if (leaf & 128) {
      dst[d] = cache < 0 ? -one : one;
      cache <<= 1;
      sh++;
    }
    if (leaf & 64) {
      dst[d + 1] = cache < 0 ? -one : one;
      cache <<= 1;
      sh++;
    }
    if (!--np) {
      np = sfb[sfbi++] >> 1;
      if (!np) break;
      one = scf[scfi++];
    }
    if (leaf & 32) {
      dst[d + 2] = cache < 0 ? -one : one;
      cache <<= 1;
      sh++;
    }
    if (leaf & 16) {
      dst[d + 3] = cache < 0 ? -one : one;
      cache <<= 1;
      sh++;
    }
    while (sh >= 0) {
      cache |= buf[next++] << sh;
      sh -= 8;
    }
  }
  bs.pos = limit;
}

// ---- Layer III stereo ----

function l3MidsideStereo(g: Float32Array, left: number, n: number) {
  for (let i = left, end = left + n; i < end; i++) {
    const a = g[i];
    const b = g[i + 576];
    g[i] = a + b;
    g[i + 576] = a - b;
  }
}

function l3IntensityStereoBand(g: Float32Array, left: number, n: number, kl: number, kr: number) {
  for (let i = left, end = left + n; i < end; i++) {
    g[i + 576] = g[i] * kr;
    g[i] *= kl;
  }
}

// The last band of each window (one for long blocks) where the right
// channel has anything; intensity stereo applies above it.
function l3StereoTopBand(g: Float32Array, right: number, sfb: Uint8Array, nbands: number, maxBand: Int32Array) {
  maxBand[0] = maxBand[1] = maxBand[2] = -1;
  for (let i = 0; i < nbands; i++) {
    for (let k = 0; k < sfb[i]; k += 2) {
      if (g[right + k] !== 0 || g[right + k + 1] !== 0) {
        maxBand[i % 3] = i;
        break;
      }
    }
    right += sfb[i];
  }
}

const PAN = new Float32Array([0, 1, 0.21132487, 0.78867513, 0.3660254, 0.6339746, 0.5, 0.5, 0.6339746, 0.3660254, 0.78867513, 0.21132487, 1, 0]);

function l3StereoProcess(g: Float32Array, istPos: Uint8Array, sfb: Uint8Array, h: Uint8Array, maxBand: Int32Array, mpeg2Sh: number) {
  const mpeg1 = isMpeg1(h[1]);
  const ms = testMsStereo(h[3]);
  const maxPos = mpeg1 ? 7 : 64;
  let left = 0;
  for (let i = 0; sfb[i]; i++) {
    const ipos = istPos[i];
    if (i > maxBand[i % 3] && ipos < maxPos) {
      let kl: number;
      let kr: number;
      const s = ms ? 1.41421356 : 1;
      if (mpeg1) {
        kl = PAN[2 * ipos];
        kr = PAN[2 * ipos + 1];
      } else {
        kl = 1;
        kr = ldexpQ2(1, ((ipos + 1) >> 1) << mpeg2Sh);
        if (ipos & 1) {
          kl = kr;
          kr = 1;
        }
      }
      l3IntensityStereoBand(g, left, sfb[i], Math.fround(kl * s), Math.fround(kr * s));
    } else if (ms) {
      l3MidsideStereo(g, left, sfb[i]);
    }
    left += sfb[i];
  }
}

function l3IntensityStereo(g: Float32Array, istPos: Uint8Array, gr0: GrInfo, gr1: GrInfo, h: Uint8Array, maxBand: Int32Array) {
  const nSfb = gr0.nLongSfb + gr0.nShortSfb;
  const maxBlocks = gr0.nShortSfb ? 3 : 1;
  l3StereoTopBand(g, 576, gr0.sfbtab, nSfb, maxBand);
  if (gr0.nLongSfb) maxBand[0] = maxBand[1] = maxBand[2] = Math.max(maxBand[0], maxBand[1], maxBand[2]);
  for (let i = 0; i < maxBlocks; i++) {
    const defaultPos = isMpeg1(h[1]) ? 3 : 0;
    const itop = nSfb - maxBlocks + i;
    const prev = itop - maxBlocks;
    istPos[itop] = maxBand[i] >= prev ? defaultPos : istPos[prev];
  }
  l3StereoProcess(g, istPos, gr0.sfbtab, h, maxBand, gr1.scalefacCompress & 1);
}

// ---- Layer III reordering, antialiasing and IMDCT ----

// Short blocks come window by window within each band; the IMDCT wants
// them interleaved.
function l3Reorder(g: Float32Array, at: number, scratch: Float32Array, sfb: Uint8Array, sfbAt: number) {
  let src = at;
  let dst = 0;
  for (let len; (len = sfb[sfbAt]) !== 0; sfbAt += 3, src += 2 * len) {
    for (let i = 0; i < len; i++, src++) {
      scratch[dst++] = g[src];
      scratch[dst++] = g[src + len];
      scratch[dst++] = g[src + 2 * len];
    }
  }
  g.set(scratch.subarray(0, dst), at);
}

const AA0 = new Float32Array([0.85749293, 0.881742, 0.94962865, 0.98331459, 0.99551782, 0.99916056, 0.9998992, 0.99999316]);
const AA1 = new Float32Array([0.51449576, 0.47173197, 0.31337745, 0.1819132, 0.09457419, 0.04096558, 0.01419856, 0.00369997]);

function l3Antialias(g: Float32Array, at: number, nbands: number) {
  for (; nbands > 0; nbands--, at += 18) {
    for (let i = 0; i < 8; i++) {
      const u = g[at + 18 + i];
      const d = g[at + 17 - i];
      g[at + 18 + i] = u * AA0[i] - d * AA1[i];
      g[at + 17 - i] = u * AA1[i] + d * AA0[i];
    }
  }
}

// The 9-point DCT-III of y[0..8] in place.
function l3Dct3x9(y: Float64Array) {
  let s0 = y[0];
  let s2 = y[2];
  let s4 = y[4];
  let s6 = y[6];
  let s8 = y[8];
  let t0 = s0 + s6 * 0.5;
  s0 -= s6;
  let t4 = (s4 + s2) * 0.93969262;
  let t2 = (s8 + s2) * 0.76604444;
  s6 = (s4 - s8) * 0.17364818;
  s4 += s8 - s2;

  s2 = s0 - s4 * 0.5;
  y[4] = s4 + s0;
  s8 = t0 - t2 + s6;
  s0 = t0 - t4 + t2;
  s4 = t0 + t4 - s6;

  let s1 = y[1];
  let s3 = y[3];
  let s5 = y[5];
  let s7 = y[7];

  s3 *= 0.8660254;
  t0 = (s5 + s1) * 0.98480775;
  t4 = (s5 - s7) * 0.34202014;
  t2 = (s1 + s7) * 0.64278761;
  s1 = (s1 - s5 - s7) * 0.8660254;

  s5 = t0 - s3 - t2;
  s7 = t4 - s3 - t0;
  s3 = t4 + s3 - t2;

  y[0] = s4 - s7;
  y[1] = s2 + s1;
  y[2] = s0 - s3;
  y[3] = s8 + s5;
  y[5] = s8 - s5;
  y[6] = s0 + s3;
  y[7] = s2 - s1;
  y[8] = s4 + s7;
}

const TWID9 = new Float32Array([
  0.73727734, 0.79335334, 0.84339145, 0.88701083, 0.92387953, 0.95371695, 0.97629601, 0.99144486, 0.99904822, 0.67559021, 0.60876143, 0.53729961, 0.46174861,
  0.38268343, 0.3007058, 0.21643961, 0.13052619, 0.04361938
]);

// One subband's 36-point IMDCT, overlapped with the previous granule's
// tail. `prev` weights that tail (by the previous block's window, see
// MDCT_WINDOW) and `cur` this block's head; minimp3 used one window for
// both, which is the same for the block sequences encoders normally write.
function l3Imdct36(g: Float32Array, at: number, overlap: Float32Array, ov: number, prev: Float32Array, cur: Float32Array, co: Float64Array, si: Float64Array) {
  {
    co[0] = -g[at];
    si[0] = g[at + 17];
    for (let i = 0; i < 4; i++) {
      si[8 - 2 * i] = g[at + 4 * i + 1] - g[at + 4 * i + 2];
      co[1 + 2 * i] = g[at + 4 * i + 1] + g[at + 4 * i + 2];
      si[7 - 2 * i] = g[at + 4 * i + 4] - g[at + 4 * i + 3];
      co[2 + 2 * i] = -(g[at + 4 * i + 3] + g[at + 4 * i + 4]);
    }
    l3Dct3x9(co);
    l3Dct3x9(si);
    si[1] = -si[1];
    si[3] = -si[3];
    si[5] = -si[5];
    si[7] = -si[7];
    for (let i = 0; i < 9; i++) {
      const ovl = overlap[ov + i];
      const sum = co[i] * TWID9[9 + i] + si[i] * TWID9[i];
      overlap[ov + i] = co[i] * TWID9[i] - si[i] * TWID9[9 + i];
      g[at + i] = ovl * prev[i] - sum * cur[9 + i];
      g[at + 17 - i] = ovl * prev[9 + i] + sum * cur[i];
    }
  }
}

const TWID3 = new Float32Array([0.79335334, 0.92387953, 0.99144486, 0.60876143, 0.38268343, 0.13052619]);

// One 12-point IMDCT of x[0, 3, .. 15] (one window of a short block) into
// dst[0..5], overlapping with overlap[0..2].
function l3Imdct12(x: Float32Array, xo: number, dst: Float32Array, d: number, overlap: Float32Array, ov: number) {
  idct3(-x[xo], x[xo + 6] + x[xo + 3], x[xo + 12] + x[xo + 9], 0);
  idct3(x[xo + 15], x[xo + 12] - x[xo + 9], x[xo + 6] - x[xo + 3], 3);
  i3[4] = -i3[4];
  for (let i = 0; i < 3; i++) {
    const ovl = overlap[ov + i];
    const sum = i3[i] * TWID3[3 + i] + i3[3 + i] * TWID3[i];
    overlap[ov + i] = i3[i] * TWID3[i] - i3[3 + i] * TWID3[3 + i];
    dst[d + i] = ovl * TWID3[2 - i] - sum * TWID3[5 - i];
    dst[d + 5 - i] = ovl * TWID3[5 - i] + sum * TWID3[2 - i];
  }
}
const i3 = new Float64Array(6); // co[0..2], si[0..2] of l3Imdct12

function idct3(x0: number, x1: number, x2: number, out: number) {
  const m1 = x1 * 0.8660254;
  const a1 = x0 - x2 * 0.5;
  i3[out + 1] = x0 + x2;
  i3[out] = a1 + m1;
  i3[out + 2] = a1 - m1;
}

// One subband's three 12-point IMDCTs. They take the previous tail as a
// start block (or short block) leaves it.
function l3ImdctShort(g: Float32Array, at: number, overlap: Float32Array, ov: number, tmp: Float32Array) {
  {
    tmp.set(g.subarray(at, at + 18));
    g.set(overlap.subarray(ov, ov + 6), at);
    l3Imdct12(tmp, 0, g, at + 6, overlap, ov + 6);
    l3Imdct12(tmp, 1, g, at + 12, overlap, ov + 6);
    l3Imdct12(tmp, 2, overlap, ov, overlap, ov + 6);
  }
}

// Every odd sample of every odd subband changes sign (the frequency
// inversion of the polyphase filterbank).
function l3ChangeSign(g: Float32Array, at: number) {
  at += 18;
  for (let b = 0; b < 32; b += 2, at += 36) for (let i = 1; i < 18; i += 2) g[at + i] = -g[at + i];
}

// [0..8] weigh the previous granule's tail where it meets this one's
// samples 0..8, [9..17] the same tail at 17..9 and this granule's head at
// 0..8 (and [0..8] its head at 17..9): row 0 for the normal (sine) shape,
// row 1 for the short-window shape a start or short block leaves and a stop
// block begins with.
const MDCT_WINDOW = [
  new Float32Array([
    0.99904822, 0.99144486, 0.97629601, 0.95371695, 0.92387953, 0.88701083, 0.84339145, 0.79335334, 0.73727734, 0.04361938, 0.13052619, 0.21643961, 0.3007058,
    0.38268343, 0.46174861, 0.53729961, 0.60876143, 0.67559021
  ]),
  new Float32Array([1, 1, 1, 1, 1, 1, 0.99144486, 0.92387953, 0.79335334, 0, 0, 0, 0, 0, 0, 0.13052619, 0.38268343, 0.60876143])
];

// ---- Synthesis ----

const SEC = new Float32Array([
  10.19000816, 0.50060302, 0.50241929, 3.40760851, 0.50547093, 0.52249861, 2.05778098, 0.51544732, 0.56694406, 1.4841646, 0.53104258, 0.6468218, 1.16943991,
  0.55310392, 0.7881546, 0.97256821, 0.58293498, 1.06067765, 0.83934963, 0.62250412, 1.72244716, 0.74453628, 0.67480832, 5.10114861
]);

// The 32-point DCT-II across the subbands of each of n time slots, in
// place (subband s, slot k at g[at + s x 18 + k]).
function dct2(g: Float32Array, at: number, n: number, t: Float64Array) {
  for (let k = 0; k < n; k++) {
    let y = at + k;
    for (let i = 0; i < 8; i++) {
      const x0 = g[y + i * 18];
      const x1 = g[y + (15 - i) * 18];
      const x2 = g[y + (16 + i) * 18];
      const x3 = g[y + (31 - i) * 18];
      const t0 = x0 + x3;
      const t1 = x1 + x2;
      const t2 = (x1 - x2) * SEC[3 * i];
      const t3 = (x0 - x3) * SEC[3 * i + 1];
      t[i] = t0 + t1;
      t[8 + i] = (t0 - t1) * SEC[3 * i + 2];
      t[16 + i] = t3 + t2;
      t[24 + i] = (t3 - t2) * SEC[3 * i + 2];
    }
    for (let x = 0; x < 32; x += 8) {
      let x0 = t[x];
      let x1 = t[x + 1];
      let x2 = t[x + 2];
      let x3 = t[x + 3];
      let x4 = t[x + 4];
      let x5 = t[x + 5];
      let x6 = t[x + 6];
      let x7 = t[x + 7];
      let xt = x0 - x7;
      x0 += x7;
      x7 = x1 - x6;
      x1 += x6;
      x6 = x2 - x5;
      x2 += x5;
      x5 = x3 - x4;
      x3 += x4;
      x4 = x0 - x3;
      x0 += x3;
      x3 = x1 - x2;
      x1 += x2;
      t[x] = x0 + x1;
      t[x + 4] = (x0 - x1) * 0.70710677;
      x5 = x5 + x6;
      x6 = (x6 + x7) * 0.70710677;
      x7 = x7 + xt;
      x3 = (x3 + x4) * 0.70710677;
      x5 -= x7 * 0.198912367; // rotate by PI/8
      x7 += x5 * 0.382683432;
      x5 -= x7 * 0.198912367;
      x0 = xt - x6;
      xt += x6;
      t[x + 1] = (xt + x7) * 0.50979561;
      t[x + 2] = (x4 + x3) * 0.54119611;
      t[x + 3] = (x0 - x5) * 0.60134488;
      t[x + 5] = (x0 + x5) * 0.89997619;
      t[x + 6] = (x4 - x3) * 1.30656302;
      t[x + 7] = (xt - x7) * 2.56291556;
    }
    for (let i = 0; i < 7; i++, y += 4 * 18) {
      g[y] = t[i];
      g[y + 18] = t[16 + i] + t[24 + i] + t[24 + i + 1];
      g[y + 2 * 18] = t[8 + i] + t[8 + i + 1];
      g[y + 3 * 18] = t[16 + i + 1] + t[24 + i] + t[24 + i + 1];
    }
    g[y] = t[7];
    g[y + 18] = t[16 + 7] + t[24 + 7];
    g[y + 2 * 18] = t[8 + 7];
    g[y + 3 * 18] = t[24 + 7];
  }
}

const SCALE = 1 / 32768;
const clamp = (v: number) => (v > 1 ? 1 : v < -1 ? -1 : v);

// Output samples 0 and 16 of a 32-sample block from z (lins, at z), the
// ones mp3d_synth's main loop leaves out.
function synthPair(out: Float32Array, o: number, z: Float32Array, at: number) {
  let a = (z[at + 14 * 64] - z[at]) * 29;
  a += (z[at + 64] + z[at + 13 * 64]) * 213;
  a += (z[at + 12 * 64] - z[at + 2 * 64]) * 459;
  a += (z[at + 3 * 64] + z[at + 11 * 64]) * 2037;
  a += (z[at + 10 * 64] - z[at + 4 * 64]) * 5153;
  a += (z[at + 5 * 64] + z[at + 9 * 64]) * 6574;
  a += (z[at + 8 * 64] - z[at + 6 * 64]) * 37489;
  a += z[at + 7 * 64] * 75038;
  out[o] = clamp(a * SCALE);
  at += 2;
  a = z[at + 14 * 64] * 104;
  a += z[at + 12 * 64] * 1567;
  a += z[at + 10 * 64] * 9727;
  a += z[at + 8 * 64] * 64019;
  a += z[at + 6 * 64] * -9975;
  a += z[at + 4 * 64] * -45;
  a += z[at + 2 * 64] * 146;
  a += z[at] * -5;
  out[o + 16] = clamp(a * SCALE);
}

// Two time slots (64 samples a channel) of the polyphase synthesis, for
// both channels at once: lins holds four lanes (left and right of the two
// slots), z = lins + lo + 15 x 64 the newest. Writes outL/outR[o..o + 63].
function synth(g: Float32Array, xl: number, xr: number, outL: Float32Array, outR: Float32Array, o: number, stereo: boolean, lins: Float32Array, lo: number) {
  const z = lo + 15 * 64;
  lins[z + 4 * 15] = g[xl + 18 * 16];
  lins[z + 4 * 15 + 1] = g[xr + 18 * 16];
  lins[z + 4 * 15 + 2] = g[xl];
  lins[z + 4 * 15 + 3] = g[xr];
  lins[z + 4 * 31] = g[xl + 1 + 18 * 16];
  lins[z + 4 * 31 + 1] = g[xr + 1 + 18 * 16];
  lins[z + 4 * 31 + 2] = g[xl + 1];
  lins[z + 4 * 31 + 3] = g[xr + 1];
  if (stereo) {
    synthPair(outR, o, lins, lo + 4 * 15 + 1);
    synthPair(outR, o + 32, lins, lo + 4 * 15 + 64 + 1);
  }
  synthPair(outL, o, lins, lo + 4 * 15);
  synthPair(outL, o + 32, lins, lo + 4 * 15 + 64);
  const w = SYNTH_WIN;
  for (let i = 14, wi = 0; i >= 0; i--) {
    const q = z + 4 * i;
    lins[q] = g[xl + 18 * (31 - i)];
    lins[q + 1] = g[xr + 18 * (31 - i)];
    lins[q + 2] = g[xl + 1 + 18 * (31 - i)];
    lins[q + 3] = g[xr + 1 + 18 * (31 - i)];
    lins[z + 4 * (i + 16)] = g[xl + 1 + 18 * (1 + i)];
    lins[z + 4 * (i + 16) + 1] = g[xr + 1 + 18 * (1 + i)];
    lins[z + 4 * (i - 16) + 2] = g[xl + 18 * (1 + i)];
    lins[z + 4 * (i - 16) + 3] = g[xr + 18 * (1 + i)];
    let a0 = 0;
    let a1 = 0;
    let a2 = 0;
    let a3 = 0;
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    let b3 = 0;
    // minimp3's S0(0) S2(1) S1(2) S2(3) S1(4) S2(5) S1(6) S2(7): k even adds
    // vz x w0 - vy x w1 to a, k odd adds vy x w1 - vz x w0; b always adds
    // vz x w1 + vy x w0. S0 starts from zero, which the zeros above give.
    for (let k = 0; k < 8; k++) {
      const w0 = w[wi++];
      const w1 = w[wi++];
      const vz = q - k * 64;
      const vy = q - (15 - k) * 64;
      const z0 = lins[vz];
      const z1 = lins[vz + 1];
      const z2 = lins[vz + 2];
      const z3 = lins[vz + 3];
      const y0 = lins[vy];
      const y1 = lins[vy + 1];
      const y2 = lins[vy + 2];
      const y3 = lins[vy + 3];
      b0 += z0 * w1 + y0 * w0;
      b1 += z1 * w1 + y1 * w0;
      b2 += z2 * w1 + y2 * w0;
      b3 += z3 * w1 + y3 * w0;
      if (k & 1) {
        a0 += y0 * w1 - z0 * w0;
        a1 += y1 * w1 - z1 * w0;
        a2 += y2 * w1 - z2 * w0;
        a3 += y3 * w1 - z3 * w0;
      } else {
        a0 += z0 * w0 - y0 * w1;
        a1 += z1 * w0 - y1 * w1;
        a2 += z2 * w0 - y2 * w1;
        a3 += z3 * w0 - y3 * w1;
      }
    }
    if (stereo) {
      outR[o + 15 - i] = clamp(a1 * SCALE);
      outR[o + 17 + i] = clamp(b1 * SCALE);
      outR[o + 47 - i] = clamp(a3 * SCALE);
      outR[o + 49 + i] = clamp(b3 * SCALE);
    }
    outL[o + 15 - i] = clamp(a0 * SCALE);
    outL[o + 17 + i] = clamp(b0 * SCALE);
    outL[o + 47 - i] = clamp(a2 * SCALE);
    outL[o + 49 + i] = clamp(b2 * SCALE);
  }
}

// Synthesizes nbands time slots (12 or 18) of grbuf into pcm from sample o.
function synthGranule(qmf: Float32Array, g: Float32Array, nbands: number, nch: number, pcm: Float32Array[], o: number, t: Scratch) {
  for (let i = 0; i < nch; i++) dct2(g, 576 * i, nbands, t.dct);
  const lins = t.lins;
  lins.set(qmf);
  const xr = 576 * (nch - 1);
  for (let i = 0; i < nbands; i += 2) synth(g, i, xr + i, pcm[0], pcm[nch - 1], o + 32 * i, nch === 2, lins, i * 64);
  // For mono minimp3 keeps only the left lanes; the right ones are unused.
  qmf.set(lins.subarray(nbands * 64, nbands * 64 + 15 * 64));
}

// ---- The decoder ----

interface Scratch {
  maindata: Uint8Array;
  grbuf: Float32Array;
  scf: Float32Array;
  iscf: Uint8Array;
  scfSize: Uint8Array;
  istPos: Uint8Array[];
  maxBand: Int32Array;
  lins: Float32Array;
  reorder: Float32Array;
  tmp18: Float32Array;
  tail18: Float64Array;
  co: Float64Array;
  si: Float64Array;
  dct: Float64Array;
}

// Room past the main data for the Huffman decoder's reads on damaged
// granules: 288 pairs of at most 19 + 2 x 14 bits each.
const MAINDATA_SLACK = 2048;

class Decoder {
  overlap = new Float32Array(2 * 9 * 32);
  qmf = new Float32Array(15 * 2 * 32);
  reserv = 0;
  freeFormatBytes = 0;
  header = new Uint8Array(4);
  reservBuf = new Uint8Array(MAX_BITRESERVOIR_BYTES);
  grInfo = [newGrInfo(), newGrInfo(), newGrInfo(), newGrInfo()];
  sci: L12Info = { scf: new Float32Array(3 * 64), totalBands: 0, stereoBands: 0, bitalloc: new Uint8Array(64), scfcod: new Uint8Array(64) };
  t: Scratch = {
    maindata: new Uint8Array(MAX_BITRESERVOIR_BYTES + MAX_L3_FRAME_PAYLOAD_BYTES + MAINDATA_SLACK),
    grbuf: new Float32Array(2 * 576),
    scf: new Float32Array(40),
    iscf: new Uint8Array(40),
    scfSize: new Uint8Array(4),
    istPos: [new Uint8Array(39), new Uint8Array(39)],
    maxBand: new Int32Array(3),
    lins: new Float32Array((18 + 15) * 64),
    reorder: new Float32Array(576),
    tmp18: new Float32Array(18),
    tail18: new Float64Array(18),
    co: new Float64Array(9),
    si: new Float64Array(9),
    dct: new Float64Array(32)
  };
  // Per channel and subband, 1 when the previous granule's window ended in
  // the short shape (a start block, or short blocks).
  shortTail = new Uint8Array(2 * 32);
  frameBits = new Bits();
  mainBits = new Bits();
  pcm = [new Float32Array(1152), new Float32Array(1152)];
  partial = new Uint8Array(MAX_FREE_FORMAT_FRAME_SIZE + 16); // a cut-off last frame, zero-filled
  // Of the last decodeFrame call:
  consumed = 0; // bytes, junk included
  channels = 0;
  hz = 0;
  layer = 0;
  kbps = 0;

  reset() {
    this.overlap.fill(0);
    this.qmf.fill(0);
    this.shortTail.fill(0);
    this.reserv = 0;
    this.freeFormatBytes = 0;
    this.header.fill(0);
    this.reservBuf.fill(0);
  }

  // Decodes the frame at d[pos], or the first one after junk, into pcm;
  // returns its samples per channel (0: none) and sets `consumed`.
  decodeFrame(d: Uint8Array, pos: number, end: number): number {
    const n = end - pos;
    const h = this.header;
    let i = 0;
    let frameSize = 0;
    let lastFrame = 0; // a frame that follows the previous one but not by a next header
    if (n > HDR_SIZE && h[0] === 0xff && hdrCompare(h, 0, d, pos)) {
      frameSize = hdrFrameBytes(d, pos, this.freeFormatBytes) + hdrPadding(d, pos);
      if (frameSize !== n && (frameSize + HDR_SIZE > n || !hdrCompare(d, pos, d, pos + frameSize))) {
        if (frameSize > HDR_SIZE) lastFrame = frameSize;
        frameSize = 0;
      }
    }
    if (!frameSize) {
      const found = findFrame(d, pos, end);
      if (found.frameBytes) {
        this.reset();
        this.freeFormatBytes = found.freeFormatBytes;
        i = found.offset;
        frameSize = found.frameBytes;
      } else if (lastFrame) {
        // Nothing decodable follows: this is the last frame, maybe cut off
        // or followed by junk. ffmpeg decodes it; so do we.
        frameSize = lastFrame;
      } else {
        this.consumed = n;
        return 0;
      }
    }
    let src = d;
    let hdr = pos + i;
    this.consumed = i + frameSize;
    if (hdr + frameSize > end) {
      this.partial.fill(0);
      this.partial.set(d.subarray(hdr, end));
      src = this.partial;
      hdr = 0;
      this.consumed = n;
    }
    h.set(src.subarray(hdr, hdr + HDR_SIZE));
    const nch = isMono(h[3]) ? 1 : 2;
    this.channels = nch;
    this.hz = hdrSampleRate(h, 0);
    this.layer = 4 - layerBits(h[1]);
    // Free format: by the frame's size less its padding slot, so that CBR
    // reads as one rate.
    this.kbps = hdrBitrateKbps(h, 0) || ((frameSize - hdrPadding(h, 0)) * 8 * this.hz) / hdrFrameSamples(h, 0) / 1000;

    const bs = this.frameBits;
    bs.init(src, hdr + HDR_SIZE, frameSize - HDR_SIZE);
    if (isCrc(h[1])) bs.get(16);
    const t = this.t;
    const grbuf = t.grbuf;
    if (this.layer === 3) {
      const grs = this.grInfo;
      const mainDataBegin = l3ReadSideInfo(bs, grs, h);
      if (mainDataBegin < 0 || bs.pos > bs.limit) {
        h[0] = 0;
        return 0;
      }
      const ngr = isMpeg1(h[1]) ? 2 : 1;
      const mbs = this.mainBits;
      const firstGr = this.restoreReservoir(bs, mbs, mainDataBegin, ngr, nch);
      for (let igr = 0; igr < ngr; igr++) {
        grbuf.fill(0);
        this.l3Decode(grs, igr * nch, nch, igr >= firstGr);
        synthGranule(this.qmf, grbuf, 18, nch, this.pcm, igr * 576, t);
      }
      this.saveReservoir(mbs);
    } else {
      const sci = this.sci;
      l12ReadScaleInfo(h, bs, sci);
      grbuf.fill(0);
      for (let at = 0, igr = 0, o = 0; igr < 3; igr++) {
        if (12 === (at += l12DequantizeGranule(grbuf, at, bs, sci, this.layer | 1))) {
          at = 0;
          l12ApplyScf384(sci, igr, grbuf);
          synthGranule(this.qmf, grbuf, 12, nch, this.pcm, o, t);
          grbuf.fill(0);
          o += 384;
        }
        if (bs.pos > bs.limit) {
          h[0] = 0;
          return 0;
        }
      }
    }
    return hdrFrameSamples(h, 0);
  }

  // Puts the frame's main data (main_data_begin bytes back into the
  // reservoir, then this frame's) in maindata and returns the first granule
  // whose data we have: granules starting before the reservoir we hold are
  // silent, as in ffmpeg.
  restoreReservoir(bs: Bits, mbs: Bits, mainDataBegin: number, ngr: number, nch: number): number {
    const md = this.t.maindata;
    const frameBytes = (bs.limit - bs.pos) >> 3;
    const have = Math.min(this.reserv, mainDataBegin);
    md.set(this.reservBuf.subarray(this.reserv - have, this.reserv), 0);
    md.set(bs.buf.subarray(bs.pos >> 3, (bs.pos >> 3) + frameBytes), have);
    mbs.init(md, 0, have + frameBytes);
    if (this.reserv >= mainDataBegin) return 0;
    let first = 0;
    let bits = this.reserv * 8;
    while (first < ngr && bits >> 3 < mainDataBegin) {
      for (let ch = 0; ch < nch; ch++) bits += this.grInfo[first * nch + ch].part23Length;
      first++;
    }
    mbs.pos = Math.max(0, bits - mainDataBegin * 8);
    return first;
  }

  saveReservoir(mbs: Bits) {
    let pos = (mbs.pos + 7) >> 3;
    let remains = (mbs.limit >> 3) - pos;
    if (remains > MAX_BITRESERVOIR_BYTES) {
      pos += remains - MAX_BITRESERVOIR_BYTES;
      remains = MAX_BITRESERVOIR_BYTES;
    }
    if (remains > 0) this.reservBuf.set(this.t.maindata.subarray(pos, pos + remains));
    this.reserv = Math.max(0, remains);
  }

  // One granule of every channel, from grs[at]: scale factors and Huffman
  // (unless the granule's data is missing), stereo, then reorder,
  // antialias, IMDCT.
  l3Decode(grs: GrInfo[], at: number, nch: number, haveData: boolean) {
    const h = this.header;
    const t = this.t;
    const g = t.grbuf;
    const mbs = this.mainBits;
    if (haveData) {
      for (let ch = 0; ch < nch; ch++) {
        const gr = grs[at + ch];
        const limit = mbs.pos + gr.part23Length;
        l3DecodeScalefactors(h, t.istPos[ch], mbs, gr, t.scf, ch, t);
        l3Huffman(g, 576 * ch, mbs, gr, t.scf, limit);
      }
      // Joint stereo only, as in ffmpeg (minimp3 went by the mode
      // extension bits alone, which other modes should leave 0).
      if (isJointStereo(h[3]) && isIStereo(h[3])) l3IntensityStereo(g, t.istPos[1], grs[at], grs[at + 1], h, t.maxBand);
      else if (isMsStereo(h[3])) l3MidsideStereo(g, 0, 576);
    }
    for (let ch = 0; ch < nch; ch++) {
      const gr = grs[at + ch];
      const o = 576 * ch;
      let aaBands = 31;
      const nLongBands = (gr.mixedBlockFlag ? 2 : 0) << (myRateIndex(h[1], h[2]) === 2 ? 1 : 0);
      if (gr.nShortSfb) {
        aaBands = nLongBands - 1;
        l3Reorder(g, o + nLongBands * 18, t.reorder, gr.sfbtab, gr.nLongSfb);
      }
      l3Antialias(g, o, aaBands);
      // IMDCT: the long bands of a mixed block with the normal window, then
      // short or long windows for the rest. Each tail is weighted by the
      // window it came from: a mixed block, or a stream that switches
      // windows without start and stop blocks, joins tails and heads of
      // different shapes, which minimp3 did not follow (ffmpeg does).
      const overlap = this.overlap;
      const tails = this.shortTail;
      const short = gr.blockType === SHORT_BLOCK_TYPE;
      const cur = MDCT_WINDOW[gr.blockType === STOP_BLOCK_TYPE ? 1 : 0];
      for (let sb = 0, at = o, ov = 9 * 32 * ch, tl = 32 * ch; sb < 32; sb++, at += 18, ov += 9, tl++) {
        if (sb >= nLongBands && short) {
          if (tails[tl]) l3ImdctShort(g, at, overlap, ov, t.tmp18);
          else {
            // A normal tail under short windows: add it by its own window.
            const w = MDCT_WINDOW[0];
            const tail = t.tail18;
            for (let i = 0; i < 9; i++) {
              tail[i] = overlap[ov + i] * w[i];
              tail[17 - i] = overlap[ov + i] * w[9 + i];
              overlap[ov + i] = 0;
            }
            l3ImdctShort(g, at, overlap, ov, t.tmp18);
            for (let i = 0; i < 18; i++) g[at + i] += tail[i];
          }
          tails[tl] = 1;
        } else {
          l3Imdct36(g, at, overlap, ov, MDCT_WINDOW[tails[tl]], sb < nLongBands ? MDCT_WINDOW[0] : cur, t.co, t.si);
          tails[tl] = sb >= nLongBands && gr.blockType === 1 ? 1 : 0;
        }
      }
      l3ChangeSign(g, o);
    }
  }
}

interface Found {
  offset: number; // from pos; the bytes left when nothing was found
  frameBytes: number; // with padding; 0: nothing found
  freeFormatBytes: number;
}

// Whether up to MAX_FRAME_SYNC_MATCHES frames follow the one at d[o] (at
// least one, or the data ends).
function matchFrame(d: Uint8Array, o: number, bytes: number, frameBytes: number): boolean {
  for (let i = 0, nmatch = 0; nmatch < MAX_FRAME_SYNC_MATCHES; nmatch++) {
    i += hdrFrameBytes(d, o + i, frameBytes) + hdrPadding(d, o + i);
    if (i + HDR_SIZE > bytes) return nmatch > 0;
    if (!hdrCompare(d, o, d, o + i)) return false;
  }
  return true;
}

// The first frame in d[pos..end] that the next frames confirm (or that
// fills it exactly). Free-format frames are measured by the distance to the
// next matching header.
function findFrame(d: Uint8Array, pos: number, end: number): Found {
  const n = end - pos;
  let freeFormatBytes = 0;
  for (let i = 0; i < n - HDR_SIZE; i++) {
    const p = pos + i;
    if (!hdrValid(d, p)) continue;
    let frameBytes = hdrFrameBytes(d, p, freeFormatBytes);
    let frameAndPadding = frameBytes + hdrPadding(d, p);
    for (let k = HDR_SIZE; !frameBytes && k < MAX_FREE_FORMAT_FRAME_SIZE && i + 2 * k < n - HDR_SIZE; k++) {
      if (hdrCompare(d, p, d, p + k)) {
        const fb = k - hdrPadding(d, p);
        const nextfb = fb + hdrPadding(d, p + k);
        if (i + k + nextfb + HDR_SIZE > n || !hdrCompare(d, p, d, p + k + nextfb)) continue;
        frameAndPadding = k;
        frameBytes = fb;
        freeFormatBytes = fb;
      }
    }
    if ((frameBytes && i + frameAndPadding <= n && matchFrame(d, p, n - i, frameBytes)) || (!i && frameAndPadding === n)) {
      return { offset: i, frameBytes: frameAndPadding, freeFormatBytes };
    }
    freeFormatBytes = 0;
  }
  return { offset: n, frameBytes: 0, freeFormatBytes: 0 };
}

// ---- Tags ----

// ffmpeg's ff_id3v2_match.
const isId3v2 = (d: Uint8Array, o: number) =>
  o + 10 <= d.length &&
  d[o] === 0x49 &&
  d[o + 1] === 0x44 &&
  d[o + 2] === 0x33 &&
  d[o + 3] !== 0xff &&
  d[o + 4] !== 0xff &&
  !((d[o + 6] | d[o + 7] | d[o + 8] | d[o + 9]) & 0x80);

// The tag's size with its header, and its footer (ID3v2.4 only, as ffmpeg).
const id3v2Size = (d: Uint8Array, o: number) =>
  10 + ((d[o + 6] << 21) | (d[o + 7] << 14) | (d[o + 8] << 7) | d[o + 9]) + (d[o + 3] === 4 && d[o + 5] & 0x10 ? 10 : 0);

const ascii = (d: Uint8Array, o: number, s: string) => {
  for (let i = 0; i < s.length; i++) if (d[o + i] !== s.charCodeAt(i)) return false;
  return true;
};
const le32 = (d: Uint8Array, o: number) => (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;
// Big-endian, reading zeros past the end (as ffmpeg's avio does).
const be = (d: Uint8Array, o: number, n: number) => {
  let v = 0;
  for (let i = 0; i < n; i++) v = v * 256 + (o + i < d.length ? d[o + i] : 0);
  return v;
};

// The end of the audio before an ID3v1 tag (and its extended TAG+ block)
// and an APEv2 tag, as minimp3_ex.h strips them.
function audioEnd(d: Uint8Array, start: number): number {
  let end = d.length;
  if (end - start >= 128 && ascii(d, end - 128, "TAG")) {
    end -= 128;
    if (end - start >= 227 && ascii(d, end - 227, "TAG+")) end -= 227;
  }
  if (end - start > 32 && ascii(d, end - 32, "APETAGEX")) {
    const size = le32(d, end - 32 + 12); // items and footer
    const header = d[end - 32 + 23] & 0x80 ? 32 : 0;
    if (end - start >= size + header) end -= size + header;
  }
  return end;
}

interface Gapless {
  skipFrame: number; // bytes of a tag frame to skip, not decode
  vbr: boolean; // a Xing or VBRI tag
  startSkip: number; // samples dropped at the start
  discardFrom: number; // samples dropped in [discardFrom, discardTo)
  discardTo: number;
  frames: number; // the tag's frame count, 0 if none
}

// libavformat/mp3dec.c's mp3_parse_vbr_tags, on the frame at d[o].
function readVbrTags(d: Uint8Array, o: number, end: number): Gapless {
  const none: Gapless = { skipFrame: 0, vbr: false, startSkip: 0, discardFrom: 0, discardTo: 0, frames: 0 };
  if (end - o < HDR_SIZE || !hdrValid(d, o) || layerBits(d[o + 1]) !== 1) return none;
  const lsf = !isMpeg1(d[o + 1]);
  const mono = isMono(d[o + 3]);
  const spf = lsf ? 576 : 1152;
  let frameSize = hdrFrameBytes(d, o, 0) + hdrPadding(d, o);
  if (isFreeFormat(d[o + 2])) {
    const found = findFrame(d, o, end);
    frameSize = found.offset === 0 ? found.frameBytes : 0;
  }
  const g: Gapless = { ...none };
  let frames = 0;
  let headerFilesize = 0;
  // Xing / Info, after the side info (ffmpeg's fixed offsets; a CRC moves it
  // and ffmpeg then misses it, as do we).
  let p = o + HDR_SIZE + (lsf ? (mono ? 9 : 17) : mono ? 17 : 32);
  const xing = ascii(d, p, "Xing");
  if (xing || ascii(d, p, "Info")) {
    const flags = be(d, p + 4, 4);
    p += 8;
    if (flags & 1) {
      frames = be(d, p, 4);
      p += 4;
    }
    if (flags & 2) {
      headerFilesize = be(d, p, 4);
      p += 4;
    }
    const fsize = Math.max(0, d.length - (o + HDR_SIZE));
    if (fsize && headerFilesize) {
      const min = Math.min(fsize, headerFilesize);
      const delta = Math.max(fsize, headerFilesize) - min;
      if (fsize > headerFilesize && delta > Math.floor(min / 16)) frames = 0; // "invalid concatenated file"
    }
    if (flags & 4) p += 100;
    if (flags & 8) p += 4;
    const lame = ascii(d, p, "LAME") || ascii(d, p, "Lavf") || ascii(d, p, "Lavc");
    p += 9 + 12; // encoder string, then revision ... ABR bitrate
    if (lame) {
      const v = be(d, p, 3);
      const startPad = v >> 12;
      const endPad = v & 4095;
      g.startSkip = startPad + 528 + 1;
      if (frames) {
        g.discardFrom = frames * spf - endPad + 528 + 1;
        g.discardTo = frames * spf;
      }
    }
    g.vbr = xing;
  }
  // VBRI, 32 bytes after the header.
  if (ascii(d, o + HDR_SIZE + 32, "VBRI") && be(d, o + HDR_SIZE + 36, 2) === 1) {
    headerFilesize = be(d, o + HDR_SIZE + 42, 4);
    frames = be(d, o + HDR_SIZE + 46, 4);
    g.vbr = true;
  }
  if (frames || headerFilesize) g.skipFrame = frameSize;
  g.frames = frames;
  return g;
}

// ---- Entry points ----

// An ID3v2 tag, or a frame header at 0 that the next frame's header
// confirms.
export function isMp3(buf: Uint8Array): boolean {
  if (isId3v2(buf, 0)) return true;
  if (buf.length < HDR_SIZE || !hdrValid(buf, 0)) return false;
  if (isFreeFormat(buf[2])) {
    const found = findFrame(buf, 0, buf.length);
    return found.offset === 0 && found.frameBytes > 0 && found.frameBytes < buf.length;
  }
  const next = hdrFrameBytes(buf, 0, 0) + hdrPadding(buf, 0);
  return next + HDR_SIZE <= buf.length && hdrCompare(buf, 0, buf, next);
}

export function decodeMp3(buf: Uint8Array, opts: Mp3Options): Mp3 {
  try {
    return decode(buf, opts);
  } catch (e) {
    if (e instanceof Mp3Error) throw e;
    // Nothing the input can do should get here; if it does, it is still
    // the input's fault as far as the caller can tell.
    throw new Mp3Error("CORRUPT", "the MP3 data could not be decoded");
  }
}

function decode(buf: Uint8Array, opts: Mp3Options): Mp3 {
  const maxSamples = Math.max(0, Math.floor(opts.maxSamples));
  let start = 0;
  const tagged = isId3v2(buf, 0);
  while (isId3v2(buf, start)) start += id3v2Size(buf, start);
  start = Math.min(start, buf.length);
  const end = audioEnd(buf, start);

  const gapless = readVbrTags(buf, start, end);
  let pos = start + gapless.skipFrame;
  const dec = new Decoder();

  let rate = 0;
  let nch = 0;
  let layer = 0;
  let kept = 0; // samples per channel in out
  let decoded = 0; // samples per channel the frames gave, before trimming
  let frames = 0;
  let kbpsSum = 0;
  let firstKbps = -1;
  let varies = false;
  let out: Float32Array[] = [];
  let capacity = 0;

  while (pos < end) {
    const n = dec.decodeFrame(buf, pos, end);
    pos += dec.consumed;
    if (!n) continue;
    if (!nch) {
      rate = dec.hz;
      nch = dec.channels;
      layer = dec.layer;
      // A first guess at the length: the frames that fit in the data at
      // this frame's size (exact for CBR), or the tag's count if less; at
      // most 2^21 samples a channel, so that junk after a small frame does
      // not cost much. Then it doubles as needed.
      let guess = (Math.ceil((end - pos) / Math.max(1, dec.consumed)) + 2) * n;
      if (gapless.frames) guess = Math.min(guess, (gapless.frames + 1) * n);
      capacity = Math.min(Math.floor(maxSamples / nch), guess, 1 << 21);
      out = Array.from({ length: nch }, () => new Float32Array(capacity));
    } else if (dec.hz !== rate || dec.channels !== nch || dec.layer !== layer) {
      break; // a different stream from here: keep what we have
    }
    frames++;
    kbpsSum += dec.kbps;
    if (firstKbps < 0) firstKbps = dec.kbps;
    else if (dec.kbps !== firstKbps) varies = true;

    // The samples of this frame that the gapless trim keeps: from
    // startSkip on, except [discardFrom, discardTo).
    let from = Math.max(0, gapless.startSkip - decoded);
    let to = n;
    if (gapless.discardTo > gapless.discardFrom) {
      const a = Math.max(0, gapless.discardFrom - decoded);
      const b = Math.min(n, gapless.discardTo - decoded);
      if (a < b) {
        if (a <= from) from = Math.max(from, b);
        else if (b >= n) to = a;
        else {
          // The discard range sits inside this frame (a tiny padding):
          // keep both sides.
          keep(from, a);
          from = b;
        }
      }
    }
    keep(from, to);
    decoded += n;
  }

  function keep(from: number, to: number) {
    const count = to - from;
    if (count <= 0) return;
    if ((kept + count) * nch > maxSamples) throw new Mp3Error("TOO_LARGE", `the audio is longer than the limit of ${maxSamples} samples`);
    if (kept + count > capacity) {
      capacity = Math.min(Math.floor(maxSamples / nch), Math.max(kept + count, capacity * 2));
      out = out.map(ch => {
        const grown = new Float32Array(capacity);
        grown.set(ch.subarray(0, kept));
        return grown;
      });
    }
    for (let c = 0; c < nch; c++) out[c].set(dec.pcm[c].subarray(from, to), kept);
    kept += count;
  }

  if (!frames) {
    if (tagged || isMp3(buf)) throw new Mp3Error("CORRUPT", "no MPEG audio frame could be decoded");
    throw new Mp3Error("NOT_MP3", "not an MP3 file: no MPEG audio frames found");
  }
  // Give back what the first guess over-allocated, unless it is little.
  const channels = out.map(ch => (capacity - kept > capacity >> 6 ? ch.slice(0, kept) : ch.subarray(0, kept)));
  return {
    rate,
    channels,
    layer: layer as 1 | 2 | 3,
    bitrate: Math.round(kbpsSum / frames),
    vbr: gapless.vbr || varies
  };
}
