import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CliError, EXIT } from "../errors.js";
import { printJson, type Ctx } from "../generate.js";
import type { Image } from "../tty/png.js";
import { findGodotProject } from "../tty/godot.js";
import { CONFIDENT, guessGrid } from "./grid.js";
import { baseOf, freeName, loadImageFile, shown, writePng, type Loaded } from "./io.js";
import { natural } from "./sprite.js";
import { crop, frameRects } from "./sheet.js";
import { contentBox, emptiness } from "./pixels.js";
import { coloursOf } from "./palette.js";
import { seams } from "./tiles.js";
import { loadAudioFile } from "./audio-io.js";
import { frames as sampleFrames, loopClicks, loudness, repeats, samplePeak, toDb, toMono } from "./sound.js";
import type { Audio } from "./wav.js";
import { modelInfo, ModelError, readGltf } from "./model.js";
import { haveFfmpeg, probeVideo } from "./video.js";
import { positiveNumber, textFlag } from "./flags.js";
import { hint, TOOLS, type Hint, type ToolCall } from "./registry.js";

// `ludo toolbox asset ...`: a folder of assets at once. These tools only
// look: they say what each file is, check it against an engine's import
// rules or a size budget, and compare two takes. They never change the art;
// where a file needs another format, they name the toolbox command that
// converts it (convert, scale, pad, mono) and leave running it to you.

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
  phash?: Uint8Array; // not in the JSON: the perceptual hash duplicates compare
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
const words = (rel: string) =>
  rel
    .replace(/\.[^./]+$/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

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
  // The first and the middle frame: a sheet that only shares its first
  // pose with another is a different animation.
  const rects = grid ? frameRects(img.width, img.height, grid.cols, grid.rows, grid.frames) : [{ x: 0, y: 0, w: img.width, h: img.height }];
  const [first, middle] = [rects[0], rects[Math.floor(rects.length / 2)]].map(r => crop(img, r));
  a.phash = new Uint8Array([...dHash(first), ...dHash(middle)]);
}

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
  if (copies > 1) return { kind: duration >= 20 ? "music" : "ambience", reason: `${copies} copies of one loop written out` };
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

// ---- Groups and duplicates ----

// Words that say which move a sheet is, and words that say nothing about
// the character (Ludo's download names, "sheet").
const ACTIONS = new Set(
  (
    "idle walk run jump attack hit hurt die death dead fall land climb crouch dash roll block cast shoot throw punch kick slash swing spin fly " +
    "swim talk emote dance victory win lose spawn sleep sit push pull pickup use interact reload aim fire charge guard dodge stun turn move " +
    "strafe sprint crawl slide wave laugh cry eat drink celebrate taunt special skill combo heavy light"
  ).split(" ")
);
const GENERIC = new Set(["animatesprite", "adjustspritesheet", "editspritesheet", "spritesheet", "spritesheets", "sheet", "sheets", "sprite", "sprites", "anim", "anims", "animation", "animations", "frames", "take", "v"]);

// The character a sheet shows and the move: hero_walk2.png -> hero, walk
// (take 2). Hashes and numbers say nothing and are dropped.
export function characterOf(rel: string): { character: string; action?: string; take?: number } {
  const keep: string[] = [];
  let action: string | undefined;
  let take: number | undefined;
  for (const w of words(withoutDownloadName(rel))) {
    if (/^\d+$/.test(w) || (/^[0-9a-f]{8,}$/.test(w) && /\d/.test(w)) || GENERIC.has(w)) continue;
    const m = /^([a-z]+?)(\d+)?$/.exec(w);
    if (m && ACTIONS.has(m[1])) {
      action = action ? `${action}_${m[1]}` : m[1];
      if (m[2]) take = Number(m[2]);
      continue;
    }
    keep.push(w);
  }
  return { character: keep.join("_"), ...(action ? { action } : {}), ...(take ? { take } : {}) };
}

export interface Group {
  character: string;
  frame_width: number;
  frame_height: number;
  animations: { path: string; action: string | null; take?: number; frames: number }[];
}

// Sheets of one character: the same words once the move is taken out, and
// frames of about the same height (within 25%: a take redrawn larger is
// still the character; a sheet twice as tall is something else).
export function groupsOf(assets: Asset[]): Group[] {
  const by = new Map<string, Asset[]>();
  for (const a of assets) {
    if (a.kind !== "spritesheet" || !a.grid) continue;
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
            const { action, take } = characterOf(a.path);
            return { path: a.path, action: action ?? null, ...(take ? { take } : {}), frames: a.grid!.frames };
          })
      });
    }
  }
  return out.sort((x, y) => natural.compare(x.character, y.character));
}

export interface Duplicate {
  match: "identical" | "looks the same";
  files: string[];
  difference?: number; // bits of the perceptual hash that differ, 0-1
}

// Byte-identical files, then pictures that look the same: the same number
// of frames of about the same shape, whose first and middle frames' hashes
// differ in at most 10 of 128 bits (a re-encode, a resize, a PNG and its
// WebP).
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
      const d = hamming(p.phash!, q.phash!);
      if (d > 10) continue;
      parent[find(j)] = find(i);
      worst.set(i, Math.max(worst.get(i) ?? 0, d));
      worst.set(j, Math.max(worst.get(j) ?? 0, d));
    }
  }
  const sets = new Map<number, number[]>();
  pics.forEach((_, i) => sets.set(find(i), [...(sets.get(find(i)) ?? []), i]));
  for (const members of sets.values()) {
    if (members.length < 2) continue;
    out.push({ match: "looks the same", files: members.flatMap(i => bySha.get(pics[i].sha256)!.map(a => a.path)), difference: round(Math.max(...members.map(i => worst.get(i) ?? 0)) / 128, 3) });
  }
  return out;
}

// What the JSON carries of an asset: everything but where it is on disk and
// its hash bits.
const publicAsset = ({ file, phash, ...rest }: Asset) => rest;

// ---- Loader code for engines ----

