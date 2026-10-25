import { CliError, EXIT } from "../errors.js";
import { printJson, type Ctx } from "../generate.js";
import { baseOf, freeName, shown } from "./io.js";
import { textFlag } from "./flags.js";
import { loadAudioFile, outputBits, outputFormat, writeAudio, type LoadedAudio } from "./audio-io.js";
import {
  audibleRange,
  clippedSamples,
  crossfadeLoop,
  fade,
  frames,
  fromDb,
  loopClicks,
  loudness,
  repeat,
  repeats,
  samplePeak,
  scale,
  seconds,
  slice,
  toDb,
  toMono,
  truePeak
} from "./sound.js";
import type { Audio } from "./wav.js";
import { hint, TOOLS, type Hint, type ToolCall, type ToolFlag } from "./registry.js";

// `ludo toolbox audio`: sound effects, music and voices. The sound work is
// in sound.ts, the files in audio-io.ts.

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
  loop?: { start: number; end: number }; // WAV: write a smpl loop
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
  const { channels, notes } = writeAudio(file, done.audio, format, { bits: outputBits(src), loop: format === "wav" ? done.loop : undefined });
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

const THRESHOLD: ToolFlag = { flag: "--threshold", value: "dB", description: "Quieter than this counts as silence, in dBFS (default -50)" };

TOOLS.push({
  group: "audio",
  name: "info",
  args: "<sound>",
  summary: "How long and how loud a sound is, and whether it loops cleanly",
  details: [
    "Its format, length, peak and true peak (dBTP, between the samples, as a player rebuilds the wave),",
    "loudness (LUFS, ITU-R BS.1770: what normalize evens out), silence at either end, clipped samples,",
    "and whether it clicks where it loops. A sound under 0.4 s is measured as one block of its own length.",
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
    const next =
      !range || lead + tail < a.rate / 50
        ? copies > 1 || clicks
          ? hint("Make it loop without a seam", `ludo toolbox audio loop ${shown(src.file)}`)
          : hint("Even out its loudness", `ludo toolbox audio normalize ${shown(src.file)}`)
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
    "cut at given times instead of where the silence ends, and --only keeps one end as it is."
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
      next: file => hint("Even out its loudness", `ludo toolbox audio normalize ${file}`)
    });
  }
});

TOOLS.push({
  group: "audio",
  name: "normalize",
  args: "<sound>",
  summary: "Make a sound as loud as others: to a loudness (LUFS) or a peak",
  details: [
    "Changes the volume only (no compression), so sounds normalized to the same --lufs play equally loud.",
    "-16 LUFS suits games on phones and the web; -23 is broadcast level, for console-style mixes. If",
    "reaching it would push the true peak over --ceiling, it stops there and says how loud it got.",
    "--peak sets the true peak instead (-1 is common for sound effects)."
  ],
  flags: [
    { flag: "--lufs", value: "n", description: "The loudness to reach (default -16)" },
    { flag: "--peak", value: "dB", description: "Set the true peak to this instead, in dBTP" },
    { flag: "--ceiling", value: "dB", description: "With --lufs: the true peak never goes over this (default -1)" },
    ...OUTPUT
  ],
  async run(ctx, call) {
    const src = one(call, "ludo toolbox audio normalize <sound> [--lufs -16]");
    const lufs = numberFlag(call, "--lufs", "LUFS", -70, 0);
    const peakTarget = numberFlag(call, "--peak", "dB", -60, 0);
    const ceiling = numberFlag(call, "--ceiling", "dB", -60, 0) ?? -1;
    if (lufs !== undefined && peakTarget !== undefined) throw usage("Give --lufs or --peak, not both");
    const a = src.audio;
    const tp = toDb(truePeak(a));
    const loud = loudness(a);
    if (!Number.isFinite(tp) || (peakTarget === undefined && !Number.isFinite(loud.lufs))) {
      throw new CliError(`${shown(src.file)} is silent, so there is nothing to make louder`, EXIT.BAD_INPUT);
    }
    let gainDb: number;
    let limited = false;
    if (peakTarget !== undefined) gainDb = peakTarget - tp;
    else {
      const target = lufs ?? -16;
      gainDb = target - loud.lufs;
      if (tp + gainDb > ceiling) {
        gainDb = ceiling - tp;
        limited = true;
      }
    }
    const out: Audio = { rate: a.rate, channels: a.channels.map(ch => ch.slice()) };
    scale(out, fromDb(gainDb));
    const after = { lufs: loud.lufs + gainDb, tp: tp + gainDb };
    const says =
      `${gainDb >= 0 ? "Raised" : "Lowered"} it ${Math.abs(gainDb).toFixed(1)} dB: ${dbText(loud.lufs, "LUFS")} to ${dbText(after.lufs, "LUFS")}, true peak ${tp.toFixed(1)} to ${after.tp.toFixed(1)} dBTP` +
      (limited ? ` (stopped at the ${ceiling} dBTP ceiling, short of ${lufs ?? -16} LUFS)` : "");
    return save(ctx, call, src, {
      audio: out,
      facts: {
        gain_db: round(gainDb),
        loudness_before: round(loud.lufs),
        loudness_after: round(after.lufs),
        true_peak_before: round(tp),
        true_peak_after: round(after.tp),
        ...(loud.short ? { loudness_short: true } : {}),
        ...(limited ? { limited_by_ceiling: true } : {})
      },
      says,
      next: file => hint("Check it", `ludo toolbox audio info ${file}`)
    });
  }
});

