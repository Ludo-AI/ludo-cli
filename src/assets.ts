import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CliError, EXIT } from "./errors.js";
import { extensionFor, isInlineFile } from "./inline.js";
import { containedPath, writeJsonFile, type Project } from "./project.js";

// `ludo-assets.json`: one entry per file a generation saved, next to the
// project's .ludo.json (or in the output folder outside a project). It records
// how each asset was made, so `ludo assets redo <file>` can make it again (with
// changes), agents can see what already exists before generating more, and a
// variation set stays recognisable as one request.
//
// Paths are relative to the log, so the project can move.
//
// The log is an index, not a store: file content a request carried inline as
// base64 is kept once in ludo-inputs/ (git-ignored), named by its hash, and the
// entry holds that path. Copying it into every entry (one per saved file, so once per
// frame) grew one log past the longest string Node can write.

export const LOG_NAME = "ludo-assets.json";
export const INPUTS_DIR = "ludo-inputs";

export interface AssetEntry {
  file: string;
  command: string; // "sprite animate"
  operation_id: string;
  body: Record<string, unknown>;
  job_id?: string;
  credits?: number;
  created_at: string;
  // The model that made the file and the prompt it received (the rewritten
  // one with augment_prompt on), when the result names them: a log of
  // generations can then tell a model change from a prompt change.
  model?: string;
  prompt?: string;
  // The generation's result URLs by field (spritesheet_url, video_url,
  // audio_url...), so a later step can name the real one. They expire 7 days
  // after created_at, as every API result does.
  result_urls?: Record<string, string>;
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

// Writes inline file content to ludo-inputs/<sha256><ext> (once) and returns
// its path relative to the log; undefined for anything that isn't file content.
// Bare base64 counts only when its first bytes name a file type.
function storeInline(value: string, logDir: string, memo: Map<string, string>): string | undefined {
  const known = memo.get(value);
  if (known) return known;
  if (!isInlineFile(value)) return undefined;
  const m = /^data:([^;,]+)[^,]*,/.exec(value);
  const buffer = Buffer.from(m ? value.slice(m[0].length) : value, "base64");
  const ext = extensionFor(buffer, m?.[1]);
  const rel = path.join(INPUTS_DIR, crypto.createHash("sha256").update(buffer).digest("hex") + ext);
  const abs = path.join(logDir, rel);
  if (!fs.existsSync(abs)) {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    // Copies of what was sent, not project files: the folder keeps itself out of git.
    const ignore = path.join(path.dirname(abs), ".gitignore");
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "*\n");
    const tmp = `${abs}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, buffer);
    fs.renameSync(tmp, abs);
  }
  memo.set(value, rel);
  return rel;
}

// Every body value (or array item) that is inline file content becomes a path.
// Runs over the whole log on each write, so a log from an older CLI shrinks the
// first time it is written.
function storeInlineBodies(entries: AssetEntry[], logDir: string): AssetEntry[] {
  const memo = new Map<string, string>();
  const one = (v: unknown) => (typeof v === "string" ? (storeInline(v, logDir, memo) ?? v) : v);
  return entries.map(e => {
    if (!e.body) return e;
    let changed = false;
    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(e.body)) {
      body[k] = Array.isArray(v) ? v.map(one) : one(v);
      if (Array.isArray(v) ? (body[k] as unknown[]).some((x, i) => x !== v[i]) : body[k] !== v) changed = true;
    }
    return changed ? { ...e, body } : e;
  });
}

function writeAssets(file: string, entries: AssetEntry[]) {
  writeJsonFile(file, { assets: storeInlineBodies(entries, path.dirname(file)) });
}

// Adds entries; one already there for the same job and file is replaced.
export function appendAssets(file: string, entries: AssetEntry[]) {
  if (!entries.length) return;
  const key = (e: AssetEntry) => `${e.job_id ?? ""}\u0000${e.file}`;
  withLock(file, () => {
    const incoming = new Set(entries.map(key));
    writeAssets(file, [...readAssets(file).filter(e => !incoming.has(key(e))), ...entries]);
  });
}

export function updateAssets(file: string, fn: (entries: AssetEntry[]) => AssetEntry[]) {
  withLock(file, () => writeAssets(file, fn(readAssets(file))));
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
