import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { Api, uploadFile } from "./api.js";
import { appendAssets, logFile, relativizeBody, updateAssets, type AssetEntry } from "./assets.js";
import { checkBudget, recordEstimate, recordFinal, totalOf } from "./budget.js";
import type { Globals, Parsed } from "./args.js";
import { resolveFlags } from "./args.js";
import type { Command } from "./commands.js";
import { resolveApiKey, resolveApiUrl } from "./config.js";
import { CliError, EXIT } from "./errors.js";
import { collectUrls, downloadAll, extractInlineFiles, waitForJob, type SavedFile } from "./jobs.js";
import { accountSummary, isAgent } from "./login.js";
import { estimatePrice, formatCredits, type Price } from "./pricing.js";
import { defaultsFor, projectPath, type Project } from "./project.js";
import { AUDIO_EXT, copyText, IMAGE_EXT, openFile, playAudio } from "./tty/actions.js";
import { creditsBar, nextStep, spinner } from "./tty/flair.js";
import { writeGodotSpriteFrames } from "./tty/godot.js";
import { convertToPng, loadImage } from "./tty/image.js";
import { canShowImages, gridFromResult, previewFile, previewSkipped, stampGrid } from "./tty/preview.js";
import { visuals, type Visuals } from "./tty/visuals.js";

// Running generations: one request, N variations of one request, or a batch
// of different requests. All three go through the same steps: resolve the
// request (flags over --input over .ludo.json defaults), price it, check the
// spending guard, upload local files, submit, wait, save the files, and
// record the spend and the asset log.

export const DEFAULT_OUT = "ludo-output";
const DEFAULT_TIMEOUT_S = 30 * 60;
// Asking before a big spend, and how long the question waits.
const CONFIRM_ABOVE = 50;
const PROMPT_TIMEOUT_MS = 20_000;

export interface Ctx {
  globals: Globals;
  api: Api;
  jsonOut: boolean;
  vis: Visuals;
  log: (msg: string) => void;
  project?: Project;
  outDir: string;
}

export function makeCtx(globals: Globals, project?: Project): Ctx {
  const jsonOut = globals.json || !process.stdout.isTTY;
  const log = (msg: string) => {
    if (!globals.quiet) process.stderr.write(msg + "\n");
  };
  const vis = visuals({ json: jsonOut, quiet: globals.quiet, plain: globals.plain });
  if (project?.config.engine && !globals.engine) globals.engine = project.config.engine;
  const outDir = path.resolve(globals.out || (project?.config.out ? projectPath(project, project.config.out, "out") : DEFAULT_OUT));
  return { globals, api: new Api(resolveApiUrl(globals.apiUrl), resolveApiKey(globals.apiKey)), jsonOut, vis, log, project, outDir };
}

export function printJson(value: unknown, pretty: boolean) {
  process.stdout.write(JSON.stringify(value, null, pretty ? 2 : 0) + "\n");
}

const prettyJson = (ctx: Ctx) => !ctx.jsonOut || (!!ctx.globals.json && process.stdout.isTTY);

// A person at a terminal who can answer a question. Never an agent or a pipe.
export function canAsk(ctx: Ctx): boolean {
  return !!process.stdin.isTTY && !!process.stderr.isTTY && !!process.stdout.isTTY && !ctx.globals.json && !isAgent() && !process.env.CI;
}

export async function ask(question: string, fallback: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  const answer = await new Promise<string>(resolve => {
    const timer = setTimeout(() => {
      process.stderr.write("\n");
      resolve(fallback);
    }, PROMPT_TIMEOUT_MS);
    rl.question(question, a => {
      clearTimeout(timer);
      resolve(a);
    });
  });
  rl.close();
  return answer.trim();
}

function isLocalPathish(value: string): boolean {
  return !/^(https?:|data:)/i.test(value);
}

// Local files in file-accepting fields are uploaded and replaced by their URL.
// `@path` forces a file even where the value would otherwise be ambiguous.
// Returns a new body; the original keeps its local paths for the asset log.
export async function uploadLocalFiles(ctx: Ctx, command: Command, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const body = { ...input };
  for (const field of command.fields.filter(f => f.isFile && f.in === "body")) {
    const value = body[field.name];
    const one = async (v: unknown): Promise<unknown> => {
      if (typeof v !== "string") return v;
      const explicit = v.startsWith("@");
      const candidate = explicit ? v.slice(1) : v;
      if (!isLocalPathish(candidate)) return v;
      if (explicit || fs.existsSync(candidate)) return uploadFile(ctx.api, candidate, field.name, ctx.log);
      // Neither URL nor existing file: a path typo is far likelier than raw base64.
      if (candidate.length < 512 && /[\/\\.]/.test(candidate)) {
        throw new CliError(`${field.flag}: file not found: ${candidate}`, EXIT.USAGE);
      }
      return v;
    };
    if (Array.isArray(value)) body[field.name] = await Promise.all(value.map(one));
    else if (value !== undefined) body[field.name] = await one(value);
  }
  return body;
}

