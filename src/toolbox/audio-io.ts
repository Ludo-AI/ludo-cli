import fs from "node:fs";
import path from "node:path";
import { CliError, EXIT } from "../errors.js";
import { noteInput } from "../telemetry.js";
import { decodeWav, encodeWav, isWav, WavError, type Audio } from "./wav.js";
import { FFMPEG_INSTALL, haveFfmpeg, needFfmpeg, run } from "./video.js";

// Reading and writing the audio tools' files. WAV is read and written
// in-process; every other format crosses the system's ffmpeg as raw 32-bit
// float samples on a pipe.

// 10 minutes of 48 kHz stereo: 230 MB of samples.
export const MAX_AUDIO_SAMPLES = 48000 * 60 * 10 * 2;

export const AUDIO_FORMATS = ["wav", "ogg", "mp3", "flac"] as const;
export type AudioFormat = (typeof AUDIO_FORMATS)[number];

export interface LoadedAudio {
  file: string;
  audio: Audio;
  format: string; // wav, mp3, ogg, flac, or what ffprobe calls it
  codec: string; // what the samples are: "16-bit PCM", "MP3 192 kbit/s"
  bits?: number; // a WAV's sample depth
  float?: boolean;
  loop?: { start: number; end: number }; // a WAV's smpl loop
}

function readFile(file: string): Buffer {
  try {
    return fs.readFileSync(file);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new CliError(`File not found: ${file}`, EXIT.USAGE);
    if (code === "EISDIR") throw new CliError(`${file} is a folder, not a sound`, EXIT.USAGE);
    throw err;
  }
}

const tooLong = (file: string, samples: number) =>
  new CliError(`${file} is too long: ${samples} samples is over ${MAX_AUDIO_SAMPLES} (10 minutes of 48 kHz stereo)`, EXIT.BAD_INPUT, "Cut it into shorter files first.");

// The file's contents decide how it is read, not its extension: Ludo has
// served WAV files named .mp3.
export function loadAudioFile(file: string): LoadedAudio {
  const buf = readFile(file);
  if (isWav(buf)) {
    noteInput("wav", false);
    try {
      const wav = decodeWav(buf, { maxSamples: MAX_AUDIO_SAMPLES });
      if (!wav.channels[0].length) throw new CliError(`${file} has no samples`, EXIT.BAD_INPUT);
      return { file, audio: wav, format: "wav", codec: `${wav.bits}-bit ${wav.float ? "float" : "PCM"}`, bits: wav.bits, float: wav.float, loop: wav.loop };
    } catch (err) {
      if (!(err instanceof WavError)) throw err;
      if (err.code === "TOO_LARGE") throw tooLong(file, Number(/^(\d+)/.exec(err.message)?.[1] ?? 0));
      // ADPCM, A-law and the like: ffmpeg reads those.
      if (err.code === "UNSUPPORTED" && haveFfmpeg()) return loadWithFfmpeg(file);
      throw new CliError(`Cannot read ${file}: ${err.message}`, EXIT.BAD_INPUT, err.code === "UNSUPPORTED" ? `Convert it to 16-bit PCM WAV first, or install ffmpeg, which reads it (${FFMPEG_INSTALL}).` : undefined);
    }
  }
  needFfmpeg("Reading this sound", "convert it to WAV first (the toolbox reads WAV itself)");
  return loadWithFfmpeg(file);
}

function loadWithFfmpeg(file: string): LoadedAudio {
  const probe = run("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name,sample_rate,channels,bit_rate:format=format_name,duration,bit_rate", "-of", "json", file]);
  let info: { streams?: { codec_name?: string; sample_rate?: string; channels?: number; bit_rate?: string }[]; format?: { format_name?: string; duration?: string; bit_rate?: string } };
  try {
    info = JSON.parse(probe.stdout.toString());
  } catch {
    info = {};
  }
  const s = info.streams?.[0];
  const rate = Number(s?.sample_rate);
  const n = s?.channels ?? 0;
  if (probe.status !== 0 || !s || !rate || !n) {
    throw new CliError(`Cannot read ${file} as a sound: ${probe.stderr.toString().trim().split("\n").pop() || "ffprobe found no audio stream"}`, EXIT.BAD_INPUT);
  }
  const duration = Number(info.format?.duration) || 0;
  if (duration * rate * n > MAX_AUDIO_SAMPLES) throw tooLong(file, Math.round(duration * rate * n));
  const res = run("ffmpeg", ["-v", "error", "-i", file, "-map", "0:a:0", "-f", "f32le", "-acodec", "pcm_f32le", "-ac", String(n), "-ar", String(rate), "pipe:1"]);
  if (res.status !== 0) throw new CliError(`ffmpeg could not decode ${file}: ${res.stderr.toString().trim().split("\n").pop()}`, EXIT.BAD_INPUT);
  const count = Math.floor(res.stdout.length / 4 / n);
  if (!count) throw new CliError(`${file} has no samples`, EXIT.BAD_INPUT);
  if (count * n > MAX_AUDIO_SAMPLES) throw tooLong(file, count * n);
  const raw = new Float32Array(res.stdout.buffer, res.stdout.byteOffset, count * n);
  const channels = Array.from({ length: n }, (_, c) => {
    const ch = new Float32Array(count);
    for (let i = 0; i < count; i++) ch[i] = raw[i * n + c];
    return ch;
  });
  const container = info.format?.format_name ?? "";
  const codec = s.codec_name ?? "";
  const format = codec === "mp3" ? "mp3" : codec === "flac" ? "flac" : /ogg/.test(container) ? "ogg" : container.split(",")[0] || codec;
  const kbps = Math.round(Number(s.bit_rate || info.format?.bit_rate) / 1000);
  noteInput(format, false);
  return { file, audio: { rate, channels }, format, codec: `${codec === "mp3" ? "MP3" : codec}${kbps ? ` ${kbps} kbit/s` : ""}` };
}

