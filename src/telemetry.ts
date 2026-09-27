import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { configDir, resolveApiKey, resolveApiUrl, VERSION } from "./config.js";
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

const SEND_TIMEOUT_MS = 1000;

// Only the `ludo` command sends anything: cli.ts calls armTelemetry() at
// startup. Code that merely imports these files (package scanners call every
// exported function with junk arguments) must not report usage.
let armed = false;
export function armTelemetry() {
  armed = true;
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
    project: !!safe(() => findProjectFile()),
    logged_in: !!safe(() => resolveApiKey(argvValue(argv, "--api-key"))),
    version: VERSION,
    os: process.platform,
    arch: process.arch,
    node: process.versions.node
  };
  if (Number.isInteger(nValue) && nValue > 0) props.n = nValue;
  const agent = agentName();
  if (agent) props.agent = agent.slice(0, 64);
  if (jobs.length) {
    props.job_ids = jobs.map(j => j.id).slice(0, 20);
    const credits = jobs.reduce((sum, j) => sum + (j.credits || 0), 0);
    props.credits = Math.round(credits * 100) / 100;
  }
  return { command, at: Math.floor(Date.now() / 1000), props };
}

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

// Sends the command's event. Never throws, never changes the exit code, and
// gives up after a second.
export async function sendTelemetry(command: string | undefined, exitCode: number, startedAt: number, argv: string[]): Promise<void> {
  if (!armed || !telemetryEnabled()) return;
  try {
    const id = installId();
    if (!id) return;
    const event = buildEvent(command || "unknown", exitCode, Date.now() - startedAt, argv);
    const key = safe(() => resolveApiKey(argvValue(argv, "--api-key")));
    const apiUrl = safe(() => resolveApiUrl(argvValue(argv, "--api-url"))) || "https://api.ludo.ai";
    await fetch(`${apiUrl}/api/cli/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": `ludo-cli/${VERSION}`,
        "x-ludo-tool": "cli",
        "x-ludo-cli-version": VERSION,
        ...(key ? { Authorization: `ApiKey ${key}` } : {})
      },
      body: JSON.stringify({ install_id: id, events: [event] }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
    });
  } catch {
    // Telemetry is best-effort.
  }
}