function expandPath(template: string, params: Record<string, string>): string {
  return template.replace(/\{([^}]+)\}/g, (_, name) => encodeURIComponent(params[name] ?? ""));
}

// ─── Preparing a request ─────────────────────────────────────────────────────

export interface Prepared {
  command: Command;
  body: Record<string, unknown>; // local paths, as the person gave them
  query: Record<string, unknown>;
  path: Record<string, string>;
  price: Price;
  label: string;
}

export type DefaultsLayer = { values: Record<string, unknown>; source: string };

export function prepare(ctx: Ctx, command: Command, parsed: Parsed, positionals: string[], extra: DefaultsLayer[] = []): Prepared {
  const layers: DefaultsLayer[] = [];
  const p = ctx.project;
  if (p?.config.style_image && command.fields.some(f => f.name === "style_image" && f.in === "body")) {
    layers.push({ values: { style_image: projectPath(p, p.config.style_image, "style_image") }, source: `style_image in ${p.file}` });
  }
  const fromConfig = defaultsFor(p, command.group, command.name, command.operationId);
  if (p && Object.keys(fromConfig).length) {
    // File fields in defaults are relative to .ludo.json and stay inside the project.
    for (const [key, value] of Object.entries(fromConfig)) {
      const field = command.fields.find(f => f.name === key.replace(/^--/, "").replace(/-/g, "_"));
      if (!field?.isFile) continue;
      const fix = (v: unknown) => (typeof v === "string" ? projectPath(p, v, `defaults.${key}`) : v);
      fromConfig[key] = Array.isArray(value) ? value.map(fix) : fix(value);
    }
    layers.push({ values: fromConfig, source: `defaults in ${p.file}` });
  }
  layers.push(...extra);
  const resolved = resolveFlags(command, parsed, positionals, layers);
  if (resolved.extraWords.length) {
    throw new CliError(`Unexpected argument: ${resolved.extraWords[0]}`, EXIT.USAGE, `Run \`ludo ${command.group} ${command.name} --help\`.`);
  }
  // --n is the variations flag for generations. An operation with its own n
  // (docs search's result count, an image job's n) gets the value directly.
  const nField = command.fields.find(f => f.name === "n" && f.in !== "path");
  if (ctx.globals.n !== undefined) {
    if (!command.isJob && !nField) throw new CliError("--n applies to generations only", EXIT.USAGE);
    if (nField) (nField.in === "query" ? resolved.query : resolved.body).n = ctx.globals.n;
  }
  return {
    command,
    body: resolved.body,
    query: resolved.query,
    path: resolved.path,
    price: command.isJob ? estimatePrice(command, resolved.body) : { credits: 0, exact: true },
    label: `${command.group} ${command.name}`
  };
}

function priceText(price: Price): string {
  if (price.credits === undefined) return `unknown (${price.note || "see --help"})`;
  return `${price.exact ? "" : "up to "}${formatCredits(price.credits)}`;
}

function dryRun(ctx: Ctx, label: string, total: Price, parts: { label: string; count: number; price: Price }[]): number {
  if (ctx.jsonOut) {
    printJson({ dry_run: true, command: label, credits: total.credits ?? null, exact: total.exact, note: total.note, items: parts.map(p => ({ command: p.label, count: p.count, credits: p.price.credits ?? null, exact: p.price.exact })) }, prettyJson(ctx));
  } else {
    for (const p of parts) process.stdout.write(`${p.label}${p.count > 1 ? ` × ${p.count}` : ""}: ${priceText(p.price)}${p.count > 1 ? " each" : ""}\n`);
    if (parts.length > 1 || parts[0]?.count > 1) process.stdout.write(`Total: ${priceText(total)}\n`);
    process.stdout.write("Dry run: nothing was submitted.\n");
  }
  return EXIT.OK;
}

