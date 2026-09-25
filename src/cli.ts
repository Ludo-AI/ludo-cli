#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { Api, uploadFile } from "./api.js";
import { Globals, parseArgv, Parsed, resolveFlags } from "./args.js";
import { buildCommands, Command, findCommand, groupsOf } from "./commands.js";
import { readConfig, resolveApiKey, resolveApiUrl, VERSION, writeConfig } from "./config.js";
import { reportCrash } from "./crash.js";
import { CliError, EXIT, specMismatch } from "./errors.js";
import { agentHelp, commandHelp, groupHelp, mainHelp } from "./help.js";
import { collectUrls, downloadAll, extractInlineFiles, waitForJob } from "./jobs.js";
import { embeddedSpecPath, loadSpec } from "./spec.js";
import { accountLine, accountSummary, billingUrlFor, browserLogin, canOpenBrowser, CLI_KEY_PREFIX, openBrowser } from "./login.js";

const DEFAULT_OUT = "ludo-output";
const DEFAULT_TIMEOUT_S = 30 * 60;

interface Ctx {
  globals: Globals;
  api: Api;
  jsonOut: boolean;
  log: (msg: string) => void;
}

function makeCtx(globals: Globals): Ctx {
  const jsonOut = globals.json || !process.stdout.isTTY;
  const log = (msg: string) => {
    if (!globals.quiet) process.stderr.write(msg + "\n");
  };
  return { globals, api: new Api(resolveApiUrl(globals.apiUrl), resolveApiKey(globals.apiKey)), jsonOut, log };
}

function printJson(value: unknown, pretty: boolean) {
  process.stdout.write(JSON.stringify(value, null, pretty ? 2 : 0) + "\n");
}

function isLocalPathish(value: string): boolean {
  return !/^(https?:|data:)/i.test(value);
}

// Local files in file-accepting fields are uploaded and replaced by their URL.
// `@path` forces a file even where the value would otherwise be ambiguous.
async function uploadLocalFiles(ctx: Ctx, command: Command, body: Record<string, unknown>) {
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
}

function expandPath(template: string, params: Record<string, string>): string {
  return template.replace(/\{([^}]+)\}/g, (_, name) => encodeURIComponent(params[name] ?? ""));
}

async function finishJob(ctx: Ctx, job: any, label: string): Promise<number> {
  const { globals } = ctx;
  const record: any = {
    job_id: job.id,
    status: job.status,
    task_type: job.task_type,
    credits_charged: job.credits_charged,
    result: job.result,
    error: job.error
  };
  if (job.status === "succeeded") {
    const dir = path.resolve(globals.out || DEFAULT_OUT);
    const prefix = `${job.task_type || label}-${String(job.id).slice(0, 8)}`;
    const inline = extractInlineFiles(job.result, globals.download ? { dir, prefix } : null, ctx.log);
    record.result = inline.result;
    const urls = collectUrls(record.result);
    const downloaded = globals.download && urls.length ? await downloadAll(urls, dir, prefix, ctx.log) : [];
    const rel = (p: string) => path.relative(process.cwd(), p) || p;
    record.files = [...downloaded, ...inline.files].map(f => ({ ...f, path: rel(f.path) }));
    // Inline files were replaced by their absolute path; show it relative too.
    for (const f of inline.files) record.result = replaceString(record.result, f.path, rel(f.path));
  }
  if (ctx.jsonOut) {
    printJson(record, !!ctx.globals.json && process.stdout.isTTY);
  } else {
    if (job.status === "succeeded") {
      process.stdout.write(`✓ ${label} succeeded${job.credits_charged ? ` (${job.credits_charged} credits)` : ""}\n`);
      for (const f of record.files || []) process.stdout.write(`  ${f.path}\n`);
      if (!record.files?.length) printJson(job.result, true);
    } else {
      process.stdout.write(`✗ ${label} ${job.status}${job.error?.message ? `: ${job.error.message}` : ""}\n`);
    }
  }
  if (job.status === "failed") return EXIT.JOB_FAILED;
  if (job.status === "canceled") return EXIT.JOB_CANCELED;
  return EXIT.OK;
}

function replaceString(value: unknown, from: string, to: string): unknown {
  if (value === from) return to;
  if (Array.isArray(value)) return value.map(v => replaceString(v, from, to));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replaceString(v, from, to)]));
  return value;
}

function progressReporter(ctx: Ctx, label: string) {
  let last = "";
  return (job: any, elapsed: number) => {
    const line = `${label}: ${job.status} (${Math.round(elapsed)}s)`;
    if (line !== last && !ctx.globals.quiet) {
      process.stderr.write(line + "\n");
      last = line;
    }
  };
}

async function runJobWait(ctx: Ctx, id: string, label: string): Promise<number> {
  ctx.api.requireKey();
  const stopHint = () => {
    process.stderr.write(`\nStopped waiting. The job keeps running; resume with: ludo jobs wait ${id}\n`);
    process.exit(EXIT.INTERRUPTED);
  };
  process.once("SIGINT", stopHint);
  try {
    const job = await waitForJob(ctx.api, id, {
      timeoutS: ctx.globals.timeout || DEFAULT_TIMEOUT_S,
      progress: progressReporter(ctx, label)
    });
    return await finishJob(ctx, job, label);
  } finally {
    process.removeListener("SIGINT", stopHint);
  }
}

