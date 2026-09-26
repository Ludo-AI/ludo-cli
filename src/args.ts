import fs from "node:fs";
import type { Command, Field } from "./commands.js";
import { CliError, EXIT, specMismatch } from "./errors.js";

// Flags every command understands. `value: true` means it takes an argument.
export const GLOBAL_FLAGS: Record<string, { value: boolean; description: string }> = {
  "--json": { value: false, description: "Print machine-readable JSON (the default when stdout is not a terminal)" },
  "--out": { value: true, description: "Directory to save generated files in (default: ./ludo-output)" },
  "--no-wait": { value: false, description: "Submit the job and print it without waiting for the result" },
  "--no-download": { value: false, description: "Do not download the result files, only print their URLs" },
  "--timeout": { value: true, description: "Give up waiting after this many seconds (default: 1800); the job keeps running" },
  "--input": { value: true, description: "Read the request body from a JSON file, or - for stdin; flags override its fields" },
  "--api-key": { value: true, description: "API key to use (default: $LUDO_API_KEY, then `ludo login`)" },
  "--api-url": { value: true, description: "API base URL (default: $LUDO_API_URL, then https://api.ludo.ai)" },
  "--quiet": { value: false, description: "No progress output on stderr" },
  "--plain": { value: false, description: "No previews, animation, spinner or colour, even at a terminal" },
  "--open": { value: false, description: "Open the result in its default app when done" },
  "--play": { value: false, description: "Play generated audio when done" },
  "--copy": { value: false, description: "Copy the saved file paths to the clipboard when done" },
  "--engine": { value: true, description: "Also write engine files next to results: godot (a SpriteFrames .tres for spritesheets, Godot 4)" },
  "--n": { value: true, description: "Make N variations of the same request and pick the best (runs N jobs, or one when the API takes n)" },
  "--max-credits": { value: true, description: "Refuse to run if this would cost more than this many credits (all variations together)" },
  "--dry-run": { value: false, description: "Print what this would cost and exit without running it" },
  "--force": { value: false, description: "Run even when the price cannot be known up front and a spending limit is set" },
  "--yes": { value: false, description: "Do not ask before spending more than 50 credits at once" },
  "--help": { value: false, description: "Show help for this command" }
};

export interface Globals {
  json: boolean;
  out?: string;
  wait: boolean;
  download: boolean;
  timeout?: number;
  input?: string;
  apiKey?: string;
  apiUrl?: string;
  quiet: boolean;
  plain: boolean;
  open: boolean;
  play: boolean;
  copy: boolean;
  engine?: string;
  n?: number;
  maxCredits?: number;
  dryRun: boolean;
  force: boolean;
  yes: boolean;
  help: boolean;
}

export interface Parsed {
  globals: Globals;
  words: string[]; // positionals before and after the command
  flags: Map<string, string[]>; // raw command flags, "--image-type" -> values
}

function defaultGlobals(): Globals {
  return { json: false, wait: true, download: true, quiet: false, plain: false, open: false, play: false, copy: false, dryRun: false, force: false, yes: false, help: false };
}

