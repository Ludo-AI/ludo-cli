import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CliError, EXIT } from "../errors.js";
import { printJson, type Ctx } from "../generate.js";
import { MAX_TOOLBOX_PIXELS, type Image } from "../tty/png.js";
import type { Grid } from "../tty/preview.js";
import { parseGrid } from "../tty/preview.js";
import { baseOf, carriedChunks, engineFiles, freeName, loadImageFile, shown, writePng, type Loaded } from "./io.js";
import { crop, joinFrames, sliceSheet } from "./sheet.js";
import { buildPack, layoutSheet, type ArtMode } from "./pack.js";
import { MAX_TARGET_FRAME_PX, uniquifyNames } from "./packMath.js";
import { frameFiles, resolveGrid } from "./sprite.js";
import { textFlag } from "./flags.js";
import { hint, TOOLS, type ToolCall } from "./registry.js";

// `ludo toolbox sprite pack`: the web app's Export Pack, offline. The pixel
// work is pack.ts; this reads the inputs and per-animation flags, writes the
// sheets (or frames) and a pack.json manifest that re-runs the pack exactly.

const MANIFEST_VERSION = 1;
const MODES = ["sheets", "frames"] as const;
type Mode = (typeof MODES)[number];

interface Animation {
  input: string; // as given (a sheet, or a folder of frames)
  kind: "sheet" | "frames";
  name: string; // the input's file or folder name, to pick it in flags
  frames: Image[];
  grid: Grid; // the layout its sheet keeps
  src?: Loaded; // the sheet, for its colour chunks
  sha256?: string;
}

interface ManifestAnimation {
  input: string; // relative to the manifest
  kind: "sheet" | "frames";
  sha256?: string;
  label: string;
  grid: { cols: number; rows: number; frames: number };
  fps: number;
  size: number;
  ground: number;
  offset_x: number;
}

interface Manifest {
  ludo: "toolbox sprite pack";
  version: number;
  name: string;
  mode: Mode;
  art: ArtMode;
  frame_size: { width?: number; height?: number } | null;
  animations: ManifestAnimation[];
}

const usage = (message: string, hintText?: string) => new CliError(message, EXIT.USAGE, hintText);
const sha256 = (file: string) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

// The web's folder name: lower case, anything but letters and digits a dash.
const folderName = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "animation-pack";

function loadAnimation(input: string, grid?: { cols: number; rows: number; frames?: number }, gridFlag = "--grid"): Animation {
  const stat = fs.statSync(input, { throwIfNoEntry: false });
  if (stat?.isDirectory()) {
    const files = frameFiles([input]);
    const loaded = files.map(loadImageFile);
    // Frames of different sizes are centred in the largest, as join does.
    const cols = grid?.cols ?? Math.ceil(Math.sqrt(loaded.length));
    const { sheet, rows } = joinFrames(
      loaded.map(f => f.image),
      cols
    );
    const frames = sliceSheet(sheet, cols, rows, loaded.length);
    return { input, kind: "frames", name: path.basename(path.resolve(input)), frames, grid: { cols, rows: grid?.rows ?? rows, frames: frames.length, fps: loaded[0].grid?.fps ?? 10 }, src: loaded[0] };
  }
  const src = loadImageFile(input);
  let resolved: Grid;
  if (grid?.frames) {
    if (grid.cols * grid.rows < grid.frames || grid.cols > src.image.width || grid.rows > src.image.height) throw usage(`The manifest's ${grid.cols}x${grid.rows} grid does not fit ${input}`);
    resolved = { cols: grid.cols, rows: grid.rows, frames: grid.frames, fps: src.grid?.fps ?? 10 };
  } else {
    resolved = resolveGrid(src, grid, gridFlag).grid;
  }
  // An extruded sheet's frames without their repeated border, as slice cuts them.
  const e = src.extrude ?? 0;
  const frames = sliceSheet(src.image, resolved.cols, resolved.rows, resolved.frames).map(img => (e ? crop(img, { x: e, y: e, w: img.width - 2 * e, h: img.height - 2 * e }) : img));
  return { input, kind: "sheet", name: baseOf(input), frames, grid: resolved, src, sha256: sha256(input) };
}

