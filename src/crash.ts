import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { launchedAsCli, PACKAGE_ROOT, resolveApiKey, VERSION } from "./config.js";

// Crash reports for bugs in the CLI itself: an unexpected exception, never an
// API error, a failed job or a usage mistake. They go straight to Sentry's
// envelope endpoint with fetch, so the CLI keeps zero runtime dependencies.
//
// A report holds the error type, a scrubbed message and stack, the CLI, Node
// and OS versions and the command name (`sprite animate`). Never flag values,
// prompts, the API key or paths outside the package.
//
// The DSN is public by design: it can only submit events to the ludo-cli
// project, and its client key is rate limited in Sentry. Users opt out with
// LUDO_TELEMETRY=0 or DO_NOT_TRACK=1.

const SENTRY_DSN = "https://f8eb96eda46baa2600e54d7c71cf4b3f@o505219.ingest.us.sentry.io/4512147055116288";
const SEND_TIMEOUT_MS = 2000;

// Only the `ludo` command reports crashes: cli.ts calls armCrashReports() at
// startup. A package scanner importing this file and calling reportCrash with
// junk must not file reports (it did, minutes after 0.1.0 was published, and
// again after 0.1.1: it calls armCrashReports too, or imports cli.js).
let armed = false;
export function armCrashReports() {
  armed = launchedAsCli();
}

// A key given with --api-key never reaches config or env, so read it here.
function argvApiKey(): string | undefined {
  const argv = process.argv;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--api-key") return argv[i + 1];
    if (argv[i].startsWith("--api-key=")) return argv[i].slice("--api-key=".length);
  }
  return undefined;
}

export function crashReportingEnabled(): boolean {
  const off = (v?: string) => !!v && !["", "0", "false"].includes(v.toLowerCase());
  if (off(process.env.DO_NOT_TRACK)) return false;
  const flag = (process.env.LUDO_TELEMETRY || "").toLowerCase();
  if (["0", "false", "off", "no"].includes(flag)) return false;
  return !!dsn();
}

function dsn(): string {
  return process.env.LUDO_SENTRY_DSN || SENTRY_DSN;
}

// Everything that could identify the user or their work is cut out: the home
// directory, the API key, and any path that is not part of the CLI's own code.
export function scrub(text: string): string {
  let out = text.split(PACKAGE_ROOT + path.sep).join("");
  const key = resolveApiKey(argvApiKey());
  // Real keys are long; a short value would shred ordinary words.
  if (key && key.length >= 16) out = out.split(key).join("[api-key]");
  // Keys in any other shape: CLI keys, 64-hex keys, Authorization values.
  out = out.replace(/ludo_[A-Za-z0-9_-]{20,}/g, "[api-key]").replace(/\b[0-9a-f]{64}\b/gi, "[api-key]").replace(/ApiKey \S+/g, "ApiKey [api-key]");
  // The operands of any failed file operation ("ENAMETOOLONG: name too long,
  // open 'walk cycle.glb'", a rename's second path too), relative ones included.
  out = out.replace(/\b(E[A-Z]{2,}): ([^'\n]*)'[^'\n]*'(?: -> '[^'\n]*')?/g, (m, code, mid) => `${code}: ${mid}'<path>'${m.includes("' -> '") ? " -> '<path>'" : ""}`);
  const home = os.homedir();
  if (home) out = out.split(home).join("~");
  // JSON.parse quotes the text it choked on, which may be a response or a user's file.
  out = out.replace(/"(?:[^"\\]|\\.)*" is not valid JSON/g, '"<text>" is not valid JSON');
  // Query strings can carry tokens (an upload session, a signed URL).
  out = out.replace(/(https?:\/\/[^\s?'"]+)\?[^\s'"]*/g, "$1?<query>");
  // Remaining absolute paths (a user's file in an ENOENT, a temp dir).
  return out.replace(/(^|[\s'"(=])(?:~|[A-Za-z]:)?[\\/][^\s'"():]+/g, "$1<path>");
}

interface Frame {
  function?: string;
  filename: string;
  lineno?: number;
  colno?: number;
  in_app: boolean;
}

export function parseStack(stack: string | undefined): Frame[] {
  const frames: Frame[] = [];
  for (const line of (stack || "").split("\n")) {
    const m = line.match(/^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/);
    if (!m) continue;
    const [, fn, rawFile, lineno, colno] = m;
    const file = rawFile.replace(/^file:\/\//, "");
    const ours = file.startsWith(PACKAGE_ROOT + path.sep);
    const internal = file.startsWith("node:");
    frames.push({
      function: fn,
      filename: ours ? path.relative(PACKAGE_ROOT, file) : internal ? file : "<external>",
      lineno: Number(lineno),
      colno: Number(colno),
      in_app: ours
    });
  }
  // Sentry wants the outermost frame first.
  return frames.reverse();
}

export function buildEvent(err: unknown, command: string | undefined) {
  const e = err instanceof Error ? err : new Error(String(err));
  return {
    event_id: crypto.randomUUID().replace(/-/g, ""),
    timestamp: Date.now() / 1000,
    platform: "node",
    level: "error",
    release: `ludo-cli@${VERSION}`,
    environment: "production",
    // No server_name and no user: the report must not identify the machine.
    tags: { command: command || "(none)", node: process.version, os: process.platform },
    contexts: {
      os: { name: process.platform, version: os.release() },
      runtime: { name: "node", version: process.version }
    },
    exception: {
      values: [{ type: e.name || "Error", value: scrub(e.message), stacktrace: { frames: parseStack(e.stack) } }]
    }
  };
}

// Sends the report and resolves with the event id, or undefined when it is
// disabled or could not be sent. Never throws and never waits long.
export async function reportCrash(err: unknown, command: string | undefined): Promise<string | undefined> {
  if (!armed || !crashReportingEnabled()) return undefined;
  try {
    const url = new URL(dsn());
    const key = url.username;
    const projectId = url.pathname.replace(/^\/+|\/+$/g, "");
    const event = buildEvent(err, command);
    const envelope = [
      JSON.stringify({ event_id: event.event_id, sent_at: new Date().toISOString() }),
      JSON.stringify({ type: "event" }),
      JSON.stringify(event)
    ].join("\n");
    const res = await fetch(`${url.protocol}//${url.host}/api/${projectId}/envelope/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-sentry-envelope",
        "X-Sentry-Auth": `Sentry sentry_version=7, sentry_key=${key}, sentry_client=ludo-cli/${VERSION}`
      },
      body: envelope,
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
    });
    return res.ok ? event.event_id : undefined;
  } catch {
    return undefined;
  }
}
