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