// Per-animation values: `--size walk=1.2` (by file name), `--size 2=1.2` (by
// position, from 1), or `--size 1.2` for every animation. Later ones win.
function perAnimation<T>(call: ToolCall, flag: string, names: string[][], parse: (v: string) => T): Map<number, T> {
  const out = new Map<number, T>();
  for (const raw of call.lists.get(flag) ?? []) {
    const eq = raw.indexOf("=");
    const value = parse(eq < 0 ? raw : raw.slice(eq + 1));
    if (eq < 0) {
      names.forEach((_, i) => out.set(i, value));
      continue;
    }
    const key = raw.slice(0, eq);
    out.set(pickAnimation(key, names, flag), value);
  }
  return out;
}

// `names` holds each animation's file name and, once given, its label.
function pickAnimation(key: string, names: string[][], flag: string): number {
  const n = Number(key);
  if (/^\d+$/.test(key)) {
    if (n >= 1 && n <= names.length) return n - 1;
    throw usage(`${flag} ${key}=...: there are ${names.length} animations, numbered from 1`);
  }
  const hits = names.flatMap((aliases, i) => (aliases.includes(key) ? [i] : []));
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw usage(`${flag} ${key}=...: ${key} is animations ${hits.map(i => i + 1).join(" and ")}; pick one by its number`);
  throw usage(`${flag} ${key}=...: no animation is called ${key}`, `Animations: ${names.map((aliases, i) => `${i + 1} ${aliases.join(" / ")}`).join(", ")}`);
}

const parseNumber = (flag: string, check: (n: number) => boolean, what: string) => (v: string) => {
  const n = Number(v);
  if (v.trim() === "" || !Number.isFinite(n) || !check(n)) throw usage(`${flag} takes ${what} (got "${v}")`);
  return n;
};

function frameSizeFlag(raw: string | undefined): { width?: number; height?: number } | undefined {
  if (raw === undefined) return undefined;
  const m = /^(\d*)x(\d*)$/i.exec(raw.trim());
  const [w, h] = m ? [m[1] ? Number(m[1]) : undefined, m[2] ? Number(m[2]) : undefined] : [];
  if (!m || (w === undefined && h === undefined) || w === 0 || h === 0) throw usage(`--frame-size takes width x height, like 256x256, 256x or x256 (got "${raw}")`);
  if ((w ?? 0) > MAX_TARGET_FRAME_PX || (h ?? 0) > MAX_TARGET_FRAME_PX) throw usage(`--frame-size goes up to ${MAX_TARGET_FRAME_PX}`);
  return { width: w, height: h };
}

// Inputs relative to the manifest, so a pack and its sources move together;
// absolute when they share no folder but the root (or another drive).
function manifestPath(dir: string, input: string): string {
  const abs = path.resolve(input);
  const shared = (a: string, b: string) => {
    const [x, y] = [a.split(path.sep), b.split(path.sep)];
    let n = 0;
    while (n < x.length && n < y.length && x[n] === y[n]) n++;
    return x.slice(0, n).filter(Boolean).length;
  };
  const rel = path.relative(dir, abs);
  return path.isAbsolute(rel) || shared(path.resolve(dir), abs) === 0 ? abs : rel.split(path.sep).join("/");
}

function readManifest(file: string): Manifest {
  let m: Manifest;
  try {
    m = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new CliError(code === "ENOENT" ? `File not found: ${file}` : `Cannot read ${file}: ${(err as Error).message}`, code === "ENOENT" ? EXIT.USAGE : EXIT.BAD_INPUT);
  }
  const ok =
    m &&
    m.ludo === "toolbox sprite pack" &&
    Array.isArray(m.animations) &&
    m.animations.length > 0 &&
    m.animations.every(a => a && typeof a.input === "string" && a.grid && Number.isInteger(a.grid.cols) && Number.isInteger(a.grid.rows) && Number.isInteger(a.grid.frames));
  if (!ok) throw new CliError(`${file} is not a pack manifest written by ludo toolbox sprite pack`, EXIT.BAD_INPUT);
  if (m.version > MANIFEST_VERSION) throw new CliError(`${file} was written by a newer ludo (manifest version ${m.version})`, EXIT.BAD_INPUT, "Update the CLI: npm i -g @ludoai/cli");
  return m;
}

