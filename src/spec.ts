import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cacheDir, PACKAGE_ROOT } from "./config.js";

// The CLI builds its commands from the API's public OpenAPI spec, fetched from
// the server at run time. New models, enum values, defaults and even whole
// operations therefore reach the CLI the moment the API deploys, with no CLI
// release. The copy embedded in the package (spec/openapi.json) is the
// fallback for a first run offline or a server that cannot be reached.
//
// Refreshing never holds a command up once a spec is cached: a cached spec
// older than REFRESH_MS is still used, and a detached `ludo spec refresh`
// fetches the new one for the next run (a command the old spec does not know
// is retried against a fresh one, see cli.ts). The refresh is a conditional
// GET that the server answers with 304 when nothing changed. One that does not
// get through is tried again after RETRY_MS, not on every run.

const REFRESH_MS = 60 * 60 * 1000;
const RETRY_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 4000;

interface Meta {
  etag?: string;
  fetched_at?: number;
  // When a background refresh was last started, successful or not.
  checked_at?: number;
}

export type Spec = any;

export interface LoadedSpec {
  spec: Spec;
  source: "file" | "cache" | "server" | "embedded";
  location: string;
}

export function embeddedSpecPath(): string {
  return path.join(PACKAGE_ROOT, "spec", "openapi.json");
}

export function specUrl(apiUrl: string): string {
  return `${apiUrl}/api-documentation/openapi.json`;
}

function cachePaths(apiUrl: string) {
  const key = crypto.createHash("sha1").update(apiUrl).digest("hex").slice(0, 12);
  const dir = cacheDir();
  return {
    dir,
    spec: path.join(dir, `openapi-${key}.json`),
    meta: path.join(dir, `openapi-${key}.meta.json`)
  };
}

function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function looksLikeSpec(spec: any): boolean {
  return !!spec && typeof spec === "object" && !!spec.paths && typeof spec.paths === "object";
}

export async function loadSpec(apiUrl: string, opts: { forceRefresh?: boolean; noWait?: boolean } = {}): Promise<LoadedSpec> {
  // Pinned to a local file: development, tests, or an air-gapped setup.
  if (process.env.LUDO_SPEC) {
    return { spec: readJson(process.env.LUDO_SPEC), source: "file", location: process.env.LUDO_SPEC };
  }

  const paths = cachePaths(apiUrl);
  let cached: Spec | undefined;
  let meta: Meta = {};
  try {
    cached = readJson(paths.spec);
    meta = readJson(paths.meta);
  } catch {
    cached = undefined;
  }

  if (!opts.forceRefresh) {
    if (cached) {
      if (refreshDue(meta)) refreshInBackground(apiUrl, paths, meta);
      return { spec: cached, source: "cache", location: paths.spec };
    }
    // Help screens never wait on the network, even on a first run.
    if (opts.noWait) {
      refreshInBackground(apiUrl, paths, meta);
      return { spec: readJson(embeddedSpecPath()), source: "embedded", location: embeddedSpecPath() };
    }
  }

  if (process.env.LUDO_OFFLINE !== "1") {
    try {
      // fetch() adds "Cache-Control: no-cache" to any request carrying
      // If-None-Match unless one is set, and Express never answers 304 to that.
      const headers: Record<string, string> = { "Cache-Control": "max-age=0" };
      if (cached && meta.etag) headers["If-None-Match"] = meta.etag;
      const res = await fetch(specUrl(apiUrl), {
        headers,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      });
      if (res.status === 304 && cached) {
        writeMeta(paths, { etag: meta.etag, fetched_at: Date.now() });
        return { spec: cached, source: "cache", location: paths.spec };
      }
      if (res.ok) {
        const text = await res.text();
        const spec = JSON.parse(text);
        // A broken deploy must not take every CLI down with it.
        if (looksLikeSpec(spec)) {
          // A cache that can't be written (a sandboxed agent, a read-only
          // home) must not cost us the spec just fetched: the embedded copy
          // it would fall back to can offer models the API has since retired.
          try {
            fs.mkdirSync(paths.dir, { recursive: true });
            writeAtomic(paths.spec, text);
            writeMeta(paths, { etag: res.headers.get("etag") || undefined, fetched_at: Date.now() });
          } catch {
            // Fetched again on the next run.
          }
          return { spec, source: "server", location: specUrl(apiUrl) };
        }
      }
    } catch {
      // Offline or unreachable: fall through to what we have.
    }
  }

  if (cached) return { spec: cached, source: "cache", location: paths.spec };
  return { spec: readJson(embeddedSpecPath()), source: "embedded", location: embeddedSpecPath() };
}

function refreshDue(meta: Meta): boolean {
  const now = Date.now();
  return now - (meta.fetched_at || 0) >= REFRESH_MS && now - (meta.checked_at || 0) >= RETRY_MS;
}

// Starts `ludo spec refresh` detached, so this command neither waits for it
// nor keeps the terminal busy after it ends. checked_at is written first so
// the commands that follow do not start one each.
function refreshInBackground(apiUrl: string, paths: { dir: string; meta: string }, meta: Meta) {
  if (process.env.LUDO_OFFLINE === "1") return;
  writeMeta(paths, { ...meta, checked_at: Date.now() });
  try {
    const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
    const env: NodeJS.ProcessEnv = { ...process.env, LUDO_TELEMETRY: "0" };
    delete env.LUDO_SPEC;
    const child = spawn(process.execPath, [cli, "spec", "refresh", "--api-url", apiUrl], {
      stdio: "ignore",
      detached: true,
      windowsHide: true,
      env
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    // The next run tries again after RETRY_MS.
  }
}

// Another ludo may be reading the file while this one writes it.
function writeAtomic(file: string, text: string) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function writeMeta(paths: { dir: string; meta: string }, meta: Meta) {
  try {
    fs.mkdirSync(paths.dir, { recursive: true });
    writeAtomic(paths.meta, JSON.stringify(meta));
  } catch {
    // A read-only cache dir only costs a refetch next time.
  }
}
