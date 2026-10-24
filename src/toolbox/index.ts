import { GLOBAL_FLAGS, type Parsed } from "../args.js";
import { CliError, EXIT } from "../errors.js";
import type { Ctx } from "../generate.js";
import { TOOL_GROUPS, TOOLS, type Tool, type ToolCall } from "./registry.js";
import "./sprite.js";
import "./sprite-pack.js";
import "./sprite-sequence.js";
import "./sprite-video.js";
import "./image.js";
import "./tiles.js";

export { TOOLS } from "./registry.js";

// `ludo toolbox <group> <tool>`: free tools that run offline, with no account
// and no API spec. Everything under the one word `toolbox` is free, so these
// names never collide with the paid commands generated from the API spec.
// The image work itself lives in pure functions next to this file; a tool
// here only reads its arguments, calls them and writes files.

const groupsInUse = () => Object.keys(TOOL_GROUPS).filter(g => TOOLS.some(t => t.group === g));

const table = (rows: [string, string][]) => {
  const width = Math.max(0, ...rows.map(r => r[0].length));
  return rows.map(([a, b]) => `  ${a.padEnd(width)}  ${b}`).join("\n");
};

export function toolboxSummary(): string {
  const groups = groupsInUse();
  return groups.length ? groups.map(g => `${g} (${TOOLS.filter(t => t.group === g).map(t => t.name).join(", ")})`).join("; ") : "coming soon";
}

function toolboxHelp(): string {
  const groups = groupsInUse();
  return [
    "Free tools: they run on your machine, offline, with no account and no credits.",
    "",
    "Usage:",
    "  ludo toolbox <group> <tool> [flags]",
    "  ludo toolbox <group> <tool> --help",
    "",
    groups.length
      ? table(groups.map(g => [g, `${TOOL_GROUPS[g]}: ${TOOLS.filter(t => t.group === g).map(t => t.name).join(", ")}`]))
      : "  No tools yet.",
    ""
  ].join("\n");
}

function groupHelp(group: string): string {
  return [
    `ludo toolbox ${group}: ${TOOL_GROUPS[group]} (free, offline)`,
    "",
    table(TOOLS.filter(t => t.group === group).map(t => [`${t.name} ${t.args}`, t.summary])),
    "",
    `Run \`ludo toolbox ${group} <tool> --help\` for its flags.`,
    ""
  ].join("\n");
}

function toolHelp(tool: Tool): string {
  return [
    `Usage: ludo toolbox ${tool.group} ${tool.name} ${tool.args} [flags]`,
    "",
    tool.summary,
    ...(tool.details?.length ? ["", ...tool.details] : []),
    ...(tool.flags.length ? ["", "Flags:", table(tool.flags.map(f => [`${f.flag}${f.value ? ` <${f.value}>` : ""}`, f.description]))] : []),
    "",
    "Also: --out <dir> (default ./ludo-output), --json, --quiet. Free and offline: no login needed.",
    ""
  ].join("\n");
}

// Reads the tool's arguments from the raw argv. The first pass (parseArgv)
// cannot know which flags take a value, so it may have taken a positional as
// a flag's value; scanning again with the tool's own flags keeps the
// positionals in their order, which matters for `join a.png b.png`.
export function parseToolArgv(argv: string[], tool: Tool): ToolCall {
  const known = new Map(tool.flags.map(f => [f.flag, f]));
  const flags = new Map<string, string | true>();
  const lists = new Map<string, string[]>();
  const positionals: string[] = [];
  let onlyPositionals = false;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (onlyPositionals || token === "-" || !token.startsWith("-")) {
      positionals.push(token);
      continue;
    }
    if (token === "--") {
      onlyPositionals = true;
      continue;
    }
    if (token === "-h") continue;
    const eq = token.indexOf("=");
    const name = eq >= 0 ? token.slice(0, eq) : token;
    const global = GLOBAL_FLAGS[name];
    if (global) {
      if (global.value && eq < 0) i++; // its value, already read by parseArgv
      continue;
    }
    const spec = known.get(name);
    if (!spec) {
      const list = tool.flags.map(f => f.flag).join(", ");
      throw new CliError(`Unknown flag for ludo toolbox ${tool.group} ${tool.name}: ${name}`, EXIT.USAGE, list ? `Flags: ${list}` : undefined);
    }
    if (!spec.value) {
      if (eq >= 0) throw new CliError(`${name} does not take a value`, EXIT.USAGE);
      flags.set(name, true);
      continue;
    }
    const value = eq >= 0 ? token.slice(eq + 1) : argv[++i];
    if (value === undefined) throw new CliError(`${name} needs a value`, EXIT.USAGE);
    flags.set(name, value);
    lists.set(name, [...(lists.get(name) ?? []), value]);
  }
  return { args: positionals.slice(3), flags, lists };
}

// `ludo toolbox ...`. parsed.words starts with "toolbox"; argv is the whole
// command line. setLabel names the command for usage telemetry as soon as it
// is known, so a tool that fails is still counted as itself.
export async function toolbox(ctx: Ctx, parsed: Parsed, argv: string[], setLabel: (label: string) => void): Promise<number> {
  const [, group, name] = parsed.words;
  const help = parsed.globals.help;
  setLabel("toolbox");
  if (!group) {
    process.stdout.write(toolboxHelp());
    return help ? EXIT.OK : EXIT.USAGE;
  }
  if (!groupsInUse().includes(group)) {
    throw new CliError(`Unknown toolbox group: ${group}`, EXIT.USAGE, `Groups: ${groupsInUse().join(", ") || "none yet"}. Run \`ludo toolbox\`.`);
  }
  if (!name) {
    process.stdout.write(groupHelp(group));
    return help ? EXIT.OK : EXIT.USAGE;
  }
  const tool = TOOLS.find(t => t.group === group && t.name === name);
  if (!tool) {
    const names = TOOLS.filter(t => t.group === group).map(t => t.name);
    throw new CliError(`Unknown tool: ludo toolbox ${group} ${name}`, EXIT.USAGE, `Tools: ${names.join(", ")}`);
  }
  setLabel(`toolbox ${group} ${name}`);
  if (help) {
    process.stdout.write(toolHelp(tool));
    return EXIT.OK;
  }
  return tool.run(ctx, parseToolArgv(argv, tool));
}
