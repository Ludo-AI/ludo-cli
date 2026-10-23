import { CliError, EXIT } from "../errors.js";
import { parseGrid } from "../tty/preview.js";
import type { ToolCall } from "./registry.js";

// Reading tool flags that more than one tool takes. A bad value is a usage
// error (exit code 2).

export function positiveInt(call: ToolCall, flag: string): number | undefined {
  const raw = call.flags.get(flag);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (raw === true || !Number.isInteger(n) || n < 1) throw new CliError(`${flag} must be a whole number above 0`, EXIT.USAGE);
  return n;
}

export function positiveNumber(call: ToolCall, flag: string): number | undefined {
  const raw = call.flags.get(flag);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (raw === true || !Number.isFinite(n) || n <= 0) throw new CliError(`${flag} must be a number above 0`, EXIT.USAGE);
  return n;
}

export function textFlag(call: ToolCall, flag: string): string | undefined {
  const v = call.flags.get(flag);
  return typeof v === "string" ? v : undefined;
}

export function gridFlag(call: ToolCall): { cols: number; rows: number } | undefined {
  const raw = call.flags.get("--grid");
  if (raw === undefined) return undefined;
  const grid = typeof raw === "string" ? parseGrid(raw) : undefined;
  if (!grid || grid.cols < 1 || grid.rows < 1) throw new CliError(`--grid takes columns x rows, like --grid 6x4 (got "${raw}")`, EXIT.USAGE);
  return grid;
}


// #rgb, #rrggbb or #rrggbbaa, as RGBA.
export function hexColour(spec: string, flag: string): [number, number, number, number] {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(spec.trim());
  if (!m) throw new CliError(`${flag} takes a hex colour like #1e1e2e or #1e1e2e80 (got "${spec}")`, EXIT.USAGE);
  const hex = m[1].length === 3 ? [...m[1]].map(c => c + c).join("") : m[1];
  const v = (i: number) => parseInt(hex.slice(i, i + 2), 16);
  return [v(0), v(2), v(4), hex.length === 8 ? v(6) : 255];
}