export interface WriteOptions {
  bits?: 16 | 24 | 32; // WAV and FLAC sample depth (32: float, WAV only)
  loop?: { start: number; end: number }; // WAV: a smpl loop
}

let vorbisEncoder: string | undefined;
// libvorbis when ffmpeg was built with it, else ffmpeg's own Vorbis encoder
// (Homebrew's ffmpeg has only that one). Opus would be smaller, but Godot and
// Unity import Ogg Vorbis, not Opus.
function vorbis(): string {
  if (vorbisEncoder === undefined) vorbisEncoder = / libvorbis /.test(run("ffmpeg", ["-hide_banner", "-encoders"]).stdout.toString()) ? "libvorbis" : "vorbis";
  return vorbisEncoder;
}

// Writes the file; returns how many channels it holds and what the reader
// should know about it.
export function writeAudio(file: string, audio: Audio, format: AudioFormat, opts: WriteOptions = {}): { channels: number; notes: string[] } {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  if (format === "wav") {
    fs.writeFileSync(file, encodeWav(audio, opts));
    return { channels: audio.channels.length, notes: [] };
  }
  needFfmpeg(`Writing ${format.toUpperCase()}`, "write WAV with --to wav (the toolbox writes WAV itself)");
  const notes: string[] = [];
  let channels = audio.channels;
  let codec: string[];
  if (format === "mp3") {
    if (channels.length > 2) throw new CliError(`MP3 holds one or two channels, and this sound has ${channels.length}`, EXIT.BAD_INPUT, "Write --to ogg, flac or wav, or add --mono.");
    // LAME's VBR quality 2: about 190 kbit/s for stereo, transparent for most material.
    codec = ["-c:a", "libmp3lame", "-q:a", "2"];
  } else if (format === "ogg") {
    const encoder = vorbis();
    if (encoder === "vorbis") {
      if (channels.length > 2) throw new CliError(`This ffmpeg's own Vorbis encoder writes stereo only, and this sound has ${channels.length} channels`, EXIT.BAD_INPUT, "Install an ffmpeg with libvorbis, or write --to flac or wav.");
      if (channels.length === 1) {
        channels = [channels[0], channels[0]];
        notes.push("this ffmpeg's own Vorbis encoder writes stereo only, so the mono sound is in both channels (an ffmpeg with libvorbis keeps it mono)");
      }
      codec = ["-c:a", "vorbis", "-strict", "-2", "-q:a", "6"];
    } else {
      codec = ["-c:a", "libvorbis", "-q:a", "5"];
    }
  } else {
    codec = ["-c:a", "flac", "-compression_level", "8", ...(opts.bits === 24 || opts.bits === 32 ? ["-sample_fmt", "s32", "-bits_per_raw_sample", "24"] : ["-sample_fmt", "s16"])];
  }
  const n = channels.length;
  const count = channels[0].length;
  const raw = new Float32Array(count * n);
  for (let c = 0; c < n; c++) for (let i = 0; i < count; i++) raw[i * n + c] = Math.max(-1, Math.min(1, channels[c][i]));
  const res = run("ffmpeg", ["-v", "error", "-y", "-f", "f32le", "-ar", String(audio.rate), "-ac", String(n), "-i", "pipe:0", ...codec, "-f", format === "ogg" ? "ogg" : format, file], Buffer.from(raw.buffer));
  if (res.status !== 0) {
    const why = res.stderr.toString().trim().split("\n").pop() ?? "";
    throw new CliError(`ffmpeg could not write ${file}: ${why}`, EXIT.BAD_INPUT, /Unknown encoder|not found/i.test(why) ? "This ffmpeg was built without that encoder; try another --to." : undefined);
  }
  return { channels: n, notes };
}

// The format a tool writes: --to's, else the input's when it is one the
// toolbox writes, else WAV.
export function outputFormat(src: LoadedAudio, to: string | undefined): AudioFormat {
  if (to !== undefined) {
    const f = to.toLowerCase().replace(/^\./, "");
    if (!(AUDIO_FORMATS as readonly string[]).includes(f)) throw new CliError(`--to takes ${AUDIO_FORMATS.join(", ")} (got "${to}")`, EXIT.USAGE);
    return f as AudioFormat;
  }
  return (AUDIO_FORMATS as readonly string[]).includes(src.format) ? (src.format as AudioFormat) : "wav";
}

// A WAV is written at the depth it was read at (8-bit as 16, 32-bit
// integer and 64-bit float as 32-bit float); other sources as 16-bit.
export const outputBits = (src: LoadedAudio): 16 | 24 | 32 => (src.float ? 32 : src.bits === 24 ? 24 : src.bits === 32 ? 32 : 16);
