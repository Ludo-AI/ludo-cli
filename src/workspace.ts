import fs from "node:fs";
import path from "node:path";
import type { Parsed } from "./args.js";
import { absolutizeBody, findAsset, logFile, readAssets } from "./assets.js";
import { budgetLimit, readSpend, resetSpend, spendFile } from "./budget.js";
import { findCommand, type Command } from "./commands.js";
import { CliError, EXIT, specMismatch } from "./errors.js";
import { prepare, printJson, runCommand, type Ctx, type Prepared } from "./generate.js";
import { formatCredits } from "./pricing.js";
import { CONFIG_NAME, containedPath, STATE_DIR } from "./project.js";
import { installSkill } from "./skill.js";

// The project-level commands: `ludo init`, `ludo assets`, `ludo spend`, and
// reading a `ludo batch` file.

const flagValue = (parsed: Parsed, name: string) => parsed.flags.get(name)?.find(v => v !== "\u0000flag");

// ─── ludo init ───────────────────────────────────────────────────────────────

const START = "<!-- ludo:start (managed by `ludo init`; edits inside are replaced) -->";
const END = "<!-- ludo:end -->";

export function agentInstructions(): string {
  return [
    "## Game assets: the ludo CLI",
    "",
    "This project generates game assets (sprites, animations, images, 3D, video, audio) with the",
    "`ludo` CLI. Settings live in `.ludo.json`; every file generated so far is listed in",
    "`ludo-assets.json`.",
    "",
    "- Run `ludo agent-help` once, and `ludo <group> <command> --help` before using a command.",
    "- Check `ludo assets` before generating: the asset may already exist. `ludo assets redo <file>`",
    "  remakes one with changed flags.",
    "- Every generation costs credits. Check the price with `--dry-run`, cap it with `--max-credits`, and",
    "  stop and ask the user when the spending budget is reached (exit code 11).",
    "- `--n 4` makes four variations; look at them, keep the best, delete the rest.",
    "- Several assets at once: write a jobs file and run `ludo batch jobs.json`.",
    "- Never ask the user to paste an API key; ask them to run `ludo login` themselves.",
    "- Hit a limitation or a bug? `ludo feedback \"...\" --category limitation`."
  ].join("\n");
}

// Replaces the managed section in `text`, or appends it.
export function upsertSection(text: string, section: string): string {
  const block = `${START}\n${section}\n${END}`;
  const start = text.indexOf(START);
  const end = text.indexOf(END);
  if (start >= 0 && end > start) return text.slice(0, start) + block + text.slice(end + END.length);
  return (text.trim() ? text.replace(/\s*$/, "\n\n") : "") + block + "\n";
}

function writeIfChanged(file: string, content: string): "created" | "updated" | "unchanged" {
  const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined;
  if (before === content) return "unchanged";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return before === undefined ? "created" : "updated";
}

export async function init(ctx: Ctx, parsed: Parsed): Promise<number> {
  if (ctx.globals.help) {
    process.stdout.write(
      [
        "Usage: ludo init [--force]",
        "",
        "Sets this folder up as a ludo project:",
        `  ${CONFIG_NAME}      project settings: output folder, engine, spending budget, per-command defaults`,
        "  AGENTS.md       a section telling coding agents how to use ludo here (Codex, Cursor, others)",
        "  .cursor/rules   the same, as a Cursor rule, when .cursor exists",
        "  .claude/skills  the Ludo skill for Claude Code, when the project uses Claude Code",
        `  .gitignore      ignores ${STATE_DIR}/ (the local spend tally)`,
        "",
        `Re-running updates the agent instructions; --force also overwrites ${CONFIG_NAME}.`,
        ""
      ].join("\n")
    );
    return EXIT.OK;
  }
  const root = process.cwd();
  const actions: { file: string; action: string }[] = [];
  const note = (file: string, action: string) => actions.push({ file: path.relative(root, file) || file, action });

  const configPath = path.join(root, CONFIG_NAME);
  if (fs.existsSync(configPath) && !ctx.globals.force) {
    note(configPath, "kept (pass --force to overwrite)");
  } else {
    const config: Record<string, unknown> = { out: "assets/ludo", defaults: {} };
    // A Godot project gets SpriteFrames next to every spritesheet.
    if (fs.existsSync(path.join(root, "project.godot"))) config.engine = "godot";
    note(configPath, writeIfChanged(configPath, JSON.stringify(config, null, 2) + "\n"));
  }

  const agentsPath = path.join(root, "AGENTS.md");
  const agents = fs.existsSync(agentsPath) ? fs.readFileSync(agentsPath, "utf8") : "";
  note(agentsPath, writeIfChanged(agentsPath, upsertSection(agents, agentInstructions())));

  if (fs.existsSync(path.join(root, ".cursor"))) {
    const rule = path.join(root, ".cursor", "rules", "ludo.mdc");
    const content = `---\ndescription: Generating game assets with the ludo CLI\nalwaysApply: false\n---\n\n${agentInstructions()}\n`;
    note(rule, writeIfChanged(rule, content));
  }

  if (fs.existsSync(path.join(root, ".claude")) || fs.existsSync(path.join(root, "CLAUDE.md"))) {
    try {
      const r = installSkill({ project: true, force: false });
      note(r.path, r.action);
    } catch (err) {
      note(path.join(root, ".claude", "skills", "ludo", "SKILL.md"), `skipped: ${(err as CliError).message}`);
    }
  }

  const gitignore = path.join(root, ".gitignore");
  if (fs.existsSync(gitignore) || fs.existsSync(path.join(root, ".git"))) {
    const text = fs.existsSync(gitignore) ? fs.readFileSync(gitignore, "utf8") : "";
    if (!text.split(/\r?\n/).some(l => l.trim() === `${STATE_DIR}/` || l.trim() === STATE_DIR)) {
      note(gitignore, writeIfChanged(gitignore, `${text}${text && !text.endsWith("\n") ? "\n" : ""}${STATE_DIR}/\n`));
    }
  }

  if (ctx.jsonOut) printJson({ root, actions }, false);
  else {
    for (const a of actions) process.stdout.write(`  ${a.action.padEnd(9)} ${a.file}\n`);
    if (!actions.some(a => a.file.includes(".claude"))) process.stdout.write("Using Claude Code here? Run: ludo skill install --project\n");
    process.stdout.write(`Edit ${CONFIG_NAME} to set the output folder, budget and defaults (see README).\n`);
  }
  return EXIT.OK;
}