// A key from the path, stable as long as the path is: lower-case words
// joined by "_", starting with a letter. A file Ludo named on download
// (animateSprite-29402c81-1.png) takes its folder's name instead. Files
// that only differ by extension take it on.
export function assetKeys(paths: string[]): string[] {
  const keyOf = (rel: string) => {
    const key = withoutDownloadName(rel)
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

const EMITS = ["phaser", "godot", "unity", "pixi", "json"] as const;
type Emit = (typeof EMITS)[number];
const HEADER = "Generated by `ludo toolbox asset manifest`: run it again rather than editing this file.";
const quote = (s: string) => JSON.stringify(s);
const num = (v: number) => String(round(v, 3));
const joinUrl = (base: string, rel: string) => (!base ? rel : base.endsWith("/") ? `${base}${rel}` : `${base}/${rel}`);

// Where the folder sits for each engine: --base, else for Godot the res://
// path under the nearest project.godot, for Unity the path from the
// project's Assets folder, and for the web the folder as given.
function baseFor(engine: Emit, root: string, flag: string | undefined): { base: string; guessed: boolean } {
  if (flag !== undefined) return { base: flag, guessed: false };
  if (engine === "godot") {
    const project = findGodotProject(root);
    const rel = project ? path.relative(project, root).split(path.sep).join("/") : "";
    return { base: `res://${rel}`, guessed: !project };
  }
  if (engine === "unity") {
    const parts = path.resolve(root).split(path.sep);
    const at = parts.lastIndexOf("Assets");
    if (at >= 0 && fs.existsSync(path.join(parts.slice(0, at).join(path.sep) || path.sep, "ProjectSettings"))) return { base: parts.slice(at).join("/"), guessed: false };
    return { base: `Assets/${path.basename(path.resolve(root))}`, guessed: true };
  }
  // A page loads files relative to itself: the folder's path from here when
  // it is inside the working folder, else its name.
  const rel = path.relative(process.cwd(), root);
  const inside = !rel.startsWith("..") && !path.isAbsolute(rel);
  return { base: inside ? rel.split(path.sep).join("/") : path.basename(path.resolve(root)), guessed: !inside };
}

interface Emitted {
  file: string;
  notes: string[];
}

function emitPhaser(assets: Asset[], keys: string[], base: string): { text: string; notes: string[] } {
  const notes: string[] = [];
  const taken = new Set<string>();
  const names = keys.map(k => pascal(k, taken));
  const loads: string[] = [];
  const sheets: string[] = [];
  assets.forEach((a, i) => {
    const key = `AssetKey.${names[i]}`;
    const url = quote(a.path);
    if (a.error) return loads.push(`  // ${a.path}: not read (${a.error})`);
    if (a.type === "image") {
      if (a.animated) {
        notes.push(`${a.path}: an animated ${a.animated.toUpperCase()}; browsers give Phaser its first frame only, so it is loaded as an image. As a PNG sheet: ludo toolbox image convert ${a.path} --to png`);
        loads.push(`  scene.load.image(${key}, ${url}); // its first frame only: an animated ${a.animated.toUpperCase()}`);
      } else if (a.grid && a.kind === "spritesheet") {
        const g = a.grid;
        const uneven = a.width! % g.cols || a.height! % g.rows;
        if (uneven) notes.push(`${a.path}: ${a.width}x${a.height} does not divide into ${g.cols}x${g.rows} equal frames, and Phaser cuts at whole frame sizes`);
        loads.push(`  scene.load.spritesheet(${key}, ${url}, { frameWidth: ${g.frame_width}, frameHeight: ${g.frame_height}, endFrame: ${g.frames - 1} });${g.from === "detected" ? ` // grid detected, ${Math.round(g.confidence! * 100)}% sure` : ""}`);
        sheets.push(`  [AssetKey.${names[i]}]: { frames: ${g.frames}, frameRate: ${g.fps ? num(g.fps) : "undefined"} },`);
      } else loads.push(`  scene.load.image(${key}, ${url});`);
    } else if (a.type === "audio") loads.push(`  scene.load.audio(${key}, ${url});`);
    else if (a.type === "video") loads.push(`  scene.load.video(${key}, ${url});`);
    else loads.push(`  // ${a.path}: a 3D model; Phaser has no glTF loader`);
  });
  const text = [
    `// ${HEADER}`,
    `// Every asset in ${base || "the folder"}, queued on a scene's loader: call preload(this) from your scene's preload().`,
    `import type { Scene } from "phaser";`,
    "",
    "export enum AssetKey {",
    ...assets.map((_, i) => `  ${names[i]} = ${quote(keys[i])},`),
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
  return { text, notes };
}

// Godot 4 imports PNG, WebP and JPEG textures, WAV, Ogg Vorbis and MP3
// sounds, glTF/GLB (and FBX, OBJ) models, and Ogg Theora video: the rest
// is listed, not preloaded, since preload() of a file Godot did not import
// stops the script from compiling.
// https://docs.godotengine.org/en/stable/tutorials/assets_pipeline/importing_images.html
// https://docs.godotengine.org/en/stable/tutorials/assets_pipeline/importing_audio_samples.html
// https://docs.godotengine.org/en/stable/tutorials/animation/playing_videos.html
const GODOT_IMPORTS = new Set(["png", "webp", "jpg", "jpeg", "wav", "ogg", "mp3", "glb", "gltf", "fbx", "obj", "dae", "blend", "ogv"]);

function emitGodot(assets: Asset[], keys: string[], base: string, guessed: boolean): { text: string; notes: string[] } {
  const notes: string[] = [];
  const entries: string[] = [];
  const sheets: string[] = [];
  if (guessed) notes.push(`No project.godot above the folder: the paths take it as the project's root (res://). Pass --base res://<its folder> otherwise.`);
  assets.forEach((a, i) => {
    const format = path.extname(a.path).slice(1).toLowerCase();
    if (a.error) return entries.push(`\t# ${a.path}: not read (${a.error})`);
    if (!GODOT_IMPORTS.has(format) || a.mismatch || /opus/i.test(a.audio?.codec ?? "")) {
      // Godot picks the importer by extension: a WAV named .mp3 fails to import.
      const why = a.mismatch
        ? a.mismatch
        : /opus/i.test(a.audio?.codec ?? "")
          ? "Godot imports Ogg Vorbis, not Opus"
          : format === "gif"
            ? "Godot does not import GIF"
            : a.type === "video"
              ? "Godot plays Ogg Theora (.ogv) video only"
              : `Godot does not import .${format}`;
      notes.push(`${a.path}: left out (${why})`);
      return entries.push(`\t# ${quote(keys[i])}: ${a.path} left out: ${why}`);
    }
    entries.push(`\t${quote(keys[i])}: preload(${quote(joinUrl(base, a.path))}),`);
    if (a.grid && a.kind === "spritesheet" && !a.animated) sheets.push(`\t${quote(keys[i])}: {"hframes": ${a.grid.cols}, "vframes": ${a.grid.rows}, "frames": ${a.grid.frames}, "fps": ${a.grid.fps ? num(a.grid.fps) : "null"}},`);
  });
  const text = [
    `# ${HEADER}`,
    `# const Assets = preload("<this file>"), then Assets.ASSETS["<key>"].`,
    "",
    "const ASSETS := {",
    ...entries,
    "}",
    "",
    "# Spritesheets: hframes and vframes for a Sprite2D, the frame count and fps for its animation.",
    "const SHEETS := {",
    ...sheets,
    "}",
    ""
  ].join("\n");
  return { text, notes };
}

// Unity imports PNG, JPEG and GIF (its first frame) but not WebP, and
// glTF only through a package (glTFast).
// https://docs.unity3d.com/Manual/ImportingTextures.html
// https://docs.unity3d.com/Packages/com.unity.cloud.gltfast@6.0/manual/index.html
function emitUnity(assets: Asset[], keys: string[], base: string, guessed: boolean): { text: string; notes: string[] } {
  const notes: string[] = [];
  if (guessed) notes.push(`The folder is not inside a Unity project's Assets folder: the paths take it as ${base}. Pass --base Assets/<its folder> otherwise.`);
  const taken = new Set(["LudoAssets", "All", "Entry", "Kind"]);
  const names = keys.map(k => pascal(k, taken));
  const kinds = ["Spritesheet", "Image", "Texture", "Sfx", "Music", "Voice", "Ambience", "Model", "Video"];
  const kindName = (k: Kind) => kinds.find(x => x.toLowerCase() === k)!;
  const consts: string[] = [];
  const entries: string[] = [];
  assets.forEach((a, i) => {
    const format = path.extname(a.path).slice(1).toLowerCase();
    if (format === "webp") notes.push(`${a.path}: Unity does not import WebP. As PNG: ludo toolbox image convert ${a.path} --to png`);
    if (a.type === "model" && format !== "fbx" && format !== "obj" && format !== "dae" && format !== "blend") notes.push(`${a.path}: Unity reads glTF through the glTFast package (com.unity.cloud.gltfast)`);
    consts.push(`    public const string ${names[i]} = ${quote(joinUrl(base, a.path))};`);
    const g = a.kind === "spritesheet" ? a.grid : undefined;
    entries.push(`        new Entry(${quote(keys[i])}, ${names[i]}, Kind.${kindName(a.kind)}, ${g ? g.frames : 1}, ${g ? g.cols : 1}, ${g ? g.rows : 1}, ${g?.fps ? `${num(g.fps)}f` : "0f"}),`);
  });
  const text = [
    `// ${HEADER}`,
    "// Every asset by its project path: for AssetDatabase.LoadAssetAtPath in the editor, or as Addressables addresses.",
    "public static class LudoAssets",
    "{",
    ...consts,
    "",
    `    public enum Kind { ${kinds.join(", ")} }`,
    "",
    "    /// <summary>One asset: its key, path and kind; for a spritesheet its frames, grid and fps (0 when the file does not say).</summary>",
    "    public readonly struct Entry",
    "    {",
    "        public readonly string Key, Path;",
    "        public readonly Kind Kind;",
    "        public readonly int Frames, Columns, Rows;",
    "        public readonly float Fps;",
    "        public Entry(string key, string path, Kind kind, int frames, int columns, int rows, float fps)",
    "        {",
    "            Key = key; Path = path; Kind = kind; Frames = frames; Columns = columns; Rows = rows; Fps = fps;",
    "        }",
    "    }",
    "",
    "    public static readonly Entry[] All =",
    "    {",
    ...entries,
    "    };",
    "}",
    ""
  ].join("\n");
  return { text, notes };
}

// A PixiJS 8 manifest for Assets.init({ manifest }), a bundle per kind of
// asset. A sheet loads as its frames when a TexturePacker atlas sits next to
// it (`sprite export --engine texturepacker` writes one); sounds need the
// @pixi/sound extension.
function emitPixi(assets: Asset[], keys: string[], base: string): { text: string; notes: string[] } {
  const notes: string[] = [];
  const bundles = new Map<string, { alias: string; src: string }[]>();
  const add = (bundle: string, alias: string, src: string) => bundles.set(bundle, [...(bundles.get(bundle) ?? []), { alias, src: joinUrl(base, src) }]);
  assets.forEach((a, i) => {
    if (a.error) return;
    if (a.type === "image") {
      if (a.kind === "spritesheet" && !a.animated) {
        const atlas = a.path.replace(/\.[^./]+$/, ".json");
        if (fs.existsSync(path.join(path.dirname(a.file), path.basename(atlas)))) return add("spritesheets", keys[i], atlas);
        notes.push(`${a.path}: loads as one texture; for its frames, write an atlas next to it: ludo toolbox sprite export ${shown(a.file)} --engine texturepacker`);
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
  return { text: JSON.stringify(manifest, null, 2) + "\n", notes };
}

const EMIT_FILE: Record<Emit, string> = { phaser: "assets.ts", godot: "assets.gd", unity: "LudoAssets.cs", pixi: "assets-manifest.json", json: "assets.json" };

// Loader code is regenerated from the folder, so it overwrites its own
// earlier copy, as engine files do.
function emit(ctx: Ctx, engine: Emit, root: string, assets: Asset[], manifest: unknown, baseFlag: string | undefined): Emitted {
  const keys = assetKeys(assets.map(a => a.path));
  const { base, guessed } = baseFor(engine, root, baseFlag);
  const out =
    engine === "phaser"
      ? emitPhaser(assets, keys, base)
      : engine === "godot"
        ? emitGodot(assets, keys, base, guessed)
        : engine === "unity"
          ? emitUnity(assets, keys, base, guessed)
          : engine === "pixi"
            ? emitPixi(assets, keys, base)
            : { text: JSON.stringify(manifest, null, 2) + "\n", notes: [] };
  if (guessed && (engine === "phaser" || engine === "pixi")) out.notes.unshift(`The folder is outside the working folder: the URLs take it as ${base}/. Pass --base <its URL path> otherwise.`);
  const named = ctx.globals.name && `${ctx.globals.name}${engine === "pixi" ? "-manifest" : ""}${path.extname(EMIT_FILE[engine])}`;
  const file = path.join(ctx.outDir, named || EMIT_FILE[engine]);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, out.text);
  return { file, notes: out.notes };
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
  summary: "Say what every asset in a folder is, find a character's animations and duplicates, and write loader code",
  details: [
    "Each file gets a kind, with the reason: spritesheet (its grid from the Ludo stamp, a GIF's or WebP's",
    "frames, or detection when it is sure), image, texture (opaque, and its edges meet when it repeats),",
    "sfx, music, voice or ambience (by length, whether it wraps without a click, and how speech-like it",
    "is; words in the path decide first), model or video. With its size, frames, fps, length, bytes and",
    "sha256. Groups are sheets of one character (the same name once the move, like walk2, is taken out,",
    "and frames of about one height); duplicates are byte-identical files, or pictures that look the same",
    "(a difference hash). Sound kinds are a first sort, not a classifier: check the reasons.",
    "--emit writes loader code to --out, overwriting its own earlier copy, with keys from the paths:",
    "  phaser  assets.ts: an AssetKey enum, preload(scene) with each sheet's frame size, SHEETS",
    "  godot   assets.gd: a const dictionary of preload()s, and each sheet's hframes/vframes/fps",
    "  unity   LudoAssets.cs: every asset's project path, and a list with each sheet's grid",
    "  pixi    assets-manifest.json: a PixiJS 8 manifest for Assets.init({ manifest })",
    "  json    assets.json: this manifest"
  ],
  flags: [
    { flag: "--emit", value: "engine", description: "Write loader code: phaser, godot, unity, pixi or json (repeat for several)" },
    { flag: "--base", value: "path", description: "The folder's path in the engine (default: res:// from project.godot, Assets/ in Unity, else the folder)" }
  ],
  async run(ctx: Ctx, call: ToolCall) {
    const emits = (call.lists.get("--emit") ?? []).map(e => e.toLowerCase());
    for (const e of emits) if (!(EMITS as readonly string[]).includes(e)) throw new CliError(`--emit takes ${EMITS.join(", ")} (got "${e}")`, EXIT.USAGE);
    const found = findAssets(call.args, "ludo toolbox asset manifest <folder> [--emit phaser|godot|unity|pixi|json]");
    const assets = readAll(found);
    const kinds: Record<string, number> = {};
    for (const a of assets) kinds[a.kind] = (kinds[a.kind] ?? 0) + 1;
    const groups = groupsOf(assets);
    const duplicates = duplicatesOf(assets);
    const manifest = {
      folder: shown(found.root),
      count: assets.length,
      bytes: assets.reduce((s, a) => s + a.bytes, 0),
      kinds,
      assets: assets.map(publicAsset),
      groups,
      duplicates,
      ...(found.skipped.length ? { skipped: found.skipped } : {})
    };
    const emitted = [...new Set(emits as Emit[])].map(e => emit(ctx, e, found.root, assets, manifest, textFlag(call, "--base")));
    const notes = emitted.flatMap(e => e.notes);
    const firstSheet = assets.find(a => a.kind === "spritesheet" && !a.animated);
    const next = !emitted.length
      ? hint("Check them against an engine's import rules", `ludo toolbox asset lint ${shown(found.root)} --engine godot`)
      : firstSheet
        ? hint("Write a sheet's engine animation too", `ludo toolbox sprite export ${shown(firstSheet.file)} --engine ${emits.includes("unity") ? "unity" : emits.includes("godot") ? "godot" : "texturepacker"}`)
        : hint("Check them against an engine's import rules", `ludo toolbox asset lint ${shown(found.root)} --engine godot`);
    if (ctx.jsonOut) {
      printJson({ ...manifest, ...(emitted.length ? { emitted: emitted.map(e => shown(e.file)) } : {}), ...(notes.length ? { notes } : {}), ...(ctx.globals.quiet ? {} : { hint: next }) }, false);
      return EXIT.OK;
    }
    const width = Math.max(...assets.map(a => a.path.length));
    const out = (line: string) => process.stdout.write(line + "\n");
    out(`${assets.length} assets in ${shown(found.root)} (${kb(manifest.bytes)}): ${Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(", ")}`);
    for (const a of assets) out(`  ${a.path.padEnd(width)}  ${a.kind.padEnd(11)}  ${describeAsset(a)}${a.reason ? `  (${a.reason})` : ""}`);
    for (const g of groups) out(`Group ${g.character}: ${g.animations.map(x => `${x.action ?? "?"}${x.take ? ` take ${x.take}` : ""}`).join(", ")} (${g.frame_width}x${g.frame_height} frames)`);
    for (const d of duplicates) out(`${d.match === "identical" ? "Identical" : "Look the same"}: ${d.files.join(", ")}`);
    if (found.skipped.length) out(`Skipped ${found.skipped.length} other file${found.skipped.length === 1 ? "" : "s"}`);
    for (const e of emitted) out(`Saved ${shown(e.file)}`);
    for (const n of notes) process.stderr.write(`Note: ${n}\n`);
    if (!ctx.globals.quiet) process.stderr.write(`Next: ${next.text}: ${next.command}\n`);
    return EXIT.OK;
  }
});

// ---- asset lint ----

const LINT_ENGINES = ["godot", "unity", "unreal", "phaser", "web"] as const;
type LintEngine = (typeof LINT_ENGINES)[number];
type Severity = "error" | "warning" | "info";

export interface Issue {
  file: string;
  rule: string;
  severity: Severity;
  detail: string;
  fix: string; // a toolbox command that changes the format, or plain advice
  source: string; // the engine documentation the rule comes from
}

const isPow2 = (n: number) => n > 0 && (n & (n - 1)) === 0;
const nextPow2 = (n: number) => 2 ** Math.ceil(Math.log2(Math.max(1, n)));
const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
const quoted = (file: string) => (/^[\w./@:+-]+$/.test(file) ? file : `"${file.replace(/(["\\$`])/g, "\\$1")}"`);

// The `image scale` that brings the longest side under `limit`: the
// smallest 1/N, which keeps pixel art's pixels square and whole.
const scaleUnder = (a: Asset, limit: number) => {
  const n = Math.ceil(Math.max(a.width!, a.height!) / limit);
  return `ludo toolbox image scale ${quoted(shown(a.file))} --by 1/${n}${n > 16 ? " (more than 16 is past what one scale takes: run it twice)" : ""}`;
};

// What the rules see of an asset: the asset, and the engine.
type Rule = (a: Asset, engine: LintEngine) => Omit<Issue, "file">[];

const at = (rule: string, source: string) => (severity: Severity, detail: string, fix: string): Omit<Issue, "file"> => ({ rule, severity, detail, fix, source });

// Every rule below is one an engine's own documentation states; the URL
// beside it is where. Rules that could not be confirmed there are left out
// on purpose, including two often repeated: that 3D engines position only
// mono sounds (Unity's AudioSource.spread and Unreal's 3D Stereo Spread
// spatialize stereo too), and an MP3 loop gap in current Godot, Unreal or
// web docs (only Unity's 4.6 manual says it).
const RULES: Rule[] = [
  // Texture size limits.
  (a, engine) => {
    if (a.type !== "image" || !a.width || !a.height) return [];
    const side = Math.max(a.width, a.height);
    const size = `${a.width}x${a.height}`;
    if (engine === "godot") {
      // "The maximum image size is 16384×16384 pixels due to graphics hardware limitations."
      // https://docs.godotengine.org/en/stable/classes/class_image.html
      const r = at("texture-size", "https://docs.godotengine.org/en/stable/classes/class_image.html");
      if (side > 16384) return [r("error", `${size}: Godot images are 16384x16384 at most`, scaleUnder(a, 16384))];
      // Size Limit: "... mobile/web platforms (as these usually can't display
      // textures larger than 4096×4096)."
      // https://docs.godotengine.org/en/stable/tutorials/assets_pipeline/importing_images.html
      if (side > 4096) return [at("texture-size", "https://docs.godotengine.org/en/stable/tutorials/assets_pipeline/importing_images.html")("warning", `${size}: mobile and web exports usually cannot show textures over 4096x4096`, scaleUnder(a, 4096))];
    }
    // "The Texture Importer only allows you to choose dimension sizes up to
    // 16384"; larger sources are scaled down to Max Size on import.
    // https://docs.unity3d.com/Manual/ImportingTextures.html
    // https://docs.unity3d.com/ScriptReference/TextureImporterPlatformSettings-maxTextureSize.html
    if (engine === "unity" && side > 16384) return [at("texture-size", "https://docs.unity3d.com/Manual/ImportingTextures.html")("warning", `${size}: Unity imports at most 16384 a side and scales the rest down`, scaleUnder(a, 16384))];
    // "some GPUs may not support texture sizes larger than 8192 pixels (8k)."
    // https://dev.epicgames.com/documentation/en-us/unreal-engine/textures-in-unreal-engine
    if (engine === "unreal" && side > 8192) return [at("texture-size", "https://dev.epicgames.com/documentation/en-us/unreal-engine/textures-in-unreal-engine")("warning", `${size}: some GPUs do not take textures over 8192 a side`, scaleUnder(a, 8192))];
    // "In practice, effectively all systems support at least ... MAX_TEXTURE_SIZE: 4096"
    // https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices
    if ((engine === "web" || engine === "phaser") && side > 4096) return [at("texture-size", "https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices")("warning", `${size}: 4096 a side is what effectively every WebGL system takes; bigger fails on many phones and laptops`, scaleUnder(a, 4096))];
    return [];
  },

  // Non-power-of-two sizes, where the engine treats them differently. A
  // repeating texture cannot be padded without breaking its repeat; a square
  // one can be resized by one factor; anything else is advice.
  (a, engine) => {
    if (a.type !== "image" || !a.width || !a.height || (isPow2(a.width) && isPow2(a.height))) return [];
    const size = `${a.width}x${a.height}`;
    const target = `${nextPow2(a.width)}x${nextPow2(a.height)}`;
    const fix = () => {
      if (a.kind === "texture" && a.width === a.height) {
        const t = nextPow2(a.width!);
        const g = gcd(t, a.width!);
        return `ludo toolbox image scale ${quoted(shown(a.file))} --by ${t / g}/${a.width! / g} --filter lanczos (resizes it to ${t}x${t}; check its repeat after with image repeat)`;
      }
      if (a.kind === "texture") return `Make it ${target} (powers of two) where it is made: padding would break its repeat`;
      if (a.kind === "image") return `ludo toolbox image pad ${quoted(shown(a.file))} --to ${target} (a transparent border)`;
      return "Pack the frames into a power-of-two atlas, or leave it if the engine does not mipmap or repeat it";
    };
    if (engine === "unreal" && a.kind !== "spritesheet") {
      // "Non-power of two sizes are never streamed and do not generate mipmaps."
      // https://dev.epicgames.com/documentation/en-us/unreal-engine/textures-in-unreal-engine
      return [at("power-of-two", "https://dev.epicgames.com/documentation/en-us/unreal-engine/textures-in-unreal-engine")("warning", `${size}: Unreal never streams a texture that is not a power of two, and imports it without mipmaps`, fix())];
    }
    if (engine === "unity" && a.kind === "texture") {
      // "NPOT Texture sizes generally take slightly more memory and might be
      // slower for the GPU to sample ... If the platform or GPU does not
      // support NPOT Texture sizes, Unity scales and pads the Texture up to
      // the next power of two size."
      // https://docs.unity3d.com/Manual/ImportingTextures.html
      return [at("power-of-two", "https://docs.unity3d.com/Manual/ImportingTextures.html")("warning", `${size}: Unity advises powers of two for textures (NPOT takes more memory, and is scaled up where the GPU lacks NPOT)`, fix())];
    }
    if ((engine === "web" || engine === "phaser") && a.kind === "texture") {
      // "WebGL1 can only use non power of 2 textures with filtering set to
      // NEAREST or LINEAR and it cannot generate a mipmap for them. Their
      // wrapping mode must also be set to CLAMP_TO_EDGE."
      // https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/Tutorial/Using_textures_in_WebGL
      // Phaser: "Mipmaps only work with textures that are fully power-of-two in size."
      // https://docs.phaser.io/api-documentation/class/renderer-webgl-webglrenderer
      const src = engine === "phaser" ? "https://docs.phaser.io/api-documentation/class/renderer-webgl-webglrenderer" : "https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/Tutorial/Using_textures_in_WebGL";
      return [at("power-of-two", src)("warning", `${size}: WebGL 1 cannot repeat or mipmap a texture that is not a power of two`, fix())];
    }
    if (engine === "godot" && a.kind === "texture") {
      // "Using power-of-two texture sizes is recommended, but is not required."
      // https://docs.godotengine.org/en/stable/tutorials/assets_pipeline/importing_images.html
      return [at("power-of-two", "https://docs.godotengine.org/en/stable/tutorials/assets_pipeline/importing_images.html")("info", `${size}: Godot recommends powers of two for textures, without requiring them`, fix())];
    }
    return [];
  },

  // 16-bit PNGs in Godot: "Precision is limited to 8 bits per channel upon
  // importing (no HDR images)."
  // https://docs.godotengine.org/en/stable/tutorials/assets_pipeline/importing_images.html
  (a, engine) =>
    engine === "godot" && a.format === "png" && a.depth === 16
      ? [at("16-bit-png", "https://docs.godotengine.org/en/stable/tutorials/assets_pipeline/importing_images.html")("info", "a 16-bit PNG: Godot imports 8 bits per channel, so the extra precision only costs file size", `ludo toolbox image convert ${quoted(shown(a.file))} --to png (writes 8 bits per channel)`)]
      : [],

  // File formats the engine does not import.
  (a, engine) => {
    const ext = path.extname(a.path).slice(1).toLowerCase();
    const codec = a.audio?.codec ?? "";
    if (engine === "godot") {
      // Raster formats: BMP, DDS, KTX, OpenEXR, Radiance HDR, JPEG, PNG, TGA, WebP (no GIF).
      // https://docs.godotengine.org/en/stable/tutorials/assets_pipeline/importing_images.html
      if (ext === "gif") return [at("format", "https://docs.godotengine.org/en/stable/tutorials/assets_pipeline/importing_images.html")("error", "Godot does not import GIF", `ludo toolbox image convert ${quoted(shown(a.file))} --to png${a.animated ? " (an animation comes out as a sheet)" : ""}`)];
      // "Godot provides 3 options to import your audio data: WAV, Ogg Vorbis and MP3."
      // https://docs.godotengine.org/en/stable/tutorials/assets_pipeline/importing_audio_samples.html
      const r = at("format", "https://docs.godotengine.org/en/stable/tutorials/assets_pipeline/importing_audio_samples.html");
      if (a.type === "audio" && !["wav", "ogg", "mp3"].includes(ext)) return [r("error", `Godot imports WAV, Ogg Vorbis and MP3, not .${ext}`, `ludo toolbox audio convert ${quoted(shown(a.file))} --to ogg`)];
      if (a.type === "audio" && /opus/i.test(codec)) return [r("error", "an Ogg Opus file: Godot imports Ogg Vorbis", `ludo toolbox audio convert ${quoted(shown(a.file))} --to ogg (writes Vorbis)`)];
      // "the only supported format in core is Ogg Theora"; WebM support "was removed in 4.0".
      // https://docs.godotengine.org/en/stable/tutorials/animation/playing_videos.html
      if (a.type === "video" && ext !== "ogv") return [at("format", "https://docs.godotengine.org/en/stable/tutorials/animation/playing_videos.html")("error", `Godot plays Ogg Theora (.ogv) video only, not .${ext}`, "Convert it to Ogg Theora (.ogv), for example with ffmpeg")];
    }
    if (engine === "unity") {
      // "Unity can read the following file formats: BMP, EXR, GIF, HDR, IFF, JPG, PICT, PNG, PSD, TGA, TIFF"
      // https://docs.unity3d.com/Manual/ImportingTextures.html
      if (ext === "webp") return [at("format", "https://docs.unity3d.com/Manual/ImportingTextures.html")("error", "Unity does not import WebP", `ludo toolbox image convert ${quoted(shown(a.file))} --to png`)];
      // .mp3, .aiff/.aif, .wav, .ogg, .flac, and the tracker formats.
      // https://docs.unity3d.com/6000.0/Documentation/Manual/AudioFiles-compatibility.html
      if (a.type === "audio" && !["mp3", "aiff", "aif", "wav", "ogg", "flac"].includes(ext)) return [at("format", "https://docs.unity3d.com/6000.0/Documentation/Manual/AudioFiles-compatibility.html")("error", `Unity does not import .${ext} sounds`, `ludo toolbox audio convert ${quoted(shown(a.file))} --to ogg`)];
      // glTF comes in through the glTFast package.
      // https://docs.unity3d.com/Packages/com.unity.cloud.gltfast@6.0/manual/index.html
      if (ext === "glb" || ext === "gltf") return [at("format", "https://docs.unity3d.com/Packages/com.unity.cloud.gltfast@6.0/manual/index.html")("info", "Unity reads glTF through the glTFast package (com.unity.cloud.gltfast)", "Add the glTFast package to the project")];
    }
    if (engine === "unreal" && a.type === "audio") {
      // Formats ".wav, .ogg, .flac, .aif, .opus, .mp3"; bit depth "16, 24";
      // "24-bit files are not dithered during conversion so importing 16-bit
      // files is recommended."
      // https://dev.epicgames.com/documentation/en-us/unreal-engine/importing-audio-files
      const r = at("format", "https://dev.epicgames.com/documentation/en-us/unreal-engine/importing-audio-files");
      if (!["wav", "ogg", "flac", "aif", "aiff", "opus", "mp3"].includes(ext)) return [r("error", `Unreal does not import .${ext} sounds`, `ludo toolbox audio convert ${quoted(shown(a.file))} --to wav`)];
      if (a.format === "wav" && (a.audio?.float || (a.audio?.bits ?? 16) > 24 || (a.audio?.bits ?? 16) < 16)) return [r("error", `a ${a.audio?.bits}-bit${a.audio?.float ? " float" : ""} WAV: Unreal imports 16- and 24-bit`, `ludo toolbox audio convert ${quoted(shown(a.file))} --bits 16`)];
      if (a.format === "wav" && a.audio?.bits === 24) return [r("info", "a 24-bit WAV: Unreal converts it to 16 bits without dither, and recommends importing 16-bit", `ludo toolbox audio convert ${quoted(shown(a.file))} --bits 16`)];
    }
    return [];
  },

  // An MP3 that has to loop, in Unity: "Standard MPEG encoders introduce a
  // short silence at the loop point, which will be audible as a brief
  // "click" or "pop"." (Unity 4.6 manual; the current one is silent.)
  // https://docs.unity3d.com/462/Documentation/Manual/class-AudioClip.html
  // The toolbox decodes MP3 gaplessly (LAME's delay and padding), so the
  // OGG it writes keeps exactly the sound.
  (a, engine) => {
    if (engine !== "unity" || a.type !== "audio" || a.format !== "mp3") return [];
    const loops = a.kind === "music" || a.kind === "ambience" || words(a.path).includes("loop") || words(a.path).includes("loops");
    return loops
      ? [at("mp3-loop", "https://docs.unity3d.com/462/Documentation/Manual/class-AudioClip.html")("warning", `an MP3 ${a.kind === "music" ? "used as music" : a.kind === "ambience" ? "ambience" : "loop"}: MP3 encoders leave a short silence at the loop point, heard as a click`, `ludo toolbox audio convert ${quoted(shown(a.file))} --to ogg`)]
      : [];
  },

  // Sample rates. Godot: "Unless you are slowing down the audio at runtime,
  // there's no audible benefit to using a sample rate greater than 48 kHz."
  // https://docs.godotengine.org/en/stable/tutorials/assets_pipeline/importing_audio_samples.html
  (a, engine) =>
    engine === "godot" && a.audio && a.audio.rate > 48000
      ? [at("sample-rate", "https://docs.godotengine.org/en/stable/tutorials/assets_pipeline/importing_audio_samples.html")("info", `${round(a.audio.rate / 1000, 1)} kHz: Godot says there is no audible benefit over 48 kHz unless it is slowed down at runtime`, "Export it at 44.1 or 48 kHz where it is made")]
      : [],

  // glTF files with several scenes, or none chosen.
  (a, engine) => {
    const m = a.model;
    if (!m || (m.scenes <= 1 && m.default_scene !== null)) return [];
    if (engine === "unity") {
      // InstantiateMainScene: "Creates an instance of the main scene of the
      // glTF ... If the main scene index is not set, it instantiates nothing".
      // https://docs.unity3d.com/Packages/com.unity.cloud.gltfast@6.0/api/GLTFast.GltfImportBase.InstantiateMainScene.html
      const r = at("gltf-scenes", "https://docs.unity3d.com/Packages/com.unity.cloud.gltfast@6.0/api/GLTFast.GltfImportBase.InstantiateMainScene.html");
      if (m.default_scene === null && m.scenes) return [r("warning", "no default scene: glTFast's InstantiateMainScene creates nothing", "Set the glTF's default scene where it is exported")];
      return [r("warning", `${m.scenes} scenes: glTFast's InstantiateMainScene creates only scene ${m.default_scene}`, "Export one scene per file, or instantiate the others by index")];
    }
    if (engine === "godot" && m.scenes > 1) {
      // "a glTF file may have multiple scenes ... which will be generated as
      // siblings of each other and as children of the root node"
      // https://docs.godotengine.org/en/stable/classes/class_gltfstate.html
      return [at("gltf-scenes", "https://docs.godotengine.org/en/stable/classes/class_gltfstate.html")("info", `${m.scenes} scenes: Godot imports all of them, side by side under one root`, "Export one scene per file if they are separate things")];
    }
    if (engine === "web") {
      // "`scene` ... identifies which of the scenes in the array SHOULD be
      // displayed at load time ... When `scene` is undefined, client
      // implementations MAY delay rendering until a particular scene is requested."
      // https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html
      const r = at("gltf-scenes", "https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html");
      if (m.default_scene === null && m.scenes) return [r("warning", "no default scene: a viewer may show nothing until a scene is asked for", "Set the glTF's default scene where it is exported")];
      return [r("info", `${m.scenes} scenes: viewers show scene ${m.default_scene} at load`, "Export one scene per file if they are separate things")];
    }
    return [];
  },

  // File names. For every engine, since projects move between systems:
  // Windows' reserved characters and names, and no name ending in a space or
  // a period; "Do not assume case sensitivity".
  // https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file
  a => {
    const r = at("file-name", "https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file");
    const out: Omit<Issue, "file">[] = [];
    for (const part of a.path.split("/")) {
      // eslint-disable-next-line no-control-regex
      if (/[<>:"\\|?*\x00-\x1f]/.test(part)) out.push(r("error", `"${part}" has a character Windows does not allow in names (< > : " \\ | ? * or a control character)`, "Rename it"));
      if (/^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i.test(part)) out.push(r("error", `"${part}" is a name Windows reserves`, "Rename it"));
      if (/[ .]$/.test(part)) out.push(r("error", `"${part}" ends in a space or a period, which Windows does not keep`, "Rename it"));
    }
    return out;
  },
  // Godot: "Godot's PCK virtual filesystem is case-sensitive", and "it's
  // recommended to stick to snake_case naming for all files in the project".
  // https://docs.godotengine.org/en/stable/tutorials/best_practices/project_organization.html
  (a, engine) =>
    engine === "godot" && /[A-Z]/.test(a.path)
      ? [at("file-name", "https://docs.godotengine.org/en/stable/tutorials/best_practices/project_organization.html")("info", "capital letters: an exported Godot game's files are case-sensitive, so a path written in another case works in the editor and fails in the export; Godot recommends snake_case", "Rename it in snake_case")]
      : [],
  // Unity ignores, in Assets, "Files and folders which end with ~" and
  // "Files and folders named cvs" (and hidden ones, which are never listed).
  // https://docs.unity3d.com/6000.0/Documentation/Manual/SpecialFolders.html
  (a, engine) =>
    engine === "unity" && a.path.split("/").some(p => p.endsWith("~") || p.toLowerCase() === "cvs")
      ? [at("file-name", "https://docs.unity3d.com/6000.0/Documentation/Manual/SpecialFolders.html")("warning", "inside a folder whose name ends in ~ or is cvs: Unity ignores it", "Move it out of that folder")]
      : []
];

// Names that differ only in case are one file on Windows and macOS.
function caseClashes(assets: Asset[]): Issue[] {
  const by = new Map<string, string[]>();
  for (const a of assets) by.set(a.path.toLowerCase(), [...(by.get(a.path.toLowerCase()) ?? []), a.path]);
  return [...by.values()]
    .filter(l => l.length > 1)
    .flatMap(l => l.map(file => ({ file, rule: "file-name", severity: "error" as const, detail: `the same name as ${l.filter(f => f !== file).join(", ")} but for case: one file on Windows and macOS`, fix: "Rename one of them", source: "https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file" })));
}

export function lintAssets(assets: Asset[], engine: LintEngine): Issue[] {
  const order: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
  const issues = [
    ...assets.flatMap(a => (a.error ? [{ file: a.path, rule: "unreadable", severity: "error" as const, detail: a.error, fix: "Check the file: it does not read as its extension says", source: "" }] : RULES.flatMap(rule => rule(a, engine).map(i => ({ file: a.path, ...i }))))),
    ...caseClashes(assets)
  ];
  return issues.sort((x, y) => order[x.severity] - order[y.severity] || natural.compare(x.file, y.file));
}

TOOLS.push({
  group: "asset",
  name: "lint",
  args: "<folder or files...>",
  summary: "Check every asset against an engine's import rules",
  details: [
    "--engine godot, unity, unreal, phaser or web. Each rule comes from the engine's own documentation",
    "(its URL is in each issue's `source`): texture size limits, power-of-two sizes where the engine",
    "streams, mipmaps or repeats them, 16-bit PNGs (Godot), formats it does not import (GIF in Godot,",
    "WebP in Unity, Opus in Godot, 32-bit WAV in Unreal), MP3 loops (Unity), sample rates over 48 kHz",
    "(Godot), glTF files with several scenes or none chosen, and file names Windows rejects or that",
    "differ only by case. A fix is a toolbox command that changes the format, or plain advice; nothing",
    "is changed here. Exit code 1 when any issue is an error, for CI."
  ],
  flags: [{ flag: "--strict", description: "Also exit 1 on warnings" }],
  async run(ctx: Ctx, call: ToolCall) {
    const name = ctx.globals.engineName ?? ctx.globals.engine;
    if (!name) throw new CliError(`Pass --engine ${LINT_ENGINES.join(", ")}`, EXIT.USAGE);
    if (!(LINT_ENGINES as readonly string[]).includes(name)) throw new CliError(`asset lint checks ${LINT_ENGINES.join(", ")} (got "${name}")`, EXIT.USAGE);
    const engine = name as LintEngine;
    const found = findAssets(call.args, "ludo toolbox asset lint <folder> --engine godot|unity|unreal|phaser|web");
    const assets = readAll(found);
    const issues = lintAssets(assets, engine);
    const count = (s: Severity) => issues.filter(i => i.severity === s).length;
    const [errors, warnings, infos] = [count("error"), count("warning"), count("info")];
    const failed = errors > 0 || (call.flags.has("--strict") && warnings > 0);
    const commandFix = issues.find(i => i.severity !== "info" && i.fix.startsWith("ludo "));
    const next = commandFix
      ? hint(`Fix the format of ${commandFix.file}`, commandFix.fix.replace(/ \(.*\)$/, ""))
      : hint("See what each file is, and write loader code", `ludo toolbox asset manifest ${quoted(shown(found.root))} --emit ${engine === "web" ? "pixi" : engine === "unreal" ? "json" : engine}`);
    if (ctx.jsonOut) {
      printJson({ folder: shown(found.root), engine, checked: assets.length, errors, warnings, infos, passed: !failed, issues, ...(ctx.globals.quiet ? {} : { hint: next }) }, false);
    } else {
      const out = (line: string) => process.stdout.write(line + "\n");
      out(`${assets.length} assets checked for ${engine}: ${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}, ${infos} note${infos === 1 ? "" : "s"}`);
      for (const i of issues) out(`  ${i.severity.padEnd(7)}  ${i.file}  [${i.rule}] ${i.detail}\n           fix: ${i.fix}`);
      if (!ctx.globals.quiet) process.stderr.write(`Next: ${next.text}: ${next.command}\n`);
    }
    return failed ? EXIT.ERROR : EXIT.OK;
  }
});

// ---- asset budget ----

// Sizes in a budget: a number of bytes, or "4MB", "512 KB", "1.5GiB"
// (K, M, G count 1024s, as GPU memory does).
export function parseBytes(v: unknown, where: string): number {
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
  const m = typeof v === "string" ? /^\s*(\d+(?:\.\d+)?)\s*(b|k|kb|kib|m|mb|mib|g|gb|gib)?\s*$/i.exec(v) : null;
  if (!m) throw new CliError(`${where} takes bytes: a number, or like "4MB" (got ${JSON.stringify(v)})`, EXIT.USAGE);
  const unit = (m[2] ?? "b").toLowerCase()[0];
  return Math.round(Number(m[1]) * (unit === "k" ? 1024 : unit === "m" ? 1024 ** 2 : unit === "g" ? 1024 ** 3 : 1));
}

// What a budget limits, per file and summed: bytes on disk, GPU memory,
// the longest texture side, seconds of sound or video, triangles, a model's
// textures.
const METRICS = ["bytes", "gpu", "side", "seconds", "triangles", "textures"] as const;
type Metric = (typeof METRICS)[number];
const BYTE_METRICS = new Set<Metric>(["bytes", "gpu"]);

export interface Budget {
  gpu: { mipmaps: boolean; power_of_two: boolean; model_mipmaps: boolean };
  sections: Map<string, { file: Partial<Record<Metric, number>>; total: Partial<Record<Metric, number>> }>; // "total", a type or a kind
}

// The config: { "total": {...}, "image": {...}, "spritesheet": {...}, ...,
// "gpu": { "mipmaps": false, "power_of_two": false, "model_mipmaps": true } }.
// In a section, "bytes": 4MB limits each file, "total_bytes" all of them;
// in "total" every limit is for all the files together.
export function parseBudget(json: unknown, file: string): Budget {
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new CliError(`${file} must hold a JSON object`, EXIT.USAGE);
  const { gpu = {}, ...rest } = json as Record<string, unknown>;
  const g = gpu as Record<string, unknown>;
  const budget: Budget = { gpu: { mipmaps: g.mipmaps === true, power_of_two: g.power_of_two === true, model_mipmaps: g.model_mipmaps !== false }, sections: new Map() };
  const names = new Set(["total", "image", "audio", "model", "video", "spritesheet", "texture", "sfx", "music", "voice", "ambience"]);
  for (const [name, value] of Object.entries(rest)) {
    if (!names.has(name)) throw new CliError(`${file}: unknown section "${name}"`, EXIT.USAGE, `Sections: ${[...names].join(", ")}, gpu`);
    if (!value || typeof value !== "object") throw new CliError(`${file}: "${name}" must be an object of limits`, EXIT.USAGE);
    const section = { file: {} as Partial<Record<Metric, number>>, total: {} as Partial<Record<Metric, number>> };
    for (const [key, limit] of Object.entries(value as Record<string, unknown>)) {
      const total = name === "total" || key.startsWith("total_");
      const metric = key.replace(/^total_/, "").replace(/^audio_seconds$/, "seconds") as Metric;
      if (!METRICS.includes(metric)) throw new CliError(`${file}: unknown limit "${name}.${key}"`, EXIT.USAGE, `Limits: ${METRICS.join(", ")}, each also as total_<limit>`);
      const n = BYTE_METRICS.has(metric) ? parseBytes(limit, `${name}.${key}`) : Number(limit);
      if (!Number.isFinite(n) || n < 0) throw new CliError(`${file}: "${name}.${key}" must be a number`, EXIT.USAGE);
      (total ? section.total : section.file)[metric] = n;
    }
    budget.sections.set(name, section);
  }
  return budget;
}

// Uncompressed RGBA8 texture memory: w x h x 4, the sides first rounded up
// to powers of two when the engine pads, and a third more for a full
// mipmap chain (1 + 1/4 + 1/16 ... = 4/3). GPU compression (BCn, ASTC,
// ETC) takes 4-8x less, so this is the most a texture can take.
export const gpuBytes = (w: number, h: number, mipmaps: boolean, pot: boolean) => {
  const [x, y] = pot ? [nextPow2(w), nextPow2(h)] : [w, h];
  return Math.round(x * y * 4 * (mipmaps ? 4 / 3 : 1));
};

export function measures(a: Asset, b: Budget["gpu"]): Partial<Record<Metric, number>> {
  const m: Partial<Record<Metric, number>> = { bytes: a.bytes };
  if (a.type === "image" && a.width && a.height) {
    m.gpu = gpuBytes(a.width, a.height, b.mipmaps, b.power_of_two);
    m.side = Math.max(a.width, a.height);
  }
  if ((a.type === "audio" || a.type === "video") && a.duration) m.seconds = a.duration;
  if (a.model) {
    m.triangles = a.model.triangles;
    m.textures = a.model.textures.length;
    const sized = a.model.textures.filter(t => t.width && t.height);
    if (sized.length) {
      m.gpu = sized.reduce((s, t) => s + gpuBytes(t.width!, t.height!, b.model_mipmaps, b.power_of_two), 0);
      m.side = Math.max(...sized.map(t => Math.max(t.width!, t.height!)));
    }
  }
  return m;
}

export interface Violation {
  file: string | null; // null for a total
  section: string;
  limit: string; // "bytes", "total_gpu"
  value: number;
  max: number;
  over: number; // value / max
}

export function checkBudget(assets: Asset[], budget: Budget): { violations: Violation[]; totals: Record<string, Partial<Record<Metric, number>>> } {
  const violations: Violation[] = [];
  const totals: Record<string, Partial<Record<Metric, number>>> = { total: {} };
  for (const a of assets) {
    const m = measures(a, budget.gpu);
    for (const section of new Set(["total", a.type, a.kind])) {
      const t = (totals[section] ??= {});
      // Sums, but the longest side is the longest.
      for (const k of METRICS) if (m[k] !== undefined) t[k] = k === "side" ? Math.max(t[k] ?? 0, m[k]!) : (t[k] ?? 0) + m[k]!;
      if (section === "total") continue;
      const limits = budget.sections.get(section)?.file ?? {};
      for (const k of METRICS) {
        const max = limits[k];
        if (max !== undefined && m[k] !== undefined && m[k]! > max) violations.push({ file: a.path, section, limit: k, value: round(m[k]!, 3), max, over: round(m[k]! / max) });
      }
    }
  }
  for (const [section, limits] of budget.sections) {
    for (const k of METRICS) {
      const max = limits.total[k];
      const value = totals[section]?.[k] ?? 0;
      if (max !== undefined && value > max) violations.push({ file: null, section, limit: `total_${k}`, value: round(value, 3), max, over: round(value / max) });
    }
  }
  return { violations, totals };
}

const sizeText = (k: Metric | string, v: number) => (BYTE_METRICS.has(k.replace(/^total_/, "") as Metric) ? kb(v) : k.endsWith("seconds") ? `${round(v, 1)} s` : String(round(v, 1)));

TOOLS.push({
  group: "asset",
  name: "budget",
  args: "<folder or files...>",
  summary: "Size gate for a folder of assets: bytes, GPU memory, texture sides, sound seconds, triangles",
  details: [
    "Measures every asset: bytes on disk; GPU memory as uncompressed RGBA (width x height x 4, padded to",
    "powers of two and a third more for mipmaps when the config says so, the most a texture can take:",
    "GPU compression takes 4-8x less); the longest texture side; seconds of sound and video; a model's",
    "triangles, textures and their memory. Limits come from --config, else ludo-budget.json in the",
    "folder or here; without one it reports the totals and the biggest files.",
    "  { \"total\": { \"bytes\": \"200MB\", \"gpu\": \"512MB\" },",
    "    \"image\": { \"side\": 2048, \"gpu\": \"16MB\", \"total_gpu\": \"256MB\" },",
    "    \"audio\": { \"seconds\": 120 }, \"sfx\": { \"bytes\": \"200KB\", \"seconds\": 3 },",
    "    \"model\": { \"triangles\": 20000, \"textures\": 4 },",
    "    \"gpu\": { \"mipmaps\": false, \"power_of_two\": false, \"model_mipmaps\": true } }",
    "Sections are total, a type (image, audio, model, video) or a kind (spritesheet, texture, sfx, music,",
    "voice, ambience); a limit applies to each file, total_<limit> to them all. Limits: bytes, gpu, side,",
    "seconds, triangles, textures. With --ci, exit code 1 when anything is over."
  ],
  flags: [
    { flag: "--config", value: "file", description: "The budget (default: ludo-budget.json in the folder, else here)" },
    { flag: "--ci", description: "Exit 1 when over budget" },
    { flag: "--top", value: "n", description: "How many of the biggest files to list (default 10)" }
  ],
  async run(ctx: Ctx, call: ToolCall) {
    const found = findAssets(call.args, "ludo toolbox asset budget <folder> [--config ludo-budget.json] [--ci]");
    const configFlag = textFlag(call, "--config");
    const configFile = configFlag ?? [path.join(found.root, "ludo-budget.json"), "ludo-budget.json"].find(f => fs.existsSync(f));
    let budget: Budget = { gpu: { mipmaps: false, power_of_two: false, model_mipmaps: true }, sections: new Map() };
    if (configFile) {
      let text: string;
      try {
        text = fs.readFileSync(configFile, "utf8");
      } catch {
        throw new CliError(`File not found: ${configFile}`, EXIT.USAGE);
      }
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch (err) {
        throw new CliError(`${configFile} is not valid JSON: ${(err as Error).message}`, EXIT.USAGE);
      }
      budget = parseBudget(json, configFile);
    }
    const top = Math.round(positiveNumber(call, "--top") ?? 10);
    const assets = readAll(found);
    const { violations, totals } = checkBudget(assets, budget);
    const rows = assets.map(a => ({ path: a.path, kind: a.kind, ...measures(a, budget.gpu), a }));
    const biggest = (k: Metric) =>
      rows
        .filter(r => r[k] !== undefined)
        .sort((x, y) => y[k]! - x[k]!)
        .slice(0, top)
        .map(r => ({ path: r.path, kind: r.kind, [k]: r[k] }));
    const over = violations.length > 0;
    const worstImage = violations.map(v => assets.find(a => a.path === v.file)).find(a => a?.type === "image" && a.width);
    const next = !configFile
      ? hint("Gate it on limits from a JSON file", `ludo toolbox asset budget ${quoted(shown(found.root))} --config ludo-budget.json --ci`)
      : worstImage
        ? hint("Halve an over-budget texture", `ludo toolbox image scale ${quoted(shown(worstImage.file))} --by 1/2`)
        : hint("Check the folder against an engine's import rules", `ludo toolbox asset lint ${quoted(shown(found.root))} --engine godot`);
    const totalsOut = Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, { files: k === "total" ? assets.length : assets.filter(a => a.type === k || a.kind === k).length, ...Object.fromEntries(Object.entries(v).map(([m, x]) => [m, round(x!, 3)])) }]));
    if (ctx.jsonOut) {
      printJson(
        {
          folder: shown(found.root),
          config: configFile ? shown(configFile) : null,
          gpu: budget.gpu,
          totals: totalsOut,
          biggest: { bytes: biggest("bytes"), gpu: biggest("gpu") },
          violations,
          over,
          ...(ctx.globals.quiet ? {} : { hint: next })
        },
        false
      );
    } else {
      const out = (line: string) => process.stdout.write(line + "\n");
      const t = totals.total;
      out(`${assets.length} assets: ${kb(t.bytes ?? 0)} on disk, ${kb(t.gpu ?? 0)} of GPU memory at most${t.seconds ? `, ${round(t.seconds, 1)} s of sound and video` : ""}${t.triangles ? `, ${t.triangles} triangles` : ""}`);
      for (const [k, v] of Object.entries(totals)) if (k !== "total") out(`  ${k.padEnd(11)} ${kb(v.bytes ?? 0).padStart(9)} on disk${v.gpu ? `, ${kb(v.gpu)} GPU` : ""}${v.seconds ? `, ${round(v.seconds, 1)} s` : ""}${v.triangles ? `, ${v.triangles} triangles` : ""}`);
      out("Biggest on disk:");
      for (const r of biggest("bytes")) out(`  ${kb(r.bytes as number).padStart(9)}  ${r.path}`);
      if (!configFile) out("No budget: pass --config, or put ludo-budget.json in the folder.");
      else if (!over) out(`Within the budget in ${shown(configFile)}.`);
      else {
        out(`${violations.length} over the budget in ${shown(configFile)}:`);
        for (const v of violations) out(`  ${v.file ?? `all ${v.section === "total" ? "files" : v.section}`}: ${v.limit} ${sizeText(v.limit, v.value)} > ${sizeText(v.limit, v.max)} (${v.section})`);
      }
      if (!ctx.globals.quiet) process.stderr.write(`Next: ${next.text}: ${next.command}\n`);
    }
    return over && call.flags.has("--ci") ? EXIT.ERROR : EXIT.OK;
  }
});

// ---- asset scale ----

// "1.8m", "180cm", "32px", "2u" (engine units, which Unity and Godot 3D
// take as metres).
export function parseSize(spec: string, where: string): { value: number; unit: "m" | "px" } {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(m|cm|mm|u|px)?\s*$/i.exec(spec);
  if (!m || !Number(m[1])) throw new CliError(`${where} takes a height like 1.8m, 180cm or 32px (got "${spec}")`, EXIT.USAGE);
  const unit = (m[2] ?? "m").toLowerCase();
  const v = Number(m[1]);
  return unit === "px" ? { value: v, unit: "px" } : { value: unit === "cm" ? v / 100 : unit === "mm" ? v / 1000 : v, unit: "m" };
}

// "hero.png=1.8m" -> the file and its height. The last = splits, so a file
// name may hold one.
function fileAndSize(arg: string, where: string) {
  const at = arg.lastIndexOf("=");
  return at > 0 ? { file: arg.slice(0, at), size: parseSize(arg.slice(at + 1), where) } : { file: arg, size: undefined };
}

// How tall an asset is in its own units: a sprite's opaque height (the
// median over its frames, so a jump's top frame does not count as its
// height), a picture's opaque height, a model's bounds height (glTF is
// y-up).
export function measuredHeight(a: Asset): { height: number; unit: "px" | "units" } | undefined {
  if (a.model?.size) return { height: a.model.size[1], unit: "units" };
  if (a.type !== "image" || a.error) return undefined;
  const src = loadImageFile(a.file);
  const frames = framesOf(src.image, a.grid, 64);
  const isEmpty = emptiness(frames, 16);
  const heights = frames.map(f => contentBox([f], isEmpty)?.h).filter((h): h is number => !!h).sort((x, y) => x - y);
  return heights.length ? { height: heights[Math.floor(heights.length / 2)], unit: "px" } : undefined;
}

TOOLS.push({
  group: "asset",
  name: "scale",
  args: "<files...>",
  summary: "Consistent scale factors for sprites and models from one reference: Unity pixels per unit, Godot scale",
  details: [
    "--reference hero.png=1.8m (or 180cm) says how tall that asset is in the game; =32px says how many",
    "screen pixels tall. Every other file is taken as tall as the reference unless it says its own",
    "height (slime.png=0.5m). Heights are measured: a sprite's opaque height (the median over its",
    "frames), a model's bounds height. In metres it gives Unity's Pixels Per Unit and Godot's Sprite3D",
    "pixel_size for sprites, and the scale for models; in pixels, Godot's Sprite2D scale and Unity's",
    "Pixels Per Unit at --ppu (default 100, Unity's). Outliers: a sprite drawn at a pixel density over",
    "25% off the reference's (one shared Pixels Per Unit would draw it that much off), or a model that",
    "needs 10x or more, as one authored in centimetres would. Nothing is resized."
  ],
  flags: [
    { flag: "--reference", value: "file=height", description: "The asset whose height you know: hero.png=1.8m or tile.png=32px" },
    { flag: "--ppu", value: "n", description: "With a px reference, the game's Unity Pixels Per Unit (default 100)" }
  ],
  async run(ctx: Ctx, call: ToolCall) {
    const refSpec = textFlag(call, "--reference");
    if (!refSpec) throw new CliError("Usage: ludo toolbox asset scale <files...> --reference hero.png=1.8m", EXIT.USAGE);
    const ref = fileAndSize(refSpec, "--reference");
    if (!ref.size) throw new CliError(`--reference takes file=height, like hero.png=1.8m (got "${refSpec}")`, EXIT.USAGE);
    const ppu = positiveNumber(call, "--ppu") ?? 100;
    const given = call.args.map(a => fileAndSize(a, a));
    if (!given.some(g => path.resolve(g.file) === path.resolve(ref.file))) given.unshift({ file: ref.file, size: ref.size });
    const found = findAssets(given.map(g => g.file), "ludo toolbox asset scale <files...> --reference hero.png=1.8m");
    const sizes = new Map(given.map(g => [path.resolve(g.file), g.size]));
    const assets = readAll(found).filter(a => a.type === "image" || a.type === "model");
    const unit = ref.size.unit;
    const rows = assets.map(a => {
      const own = path.resolve(a.file) === path.resolve(ref.file) ? ref.size : sizes.get(path.resolve(a.file));
      if (own && own.unit !== unit) throw new CliError(`${a.path} is given in ${own.unit} and the reference in ${unit}: use one unit`, EXIT.USAGE);
      const target = own ?? ref.size!;
      const m = measuredHeight(a);
      return { a, target: target.value, assumed: !own, m };
    });
    const refRow = rows.find(r => path.resolve(r.a.file) === path.resolve(ref.file));
    if (!refRow?.m) throw new CliError(`Cannot measure ${ref.file}: it has nothing opaque, or is not a sprite, image or glTF model`, EXIT.BAD_INPUT);
    const refDensity = refRow.m.height / refRow.target;
    const results = rows.map(({ a, target, assumed, m }) => {
      const base = { path: a.path, kind: a.kind, target: round(target, 4), unit, ...(assumed ? { assumed: true } : {}) };
      if (!m) return { ...base, error: a.error ?? "nothing opaque to measure" };
      const s = target / m.height; // target units per measured unit
      const out: Record<string, unknown> = { ...base, measured: round(m.height, 4), measured_unit: m.unit, scale: round(s, 6) };
      if (m.unit === "px" && unit === "m") {
        out.unity = { pixels_per_unit: round(m.height / target, 2) };
        out.godot = { pixel_size: round(s, 6) };
      } else if (m.unit === "px") {
        out.unity = { pixels_per_unit: round((m.height * ppu) / target, 2) };
        out.godot = { scale: round(s, 4) };
      } else if (unit === "m") {
        out.unity = { scale: round(s, 4) };
        out.godot = { scale: round(s, 4) };
      } else return { ...base, measured: round(m.height, 4), measured_unit: m.unit, error: "a model's height needs a reference in metres" };
      // A sprite is an outlier when one shared pixels-per-unit would draw it
      // over 25% off its height, or over 10% for another animation of the
      // reference's own character (it would grow or shrink between moves);
      // a model when its units look like another unit's (10x or more off a
      // metre).
      const density = m.height / target;
      const character = characterOf(a.path).character;
      const sameCharacter = !!character && character === characterOf(refRow.a.path).character;
      const k = density / refDensity;
      if (m.unit === "px" && refRow.m!.unit === "px" && Math.abs(k - 1) > (sameCharacter ? 0.1 : 0.25)) {
        out.outlier = `drawn at ${round(k, 2)}x the reference's pixels per ${unit === "m" ? "metre" : "screen pixel"}: at the reference's Pixels Per Unit it would stand ${Math.round(Math.abs(k - 1) * 100)}% ${k > 1 ? "taller" : "shorter"} than ${round(target, 3)} ${unit}${sameCharacter ? `, so ${character} changes size between animations` : ""}`;
      }
      if (m.unit === "units" && (s >= 10 || s <= 0.1)) out.outlier = `needs ${round(s, 4)}x: probably authored in ${s >= 10 ? "another unit than metres" : "centimetres or millimetres"}`;
      return out;
    });
    const outliers = results.filter(r => "outlier" in r).map(r => r.path);
    const firstOut = rows.find(r => outliers.includes(r.a.path) && r.a.type === "image");
    const next = firstOut
      ? hint("Compare the outlier with the reference", `ludo toolbox asset diff ${quoted(shown(ref.file))} ${quoted(shown(firstOut.a.file))}`)
      : hint("See what else is in the folder", `ludo toolbox asset manifest ${quoted(shown(found.root))}`);
    if (ctx.jsonOut) {
      printJson({ reference: { path: refRow.a.path, height: ref.size.value, unit, measured: round(refRow.m.height, 4), measured_unit: refRow.m.unit }, ...(unit === "px" ? { ppu } : {}), assets: results, outliers, ...(ctx.globals.quiet ? {} : { hint: next }) }, false);
    } else {
      const out = (line: string) => process.stdout.write(line + "\n");
      out(`Reference ${refRow.a.path}: ${round(refRow.m.height, 3)} ${refRow.m.unit} tall = ${ref.size.value} ${unit}`);
      for (const r of results as Record<string, any>[]) {
        if (r.error) {
          out(`  ${r.path}: ${r.error}`);
          continue;
        }
        const unity = r.unity.pixels_per_unit !== undefined ? `Unity PPU ${r.unity.pixels_per_unit}` : `Unity scale ${r.unity.scale}`;
        const godot = r.godot.pixel_size !== undefined ? `Godot pixel_size ${r.godot.pixel_size}` : `Godot scale ${r.godot.scale}`;
        out(`  ${r.path}: ${r.measured} ${r.measured_unit} -> ${r.target} ${unit}${r.assumed ? " (as the reference)" : ""}; ${unity}, ${godot}${r.outlier ? `\n    outlier: ${r.outlier}` : ""}`);
      }
      if (!ctx.globals.quiet) process.stderr.write(`Next: ${next.text}: ${next.command}\n`);
    }
    return EXIT.OK;
  }
});

// ---- asset diff ----

interface SheetLook {
  frames: Image[];
  grid?: SheetGrid;
  width: number;
  height: number;
  fps?: number;
  ground: number; // px from the frame's bottom edge to the lowest opaque row
  bounds: { x: number; y: number; w: number; h: number }; // every frame's opaque pixels, in frame coordinates
  height_px: number; // the median frame's opaque height
  colours: { colour: [number, number, number]; count: number }[];
}

function lookAt(file: string): SheetLook {
  const src = loadImageFile(file);
  const grid = gridOf(src);
  const frames = framesOf(src.image, grid);
  const isEmpty = emptiness(frames, 16);
  const boxes = frames.map(f => contentBox([f], isEmpty));
  const solid = boxes.filter((b): b is NonNullable<typeof b> => !!b);
  const fw = frames[0].width;
  const fh = frames[0].height;
  const bounds = solid.length
    ? { x: Math.min(...solid.map(b => b.x)), y: Math.min(...solid.map(b => b.y)), w: Math.max(...solid.map(b => b.x + b.w)) - Math.min(...solid.map(b => b.x)), h: Math.max(...solid.map(b => b.y + b.h)) - Math.min(...solid.map(b => b.y)) }
    : { x: 0, y: 0, w: 0, h: 0 };
  const heights = solid.map(b => b.h).sort((x, y) => x - y);
  return {
    frames,
    grid,
    width: src.image.width,
    height: src.image.height,
    fps: grid?.fps,
    ground: solid.length ? fh - (bounds.y + bounds.h) : fh,
    bounds,
    height_px: heights.length ? heights[Math.floor(heights.length / 2)] : 0,
    colours: coloursOf(frames).map(c => ({ colour: c.colour as [number, number, number], count: c.count }))
  };
}

// How alike two palettes are: with 256 colours or fewer each (pixel art),
// which colours came and went; otherwise the overlap of their colour
// histograms (16 levels a channel, by pixel share; 1 = the same mix).
function paletteChange(a: SheetLook["colours"], b: SheetLook["colours"]) {
  if (a.length <= 256 && b.length <= 256) {
    const key = (c: [number, number, number]) => (c[0] << 16) | (c[1] << 8) | c[2];
    const ka = new Set(a.map(c => key(c.colour)));
    const kb = new Set(b.map(c => key(c.colour)));
    const hex = (k: number) => `#${k.toString(16).padStart(6, "0")}`;
    const added = [...kb].filter(k => !ka.has(k));
    const removed = [...ka].filter(k => !kb.has(k));
    return { colours: [a.length, b.length], exact: true, added: added.slice(0, 32).map(hex), removed: removed.slice(0, 32).map(hex), similarity: round(1 - (added.length + removed.length) / Math.max(1, ka.size + kb.size), 3) };
  }
  const hist = (cs: SheetLook["colours"]) => {
    const h = new Float64Array(4096);
    let total = 0;
    for (const { colour: [r, g, bl], count } of cs) {
      h[((r >> 4) << 8) | ((g >> 4) << 4) | (bl >> 4)] += count;
      total += count;
    }
    return h.map(v => v / (total || 1));
  };
  const [ha, hb] = [hist(a), hist(b)];
  let overlap = 0;
  for (let i = 0; i < 4096; i++) overlap += Math.min(ha[i], hb[i]);
  return { colours: [a.length, b.length], exact: false, similarity: round(overlap, 3) };
}

// How alike two animations look, 0 to 1: up to 16 frames at the same
// points of each, compared by a 16x16 difference hash. Unrelated pictures
// differ in about half their bits, so the score is 1 - 2 x that share:
// 1 the same, 0 no more alike than chance.
function lookalike(a: Image[], b: Image[]): number {
  const k = Math.min(16, a.length, b.length);
  let bits = 0;
  for (let i = 0; i < k; i++) {
    const [fa, fb] = [a[Math.floor((i * a.length) / k)], b[Math.floor((i * b.length) / k)]];
    bits += hamming(dHash(fa, 16, 16), dHash(fb, 16, 16));
  }
  return round(Math.max(0, 1 - (2 * bits) / (k * 256)), 3);
}

// The picture of a diff: A's first frame, B's first frame, and both
// silhouettes over every frame (A magenta, B green, both white) with each
// one's ground line, all anchored at the bottom centre as a sprite stands.
function diffImage(a: SheetLook, b: SheetLook): Image {
  const w = Math.max(a.frames[0].width, b.frames[0].width);
  const h = Math.max(a.frames[0].height, b.frames[0].height);
  const gap = 8;
  const out: Image = { width: w * 3 + gap * 4, height: h + gap * 2, rgba: new Uint8Array((w * 3 + gap * 4) * (h + gap * 2) * 4) };
  for (let i = 0; i < out.rgba.length; i += 4) out.rgba.set([30, 30, 46, 255], i);
  const put = (x: number, y: number, c: number[]) => {
    if (x < 0 || y < 0 || x >= out.width || y >= out.height) return;
    const i = (y * out.width + x) * 4;
    const al = c[3] / 255;
    for (let k = 0; k < 3; k++) out.rgba[i + k] = Math.round(c[k] * al + out.rgba[i + k] * (1 - al));
  };
  const origin = (f: Image, panel: number) => [gap + panel * (w + gap) + Math.floor((w - f.width) / 2), gap + h - f.height];
  const draw = (f: Image, panel: number) => {
    const [ox, oy] = origin(f, panel);
    for (let y = 0; y < f.height; y++) for (let x = 0; x < f.width; x++) {
      const i = (y * f.width + x) * 4;
      if (f.rgba[i + 3]) put(ox + x, oy + y, [f.rgba[i], f.rgba[i + 1], f.rgba[i + 2], f.rgba[i + 3]]);
    }
  };
  draw(a.frames[0], 0);
  draw(b.frames[0], 1);
  const silhouette = (s: SheetLook) => {
    const f = s.frames[0];
    const mask = new Uint8Array(f.width * f.height);
    for (const fr of s.frames) for (let i = 0; i < mask.length; i++) if (fr.rgba[i * 4 + 3] > 16) mask[i] = 1;
    return { mask, w: f.width, h: f.height };
  };
  const [sa, sb] = [silhouette(a), silhouette(b)];
  const [ax, ay] = origin(a.frames[0], 2);
  const [bx, by] = origin(b.frames[0], 2);
  const at2 = (s: ReturnType<typeof silhouette>, ox: number, oy: number, x: number, y: number) => {
    const [u, v] = [x - ox, y - oy];
    return u >= 0 && v >= 0 && u < s.w && v < s.h && s.mask[v * s.w + u] === 1;
  };
  const x0 = gap + 2 * (w + gap);
  for (let y = gap; y < gap + h; y++) for (let x = x0; x < x0 + w; x++) {
    const [inA, inB] = [at2(sa, ax, ay, x, y), at2(sb, bx, by, x, y)];
    if (inA && inB) put(x, y, [235, 235, 235, 255]);
    else if (inA) put(x, y, [230, 60, 160, 255]);
    else if (inB) put(x, y, [60, 200, 120, 255]);
  }
  // Ground lines: where each one's lowest opaque pixel sits.
  for (const [s, c] of [[a, [230, 60, 160, 255]], [b, [60, 200, 120, 255]]] as const) {
    const y = gap + h - 1 - s.ground;
    for (let x = gap; x < x0 + w; x++) for (const dy of [0, 1]) put(x, y + dy, [c[0], c[1], c[2], x < x0 ? 140 : 255]);
  }
  return out;
}

function diffImages(a: string, b: string) {
  const [la, lb] = [lookAt(a), lookAt(b)];
  const fa = la.frames.length;
  const fb = lb.frames.length;
  const [cwA, chA, cwB, chB] = [la.frames[0].width, la.frames[0].height, lb.frames[0].width, lb.frames[0].height];
  const breaking: string[] = [];
  const changes: string[] = [];
  if (fa !== fb) breaking.push(`frames ${fa}→${fb}`);
  if (cwA !== cwB || chA !== chB) breaking.push(`frame size ${cwA}x${chA}→${cwB}x${chB}`);
  if (la.grid && lb.grid && fa === fb && (la.grid.cols !== lb.grid.cols || la.grid.rows !== lb.grid.rows)) breaking.push(`grid ${la.grid.cols}x${la.grid.rows}→${lb.grid.cols}x${lb.grid.rows} (engine files made for the old one point at the wrong cells)`);
  const groundShift = lb.ground - la.ground;
  if (Math.abs(groundShift) > 2) breaking.push(`ground moved ${Math.abs(groundShift)} px ${groundShift > 0 ? "up" : "down"}`);
  else if (groundShift) changes.push(`ground moved ${Math.abs(groundShift)} px`);
  const heightRatio = la.height_px ? lb.height_px / la.height_px : 1;
  if (Math.abs(heightRatio - 1) > 0.1) breaking.push(`height ${la.height_px}→${lb.height_px} px (${Math.round((heightRatio - 1) * 100)}%)`);
  else if (la.height_px !== lb.height_px) changes.push(`height ${la.height_px}→${lb.height_px} px`);
  const cx = (s: SheetLook, w: number) => s.bounds.x + s.bounds.w / 2 - w / 2;
  const shiftX = round(cx(lb, cwB) - cx(la, cwA), 1);
  if (Math.abs(shiftX) >= 2) changes.push(`centre moved ${Math.abs(shiftX)} px ${shiftX > 0 ? "right" : "left"}`);
  if (la.fps && lb.fps && la.fps !== lb.fps) changes.push(`fps ${la.fps ?? "?"}→${lb.fps ?? "?"}`);
  const palette = paletteChange(la.colours, lb.colours);
  if (palette.similarity < 0.9) changes.push(`palette ${Math.round(palette.similarity * 100)}% alike`);
  const similarity = lookalike(la.frames, lb.frames);
  const facts = (s: SheetLook) => ({
    width: s.width,
    height: s.height,
    frames: s.frames.length,
    frame_width: s.frames[0].width,
    frame_height: s.frames[0].height,
    ...(s.grid ? { grid: { cols: s.grid.cols, rows: s.grid.rows, from: s.grid.from } } : {}),
    fps: s.fps ?? null,
    ground: s.ground,
    bounds: s.bounds,
    opaque_height: s.height_px
  });
  return { type: "image" as const, a: facts(la), b: facts(lb), palette, similarity, breaking, changes, looks: [la, lb] as const };
}

function diffSounds(a: string, b: string) {
  const facts = (file: string) => {
    const src = loadAudioFile(file);
    const au = src.audio;
    const mono = toMono(au).channels[0];
    let peakAt = 0;
    for (let i = 1; i < mono.length; i++) if (Math.abs(mono[i]) > Math.abs(mono[peakAt])) peakAt = i;
    const lufs = loudness(au).lufs;
    return { format: src.format, rate: au.rate, channels: au.channels.length, duration: round(sampleFrames(au) / au.rate, 3), loudness_lufs: Number.isFinite(lufs) ? round(lufs, 1) : null, peak_db: Number.isFinite(toDb(samplePeak(au))) ? round(toDb(samplePeak(au)), 1) : null, peak_at: round(peakAt / au.rate, 3) };
  };
  const [fa, fb] = [facts(a), facts(b)];
  const breaking: string[] = [];
  const changes: string[] = [];
  const dd = fb.duration - fa.duration;
  // Timed to something (an animation, a cue) when within 10% or 50 ms.
  if (Math.abs(dd) > 0.05 && Math.abs(dd) > 0.1 * fa.duration) breaking.push(`duration ${fa.duration}→${fb.duration} s`);
  else if (dd) changes.push(`duration ${fa.duration}→${fb.duration} s`);
  if (fa.loudness_lufs !== null && fb.loudness_lufs !== null) {
    const dl = round(fb.loudness_lufs - fa.loudness_lufs, 1);
    // A mix balanced by ear notices 3 LU.
    if (Math.abs(dl) > 3) breaking.push(`loudness ${fa.loudness_lufs}→${fb.loudness_lufs} LUFS`);
    else if (dl) changes.push(`loudness ${dl > 0 ? "+" : ""}${dl} LU`);
  }
  const dp = round(fb.peak_at - fa.peak_at, 3);
  if (Math.abs(dp) > 0.05) breaking.push(`peak moved ${Math.abs(dp)} s ${dp > 0 ? "later" : "earlier"} (${fa.peak_at}→${fb.peak_at} s)`);
  if (fa.channels !== fb.channels) changes.push(`channels ${fa.channels}→${fb.channels}`);
  if (fa.rate !== fb.rate) changes.push(`sample rate ${fa.rate}→${fb.rate}`);
  return { type: "audio" as const, a: fa, b: fb, breaking, changes };
}

function diffModels(a: string, b: string) {
  const facts = (file: string) => {
    const asset = readAsset(file, path.basename(file));
    if (asset.error || !asset.model) throw new CliError(`Cannot read ${file} as a glTF model${asset.error ? `: ${asset.error}` : ""}`, EXIT.BAD_INPUT);
    return asset.model;
  };
  const [ma, mb] = [facts(a), facts(b)];
  const breaking: string[] = [];
  const changes: string[] = [];
  const gone = (x: string[], y: string[]) => x.filter(n => !y.includes(n));
  const lostBones = gone(ma.joints, mb.joints);
  const newBones = gone(mb.joints, ma.joints);
  if (lostBones.length) breaking.push(`bones missing: ${lostBones.slice(0, 8).join(", ")}${lostBones.length > 8 ? ` and ${lostBones.length - 8} more` : ""}`);
  if (newBones.length) changes.push(`bones added: ${newBones.slice(0, 8).join(", ")}${newBones.length > 8 ? ` and ${newBones.length - 8} more` : ""}`);
  const lostClips = gone(ma.clips, mb.clips);
  if (lostClips.length) breaking.push(`clips missing: ${lostClips.join(", ")}`);
  const newClips = gone(mb.clips, ma.clips);
  if (newClips.length) changes.push(`clips added: ${newClips.join(", ")}`);
  if (ma.size && mb.size) {
    const ratio = mb.size[1] / ma.size[1];
    if (Math.abs(ratio - 1) > 0.1) breaking.push(`height ${round(ma.size[1], 3)}→${round(mb.size[1], 3)}`);
    const ground = round(mb.min![1] - ma.min![1], 4);
    if (Math.abs(ground) > 0.01 * ma.size[1]) breaking.push(`ground moved ${Math.abs(ground)} ${ground > 0 ? "up" : "down"}`);
  }
  if (ma.triangles !== mb.triangles) changes.push(`triangles ${ma.triangles}→${mb.triangles}`);
  const pick = (m: NonNullable<Asset["model"]>) => ({ size: m.size ?? null, min: m.min ?? null, triangles: m.triangles, joints: m.joints, clips: m.clips });
  return { type: "model" as const, a: pick(ma), b: pick(mb), breaking, changes };
}

TOOLS.push({
  group: "asset",
  name: "diff",
  args: "<a> <b>",
  summary: "Compare two versions or takes of one asset, and say whether the new one drops in",
  details: [
    "Images and sheets: size, frames, frame size, grid, fps, the ground line (the lowest opaque row,",
    "from the frame's bottom), opaque bounds and height, palette, and how alike they look (0-1, a",
    "difference hash over up to 16 frames). Sounds: length, loudness (LUFS), peak level and when the",
    "peak comes. Models: bounds, bone names, clip names, triangles. `compatible` is false when",
    "something that code or other assets rely on changed: frame count or size, the grid, the ground",
    "by more than 2 px, the height by more than 10%; a sound's length by more than 10%, its loudness",
    "by more than 3 LU, its peak by more than 50 ms; bones or clips gone, a model's height or ground.",
    "--image writes a picture: both first frames, and both silhouettes over every frame with their",
    "ground lines (A magenta, B green)."
  ],
  flags: [{ flag: "--image", description: "Also write a diff PNG (images and sheets)" }],
  async run(ctx: Ctx, call: ToolCall) {
    if (call.args.length !== 2) throw new CliError("Usage: ludo toolbox asset diff <a> <b> [--image]", EXIT.USAGE);
    const [a, b] = call.args;
    for (const f of [a, b]) if (!fs.existsSync(f)) throw new CliError(`File not found: ${f}`, EXIT.USAGE);
    const [ta, tb] = [typeOf(a), typeOf(b)];
    if (!ta || ta !== tb || ta === "video") throw new CliError(`asset diff compares two images, two sounds or two models (got ${ta ?? "an unknown type"} and ${tb ?? "an unknown type"})`, EXIT.USAGE);
    if (call.flags.has("--image") && ta !== "image") throw new CliError("--image draws images and sheets only", EXIT.USAGE);
    let result: ReturnType<typeof diffImages> | ReturnType<typeof diffSounds> | ReturnType<typeof diffModels>;
    try {
      result = ta === "image" ? diffImages(a, b) : ta === "audio" ? diffSounds(a, b) : diffModels(a, b);
    } catch (err) {
      if (err instanceof ModelError || err instanceof TypeError) throw new CliError(`Cannot read a model: ${err.message}`, EXIT.BAD_INPUT);
      throw err;
    }
    let picture: string | undefined;
    if (call.flags.has("--image") && result.type === "image") {
      picture = freeName(ctx.outDir, ctx.globals.name || `${baseOf(a)}-vs-${baseOf(b)}`, ".png");
      writePng(picture, diffImage(...result.looks));
    }
    const { looks, a: factsA, b: factsB, ...rest } = result as ReturnType<typeof diffImages>;
    const compatible = result.breaking.length === 0;
    const next: Hint =
      result.type === "image"
        ? compatible
          ? hint("Check which take loops better", `ludo toolbox sprite loop ${quoted(shown(a))} ${quoted(shown(b))}`)
          : hint("See both sheets' frames", `ludo toolbox sprite slice ${quoted(shown(b))}`)
        : result.type === "audio"
          ? hint("See the new one's loudness and loop", `ludo toolbox audio info ${quoted(shown(b))}`)
          : hint("See the new model in full", `ludo toolbox model info ${quoted(shown(b))}`);
    if (ctx.jsonOut) {
      printJson({ ...rest, a: { file: shown(a), ...factsA }, b: { file: shown(b), ...factsB }, compatible, ...(picture ? { image: shown(picture) } : {}), ...(ctx.globals.quiet ? {} : { hint: next }) }, false);
    } else {
      const out = (line: string) => process.stdout.write(line + "\n");
      out(`${shown(a)} -> ${shown(b)}: ${compatible ? "compatible" : "not compatible"}`);
      for (const x of result.breaking) out(`  breaking: ${x}`);
      for (const x of result.changes) out(`  changed:  ${x}`);
      if (result.type === "image") out(`  looks ${Math.round(result.similarity * 100)}% alike; palette ${Math.round(result.palette.similarity * 100)}% alike`);
      if (!result.breaking.length && !result.changes.length) out("  nothing else changed");
      if (picture) out(`Saved ${shown(picture)}`);
      if (!ctx.globals.quiet) process.stderr.write(`Next: ${next.text}: ${next.command}\n`);
    }
    return EXIT.OK;
  }
});
