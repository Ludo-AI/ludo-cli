import fs from "node:fs";
import path from "node:path";
import { Api } from "./api.js";
import { CliError, EXIT } from "./errors.js";

export const TERMINAL = ["succeeded", "failed", "canceled"];
const LONG_POLL_S = 30;

export interface WaitOptions {
  timeoutS: number;
  progress?: (job: any, elapsedS: number) => void;
}

// Long-polls the job until it reaches a terminal status. Each poll holds for
// up to 30s server-side, so a normal generation costs a handful of requests,
// well inside the 150-per-5-minutes budget of the jobs endpoint.
export async function waitForJob(api: Api, id: string, opts: WaitOptions): Promise<any> {
  const started = Date.now();
  for (;;) {
    const elapsed = (Date.now() - started) / 1000;
    const remaining = opts.timeoutS - elapsed;
    if (remaining <= 0) {
      throw new CliError(
        `Timed out after ${Math.round(opts.timeoutS)}s; job ${id} is still running.`,
        EXIT.TIMEOUT,
        `Resume with: ludo jobs wait ${id}`
      );
    }
    const wait = Math.max(0, Math.min(LONG_POLL_S, Math.floor(remaining)));
    const { body: job } = await api.call("GET", `/assets/jobs/${encodeURIComponent(id)}`, {
      query: { wait },
      timeoutMs: (wait + 30) * 1000
    });
    opts.progress?.(job, (Date.now() - started) / 1000);
    if (TERMINAL.includes(job.status)) return job;
    if (job.poll_after_ms) await sleep(Math.min(job.poll_after_ms, 10_000));
  }
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Every downloadable URL in a result, whatever the operation's shape: image
// arrays, spritesheets with a video_url, 3D assets with several files...
export function collectUrls(value: unknown, found = new Set<string>()): string[] {
  if (typeof value === "string") {
    if (/^https?:\/\/\S+\.[a-z0-9]{2,5}(\?\S*)?$/i.test(value)) found.add(value);
  } else if (Array.isArray(value)) {
    value.forEach(v => collectUrls(v, found));
  } else if (value && typeof value === "object") {
    Object.values(value).forEach(v => collectUrls(v, found));
  }
  return [...found];
}

export interface SavedFile {
  url: string;
  path: string;
}

// `suffix` names the i-th of `count` files (default: -1, -2, ... when there
// are several); variations use it for -v1, -v2, ...
// <dir>/<base><ext>, or <base>-2<ext>, -3... when taken: saved files are never
// overwritten (a --name used twice, or a file the person already had). A WebP
// also needs its PNG twin free, since saveResult writes one beside it.
export function freePath(dir: string, base: string, ext: string): string {
  const taken = (p: string) => fs.existsSync(p) || (/\.webp$/i.test(p) && fs.existsSync(p.replace(/\.webp$/i, ".png")));
  let target = path.join(dir, `${base}${ext}`);
  for (let n = 2; taken(target); n++) target = path.join(dir, `${base}-${n}${ext}`);
  return target;
}

export async function downloadAll(
  urls: string[],
  dir: string,
  prefix: string,
  log?: (msg: string) => void,
  suffix: (i: number, count: number) => string = (i, count) => (count > 1 ? `-${i + 1}` : "")
): Promise<SavedFile[]> {
  fs.mkdirSync(dir, { recursive: true });
  const saved: SavedFile[] = [];
  for (const [i, url] of urls.entries()) {
    const ext = path.extname(new URL(url).pathname) || "";
    const target = freePath(dir, `${prefix}${suffix(i, urls.length)}`, ext);
    const failed = (err: any) => new CliError(`Download failed for ${url}: ${err?.cause?.code || err?.message || err}`, EXIT.ERROR);
    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(5 * 60 * 1000) });
    } catch (err: any) {
      throw failed(err);
    }
    if (!res.ok) throw new CliError(`Download failed for ${url}: HTTP ${res.status}`, EXIT.ERROR);
    // The timeout also covers the body: a slow download can abort here.
    let data: ArrayBuffer;
    try {
      data = await res.arrayBuffer();
    } catch (err: any) {
      throw failed(err);
    }
    fs.writeFileSync(target, Buffer.from(data));
    log?.(`Saved ${target}`);
    saved.push({ url, path: target });
  }
  return saved;
}

// Inline base64 in a result (hydra's `audio_b64`) is written to a file and
// replaced by its path, so it never floods an agent's context.
const MAGIC: [RegExp, string][] = [
  [/^ID3|^\xff[\xe0-\xff]/, ".mp3"],
  [/^RIFF.{4}WAVE/s, ".wav"],
  [/^OggS/, ".ogg"],
  [/^fLaC/, ".flac"],
  [/^\x89PNG/, ".png"],
  [/^GIF8/, ".gif"],
  [/^\xff\xd8/, ".jpg"],
  [/^.{4}ftyp/s, ".mp4"],
  [/^glTF/, ".glb"]
];

function extensionFor(buffer: Buffer, dataUrlMime?: string): string {
  if (dataUrlMime) {
    const sub = dataUrlMime.split("/")[1] || "";
    const map: Record<string, string> = { mpeg: ".mp3", mp3: ".mp3", wav: ".wav", "x-wav": ".wav", ogg: ".ogg", png: ".png", jpeg: ".jpg", webp: ".webp", mp4: ".mp4" };
    if (map[sub]) return map[sub];
  }
  const head = buffer.subarray(0, 12).toString("latin1");
  for (const [re, ext] of MAGIC) if (re.test(head)) return ext;
  return ".bin";
}

function looksLikeBase64(value: string): boolean {
  if (/^https?:\/\//i.test(value)) return false;
  const body = value.replace(/^data:[^,]*,/, "");
  return /^[A-Za-z0-9+/_-]+={0,2}$/.test(body.slice(0, 4096).replace(/\s+/g, ""));
}

export function extractInlineFiles(
  result: unknown,
  save: { dir: string; prefix: string } | null,
  log?: (msg: string) => void
): { result: unknown; files: SavedFile[] } {
  const files: SavedFile[] = [];
  const walk = (value: unknown, key: string): unknown => {
    // Some *_b64 fields hold a URL once the API has uploaded the file (a
    // spritesheet's audio_b64 is its mp3's URL); those are downloaded like any
    // other result URL. Only real base64 is decoded here.
    if (typeof value === "string" && /_b64$/.test(key) && value.length > 64 && looksLikeBase64(value)) {
      const m = /^data:([^;,]+)[^,]*,/.exec(value);
      const buffer = Buffer.from(m ? value.slice(m[0].length) : value, "base64");
      if (!save) return `<${buffer.length} bytes of base64 omitted; run without --no-download to save it>`;
      fs.mkdirSync(save.dir, { recursive: true });
      const target = freePath(save.dir, `${save.prefix}-${key.replace(/_b64$/, "")}`, extensionFor(buffer, m?.[1]));
      fs.writeFileSync(target, buffer);
      log?.(`Saved ${target}`);
      files.push({ url: `(inline ${key})`, path: target });
      return target;
    }
    if (Array.isArray(value)) return value.map((v, i) => walk(v, key));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, k)]));
    }
    return value;
  };
  return { result: walk(result, ""), files };
}

