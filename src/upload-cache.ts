import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { cacheDir } from "./config.js";

// Local files uploaded through createUpload, remembered by content, so an
// input used by many generations (a batch animating one sprite, a retry, a
// re-run) is uploaded once instead of every time. Each upload counts against
// createUpload's rate limit, and a batch that re-uploaded the same image for
// every job ran into the daily cap before any generation was submitted.
//
// Uploads expire after 7 days, but the API copies an input when the job is
// submitted, so a URL only has to be alive at submit time: entries are reused
// for 6 days, and only after a HEAD request shows the file is still there
// with the same size. HEAD goes to storage, not the API, so it costs no rate
// limit. LUDO_UPLOAD_CACHE=0 turns reuse off.

const MAX_AGE_MS = 6 * 24 * 60 * 60 * 1000;
const HEAD_TIMEOUT_MS = 10 * 1000;

interface Entry {
  url: string;
  size: number;
  at: number; // epoch ms of the upload
}

type Store = Record<string, Entry>;

// Concurrent uploads of the same content in this process share one request.
const inFlight = new Map<string, Promise<string>>();

function storeFile(): string {
  return path.join(cacheDir(), "uploads.json");
}

function readStore(): Store {
  try {
    const parsed = JSON.parse(fs.readFileSync(storeFile(), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

// Read-modify-write against the file as it is now (another `ludo` may have
// added entries), drop expired ones, and replace the file atomically. A
// cache that cannot be written only costs a future upload.
function updateStore(change: (store: Store) => void): void {
  try {
    const store = readStore();
    change(store);
    const now = Date.now();
    for (const [key, entry] of Object.entries(store)) {
      if (!entry || now - entry.at > MAX_AGE_MS) delete store[key];
    }
    fs.mkdirSync(cacheDir(), { recursive: true, mode: 0o700 });
    const tmp = `${storeFile()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store), { mode: 0o600 });
    fs.renameSync(tmp, storeFile());
  } catch {
    // best effort
  }
}

export function uploadCacheEnabled(): boolean {
  return process.env.LUDO_UPLOAD_CACHE !== "0";
}

// The API decides where uploads live, so the same bytes sent to another API
// (dev vs production) are another upload.
export function uploadKey(apiUrl: string, mime: string, bytes: Buffer): string {
  const sha = crypto.createHash("sha256").update(bytes).digest("hex");
  return `${apiUrl}|${mime}|${sha}`;
}

async function stillThere(entry: Entry): Promise<boolean> {
  try {
    const res = await fetch(entry.url, { method: "HEAD", signal: AbortSignal.timeout(HEAD_TIMEOUT_MS) });
    if (!res.ok) return false;
    const length = res.headers.get("content-length");
    return length === null || Number(length) === entry.size;
  } catch {
    return false;
  }
}

/**
 * The URL of an earlier upload of the same content, when one is fresh and
 * still in storage; otherwise runs `upload` and remembers its URL.
 * `reuse: false` always uploads (and still remembers the result).
 */
export async function reuseOrUpload(
  key: string,
  size: number,
  upload: () => Promise<string>,
  opts: { reuse?: boolean; onReuse?: (ageMs: number) => void } = {}
): Promise<string> {
  const reuse = opts.reuse !== false && uploadCacheEnabled();
  if (reuse) {
    const pending = inFlight.get(key);
    if (pending) return pending;
    const entry = readStore()[key];
    if (entry && entry.size === size && Date.now() - entry.at <= MAX_AGE_MS && (await stillThere(entry))) {
      opts.onReuse?.(Date.now() - entry.at);
      return entry.url;
    }
  }
  const run = upload().then(url => {
    if (uploadCacheEnabled()) {
      updateStore(store => {
        store[key] = { url, size, at: Date.now() };
      });
    }
    return url;
  });
  if (reuse) {
    inFlight.set(key, run);
    run.then(
      () => inFlight.delete(key),
      () => inFlight.delete(key)
    );
  }
  return run;
}