// First pass: split argv into positionals, global flags and command flags.
// Command flags are kept raw until the command is known.
export function parseArgv(argv: string[]): Parsed {
  const globals = defaultGlobals();
  const words: string[] = [];
  const flags = new Map<string, string[]>();
  let onlyPositionals = false;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (onlyPositionals || token === "-" || !token.startsWith("-")) {
      words.push(token);
      continue;
    }
    if (token === "--") {
      onlyPositionals = true;
      continue;
    }
    if (token === "-h") {
      globals.help = true;
      continue;
    }

    const eq = token.indexOf("=");
    const name = eq >= 0 ? token.slice(0, eq) : token;
    const inline = eq >= 0 ? token.slice(eq + 1) : undefined;
    const global = GLOBAL_FLAGS[name];

    const takeValue = (): string => {
      if (inline !== undefined) return inline;
      const next = argv[i + 1];
      if (next === undefined) throw new CliError(`${name} needs a value`, EXIT.USAGE);
      i++;
      return next;
    };

    if (global) {
      switch (name) {
        case "--json": globals.json = true; break;
        case "--no-wait": globals.wait = false; break;
        case "--no-download": globals.download = false; break;
        case "--quiet": globals.quiet = true; break;
        case "--plain": globals.plain = true; break;
        case "--open": globals.open = true; break;
        case "--play": globals.play = true; break;
        case "--copy": globals.copy = true; break;
        case "--engine": {
          const engine = takeValue().toLowerCase();
          if (engine !== "godot") throw new CliError(`--engine supports: godot (got "${engine}")`, EXIT.USAGE);
          globals.engine = engine;
          break;
        }
        case "--help": globals.help = true; break;
        case "--dry-run": globals.dryRun = true; break;
        case "--force": globals.force = true; break;
        case "--yes": globals.yes = true; break;
        case "--n": {
          const v = Number(takeValue());
          if (!Number.isInteger(v) || v < 1 || v > 20) throw new CliError("--n must be a whole number from 1 to 20", EXIT.USAGE);
          globals.n = v;
          break;
        }
        case "--max-credits": {
          const v = Number(takeValue());
          if (!Number.isFinite(v) || v < 0) throw new CliError("--max-credits must be a number of credits", EXIT.USAGE);
          globals.maxCredits = v;
          break;
        }
        case "--out": globals.out = takeValue(); break;
        case "--input": globals.input = takeValue(); break;
        case "--api-key": globals.apiKey = takeValue(); break;
        case "--api-url": globals.apiUrl = takeValue(); break;
        case "--timeout": {
          const v = Number(takeValue());
          if (!Number.isFinite(v) || v <= 0) throw new CliError("--timeout must be a positive number of seconds", EXIT.USAGE);
          globals.timeout = v;
          break;
        }
      }
      continue;
    }

    // A command flag. Whether it takes a value is only known once the command
    // is resolved, so a following non-flag token is tentatively its value;
    // resolveFlags hands it back as a positional for boolean flags.
    const list = flags.get(name) || [];
    if (inline !== undefined) {
      list.push(inline);
    } else if (argv[i + 1] !== undefined && (!argv[i + 1].startsWith("-") || argv[i + 1] === "-" || /^-\d/.test(argv[i + 1]))) {
      list.push(argv[++i]);
    } else {
      list.push("\u0000flag"); // bare flag, no value
    }
    flags.set(name, list);
  }
  return { globals, words, flags };
}

const BARE = "\u0000flag";

function coerce(field: Field, raw: string, type = field.type): unknown {
  switch (type) {
    case "integer":
    case "number": {
      const n = Number(raw);
      if (raw.trim() === "" || !Number.isFinite(n) || (type === "integer" && !Number.isInteger(n))) {
        throw new CliError(`${field.flag} expects ${type === "integer" ? "a whole number" : "a number"}, got "${raw}"`, EXIT.USAGE);
      }
      return n;
    }
    case "boolean": {
      const v = raw.toLowerCase();
      if (["true", "1", "yes"].includes(v)) return true;
      if (["false", "0", "no"].includes(v)) return false;
      throw new CliError(`${field.flag} expects true or false, got "${raw}"`, EXIT.USAGE);
    }
    case "object":
    case "array": {
      const text = raw.startsWith("@") ? fs.readFileSync(raw.slice(1), "utf8") : raw;
      try {
        return JSON.parse(text);
      } catch {
        throw new CliError(`${field.flag} expects JSON${raw.startsWith("@") ? " in " + raw.slice(1) : ""}`, EXIT.USAGE);
      }
    }
    default:
      return raw;
  }
}

function checkEnum(field: Field, value: unknown) {
  if (!field.enum || typeof value !== "string") return;
  if (!field.enum.includes(value)) {
    throw specMismatch(
      `${field.flag} must be one of: ${field.enum.join(", ")} (got "${value}")`,
      `Run \`ludo ... --help\` to see every flag.`
    );
  }
}

export interface Resolved {
  body: Record<string, unknown>;
  query: Record<string, unknown>;
  path: Record<string, string>;
  extraWords: string[];
}

// stdin can only be read once, and a stale-spec retry resolves flags twice.
let stdinText: string | undefined;
function readStdin(): string {
  if (stdinText === undefined) stdinText = fs.readFileSync(0, "utf8");
  return stdinText;
}

function readInput(input: string): Record<string, unknown> {
  const text = input === "-" ? readStdin() : fs.readFileSync(input, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CliError(`--input ${input} is not valid JSON`, EXIT.USAGE);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliError(`--input must hold a JSON object`, EXIT.USAGE);
  }
  return parsed as Record<string, unknown>;
}

// Body fields from somewhere other than flags (.ludo.json defaults, a batch
// item, the asset log), checked like flags: known fields, allowed values.
function applyDefaults(command: Command, out: Resolved, defaults: Record<string, unknown>, source: string) {
  for (const [key, value] of Object.entries(defaults)) {
    const name = key.replace(/^--/, "").replace(/-/g, "_");
    const field = command.fields.find(f => f.name === name && f.in !== "path");
    if (!field) {
      throw new CliError(
        `${source}: \`ludo ${command.group} ${command.name}\` has no field "${key}"`,
        EXIT.USAGE,
        `Fields: ${command.fields.filter(f => f.in !== "path").map(f => f.name).join(", ")}`
      );
    }
    let typed: unknown;
    try {
      typed = coerceValue(field, value);
    } catch (err) {
      throw new CliError(`${source}: ${(err as Error).message}`, EXIT.USAGE);
    }
    if (Array.isArray(typed)) typed.forEach(v => checkEnum(field, v));
    else checkEnum(field, typed);
    if (field.in === "query") out.query[name] = typed;
    else out.body[name] = typed;
  }
}

