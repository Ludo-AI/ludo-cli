import fs from "node:fs";
import path from "node:path";
import { Api, apiError } from "./api.js";
import { CliError, EXIT } from "./errors.js";
import { extensionFor, looksLikeBase64 } from "./inline.js";

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

export function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function timedOut(id: string, timeoutS: number): CliError {
  return new CliError(`Timed out after ${Math.round(timeoutS)}s; job ${id} is still running.`, EXIT.TIMEOUT, `Resume with: ludo jobs wait ${id}`);
}

// LUDO_BATCH_POLL_MS exists for the tests.
const BATCH_POLL_MS = process.env.LUDO_BATCH_POLL_MS ? Number(process.env.LUDO_BATCH_POLL_MS) : 10_000;
// Jobs looked up by id per round when the listing no longer shows them.
const LOOKUPS_PER_ROUND = 2;
const LIST_LIMIT = 100;

interface Watched {
  promise: Promise<any>;
  resolve: (job: any) => void;
  reject: (err: unknown) => void;
  deadline: number;
}

export interface WatcherOptions {
  timeoutS: number; // per job, from when it is first waited on
  note?: (msg: string) => void;
  // True while more jobs may join soon (a batch still submitting): the
  // watcher then keeps to the listing rather than long-polling one job.
  moreComing?: () => boolean;
}

// Waits for many jobs with one read for all of them, so a batch stays far
// inside the jobs endpoints' budget (150 reads per 5 minutes per key, shared
// with every other session on the key) however many jobs it runs. With
// several jobs it reads the job listing (newest 100) every 10s, or the
// server's poll_after_ms when longer, and looks a job up by id only when the
// listing no longer shows it; with one left, it long-polls that job. A 429 on
// a read waits out its Retry-After and carries on: reads are safe to repeat.
export class JobWatcher {
  private jobs = new Map<string, Watched>();
  private running = false;
  private lastNote = 0;

  constructor(private api: Api, private opts: WatcherOptions) {}

  wait(id: string): Promise<any> {
    const known = this.jobs.get(id);
    if (known) return known.promise;
    let resolve!: (job: any) => void;
    let reject!: (err: unknown) => void;
    const promise = new Promise<any>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.jobs.set(id, { promise, resolve, reject, deadline: Date.now() + this.opts.timeoutS * 1000 });
    if (!this.running) {
      this.running = true;
      void this.loop();
    }
    return promise;
  }

  private settle(job: any): boolean {
    const w = job && typeof job.id === "string" ? this.jobs.get(job.id) : undefined;
    if (!w || !TERMINAL.includes(job.status)) return false;
    this.jobs.delete(job.id);
    w.resolve(job);
    return true;
  }

  private fail(id: string, err: unknown) {
    const w = this.jobs.get(id);
    if (!w) return;
    this.jobs.delete(id);
    w.reject(err);
  }

  private expire() {
    const now = Date.now();
    for (const [id, w] of [...this.jobs]) if (now >= w.deadline) this.fail(id, timedOut(id, this.opts.timeoutS));
  }

  // Sleeps, but not past the nearest deadline, so a timeout is reported on time.
  private async pause(ms: number) {
    const nearest = Math.min(...[...this.jobs.values()].map(w => w.deadline));
    await sleep(Math.max(0, Math.min(ms, nearest - Date.now())));
  }

  private async loop() {
    try {
      await this.rounds();
    } finally {
      this.running = false;
    }
  }

  private async rounds() {
    while (this.jobs.size) {
      this.expire();
      if (!this.jobs.size) break;
      let next = BATCH_POLL_MS;
      try {
        next = this.jobs.size === 1 && !this.opts.moreComing?.() ? await this.longPoll() : await this.listRound();
      } catch (err) {
        if (err instanceof CliError && err.exitCode === EXIT.RATE_LIMITED) {
          const s = err.retryAfterS ?? 30;
          if (Date.now() - this.lastNote > 60_000) {
            this.opts.note?.(`Job status reads are rate limited (150 per 5 minutes per key, shared with other sessions); waiting ${Math.ceil(s)}s.`);
            this.lastNote = Date.now();
          }
          next = Math.max(s * 1000, BATCH_POLL_MS);
        } else {
          // Anything else (no network after the retry, a rejected key, an
          // outdated CLI) ends every wait with that error, as one poll per
          // job would have.
          for (const id of [...this.jobs.keys()]) this.fail(id, err);
          break;
        }
      }
      if (this.jobs.size) await this.pause(next);
    }
  }

  private async lookup(id: string, wait = 0): Promise<number> {
    const res = await this.api.request("GET", `/assets/jobs/${encodeURIComponent(id)}`, wait ? { query: { wait }, timeoutMs: (wait + 30) * 1000 } : {});
    if (res.status === 404) {
      this.fail(id, apiError(res));
      return 0;
    }
    if (res.status < 200 || res.status >= 300) throw apiError(res);
    return this.settle(res.body) ? 0 : res.body?.poll_after_ms || 0;
  }

  private async longPoll(): Promise<number> {
    const [id, w] = [...this.jobs][0];
    const wait = Math.max(0, Math.min(LONG_POLL_S, Math.floor((w.deadline - Date.now()) / 1000)));
    return Math.min(await this.lookup(id, wait), 10_000);
  }

