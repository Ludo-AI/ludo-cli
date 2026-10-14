import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliError, EXIT } from "./errors.js";
import { isInlineFile } from "./inline.js";

// A project's `.ludo.json`, found by walking up from the current directory
// (never above the home directory). Every agent session and teammate in the
// project then generates with the same defaults, and the project keeps its
// own spending budget and asset log:
//
//   {
//     "out": "assets/generated",            where files are saved
//     "engine": "godot",                    as --engine
//     "max_credits": 200,                   session budget (see budget.ts)
//     "style_image": "art/style.png",       for operations with a style_image field
//     "defaults": {                         per command ("group command" or API id)
//       "image create": { "image_type": "sprite" },
//       "animateSprite": { "model": "forge" }
//     }
//   }
//
// Paths are relative to the file. Flags always win over the file.

export const CONFIG_NAME = ".ludo.json";
export const STATE_DIR = ".ludo";

export interface ProjectConfig {
  out?: string;
  engine?: "godot";
  max_credits?: number;
  style_image?: string;
  defaults?: Record<string, Record<string, unknown>>;
}

export interface Project {
  root: string;
  file: string;
  config: ProjectConfig;
}

const FIELDS = ["out", "engine", "max_credits", "style_image", "defaults"];

export function findProjectFile(start = process.cwd()): string | undefined {
  const home = path.resolve(os.homedir());
  let dir = path.resolve(start);
  for (;;) {
    const file = path.join(dir, CONFIG_NAME);
    if (fs.existsSync(file)) return file;
    const parent = path.dirname(dir);
    if (dir === home || parent === dir) return undefined;
    dir = parent;
  }
}

export function validateConfig(raw: unknown, file: string): ProjectConfig {
  const bad = (message: string) => new CliError(`${file}: ${message}`, EXIT.USAGE, `Fields: ${FIELDS.join(", ")}. See \`ludo init --help\`.`);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw bad("must hold a JSON object");
  const c = raw as Record<string, unknown>;
  for (const key of Object.keys(c)) if (!FIELDS.includes(key)) throw bad(`unknown field "${key}"`);
  if (c.out !== undefined && (typeof c.out !== "string" || !c.out.trim())) throw bad(`"out" must be a folder path`);
  if (c.engine !== undefined && c.engine !== "godot") throw bad(`"engine" supports: godot`);
  if (c.max_credits !== undefined && (typeof c.max_credits !== "number" || !(c.max_credits >= 0))) throw bad(`"max_credits" must be a number of credits`);
  if (c.style_image !== undefined && (typeof c.style_image !== "string" || !c.style_image.trim())) throw bad(`"style_image" must be a file path or URL`);
  if (c.defaults !== undefined) {
    if (!c.defaults || typeof c.defaults !== "object" || Array.isArray(c.defaults)) throw bad(`"defaults" must map commands to fields`);
    for (const [cmd, fields] of Object.entries(c.defaults)) {
      if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw bad(`defaults["${cmd}"] must be an object of API fields`);
    }
  }
  return c as ProjectConfig;
}

export function loadProject(start?: string): Project | undefined {
  if (process.env.LUDO_PROJECT === "0") return undefined;
  const file = findProjectFile(start);
  if (!file) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new CliError(`${file} is not valid JSON: ${(err as Error).message}`, EXIT.USAGE);
  }
  return { root: path.dirname(file), file, config: validateConfig(raw, file) };
}

// The real location of a path, following symlinks as far as it exists (a
// folder about to be created has none yet).
function realish(p: string): string {
  let dir = p;
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(dir), ...rest.reverse());
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return p;
      rest.push(path.basename(dir));
      dir = parent;
    }
  }
}

export const isUrl = (value: string) => /^(https?:|data:)/i.test(value);

// A path that came from a file in the repository (.ludo.json, the asset log),
// made absolute against `base` and required to stay inside `root`: a cloned
// repo must not be able to make ludo upload ~/.ssh/id_rsa or write files
// elsewhere, through ../ or a symlink. Paths people type as flags are theirs
// and are not checked. URLs and inline base64 file content pass through.
export function containedPath(root: string, base: string, value: string, label: string): string {
  if (isUrl(value) || isInlineFile(value)) return value;
  const abs = path.resolve(base, value.startsWith("@") ? value.slice(1) : value);
  const rel = path.relative(realish(root), realish(abs));
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new CliError(`${label}: ${value} is outside the project (${root})`, EXIT.USAGE, "Paths from project files must stay inside the project; pass the file as a flag instead.");
  }
  return value.startsWith("@") ? `@${abs}` : abs;
}

// A path in the config, made absolute and kept inside the project.
export function projectPath(project: Project, value: string, label: string): string {
  return containedPath(project.root, project.root, value, `${label} in ${project.file}`);
}

// Defaults for a command, by "group command" and by API id (the id wins).
export function defaultsFor(project: Project | undefined, group: string, name: string, operationId: string): Record<string, unknown> {
  const d = project?.config.defaults || {};
  return { ...(d[`${group} ${name}`] || {}), ...(d[operationId] || {}) };
}

// Where per-project state (the spend tally) lives, created on demand.
export function stateDir(project: Project | undefined, fallback: string): string {
  const dir = project ? path.join(project.root, STATE_DIR) : fallback;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Writes a file atomically enough for concurrent readers: temp file, rename.
export function writeJsonFile(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(tmp, file);
}
