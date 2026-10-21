#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { Api, uploadFile } from "./api.js";
import { parseArgv, Parsed } from "./args.js";
import { buildCommands, findCommand, groupsOf } from "./commands.js";
import { readConfig, resolveApiKey, resolveApiUrl, VERSION, writeConfig } from "./config.js";
import { armCrashReports, reportCrash } from "./crash.js";
import { exitNow, handleSignals, onExit } from "./shutdown.js";
import { armTelemetry, sendTelemetry } from "./telemetry.js";
import { CliError, EXIT, localFsError, specMismatch } from "./errors.js";
import { makeCtx, printJson, runBatch, runCommand, runJobWait, type Ctx } from "./generate.js";
import { agentHelp, BUILTIN_HELP, commandHelp, groupHelp, mainHelp } from "./help.js";
import { flushNotes, latestVersion } from "./notices.js";
import { loadProject } from "./project.js";
import { embeddedSpecPath, loadSpec } from "./spec.js";
import { parseGrid, previewFile, previewSkipped } from "./tty/preview.js";
import { logo } from "./tty/flair.js";
import { installSkill, isInstalled, skillTarget, uninstallSkill } from "./skill.js";
import { accountLine, accountSummary, agentName, billingUrlFor, browserLogin, canOpenBrowser, isAgent, openBrowser } from "./login.js";
import { assets, BATCH_HELP, init, loadBatch, spend } from "./workspace.js";
import { toolbox } from "./toolbox/index.js";

async function promptSecret(question: string): Promise<string> {
  if (!process.stdin.isTTY) return fs.readFileSync(0, "utf8").trim();
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  const answer = await new Promise<string>(resolve => rl.question(question, resolve));
  rl.close();
  return answer.trim();
}

function flagSet(parsed: Parsed, name: string): boolean {
  return parsed.flags.has(name);
}

async function fetchAccount(apiUrl: string, key: string): Promise<any | undefined> {
  const res = await new Api(apiUrl, key).request("GET", "/assets/account", { timeoutMs: 10_000 });
  return res.status === 200 ? res.body : undefined;
}

// `ludo login` opens the browser login. `ludo login --with-key` (key from the
// prompt or stdin), `ludo login <key>` and `--api-key <key>` save a key
// instead, for CI and machines without a browser.
async function login(ctx: Ctx, parsed: Parsed, words: string[]): Promise<number> {
  const apiUrl = resolveApiUrl(parsed.globals.apiUrl);
  let key = parsed.globals.apiKey || words[0];
  const pasted = !!key || flagSet(parsed, "--with-key");
  if (!key && flagSet(parsed, "--with-key")) {
    const given = parsed.flags.get("--with-key")?.find(v => v !== "\u0000flag");
    key = given || (await promptSecret("Ludo API key: "));
    if (!key) throw new CliError("No key given", EXIT.USAGE);
  }

  if (key) {
    const res = await new Api(apiUrl, key).request("GET", "/auth/validate-api-key");
    if (res.status === 402) throw new CliError("That key is valid, but your plan has no API access", EXIT.CREDITS, `Change plan at ${billingUrlFor(apiUrl)}`);
    if (res.status < 200 || res.status >= 300) throw new CliError("That API key was rejected", EXIT.AUTH);
  } else {
    // Progress goes to stderr even with --quiet: the person needs the URL.
    const log = (msg: string) => process.stderr.write(msg + "\n");
    const noBrowser = flagSet(parsed, "--no-browser");
    ({ key } = await browserLogin(apiUrl, { log, openBrowser: !noBrowser && canOpenBrowser() }));
  }

  const config = { ...readConfig(), api_key: key, ...(parsed.globals.apiUrl ? { api_url: parsed.globals.apiUrl } : {}) };
  if (pasted) delete config.key_source;
  else config.key_source = "login";
  const file = writeConfig(config);
  const account = await fetchAccount(apiUrl, key!).catch(() => undefined);
  ctx.log(`Saved to ${file}`);
  if (process.env.LUDO_API_KEY && process.env.LUDO_API_KEY !== key) {
    process.stderr.write("Note: LUDO_API_KEY is set in your environment and takes precedence over this login. Unset it to use the login.\n");
  }
  if (ctx.jsonOut) printJson({ ok: true, config: file, account }, false);
  else {
    process.stdout.write(account ? `✓ Player 1 ready: ${accountLine(account)}\n` : "✓ Logged in\n");
    // Claude Code users get a pointer to the skill if they don't have it yet.
    const claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
    if (fs.existsSync(claudeHome) && !isInstalled()) process.stderr.write("Using Claude Code? Teach it the CLI: ludo skill install\n");
  }
  return EXIT.OK;
}

