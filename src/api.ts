import fs from "node:fs";
import path from "node:path";
import { VERSION } from "./config.js";
import { CliError, EXIT, exitCodeForStatus } from "./errors.js";
import { observeHeaders, upgradeRequired } from "./notices.js";
import { reuseOrUpload, uploadKey } from "./upload-cache.js";

export interface ApiResponse {
  status: number;
  body: any;
}

export class Api {
  constructor(private apiUrl: string, private apiKey: string | undefined) {}

  get baseUrl(): string {
    return this.apiUrl;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": `ludo-cli/${VERSION}`,
      // Marks every generation as made through the CLI (job origin "cli").
      "x-ludo-tool": "cli",
      "x-ludo-cli-version": VERSION,
      ...extra
    };
    if (this.apiKey) headers.Authorization = `ApiKey ${this.apiKey}`;
    return headers;
  }

  requireKey() {
    if (!this.apiKey) {
      throw new CliError(
        "No API key. Run `ludo login`, set LUDO_API_KEY, or pass --api-key.",
        EXIT.AUTH,
        "`ludo login` logs you in with your browser, and can create an account. Generating needs a Pro or Studio plan: `ludo pricing` compares them."
      );
    }
  }

  // GETs, and requests marked retry (safe to repeat), are tried once more
  // after a network error or a 502/503/504 from the load balancer: those are
  // usually a dropped keep-alive connection, gone on the second try. Never a
  // generation submit, which could run (and charge) twice.
  async request(method: string, apiPath: string, opts: RequestOpts = {}): Promise<ApiResponse> {
    const retryable = method === "GET" || !!opts.retry;
    try {
      const res = await this.requestOnce(method, apiPath, opts);
      if (!retryable || !RETRY_STATUSES.has(res.status)) return res;
    } catch (err) {
      if (!retryable || !(err instanceof CliError) || !err.network) throw err;
    }
    await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
    return this.requestOnce(method, apiPath, opts);
  }

  private async requestOnce(method: string, apiPath: string, opts: RequestOpts): Promise<ApiResponse> {
    const url = new URL(`${this.apiUrl}/api${apiPath}`);
    for (const [k, v] of Object.entries(opts.query || {})) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) v.forEach(item => url.searchParams.append(k, String(item)));
      else url.searchParams.set(k, String(v));
    }
    const unreachable = (err: any) => {
      const e = new CliError(`Could not reach ${this.apiUrl}: ${err?.cause?.code || err?.message || err}`, EXIT.ERROR);
      e.network = true;
      return e;
    };
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: this.headers(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(opts.timeoutMs || 120_000)
      });
    } catch (err: any) {
      throw unreachable(err);
    }
    observeHeaders(res.headers);
    // The timeout still runs while the body streams in, so a stalled body
    // fails here too, not only in fetch() (LUDO-CLI-6).
    let text: string;
    try {
      text = await res.text();
    } catch (err: any) {
      throw unreachable(err);
    }
    let body: any = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // Non-JSON error pages are reported as text.
    }
    // Below the API's minimum CLI version every request answers 426.
    if (res.status === 426) throw upgradeRequired(body);
    return { status: res.status, body };
  }

  // A request that must succeed: any non-2xx becomes a CliError with the
  // server's message and an exit code for its class.
  async call(method: string, apiPath: string, opts: RequestOpts = {}): Promise<ApiResponse> {
    const res = await this.request(method, apiPath, opts);
    if (res.status >= 200 && res.status < 300) return res;
    throw apiError(res);
  }
}

type RequestOpts = { query?: Record<string, unknown>; body?: unknown; timeoutMs?: number; retry?: boolean };

const RETRY_STATUSES = new Set([502, 503, 504]);
// LUDO_RETRY_DELAY_MS exists for the tests.
const RETRY_DELAY_MS = process.env.LUDO_RETRY_DELAY_MS ? Number(process.env.LUDO_RETRY_DELAY_MS) : 1000;