// The guard, then (for people) a question before a big multi-job spend.
async function guard(ctx: Ctx, total: Price, multi: boolean) {
  checkBudget(ctx.project, total, { maxCredits: ctx.globals.maxCredits, force: ctx.globals.force });
  if (!multi || ctx.globals.yes || total.credits === undefined || total.credits <= CONFIRM_ABOVE || !canAsk(ctx)) return;
  const answer = await ask(`This will spend ${priceText(total)}. Continue? [y/N] `, "n");
  if (!/^y(es)?$/i.test(answer)) throw new CliError("Canceled; nothing was submitted.", EXIT.USAGE);
}

// ─── Saving a finished job ───────────────────────────────────────────────────

export interface Naming {
  prefix?: string;
  suffix?: (i: number, count: number) => string;
  // Which variation a result URL (by index) or an inline file belongs to.
  variationOf?: (i: number) => number | undefined;
}

export interface SavedResult {
  record: any;
  sheet?: string;
  files: (SavedFile & { variation?: number })[]; // paths relative to cwd
}

export async function saveResult(ctx: Ctx, job: any, label: string, naming: Naming = {}): Promise<SavedResult> {
  const { globals } = ctx;
  const record: any = {
    job_id: job.id,
    status: job.status,
    task_type: job.task_type,
    credits_charged: job.credits_charged,
    result: job.result,
    error: job.error
  };
  let sheet: string | undefined;
  let files: SavedResult["files"] = [];
  if (job.status === "succeeded") {
    const dir = ctx.outDir;
    const prefix = naming.prefix || `${job.task_type || label}-${String(job.id).slice(0, 8)}`;
    const inline = extractInlineFiles(job.result, globals.download ? { dir, prefix } : null, ctx.log);
    record.result = inline.result;
    const urls = collectUrls(record.result);
    const downloaded: SavedResult["files"] = globals.download && urls.length ? await downloadAll(urls, dir, prefix, ctx.log, naming.suffix) : [];
    downloaded.forEach((f, i) => (f.variation = naming.variationOf?.(i)));
    // WebP results also get a PNG copy side by side: engines and tools take
    // PNG everywhere, and the PNG is what carries a spritesheet's grid.
    const pngOf = new Map<string, string>();
    for (const f of [...downloaded]) {
      if (!/\.webp$/i.test(f.path)) continue;
      const png = f.path.replace(/\.webp$/i, ".png");
      if (!fs.existsSync(png) && convertToPng(f.path, png)) {
        pngOf.set(f.path, png);
        downloaded.push({ url: f.url, path: png, variation: f.variation });
      }
    }
    // A spritesheet remembers its grid inside the PNG, for `ludo preview`
    // and engine exports.
    const grid = gridFromResult(job.result);
    const sheetFile = downloaded.find(f => f.url === job.result?.spritesheet_url);
    const sheetPng = sheetFile && (pngOf.get(sheetFile.path) || (/\.png$/i.test(sheetFile.path) ? sheetFile.path : undefined));
    if (grid && sheetPng) {
      stampGrid(sheetPng, grid);
      sheet = sheetPng;
    }
    const engineFiles = globals.engine ? await engineExport(ctx, sheet, grid) : [];
    const constant = naming.variationOf?.(-1);
    const rel = (p: string) => path.relative(process.cwd(), p) || p;
    files = [
      ...downloaded,
      ...inline.files.map(f => ({ ...f, variation: constant })),
      ...engineFiles.map(f => ({ ...f, variation: sheetFile?.variation ?? constant }))
    ].map(f => ({ ...f, path: rel(f.path) }));
    record.files = files.map(f => (f.variation === undefined ? { url: f.url, path: f.path } : f));
    // Inline files were replaced by their absolute path; show it relative too.
    for (const f of inline.files) record.result = replaceString(record.result, f.path, rel(f.path));
    if (sheet) sheet = rel(sheet);
  }
  return { record, sheet, files };
}

