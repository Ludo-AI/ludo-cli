import { GLOBAL_FLAGS } from "./args.js";
import { Command, Field, GROUP_INFO, groupsOf } from "./commands.js";
import { VERSION } from "./config.js";
import { TOOLS, toolboxSummary } from "./toolbox/index.js";

const WIDTH = Math.min(process.stdout.columns || 100, 110);

function wrap(text: string, indent: number, width = WIDTH): string {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if (line && line.length + 1 + w.length > width - indent) {
      lines.push(line);
      line = w;
    } else {
      line = line ? `${line} ${w}` : w;
    }
  }
  if (line) lines.push(line);
  return lines.map(l => " ".repeat(indent) + l).join("\n");
}

function table(rows: [string, string][], indent = 2): string {
  const col = Math.min(Math.max(...rows.map(r => r[0].length), 0) + 2, 34);
  return rows
    .map(([left, right]) => {
      const pad = left.length + 2 > col ? "\n" + " ".repeat(indent + col) : " ".repeat(col - left.length);
      const body = wrap(right, indent + col).trimStart();
      return " ".repeat(indent) + left + pad + body;
    })
    .join("\n");
}

export function mainHelp(commands: Command[]): string {
  const groups = groupsOf(commands);
  const rows: [string, string][] = groups.map(g => {
    const names = commands.filter(c => c.group === g && !c.hidden).map(c => c.name);
    return [g, `${GROUP_INFO[g] || ""}${GROUP_INFO[g] ? ": " : ""}${names.join(", ")}`];
  });
  return [
    `ludo ${VERSION}: generate game assets with Ludo AI from the command line.`,
    "",
    "Usage:",
    "  ludo <group> <command> [flags]",
    "  ludo <group> <command> --help",
    "",
    "Groups:",
    table(rows),
    "",
    ...(TOOLS.length ? ["Free tools (offline, no account):", table([["toolbox", toolboxSummary()]]), ""] : []),
    "Other commands:",
    table([
      ["login", "Log in with your browser (--with-key to paste an API key instead)"],
      ["logout", "Log out and revoke this CLI login"],
      ["billing", "Open the billing page: buy credits, change plan or auto top-up"],
      ["feedback <message>", "Tell the Ludo team about a limitation, bug, idea or win"],
      ["init", "Set this folder up as a project: .ludo.json, agent instructions"],
      ["batch <jobs.json>", "Run a list of generations side by side"],
      ["assets [redo <file>]", "List generated files and how they were made; make one again"],
      ["spend [reset]", "Show what has been spent against the spending budget"],
      ["update", "Update ludo to the newest version"],
      ["preview <file>", "Show an image in the terminal; spritesheets play"],
      ["files upload <path>", "Upload a local file and print its URL"],
      ["jobs wait <id>", "Wait for a job and download its results"],
      ["agent-help", "A short guide for AI agents using this CLI"],
      ["skill install", "Teach Claude Code the CLI (--project for this repo)"],
      ["spec [refresh|path]", "Show or refresh the API spec the commands are built from"],
      ["version", "Print the version"]
    ]),
    "",
    "Examples:",
    "  ludo image create --prompt \"a knight with a red cape\" --image-type sprite",
    "  ludo sprite animate --initial-image knight.png --motion-prompt \"walk cycle\"",
    "  ludo image remove-background --image photo.jpg --out assets/",
    "",
    "Local files passed to image, audio, video or model flags are uploaded for you.",
    "Generations wait for the result and save files to ./ludo-output unless --no-wait."
  ].join("\n");
}

// Usage for the commands that do something straight away. `--help` on them
// prints this and nothing else: `ludo login --help` must not start a login,
// nor `ludo logout --help` revoke the key.
export const BUILTIN_HELP: Record<string, string> = {
  login: [
    "Usage: ludo login [--no-browser]",
    "       ludo login --with-key [<key>]   (or pipe the key on stdin)",
    "",
    "Logs in through the browser: it opens a page where you log in (or create an account) and approve",
    "this CLI, and waits up to 10 minutes. --no-browser prints the page instead of opening it.",
    "--with-key saves an existing API key instead, for CI and machines without a browser.",
    ""
  ].join("\n"),
  logout: ["Usage: ludo logout", "", "Forgets the saved key, and revokes it when `ludo login` created it.", ""].join("\n"),
  billing: ["Usage: ludo billing", "", "Opens the billing page (buy credits, change plan or auto top-up), or prints its URL.", ""].join("\n"),
  update: [
    "Usage: ludo update",
    "",
    "Updates ludo with npm install -g @ludoai/cli@latest. Outside an interactive terminal it prints",
    "the command instead of running it.",
    ""
  ].join("\n"),
  spec: [
    "Usage: ludo spec [refresh|path]",
    "",
    "Shows where the API spec the commands are built from came from. refresh fetches it again;",
    "path prints the cached file's path.",
    ""
  ].join("\n"),
  version: ["Usage: ludo version", "", "Prints the version (also ludo --version).", ""].join("\n")
};

