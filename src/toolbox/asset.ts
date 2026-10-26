import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CliError, EXIT } from "../errors.js";
import { printJson, type Ctx } from "../generate.js";
import type { Image } from "../tty/png.js";
import { CONFIDENT, guessGrid } from "./grid.js";
import { loadImageFile, shown, type Loaded } from "./io.js";
import { natural } from "./sprite.js";
import { crop, frameRects } from "./sheet.js";
import { contentBox, emptiness } from "./pixels.js";
import { seams } from "./tiles.js";
import { loadAudioFile } from "./audio-io.js";
import { frames as sampleFrames, loopClicks, loudness, repeats, samplePeak, toDb, toMono } from "./sound.js";
import type { Audio } from "./wav.js";
import { modelInfo, ModelError, readGltf } from "./model.js";
import { haveFfmpeg, probeVideo } from "./video.js";
import { textFlag } from "./flags.js";
import { hint, TOOLS, type Hint, type ToolCall } from "./registry.js";
import { LOG_NAME, readAssets, type AssetEntry } from "../assets.js";

// `ludo toolbox asset ...`: a folder of assets at once. The manifest only
// looks: it says what each file is, what the folder visibly lacks next to
// what the rest of it has, and writes loader code. It never changes the art;
// where something is missing, it names the Ludo command that makes it.

// ---- Finding and reading the files ----

const IMAGE_EXT = new Set([".png", ".gif", ".webp", ".jpg", ".jpeg"]);
const AUDIO_EXT = new Set([".wav", ".mp3", ".ogg", ".oga", ".flac", ".opus", ".m4a", ".aac", ".aif", ".aiff"]);
const MODEL_EXT = new Set([".glb", ".gltf", ".fbx", ".obj", ".dae", ".blend"]);
const VIDEO_EXT = new Set([".mp4", ".webm", ".mov", ".m4v", ".ogv", ".mkv", ".avi"]);

type AssetType = "image" | "audio" | "model" | "video";
export type Kind = "spritesheet" | "image" | "texture" | "sfx" | "music" | "voice" | "ambience" | "model" | "video";

const typeOf = (file: string): AssetType | undefined => {
  const ext = path.extname(file).toLowerCase();
  return IMAGE_EXT.has(ext) ? "image" : AUDIO_EXT.has(ext) ? "audio" : MODEL_EXT.has(ext) ? "model" : VIDEO_EXT.has(ext) ? "video" : undefined;
};

export interface SheetGrid {
  cols: number;
  rows: number;
  frames: number;
  frame_width: number;
  frame_height: number;
  fps?: number; // only when the file says (a stamp, a GIF's or WebP's timing)
  from: "stamp" | "gif" | "webp" | "detected";
  confidence?: number;
}

export interface Asset {
  path: string; // relative to the folder, with forward slashes
  file: string; // as found on disk
  type: AssetType;
  kind: Kind;
  reason: string; // why it is that kind, in a few words
  format: string;
  bytes: number;
  sha256: string;
  width?: number;
  height?: number;
  frames?: number;
  fps?: number;
  duration?: number; // seconds
  grid?: SheetGrid;
  depth?: number; // bits per channel of a PNG
  alpha?: boolean; // any pixel not fully opaque
  animated?: "gif" | "webp";
  seams?: { across: number; down: number }; // a texture's wrap, as `image repeat` measures it
  audio?: { rate: number; channels: number; codec: string; bits?: number; float?: boolean; loudness_lufs: number | null; peak_db: number | null; loop_clicks: boolean; repeats: number; wav_loop: boolean };
  model?: {
    scenes: number;
    default_scene: number | null; // glTF's `scene`: the one shown at load
    meshes: number;
    triangles: number;
    vertices: number;
    materials: number;
    textures: { width?: number; height?: number }[];
    size?: number[]; // x, y, z
    min?: number[];
    rigged: boolean;
    joints: string[];
    clips: string[];
  };
  video?: { codec: string; alpha: boolean };
  mismatch?: string; // its extension says one format and its bytes another
  error?: string; // a file of a known type it could not read
  made?: Made; // how Ludo made it, when the folder keeps the record
  phash?: Uint8Array; // not in the JSON: the perceptual hash duplicates compare
  clipTargets?: string[]; // not in the JSON: the nodes a model's clips move, by name
}

// How the CLI names a download (animateSprite-29402c81-1.png): the
// operation, the job, the file's number. Its folder says what it is.
const LUDO_DOWNLOAD = /^[a-z][A-Za-z0-9]*-[0-9a-f]{8}-\d+$/;
const withoutDownloadName = (rel: string) => {
  const parts = rel.replace(/\.[^./]+$/, "").split("/");
  if (parts.length > 1 && LUDO_DOWNLOAD.test(parts[parts.length - 1])) parts.pop();
  return parts.join("/");
};

// Names that are not assets: version control, engines' own sidecar files
// (Godot's .import, Unity's .meta), dependencies.
const skipName = (name: string) => name.startsWith(".") || name === "node_modules" || /\.(import|meta)$/i.test(name);

interface Found {
  root: string;
  files: { file: string; rel: string }[];
  skipped: string[]; // files of no kind the toolbox knows, relative
}

// The files to look at: each argument is a file, or a folder walked
// (hidden files and sidecar files left out), all in natural order. Paths are
// shown relative to the one folder given, or to the folder the files share.
export function findAssets(args: string[], what: string): Found {
  if (!args.length) throw new CliError(`Usage: ${what}`, EXIT.USAGE);
  const stats = args.map(a => {
    const stat = fs.statSync(a, { throwIfNoEntry: false });
    if (!stat) throw new CliError(`File not found: ${a}`, EXIT.USAGE);
    return stat;
  });
  const dirs = args.map(a => path.resolve(a)).map((a, i) => (stats[i].isDirectory() ? a : path.dirname(a)));
  let root = dirs[0];
  for (const d of dirs) while (root !== path.dirname(root) && path.relative(root, d).startsWith("..")) root = path.dirname(root);
  const files: Found["files"] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  const add = (file: string) => {
    const abs = path.resolve(file);
    if (seen.has(abs)) return;
    seen.add(abs);
    const rel = path.relative(root, abs).split(path.sep).join("/");
    if (typeOf(abs)) files.push({ file, rel });
    else skipped.push(rel);
  };
  const walk = (dir: string, depth: number) => {
    if (depth > 32) return;
    for (const name of fs.readdirSync(dir).sort(natural.compare)) {
      if (skipName(name)) continue;
      const full = path.join(dir, name);
      const stat = fs.statSync(full, { throwIfNoEntry: false });
      if (stat?.isDirectory()) walk(full, depth + 1);
      else if (stat?.isFile()) add(full);
    }
  };
  args.forEach((a, i) => (stats[i].isDirectory() ? walk(a, 0) : add(a)));
  if (!files.length) throw new CliError(`No images, sounds, models or videos in ${args.join(", ")}`, EXIT.USAGE);
  return { root, files, skipped };
}

const round = (v: number, places = 2) => Math.round(v * 10 ** places) / 10 ** places;