// Records what a finished job spent and the files it saved.
function bookkeep(ctx: Ctx, job: any, saved: SavedResult, prep?: Prepared, variationSet?: string) {
  try {
    recordFinal(ctx.project, job);
  } catch (err) {
    ctx.log(`Could not update the spend ledger: ${(err as Error).message}`);
  }
  if (!saved.files.length) return;
  try {
    const log = logFile(ctx.project, ctx.outDir);
    const logDir = path.dirname(log);
    const fileFields = prep ? prep.command.fields.filter(f => f.isFile && f.in === "body").map(f => f.name) : [];
    const created = new Date().toISOString();
    const entries: AssetEntry[] = saved.files.map(f => ({
      file: path.relative(logDir, path.resolve(f.path)),
      command: prep?.label || job.task_type || "job",
      operation_id: prep?.command.operationId || job.task_type || "",
      body: prep ? relativizeBody(prep.body, fileFields, logDir) : {},
      // `ludo jobs wait` knows the job but not the request that made it.
      ...(prep ? {} : { redo: false }),
      job_id: job.id,
      credits: typeof job.credits_charged === "number" ? job.credits_charged : undefined,
      created_at: created,
      ...(variationSet ? { variation_set: variationSet, variation: f.variation } : {})
    }));
    appendAssets(log, entries);
  } catch (err) {
    ctx.log(`Could not update the asset log: ${(err as Error).message}`);
  }
}

async function finishJob(ctx: Ctx, job: any, label: string, prep?: Prepared): Promise<number> {
  const { globals } = ctx;
  const saved = await saveResult(ctx, job, label);
  bookkeep(ctx, job, saved, prep);
  const { record, files, sheet } = saved;
  if (ctx.jsonOut) {
    printJson(record, !!ctx.globals.json && process.stdout.isTTY);
  } else {
    if (job.status === "succeeded") {
      const cost = await costLine(ctx, job.credits_charged);
      process.stdout.write(`✓ ${label} succeeded${cost ? ` (${cost})` : ""}\n`);
      for (const f of files) process.stdout.write(`  ${f.path}\n`);
      if (!files.length) printJson(job.result, true);
      if (ctx.vis.enabled) {
        const still = sheet || files.find(f => IMAGE_EXT.test(f.path))?.path;
        if (still && (await previewFile(still, ctx.vis)) === "unsupported") {
          process.stderr.write(`${previewSkipped()}\n`);
        }
      }
      const hint = !globals.quiet && nextStep(job.task_type, files, prep?.body);
      if (hint) process.stderr.write(`${hint}\n`);
    } else {
      process.stdout.write(`✗ ${label} ${job.status}${job.error?.message ? `: ${job.error.message}` : ""}\n`);
      // A failure a retry will not fix is worth hearing about.
      if (job.status === "failed" && job.error?.retriable === false && !globals.quiet) {
        process.stderr.write(`Blocked by this? Tell us: ludo feedback "<what you needed>" --category limitation --job ${job.id}\n`);
      }
    }
  }
  if (job.status === "succeeded" && files.length) handOff(ctx, files, sheet);
  if (job.status === "failed") return EXIT.JOB_FAILED;
  if (job.status === "canceled") return EXIT.JOB_CANCELED;
  return EXIT.OK;
}

// "9 credits · 1,831 left", for people only (one extra request).
async function costLine(ctx: Ctx, charged: unknown): Promise<string | undefined> {
  const spent = typeof charged === "number" && charged > 0 ? `${charged.toLocaleString("en-US")} credits` : undefined;
  const res = await ctx.api.request("GET", "/assets/account", { timeoutMs: 5_000 }).catch(() => undefined);
  const left = res?.status === 200 ? res.body?.credits?.available : undefined;
  const leftText = typeof left === "number" ? `${left.toLocaleString("en-US", { maximumFractionDigits: 2 })} left` : undefined;
  return [spent, leftText].filter(Boolean).join(" · ") || undefined;
}

// --open, --play, --copy: explicit requests, so they run for agents too.
function handOff(ctx: Ctx, files: { path: string }[], sheet?: string) {
  const { globals } = ctx;
  if (globals.copy) {
    const ok = copyText(files.map(f => path.resolve(f.path)).join("\n"));
    ctx.log(ok ? "Copied the file paths to the clipboard." : "Could not reach a clipboard tool (pbcopy, wl-copy, xclip, xsel or clip).");
  }
  if (globals.open) {
    const target = sheet || files.find(f => IMAGE_EXT.test(f.path))?.path || files[0].path;
    openFile(path.resolve(target));
  }
  if (globals.play) {
    const audio = files.find(f => AUDIO_EXT.test(f.path));
    if (audio) playAudio(path.resolve(audio.path));
    else ctx.log("--play: this result has no audio.");
  }
}