// ─── ludo assets ─────────────────────────────────────────────────────────────

export async function assets(ctx: Ctx, parsed: Parsed, words: string[], commands: Command[]): Promise<number> {
  const sub = words[0];
  const log = logFile(ctx.project, ctx.outDir);
  const logDir = path.dirname(log);
  if (ctx.globals.help || (sub && sub !== "redo" && sub !== "list")) {
    process.stdout.write(
      [
        "Usage: ludo assets [list]",
        "       ludo assets redo <file> [flags]",
        "",
        `Every file a generation saves is recorded in ${path.relative(process.cwd(), log) || log}: the command,`,
        "its flags, the job and what it cost. `list` shows them (JSON for agents). `redo` runs the",
        "request that made <file> again; flags override the recorded ones, and --n makes variations.",
        ""
      ].join("\n")
    );
    return ctx.globals.help ? EXIT.OK : EXIT.USAGE;
  }
  const entries = readAssets(log);
  if (sub === "redo") {
    const file = words[1];
    if (!file) throw new CliError("Usage: ludo assets redo <file> [flags]", EXIT.USAGE);
    const entry = findAsset(entries, file, logDir);
    if (!entry) throw new CliError(`${file} is not in the asset log (${log})`, EXIT.USAGE, "`ludo assets` lists what it knows.");
    if (entry.redo === false) {
      throw new CliError(`${file} can't be replayed: it was saved by \`ludo jobs wait\`, which does not know the request that made it`, EXIT.USAGE);
    }
    const { command } = findCommand(commands, [entry.operation_id]);
    if (!command) throw specMismatch(`The API no longer has ${entry.operation_id}, which made ${file}`);
    const fileFields = command.fields.filter(f => f.isFile && f.in === "body").map(f => f.name);
    // The log may come from a cloned repository: its paths stay inside the project.
    const recorded = absolutizeBody(entry.body || {}, fileFields, logDir, ctx.project?.root || logDir);
    return runCommand(ctx, command, parsed, words.slice(2), [{ values: recorded, source: `the asset log entry for ${file}` }]);
  }
  const list = entries.map(e => ({ ...e, exists: fs.existsSync(path.resolve(logDir, e.file)) }));
  if (ctx.jsonOut) printJson({ log, assets: list }, false);
  else if (!list.length) process.stdout.write(`No assets recorded yet (${path.relative(process.cwd(), log) || log}).\n`);
  else {
    for (const e of list) {
      const credits = typeof e.credits === "number" ? formatCredits(e.credits) : "";
      const v = e.variation !== undefined ? ` v${e.variation}` : "";
      process.stdout.write(`${e.created_at.slice(0, 10)}  ${(e.command + v).padEnd(26)} ${credits.padEnd(12)} ${e.file}${e.exists ? "" : "  (missing)"}${e.discarded ? "  (discarded)" : ""}\n`);
    }
  }
  return EXIT.OK;
}

// ─── ludo spend ──────────────────────────────────────────────────────────────

