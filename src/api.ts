import fs from "node:fs";
import path from "node:path";
import { VERSION } from "./config.js";
import { CliError, EXIT, exitCodeForStatus } from "./errors.js";

export interface ApiResponse {
  status: number;
  body: any;
}

export class Api {
  constructor(private apiUrl: string, private apiKey: string | undefined) {}

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
        "Get a key at https://app.ludo.ai (Account > API)."
      );
    }
  }

  async request(method: string, apiPath: string, opts: { query?: Record<string, unknown>; body?: unknown; timeoutMs?: number } = {}): Promise<ApiResponse> {
    const url = new URL(`${this.apiUrl}/api${apiPath}`);
    for (const [k, v] of Object.entries(opts.query || {})) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) v.forEach(item => url.searchParams.append(k, String(item)));
      else url.searchParams.set(k, String(v));
    }
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: this.headers(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(opts.timeoutMs || 120_000)
      });
    } catch (err: any) {
      throw new CliError(`Could not reach ${this.apiUrl}: ${err?.cause?.code || err?.message || err}`, EXIT.ERROR);
    }
    const text = await res.text();
    let body: any = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // Non-JSON error pages are reported as text.
    }
    return { status: res.status, body };
  }

  // A request that must succeed: any non-2xx becomes a CliError with the
  // server's message and an exit code for its class.
  async call(method: string, apiPath: string, opts: { query?: Record<string, unknown>; body?: unknown; timeoutMs?: number } = {}): Promise<ApiResponse> {
    const res = await this.request(method, apiPath, opts);
    if (res.status >= 200 && res.status < 300) return res;
    throw apiError(res);
  }
}

export function apiError(res: ApiResponse): CliError {
  const b = res.body;
  const message = (b && typeof b === "object" && (b.message || b.error)) || (typeof b === "string" && b.slice(0, 300)) || `HTTP ${res.status}`;
  let hint: string | undefined;
  if (res.status === 401 || res.status === 403) hint = "Check your API key: `ludo auth validate-api-key`.";
  if (res.status === 402) hint = "Not enough credits. Top up at https://app.ludo.ai.";
  if (res.status === 429) hint = b?.code === "PENDING_JOBS_LIMIT" ? "Too many jobs queued at once; wait for some to finish (`ludo jobs list`)." : "Rate limited; slow down and retry shortly.";
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
export async function uploadFile(api: Api, file: string, fieldName = "", log?: (msg: string) => void): Promise<string> {
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

  log?.(`Uploading ${path.basename(file)} (${formatBytes(stat.size)})`);
  const { body: session } = await api.call("POST", "/assets/uploads", { body: { mime_type: mime, size: stat.size } });
  let put: Response;
  try {
    put = await fetch(session.upload_url, {
      method: "PUT",
      headers: { "Content-Type": mime },
      body: fs.readFileSync(file),
      signal: AbortSignal.timeout(10 * 60 * 1000)
    });
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