async function engineExport(ctx: Ctx, sheet: string | undefined, grid: ReturnType<typeof gridFromResult>): Promise<{ url: string; path: string }[]> {
  if (!sheet || !grid) {
    ctx.log("--engine godot: this result has no spritesheet, so there is nothing to export.");
    return [];
  }
  try {
    const img = loadImage(sheet);
    if (!img) throw new Error("could not read the spritesheet");
    const tres = writeGodotSpriteFrames(sheet, img.width, img.height, { cols: grid.cols, rows: grid.rows, frames: grid.frames, fps: grid.fps });
    return [{ url: "(godot SpriteFrames)", path: tres }];
  } catch (err) {
    ctx.log(`--engine godot: ${(err as Error).message}`);
    return [];
  }
}

function replaceString(value: unknown, from: string, to: string): unknown {
  if (value === from) return to;
  if (Array.isArray(value)) return value.map(v => replaceString(v, from, to));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replaceString(v, from, to)]));
  return value;
}

// A one-line spinner for a person at a terminal; otherwise one plain line
// per status change, as logs and agents expect.
function progressReporter(ctx: Ctx, label: string) {
  if (ctx.vis.enabled) {
    const s = spinner(label, ctx.vis);
    return { report: (job: any, elapsed: number) => s.update(job.status, elapsed), stop: () => s.stop() };
  }
  let last = "";
  return {
    report: (job: any, elapsed: number) => {
      const line = `${label}: ${job.status} (${Math.round(elapsed)}s)`;
      if (line !== last && !ctx.globals.quiet) {
        process.stderr.write(line + "\n");
        last = line;
      }
    },
    stop: () => {}
  };
}

export async function runJobWait(ctx: Ctx, id: string, label: string, prep?: Prepared): Promise<number> {
  ctx.api.requireKey();
  const progress = progressReporter(ctx, label);
  const stopHint = () => {
    progress.stop();
    process.stderr.write(`\nStopped waiting. The job keeps running; resume with: ludo jobs wait ${id}\n`);
    process.exit(EXIT.INTERRUPTED);
  };
  process.once("SIGINT", stopHint);
  let job;
  try {
    job = await waitForJob(ctx.api, id, {
      timeoutS: ctx.globals.timeout || DEFAULT_TIMEOUT_S,
      progress: progress.report
    });
  } finally {
    progress.stop();
    process.removeListener("SIGINT", stopHint);
  }
  return finishJob(ctx, job, label, prep);
}

// ─── One request ─────────────────────────────────────────────────────────────

export async function runCommand(ctx: Ctx, command: Command, parsed: Parsed, positionals: string[], extra: DefaultsLayer[] = []): Promise<number> {
  const { globals } = ctx;
  const prep = prepare(ctx, command, parsed, positionals, extra);
  if (command.isJob && globals.n !== undefined && globals.n > 1) {
    // Variations, unless --no-wait asks for the one job the API's own n makes.
    const native = command.fields.find(f => f.name === "n" && f.in === "body");
    const oneJob = !!native && globals.n <= (native.maximum || 1);
    if (globals.wait) return runVariations(ctx, prep, globals.n);
    if (!oneJob) throw new CliError("--n with more jobs than one waits for them to pick between them; drop --no-wait", EXIT.USAGE);
  }
  if (globals.dryRun) return dryRun(ctx, prep.label, prep.price, [{ label: prep.label, count: 1, price: prep.price }]);
  if (command.isJob) await guard(ctx, prep.price, false);

  ctx.api.requireKey();
  const uploaded = await uploadLocalFiles(ctx, command, prep.body);
  const hasBody = command.method !== "GET" && command.method !== "DELETE";
  const body = hasBody ? { ...uploaded, ...(command.isJob ? { async: true } : {}) } : undefined;
  if (command.isJob) ctx.log(`Submitting ${prep.label}`);
  const { body: response } = await ctx.api.call(command.method, expandPath(command.path, prep.path), { query: prep.query, body });
  // Counted from submission, so a job left running still counts.
  if (command.isJob) recordEstimate(ctx.project, response?.id, prep.price.credits);

  if (command.isJob && response && response.id && response.status) {
    if (!globals.wait) {
      printJson(response, !ctx.jsonOut || !!globals.json);
      return EXIT.OK;
    }
    if (["succeeded", "failed", "canceled"].includes(response.status)) return finishJob(ctx, response, prep.label, prep);
    return runJobWait(ctx, response.id, prep.label, prep);
  }
  if (command.operationId === "getAccount" && !ctx.jsonOut) {
    const c = response?.credits || {};
    if (ctx.vis.enabled && typeof c.available === "number") process.stderr.write(`  ${creditsBar(c.available, (c.plan_credits || 0) + (c.extra || 0))}\n`);
    process.stdout.write(accountSummary(response) + "\n");
    return EXIT.OK;
  }
  // Some operations answer 200 with no body (validate-api-key).
  printJson(response === null || response === "" ? { ok: true } : response, prettyJson(ctx));
  return EXIT.OK;
}