export async function spend(ctx: Ctx, words: string[]): Promise<number> {
  const sub = words[0];
  if (ctx.globals.help || (sub && sub !== "reset")) {
    process.stdout.write(
      [
        "Usage: ludo spend [reset]",
        "",
        "Shows what the CLI has spent against the spending budget (LUDO_MAX_CREDITS, or max_credits",
        `in ${CONFIG_NAME}), per project. \`reset\` starts a new tally.`,
        ""
      ].join("\n")
    );
    return ctx.globals.help ? EXIT.OK : EXIT.USAGE;
  }
  const s = sub === "reset" ? resetSpend(ctx.project) : readSpend(ctx.project);
  const { limit, source } = budgetLimit(ctx.project);
  const out = { ...s, limit: limit ?? null, limit_source: source ?? null, remaining: limit === undefined ? null : Math.max(0, Math.round((limit - s.spent) * 100) / 100), file: spendFile(ctx.project) };
  if (ctx.jsonOut) printJson(out, false);
  else {
    process.stdout.write(`${sub === "reset" ? "Reset. " : ""}Spent ${formatCredits(s.spent)} in ${s.jobs} job${s.jobs === 1 ? "" : "s"} since ${s.since.slice(0, 10)}\n`);
    process.stdout.write(limit === undefined ? "No budget set (LUDO_MAX_CREDITS or max_credits in .ludo.json).\n" : `Budget: ${formatCredits(limit)} (${source}), ${formatCredits(out.remaining!)} left\n`);
  }
  return EXIT.OK;
}

// ─── ludo batch ──────────────────────────────────────────────────────────────

export const BATCH_HELP = [
  "Usage: ludo batch <jobs.json> [--concurrency <n>] [--dry-run] [--max-credits <n>]",
  "",
  "Runs a list of generations side by side and saves every result. jobs.json holds an array:",
  "",
  '  [',
  '    { "command": "sprite animate", "initial_image": "knight.png", "motion_prompt": "walk cycle" },',
  '    { "command": "createSoundEffect", "prompt": "sword swing" }',
  '  ]',
  "",
  "`command` is \"<group> <command>\" or the API id; the other keys are the command's fields",
  "(snake_case or kebab-case). File paths are relative to jobs.json. .ludo.json defaults apply.",
  "The spending guard checks the total before anything runs; a failed item does not stop the",
  "others. --concurrency sets how many run at once (default 4, at most 50).",
  ""
].join("\n");

export function loadBatch(ctx: Ctx, parsed: Parsed, file: string, commands: Command[]): { preps: Prepared[]; limit: number } {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new CliError(`Could not read ${file}: ${(err as Error).message}`, EXIT.USAGE);
  }
  const items = Array.isArray(raw) ? raw : (raw as any)?.jobs;
  if (!Array.isArray(items) || !items.length) throw new CliError(`${file} must hold a non-empty JSON array of jobs`, EXIT.USAGE, BATCH_HELP);
  const concurrency = flagValue(parsed, "--concurrency");
  const limit = concurrency === undefined ? 4 : Number(concurrency);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new CliError("--concurrency must be a whole number from 1 to 50", EXIT.USAGE);
  for (const name of parsed.flags.keys()) if (name !== "--concurrency") throw new CliError(`Unknown flag ${name} for \`ludo batch\``, EXIT.USAGE, BATCH_HELP);

  const baseDir = path.dirname(path.resolve(file));
  const root = ctx.project?.root || baseDir;
  const empty: Parsed = { globals: { ...parsed.globals, input: undefined }, words: [], flags: new Map() };
  const preps = items.map((item: any, i: number) => {
    const where = `${file} item ${i + 1}`;
    if (!item || typeof item !== "object" || typeof item.command !== "string") throw new CliError(`${where}: needs a "command"`, EXIT.USAGE, BATCH_HELP);
    const { command: name, ...fields } = item;
    const { command } = findCommand(commands, name.trim().split(/\s+/));
    if (!command) throw specMismatch(`${where}: unknown command "${name}"`);
    if (!command.isJob) throw new CliError(`${where}: \`${name}\` is not a generation`, EXIT.USAGE);
    const fileFields = command.fields.filter(f => f.isFile && f.in === "body").map(f => f.name.replace(/_/g, "-"));
    // File paths are relative to the jobs file, and (since a jobs file can
    // come with a cloned repository) must stay inside the project, or the
    // jobs file's folder outside one. Checked before anything is uploaded.
    for (const key of Object.keys(fields)) {
      const snake = key.replace(/-/g, "_");
      if (!fileFields.includes(snake.replace(/_/g, "-"))) continue;
      const fix = (v: unknown) => (typeof v === "string" ? containedPath(root, baseDir, v, `${where}, field ${snake}`) : v);
      fields[key] = Array.isArray(fields[key]) ? fields[key].map(fix) : fix(fields[key]);
    }
    return prepare(ctx, command, empty, [], [{ values: fields, source: where }]);
  });
  return { preps, limit };
}