// A value from JSON to the field's type, the way a flag's text would be:
// "4" for a number field is 4, "true" for a switch is true.
function coerceValue(field: Field, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (field.type === "array") {
    const items = Array.isArray(value) ? value : typeof value === "string" && value.trim().startsWith("[") ? (coerce(field, value) as unknown[]) : [value];
    return items.map(v => (v !== null && typeof v === "object" ? v : coerce(field, String(v), field.itemType || "string")));
  }
  if (field.type === "object") return typeof value === "string" ? coerce(field, value) : value;
  if (typeof value === "object") throw new CliError(`${field.flag} expects ${field.type === "string" ? "text" : `a ${field.type}`}, got JSON`, EXIT.USAGE);
  return coerce(field, String(value));
}

// Second pass: map raw flags onto the command's fields. Path parameters may
// also be given positionally (`ludo jobs get <id>`). Defaults come first,
// then --input, then flags: the most explicit wins.
export function resolveFlags(
  command: Command,
  parsed: Parsed,
  positionals: string[],
  defaults?: { values: Record<string, unknown>; source: string }[]
): Resolved {
  const out: Resolved = { body: {}, query: {}, path: {}, extraWords: [] };
  for (const d of defaults || []) applyDefaults(command, out, d.values, d.source);
  if (parsed.globals.input) Object.assign(out.body, readInput(parsed.globals.input));

  const byFlag = new Map<string, Field>();
  for (const f of command.fields) {
    byFlag.set(f.flag, f);
    byFlag.set("--" + f.name, f); // snake_case spelling works too
  }

  const leftovers = [...positionals];
  for (const [flag, values] of parsed.flags) {
    let field = byFlag.get(flag);
    let negated = false;
    if (!field && flag.startsWith("--no-")) {
      field = byFlag.get("--" + flag.slice(5));
      negated = !!field && field.type === "boolean";
      if (!negated) field = undefined;
    }
    if (!field) {
      const known = command.fields.map(f => f.flag).join(", ");
      throw specMismatch(`Unknown flag ${flag} for \`ludo ${command.group} ${command.name}\``, `Flags: ${known || "(none)"}`);
    }

    let value: unknown;
    if (field.type === "boolean") {
      const last = values[values.length - 1];
      if (negated) {
        value = false;
        if (last !== BARE) leftovers.push(last);
      } else if (last === BARE) {
        value = true;
      } else if (/^(true|false|1|0|yes|no)$/i.test(last)) {
        value = coerce(field, last);
      } else {
        // `--crop photo.png`: crop is a switch, photo.png a positional.
        value = true;
        leftovers.push(last);
      }
    } else if (values.includes(BARE)) {
      throw new CliError(`${field.flag} needs a value`, EXIT.USAGE);
    } else if (field.type === "array") {
      // Repeat the flag (--images a.png --images b.png) or pass a JSON array.
      if (values.length === 1 && values[0].trim().startsWith("[")) {
        value = coerce(field, values[0]);
      } else {
        value = values.map(v => coerce(field!, v, field!.itemType || "string"));
      }
    } else {
      if (values.length > 1) throw new CliError(`${field.flag} was given more than once`, EXIT.USAGE);
      value = coerce(field, values[0]);
    }

    if (Array.isArray(value)) value.forEach(v => checkEnum(field!, v));
    else checkEnum(field, value);

    if (field.in === "path") out.path[field.name] = String(value);
    else if (field.in === "query") out.query[field.name] = value;
    else out.body[field.name] = value;
  }

  // Positionals fill path parameters in order.
  for (const f of command.fields.filter(f => f.in === "path")) {
    if (out.path[f.name] === undefined && leftovers.length) out.path[f.name] = leftovers.shift()!;
  }
  out.extraWords = leftovers;

  const missing = command.fields.filter(f => {
    if (!f.required) return false;
    if (f.in === "path") return out.path[f.name] === undefined;
    if (f.in === "query") return out.query[f.name] === undefined;
    return out.body[f.name] === undefined;
  });
  if (missing.length) {
    throw specMismatch(
      `Missing required ${missing.length === 1 ? "flag" : "flags"}: ${missing.map(f => (f.in === "path" ? `<${f.name}>` : f.flag)).join(", ")}`,
      `Run \`ludo ${command.group} ${command.name} --help\` for details.`
    );
  }
  return out;
}
