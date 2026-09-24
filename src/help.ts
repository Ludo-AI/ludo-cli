import { GLOBAL_FLAGS } from "./args.js";
import { Command, Field, GROUP_INFO, groupsOf } from "./commands.js";
import { VERSION } from "./config.js";

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
    "Other commands:",
    table([
      ["login", "Save your API key (or set LUDO_API_KEY)"],
      ["logout", "Forget the saved API key"],
      ["files upload <path>", "Upload a local file and print its URL"],
      ["jobs wait <id>", "Wait for a job and download its results"],
      ["agent-help", "A short guide for AI agents using this CLI"],
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
    .filter(([name]) => c.isJob || !["--no-wait", "--no-download", "--timeout", "--out"].includes(name))
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

## Call
- Flags are the API fields in kebab-case: \`image_type\` -> \`--image-type\`. Booleans: \`--crop\` / \`--no-crop\`.
- Files: pass a local path to any image/audio/video/model flag (\`--image ./knight.png\`); the CLI uploads it (15MB max). URLs work too. Never base64-encode files yourself.
- Complex bodies: \`--input body.json\` (or \`--input -\` for stdin); flags override its fields.
- Generations block until done, then save every result file to \`./ludo-output\` (\`--out <dir>\` to change).
  Long jobs: \`--no-wait\` returns \`{id, status}\`; resume with \`ludo jobs wait <id>\`.

## Output
- stdout is JSON when not a terminal (force with \`--json\`): \`{job_id, status, credits_charged, result, files: [{url, path}]}\`.
- Result URLs expire after 7 days; the downloaded files in \`files[].path\` are yours to keep.
- Progress goes to stderr (\`--quiet\` silences it).

## Exit codes
0 ok, 1 error, 2 bad usage, 3 auth, 4 rejected by the API, 5 not enough credits, 6 job failed (credits refunded),
7 job canceled, 8 rate limited / too many queued jobs, 9 timed out waiting (job keeps running).

## Auth
\`LUDO_API_KEY\` env var, \`ludo login\`, or \`--api-key\`. Every generation costs credits; check \`--help\` for the price first.
`;
}
