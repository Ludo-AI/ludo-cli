import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { configDir, launchedAsCli, resolveApiKey, resolveApiUrl, VERSION } from "./config.js";
import { agentName } from "./login.js";
import { findProjectFile } from "./project.js";

// Usage telemetry: one event per command, sent to Ludo when the command ends
// (POST /api/cli/events). It says which command ran and how it went: the exit
// code, how long it took, the NAMES of the flags used, the CLI, Node and OS
// versions, which coding agent ran it, and the job ids and credits of any
// generations. Never flag values, prompts, file paths or file contents.
//
// Events carry a random install id (kept in the config dir, separate from the
// login so `ludo logout` keeps it) and the API key when there is one, so usage
// can be tied to an account. Opt out with LUDO_TELEMETRY=0 or DO_NOT_TRACK=1,
// the same switches as crash reports.
//
// Events wait in a queue file in the config dir and go out together, at most
// every FLUSH_EVERY_MS: a script running ludo on hundreds of files sends a
// few requests instead of one per file (which the server's rate limit would
// drop), and most runs then make no request at all. An event the server did
// not get goes back in the queue; ones over a week old are dropped, as the
// server would no longer date them.
//
// A send that times out may still have been stored, so each event carries a
// random id and the server stores an id once. The timeout leaves room for a
// fresh TLS connection from far away (a second was not enough from Asia, and
// every event went again on each run) while keeping what a hung API costs an
// offline toolbox command small, and one run sends at most MAX_BATCHES
// requests, leaving the rest queued for the next.

const SEND_TIMEOUT_MS = 2000;
const FLUSH_EVERY_MS = 10_000;
const FLUSH_AT = 20; // queued events that send at once
const BATCH = 20; // events per request (the server's maxItems)
const MAX_BATCHES = 2; // requests per run
const MAX_QUEUED = 400;
const MAX_AGE_S = 7 * 24 * 3600;
const QUEUE = "telemetry-queue.jsonl";
const SENT = "telemetry-sent"; // its mtime: the last send

// Only the `ludo` command sends anything: cli.ts calls armTelemetry() at
// startup. Code that merely imports these files (package scanners call every
// exported function with junk arguments) must not report usage.
let armed = false;
export function armTelemetry() {
  armed = launchedAsCli();
}

export function telemetryEnabled(env = process.env): boolean {
  const on = (v?: string) => !!v && !["", "0", "false"].includes(v.toLowerCase());
  if (on(env.DO_NOT_TRACK)) return false;
  return !["0", "false", "off", "no"].includes((env.LUDO_TELEMETRY || "").toLowerCase());
}

function installFile(): string {
  return path.join(configDir(), "install_id");
}

// Created on first use and never changed. undefined when it cannot be stored,
// in which case nothing is sent: an id that changes every run is noise.
export function installId(): string | undefined {
  const file = installFile();
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (/^[A-Za-z0-9_-]{8,64}$/.test(existing)) return existing;
  } catch {
    // Not created yet.
  }
  try {
    const id = crypto.randomBytes(16).toString("base64url");
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, id + "\n", { mode: 0o600 });
    return id;
  } catch {
    return undefined;
  }
}

// Filled in while the command runs.
const jobs: { id: string; credits?: number }[] = [];
// Called at submission (no charge known yet) and again when the job ends.
export function noteJob(id: unknown, credits?: unknown) {
  if (typeof id !== "string") return;
  const charged = typeof credits === "number" ? credits : undefined;
  const known = jobs.find(j => j.id === id);
  if (known) {
    if (charged !== undefined) known.credits = charged;
  } else {
    jobs.push({ id, credits: charged });
  }
}

// Facts a command learns while it runs, beyond its flags: what the toolbox
// read (counts and formats, never names), which engine files it wrote, which
// "Next:" line it showed, how many gaps `asset manifest` found and of which
// kinds, and whether the installed skill was brought up to date.
const facts: Record<string, string | number | boolean> = {};
export function noteFact(key: "engine" | "grid_from" | "hint" | "gap_kinds", value: string): void;
export function noteFact(key: "frames" | "gaps", value: number): void;
export function noteFact(key: "skill_refreshed", value: boolean): void;
export function noteFact(key: string, value: string | number | boolean) {
  facts[key] = value;
}

// One input file read: its format, and whether Ludo made it (its grid stamp).
export function noteInput(format: string, ludoSheet: boolean) {
  facts.inputs = Number(facts.inputs ?? 0) + 1;
  if (facts.input_format === undefined) facts.input_format = format.toLowerCase().slice(0, 16);
  facts.ludo_sheet = facts.ludo_sheet === true || ludoSheet;
}

// The command a "Next:" hint suggests, as the words after `ludo`: "sprite
// animate", "preview".
export const hintId = (command: string) => /^ludo((?: [a-z][a-z0-9-]*){1,3})/.exec(command)?.[1].trim();

// Flag names from argv, never their values: "--prompt=knight" and
// "--prompt knight" both become "--prompt".
export function flagNames(argv: string[]): string[] {
  const names = argv.filter(a => /^--[a-z0-9]/i.test(a)).map(a => a.split("=")[0].toLowerCase());
  return [...new Set(names)].slice(0, 40);
}

function argvValue(argv: string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name) return argv[i + 1];
    if (argv[i].startsWith(name + "=")) return argv[i].slice(name.length + 1);
  }
  return undefined;
}