// Forgets the saved key, and revokes it on the server when `ludo login`
// created it (a key pasted with --with-key is the account's own; leave it).
async function logout(ctx: Ctx): Promise<number> {
  const config = readConfig();
  const key = config.api_key;
  let revoked = false;
  if (key && config.key_source === "login") {
    const res = await new Api(resolveApiUrl(ctx.globals.apiUrl), key).request("DELETE", "/assets/cli-key", { timeoutMs: 10_000 }).catch(() => undefined);
    revoked = !!res && res.status >= 200 && res.status < 300;
  }
  delete config.api_key;
  delete config.key_source;
  writeConfig(config);
  if (ctx.jsonOut) printJson({ ok: true, revoked }, false);
  else process.stdout.write(`Logged out${revoked ? " (this CLI login was revoked)" : ""}\n`);
  if (process.env.LUDO_API_KEY) ctx.log("Note: LUDO_API_KEY is still set in your environment.");
  return EXIT.OK;
}

// `ludo skill install|uninstall|path [--project] [--force]`
async function skill(ctx: Ctx, parsed: Parsed, words: string[]): Promise<number> {
  const sub = words[0];
  const project = parsed.flags.has("--project");
  const force = ctx.globals.force;
  if (!sub || ctx.globals.help || !["install", "uninstall", "path"].includes(sub)) {
    process.stdout.write(
      [
        "Usage: ludo skill install|uninstall|path [--project] [--force]",
        "",
        "Installs the Ludo skill for Claude Code, so your agent knows how to generate game assets",
        "with this CLI. Personal by default (~/.claude/skills/ludo); --project installs it into this",
        "project's .claude/skills instead, to share with your team through the repository.",
        "Other agents: point them at `ludo agent-help`.",
        ""
      ].join("\n")
    );
    return sub && !ctx.globals.help ? EXIT.USAGE : EXIT.OK;
  }
  if (sub === "path") {
    process.stdout.write(`${skillTarget(project)}\n`);
    return EXIT.OK;
  }
  const result = sub === "install" ? installSkill({ project, force }) : uninstallSkill({ project, force });
  if (ctx.jsonOut) printJson(result, false);
  else {
    const messages: Record<string, string> = {
      installed: `✓ Installed the Ludo skill: ${result.path}\nStart a new Claude Code session to pick it up.`,
      updated: `✓ Updated the Ludo skill: ${result.path}`,
      unchanged: `The Ludo skill is already up to date: ${result.path}`,
      removed: `Removed the Ludo skill: ${result.path}`,
      absent: `The Ludo skill is not installed at ${result.path}`
    };
    process.stdout.write(messages[result.action] + "\n");
  }
  return EXIT.OK;
}

