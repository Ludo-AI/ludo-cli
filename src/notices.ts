import fs from "node:fs";
import path from "node:path";
import { configDir, VERSION } from "./config.js";
import { CliError, EXIT } from "./errors.js";

// What the API tells the CLI on every response, besides the answer itself:
//
//   x-ludo-cli-latest  the newest published @ludoai/cli
//   x-ludo-cli-min     the oldest version still served (only when one is set);
//                      below it every request answers 426
//   x-ludo-notice      a service notice: base64url of UTF-8 JSON
//                      { id, level: "info"|"warning"|"critical", message, url? }
//
// Headers are collected while the command runs and printed once, on stderr,
// when it ends, so they never interleave with a spinner or land on stdout.
// The update line shows at most once a day and each notice at most every six
// hours (critical ones every run), remembered in the config dir.

export interface Notice {
  id: string;
  level: "info" | "warning" | "critical";
  message: string;
  url?: string;
}

let latest: string | undefined;
const notices = new Map<string, Notice>();

const UPDATE_EVERY_MS = 24 * 60 * 60 * 1000;
const NOTICE_EVERY_MS = 6 * 60 * 60 * 1000;

// "1.2.3" vs "1.10.0"; a pre-release sorts before its release. Anything that
// is not a version compares as equal, so garbage never triggers a notice.
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(v.trim());
    return m ? { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] } : undefined;
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] < y.nums[i] ? -1 : 1;
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

// Printable text only: a notice must not be able to move the cursor or
// recolour the terminal.
const clean = (text: string, max: number) => text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim().slice(0, max);

export function decodeNotice(header: string): Notice | undefined {
  try {
    const raw = JSON.parse(Buffer.from(header.trim(), "base64url").toString("utf8"));
    if (!raw || typeof raw !== "object" || typeof raw.message !== "string" || !raw.message.trim()) return undefined;
    const level = raw.level === "warning" || raw.level === "critical" ? raw.level : "info";
    const url = typeof raw.url === "string" && /^https?:\/\/\S+$/i.test(raw.url) ? clean(raw.url, 300) : undefined;
    return { id: clean(String(raw.id ?? raw.message), 100), level, message: clean(raw.message, 500), url };
  } catch {
    return undefined;
  }
}

export function observeHeaders(headers: Headers) {
  const l = headers.get("x-ludo-cli-latest");
  if (l && compareVersions(l, "0.0.0") > 0) latest = clean(l, 40);
  const n = headers.get("x-ludo-notice");
  const notice = n ? decodeNotice(n) : undefined;
  if (notice) notices.set(notice.id, notice);
}

// A notice from the CLI itself rather than the API, shown like one.
export function addLocalNotice(id: string, message: string) {
  notices.set(id, { id, level: "info", message });
}

export function upgradeRequired(body: any): CliError {
  const min = typeof body?.min_version === "string" ? clean(body.min_version, 40) : undefined;
  return new CliError(
    `This version of ludo (${VERSION}) is no longer supported${min ? `; ${min} or newer is required` : ""}.`,
    EXIT.UPGRADE_REQUIRED,
    "Update: npm install -g @ludoai/cli@latest (or run `ludo update`)"
  );
}

export function latestVersion(): string | undefined {
  return latest;
}

interface State {
  update_notice_at?: number;
  notices?: Record<string, number>;
}

const stateFile = () => path.join(configDir(), "state.json");

function readState(): State {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), "utf8"));
  } catch {
    return {};
  }
}

function writeState(state: State) {
  try {
    fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(stateFile(), JSON.stringify(state) + "\n");
  } catch {
    // Only costs a repeated notice.
  }
}

// The lines to print now, and the state that remembers them. Pure, for tests.
export function pendingLines(state: State, now: number, quiet: boolean, found = { latest, notices: [...notices.values()] }): { lines: string[]; state: State } {
  const next: State = { ...state, notices: { ...(state.notices || {}) } };
  const lines: string[] = [];
  for (const n of found.notices) {
    const shownAt = next.notices![n.id] || 0;
    if (n.level !== "critical" && (quiet || now - shownAt < NOTICE_EVERY_MS)) continue;
    lines.push(`${n.level === "info" ? "ℹ" : "⚠"} Ludo: ${n.message}${n.url ? ` ${n.url}` : ""}`);
    next.notices![n.id] = now;
  }
  // Forget notices nobody has sent for a week.
  for (const [id, at] of Object.entries(next.notices!)) if (now - at > 7 * UPDATE_EVERY_MS) delete next.notices![id];
  if (!quiet && found.latest && compareVersions(found.latest, VERSION) > 0 && now - (state.update_notice_at || 0) >= UPDATE_EVERY_MS) {
    lines.push(`Update available: ludo ${VERSION} → ${found.latest}. Run \`ludo update\` (npm install -g @ludoai/cli@latest).`);
    next.update_notice_at = now;
  }
  return { lines, state: next };
}

export function flushNotes(quiet: boolean) {
  if (!latest && !notices.size) return;
  const { lines, state } = pendingLines(readState(), Date.now(), quiet);
  latest = undefined;
  notices.clear();
  if (!lines.length) return;
  process.stderr.write(lines.join("\n") + "\n");
  writeState(state);
}
