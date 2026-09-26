import fs from "node:fs";
import path from "node:path";
import { CliError, EXIT } from "./errors.js";
import { containedPath, writeJsonFile, type Project } from "./project.js";

// `ludo-assets.json`: one entry per file a generation saved, next to the
// project's .ludo.json (or in the output folder outside a project). It records
// how each asset was made, so `ludo assets redo <file>` can make it again (with
// changes), agents can see what already exists before generating more, and a
// variation set stays recognisable as one request.
//
// Paths are relative to the log, so the project can move.

export const LOG_NAME = "ludo-assets.json";

export interface AssetEntry {
  file: string;
  command: string; // "sprite animate"
  operation_id: string;
  body: Record<string, unknown>;
  job_id?: string;
  credits?: number;
  created_at: string;
  variation_set?: string;
  variation?: number;
  // false when the request is unknown (saved by `ludo jobs wait`).
  redo?: boolean;
  discarded?: boolean;
}

export function logFile(project: Project | undefined, outDir: string): string {
  return path.join(project ? project.root : outDir, LOG_NAME);
}

export function readAssets(file: string): AssetEntry[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed.assets) ? parsed.assets : [];
  } catch {
    throw new CliError(`${file} is not valid JSON; fix or remove it`, EXIT.USAGE);
  }
}

const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 15_000;

function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Parallel ludo processes (a batch in one terminal, an agent in another) all
// update the log: each read-modify-write holds <log>.lock, created with O_EXCL.
// A lock older than 10s belongs to a process that died, and is taken over.
export function withLock<T>(file: string, fn: () => T): T {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const started = Date.now();
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lock, "wx"));
      break;
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;
      let age = 0;
      try {
        age = Date.now() - fs.statSync(lock).mtimeMs;
      } catch {
        continue; // released between the two calls
      }
      if (age > LOCK_STALE_MS || Date.now() - started > LOCK_WAIT_MS) {
        fs.rmSync(lock, { force: true });
        continue;
      }
      sleepSync(20 + Math.random() * 30);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

// Adds entries; one already there for the same job and file is replaced.
export function appendAssets(file: string, entries: AssetEntry[]) {
  if (!entries.length) return;
  const key = (e: AssetEntry) => `${e.job_id ?? ""}\u0000${e.file}`;
  withLock(file, () => {
    const incoming = new Set(entries.map(key));
    writeJsonFile(file, { assets: [...readAssets(file).filter(e => !incoming.has(key(e))), ...entries] });
  });
}

export function updateAssets(file: string, fn: (entries: AssetEntry[]) => AssetEntry[]) {
  withLock(file, () => writeJsonFile(file, { assets: fn(readAssets(file)) }));
}

// Local file paths in a request body, rewritten relative to the log (and back).
// `files` are the body fields that take files.
export function relativizeBody(body: Record<string, unknown>, fileFields: string[], logDir: string): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body };
  const one = (v: unknown) => {
    if (typeof v !== "string") return v;
    const p = v.startsWith("@") ? v.slice(1) : v;
    if (/^(https?:|data:)/i.test(p) || !fs.existsSync(p)) return v;
    return path.relative(logDir, path.resolve(p)) || ".";
  };
  for (const f of fileFields) {
    if (Array.isArray(out[f])) out[f] = (out[f] as unknown[]).map(one);
    else if (out[f] !== undefined) out[f] = one(out[f]);
  }
  return out;
}

// The recorded body, with its local paths made absolute again. The log is a
// file in the repository, so its paths must stay inside `root`.
export function absolutizeBody(body: Record<string, unknown>, fileFields: string[], logDir: string, root: string): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body };
  const one = (field: string) => (v: unknown) => (typeof v === "string" ? containedPath(root, logDir, v, `${field} in the asset log`) : v);
  for (const f of fileFields) {
    if (Array.isArray(out[f])) out[f] = (out[f] as unknown[]).map(one(f));
    else if (out[f] !== undefined) out[f] = one(f)(out[f]);
  }
  return out;
}

export function findAsset(entries: AssetEntry[], file: string, logDir: string): AssetEntry | undefined {
  const rel = path.relative(logDir, path.resolve(file));
  // The newest entry wins when a file was overwritten.
  return [...entries].reverse().find(e => e.file === rel || e.file === file);
}