TOOLS.push({
  group: "sprite",
  name: "pack",
  args: "<sheets...>",
  summary: "Bring several animations of one character to one size and ground line, in one frame size",
  details: [
    "The Ludo web app's Export Pack, offline. Each input is a spritesheet (or a folder of frames) of one",
    "animation. Each is cropped to the box around all its frames, scaled so frame 1's character matches",
    "the shortest one, and drawn centred with frame 1's feet on a shared ground line, in a frame size",
    "every animation shares. Each sheet keeps its own grid.",
    "",
    "Adjust an animation by its file name, its label or its position: --size walk=1.2, --ground 2=-3.",
    "A value with no name applies to all. --ground is the web's Vertical value (pixels, up is",
    "positive); the output gives each animation's, so you can nudge it. The pack folder gets a",
    "pack.json that re-runs it exactly: ludo toolbox sprite pack --manifest <pack>/pack.json (flags",
    "given with it override it).",
    "",
    "--art smooth resizes with area averaging when shrinking and bicubic when enlarging; pixel uses",
    "nearest neighbour. Sheets whose size does not divide by their grid are cut into whole-pixel cells.",
    "--name names the pack's folder (default animation-pack); --engine texturepacker|godot writes engine",
    "files next to each sheet, named after its animation."
  ],
  flags: [
    { flag: "--mode", value: "sheets|frames", description: "One spritesheet per animation (default), or a folder of frames each" },
    { flag: "--art", value: "smooth|pixel", description: "Resizing for painted art (default) or pixel art" },
    { flag: "--frame-size", value: "WxH", description: "Grow the shared frame to at least this size, like 256x256 (or 256x, x256)" },
    { flag: "--size", value: "[anim=]n", description: "Scale an animation's character by n after matching heights (default 1)" },
    { flag: "--ground", value: "[anim=]px", description: "Raise (or lower, negative) an animation against the ground line" },
    { flag: "--offset-x", value: "[anim=]px", description: "Move an animation right (or left, negative)" },
    { flag: "--label", value: "anim=name", description: "Name an animation's output (default: its file name)" },
    { flag: "--fps", value: "[anim=]n", description: "Frame rate the sheets remember (default: each sheet's, else 10)" },
    { flag: "--grid", value: "[anim=]CxR", description: "A sheet's grid, when it has no Ludo stamp and detection is unsure" },
    { flag: "--manifest", value: "file", description: "Re-run a pack from its pack.json" }
  ],
  async run(ctx: Ctx, call: ToolCall) {
    const manifestFile = textFlag(call, "--manifest");
    if (manifestFile !== undefined && call.args.length) throw usage("Pass the animations or --manifest, not both");
    if (manifestFile === undefined && !call.args.length) throw usage("Usage: ludo toolbox sprite pack <sheets...> (or --manifest pack.json)");
    const manifest = manifestFile !== undefined ? readManifest(manifestFile) : undefined;
    const base = manifestFile !== undefined ? path.dirname(path.resolve(manifestFile)) : process.cwd();

    const mode = (textFlag(call, "--mode") ?? manifest?.mode ?? "sheets") as Mode;
    if (!MODES.includes(mode)) throw usage(`--mode is sheets or frames (got "${mode}")`);
    const art = (textFlag(call, "--art") ?? manifest?.art ?? "smooth") as ArtMode;
    if (art !== "smooth" && art !== "pixel") throw usage(`--art is smooth or pixel (got "${art}")`);
    const frameSize = frameSizeFlag(textFlag(call, "--frame-size")) ?? manifest?.frame_size ?? undefined;

    // The inputs and the names to pick them by.
    const inputs = manifest ? manifest.animations.map(a => path.resolve(base, a.input)) : call.args;
    const files = inputs.map(input => (fs.statSync(input, { throwIfNoEntry: false })?.isDirectory() ? path.basename(path.resolve(input)) : baseOf(input)));
    // Labels first: they name animations for the other flags too.
    const labelFlags = new Map<number, string>();
    for (const raw of call.lists.get("--label") ?? []) {
      const eq = raw.indexOf("=");
      if (eq < 0) throw usage(`--label takes anim=name, like --label 1=walk (got "${raw}")`);
      const label = raw.slice(eq + 1).trim();
      if (!label) throw usage(`--label ${raw}: the name is empty`);
      labelFlags.set(pickAnimation(raw.slice(0, eq), files.map((f, i) => [f, ...(manifest ? [manifest.animations[i].label] : [])]), "--label"), label);
    }
    const names = files.map((f, i) => [...new Set([f, labelFlags.get(i) ?? manifest?.animations[i].label ?? f])]);
    const gridFlags = perAnimation(call, "--grid", names, v => {
      const g = parseGrid(v);
      if (!g || g.cols < 1 || g.rows < 1) throw usage(`--grid takes columns x rows, like 6x4 (got "${v}")`);
      return g;
    });
    const animations = inputs.map((input, i) => loadAnimation(input, gridFlags.get(i) ?? manifest?.animations[i].grid, "--grid"));
    const warnings: string[] = [];
    if (manifest) {
      manifest.animations.forEach((a, i) => {
        if (a.sha256 && animations[i].sha256 && a.sha256 !== animations[i].sha256) warnings.push(`${shown(inputs[i])} changed since the manifest was written`);
      });
    }

    const sizes = perAnimation(call, "--size", names, parseNumber("--size", n => n > 0 && n <= 16, "a number above 0, up to 16"));
    const grounds = perAnimation(call, "--ground", names, parseNumber("--ground", Number.isInteger, "whole pixels, like -3"));
    const offsets = perAnimation(call, "--offset-x", names, parseNumber("--offset-x", Number.isInteger, "whole pixels, like 4"));
    const fpsFlags = perAnimation(call, "--fps", names, parseNumber("--fps", n => n > 0, "a number above 0"));
    const at = <T>(map: Map<number, T>, i: number, saved: T | undefined) => (map.has(i) ? map.get(i) : saved);

    const pack = buildPack(
      animations.map((a, i) => ({
        frames: a.frames,
        size: at(sizes, i, manifest?.animations[i].size),
        ground: at(grounds, i, manifest?.animations[i].ground),
        offsetX: at(offsets, i, manifest?.animations[i].offset_x)
      })),
      { art, frameSize: frameSize ? { w: frameSize.width, h: frameSize.height } : undefined }
    );
    const { frameWidth: fw, frameHeight: fh } = pack;
    for (const a of animations) {
      if (fw * a.grid.cols * fh * a.grid.rows > MAX_TOOLBOX_PIXELS) {
        throw usage(`A ${a.grid.cols}x${a.grid.rows} sheet of ${fw}x${fh} frames is over ${MAX_TOOLBOX_PIXELS / 1024 / 1024} megapixels`, "Use smaller --size values, or --mode frames.");
      }
    }

    const labels = uniquifyNames(names.map(n => n[n.length - 1]));
    const packName = ctx.globals.name ?? manifest?.name ?? "Animation Pack";
    const dir = freeName(ctx.outDir, folderName(packName));
    fs.mkdirSync(dir, { recursive: true });

    const results = animations.map((a, i) => {
      const packed = pack.animations[i];
      const fps = at(fpsFlags, i, manifest?.animations[i].fps) ?? a.grid.fps;
      const grid: Grid = { cols: a.grid.cols, rows: a.grid.rows, frames: a.grid.frames, fps };
      let files: string[];
      let engine: string[] = [];
      if (mode === "sheets") {
        const sheet = layoutSheet(packed.frames, grid.cols, grid.rows);
        const file = path.join(dir, `${labels[i]}.png`);
        writePng(file, sheet, a.src ? carriedChunks(a.src, grid) : []);
        engine = engineFiles(ctx, file, sheet, grid, {}, labels[i]);
        files = [file];
      } else {
        const folder = path.join(dir, labels[i]);
        files = packed.frames.map((f, k) => {
          const file = path.join(folder, `frame_${String(k).padStart(3, "0")}.png`);
          writePng(file, f, a.src ? carriedChunks(a.src) : []);
          return file;
        });
      }
      return { a, packed, fps, files, engine };
    });

    const manifestOut = path.join(dir, "pack.json");
    const saved: Manifest = {
      ludo: "toolbox sprite pack",
      version: MANIFEST_VERSION,
      name: packName,
      mode,
      art,
      frame_size: frameSize ?? null,
      animations: results.map(({ a, packed, fps }, i) => ({
        input: manifestPath(dir, a.input),
        kind: a.kind,
        ...(a.sha256 ? { sha256: a.sha256 } : {}),
        label: labels[i],
        grid: { cols: a.grid.cols, rows: a.grid.rows, frames: a.grid.frames },
        fps,
        size: packed.size,
        ground: packed.ground,
        offset_x: packed.offsetX
      }))
    };
    fs.writeFileSync(manifestOut, JSON.stringify(saved, null, 2) + "\n");

    const groundLine = Math.round(pack.groundLine * 100) / 100;
    const next = hint("Animate another move for the same character with Ludo, then add it to the pack", `ludo sprite animate --initial-image <a frame> --motion-prompt "<what it does>"`);
    if (ctx.jsonOut) {
      printJson(
        {
          pack: shown(dir),
          manifest: shown(manifestOut),
          mode,
          art,
          frame_width: fw,
          frame_height: fh,
          ground_line: groundLine,
          target_height: pack.targetHeight,
          animations: results.map(({ a, packed, fps, files, engine }, i) => ({
            input: shown(a.input),
            label: labels[i],
            frames: a.grid.frames,
            grid: { cols: a.grid.cols, rows: a.grid.rows },
            fps,
            scale: Math.round(packed.scale * 10000) / 10000,
            size: packed.size,
            ground: packed.ground,
            ground_auto: packed.groundAuto,
            offset_x: packed.offsetX,
            ...(mode === "sheets" ? { sheet: shown(files[0]) } : { dir: shown(path.dirname(files[0])) }),
            ...(engine.length ? { engine_files: engine.map(shown) } : {})
          })),
          ...(warnings.length ? { warnings } : {}),
          ...(ctx.globals.quiet ? {} : { hint: next })
        },
        false
      );
    } else {
      const out = (line: string) => process.stdout.write(line + "\n");
      out(`${animations.length} animations in ${fw}x${fh} frames (${art} art); the ground line is ${groundLine} px above the frame bottom`);
      const width = Math.max(...labels.map(l => l.length));
      results.forEach(({ a, packed, files, engine }, i) => {
        const where = mode === "sheets" ? shown(files[0]) : `${shown(path.dirname(files[0]))}${path.sep}`;
        out(`  ${labels[i].padEnd(width)}  ${String(a.grid.frames).padStart(3)} frames  scale ${packed.scale.toFixed(2)}  ground ${packed.ground}  -> ${where}${engine.length ? ` + ${engine.map(shown).join(", ")}` : ""}`);
      });
      out(`Saved ${shown(dir)}${path.sep}; re-run it with: ludo toolbox sprite pack --manifest ${shown(manifestOut)}`);
      for (const w of warnings) process.stderr.write(`Note: ${w}\n`);
      if (!ctx.globals.quiet) process.stderr.write(`Next: ${next.text}: ${next.command}\n`);
    }
    return EXIT.OK;
  }
});