// `ludo preview <file> [--grid 8x4] [--fps 12] [--frames N]`: shows a PNG in
// the terminal and plays it when it is a spritesheet (Ludo sheets carry their
// grid; others take --grid).
async function preview(ctx: Ctx, parsed: Parsed, words: string[]): Promise<number> {
  const file = words[0];
  const flag = (name: string) => parsed.flags.get(name)?.find(v => v !== "\u0000flag");
  if (!file || ctx.globals.help) {
    process.stdout.write("Usage: ludo preview <file.png> [--grid <cols>x<rows>] [--fps <n>] [--frames <n>]\n\nDraws a PNG in the terminal. Spritesheets saved by ludo play automatically;\nfor other sheets pass --grid (and --fps, default 10).\n");
    return ctx.globals.help ? EXIT.OK : EXIT.USAGE;
  }
  if (!fs.existsSync(file)) throw new CliError(`file not found: ${file}`, EXIT.USAGE);
  if (!ctx.vis.enabled) {
    throw new CliError("ludo preview draws in an interactive terminal", EXIT.USAGE, "It is off with --json, --plain, NO_COLOR, LUDO_PREVIEW=0, in pipes and for coding agents.");
  }
  let grid;
  const gridFlag = flag("--grid");
  if (gridFlag) {
    const g = parseGrid(gridFlag);
    if (!g) throw new CliError(`--grid expects <cols>x<rows>, e.g. 8x4 (got "${gridFlag}")`, EXIT.USAGE);
    const frames = Number(flag("--frames")) || g.cols * g.rows;
    grid = { ...g, frames, fps: Number(flag("--fps")) || 10 };
  }
  const outcome = await previewFile(file, ctx.vis, grid);
  if (outcome === "unsupported") {
    process.stderr.write(`${previewSkipped().replace("add --open", "open the file")}\n`);
    return EXIT.OK;
  }
  if (outcome !== "shown") {
    throw new CliError(
      `Could not preview ${file}`,
      EXIT.USAGE,
      process.platform === "darwin" ? "Previews read PNG, WebP and JPEG images." : "Previews read PNG; for WebP or JPEG install dwebp (libwebp), ImageMagick or ffmpeg."
    );
  }
  return EXIT.OK;
}

// Opens the web app's billing page: buy credits, change plan or auto top-up.
async function billing(ctx: Ctx): Promise<number> {
  const apiUrl = resolveApiUrl(ctx.globals.apiUrl);
  const key = resolveApiKey(ctx.globals.apiKey);
  const account = key ? await fetchAccount(apiUrl, key).catch(() => undefined) : undefined;
  const url = account?.billing_url || billingUrlFor(apiUrl);
  const opened = !ctx.jsonOut && canOpenBrowser() && openBrowser(url);
  if (ctx.jsonOut) printJson({ billing_url: url, account }, false);
  else {
    if (account) process.stdout.write(accountSummary(account) + "\n");
    process.stdout.write(opened ? `Opened ${url}\n` : `Billing: ${url}\n`);
  }
  return EXIT.OK;
}

// `ludo update`: runs the npm install for a person at a terminal; anyone else
// (an agent, a script) gets the command, since replacing a global install can
// need sudo and should not happen in the middle of someone else's task.
async function update(ctx: Ctx): Promise<number> {
  const command = "npm install -g @ludoai/cli@latest";
  const human = process.stdin.isTTY && process.stdout.isTTY && !isAgent() && !process.env.CI && !ctx.globals.json;
  if (!human) {
    const latest = latestVersion();
    if (ctx.jsonOut) printJson({ version: VERSION, latest: latest || null, command }, false);
    else process.stdout.write(`Update with: ${command}\n(Commands follow the API automatically; updates are only needed for CLI fixes.)\n`);
    return EXIT.OK;
  }
  process.stderr.write(`Running: ${command}\n`);
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const res = spawnSync(npm, ["install", "-g", "@ludoai/cli@latest"], { stdio: "inherit", shell: process.platform === "win32" });
  if (res.status === 0) return EXIT.OK;
  throw new CliError(`The update failed${res.error ? `: ${res.error.message}` : ""}`, EXIT.ERROR, `Run it yourself: ${command} (it may need sudo)`);
}

const FEEDBACK_CATEGORIES = ["limitation", "bug", "feature_request", "praise", "other"];
const FEEDBACK_HELP = [
  "Usage: ludo feedback <message> [--category <c>] [--operation <id>] [--job <id>]...",
  "       echo <message> | ludo feedback - [...]",
  "",
  "Sends feedback to the Ludo team: a limitation you hit, a bug, something you'd like",
  "Ludo to support, or something that worked well. Free.",
  "",
  `  --category   ${FEEDBACK_CATEGORIES.join(", ")} (default: other)`,
  "  --operation  the command or operation it is about, e.g. animateSprite",
  "  --job        a job id it is about; repeat it for each job involved (up to 10)",
  ""
].join("\n");