async function runCommand(ctx: Ctx, command: Command, parsed: Parsed, positionals: string[]): Promise<number> {
  const resolved = resolveFlags(command, parsed, positionals);
  if (resolved.extraWords.length) {
    throw new CliError(`Unexpected argument: ${resolved.extraWords[0]}`, EXIT.USAGE, `Run \`ludo ${command.group} ${command.name} --help\`.`);
  }
  ctx.api.requireKey();
  await uploadLocalFiles(ctx, command, resolved.body);

  const hasBody = command.method !== "GET" && command.method !== "DELETE";
  const body = hasBody ? { ...resolved.body, ...(command.isJob ? { async: true } : {}) } : undefined;
  const label = `${command.group} ${command.name}`;
  if (command.isJob) ctx.log(`Submitting ${label}`);
  const { body: response } = await ctx.api.call(command.method, expandPath(command.path, resolved.path), {
    query: resolved.query,
    body
  });

  if (command.isJob && response && response.id && response.status) {
    if (!ctx.globals.wait) {
      printJson(response, !ctx.jsonOut || !!ctx.globals.json);
      return EXIT.OK;
    }
    if (["succeeded", "failed", "canceled"].includes(response.status)) return finishJob(ctx, response, label);
    return runJobWait(ctx, response.id, label);
  }
  if (command.operationId === "getAccount" && !ctx.jsonOut) {
    process.stdout.write(accountSummary(response) + "\n");
    return EXIT.OK;
  }
  // Some operations answer 200 with no body (validate-api-key).
  printJson(response === null || response === "" ? { ok: true } : response, !ctx.jsonOut || (!!ctx.globals.json && process.stdout.isTTY));
  return EXIT.OK;
}

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

  const file = writeConfig({ ...readConfig(), api_key: key, ...(parsed.globals.apiUrl ? { api_url: parsed.globals.apiUrl } : {}) });
  const account = await fetchAccount(apiUrl, key!).catch(() => undefined);
  ctx.log(`Saved to ${file}`);
  if (process.env.LUDO_API_KEY && process.env.LUDO_API_KEY !== key) {
    process.stderr.write("Note: LUDO_API_KEY is set in your environment and takes precedence over this login. Unset it to use the login.\n");
  }
  if (ctx.jsonOut) printJson({ ok: true, config: file, account }, false);
  else process.stdout.write(`✓ Logged in${account ? `: ${accountLine(account)}` : ""}\n`);
  return EXIT.OK;
}

// Forgets the saved key, and revokes it on the server when `ludo login`
// created it (a key pasted with --with-key is the account's own; leave it).
async function logout(ctx: Ctx): Promise<number> {
  const config = readConfig();
  const key = config.api_key;
  let revoked = false;
  if (key && key.startsWith(CLI_KEY_PREFIX)) {
    const res = await new Api(resolveApiUrl(ctx.globals.apiUrl), key).request("DELETE", "/assets/cli-key", { timeoutMs: 10_000 }).catch(() => undefined);
    revoked = !!res && res.status >= 200 && res.status < 300;
  }
  delete config.api_key;
  writeConfig(config);
  if (ctx.jsonOut) printJson({ ok: true, revoked }, false);
  else process.stdout.write(`Logged out${revoked ? " (this CLI login was revoked)" : ""}\n`);
  if (process.env.LUDO_API_KEY) ctx.log("Note: LUDO_API_KEY is still set in your environment.");
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
  if (["version", "login", "logout", "billing", "update", "spec", "help", "agent-help"].includes(first)) commandLabel = first;

  if (first === "version" || argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`${VERSION}\n`);
    return EXIT.OK;
  }
  if (first === "login") return login(ctx, parsed, words.slice(1));
  if (first === "logout") return logout(ctx);
  if (first === "billing") return billing(ctx);
  if (first === "update") {
    process.stdout.write("Update with: npm install -g @ludoai/cli@latest\n(Commands follow the API automatically; updates are only needed for CLI fixes.)\n");
    return EXIT.OK;
  }

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
    const target = first === "help" ? words.slice(1) : [];
    if (target.length) return main([...target, "--help"]);
    process.stdout.write(mainHelp(commands) + "\n");
    return first || globals.help ? EXIT.OK : EXIT.USAGE;
  }
  if (first === "agent-help") {
    process.stdout.write(agentHelp(commands));
    return EXIT.OK;
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
    for (const file of words.slice(2)) results.push({ path: file, url: await uploadFile(ctx.api, file, "", ctx.log) });
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
    return runJobWait(ctx, words[2], `job ${words[2]}`);
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
  return runCommand(ctx, command, parsed, words.slice(consumed));
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

run(process.argv.slice(2)).then(
  code => process.exit(code),
  async (err: unknown) => {
    const json = process.argv.includes("--json") || !process.stdout.isTTY;
    if (err instanceof CliError) {
      if (json) printJson({ error: { message: err.message, exit_code: err.exitCode, hint: err.hint, details: err.details } }, false);
      process.stderr.write(`Error: ${err.message}\n${err.hint ? `${err.hint}\n` : ""}`);
      if (err.exitCode === EXIT.CREDITS && !json) await offerBilling();
      process.exit(err.exitCode);
    }
    // Anything else is a bug in the CLI.
    process.stderr.write(`Error: ${(err as Error)?.stack || err}\n`);
    const eventId = await reportCrash(err, commandLabel);
    if (eventId) process.stderr.write(`This looks like a bug in ludo; a crash report was sent (${eventId}). Set LUDO_TELEMETRY=0 to stop sending them.\n`);
    process.exit(EXIT.ERROR);
  }
);