  private async listRound(): Promise<number> {
    const { body } = await this.api.call("GET", "/assets/jobs", { query: { limit: LIST_LIMIT } });
    const listed = new Map<string, any>();
    for (const job of Array.isArray(body) ? body : []) if (job && typeof job.id === "string") listed.set(job.id, job);
    let after = 0;
    const unseen: string[] = [];
    for (const id of [...this.jobs.keys()]) {
      const job = listed.get(id);
      if (!job) unseen.push(id);
      else if (!this.settle(job)) after = Math.max(after, job.poll_after_ms || 0);
    }
    // Pushed out of the newest 100 by later jobs on the key: looked up by id,
    // a couple per round (oldest first: the map keeps insertion order).
    for (const id of unseen.slice(0, LOOKUPS_PER_ROUND)) after = Math.max(after, await this.lookup(id));
    return Math.max(BATCH_POLL_MS, Math.min(after, 60_000));
  }
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
  // Saved by an earlier run for the same job, and left as it was.
  reused?: boolean;
}

// For a job saved before (a jobs file run again: its request_ids bring the
// same jobs back), where an earlier run saved the file this one would name
// <base><ext>: exists false means it was saved there and is gone since.
export type Earlier = (base: string, ext: string) => { path: string; exists: boolean } | undefined;

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
  suffix: (i: number, count: number) => string = (i, count) => (count > 1 ? `-${i + 1}` : ""),
  earlier?: Earlier
): Promise<SavedFile[]> {
  fs.mkdirSync(dir, { recursive: true });
  const saved: SavedFile[] = [];
  for (const [i, url] of urls.entries()) {
    const ext = path.extname(new URL(url).pathname) || "";
    const base = `${prefix}${suffix(i, urls.length)}`;
    const before = earlier?.(base, ext);
    if (before?.exists) {
      log?.(`Already saved ${before.path}`);
      saved.push({ url, path: before.path, reused: true });
      continue;
    }
    // A file saved before and deleted since comes back where it was.
    const target = before ? before.path : freePath(dir, base, ext);
    await fetchToFile(url, target, log);
    log?.(`Saved ${target}`);
    saved.push({ url, path: target });
  }
  return saved;
}

const DOWNLOAD_ATTEMPTS = 4;

// Streams url into target through a .part file. A transfer that stalls (no
// data for idleMs) or drops part-way is picked up with a Range request from
// the bytes already written, so a long video on a flaky line is neither lost
// nor fetched from zero again. A server that ignores Range starts it over.
// The .part file is this process's own: two ludo processes saving the same
// file (the same job waited on twice) would otherwise write into one, and
// the second rename fails.
export async function fetchToFile(url: string, target: string, log?: (msg: string) => void, idleMs = 60_000): Promise<void> {
  const part = `${target}.${process.pid}.part`;
  const state = { written: 0 };
  try {
    for (let attempt = 1; ; attempt++) {
      let problem: string;
      try {
        if (await fetchOnce(url, part, state, idleMs)) break;
        problem = "the connection closed early";
      } catch (err: any) {
        if (err instanceof CliError) throw err;
        problem = err?.cause?.code || err?.message || String(err);
      }
      if (attempt === DOWNLOAD_ATTEMPTS) throw new CliError(`Download failed for ${url}: ${problem}`, EXIT.ERROR);
      log?.(`Download of ${path.basename(target)} interrupted (${problem}); resuming from byte ${state.written.toLocaleString("en-US")}.`);
    }
    fs.renameSync(part, target);
  } finally {
    fs.rmSync(part, { force: true });
  }
}

// One request, appending to part from state.written. True once the whole
// file is there.
async function fetchOnce(url: string, part: string, state: { written: number }, idleMs: number): Promise<boolean> {
  const ctrl = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const kick = () => {
    clearTimeout(timer);
    timer = setTimeout(() => ctrl.abort(new Error(`no data for ${idleMs / 1000}s`)), idleMs);
  };
  kick();
  try {
    const res = await fetch(url, { headers: state.written ? { Range: `bytes=${state.written}-` } : {}, signal: ctrl.signal });
    const rangeTotal = () => Number(/\/(\d+)$/.exec(res.headers.get("content-range") || "")?.[1]) || undefined;
    let total: number | undefined;
    if (res.status === 206) {
      total = rangeTotal();
    } else if (res.status === 416 && state.written) {
      // Everything had arrived; only the end of the last response was lost.
      if (rangeTotal() === state.written) return true;
      state.written = 0;
      return false;
    } else if (res.ok) {
      state.written = 0;
      total = Number(res.headers.get("content-length")) || undefined;
    } else {
      throw new CliError(`Download failed for ${url}: HTTP ${res.status}`, EXIT.ERROR);
    }
    const fd = fs.openSync(part, state.written ? "a" : "w");
    try {
      for await (const chunk of (res.body || []) as unknown as AsyncIterable<Uint8Array>) {
        fs.writeSync(fd, chunk);
        state.written += chunk.length;
        kick();
      }
    } finally {
      fs.closeSync(fd);
    }
    return total === undefined || state.written >= total;
  } catch (err) {
    if (ctrl.signal.aborted && !(err instanceof CliError)) throw ctrl.signal.reason;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Inline base64 in a result (hydra's `audio_b64`) is written to a file and
// replaced by its path, so it never floods an agent's context.
export function extractInlineFiles(
  result: unknown,
  save: { dir: string; prefix: string; earlier?: Earlier } | null,
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
      const base = `${save.prefix}-${key.replace(/_b64$/, "")}`;
      const ext = extensionFor(buffer, m?.[1]);
      const before = save.earlier?.(base, ext);
      if (before?.exists) {
        files.push({ url: `(inline ${key})`, path: before.path, reused: true });
        return before.path;
      }
      const target = before ? before.path : freePath(save.dir, base, ext);
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