async function feedback(ctx: Ctx, parsed: Parsed, words: string[]): Promise<number> {
  const flag = (name: string) => {
    const v = parsed.flags.get(name)?.at(-1);
    return v === undefined || v === "\u0000flag" ? undefined : v;
  };
  // The message is the remaining positionals, or stdin for `-` (only then:
  // an agent's shell can leave stdin open and silent, and reading it would hang).
  let message = words.join(" ").trim();
  if (message === "-") message = fs.readFileSync(0, "utf8").trim();
  if (ctx.globals.help || !message) {
    process.stdout.write(FEEDBACK_HELP);
    return ctx.globals.help ? EXIT.OK : EXIT.USAGE;
  }
  const category = (flag("--category") || "other").toLowerCase().replace(/-/g, "_");
  if (!FEEDBACK_CATEGORIES.includes(category)) {
    throw new CliError(`--category must be one of: ${FEEDBACK_CATEGORIES.join(", ")}`, EXIT.USAGE);
  }
  if (message.length > 4000) throw new CliError(`Feedback is limited to 4000 characters (got ${message.length})`, EXIT.USAGE);
  if (!resolveApiKey(ctx.globals.apiKey)) {
    throw new CliError(
      "Sending feedback needs a Ludo account.",
      EXIT.AUTH,
      "Run `ludo login` (it can create an account), or open an issue at https://github.com/Ludo-AI/ludo-cli/issues"
    );
  }
  const body: Record<string, string | string[]> = { category, message };
  const operation = flag("--operation");
  const jobs = [...new Set((parsed.flags.get("--job") || [])
    .filter(v => v !== "\u0000flag")
    .flatMap(v => v.split(","))
    .map(v => v.trim())
    .filter(Boolean))];
  if (jobs.length > 10) throw new CliError(`--job takes at most 10 job ids (got ${jobs.length})`, EXIT.USAGE);
  const agent = agentName();
  if (operation) body.operation = operation.slice(0, 100);
  // job_id alone for one job, so a single-job report also works on an API
  // from before job_ids.
  if (jobs.length) body.job_id = jobs[0].slice(0, 64);
  if (jobs.length > 1) body.job_ids = jobs.map(j => j.slice(0, 64));
  if (agent) body.agent = agent;
  const res = await ctx.api.call("POST", "/assets/feedback", { body });
  if (ctx.jsonOut) printJson(res.body, false);
  else process.stdout.write(`✓ Feedback sent. Thank you! (${res.body?.id || "received"})\n`);
  return EXIT.OK;
}

// What is running, for crash reports: a command name, never its arguments.
let commandLabel: string | undefined;

// The spec the current run was built from, for the stale-spec retry below.
let specInUse: { apiUrl: string; source: string } | undefined;

// A cached spec can be up to an hour behind the API. When a command, flag or
// value is rejected locally and that spec came from the cache, refetch it and,
// if the server has a newer one, run the command again against it. These
// errors are all raised before anything is uploaded or submitted.
async function run(argv: string[]): Promise<number> {
  try {
    return await main(argv);
  } catch (err) {
    if (!(err instanceof CliError && err.specMismatch && specInUse?.source === "cache")) throw err;
    const fresh = await loadSpec(specInUse.apiUrl, { forceRefresh: true });
    if (fresh.source !== "server") throw err;
    return main(argv);
  }
}

