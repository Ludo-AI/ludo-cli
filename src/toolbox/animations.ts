import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CliError, EXIT } from "../errors.js";
import type { Image } from "../tty/png.js";
import type { Grid } from "../tty/preview.js";
import { parseGrid } from "../tty/preview.js";
import { baseOf, loadImageFile, shown, type Loaded } from "./io.js";
import { crop, joinFrames, sliceSheet } from "./sheet.js";
import { frameFiles, resolveGrid } from "./sprite.js";
import type { ToolCall } from "./registry.js";

// What `sprite pack` and `sprite sequence` share: their inputs (sheets or
// folders of frames, one animation each), picking an animation in a flag by
// name or position, and the JSON manifest that re-runs them.

export interface Animation {
  input: string; // as given (a sheet, or a folder of frames)
  kind: "sheet" | "frames";
  name: string; // the input's file or folder name, to pick it in flags
  frames: Image[];
  grid: Grid; // the layout its sheet keeps
  src?: Loaded; // the sheet, for its colour chunks
  sha256?: string;
}

/** What a manifest keeps of each input. */
export interface SavedAnimation {
  input: string; // relative to the manifest
  kind: "sheet" | "frames";
  sha256?: string;
  label: string;
  grid: { cols: number; rows: number; frames: number };
  fps: number;
}

export const usage = (message: string, hintText?: string) => new CliError(message, EXIT.USAGE, hintText);
const sha256 = (file: string) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

// The web's folder name: lower case, anything but letters and digits a dash.
export const folderName = (name: string, fallback: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || fallback;

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
export function perAnimation<T>(call: ToolCall, flag: string, names: string[][], parse: (v: string) => T): Map<number, T> {
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

export const parseNumber = (flag: string, check: (n: number) => boolean, what: string) => (v: string) => {
  const n = Number(v);
  if (v.trim() === "" || !Number.isFinite(n) || !check(n)) throw usage(`${flag} takes ${what} (got "${v}")`);
  return n;
};

export function frameSizeFlag(raw: string | undefined, max: number): { width?: number; height?: number } | undefined {
  if (raw === undefined) return undefined;
  const m = /^(\d*)x(\d*)$/i.exec(raw.trim());
  const [w, h] = m ? [m[1] ? Number(m[1]) : undefined, m[2] ? Number(m[2]) : undefined] : [];
  if (!m || (w === undefined && h === undefined) || w === 0 || h === 0) throw usage(`--frame-size takes width x height, like 256x256, 256x or x256 (got "${raw}")`);
  if ((w ?? 0) > max || (h ?? 0) > max) throw usage(`--frame-size goes up to ${max}`);
  return { width: w, height: h };
}

/**
 * The inputs, by name for the other flags: --label first (labels name
 * animations too), then --grid, then each input loaded once.
 */
export function readInputs(call: ToolCall, inputs: string[], saved?: SavedAnimation[]): { animations: Animation[]; names: string[][]; warnings: string[] } {
  const files = inputs.map(input => (fs.statSync(input, { throwIfNoEntry: false })?.isDirectory() ? path.basename(path.resolve(input)) : baseOf(input)));
  const labelFlags = new Map<number, string>();
  for (const raw of call.lists.get("--label") ?? []) {
    const eq = raw.indexOf("=");
    if (eq < 0) throw usage(`--label takes anim=name, like --label 1=walk (got "${raw}")`);
    const label = raw.slice(eq + 1).trim();
    if (!label) throw usage(`--label ${raw}: the name is empty`);
    labelFlags.set(pickAnimation(raw.slice(0, eq), files.map((f, i) => [f, ...(saved ? [saved[i].label] : [])]), "--label"), label);
  }
  const names = files.map((f, i) => [...new Set([f, labelFlags.get(i) ?? saved?.[i].label ?? f])]);
  const gridFlags = perAnimation(call, "--grid", names, v => {
    const g = parseGrid(v);
    if (!g || g.cols < 1 || g.rows < 1) throw usage(`--grid takes columns x rows, like 6x4 (got "${v}")`);
    return g;
  });
  // An input given twice with the same grid is read once.
  const cache = new Map<string, Animation>();
  const animations = inputs.map((input, i) => {
    const grid = gridFlags.get(i) ?? saved?.[i].grid;
    const key = JSON.stringify([path.resolve(input), grid ?? null]);
    const a = cache.get(key) ?? loadAnimation(input, grid, "--grid");
    cache.set(key, a);
    return { ...a, input };
  });
  const warnings: string[] = [];
  saved?.forEach((a, i) => {
    if (a.sha256 && animations[i].sha256 && a.sha256 !== animations[i].sha256) warnings.push(`${shown(inputs[i])} changed since the manifest was written`);
  });
  return { animations, names, warnings };
}

// Inputs relative to the manifest, so the output and its sources move
// together; absolute when they share no folder but the root (or another drive).
export function manifestPath(dir: string, input: string): string {
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

/** A manifest written by `ludo toolbox <tool>`, checked enough to re-run. */
export function readManifest<M extends { ludo: string; version: number; animations: SavedAnimation[] }>(file: string, tool: string, version: number, what: string): M {
  let m: M;
  try {
    m = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new CliError(code === "ENOENT" ? `File not found: ${file}` : `Cannot read ${file}: ${(err as Error).message}`, code === "ENOENT" ? EXIT.USAGE : EXIT.BAD_INPUT);
  }
  const ok =
    m &&
    m.ludo === `toolbox ${tool}` &&
    Array.isArray(m.animations) &&
    m.animations.length > 0 &&
    m.animations.every(a => a && typeof a.input === "string" && a.grid && Number.isInteger(a.grid.cols) && Number.isInteger(a.grid.rows) && Number.isInteger(a.grid.frames));
  if (!ok) throw new CliError(`${file} is not a ${what} manifest written by ludo toolbox ${tool}`, EXIT.BAD_INPUT);
  if (m.version > version) throw new CliError(`${file} was written by a newer ludo (manifest version ${m.version})`, EXIT.BAD_INPUT, "Update the CLI: npm i -g @ludoai/cli");
  return m;
}
