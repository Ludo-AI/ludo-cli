#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { Api, uploadFile } from "./api.js";
import { Globals, parseArgv, Parsed, resolveFlags } from "./args.js";
import { buildCommands, Command, findCommand, groupsOf } from "./commands.js";
import { readConfig, resolveApiKey, resolveApiUrl, VERSION, writeConfig } from "./config.js";
import { CliError, EXIT } from "./errors.js";
import { agentHelp, commandHelp, groupHelp, mainHelp } from "./help.js";
import { collectUrls, downloadAll, extractInlineFiles, waitForJob } from "./jobs.js";
import { embeddedSpecPath, loadSpec } from "./spec.js";

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

async function login(ctx: Ctx, parsed: Parsed, words: string[]): Promise<number> {
  const key = parsed.globals.apiKey || words[0] || (await promptSecret("Ludo API key (from https://app.ludo.ai): "));
  if (!key) throw new CliError("No key given", EXIT.USAGE);
  const api = new Api(resolveApiUrl(parsed.globals.apiUrl), key);
  const res = await api.request("GET", "/auth/validate-api-key");
  if (res.status !== 200) throw new CliError("That API key was rejected", EXIT.AUTH);
  const file = writeConfig({ ...readConfig(), api_key: key, ...(parsed.globals.apiUrl ? { api_url: parsed.globals.apiUrl } : {}) });
  ctx.log(`Saved to ${file}`);
  if (ctx.jsonOut) printJson({ ok: true, config: file }, false);
  else process.stdout.write("✓ Logged in\n");
  return EXIT.OK;
}

async function main(argv: string[]): Promise<number> {
  const parsed = parseArgv(argv);
  const { globals, words } = parsed;
  const ctx = makeCtx(globals);
  const [first, second] = words;

  if (first === "version" || argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`${VERSION}\n`);
    return EXIT.OK;
  }
  if (first === "login") return login(ctx, parsed, words.slice(1));
  if (first === "logout") {
    const config = readConfig();
    delete config.api_key;
    writeConfig(config);
    process.stdout.write("Logged out\n");
    return EXIT.OK;
  }
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

  const { spec } = await loadSpec(apiUrl);
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
    if (globals.help || !words[2]) {
      process.stdout.write("Usage: ludo jobs wait <id> [--out <dir>] [--timeout <s>] [--no-download]\n\nWaits for a job to finish, then saves its result files like a generation command does.\n");
      return globals.help ? EXIT.OK : EXIT.USAGE;
    }
    return runJobWait(ctx, words[2], `job ${words[2]}`);
  }

  const groups = groupsOf(commands);
  const { command, consumed } = findCommand(commands, words);
  if (!command) {
    if (groups.includes(first) && (!second || globals.help)) {
      process.stdout.write(groupHelp(commands, first) + "\n");
      return second || globals.help ? EXIT.OK : EXIT.USAGE;
    }
    if (groups.includes(first)) {
      throw new CliError(`Unknown command: ludo ${first} ${second}`, EXIT.USAGE, `Commands: ${commands.filter(c => c.group === first && !c.hidden).map(c => c.name).join(", ")}`);
    }
    throw new CliError(`Unknown command: ${first}`, EXIT.USAGE, `Groups: ${groups.join(", ")}. Run \`ludo --help\`.`);
  }
  if (globals.help) {
    process.stdout.write(commandHelp(command) + "\n");
    return EXIT.OK;
  }
  return runCommand(ctx, command, parsed, words.slice(consumed));
}

main(process.argv.slice(2)).then(
  code => process.exit(code),
  (err: unknown) => {
    const json = process.argv.includes("--json") || !process.stdout.isTTY;
    if (err instanceof CliError) {
      if (json) printJson({ error: { message: err.message, exit_code: err.exitCode, hint: err.hint, details: err.details } }, false);
      process.stderr.write(`Error: ${err.message}\n${err.hint ? `${err.hint}\n` : ""}`);
      process.exit(err.exitCode);
    }
    process.stderr.write(`Error: ${(err as Error)?.stack || err}\n`);
    process.exit(EXIT.ERROR);
  }
);
