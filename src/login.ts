import { spawn } from "node:child_process";
import { Api } from "./api.js";
import { VERSION } from "./config.js";
import { CliError, EXIT } from "./errors.js";

// Browser login (`ludo login`), and the account and billing views around it.
//
// The login is a device authorization grant: the API hands out a secret
// device_code (polled here) and a short user_code the person checks in the
// browser. Approving there mints a CLI key of their own, so the account's
// main API key is never shown or rotated. Someone without an account signs up
// on the same page, and is offered a plan if theirs has no API access.

// The web app for an API URL: api.ludo.ai -> app.ludo.ai, api-dev -> app-dev.
export function webUrlFor(apiUrl: string): string {
  try {
    const url = new URL(apiUrl);
    if (/^api(-|\.)/.test(url.hostname)) {
      url.hostname = url.hostname.replace(/^api/, "app");
      return url.origin;
    }
  } catch {
    // Fall through to production.
  }
  return "https://app.ludo.ai";
}

export function billingUrlFor(apiUrl: string): string {
  return `${webUrlFor(apiUrl)}/account/billing`;
}

// Only open a browser for a person at a local terminal: never for an agent,
// a CI job or an SSH session, where it would open on the wrong machine or
// nowhere. They get the URL printed instead.
// Coding agents that drive a pseudo-terminal look interactive; these are the
// variables they set.
const AGENT_ENV = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CODEX_SANDBOX", "CODEX_CI", "CURSOR_AGENT", "GEMINI_CLI", "AIDER_MODEL", "AGENT"];

export function isAgent(): boolean {
  return AGENT_ENV.some(name => !!process.env[name]);
}

// Which agent is driving the CLI, for feedback reports. Undefined for a person.
export function agentName(env = process.env): string | undefined {
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT) return "Claude Code";
  if (env.CODEX_SANDBOX || env.CODEX_CI) return "Codex";
  if (env.CURSOR_AGENT) return "Cursor";
  if (env.GEMINI_CLI) return "Gemini CLI";
  if (env.AIDER_MODEL) return "Aider";
  if (env.AGENT) return env.AGENT.slice(0, 100);
  return undefined;
}

export function canOpenBrowser(): boolean {
  if (process.env.LUDO_NO_BROWSER || process.env.CI || isAgent()) return false;
  if (process.env.TERM === "dumb") return false;
  if (process.env.SSH_CONNECTION || process.env.SSH_TTY) return false;
  if (!process.stdout.isTTY || !process.stdin.isTTY) return false;
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return false;
  return true;
}

export function openBrowser(url: string): boolean {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", '""', url.replace(/&/g, "^&")]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args as string[], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export interface LoginResult {
  key: string;
}

export interface LoginStart {
  device_code: string;
  user_code: string;
  verification_url_complete: string;
  expires_in?: number;
  interval?: number;
}

// Asks the API for a login code. Nothing waits on it yet.
export async function startLogin(apiUrl: string): Promise<LoginStart> {
  const api = new Api(apiUrl, undefined);
  const { body } = await api.call("POST", "/cli/auth/start", {
    body: { platform: process.platform, client_version: VERSION }
  });
  return body;
}

export function showLogin(started: LoginStart, log: (msg: string) => void) {
  log("To log in, open this page and check the code matches:");
  log(`\n  ${started.verification_url_complete}\n\n  Code: ${started.user_code}\n`);
}