export function apiError(res: ApiResponse): CliError {
  const b = res.body;
  const message = (b && typeof b === "object" && (b.message || b.error)) || (typeof b === "string" && b.slice(0, 300)) || `HTTP ${res.status}`;
  let hint: string | undefined;
  if (res.status === 401 || res.status === 403) hint = "Your API key was rejected. Log in again with `ludo login`.";
  if (res.status === 402) {
    hint = /API access/i.test(String(message))
      ? "Your plan does not include API access (Pro and Studio do): `ludo pricing` compares the plans, `ludo billing` changes plan."
      : "Not enough credits. Buy credits or set up auto top-up with `ludo billing`; `ludo account` shows your balance.";
  }
  if (res.status === 429) {
    if (b?.code === "PENDING_JOBS_LIMIT") hint = "Too many jobs queued at once; wait for some to finish (`ludo jobs list`).";
    else if (typeof b?.reset_at === "string" && !Number.isNaN(Date.parse(b.reset_at))) {
      // The server names the limit and when it lifts: a daily cap is hours
      // away, and retrying before then only fails again.
      hint = `Rate limited until ${new Date(b.reset_at).toLocaleString()}; retrying earlier fails again.`;
    } else hint = "Rate limited; slow down and retry shortly.";
  }
  return new CliError(String(message).replace(/^Error:\s*/, ""), exitCodeForStatus(res.status), hint, b);
}

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".glb": "model/gltf-binary"
};

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

export function mimeFor(file: string, fieldName = ""): string | undefined {
  const ext = path.extname(file).toLowerCase();
  // .webm holds either; audio fields get audio.
  if (ext === ".webm" && /audio|sample/i.test(fieldName)) return "audio/webm";
  return MIME_BY_EXT[ext];
}

// Uploads a local file through createUpload and returns its public URL:
// ask the API for an upload session, then PUT the bytes straight to storage.
// Both steps are safe to repeat, so each gets one retry. A file uploaded
// before with the same content is not uploaded again (see upload-cache);
// `reuse: false` (`ludo files upload`, which promises a fresh 7-day URL)
// always uploads.
export async function uploadFile(
  api: Api,
  file: string,
  fieldName = "",
  log?: (msg: string) => void,
  opts: { reuse?: boolean } = {}
): Promise<string> {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new CliError(`File not found: ${file}`, EXIT.USAGE);
  }
  if (!stat.isFile()) throw new CliError(`Not a file: ${file}`, EXIT.USAGE);
  if (stat.size === 0) throw new CliError(`File is empty: ${file}`, EXIT.USAGE);
  if (stat.size > MAX_UPLOAD_BYTES) {
    throw new CliError(`${file} is ${(stat.size / 1024 / 1024).toFixed(1)}MB; the limit is 15MB`, EXIT.USAGE);
  }
  const mime = mimeFor(file, fieldName);
  if (!mime) {
    throw new CliError(
      `Unsupported file type: ${file}`,
      EXIT.USAGE,
      `Supported: ${Object.keys(MIME_BY_EXT).join(" ")}`
    );
  }

  const bytes = fs.readFileSync(file);
  return reuseOrUpload(
    uploadKey(api.baseUrl, mime, bytes),
    bytes.length,
    () => putNewUpload(api, file, mime, bytes, log),
    { reuse: opts.reuse, onReuse: () => log?.(`Reusing the earlier upload of ${path.basename(file)}`) }
  );
}

async function putNewUpload(api: Api, file: string, mime: string, bytes: Buffer<ArrayBuffer>, log?: (msg: string) => void): Promise<string> {
  log?.(`Uploading ${path.basename(file)} (${formatBytes(bytes.length)})`);
  const { body: session } = await api.call("POST", "/assets/uploads", { body: { mime_type: mime, size: bytes.length }, retry: true });
  const putOnce = () =>
    fetch(session.upload_url, {
      method: "PUT",
      headers: { "Content-Type": mime },
      body: bytes,
      signal: AbortSignal.timeout(10 * 60 * 1000)
    });
  const pause = () => new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
  let put: Response;
  try {
    put = await putOnce().catch(async () => {
      await pause();
      return putOnce();
    });
    if (put.status >= 500) {
      await pause();
      put = await putOnce();
    }
  } catch (err: any) {
    throw new CliError(`Upload of ${file} failed: ${err?.cause?.code || err?.message || err}`, EXIT.ERROR);
  }
  if (!put.ok) {
    throw new CliError(`Upload of ${file} failed: storage answered ${put.status}`, EXIT.ERROR, (await put.text()).slice(0, 200));
  }
  return session.file_url;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
