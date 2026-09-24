import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { cacheDir, PACKAGE_ROOT } from "./config.js";

// The CLI builds its commands from the API's public OpenAPI spec, fetched from
// the server at run time. New models, enum values, defaults and even whole
// operations therefore reach the CLI the moment the API deploys, with no CLI
// release. The copy embedded in the package (spec/openapi.json) is the
// fallback for a first run offline or a server that cannot be reached.
//
// Refreshing is cheap: at most once per REFRESH_MS, a conditional GET that the
// server answers with 304 when nothing changed.

const REFRESH_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 4000;

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

export async function loadSpec(apiUrl: string, opts: { forceRefresh?: boolean } = {}): Promise<LoadedSpec> {
  // Pinned to a local file: development, tests, or an air-gapped setup.
  if (process.env.LUDO_SPEC) {
    return { spec: readJson(process.env.LUDO_SPEC), source: "file", location: process.env.LUDO_SPEC };
  }

  const paths = cachePaths(apiUrl);
  let cached: Spec | undefined;
  let meta: { etag?: string; fetched_at?: number } = {};
  try {
    cached = readJson(paths.spec);
    meta = readJson(paths.meta);
  } catch {
    cached = undefined;
  }

  const fresh = cached && meta.fetched_at && Date.now() - meta.fetched_at < REFRESH_MS;
  if (cached && fresh && !opts.forceRefresh) {
    return { spec: cached, source: "cache", location: paths.spec };
  }

  if (process.env.LUDO_OFFLINE !== "1") {
    try {
      const headers: Record<string, string> = {};
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
          fs.mkdirSync(paths.dir, { recursive: true });
          fs.writeFileSync(paths.spec, text);
          writeMeta(paths, { etag: res.headers.get("etag") || undefined, fetched_at: Date.now() });
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

function writeMeta(paths: { dir: string; meta: string }, meta: object) {
  try {
    fs.mkdirSync(paths.dir, { recursive: true });
    fs.writeFileSync(paths.meta, JSON.stringify(meta));
  } catch {
    // A read-only cache dir only costs a refetch next time.
  }
}