async function main(argv: string[]): Promise<number> {
  const parsed = parseArgv(argv);
  const { globals, words } = parsed;
  const ctx = makeCtx(globals);
  const [first, second] = words;
  if (["version", "login", "logout", "billing", "update", "spec", "help", "agent-help", "preview", "skill", "feedback", "init", "assets", "spend", "batch"].includes(first)) commandLabel = first;

  if (globals.help && BUILTIN_HELP[first]) {
    process.stdout.write(BUILTIN_HELP[first]);
    return EXIT.OK;
  }
  if (first === "version" || argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`${VERSION}\n`);
    return EXIT.OK;
  }
  if (first === "login") return login(ctx, parsed, words.slice(1));
  if (first === "logout") return logout(ctx);
  if (first === "billing") return billing(ctx);
  if (first === "feedback") return feedback(ctx, parsed, words.slice(1));
  if (first === "update") return update(ctx);
  if (first === "init") return init(ctx, parsed);
  // Free and offline: dispatched before the API spec is loaded.
  if (first === "toolbox") return toolbox(ctx, parsed, argv, label => (commandLabel = label));

  const apiUrl = resolveApiUrl(globals.apiUrl);
  if (first === "spec") {
    const loaded = await loadSpec(apiUrl, { forceRefresh: second === "refresh" });
    if (second === "path") process.stdout.write(`${loaded.location}\n`);
    else process.stdout.write(`API ${loaded.spec.info?.version} spec from ${loaded.source}: ${loaded.location}\nEmbedded fallback: ${embeddedSpecPath()}\n`);
    return EXIT.OK;
  }

  const loaded = await loadSpec(apiUrl);
  specInUse = { apiUrl, source: loaded.source };
  const { spec } = loaded;
  const commands = buildCommands(spec);

  if (!first || first === "help") {
    commandLabel = "help";
    const target = first === "help" ? words.slice(1) : [];
    if (target.length) return main([...target, "--help"]);
    if (!first && ctx.vis.enabled) process.stderr.write(logo(ctx.vis) + "\n\n");
    process.stdout.write(mainHelp(commands) + "\n");
    return first || globals.help ? EXIT.OK : EXIT.USAGE;
  }
  if (first === "agent-help") {
    process.stdout.write(agentHelp(commands));
    return EXIT.OK;
  }

  if (first === "skill") {
    commandLabel = "skill";
    return skill(ctx, parsed, words.slice(1));
  }
  if (first === "preview") {
    commandLabel = "preview";
    return preview(ctx, parsed, words.slice(1));
  }

  // Everything below works inside a project: .ludo.json settings, budget and
  // asset log.
  const pctx = makeCtx(globals, loadProject());
  if (first === "spend") return spend(pctx, words.slice(1));
  if (first === "assets") return assets(pctx, parsed, words.slice(1), commands);
  if (first === "batch") {
    if (globals.help || !words[1]) {
      process.stdout.write(BATCH_HELP);
      return globals.help ? EXIT.OK : EXIT.USAGE;
    }
    if (globals.n !== undefined) throw new CliError("--n does not apply to a batch; list each job instead", EXIT.USAGE);
    if (globals.name) throw new CliError("--name does not apply to a batch; give each job its own \"name\"", EXIT.USAGE);
    if (!globals.wait) throw new CliError("ludo batch waits for its jobs; drop --no-wait", EXIT.USAGE);
    const { preps, limit } = loadBatch(pctx, parsed, words[1], commands);
    return runBatch(pctx, preps, limit);
  }

  // Built-ins living inside API groups.
  if (first === "files" && second === "upload") {
    commandLabel = "files upload";
    if (globals.help || words.length < 3) {
      process.stdout.write("Usage: ludo files upload <path>...\n\nUploads local files and prints their public URLs (deleted after 7 days).\nYou rarely need this: file flags upload local paths for you.\n");
      return globals.help ? EXIT.OK : EXIT.USAGE;
    }
    ctx.api.requireKey();
    const results = [];
    for (const file of words.slice(2)) results.push({ path: file, url: await uploadFile(ctx.api, file, "", ctx.log, { reuse: false }) });
    if (ctx.jsonOut) printJson(results, false);
    else results.forEach(r => process.stdout.write(`${r.url}\n`));
    return EXIT.OK;
  }
  if (first === "jobs" && second === "wait") {
    commandLabel = "jobs wait";
    if (globals.help || !words[2]) {
      process.stdout.write("Usage: ludo jobs wait <id> [--out <dir>] [--timeout <s>] [--no-download]\n\nWaits for a job to finish, then saves its result files like a generation command does.\n");
      return globals.help ? EXIT.OK : EXIT.USAGE;
    }
    return runJobWait(pctx, words[2], `job ${words[2]}`);
  }

  const groups = groupsOf(commands);
  let { command, consumed } = findCommand(commands, words);
  // A group with a single command runs it by name alone: `ludo account`.
  if (!command && groups.includes(first) && !second) {
    const only = commands.filter(c => c.group === first && !c.hidden);
    if (only.length === 1) ({ command, consumed } = { command: only[0], consumed: 1 });
  }
  if (!command) {
    if (groups.includes(first) && (!second || globals.help)) {
      process.stdout.write(groupHelp(commands, first) + "\n");
      return second || globals.help ? EXIT.OK : EXIT.USAGE;
    }
    if (groups.includes(first)) {
      throw specMismatch(`Unknown command: ludo ${first} ${second}`, `Commands: ${commands.filter(c => c.group === first && !c.hidden).map(c => c.name).join(", ")}`);
    }
    throw specMismatch(`Unknown command: ${first}`, `Groups: ${groups.join(", ")}. Run \`ludo --help\`.`);
  }
  commandLabel = `${command.group} ${command.name}`;
  if (globals.help) {
    process.stdout.write(commandHelp(command) + "\n");
    return EXIT.OK;
  }
  return runCommand(pctx, command, parsed, words.slice(consumed));
}