export function groupHelp(commands: Command[], group: string): string {
  const cmds = commands.filter(c => c.group === group && !c.hidden);
  return [
    `ludo ${group}: ${GROUP_INFO[group] || ""}`,
    "",
    "Commands:",
    table(cmds.map(c => [c.name, `${c.summary}${c.credits ? ` (${shortCredits(c.credits)})` : ""}`])),
    "",
    `Run \`ludo ${group} <command> --help\` for its flags.`
  ].join("\n");
}

function shortCredits(text: string): string {
  return text.replace(/^This endpoint consumes\s*/i, "").replace(/\.$/, "");
}

function flagLabel(f: Field): string {
  if (f.in === "path") return `<${f.name}>`;
  if (f.type === "boolean") return f.flag;
  if (f.isFile) return `${f.flag} <file|url>${f.type === "array" ? "..." : ""}`;
  if (f.enum) return `${f.flag} <value>${f.type === "array" ? "..." : ""}`;
  const t = f.type === "array" ? `${f.itemType || "string"}...` : f.type === "object" ? "json" : f.type === "string" ? "text" : f.type;
  return `${f.flag} <${t}>`;
}

function flagDescription(f: Field): string {
  const parts = [f.description || ""];
  if (f.isFile) parts.push("Accepts a local file path (uploaded for you) or a URL.");
  if (f.enum) parts.push(`One of: ${f.enum.join(", ")}.`);
  const hasMin = typeof f.minimum === "number";
  const hasMax = typeof f.maximum === "number";
  if (hasMin && hasMax) parts.push(`Range: ${f.minimum} to ${f.maximum}.`);
  else if (hasMin) parts.push(`Minimum: ${f.minimum}.`);
  else if (hasMax) parts.push(`Maximum: ${f.maximum}.`);
  if (f.default !== undefined && f.default !== null && f.default !== "") parts.push(`Default: ${JSON.stringify(f.default)}.`);
  if (f.type === "array" && !f.isFile) parts.push("Repeat the flag, or pass a JSON array.");
  return parts.filter(Boolean).join(" ");
}

export function commandHelp(c: Command): string {
  const pathArgs = c.fields.filter(f => f.in === "path").map(f => `<${f.name}>`).join(" ");
  const required = c.fields.filter(f => f.required && f.in !== "path");
  const optional = c.fields.filter(f => !f.required && f.in !== "path");
  const usage = [`ludo ${c.group} ${c.name}`, pathArgs, ...required.map(f => flagLabel(f)), optional.length ? "[flags]" : ""]
    .filter(Boolean)
    .join(" ");

  const out = [`Usage: ${usage}`, "", wrap(c.description, 0)];
  if (c.credits) out.push("", wrap(`Credits: ${shortCredits(c.credits)}.`, 0));
  if (c.isJob) {
    out.push(
      "",
      wrap(
        "Runs as a job: the CLI submits it, waits for the result and saves the files to --out " +
          "(default ./ludo-output). With --no-wait it prints the job id instead; follow up with `ludo jobs wait <id>`.",
        0
      )
    );
  }
  const args = c.fields.filter(f => f.in === "path");
  if (args.length) out.push("", "Arguments:", table(args.map(f => [flagLabel(f), flagDescription(f)])));
  if (required.length) out.push("", "Required flags:", table(required.map(f => [flagLabel(f), flagDescription(f)])));
  if (optional.length) out.push("", "Flags:", table(optional.map(f => [flagLabel(f), flagDescription(f)])));
  const globals = Object.entries(GLOBAL_FLAGS)
    .filter(([name]) => c.isJob || !["--no-wait", "--no-download", "--timeout", "--out", "--name"].includes(name))
    .map(([name, g]) => [g.value ? `${name} <value>` : name, g.description] as [string, string]);
  out.push("", "Global flags:", table(globals));
  out.push("", `API operation: ${c.operationId} (${c.method} /api${c.path})`);
  return out.join("\n");
}

