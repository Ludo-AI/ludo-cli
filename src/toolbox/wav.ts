// WAV reading and writing, in-process: RIFF WAVE with PCM (8-bit unsigned,
// 16, 24 and 32-bit signed) or IEEE float (32 and 64-bit) samples, plain or
// WAVE_FORMAT_EXTENSIBLE, as Microsoft's "Multimedia Programming Interface
// and Data Specifications 1.0" and its WAVEFORMATEXTENSIBLE note lay them
// out. A `smpl` chunk's first loop is read and can be written: Godot's WAV
// importer loops a sound on it ("Detect From WAV").

export type WavErrorCode = "NOT_WAV" | "CORRUPT" | "UNSUPPORTED" | "TOO_LARGE";

export class WavError extends Error {
  constructor(
    readonly code: WavErrorCode,
    message: string
  ) {
    super(message);
  }
}

export interface Audio {
  rate: number; // samples per second
  channels: Float32Array[]; // planar, -1 to 1
}

export interface Wav extends Audio {
  bits: number; // per sample: 8, 16, 24, 32 or 64
  float: boolean;
  loop?: { start: number; end: number }; // the smpl chunk's first loop, in samples, end exclusive
}

const PCM = 1;
const FLOAT = 3;
const EXTENSIBLE = 0xfffe;
// The tail every WAVE_FORMAT_EXTENSIBLE subformat GUID shares after its
// first two bytes (the format tag): 0000-0010-8000-00aa00389b71.
const GUID_TAIL = [0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];