export function buildEvent(command: string, exitCode: number, durationMs: number, argv: string[]) {
  const flags = flagNames(argv);
  const nValue = Number(argvValue(argv, "--n"));
  const props: Record<string, unknown> = {
    exit_code: exitCode,
    duration_ms: Math.max(0, Math.round(durationMs)),
    flags,
    dry_run: flags.includes("--dry-run"),
    json: flags.includes("--json") || !process.stdout.isTTY,
    quiet: flags.includes("--quiet"),
    tty: !!process.stdout.isTTY && !!process.stderr.isTTY,
    // A CI machine starts with a fresh config dir, so a new install id, on
    // every run: counted apart, it doesn't pass for a new user each time.
    ci: !!process.env.CI && !["0", "false"].includes(process.env.CI.toLowerCase()),
    project: !!safe(() => findProjectFile()),
    logged_in: !!safe(() => resolveApiKey(argvValue(argv, "--api-key"))),
    version: VERSION,
    os: process.platform,
    arch: process.arch,
    node: process.versions.node
  };
  if (Number.isInteger(nValue) && nValue > 0) props.n = nValue;
  for (const [k, v] of Object.entries(facts)) if (!(k === "hint" && props.quiet)) props[k] = v;
  const agent = agentName();
  if (agent) props.agent = agent.slice(0, 64);
  if (jobs.length) {
    props.job_ids = jobs.map(j => j.id).slice(0, 20);
    const credits = jobs.reduce((sum, j) => sum + (j.credits || 0), 0);
    props.credits = Math.round(credits * 100) / 100;
  }
  return { command, id: crypto.randomBytes(12).toString("base64url"), at: Math.floor(Date.now() / 1000), props };
}

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

interface Queued {
  command: string;
  id?: string; // missing on events queued by 0.2.0
  at: number;
  props: Record<string, unknown>;
}

function readQueue(file: string): Queued[] {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const oldest = Math.floor(Date.now() / 1000) - MAX_AGE_S;
  const out: Queued[] = [];
  for (const line of text.split("\n")) {
    try {
      const e = JSON.parse(line);
      if (e && typeof e.command === "string" && Number.isInteger(e.at) && e.at > oldest) out.push(e);
    } catch {
      // A torn or empty line.
    }
  }
  return out.slice(-MAX_QUEUED);
}

function appendQueue(dir: string, events: Queued[]) {
  if (!events.length) return;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // One write per call, under 4 KB per event: lines from processes running
  // side by side do not interleave.
  fs.appendFileSync(path.join(dir, QUEUE), events.map(e => JSON.stringify(e) + "\n").join(""), { mode: 0o600 });
}

// Takes the queue for this process to send: renamed first, so two processes
// never send the same events. Also picks up what a process that died while
// sending left behind.
function takeQueue(dir: string): Queued[] {
  const mine = path.join(dir, `${QUEUE}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.sending`);
  const out: Queued[] = [];
  try {
    fs.renameSync(path.join(dir, QUEUE), mine);
    out.push(...readQueue(mine));
    fs.rmSync(mine, { force: true });
  } catch {
    // Another process took it, or there is none.
  }
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(`${QUEUE}.`) || !name.endsWith(".sending")) continue;
      const file = path.join(dir, name);
      if (Date.now() - fs.statSync(file).mtimeMs < 60_000) continue;
      out.push(...readQueue(file));
      fs.rmSync(file, { force: true });
    }
  } catch {
    // Nothing left behind.
  }
  return out.slice(-MAX_QUEUED);
}

function sentAgo(dir: string): number {
  try {
    return Date.now() - fs.statSync(path.join(dir, SENT)).mtimeMs;
  } catch {
    return Infinity;
  }
}

// Queues the command's event and sends the queue when it is due. Never
// throws, never changes the exit code, and gives up after SEND_TIMEOUT_MS.
export async function sendTelemetry(command: string | undefined, exitCode: number, startedAt: number, argv: string[]): Promise<void> {
  if (!armed || !telemetryEnabled()) return;
  try {
    const id = installId();
    if (!id) return;
    const event = buildEvent(command || "unknown", exitCode, Date.now() - startedAt, argv);
    const dir = configDir();
    let events: Queued[];
    try {
      appendQueue(dir, [event]);
      // A login sends at once: it is what ties this install's earlier
      // events to the account.
      const due = command === "login" || sentAgo(dir) >= FLUSH_EVERY_MS || readQueue(path.join(dir, QUEUE)).length >= FLUSH_AT;
      if (!due) return;
      events = takeQueue(dir);
      fs.writeFileSync(path.join(dir, SENT), "");
    } catch {
      events = [event]; // No queue here: send this one alone.
    }
    if (!events.length) return;
    const later = events.slice(MAX_BATCHES * BATCH);
    events = events.slice(0, MAX_BATCHES * BATCH);
    safe(() => appendQueue(dir, later));
    const key = safe(() => resolveApiKey(argvValue(argv, "--api-key")));
    const apiUrl = safe(() => resolveApiUrl(argvValue(argv, "--api-url"))) || "https://api.ludo.ai";
    const batches: Queued[][] = [];
    for (let i = 0; i < events.length; i += BATCH) batches.push(events.slice(i, i + BATCH));
    const failed = await Promise.all(
      batches.map(async batch => {
        try {
          const res = await fetch(`${apiUrl}/api/cli/events`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "User-Agent": `ludo-cli/${VERSION}`,
              "x-ludo-tool": "cli",
              "x-ludo-cli-version": VERSION,
              ...(key ? { Authorization: `ApiKey ${key}` } : {})
            },
            body: JSON.stringify({ install_id: id, events: batch }),
            signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
          });
          // A request the server turned down as malformed would be turned
          // down again; anything else is tried again later.
          return res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429) ? [] : batch;
        } catch {
          return batch;
        }
      })
    );
    safe(() => appendQueue(dir, failed.flat()));
  } catch {
    // Telemetry is best-effort.
  }
}