// What every file gets, then what its type adds. A file that does not read
// stays in the list with its error, so one bad file never hides the rest.
// The hash in 1 MB reads, so a long video is never held whole.
function sha256Of(file: string): { sha256: string; bytes: number } {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  const chunk = Buffer.alloc(1 << 20);
  let bytes = 0;
  try {
    for (let n; (n = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0; bytes += n) hash.update(chunk.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return { sha256: hash.digest("hex"), bytes };
}

export function readAsset(file: string, rel: string): Asset {
  const type = typeOf(file)!;
  const { sha256, bytes } = sha256Of(file);
  const a: Asset = {
    path: rel,
    file,
    type,
    kind: type === "image" ? "image" : type === "audio" ? "sfx" : type,
    reason: "",
    format: path.extname(file).slice(1).toLowerCase(),
    bytes,
    sha256
  };
  try {
    if (type === "image") readImage(a, loadImageFile(file));
    else if (type === "audio") readSound(a, loadAudioFile(file));
    else if (type === "model") readModel(a, fs.readFileSync(file));
    else readVideo(a);
  } catch (err) {
    if (!(err instanceof CliError) && !(err instanceof ModelError) && !(err instanceof TypeError)) throw err;
    a.error = err.message.replace(/^Cannot read [^:]*: /, "");
    a.reason = "could not be read";
  }
  return a;
}

// ---- Images ----

// A difference hash (dHash, Krawetz 2013): the picture shrunk to (w+1) x h
// grey cells by box averaging, one bit per cell for whether it is brighter
// than the cell to its right. Transparent pixels count as mid-grey, so a
// sprite's silhouette shows. Re-encoding, resizing and small colour changes
// keep the bits; a different picture flips about half of them.
export function dHash(img: Image, w = 8, h = 8): Uint8Array {
  const cols = w + 1;
  const grey = new Float64Array(cols * h);
  const count = new Float64Array(cols * h);
  const { width, height, rgba } = img;
  for (let y = 0; y < height; y++) {
    const cy = Math.min(h - 1, Math.floor((y * h) / height));
    for (let x = 0; x < width; x++) {
      const cx = Math.min(cols - 1, Math.floor((x * cols) / width));
      const i = (y * width + x) * 4;
      const a = rgba[i + 3] / 255;
      grey[cy * cols + cx] += (0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]) * a + 128 * (1 - a);
      count[cy * cols + cx]++;
    }
  }
  const bits = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) bits[y * w + x] = grey[y * cols + x] / (count[y * cols + x] || 1) > grey[y * cols + x + 1] / (count[y * cols + x + 1] || 1) ? 1 : 0;
  return bits;
}

const hamming = (a: Uint8Array, b: Uint8Array) => a.reduce((n, v, i) => n + (v !== b[i] ? 1 : 0), 0);

const hasAlpha = (img: Image) => {
  for (let i = 3; i < img.rgba.length; i += 4) if (img.rgba[i] < 255) return true;
  return false;
};

// A sheet's grid as the file states it (a Ludo stamp, a GIF's or WebP's
// frames), else as detection finds it when it is sure; undefined for one
// picture.
export function gridOf(src: Loaded): SheetGrid | undefined {
  const { width, height } = src.image;
  const cell = (cols: number, rows: number) => ({ frame_width: Math.floor(width / cols), frame_height: Math.floor(height / rows) });
  if (src.grid) {
    if (src.grid.frames < 2) return undefined;
    return { cols: src.grid.cols, rows: src.grid.rows, frames: src.grid.frames, ...cell(src.grid.cols, src.grid.rows), fps: src.grid.fps, from: src.animation ?? "stamp" };
  }
  const guess = guessGrid(src.image);
  if (guess.confidence < CONFIDENT || guess.frames < 2) return undefined;
  return { cols: guess.cols, rows: guess.rows, frames: guess.frames, ...cell(guess.cols, guess.rows), from: "detected", confidence: round(guess.confidence) };
}

// The frames of an image: its grid's cells, or the whole picture.
export function framesOf(img: Image, grid: SheetGrid | undefined, limit = Infinity): Image[] {
  if (!grid) return [img];
  const rects = frameRects(img.width, img.height, grid.cols, grid.rows, grid.frames);
  const pick = rects.length <= limit ? rects : Array.from({ length: limit }, (_, k) => rects[Math.floor((k * rects.length) / limit)]);
  return pick.map(r => crop(img, r));
}

// Words a file's path uses for what it is. Only a tie-breaker: what the
// pixels or samples show decides first.
const wordsIn = (text: string) =>
  text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
const words = (rel: string) => wordsIn(rel.replace(/\.[^./]+$/, ""));

const TILE_WORDS = new Set(["tile", "tiles", "tileset", "tilemap", "texture", "textures", "tex", "seamless", "terrain", "ground", "floor", "wall", "pattern"]);

function readImage(a: Asset, src: Loaded) {
  const img = src.image;
  a.width = img.width;
  a.height = img.height;
  a.alpha = hasAlpha(img);
  if (a.format === "png") a.depth = src.info.sourceDepth;
  if (src.animation) a.animated = src.animation;
  const named = words(a.path).find(w => TILE_WORDS.has(w));
  // An opaque picture whose edges meet when it repeats is a texture; checked
  // before the grid, since a repeating pattern can pass for one.
  const wrap = !src.grid && !a.alpha && img.width >= 8 && img.height >= 8 ? seams(img) : undefined;
  const grid = wrap && wrap.x < 1.5 && wrap.y < 1.5 ? undefined : gridOf(src);
  if (grid) {
    a.grid = grid;
    a.frames = grid.frames;
    if (grid.fps) {
      a.fps = grid.fps;
      a.duration = round(grid.frames / grid.fps, 3);
    }
  }
  if (wrap && wrap.x < 1.5 && wrap.y < 1.5) {
    a.kind = "texture";
    a.seams = { across: wrap.x, down: wrap.y };
    a.reason = `opaque, and its edges meet when it repeats (${wrap.x}x and ${wrap.y}x its inner edges)`;
  } else if (grid && named && !src.grid) {
    a.kind = "texture";
    a.reason = `tiles in a ${grid.cols}x${grid.rows} grid, and named like tiles ("${named}")`;
  } else if (grid) {
    a.kind = "spritesheet";
    a.reason =
      grid.from === "stamp" ? "its Ludo stamp says so" : grid.from === "detected" ? `grid detected, ${Math.round(grid.confidence! * 100)}% sure` : `an animated ${grid.from.toUpperCase()}`;
  } else if (named && !a.alpha) {
    a.kind = "texture";
    a.reason = `opaque, and named like a texture ("${named}"), though its edges do not meet`;
  } else {
    a.kind = "image";
    a.reason = src.grid ? "its Ludo stamp says one frame" : a.alpha ? "one picture with transparency" : "one opaque picture";
  }
  // Up to 8 frames spread over the sheet, each hashed on its own: two
  // animations of one character start from the same pose and keep its
  // silhouette, so only frame by frame do they differ. They are hashed
  // inside the box the art fills in all of them: a small figure in a big
  // empty frame would leave most cells the same grey whatever its pose.
  const hashed = framesOf(img, grid, HASHED_FRAMES);
  const box = contentBox(hashed, emptiness(hashed, 127));
  a.phash = new Uint8Array(hashed.flatMap(f => [...dHash(box ? crop(f, box) : f)]));
}

const HASHED_FRAMES = 8;

// ---- Sounds ----

// Two speech measures on the 10 ms loudness envelope. Speech alternates
// syllables with short pauses, so many of its frames are much quieter than
// the second around them: Scheirer & Slaney's "percentage of low-energy
// frames" (ICASSP 1997, frames under half the mean RMS of their 1 s
// window). Pauses: frames 30 dB under the loud end (95th percentile).
// Music and ambiences rarely drop that far; voices do between words.
export function speechStats(a: Audio): { low: number; pauses: number } {
  const m = toMono(a).channels[0];
  const hop = Math.max(1, Math.round(a.rate / 100));
  const env: number[] = [];
  for (let i = 0; i + hop <= m.length; i += hop) {
    let s = 0;
    for (let k = 0; k < hop; k++) s += m[i + k] * m[i + k];
    env.push(Math.sqrt(s / hop));
  }
  let low = 0;
  let total = 0;
  for (let w = 0; w + 100 <= env.length; w += 100) {
    const seg = env.slice(w, w + 100);
    const mean = seg.reduce((x, y) => x + y, 0) / seg.length;
    for (const v of seg) {
      total++;
      if (v < 0.5 * mean) low++;
    }
  }
  const sorted = [...env].sort((x, y) => x - y);
  const loud = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
  const pauses = env.length ? env.filter(v => v < loud * 10 ** (-30 / 20)).length / env.length : 0;
  return { low: total ? round(low / total) : 0, pauses: round(pauses) };
}

const SOUND_WORDS: [Kind, Set<string>][] = [
  ["voice", new Set(["voice", "voices", "vo", "speech", "dialog", "dialogue", "line", "lines", "narration", "narrator", "bark", "barks", "spoken"])],
  ["ambience", new Set(["ambience", "ambiance", "ambient", "amb", "atmos", "atmosphere", "roomtone"])],
  ["music", new Set(["music", "bgm", "theme", "song", "track", "ost", "soundtrack", "score"])],
  ["sfx", new Set(["sfx", "fx", "sound", "sounds", "footstep", "footsteps", "step", "steps", "hit", "jump", "coin", "click", "ui", "impact", "explosion", "laser", "swing", "whoosh", "pickup"])]
];

// What a sound is for, from its length, whether it loops, and how it moves,
// with the path's words first when they say. The thresholds were set on
// Ludo's own sound effects, music, ambiences and voices: they are a
// reasonable first sort, not a classifier, and `reason` says which rule
// decided.
export function soundKind(rel: string, duration: number, loops: boolean, copies: number, speech: { low: number; pauses: number }): { kind: Kind; reason: string } {
  const w = words(rel);
  for (const [kind, set] of SOUND_WORDS) {
    const hit = w.find(x => set.has(x));
    if (hit) return { kind, reason: `named like ${kind === "sfx" ? "a sound effect" : kind === "voice" ? "a voice line" : kind === "music" ? "music" : "an ambience"} ("${hit}")` };
  }
  // A loop written out more than once (Ludo's ambiences are a 10 s loop
  // written twice, 20 s): its length is the loop's, not the file's.
  if (copies > 1) {
    const loop = duration / copies;
    return { kind: loop >= 20 ? "music" : "ambience", reason: `${copies} copies of one ${round(loop, 1)} s loop written out` };
  }
  if (duration < 1.5) return { kind: "sfx", reason: "under 1.5 s" };
  const speechLike = duration <= 15 && speech.low >= 0.3 && speech.low <= 0.6 && speech.pauses >= 0.12 && speech.pauses <= 0.45;
  if (speechLike) return { kind: "voice", reason: `speech-like: ${Math.round(speech.low * 100)}% low-energy frames, ${Math.round(speech.pauses * 100)}% pauses` };
  if (duration >= 20) return { kind: "music", reason: `${Math.round(duration)} s long${loops ? ", and wraps without a click" : ""}` };
  if (loops && duration >= 5 && speech.pauses < 0.05) return { kind: "ambience", reason: "5-20 s without pauses, and wraps without a click" };
  return { kind: "sfx", reason: `${round(duration, 1)} s, not speech-like${loops ? "" : ", and clicks where it wraps"}` };
}

function readSound(a: Asset, src: ReturnType<typeof loadAudioFile>) {
  const audio = src.audio;
  const n = sampleFrames(audio);
  const duration = n / audio.rate;
  const clicks = loopClicks(audio);
  const copies = repeats(audio);
  const lufs = loudness(audio).lufs;
  const peak = toDb(samplePeak(audio));
  const ext = path.extname(a.path).slice(1).toLowerCase().replace(/^oga$/, "ogg");
  if (["wav", "mp3", "ogg", "flac"].includes(ext) && ["wav", "mp3", "ogg", "flac"].includes(src.format) && ext !== src.format) a.mismatch = `named .${ext}, but a ${src.format.toUpperCase()} inside`;
  a.format = src.format;
  a.duration = round(duration, 3);
  a.audio = {
    rate: audio.rate,
    channels: audio.channels.length,
    codec: src.codec,
    ...(src.bits ? { bits: src.bits, float: !!src.float } : {}),
    loudness_lufs: Number.isFinite(lufs) ? round(lufs, 1) : null,
    peak_db: Number.isFinite(peak) ? round(peak, 1) : null,
    loop_clicks: clicks,
    repeats: copies,
    wav_loop: !!src.loop
  };
  const k = soundKind(a.path, duration, !clicks || !!src.loop, copies, speechStats(audio));
  a.kind = k.kind;
  a.reason = k.reason;
}

// ---- Models and videos ----

function readModel(a: Asset, buf: Buffer) {
  a.kind = "model";
  if (a.format !== "glb" && a.format !== "gltf") {
    a.reason = `a .${a.format} model (the toolbox reads glTF and GLB only)`;
    return;
  }
  const loaded = readGltf(buf, a.file);
  const info = modelInfo(loaded);
  const json = loaded.json;
  // Every joint and clip by name (modelInfo keeps the first 64 joints).
  const joints = [...new Set((json.skins ?? []).flatMap(s => s.joints.map(j => json.nodes?.[j]?.name ?? `node ${j}`)))];
  a.clipTargets = [...new Set((json.animations ?? []).flatMap(c => c.channels.map(ch => json.nodes?.[ch.target.node ?? -1]?.name ?? "")))].filter(Boolean);
  a.model = {
    scenes: info.scenes,
    default_scene: typeof json.scene === "number" ? json.scene : null,
    meshes: info.meshes,
    triangles: info.triangles,
    vertices: info.vertices,
    materials: info.materials,
    textures: info.images.map(i => ("width" in i ? { width: i.width, height: i.height } : {})),
    ...(info.bounds ? { size: info.bounds.size, min: info.bounds.min } : {}),
    rigged: info.rigged,
    joints,
    clips: info.animations.map(c => c.name)
  };
  a.reason = [`glTF ${info.version}`, `${info.triangles} triangles`, info.rigged ? `rigged (${joints.length} joints)` : "", info.animations.length ? `${info.animations.length} clip${info.animations.length === 1 ? "" : "s"}` : ""]
    .filter(Boolean)
    .join(", ");
}

let ffmpeg: boolean | undefined;
function readVideo(a: Asset) {
  a.kind = "video";
  ffmpeg ??= haveFfmpeg();
  if (!ffmpeg) {
    a.reason = "a video (its size needs ffprobe, which is not installed)";
    return;
  }
  const v = probeVideo(a.file);
  a.width = v.width;
  a.height = v.height;
  a.fps = round(v.fps);
  a.duration = round(v.duration, 3);
  if (v.duration) a.frames = Math.round(v.duration * v.fps);
  a.video = { codec: v.codec, alpha: v.alpha };
  a.reason = `${v.codec}${v.alpha ? " with alpha" : ""}`;
}

// ---- How Ludo made them ----

// What the folder records of how a file was made, and only what it states:
// the CLI's asset log (ludo-assets.json, in the folder, in a folder in it or
// in one above it), or an API job saved as JSON beside its files
// (<name>_job.json, the job getApiJob returns, its files saved as
// <name>_<n>.<ext> in the order of the result's URLs), or what the CLI
// printed with --json for a job (its `files`, each with its absolute_path).
export interface Made {
  operation: string; // the API operation: animateSprite, adjustSpritesheet, rigModel...
  job?: string;
  created?: number; // ms since 1970
  model?: string; // the AI model the request named
  audio: boolean; // the job's result has a sound: a sound file of its job in the log, or an audio_url
  video?: { url: string; record: string }; // the job's video_url, and the record that keeps it
  inputs: string[]; // local files the request named, absolute
  record: string; // the record, relative to the folder
}

const SOUND_OF: Record<string, Kind> = {
  createSoundEffect: "sfx",
  createSpriteAudio: "sfx",
  animateSprite: "sfx",
  animateSpriteKeyframes: "sfx",
  transferMotion: "sfx",
  editSpritesheet: "sfx",
  adjustSpritesheet: "sfx",
  createMusic: "music",
  createAmbiance: "ambience",
  createVoice: "voice",
  createSpeech: "voice",
  createSpeechPreset: "voice"
};
const SPRITE_OPS = new Set(["animateSprite", "animateSpriteKeyframes", "transferMotion", "editSpritesheet", "adjustSpritesheet", "rotateSpritesheet"]);

function fromLog(file: string, record: string, out: Map<string, Made>) {
  let entries: AssetEntry[];
  try {
    entries = readAssets(file);
  } catch {
    return; // not JSON: nothing it says can be trusted
  }
  const dir = path.dirname(file);
  const byJob = new Map<string, AssetEntry[]>();
  for (const e of entries) if (e?.job_id && typeof e.file === "string") byJob.set(e.job_id, [...(byJob.get(e.job_id) ?? []), e]);
  for (const e of entries) {
    if (typeof e?.file !== "string" || typeof e.operation_id !== "string") continue;
    const body = e.body && typeof e.body === "object" ? e.body : {};
    const inputs = Object.values(body)
      .flatMap(v => (Array.isArray(v) ? v : [v]))
      .filter((v): v is string => typeof v === "string" && !/^(https?:|data:)/i.test(v) && v.length < 1024)
      .map(v => path.resolve(dir, v))
      .filter(v => fs.statSync(v, { throwIfNoEntry: false })?.isFile());
    const created = Date.parse(e.created_at);
    const at = path.resolve(dir, e.file);
    const job = out.get(at); // a job record of the same file keeps what the log does not
    out.set(at, {
      ...(job?.video ? { video: job.video } : {}),
      operation: e.operation_id,
      ...(e.job_id ? { job: e.job_id } : {}),
      ...(Number.isFinite(created) ? { created } : {}),
      ...(typeof body.model === "string" && /^[a-z0-9-]+$/i.test(body.model) ? { model: body.model } : {}),
      audio: !!job?.audio || (e.job_id ? (byJob.get(e.job_id) ?? []) : [e]).some(x => AUDIO_EXT.has(path.extname(x.file).toLowerCase())),
      inputs,
      record
    });
  }
}

function fromJob(file: string, record: string, out: Map<string, Made>) {
  let job: { id?: unknown; job_id?: unknown; task_type?: unknown; created_at?: unknown; result?: unknown; files?: unknown };
  try {
    if (fs.statSync(file).size > 4 << 20) return;
    job = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return;
  }
  if (typeof job?.task_type !== "string" || !job.result || typeof job.result !== "object") return;
  const results = (Array.isArray(job.result) ? job.result : [job.result]).filter(x => x && typeof x === "object") as Record<string, unknown>[];
  const urls = results.flatMap(x => (typeof x.url === "string" ? [x.url] : Object.values(x).filter((v): v is string => typeof v === "string" && /^https?:/.test(v))));
  const created = typeof job.created_at === "number" ? job.created_at : typeof job.created_at === "string" ? Date.parse(job.created_at) : NaN;
  const video = results.find(x => typeof x.video_url === "string")?.video_url as string | undefined;
  const id = typeof job.id === "string" ? job.id : typeof job.job_id === "string" ? job.job_id : undefined;
  const made: Made = {
    operation: job.task_type,
    ...(id ? { job: id } : {}),
    ...(Number.isFinite(created) ? { created } : {}),
    audio: results.some(x => typeof x.audio_url === "string" || typeof x.audio_b64 === "string"),
    ...(video ? { video: { url: video, record } } : {}),
    inputs: [],
    record
  };
  const files = Array.isArray(job.files) ? job.files.map(f => f?.absolute_path).filter((f): f is string => typeof f === "string" && path.isAbsolute(f)) : [];
  if (files.length) for (const f of files) out.set(path.resolve(f), made);
  else if (file.endsWith("_job.json")) {
    const prefix = file.slice(0, -"_job.json".length);
    urls.forEach((u, i) => {
      const ext = /\.(\w+)$/.exec(u.split("?")[0])?.[1];
      if (ext) out.set(path.resolve(`${prefix}_${i}.${ext}`), made);
    });
  }
}

// Each file's record, from the logs and jobs found and the logs above the folder.
export function madeOf(found: Found, assets: Asset[]) {
  const out = new Map<string, Made>();
  const logs = new Set<string>();
  for (let dir = path.dirname(found.root), n = 0; n < 16 && dir !== path.dirname(dir); dir = path.dirname(dir), n++) logs.add(path.join(dir, LOG_NAME));
  for (const rel of found.skipped) {
    const abs = path.resolve(found.root, rel);
    if (path.basename(rel) === LOG_NAME) logs.add(abs);
    else if (rel.endsWith(".json")) fromJob(abs, rel, out);
  }
  logs.add(path.join(found.root, LOG_NAME));
  // Above the folder first, so a log closer to the files has the last word.
  for (const log of [...logs].sort((x, y) => x.length - y.length)) if (fs.existsSync(log)) fromLog(log, path.relative(found.root, log).split(path.sep).join("/"), out);
  for (const a of assets) {
    const made = out.get(path.resolve(a.file));
    if (!made) continue;
    a.made = made;
    const kind = a.type === "audio" && !a.error ? SOUND_OF[made.operation] : undefined;
    if (kind) {
      a.kind = kind;
      a.reason = SPRITE_OPS.has(made.operation) ? `the sound Ludo's ${made.operation} made with its sheet (${made.record})` : `made by Ludo's ${made.operation} (${made.record})`;
    }
  }
}

// ---- Groups and duplicates ----

// Words that say which move a sheet is, and words that say nothing about
// the character (Ludo's download names, "sheet").
const ACTIONS = new Set(
  (
    "idle walk run jump attack hit hurt die death dead fall land climb crouch dash roll block cast shoot throw punch kick slash swing spin fly " +
    "swim talk emote dance victory win lose spawn sleep sit push pull pickup use interact reload aim fire charge guard dodge stun turn move " +
    "strafe sprint crawl slide wave laugh cry eat drink celebrate taunt special skill combo heavy light roar smash slam stomp bite howl growl hop"
  ).split(" ")
);
const GENERIC = new Set(["animatesprite", "adjustspritesheet", "editspritesheet", "transfermotion", "spritesheet", "spritesheets", "sheet", "sheets", "sprite", "sprites", "anim", "anims", "animation", "animations", "frames", "take", "v"]);
// Words that say which way or how a move plays, not who makes it:
// hero_walk_left and hero_walk_right are one hero, mt_walk_loop and
// mt_walk_forward one character. "ts" is a True Size copy (sprite adjust).
const VARIANTS = new Set(
  "left right up down front back side forward forwards backward backwards north south east west n s e w ne nw se sw loop loops looped looping cycle once start end ts".split(" ")
);

// The character a sheet shows and the move: hero_walk2.png -> hero, walk
// (take 2); hero_walk_left.png -> hero, walk (left). Hashes and numbers say
// nothing and are dropped. Once a name has said who, the words after its
// move say how the move plays (mt_idle_neutral is mt's idle); a name that
// starts with the move says who after it (attack_goblin). The deepest part
// of the path that names someone names the character: collide/knight-walk
// and compare/knight-walk are one knight; knight/attack.png is the knight's.
export function characterOf(rel: string): { character: string; action?: string; take?: number; variant?: string } {
  let keep: string[] = [];
  const variant: string[] = [];
  let action: string | undefined;
  let take: number | undefined;
  const tokens = withoutDownloadName(rel)
    .split("/")
    .map(segment => wordsIn(segment).filter(w => !(/^\d+$/.test(w) || (/^[0-9a-f]{8,}$/.test(w) && /\d/.test(w)) || GENERIC.has(w))));
  const moving = tokens.some(seg => seg.some(w => ACTIONS.has(/^([a-z]+?)\d*$/.exec(w)?.[1] ?? "")));
  for (const segment of tokens) {
    let moved = false;
    const own: string[] = [];
    const after: string[] = [];
    for (const w of segment) {
      const m = /^([a-z]+?)(\d+)?$/.exec(w);
      if (m && ACTIONS.has(m[1])) {
        action = action ? `${action}_${m[1]}` : m[1];
        if (m[2]) take = Number(m[2]);
        moved = true;
      } else if (moving && VARIANTS.has(w)) variant.push(w);
      else (moved ? after : own).push(w);
    }
    if (own.length || keep.length) variant.push(...after);
    else own.push(...after);
    if (own.length) keep = own;
  }
  return {
    character: [...new Set(keep)].join("_"),
    ...(action ? { action } : {}),
    ...(take ? { take } : {}),
    ...(variant.length ? { variant: variant.join("_") } : {})
  };
}

// The move without its kind: attack_heavy is an attack.
const baseMove = (action: string) => action.split("_")[0];

export interface Group {
  character: string;
  frame_width: number; // the median of the sheets'
  frame_height: number;
  animations: { path: string; action: string | null; take?: number; variant?: string; frames: number; frame_width: number; frame_height: number }[];
}

// Sheets of one character: the same words once the move is taken out, and
// frames of about the same height (within 25%: a take redrawn larger is
// still the character; a sheet twice as tall is something else). A PNG and
// the WebP of one download count once, as the PNG.
export function groupsOf(assets: Asset[], plan?: LoadPlan): Group[] {
  const by = new Map<string, Asset[]>();
  for (const a of assets) {
    if (a.kind !== "spritesheet" || !a.grid || (plan && !isShown(a, plan))) continue;
    const { character } = characterOf(a.path);
    if (!character) continue;
    by.set(character, [...(by.get(character) ?? []), a]);
  }
  const out: Group[] = [];
  for (const [character, list] of by) {
    const sorted = [...list].sort((x, y) => x.grid!.frame_height - y.grid!.frame_height);
    const clusters: Asset[][] = [];
    for (const a of sorted) {
      const last = clusters[clusters.length - 1];
      if (last && a.grid!.frame_height <= last[0].grid!.frame_height * 1.25) last.push(a);
      else clusters.push([a]);
    }
    for (const c of clusters) {
      if (c.length < 2) continue;
      const median = (vs: number[]) => vs.sort((x, y) => x - y)[Math.floor(vs.length / 2)];
      out.push({
        character: clusters.filter(x => x.length >= 2).length > 1 ? `${character}_${c[0].grid!.frame_height}px` : character,
        frame_width: median(c.map(a => a.grid!.frame_width)),
        frame_height: median(c.map(a => a.grid!.frame_height)),
        animations: c
          .sort((x, y) => natural.compare(x.path, y.path))
          .map(a => {
            const { action, take, variant } = characterOf(a.path);
            return { path: a.path, action: action ?? null, ...(take ? { take } : {}), ...(variant ? { variant } : {}), frames: a.grid!.frames, frame_width: a.grid!.frame_width, frame_height: a.grid!.frame_height };
          })
      });
    }
  }
  return out.sort((x, y) => natural.compare(x.character, y.character));
}

export interface Duplicate {
  match: "identical" | "looks the same";
  files: string[];
  difference?: number; // the most bits of one frame's perceptual hash that differ, 0-1
}

// Byte-identical files, then pictures that look the same: the same number
// of frames of about the same shape, whose hashed frames differ in 6 of
// their 64 bits or fewer on average and in no frame by more than 10 (a
// re-encode, a PNG and its WebP, a copy at half size: up to 9 in a frame).
// Two moves of one character share their first pose but differ by 15 to 18
// bits in some frames, 11 to 13 on average.
export function duplicatesOf(assets: Asset[]): Duplicate[] {
  const out: Duplicate[] = [];
  const bySha = new Map<string, Asset[]>();
  for (const a of assets) bySha.set(a.sha256, [...(bySha.get(a.sha256) ?? []), a]);
  for (const list of bySha.values()) if (list.length > 1) out.push({ match: "identical", files: list.map(a => a.path) });
  const pics = [...bySha.values()].map(l => l[0]).filter(a => a.phash);
  const parent = pics.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const worst = new Map<number, number>();
  const shape = (a: Asset) => (a.grid ? a.grid.frame_width / a.grid.frame_height : a.width! / a.height!);
  for (let i = 0; i < pics.length; i++) {
    for (let j = i + 1; j < pics.length; j++) {
      const [p, q] = [pics[i], pics[j]];
      if ((p.frames ?? 1) !== (q.frames ?? 1) || Math.abs(shape(p) / shape(q) - 1) > 0.03) continue;
      let d = 0;
      let total = 0;
      for (let k = 0; k < p.phash!.length; k += 64) {
        const n = hamming(p.phash!.subarray(k, k + 64), q.phash!.subarray(k, k + 64));
        d = Math.max(d, n);
        total += n;
      }
      if (d > 10 || total / (p.phash!.length / 64) > 6) continue;
      parent[find(j)] = find(i);
      worst.set(i, Math.max(worst.get(i) ?? 0, d));
      worst.set(j, Math.max(worst.get(j) ?? 0, d));
    }
  }
  const sets = new Map<number, number[]>();
  pics.forEach((_, i) => sets.set(find(i), [...(sets.get(find(i)) ?? []), i]));
  for (const members of sets.values()) {
    if (members.length < 2) continue;
    out.push({ match: "looks the same", files: members.flatMap(i => bySha.get(pics[i].sha256)!.map(a => a.path)), difference: round(Math.max(...members.map(i => worst.get(i) ?? 0)) / 64, 3) });
  }
  return out;
}

// What the JSON carries of an asset: everything but where it is on disk and
// its hash bits.
const publicAsset = ({ file, phash, clipTargets, made, ...rest }: Asset) => ({
  ...rest,
  ...(made ? { made: { operation: made.operation, ...(made.job ? { job: made.job } : {}), ...(made.created ? { created_at: new Date(made.created).toISOString() } : {}), ...(made.model ? { model: made.model } : {}), record: made.record } } : {})
});

// ---- Loader code for engines ----

// A key from the path, stable as long as the path is: lower-case words
// joined by "_", starting with a letter. A file Ludo named on download
// (animateSprite-29402c81-1.png) takes its folder's name instead when the
// folder holds that one generation only, as the CLI saves it; in a models/
// that holds other files too, the folder names none of them. Files that
// only differ by extension take it on.
export function assetKeys(paths: string[]): string[] {
  const stem = (rel: string) => path.posix.basename(rel).replace(/\.[^.]+$/, "");
  const job = (rel: string) => (LUDO_DOWNLOAD.test(stem(rel)) ? stem(rel).replace(/-\d+$/, "") : stem(rel));
  const jobsIn = new Map<string, Set<string>>();
  for (const rel of paths) {
    const dir = path.posix.dirname(rel);
    jobsIn.set(dir, (jobsIn.get(dir) ?? new Set()).add(job(rel)));
  }
  const keyOf = (rel: string) => {
    const onlyJob = jobsIn.get(path.posix.dirname(rel))!.size === 1;
    const key = (onlyJob ? withoutDownloadName(rel) : rel.replace(/\.[^./]+$/, ""))
      .replace(/\//g, "_")
      .replace(/([a-z])([A-Z])/g, "$1_$2")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    return /^[a-z]/.test(key) ? key : `asset_${key}`;
  };
  const keys = paths.map(keyOf);
  const count = new Map<string, number>();
  keys.forEach(k => count.set(k, (count.get(k) ?? 0) + 1));
  const withExt = keys.map((k, i) => (count.get(k)! > 1 ? `${k}_${path.extname(paths[i]).slice(1).toLowerCase()}` : k));
  // Two files that still collide (a.png in two spellings) are numbered.
  const used = new Map<string, number>();
  return withExt.map(k => {
    const n = (used.get(k) ?? 0) + 1;
    used.set(k, n);
    return n > 1 ? `${k}_${n}` : k;
  });
}

// hero_walk -> HeroWalk, unique among `taken`.
function pascal(key: string, taken: Set<string>): string {
  const base = key
    .split("_")
    .filter(Boolean)
    .map(w => w[0].toUpperCase() + w.slice(1))
    .join("");
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}${n}`;
  taken.add(name);
  return name;
}

const EMITS = ["phaser", "pixi", "json"] as const;
type Emit = (typeof EMITS)[number];
const HEADER = "Generated by `ludo toolbox asset manifest`: run it again rather than editing this file.";
const quote = (s: string) => JSON.stringify(s);
const num = (v: number) => String(round(v, 3));
const joinUrl = (base: string, rel: string) => (!base ? rel : base.endsWith("/") ? `${base}${rel}` : `${base}/${rel}`);
const quoted = (file: string) => (/^[\w./@:+-]+$/.test(file) ? file : `"${file.replace(/(["\\$`])/g, "\\$1")}"`);

// Where the folder sits for a page, which loads files relative to itself:
// --base, else the folder's path from here when it is inside the working
// folder, else its name.
function baseFor(root: string, flag: string | undefined): { base: string; guessed: boolean } {
  if (flag !== undefined) return { base: flag, guessed: false };
  const rel = path.relative(process.cwd(), root);
  const inside = !rel.startsWith("..") && !path.isAbsolute(rel);
  return { base: inside ? rel.split(path.sep).join("/") : path.basename(path.resolve(root)), guessed: !inside };
}

// What the loaders queue of the duplicates: one file of each set of the
// same file, either byte for byte, or one picture under one name in two
// formats (the WebP Ludo sends and the PNG copy the CLI writes beside it,
// animateSprite-29402c81-1.webp and -1.png), at one size: the smallest, with
// its twin's grid when only the twin carries the Ludo stamp. Pictures that
// only look alike stay, whatever the hash says: two moves of one small
// character can hash alike, and a 2x take may be meant.
export interface LoadPlan {
  left: Map<Asset, Asset>; // left out -> the file queued instead
  grid: Map<Asset, SheetGrid>; // a queued sheet's grid, from its twin's stamp
  shown: Map<Asset, Asset>; // each file of such a set -> the one reports name: the stamped PNG, else the first
}

const stem = (a: Asset) => a.path.replace(/\.[^./]+$/, "");

export function loadPlan(assets: Asset[], duplicates: Duplicate[]): LoadPlan {
  const byPath = new Map(assets.map(a => [a.path, a]));
  const index = new Map(assets.map((a, i) => [a, i]));
  const parent = assets.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const join = (a: Asset, b: Asset) => (parent[find(index.get(b)!)] = find(index.get(a)!));
  for (const d of duplicates) {
    const files = d.files.map(f => byPath.get(f)!);
    for (const a of files) {
      for (const b of files) {
        if (a === b) continue;
        if (d.match === "identical" || (a.type === "image" && b.type === "image" && stem(a) === stem(b) && a.width === b.width && a.height === b.height)) join(a, b);
      }
    }
  }
  const sets = new Map<number, Asset[]>();
  assets.forEach((a, i) => sets.set(find(i), [...(sets.get(find(i)) ?? []), a]));
  const left = new Map<Asset, Asset>();
  const grid = new Map<Asset, SheetGrid>();
  const shown = new Map<Asset, Asset>();
  for (const same of sets.values()) {
    if (same.length < 2) continue;
    const keep = same.reduce((x, y) => (y.bytes < x.bytes ? y : x));
    for (const a of same) if (a !== keep) left.set(a, keep);
    const stamp = same.find(a => a.grid?.from === "stamp")?.grid;
    const own = keep.grid;
    if (stamp && own && own.from !== "stamp" && own.cols === stamp.cols && own.rows === stamp.rows && own.frames === stamp.frames) grid.set(keep, stamp);
    const named = same.find(a => a.grid?.from === "stamp") ?? same.find(a => a.format === "png") ?? same[0];
    for (const a of same) shown.set(a, named);
  }
  return { left, grid, shown };
}

// Whether reports name this file: one file of each set the loaders take once.
const isShown = (a: Asset, plan: LoadPlan) => (plan.shown.get(a) ?? a) === a;

const leftNote = (a: Asset, kept: Asset) => `${a.path}: left out, the same ${a.sha256 === kept.sha256 ? "file" : "picture"} as ${kept.path} (loaders take the smallest of duplicates)`;

// Phaser gets both forms of one list: the asset pack, which any Phaser 3 or 4
// project loads in one line (this.load.pack), JavaScript or TypeScript; and a
// TypeScript module, whose AssetKey enum turns a mistyped key into a compile
// error and whose SHEETS carry the frame rates anims.create needs (a pack
// has no place for them, so its `meta`, which Phaser skips, holds them too).
function emitPhaser(assets: Asset[], keys: string[], base: string, plan: LoadPlan): { texts: string[]; notes: string[] } {
  const notes: string[] = [];
  const taken = new Set<string>();
  const queued = assets.filter(a => !plan.left.has(a));
  const names = new Map(queued.map(a => [a, pascal(keys[assets.indexOf(a)], taken)]));
  const loads: string[] = [];
  const sheets: string[] = [];
  const pack: Record<string, unknown>[] = [];
  const rates: Record<string, { frames: number; frameRate: number | null }> = {};
  assets.forEach((a, i) => {
    const key = `AssetKey.${names.get(a)}`;
    const url = quote(a.path);
    if (a.error) return loads.push(`  // ${a.path}: not read (${a.error})`);
    const kept = plan.left.get(a);
    if (kept) {
      notes.push(leftNote(a, kept));
      return loads.push(`  // ${a.path}: left out, the same picture as ${kept.path}`);
    }
    if (a.type === "image") {
      const g = plan.grid.get(a) ?? a.grid;
      if (a.animated) {
        notes.push(`${a.path}: an animated ${a.animated.toUpperCase()}; browsers give Phaser its first frame only, so it is loaded as an image. As a PNG sheet: ludo toolbox image convert ${quoted(a.path)} --to png`);
        loads.push(`  scene.load.image(${key}, ${url}); // its first frame only: an animated ${a.animated.toUpperCase()}`);
        pack.push({ type: "image", key: keys[i], url: a.path });
      } else if (g && a.kind === "spritesheet") {
        const uneven = a.width! % g.cols || a.height! % g.rows;
        if (uneven) notes.push(`${a.path}: ${a.width}x${a.height} does not divide into ${g.cols}x${g.rows} equal frames, and Phaser cuts at whole frame sizes`);
        loads.push(`  scene.load.spritesheet(${key}, ${url}, { frameWidth: ${g.frame_width}, frameHeight: ${g.frame_height}, endFrame: ${g.frames - 1} });${g.from === "detected" ? ` // grid detected, ${Math.round(g.confidence! * 100)}% sure` : ""}`);
        sheets.push(`  [${key}]: { frames: ${g.frames}, frameRate: ${g.fps ? num(g.fps) : "undefined"} },`);
        pack.push({ type: "spritesheet", key: keys[i], url: a.path, frameConfig: { frameWidth: g.frame_width, frameHeight: g.frame_height, endFrame: g.frames - 1 } });
        rates[keys[i]] = { frames: g.frames, frameRate: g.fps ? round(g.fps, 3) : null };
      } else {
        loads.push(`  scene.load.image(${key}, ${url});`);
        pack.push({ type: "image", key: keys[i], url: a.path });
      }
    } else if (a.type === "audio") {
      loads.push(`  scene.load.audio(${key}, ${url});`);
      pack.push({ type: "audio", key: keys[i], url: a.path });
    } else if (a.type === "video") {
      loads.push(`  scene.load.video(${key}, ${url});`);
      pack.push({ type: "video", key: keys[i], url: a.path });
    } else loads.push(`  // ${a.path}: a 3D model; Phaser has no glTF loader`);
  });
  const ts = [
    `// ${HEADER}`,
    `// Every asset in ${base || "the folder"}, queued on a scene's loader: call preload(this) from your scene's preload().`,
    `import type { Scene } from "phaser";`,
    "",
    "export enum AssetKey {",
    ...queued.map(a => `  ${names.get(a)} = ${quote(keys[assets.indexOf(a)])},`),
    "}",
    "",
    `/** Queues every asset; the paths are relative to \`path\`. */`,
    `export function preload(scene: Scene, path = ${quote(joinUrl(base, ""))}): void {`,
    "  const previous = scene.load.path;",
    "  scene.load.setPath(path);",
    ...loads,
    "  scene.load.setPath(previous);",
    "}",
    "",
    "/** Each spritesheet's frame count and frame rate (undefined where the file does not say), for anims.create. */",
    "export const SHEETS: Partial<Record<AssetKey, { frames: number; frameRate: number | undefined }>> = {",
    ...sheets,
    "};",
    ""
  ].join("\n");
  const packJson = {
    meta: { generated: HEADER, usage: 'this.load.pack("<any key>", "<url of this file>")', sheets: rates },
    assets: { ...(base ? { path: joinUrl(base, "") } : {}), files: pack }
  };
  return { texts: [JSON.stringify(packJson, null, 2) + "\n", ts], notes };
}

// A PixiJS 8 manifest for Assets.init({ manifest }), a bundle per kind of
// asset. A sheet loads as its frames when a TexturePacker atlas sits next to
// it (`sprite export --engine texturepacker` writes one); sounds need the
// @pixi/sound extension.
function emitPixi(assets: Asset[], keys: string[], base: string, plan: LoadPlan): { texts: string[]; notes: string[] } {
  const notes: string[] = [];
  const bundles = new Map<string, { alias: string; src: string }[]>();
  const add = (bundle: string, alias: string, src: string) => bundles.set(bundle, [...(bundles.get(bundle) ?? []), { alias, src: joinUrl(base, src) }]);
  assets.forEach((a, i) => {
    if (a.error) return;
    const kept = plan.left.get(a);
    if (kept) return notes.push(leftNote(a, kept));
    if (a.type === "image") {
      if (a.kind === "spritesheet" && !a.animated) {
        const atlas = a.path.replace(/\.[^./]+$/, ".json");
        if (fs.existsSync(path.join(path.dirname(a.file), path.basename(atlas)))) return add("spritesheets", keys[i], atlas);
        notes.push(`${a.path}: loads as one texture; for its frames, write an atlas next to it: ludo toolbox sprite export ${quoted(shown(a.file))} --engine texturepacker`);
      }
      if (a.animated) notes.push(`${a.path}: an animated ${a.animated.toUpperCase()} loads as its first frame`);
      return add(a.kind === "spritesheet" ? "spritesheets" : a.kind === "texture" ? "textures" : "images", keys[i], a.path);
    }
    if (a.type === "audio") {
      if (!notes.some(n => n.startsWith("Sounds:"))) notes.push("Sounds: PixiJS loads them with the @pixi/sound extension");
      return add("sounds", keys[i], a.path);
    }
    if (a.type === "video") return add("videos", keys[i], a.path);
    notes.push(`${a.path}: left out (PixiJS draws 2D; it has no glTF loader)`);
  });
  const manifest = { bundles: [...bundles].map(([name, list]) => ({ name, assets: list })) };
  return { texts: [JSON.stringify(manifest, null, 2) + "\n"], notes };
}

const EMIT_FILES: Record<Emit, string[]> = { phaser: ["assets-pack.json", "assets.ts"], pixi: ["assets-manifest.json"], json: ["assets.json"] };

// Loader code is regenerated from the folder, so it overwrites its own
// earlier copy, as engine files do. --name replaces the "assets" in each name.
// Keys come from the files it queues: a WebP whose PNG copy is left out
// keeps the plain key.
function emit(ctx: Ctx, engine: Emit, root: string, assets: Asset[], manifest: unknown, plan: LoadPlan, baseFlag: string | undefined): Emitted {
  const queued = assets.filter(a => !plan.left.has(a));
  const queuedKeys = assetKeys(queued.map(a => a.path));
  const keys = assets.map(a => (plan.left.has(a) ? "" : queuedKeys[queued.indexOf(a)]));
  const { base, guessed } = baseFor(root, baseFlag);
  const out = engine === "phaser" ? emitPhaser(assets, keys, base, plan) : engine === "pixi" ? emitPixi(assets, keys, base, plan) : { texts: [JSON.stringify(manifest, null, 2) + "\n"], notes: [] };
  if (guessed && engine !== "json") out.notes.unshift(`The folder is outside the working folder: the URLs take it as ${base}/. Pass --base <its URL path> otherwise.`);
  const files = EMIT_FILES[engine].map((name, i) => {
    const file = path.join(ctx.outDir, ctx.globals.name ? `${ctx.globals.name}${name.slice("assets".length)}` : name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, out.texts[i]);
    return file;
  });
  return { files, notes: out.notes };
}

interface Emitted {
  files: string[];
  notes: string[];
}

// ---- What the folder is missing ----

// What a folder visibly lacks next to what the rest of it has, each with the
// Ludo command that makes it. Every gap needs evidence in the folder: other
// characters with the move, sheets of the character that have their sounds,
// Ludo's own record or video of a sheet made without one, models that are
// rigged or animated. A folder with one of each thing shows none.
export interface Gap {
  kind: "animation" | "sound" | "rig" | "3d-animation";
  subject: string; // the character, or the file
  missing: string; // the move, or "sound", "rig", "animation"
  detail: string;
  evidence: string[]; // the files that show it is expected
  also?: string[]; // other files the gap is for: the other sheets of one move
  hint: Hint; // built plainly: only the one printed as Next counts as shown
}

const list = (xs: string[]) => (xs.length < 3 ? xs.join(" and ") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

// A file Ludo's CLI downloaded (animateSprite-29402c81-1.png): its folder
// and job, which every file of that job shares (-2.mp4, -3.mp3, -audio.mp3).
const jobOf = (a: Asset) => {
  const name = path.posix.basename(a.path).replace(/\.[^.]+$/, "");
  return LUDO_DOWNLOAD.test(name) ? `${path.posix.dirname(a.path)}/${name.replace(/-\d+$/, "")}-` : undefined;
};
// A file's name without a trailing number: what a job's files share when
// saved as <name>_<n> (anim_attack_0.webp, anim_attack_1.mp4, anim_attack_2.mp3).
const unnumbered = (a: Asset) => stem(a).replace(/[-_]\d+$/, "");
// Two files of one generation: one job in the folder's records, or by the
// CLI's download names, or one name in one folder but for a trailing number
// (hero_walk.png and hero_walk-2.mp3).
const sameJob = (sheet: Asset, other: Asset) => {
  if (sheet.made?.job && sheet.made.job === other.made?.job) return true;
  const job = jobOf(sheet);
  if (job) return `${path.posix.dirname(other.path)}/${path.posix.basename(other.path)}`.startsWith(job);
  return path.posix.dirname(sheet.path) === path.posix.dirname(other.path) && [stem(sheet), unnumbered(sheet)].includes(unnumbered(other));
};

// A sound for a sheet: one of its job's files, or one named for its
// character and move (hero_walk.png and sfx/hero_walk_steps.wav).
function soundFor(sheet: Asset, sounds: Asset[]): Asset | undefined {
  const s = characterOf(sheet.path);
  return (
    sounds.find(a => sameJob(sheet, a)) ??
    sounds.find(a => {
      const c = characterOf(a.path);
      const words = new Set(c.character.split("_"));
      return !!s.action && !!s.character && !!c.action && baseMove(c.action) === baseMove(s.action) && s.character.split("_").every(w => words.has(w));
    })
  );
}

// Characters whose names nest (hero and hero_ts, mt and mt_neutral) may be
// one character under two names: neither counts for or against the other.
const nested = (a: string, b: string) => {
  const [x, y] = [a.split("_"), b.split("_")];
  return x.every(w => y.includes(w)) || y.every(w => x.includes(w));
};

// create-audio, by its own help: the video_url of a sheet from one of these,
// made in the last 7 days.
const CREATE_AUDIO_TAKES = ["animateSprite", "animateSpriteKeyframes", "transferMotion", "editSpritesheet"];
const CREATE_AUDIO_DAYS = 7;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

// The way to a sound for sheets of one move: create-audio when it takes
// every one of them, else a sound effect, saying why.
function soundHint(group: Asset[], ludo: boolean, sheets = group.length): Hint {
  const { character, action } = characterOf(group[0].path);
  const many = group.length > 1;
  const effect = (why: string): Hint => ({
    text: many ? `Make the sound of ${character}'s ${baseMove(action!)} with Ludo, one for its ${sheets} sheets${why}` : `Make its sound with Ludo${why}`,
    command: `ludo audio sound-effect --description ${quote(`<what ${character || "it"}${action ? ` doing ${action.replace(/_/g, " ")}` : ""} sounds like>`)}`
  });
  if (!ludo) return effect("");
  const from = `create-audio takes the video_url of a sheet from ${CREATE_AUDIO_TAKES.slice(0, -1).join(", ")} or ${CREATE_AUDIO_TAKES[CREATE_AUDIO_TAKES.length - 1]}`;
  const recent = `create-audio takes only sheets made in the last ${CREATE_AUDIO_DAYS} days`;
  const ops = [...new Set(group.map(a => a.made?.operation).filter((o): o is string => !!o && !CREATE_AUDIO_TAKES.includes(o)))];
  const old = group.map(a => a.made?.created).filter((c): c is number => !!c && Date.now() - c > CREATE_AUDIO_DAYS * 86400e3);
  if (ops.length && group.every(a => a.made && !CREATE_AUDIO_TAKES.includes(a.made.operation))) return effect(`: ${from}, and ${many ? "these are" : "this one is"} from ${list(ops)}`);
  if (old.length === group.length) return effect(`: ${recent}, and ${many ? `these were made by ${day(Math.max(...old))}` : `this one was made on ${day(old[0])}`}`);
  if (ops.length || old.length) return effect(ops.length ? `: ${from}, and some are from ${list(ops)}` : `: ${recent}, and some were made before ${day(Date.now() - CREATE_AUDIO_DAYS * 86400e3)}`);
  const made = group[0].made;
  if (!many && made?.video && made.created) return { text: `Give it a sound with Ludo, from the video_url its job record keeps (${made.video.record}; made on ${day(made.created)})`, command: `ludo sprite create-audio --spritesheet-video-url ${made.video.url}` };
  const dates = group.map(a => a.made?.created).filter((c): c is number => !!c);
  return {
    text: `Give ${many ? "each" : "it"} a sound with Ludo: create-audio takes ${many ? "a" : "the"} sheet's video_url, for a sheet made in the last ${CREATE_AUDIO_DAYS} days${dates.length ? ` (${many ? "these" : "this one"}: ${[...new Set(dates.map(day))].join(", ")})` : ""} (ludo generations list --type spritesheet lists them)`,
    command: "ludo sprite create-audio --spritesheet-video-url <its video_url>"
  };
}

// A GLB's rig is here when a rigged mesh has its geometry (ludo model rig's
// help: rigging is non-destructive to geometry), or the log says a rigged
// file was made from it.
function riggedTwin(m: Asset, rigged: Asset[]): Asset | undefined {
  const near = (x: number[] | undefined, y: number[] | undefined) => !!x && !!y && x.every((v, i) => Math.abs(v - y[i]) <= 0.01 * Math.max(...x.map(Math.abs), ...y.map(Math.abs)));
  return rigged.find(r => (r.made?.operation === "rigModel" && r.made.inputs.includes(path.resolve(m.file))) || (r.model!.triangles === m.model!.triangles && r.model!.vertices === m.model!.vertices && near(r.model!.size, m.model!.size)));
}

export function gapsOf(assets: Asset[], plan: LoadPlan): Gap[] {
  const gaps: Gap[] = [];
  // One file of each set the loaders take once, the PNG of a download's PNG and WebP.
  const kept = assets.filter(a => !a.error && isShown(a, plan));
  const sheets = kept.filter(a => a.kind === "spritesheet");

  // Moves: each character's first sheet of each, by name. Directions, loops
  // and takes are the move played another way, not another move.
  const chars = new Map<string, Map<string, Asset>>();
  for (const a of sheets) {
    const { character, action } = characterOf(a.path);
    if (!character || !action) continue;
    const moves = chars.get(character) ?? new Map<string, Asset>();
    if (!moves.has(baseMove(action))) moves.set(baseMove(action), a);
    chars.set(character, moves);
  }
  for (const [c, have] of chars) {
    const others = [...chars].filter(([o]) => !nested(o, c));
    const wanted = [...new Set(others.flatMap(([, m]) => [...m.keys()]))].sort(natural.compare);
    for (const move of wanted) {
      const holders = others.filter(([, m]) => m.has(move));
      // Two other characters at least, and more than half of them: one
      // hero's attack says nothing of what an NPC needs.
      if (have.has(move) || holders.length < 2 || holders.length * 2 <= others.length) continue;
      const sheet = [...have.values()][0];
      gaps.push({
        kind: "animation",
        subject: c,
        missing: move,
        detail: `${c} has ${list([...have.keys()])} but no ${move}, which ${list(holders.map(([o]) => o))} have`,
        evidence: holders.map(([, m]) => m.get(move)!.path),
        hint: { text: `Animate ${c}'s ${move} with Ludo, from one of its frames (ludo toolbox sprite slice ${quoted(shown(sheet.file))} cuts them)`, command: `ludo sprite animate --initial-image <a frame of ${c}> --motion-prompt ${quote(move)}` }
      });
    }
  }

  // Sounds: a sheet without one, when sheets of its character have theirs,
  // or when Ludo made it without one (its record names forge or forge-pixel,
  // or its download kept the video but no audio). A sheet made by sprite
  // adjust has its source's sound when the source has one (its help says
  // so), and goes with its source when that is here by name. The sheets of
  // one move (its directions, loops and takes) that lack one for one reason
  // are one gap: one sound serves the move.
  const sounds = assets.filter(a => a.type === "audio");
  const videos = assets.filter(a => a.type === "video");
  const adjusted = (a: Asset) => a.made?.operation === "adjustSpritesheet";
  const move = (a: Asset) => {
    const c = characterOf(a.path);
    return c.character && c.action ? `${c.character} ${c.action} ${c.take ?? 1}` : undefined;
  };
  const sourceOf = (a: Asset) => (adjusted(a) && move(a) ? sheets.find(s => s !== a && !adjusted(s) && move(s) === move(a)) : undefined);
  const own = (a: Asset): string | undefined => soundFor(a, sounds)?.path ?? (a.made?.audio ? a.made.record : undefined);
  const soundOf = (a: Asset): string | undefined => {
    const src = sourceOf(a);
    return own(a) ?? (src ? own(src) : undefined);
  };
  type Why = { kind: string; why: (many: boolean) => string; evidence: string[] };
  const lacking = new Map<string, { sheets: Asset[]; whys: Why[]; ludo: boolean; character: string; move?: string }>();
  for (const sheet of sheets) {
    if (soundOf(sheet) || sourceOf(sheet)) continue;
    const { character, action } = characterOf(sheet.path);
    const kin = character ? sheets.filter(s => s !== sheet && characterOf(s.path).character === character && soundOf(s)) : [];
    const video = videos.find(v => sameJob(sheet, v));
    const model = sheet.made?.model && /^forge/.test(sheet.made.model) ? sheet.made.model : undefined;
    const ludo = (plan.grid.get(sheet) ?? sheet.grid)?.from === "stamp" || !!jobOf(sheet) || !!sheet.made;
    const why: Why | undefined = adjusted(sheet)
      ? { kind: "adjust", why: many => `: sprite adjust made ${many ? "them" : "it"}, and a copy carries its source's sound only when the source has one`, evidence: [sheet.made!.record] }
      : ludo && model
        ? { kind: `model ${model}`, why: many => `: ${many ? "they were" : "it was"} made with ${model}`, evidence: [sheet.made!.record] }
        : ludo && video
          ? { kind: "video", why: many => (many ? ": their Ludo downloads have their videos but no audio" : `: its Ludo download has its video (${video.path}) but no audio`), evidence: [video.path] }
          : kin.length
            ? { kind: "kin", why: () => `, while ${kin.length} other sheet${kin.length === 1 ? ` of ${character} has its` : `s of ${character} have theirs`}`, evidence: kin.slice(0, 3).map(s => soundOf(s)!) }
            : undefined;
    if (!why) continue;
    const key = character && action ? `${character}\u0000${baseMove(action)}\u0000${ludo}` : sheet.path;
    const at = lacking.get(key);
    if (at) {
      at.sheets.push(sheet);
      at.whys.push(why);
    } else lacking.set(key, { sheets: [sheet], whys: [why], ludo, character, ...(action ? { move: baseMove(action) } : {}) });
  }
  for (const { sheets: same, whys, ludo, character, move: m } of lacking.values()) {
    const [first, ...rest] = same;
    const kinds = [...new Set(whys.map(w => w.kind))];
    const why = kinds.length === 1 ? whys[0].why(rest.length > 0) : kinds.every(k => k !== "kin") ? ": Ludo made them, and their records and downloads have no audio" : ": none of them has one here";
    const copies = sheets.filter(s => same.includes(sourceOf(s)!)).map(s => s.path);
    const also = [...rest.map(s => s.path), ...copies];
    const who = rest.length ? `${first.path} and ${rest.length} other sheet${rest.length === 1 ? "" : "s"} of ${character}'s ${m}` : first.path;
    gaps.push({
      kind: "sound",
      subject: first.path,
      missing: "sound",
      detail: `${who} ${rest.length ? "have" : "has"} no sound${why}${copies.length ? ` (nor ${copies.length === 1 ? "has" : "have"} ${copies.length === 1 ? copies[0] : `${copies.length} sheets`}, ${copies.length === 1 ? "its sprite adjust copy" : "their sprite adjust copies"} by name)` : ""}`,
      evidence: [...new Set(whys.flatMap(w => w.evidence))],
      ...(also.length ? { also } : {}),
      hint: soundHint(same, ludo, same.length + copies.length)
    });
  }

  // Models: a mesh without a skeleton, when others here are rigged or
  // animated and none of them is its own rig; a rigged mesh with no clip,
  // in it or in an animation file whose bones are its own (Ludo's
  // animations come as such files).
  const models = kept.filter(a => a.model);
  const meshes = models.filter(a => a.model!.triangles > 0);
  const clipFiles = models.filter(a => a.model!.triangles === 0 && a.model!.clips.length);
  const rigged = meshes.filter(a => a.model!.rigged);
  for (const m of meshes) {
    if (m.model!.rigged || m.model!.clips.length || m.format !== "glb" || riggedTwin(m, rigged)) continue;
    const evidence = [...rigged, ...clipFiles].map(a => a.path);
    if (!evidence.length) continue;
    gaps.push({
      kind: "rig",
      subject: m.path,
      missing: "rig",
      detail: `${m.path} has no skeleton, while ${list(evidence.slice(0, 3))} ${evidence.length === 1 ? "is" : "are"} rigged or animated (and no rigged mesh here has its geometry)`,
      evidence,
      hint: { text: "Rig it with Ludo, so it can be animated", command: `ludo model rig --model ${quoted(shown(m.file))}` }
    });
  }
  for (const m of rigged) {
    if (m.model!.clips.length) continue;
    const joints = new Set(m.model!.joints);
    const moves = (c: Asset) => c.clipTargets!.filter(t => joints.has(t)).length >= 0.8 * c.clipTargets!.length && c.clipTargets!.length > 0;
    if (clipFiles.some(moves)) continue;
    gaps.push({
      kind: "3d-animation",
      subject: m.path,
      missing: "animation",
      detail: `${m.path} is rigged (${joints.size} joints) but has no clip, and no animation file here moves its bones`,
      evidence: [m.path],
      hint: { text: "Animate it with Ludo: a preset (its id from ludo sprite list-animation-presets), or from a prompt with ludo model animate", command: `ludo model animate-preset --model ${quoted(shown(m.file))} --preset-id <id>` }
    });
  }
  return gaps;
}

// ---- asset manifest ----

const describeAsset = (a: Asset) => {
  if (a.error) return `unreadable: ${a.error}`;
  const bits: string[] = [];
  if (a.grid) bits.push(`${a.grid.frames} frames of ${a.grid.frame_width}x${a.grid.frame_height} (${a.grid.cols}x${a.grid.rows})${a.fps ? ` at ${a.fps} fps` : ""}`);
  else if (a.width) bits.push(`${a.width}x${a.height}`);
  if (a.audio) bits.push(`${a.duration} s, ${a.audio.channels === 1 ? "mono" : a.audio.channels === 2 ? "stereo" : `${a.audio.channels} ch`} ${round(a.audio.rate / 1000, 1)} kHz`);
  if (a.model) bits.push(`${a.model.triangles} triangles`);
  if (a.type === "video" && a.duration) bits.push(`${a.duration} s`);
  if (a.mismatch) bits.push(a.mismatch);
  return bits.join(", ");
};

const kb = (bytes: number) => (bytes >= 1024 * 1024 ? `${round(bytes / 1024 / 1024, 1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

export function readAll(found: Found): Asset[] {
  return found.files.map(f => readAsset(f.file, f.rel));
}

TOOLS.push({
  group: "asset",
  name: "manifest",
  args: "<folder or files...>",
  summary: "Say what every asset in a folder is and what the folder lacks, with the Ludo command that makes it; write loaders",
  details: [
    "Each file gets a kind, with the reason: spritesheet (its grid from the Ludo stamp, a GIF's or WebP's",
    "frames, or detection when it is sure), image, texture (opaque, and its edges meet when it repeats),",
    "sfx, music, voice or ambience (the Ludo job that made it when the folder records it; else words in",
    "the path; else by length, whether it wraps without a click, and how speech-like it is), model or",
    "video. With its size, frames, fps, length, bytes and sha256, and a note when its bytes are another",
    "format than its extension says. How Ludo made a file comes from the CLI's asset log",
    "(ludo-assets.json, in or above the folder) and job records beside the files (<name>_job.json, or",
    "the CLI's --json output). Groups are sheets of one character (the same name once the move, its",
    "direction, loop or take, like walk2 or walk_left, is taken out, and frames of about one height);",
    "duplicates are byte-identical files, or pictures whose frames all look the same.",
    "Gaps are what the folder lacks next to what the rest of it has, each with the Ludo command that",
    "makes it (nothing is generated here):",
    "  animation     a move that two or more, and most, of the other characters have: ludo sprite animate",
    "  sound         a move's sheets without their sound, when sheets of the character have theirs or",
    "                Ludo made them without one: ludo sprite create-audio (for the sheets it takes: from",
    "                animate, keyframes, transfer-motion or edit, made in the last 7 days), else ludo",
    "                audio sound-effect",
    "  rig           a GLB without a skeleton, when other models here are rigged or animated and none has",
    "                its geometry (rigging keeps it): ludo model rig",
    "  3d-animation  a rigged model with no clip, in it or in an animation file that moves its bones:",
    "                ludo model animate-preset, or ludo model animate",
    "A folder with one of each thing shows no gaps. Sound kinds are a first sort: check the reasons.",
    "--emit writes loaders to --out, overwriting their earlier copy, with keys from the paths. They take",
    "one file of each set of byte-identical files, or of one picture's PNG and WebP under one name (the",
    "smallest); pictures that only look alike are all loaded. They leave out what the engine cannot load:",
    "  phaser  assets-pack.json for this.load.pack(key, url), and assets.ts: typed AssetKey keys,",
    "          preload(scene), and SHEETS with each sheet's frames and fps for anims.create",
    "  pixi    assets-manifest.json: a PixiJS 8 manifest for Assets.init({ manifest })",
    "  json    assets.json: this manifest",
    "For Godot and Unity, write each sheet's engine files: ludo toolbox sprite export <sheet> --engine godot|unity"
  ],
  flags: [
    { flag: "--emit", value: "engine", description: "Write loaders: phaser, pixi or json (repeat for several)" },
    { flag: "--base", value: "path", description: "The folder's URL path in the game (default: the folder's path from here)" }
  ],
  async run(ctx: Ctx, call: ToolCall) {
    const emits = (call.lists.get("--emit") ?? []).map(e => e.toLowerCase());
    for (const e of emits) {
      if ((EMITS as readonly string[]).includes(e)) continue;
      const engine = e === "godot" || e === "unity" ? `. For ${e === "godot" ? "Godot" : "Unity"}, write each sheet's engine files: ludo toolbox sprite export <sheet> --engine ${e}` : "";
      throw new CliError(`--emit takes ${EMITS.join(", ")} (got "${e}")${engine}`, EXIT.USAGE);
    }
    const found = findAssets(call.args, "ludo toolbox asset manifest <folder> [--emit phaser|pixi|json]");
    const assets = readAll(found);
    madeOf(found, assets);
    const kinds: Record<string, number> = {};
    for (const a of assets) kinds[a.kind] = (kinds[a.kind] ?? 0) + 1;
    const duplicates = duplicatesOf(assets);
    const plan = loadPlan(assets, duplicates);
    const groups = groupsOf(assets, plan);
    const gaps = gapsOf(assets, plan);
    const manifest = {
      folder: shown(found.root),
      count: assets.length,
      bytes: assets.reduce((s, a) => s + a.bytes, 0),
      kinds,
      assets: assets.map(publicAsset),
      groups,
      duplicates,
      gaps,
      ...(found.skipped.length ? { skipped: found.skipped } : {})
    };
    const emitted = [...new Set(emits as Emit[])].map(e => emit(ctx, e, found.root, assets, manifest, plan, textFlag(call, "--base")));
    const notes = [...new Set(emitted.flatMap(e => e.notes))];
    const firstSheet = assets.find(a => a.kind === "spritesheet" && !a.animated && !plan.left.has(a));
    const next = gaps.length
      ? hint(gaps[0].hint.text, gaps[0].hint.command)
      : firstSheet
        ? hint("Write a sheet's engine files (godot, unity or texturepacker)", `ludo toolbox sprite export ${quoted(shown(firstSheet.file))} --engine ${emits.includes("pixi") ? "texturepacker" : "godot"}`)
        : hint("Write a loader for them", `ludo toolbox asset manifest ${quoted(shown(found.root))} --emit phaser`);
    if (ctx.jsonOut) {
      printJson({ ...manifest, ...(emitted.length ? { emitted: emitted.flatMap(e => e.files.map(shown)) } : {}), ...(notes.length ? { notes } : {}), ...(ctx.globals.quiet ? {} : { hint: next }) }, false);
      return EXIT.OK;
    }
    const width = Math.max(...assets.map(a => a.path.length));
    const out = (line: string) => process.stdout.write(line + "\n");
    out(`${assets.length} assets in ${shown(found.root)} (${kb(manifest.bytes)}): ${Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(", ")}`);
    for (const a of assets) out(`  ${a.path.padEnd(width)}  ${a.kind.padEnd(11)}  ${describeAsset(a)}${a.reason ? `  (${a.reason})` : ""}`);
    // One frame size when the sheets share it, else each sheet's.
    for (const g of groups) {
      const one = g.animations.every(x => x.frame_width === g.animations[0].frame_width && x.frame_height === g.animations[0].frame_height);
      const name = (x: Group["animations"][number]) => `${x.action ?? "?"}${x.variant ? ` (${x.variant.replace(/_/g, " ")})` : ""}${x.take ? ` take ${x.take}` : ""}${one ? "" : ` ${x.frame_width}x${x.frame_height}`}`;
      out(`Group ${g.character}: ${g.animations.map(name).join(", ")}${one ? ` (${g.frame_width}x${g.frame_height} frames)` : ""}`);
    }
    for (const d of duplicates) out(`${d.match === "identical" ? "Identical" : "Look the same"}: ${d.files.join(", ")}`);
    if (gaps.length) out(`Missing, next to the rest of the folder (${gaps.length}):`);
    for (const g of gaps) out(`  ${g.detail}\n    ${g.hint.text}: ${g.hint.command}`);
    if (found.skipped.length) out(`Skipped ${found.skipped.length} other file${found.skipped.length === 1 ? "" : "s"}`);
    for (const e of emitted) for (const f of e.files) out(`Saved ${shown(f)}`);
    for (const n of notes) process.stderr.write(`Note: ${n}\n`);
    if (!ctx.globals.quiet) process.stderr.write(`Next: ${next.text}: ${next.command}\n`);
    return EXIT.OK;
  }
});
