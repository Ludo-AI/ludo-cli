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
  help: boolean;
}

export interface Parsed {
  globals: Globals;
  words: string[]; // positionals before and after the command
  flags: Map<string, string[]>; // raw command flags, "--image-type" -> values
}

function defaultGlobals(): Globals {
  return { json: false, wait: true, download: true, quiet: false, help: false };
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
        case "--help": globals.help = true; break;
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

// Second pass: map raw flags onto the command's fields. Path parameters may
// also be given positionally (`ludo jobs get <id>`).
export function resolveFlags(command: Command, parsed: Parsed, positionals: string[]): Resolved {
  const out: Resolved = { body: {}, query: {}, path: {}, extraWords: [] };
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