// ─── Several jobs at once ────────────────────────────────────────────────────

interface Unit {
  prep: Prepared;
  body: Record<string, unknown>; // uploaded, ready to send
  naming?: Naming;
}

export interface UnitOutcome {
  index: number;
  label: string;
  status: string; // succeeded | failed | canceled | error
  job_id?: string;
  credits_charged?: number;
  files: SavedResult["files"];
  sheet?: string;
  error?: { message: string; exit_code: number };
}

async function pool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>, stopped = () => false): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length && !stopped()) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Submits every unit (at most `limit` in flight), waits for each, saves its
// files and books it. A failure is recorded, never thrown: the others go on.
async function runUnits(ctx: Ctx, units: Unit[], label: string, limit: number, variationSet?: string): Promise<UnitOutcome[]> {
  ctx.api.requireKey();
  const quietCtx: Ctx = { ...ctx, log: () => {} };
  let done = 0;
  let failed = 0;
  const started = Date.now();
  const s = ctx.vis.enabled ? spinner(label, ctx.vis) : undefined;
  const status = () => `${done}/${units.length} done${failed ? `, ${failed} failed` : ""}`;
  s?.update(status(), 0);
  const ticker = s ? setInterval(() => s.update(status(), (Date.now() - started) / 1000), 1000) : undefined;
  ticker?.unref();
  // An error every other unit would hit too (bad key, no credits, an outdated
  // CLI, rate limits) stops the pool and is raised as itself.
  let fatal: CliError | undefined;
  try {
    const outcomes = await pool(units, limit, async (unit, index) => {
      const outcome: UnitOutcome = { index, label: unit.prep.label, status: "error", files: [] };
      try {
        const { command } = unit.prep;
        const { body: response } = await ctx.api.call(command.method, expandPath(command.path, unit.prep.path), {
          query: unit.prep.query,
          body: { ...unit.body, async: true }
        });
        outcome.job_id = response?.id;
        recordEstimate(ctx.project, response?.id, unit.prep.price.credits);
        const job = ["succeeded", "failed", "canceled"].includes(response?.status)
          ? response
          : await waitForJob(ctx.api, response.id, { timeoutS: ctx.globals.timeout || DEFAULT_TIMEOUT_S });
        const saved = await saveResult(quietCtx, job, unit.prep.label, unit.naming);
        bookkeep(ctx, job, saved, unit.prep, variationSet);
        Object.assign(outcome, {
          status: job.status,
          job_id: job.id,
          credits_charged: job.credits_charged,
          files: saved.files,
          sheet: saved.sheet,
          error: job.status === "succeeded" ? undefined : { message: job.error?.message || job.status, exit_code: job.status === "canceled" ? EXIT.JOB_CANCELED : EXIT.JOB_FAILED }
        });
      } catch (err) {
        const e = err instanceof CliError ? err : new CliError(String((err as Error)?.message || err));
        outcome.error = { message: e.message, exit_code: e.exitCode };
        if (FATAL.includes(e.exitCode)) fatal = fatal || e;
      }
      done++;
      if (outcome.status !== "succeeded") failed++;
      if (!s && !ctx.globals.quiet) {
        const mark = outcome.status === "succeeded" ? "✓" : "✗";
        process.stderr.write(`[${done}/${units.length}] ${mark} ${outcome.label}${outcome.job_id ? ` (${outcome.job_id})` : ""}${outcome.error ? `: ${outcome.error.message}` : ""}\n`);
      }
      return outcome;
    }, () => !!fatal);
    if (fatal) throw fatal;
    return outcomes;
  } finally {
    if (ticker) clearInterval(ticker);
    s?.stop();
  }
}

const FATAL: number[] = [EXIT.AUTH, EXIT.CREDITS, EXIT.UPGRADE_REQUIRED, EXIT.RATE_LIMITED];