TOOLS.push({
  group: "audio",
  name: "loop",
  args: "<sound>",
  summary: "Make a sound loop without a seam (ambience, engines, music beds)",
  details: [
    "Mixes the end over the start (--crossfade long) and drops it, so when the sound wraps around it runs",
    "on as it ran into its own tail: no click, no gap. A sound that is already several copies of one",
    "stretch is cut to one copy instead, which loops as it is. A WAV gets a loop point that Godot's",
    "importer loops on. --count writes the loop several times over, for players that cannot loop."
  ],
  flags: [
    { flag: "--crossfade", value: "ms", description: "How much of the end to mix over the start (default 1000, at most a quarter of it; 0: none)" },
    { flag: "--count", value: "n", description: "Write the loop this many times in a row (default 1)" },
    ...OUTPUT
  ],
  async run(ctx, call) {
    const src = one(call, "ludo toolbox audio loop <sound> [--crossfade 1000]");
    const given = numberFlag(call, "--crossfade", "milliseconds", 0, 60000);
    const count = numberFlag(call, "--count", "loops", 1, 100) ?? 1;
    if (!Number.isInteger(count)) throw usage("--count must be a whole number");
    const a = src.audio;
    const n = frames(a);
    const copies = given === undefined ? repeats(a) : 1;
    let out: Audio;
    let says: string;
    let crossfade = 0;
    if (copies > 1) {
      out = slice(a, 0, Math.floor(n / copies));
      says = `It is ${copies} copies of one ${(frames(out) / a.rate).toFixed(2)} s loop: kept one, which loops as it is`;
    } else {
      crossfade = Math.min(Math.round(((given ?? 1000) / 1000) * a.rate), Math.floor(n / 4));
      out = crossfade ? crossfadeLoop(a, crossfade) : slice(a, 0, n);
      says = crossfade
        ? `Mixed its last ${(crossfade / a.rate).toFixed(2)} s over its start: a ${(frames(out) / a.rate).toFixed(2)} s loop`
        : `Left as it is: ${loopClicks(a) ? "it clicks where it wraps around (try --crossfade)" : "it wraps around without a click"}`;
    }
    const period = frames(out);
    if (count > 1) out = repeat(out, count);
    return save(ctx, call, src, {
      audio: out,
      loop: { start: 0, end: frames(out) },
      facts: { loop_duration: secs(period, a.rate), crossfade: secs(crossfade, a.rate), ...(copies > 1 ? { repeats: copies } : {}), count, loop_clicks: loopClicks(out) },
      says: count > 1 ? `${says}, written ${count} times` : says,
      next: file => hint("Check where it wraps around", `ludo toolbox audio info ${file}`)
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