// Out of credits (or no API access) at a terminal: offer to open the billing
// page. Never for an agent or a script: they get the hint and exit code 5.
async function offerBilling() {
  if (!canOpenBrowser()) return;
  let apiUrl: string;
  try {
    apiUrl = resolveApiUrl(parseArgv(process.argv.slice(2)).globals.apiUrl);
  } catch {
    apiUrl = resolveApiUrl(undefined);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  // Never hang: no answer in 20 seconds counts as no.
  const answer = await new Promise<string>(resolve => {
    const timer = setTimeout(() => resolve("n"), 20_000);
    rl.question("Open the billing page? [Y/n] ", a => {
      clearTimeout(timer);
      resolve(a);
    });
  });
  rl.close();
  if (/^(y|yes|)$/i.test(answer.trim())) openBrowser(billingUrlFor(apiUrl));
}

const quietRun = process.argv.includes("--quiet");
const startedAt = Date.now();
const argvForTelemetry = process.argv.slice(2);

armCrashReports();
armTelemetry();
// Interrupted (Ctrl-C, or an agent stopping a long command): still report it.
onExit(code => sendTelemetry(commandLabel, code, startedAt, argvForTelemetry));
handleSignals();

// Ends the run with this code WITHOUT process.exit(): on Windows, exiting while
// fetch's connection pool is still closing trips a libuv assertion
// (UV_HANDLE_CLOSING, nodejs/node#58091) and turns every exit code into a
// crash (0xC0000409). Node exits by itself once the pool has closed; the
// unref'd timer only fires if something unexpected keeps the process alive.
function finish(code: number) {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 3000).unref();
}

run(process.argv.slice(2)).then(
  async code => {
    flushNotes(quietRun);
    await sendTelemetry(commandLabel, code, startedAt, argvForTelemetry);
    finish(code);
  },
  async (err: unknown) => {
    err = localFsError(err) || err;
    const json = process.argv.includes("--json") || !process.stdout.isTTY;
    flushNotes(quietRun);
    if (err instanceof CliError) {
      if (json) printJson({ error: { message: err.message, exit_code: err.exitCode, hint: err.hint, details: err.details } }, false);
      process.stderr.write(`Error: ${err.message}\n${err.hint ? `${err.hint}\n` : ""}`);
      if (err.exitCode === EXIT.CREDITS && !json) await offerBilling();
      await sendTelemetry(commandLabel, err.exitCode, startedAt, argvForTelemetry);
      return finish(err.exitCode);
    }
    // Anything else is a bug in the CLI.
    process.stderr.write(`Error: ${(err as Error)?.stack || err}\n`);
    const eventId = await reportCrash(err, commandLabel);
    if (eventId) process.stderr.write(`This looks like a bug in ludo; a crash report was sent (${eventId}). Set LUDO_TELEMETRY=0 to stop sending them.\n`);
    await sendTelemetry(commandLabel, EXIT.ERROR, startedAt, argvForTelemetry);
    finish(EXIT.ERROR);
  }
);