const fourcc = (b: Uint8Array, o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

export const isWav = (b: Uint8Array) => b.length >= 12 && fourcc(b, 0) === "RIFF" && fourcc(b, 8) === "WAVE";

// maxSamples counts every channel's samples together.
export function decodeWav(buf: Uint8Array, opts: { maxSamples: number }): Wav {
  if (!isWav(buf)) throw new WavError("NOT_WAV", "not a WAV file (no RIFF WAVE header)");
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let fmt: { tag: number; channels: number; rate: number; align: number; bits: number } | undefined;
  let data: Uint8Array | undefined;
  let loop: Wav["loop"];
  // The RIFF size is often wrong (streamed writers leave it 0 or -1), so the
  // chunks are walked to the end of the file instead.
  for (let o = 12; o + 8 <= buf.length; ) {
    const id = fourcc(buf, o);
    let size = dv.getUint32(o + 4, true);
    const body = o + 8;
    if (id === "data") {
      // The same goes for the data size: what is there is what plays.
      if (size > buf.length - body) size = buf.length - body;
      data = buf.subarray(body, body + size);
    } else {
      if (size > buf.length - body) {
        // A cut-off chunk after the samples (tags, cues) costs nothing.
        if (data && fmt) break;
        throw new WavError("CORRUPT", `its ${id.trim()} chunk runs past the end of the file`);
      }
      if (id === "fmt ") {
        if (size < 16) throw new WavError("CORRUPT", "its fmt chunk is too short");
        let tag = dv.getUint16(body, true);
        const bits = dv.getUint16(body + 14, true);
        if (tag === EXTENSIBLE) {
          if (size < 40) throw new WavError("CORRUPT", "its extensible fmt chunk is too short");
          const guid = buf.subarray(body + 24, body + 40);
          if (GUID_TAIL.some((v, i) => guid[2 + i] !== v)) throw new WavError("UNSUPPORTED", "its samples are in a format other than PCM or float");
          tag = dv.getUint16(body + 24, true);
        }
        fmt = { tag, channels: dv.getUint16(body + 2, true), rate: dv.getUint32(body + 4, true), align: dv.getUint16(body + 12, true), bits };
      } else if (id === "smpl" && size >= 36 + 24 && dv.getUint32(body + 28, true) > 0) {
        // The first sample loop: its type, then start and end (inclusive).
        const start = dv.getUint32(body + 36 + 8, true);
        const end = dv.getUint32(body + 36 + 12, true);
        if (end >= start) loop = { start, end: end + 1 };
      }
    }
    o = body + size + (size & 1);
  }
  if (!fmt) throw new WavError("CORRUPT", "it has no fmt chunk");
  if (!data) throw new WavError("CORRUPT", "it has no data chunk");
  const { tag, channels: n, rate, bits } = fmt;
  if (tag !== PCM && tag !== FLOAT) {
    const names: Record<number, string> = { 2: "ADPCM", 6: "A-law", 7: "µ-law", 0x11: "IMA ADPCM", 0x55: "MP3" };
    throw new WavError("UNSUPPORTED", `its samples are ${names[tag] ?? `format ${tag}`}, and only PCM and float are read`);
  }
  if (!n || n > 32) throw new WavError("CORRUPT", `it says ${n} channels`);
  if (rate < 1000 || rate > 768000) throw new WavError("CORRUPT", `it says ${rate} samples per second`);
  const ok = tag === PCM ? [8, 16, 24, 32].includes(bits) : bits === 32 || bits === 64;
  if (!ok) throw new WavError("UNSUPPORTED", `${bits}-bit ${tag === PCM ? "PCM" : "float"} samples are not read`);
  const bytes = bits / 8;
  // Some writers pad each sample to the block align; the block is what steps.
  const align = Math.max(fmt.align, bytes * n);
  const frames = Math.floor(data.length / align);
  if (frames * n > opts.maxSamples) throw new WavError("TOO_LARGE", `${frames * n} samples is over the limit of ${opts.maxSamples}`);
  const ddv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const channels = Array.from({ length: n }, () => new Float32Array(frames));
  for (let c = 0; c < n; c++) {
    const out = channels[c];
    let o = c * bytes;
    if (tag === FLOAT && bits === 32) for (let i = 0; i < frames; i++, o += align) out[i] = ddv.getFloat32(o, true);
    else if (tag === FLOAT) for (let i = 0; i < frames; i++, o += align) out[i] = ddv.getFloat64(o, true);
    else if (bits === 8) for (let i = 0; i < frames; i++, o += align) out[i] = (data[o] - 128) / 128;
    else if (bits === 16) for (let i = 0; i < frames; i++, o += align) out[i] = ddv.getInt16(o, true) / 32768;
    else if (bits === 24) for (let i = 0; i < frames; i++, o += align) out[i] = (((data[o] | (data[o + 1] << 8) | (data[o + 2] << 16)) << 8) >> 8) / 8388608;
    else for (let i = 0; i < frames; i++, o += align) out[i] = ddv.getInt32(o, true) / 2147483648;
  }
  // Float files can hold NaN and infinities, which every sum after this
  // would spread; they play as silence and full scale.
  if (tag === FLOAT) for (const ch of channels) for (let i = 0; i < frames; i++) if (!Number.isFinite(ch[i])) ch[i] = Number.isNaN(ch[i]) ? 0 : Math.sign(ch[i]);
  if (loop && (loop.end > frames || loop.start >= loop.end)) loop = undefined;
  return { rate, channels, bits, float: tag === FLOAT, ...(loop ? { loop } : {}) };
}

export interface WavOptions {
  bits?: 16 | 24 | 32; // default 16; 32 writes float
  loop?: { start: number; end: number }; // a smpl chunk with this one forward loop
}

// Integer samples are rounded to the nearest step and clipped, without
// dither: the toolbox writes game audio at the depth it read it at, where
// dither's noise floor would not be heard.
export function encodeWav(audio: Audio, opts: WavOptions = {}): Uint8Array {
  const bits = opts.bits ?? 16;
  const float = bits === 32;
  const n = audio.channels.length;
  const frames = audio.channels[0]?.length ?? 0;
  if (!n || n > 32) throw new Error(`a WAV holds 1-32 channels, not ${n}`);
  const bytes = bits / 8;
  const dataSize = frames * n * bytes;
  // Over two channels or 16 bits, WAVEFORMATEXTENSIBLE is what readers expect.
  const extensible = n > 2 || bits > 16;
  const fmtSize = extensible ? 40 : 16;
  const smplSize = opts.loop ? 36 + 24 : 0;
  const total = 12 + 8 + fmtSize + (smplSize ? 8 + smplSize : 0) + 8 + dataSize + (dataSize & 1);
  if (total > 0xffffffff) throw new Error("over 4 GB, too large for a WAV file");
  const buf = new Uint8Array(total);
  const dv = new DataView(buf.buffer);
  const tag = (o: number, s: string) => {
    for (let i = 0; i < 4; i++) buf[o + i] = s.charCodeAt(i);
  };
  tag(0, "RIFF");
  dv.setUint32(4, total - 8, true);
  tag(8, "WAVE");
  let o = 12;
  tag(o, "fmt ");
  dv.setUint32(o + 4, fmtSize, true);
  dv.setUint16(o + 8, extensible ? EXTENSIBLE : float ? FLOAT : PCM, true);
  dv.setUint16(o + 10, n, true);
  dv.setUint32(o + 12, audio.rate, true);
  dv.setUint32(o + 16, audio.rate * n * bytes, true);
  dv.setUint16(o + 20, n * bytes, true);
  dv.setUint16(o + 22, bits, true);
  if (extensible) {
    dv.setUint16(o + 24, 22, true);
    dv.setUint16(o + 26, bits, true);
    // The speaker mask: the first n of Microsoft's speaker positions (front
    // left, front right, centre...), 0 past 18 channels.
    dv.setUint32(o + 28, n <= 18 ? 2 ** n - 1 : 0, true);
    dv.setUint16(o + 32, float ? FLOAT : PCM, true);
    buf.set(GUID_TAIL, o + 34);
  }
  o += 8 + fmtSize;
  if (opts.loop) {
    tag(o, "smpl");
    dv.setUint32(o + 4, smplSize, true);
    // Manufacturer, product, then the sample period in nanoseconds, MIDI
    // unity note 60, pitch fraction, SMPTE format and offset, one loop, no
    // sampler data.
    dv.setUint32(o + 8 + 8, Math.round(1e9 / audio.rate), true);
    dv.setUint32(o + 8 + 12, 60, true);
    dv.setUint32(o + 8 + 28, 1, true);
    // The loop: cue id 0, type 0 (forward), start, end (inclusive), fraction, play count 0 (forever).
    dv.setUint32(o + 8 + 36 + 8, opts.loop.start, true);
    dv.setUint32(o + 8 + 36 + 12, opts.loop.end - 1, true);
    o += 8 + smplSize;
  }
  tag(o, "data");
  dv.setUint32(o + 4, dataSize, true);
  o += 8;
  const clip = (v: number) => (v > 1 ? 1 : v < -1 ? -1 : v);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < n; c++, o += bytes) {
      const v = audio.channels[c][i];
      if (float) dv.setFloat32(o, v, true);
      else if (bits === 16) dv.setInt16(o, Math.max(-32768, Math.min(32767, Math.round(clip(v) * 32768))), true);
      else {
        const s = Math.max(-8388608, Math.min(8388607, Math.round(clip(v) * 8388608)));
        buf[o] = s & 0xff;
        buf[o + 1] = (s >> 8) & 0xff;
        buf[o + 2] = (s >> 16) & 0xff;
      }
    }
  }
  return buf;
}
