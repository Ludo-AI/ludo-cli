import fs from "node:fs";
import path from "node:path";
import { CliError, EXIT } from "./errors.js";
import { writeJsonFile, type Project } from "./project.js";

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

export function appendAssets(file: string, entries: AssetEntry[]) {
  if (!entries.length) return;
  writeJsonFile(file, { assets: [...readAssets(file), ...entries] });
}

export function writeAssets(file: string, entries: AssetEntry[]) {
  writeJsonFile(file, { assets: entries });
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

export function absolutizeBody(body: Record<string, unknown>, fileFields: string[], logDir: string): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body };
  const one = (v: unknown) => {
    if (typeof v !== "string" || /^(https?:|data:|@)/i.test(v) || path.isAbsolute(v)) return v;
    const abs = path.resolve(logDir, v);
    return fs.existsSync(abs) ? abs : v;
  };
  for (const f of fileFields) {
    if (Array.isArray(out[f])) out[f] = (out[f] as unknown[]).map(one);
    else if (out[f] !== undefined) out[f] = one(out[f]);
  }
  return out;
}

export function findAsset(entries: AssetEntry[], file: string, logDir: string): AssetEntry | undefined {
  const rel = path.relative(logDir, path.resolve(file));
  // The newest entry wins when a file was overwritten.
  return [...entries].reverse().find(e => e.file === rel || e.file === file);
}