// Polls a login code until it is approved (resolves with the key), denied,
// or past its deadline. The person may still be in the browser meanwhile.
export async function waitForLogin(apiUrl: string, deviceCode: string, deadline: number, intervalS?: number): Promise<LoginResult> {
  const api = new Api(apiUrl, undefined);
  const baseInterval = Math.max(0.01, intervalS || 3) * 1000;
  let interval = baseInterval;
  let rateLimited = 0;
  let unreachable = 0;
  // At least one poll, even on a deadline that has just passed.
  do {
    await sleep(interval);
    let res;
    try {
      res = await api.request("POST", "/cli/auth/token", { body: { device_code: deviceCode } });
    } catch (err) {
      // Wi-Fi handoff, sleep, DNS blip: the person is still in the browser,
      // and the key waits for us until the code expires.
      if (++unreachable >= 20) throw err;
      interval = Math.min(interval * 2, 15_000);
      continue;
    }
    unreachable = 0;
    if (res.status === 429) {
      // Backing off until the code expires would end in a misleading "expired".
      if (++rateLimited >= 3) {
        throw new CliError("Too many login attempts from this network", EXIT.RATE_LIMITED, "Wait a few minutes, then run `ludo login` again.");
      }
      interval = Math.min(interval * 2, 15_000);
      continue;
    }
    rateLimited = 0;
    interval = baseInterval;
    // A blip while the person is still in the browser is not worth failing on.
    if (res.status >= 500 || typeof res.body !== "object" || !res.body) continue;
    if (res.status >= 400) throw new CliError(res.body.message || `Login failed (HTTP ${res.status})`, EXIT.ERROR);
    const { status, api_key } = res.body;
    if (status === "approved" && api_key) return { key: api_key };
    if (status === "denied") throw new CliError("The login was denied in the browser", EXIT.AUTH);
    if (status === "expired") break;
  } while (Date.now() < deadline);
  // About a fifth of logins ended here in Nov 2026, many of them run by an
  // agent whose user never saw the link while the command waited.
  throw new CliError(
    "The login code expired before it was approved",
    EXIT.TIMEOUT,
    isAgent()
      ? "Run `ludo login --no-wait`: it prints the link and returns. Give the link to the user, and once they approve it, run `ludo login --continue`."
      : "Run `ludo login` again."
  );
}

// Runs the browser login and resolves with the new CLI key.
export async function browserLogin(apiUrl: string, opts: { log: (msg: string) => void; openBrowser: boolean }): Promise<LoginResult> {
  const started = await startLogin(apiUrl);
  showLogin(started, opts.log);
  if (opts.openBrowser && openBrowser(started.verification_url_complete)) {
    opts.log("Opened it in your browser. Waiting for you to approve…");
  } else {
    opts.log("Waiting for you to approve…");
  }
  opts.log("No Ludo account yet? You can sign up on that page.");
  return waitForLogin(apiUrl, started.device_code, Date.now() + (started.expires_in || 600) * 1000, started.interval);
}

// "1,840.5"
function fmt(n: unknown): string {
  return typeof n === "number" ? n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : "?";
}

function fmtDate(unix: unknown): string | undefined {
  if (typeof unix !== "number" || !unix) return undefined;
  return new Date(unix * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// One line for `ludo login`: "Pro plan, 1,840.5 credits available".
export function accountLine(account: any): string {
  const plan = account?.plan?.name ? `${account.plan.name} plan` : "Your plan";
  return `${plan}, ${fmt(account?.credits?.available)} credits available`;
}

// The human view of GET /assets/account.
export function accountSummary(account: any): string {
  const c = account?.credits || {};
  const lines = [accountLine(account)];
  const parts = [`${fmt(c.plan_credits)} plan`, `${fmt(c.used)} used`];
  if (c.extra) parts.push(`${fmt(c.extra)} extra`);
  lines.push(`  ${parts.join(", ")}${c.team_pool ? " (team pool)" : ""}`);
  const reset = fmtDate(c.resets_at);
  if (reset) lines.push(`  Plan credits refill on ${reset}`);
  if (c.paused) lines.push("  Your subscription is paused");
  const grace = fmtDate(c.grace_until);
  if (grace) lines.push(`  Your subscription ended; credits stay spendable until ${grace}`);
  if (account?.plan && !account.plan.api_access) lines.push("  This plan does not include API access");
  const t = account?.auto_topup;
  if (t) {
    lines.push(
      t.enabled
        ? `Auto top-up: on, buys ${fmt(t.credits)} credits when you drop below ${fmt(t.threshold)}`
        : "Auto top-up: off"
    );
  } else if (c.team_pool) {
    lines.push("Auto top-up: managed by your team owner");
  }
  if (c.team_pool) {
    // The team owner's pool: a member can neither buy credits nor set auto
    // top-up (the top-up endpoints refuse them), so point at the owner.
    lines.push("Credits are bought by your team owner");
  } else if (account?.billing_url) {
    lines.push("Buy credits: `ludo topup --credits <n>`");
    lines.push(`Change plan or auto top-up: ${account.billing_url}`);
  }
  return lines.join("\n");
}