export function agentHelp(commands: Command[]): string {
  const groups = groupsOf(commands)
    .map(g => `- ${g}: ${commands.filter(c => c.group === g && !c.hidden).map(c => c.name).join(", ")}`)
    .join("\n");
  return `# ludo CLI: guide for AI agents

Ludo AI generates game assets (sprites, spritesheet animations, images, 3D models, video, audio).
Every command maps to one Ludo API operation; its \`--help\` is generated from the live API spec.

## Discover
- \`ludo <group> --help\` lists commands; \`ludo <group> <command> --help\` lists flags, enums, defaults and credit cost.
- Descriptions name other operations by their API id (createSoundEffect, getDocs); \`ludo <apiId>\` runs them too, e.g. \`ludo createSoundEffect --help\`.
- Before using a feature you have not used, ask the docs: \`ludo docs search --query "how do I pick an animation mode?"\`.

${groups}

${TOOLS.length ? `## Free tools (offline, no account, no credits)
- \`ludo toolbox\` lists them; \`ludo toolbox <group> <tool> --help\` gives the flags. They need no login and no network.
${TOOLS.map(t => `- \`ludo toolbox ${t.group} ${t.name} ${t.args}\`: ${t.summary}`).join("\n")}
- A tool's JSON may carry \`hint: {text, command}\`, the natural next step; mention it to the user once if it fits.
- Exit code 12: an input file it cannot read or use, or a grid it cannot tell for sure; pass \`--grid <cols>x<rows>\`.

` : ""}## Call
- Flags are the API fields in kebab-case: \`image_type\` -> \`--image-type\`. Booleans: \`--crop\` / \`--no-crop\`.
- Files: pass a local path to any image/audio/video/model flag (\`--image ./knight.png\`); the CLI uploads it (15MB max). URLs work too. Never base64-encode files yourself.
- Complex bodies: \`--input body.json\` (or \`--input -\` for stdin); flags override its fields.
- Generations block until done, then save every result file to \`./ludo-output\` (\`--out <dir>\` to change).
  Name them with \`--name <base>\` (\`--name sfx_pump\` -> \`sfx_pump.mp3\`) rather than renaming files afterwards;
  an existing file is never overwritten (the new one gets \`-2\`).
- Game engines: \`--engine godot\` also writes a Godot 4 SpriteFrames \`.tres\` next to a spritesheet (listed in \`files\`).
- Directional Sprites (a character seen from up to 8 directions that line up): make a rigged model
  (\`ludo model create --image hero.png --rig\`), pick a style (\`ludo sprite directional-styles\`), check the look
  with \`ludo sprite directional-preview\` (free; saves the frames as images to look at; one preview at a time per
  account), then render \`ludo sprite directional\` (one sheet per direction, files named \`-SW\`, \`-N\`, ...).
  Long jobs: \`--no-wait\` returns \`{id, status}\`; resume with \`ludo jobs wait <id>\`.

## Output
- stdout is JSON when not a terminal (force with \`--json\`): \`{job_id, status, credits_charged, result, files: [{url, path}]}\`.
- Result URLs expire after 7 days; the downloaded files in \`files[].path\` (relative to the working directory; \`files[].absolute_path\` is the same file, absolute) are yours to keep.
- Progress goes to stderr (\`--quiet\` silences it).

## Projects, cost and reuse
- \`.ludo.json\` (made by \`ludo init\`) sets the output folder, engine, spending budget and per-command defaults;
  flags override it. Generated files are listed in \`ludo-assets.json\`.
- Check \`ludo assets\` before generating: the asset may already exist. \`ludo assets redo <file> [flags]\` makes it
  again with changes.
- \`--dry-run\` prints the price without running; \`--max-credits <n>\` refuses anything dearer. Prices for
  duration-priced models are upper bounds.
- A spending budget (\`LUDO_MAX_CREDITS\` or \`max_credits\`) stops the CLI once reached: exit code 11. Do not work
  around it; tell the user what was spent (\`ludo spend\`) and ask.
- \`--n 4\` makes four variations (files \`-v1\`..\`-v4\`, JSON lists each; with \`--name\`, \`<name>-v1\`..). Look at them, keep the best, delete the rest.
- Several different assets: write a jobs file and run \`ludo batch jobs.json\` (see \`ludo batch --help\`); a job's
  \`"name"\` names its files.

## Exit codes
0 ok, 1 error, 2 bad usage, 3 auth, 4 rejected by the API, 5 not enough credits, 6 job failed (credits refunded;
in a batch, at least one item failed), 7 job canceled, 8 rate limited / too many queued jobs, 9 timed out waiting
(job keeps running), 10 this CLI version is too old (update it), 11 refused by the spending guard, 12 a toolbox
input it cannot use.

## Auth and credits
- The key comes from \`LUDO_API_KEY\`, a prior \`ludo login\`, or \`--api-key\`.
- On exit code 3 (no or rejected key), do not ask the user to paste a key into the chat. Ask them to run
  \`ludo login\` in their own terminal: it opens the browser, where they log in or create an account and
  pick a plan with API access if needed. It waits up to 10 minutes for them to approve.
- Every generation costs credits; \`--help\` shows the price. \`ludo account\` shows the balance, plan and
  auto top-up; check it before an expensive batch.
- On exit code 5, do not retry. Tell the user they are out of credits (or their plan lacks API access) and
  that \`ludo billing\` opens the page to buy credits or change plan.

## Feedback
- When you hit a limitation you cannot work around, a bug, or something the user needed that Ludo
  cannot do, send one short report and tell the user you did:
  \`ludo feedback "<what you tried, what happened, what would have helped>" --category limitation\`
  (categories: limitation, bug, feature_request, praise, other; add \`--operation\` and \`--job <id>\`
  when they apply). Praise for results that worked well is welcome too. It is free but capped at a
  few reports a day, so send one per issue. Never include secrets, personal data or file contents.

## Usage stats
- Each command sends Ludo the command name, exit code, duration, flag names (never values), versions and
  job ids. No prompts, paths or file contents. \`LUDO_TELEMETRY=0\` (or \`DO_NOT_TRACK=1\`) turns it off.
`;
}