// The exit code for a multi-job run where some failed: a job failure when any
// job ran, otherwise the commonest reason nothing ran.
function failureCode(outcomes: UnitOutcome[]): number {
  if (outcomes.some(o => o.job_id)) return EXIT.JOB_FAILED;
  const counts = new Map<number, number>();
  for (const o of outcomes) if (o.error) counts.set(o.error.exit_code, (counts.get(o.error.exit_code) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? EXIT.ERROR;
}

const sumCharged = (outcomes: UnitOutcome[]) =>
  Math.round(outcomes.reduce((sum, o) => sum + (typeof o.credits_charged === "number" ? o.credits_charged : 0), 0) * 100) / 100;

// ─── Variations: --n ─────────────────────────────────────────────────────────

// N of the same request. Where the API takes `n` (images) one job makes up to
// its maximum; beyond that, and everywhere else, N jobs run side by side.
// Files are numbered -v1..-vN and logged as one variation set. A person then
// picks which to keep; the rest move to <out>/.discarded.
export async function runVariations(ctx: Ctx, prep: Prepared, n: number): Promise<number> {
  const { command } = prep;
  const native = command.fields.find(f => f.name === "n" && f.in === "body" && (f.type === "integer" || f.type === "number"));
  const nativeMax = native ? Math.max(1, native.maximum || 1) : 1;
  const chunks: { offset: number; count: number }[] = [];
  for (let offset = 0; offset < n; offset += nativeMax) chunks.push({ offset, count: Math.min(nativeMax, n - offset) });
  const set = crypto.randomBytes(4).toString("hex");
  const preps = chunks.map(c => {
    const body = native ? { ...prep.body, n: c.count } : { ...prep.body };
    delete (body as any).async;
    return { ...prep, body, price: estimatePrice(command, body) };
  });
  const total = totalOf(preps.map(p => p.price));
  const label = `${prep.label} ×${n}`;
  if (ctx.globals.dryRun) {
    return dryRun(ctx, label, total, [{ label: prep.label, count: n, price: estimatePrice(command, native ? { ...prep.body, n: 1 } : prep.body) }]);
  }
  await guard(ctx, total, true);
  ctx.api.requireKey();
  // Upload local files once; every job reuses the URLs.
  const uploaded = await uploadLocalFiles(ctx, command, prep.body);
  const units: Unit[] = preps.map((p, i) => {
    const { offset, count } = chunks[i];
    const task = command.operationId;
    return {
      prep: p,
      body: native ? { ...uploaded, n: count } : uploaded,
      naming: native
        ? { prefix: `${task}-${set}`, suffix: (j: number) => (j < count ? `-v${offset + j + 1}` : `-x${j + 1}`), variationOf: (j: number) => (j >= 0 && j < count ? offset + j + 1 : undefined) }
        : { prefix: `${task}-${set}-v${offset + 1}`, variationOf: () => offset + 1 }
    };
  });
  ctx.log(`Submitting ${label}`);
  const outcomes = await runUnits(ctx, units, label, Math.min(4, units.length), set);
  const files = outcomes.flatMap(o => o.files);
  const ok = outcomes.filter(o => o.status === "succeeded");
  const variations = Array.from({ length: n }, (_, i) => i + 1).map(v => {
    const o = outcomes.find(x => x.files.some(f => f.variation === v)) || (native ? undefined : outcomes[v - 1]);
    return {
      variation: v,
      job_id: o?.job_id,
      status: o?.status || "failed",
      files: files.filter(f => f.variation === v).map(f => f.path),
      error: o?.status === "succeeded" ? undefined : o?.error
    };
  });

  let kept: number[] | undefined;
  if (!ctx.jsonOut) {
    process.stdout.write(`${ok.length ? "✓" : "✗"} ${label}: ${variations.filter(v => v.files.length).length} of ${n} variations saved (${formatCredits(sumCharged(outcomes))})\n`);
    for (const v of variations) {
      process.stdout.write(`  v${v.variation}: ${v.files.length ? v.files.join(", ") : `failed${v.error ? `: ${v.error.message}` : ""}`}\n`);
    }
    if (ctx.vis.enabled && !canShowImages()) {
      if (variations.some(v => v.files.some(p => IMAGE_EXT.test(p)))) process.stderr.write(`${previewSkipped()}\n`);
    } else if (ctx.vis.enabled) {
      // Numbered, one after another; a spritesheet plays.
      const sheets = new Set(outcomes.map(o => o.sheet).filter(Boolean));
      for (const v of variations) {
        const still = v.files.find(p => sheets.has(p)) || v.files.find(p => IMAGE_EXT.test(p));
        if (!still) continue;
        process.stderr.write(`v${v.variation}\n`);
        await previewFile(still, ctx.vis);
      }
    }
    const saved = variations.filter(v => v.files.length);
    if (saved.length > 1 && canAsk(ctx)) kept = await pickVariations(ctx, saved.map(v => v.variation), n, set);
  } else {
    printJson({ variation_set: set, n, credits_charged: sumCharged(outcomes), variations, files: files.map(f => ({ path: f.path, variation: f.variation })) }, prettyJson(ctx));
  }
  if (kept) ctx.log(`Kept ${kept.map(v => `v${v}`).join(", ")}.`);
  return ok.length ? EXIT.OK : failureCode(outcomes);
}

export function parsePick(answer: string, available: number[]): number[] | undefined {
  const a = answer.trim().toLowerCase();
  if (!a || a === "all" || a === "a") return available;
  const picked = new Set<number>();
  for (const part of a.split(/[\s,]+/).filter(Boolean)) {
    const range = /^v?(\d+)(?:-v?(\d+))?$/.exec(part);
    if (!range) return undefined;
    const from = Number(range[1]);
    const to = Number(range[2] || range[1]);
    for (let v = Math.min(from, to); v <= Math.max(from, to); v++) if (available.includes(v)) picked.add(v);
  }
  return picked.size ? [...picked].sort((x, y) => x - y) : undefined;
}

async function pickVariations(ctx: Ctx, available: number[], n: number, set: string): Promise<number[]> {
  const answer = await ask(`Keep which? [1-${n}, all] `, "all");
  const keep = parsePick(answer, available) || available;
  const drop = available.filter(v => !keep.includes(v));
  if (drop.length) discardVariations(ctx, set, drop);
  return keep;
}

// Moves the variations not kept to <out>/.discarded and notes it in the log.
export function discardVariations(ctx: Ctx, set: string, variations: number[]) {
  const log = logFile(ctx.project, ctx.outDir);
  const logDir = path.dirname(log);
  const bin = path.join(ctx.outDir, ".discarded");
  fs.mkdirSync(bin, { recursive: true });
  updateAssets(log, entries => {
    for (const e of entries) {
      if (e.variation_set !== set || e.variation === undefined || !variations.includes(e.variation)) continue;
      const from = path.resolve(logDir, e.file);
      if (!fs.existsSync(from)) continue;
      const to = path.join(bin, path.basename(from));
      fs.renameSync(from, to);
      e.file = path.relative(logDir, to);
      e.discarded = true;
    }
    return entries;
  });
  ctx.log(`Moved ${variations.map(v => `v${v}`).join(", ")} to ${path.relative(process.cwd(), bin) || bin}`);
}

// ─── Batch ───────────────────────────────────────────────────────────────────

export async function runBatch(ctx: Ctx, preps: Prepared[], limit: number): Promise<number> {
  const total = totalOf(preps.map(p => p.price));
  const label = `batch of ${preps.length}`;
  if (ctx.globals.dryRun) {
    return dryRun(ctx, label, total, preps.map(p => ({ label: p.label, count: 1, price: p.price })));
  }
  await guard(ctx, total, true);
  ctx.api.requireKey();
  const units: Unit[] = [];
  for (const p of preps) units.push({ prep: p, body: await uploadLocalFiles(ctx, p.command, p.body) });
  ctx.log(`Submitting ${label} (${limit} at a time)`);
  const outcomes = await runUnits(ctx, units, label, limit);
  const ok = outcomes.filter(o => o.status === "succeeded").length;
  const summary = { total: outcomes.length, succeeded: ok, failed: outcomes.length - ok, credits_charged: sumCharged(outcomes) };
  if (ctx.jsonOut) {
    printJson(
      {
        results: outcomes.map(o => ({ index: o.index, command: o.label, status: o.status, job_id: o.job_id, credits_charged: o.credits_charged, files: o.files.map(f => f.path), error: o.error })),
        summary
      },
      prettyJson(ctx)
    );
  } else {
    for (const o of outcomes) {
      process.stdout.write(`${o.status === "succeeded" ? "✓" : "✗"} [${o.index + 1}] ${o.label}${o.error ? `: ${o.error.message}` : ""}\n`);
      for (const f of o.files) process.stdout.write(`    ${f.path}\n`);
    }
    process.stdout.write(`${summary.succeeded} of ${summary.total} succeeded (${formatCredits(summary.credits_charged)})\n`);
  }
  return summary.failed ? failureCode(outcomes) : EXIT.OK;
}
