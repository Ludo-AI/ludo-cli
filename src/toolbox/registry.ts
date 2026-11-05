import type { Ctx } from "../generate.js";
import { hintId, noteFact } from "../telemetry.js";

// The toolbox's tools register themselves here (a module per group), so the
// dispatcher and the tools do not import each other.

export interface ToolFlag {
  flag: string; // "--grid"
  value?: string; // placeholder when it takes a value: "CxR"
  description: string;
}

export interface ToolCall {
  args: string[]; // positionals after `toolbox <group> <tool>`
  flags: Map<string, string | true>; // the last value given wins
  lists: Map<string, string[]>; // every value given, in order, for flags that may repeat
}

export interface Tool {
  group: string;
  name: string;
  args: string; // usage for the positionals: "<sheet>"
  summary: string;
  details?: string[];
  flags: ToolFlag[];
  run(ctx: Ctx, call: ToolCall): Promise<number>;
}

export const TOOL_GROUPS: Record<string, string> = {
  sprite: "Spritesheets and frames",
  image: "Images",
  audio: "Sound effects, music and voices",
  model: "3D models",
  asset: "Folders of assets: inventories, gaps to fill with Ludo, loaders"
};

export const TOOLS: Tool[] = [];

// The one next-step line a tool may print: on stderr for people, as `hint`
// in JSON for agents. --quiet drops it.
export interface Hint {
  text: string;
  command: string;
}

// A path as the person would type it in their shell: bare when nothing in it
// needs quoting, else in double quotes. On Windows backslashes are the path's
// own (cmd and PowerShell don't escape with them), and a ~ inside a short
// name (RUNNER~1) is only a letter.
export const shellArg = (p: string): string => {
  if (process.platform === "win32") return /^(?!~)[\w.\\/@:+~-]+$/.test(p) ? p : `"${p.replace(/"/g, '\\"')}"`;
  return /^[\w./@:+-]+$/.test(p) ? p : `"${p.replace(/(["\\$`])/g, "\\$1")}"`;
};

export const hint = (text: string, command: string): Hint => {
  const id = hintId(command);
  if (id) noteFact("hint", id);
  return { text, command };
};

// The line after a tool writes a sheet that plays. `ludo preview` draws only
// in an interactive terminal, and refuses everyone else, coding agents (most
// toolbox runs) above all: they are shown Ludo's next step instead.
export const playHint = (ctx: Ctx, sheet: string, text = "Preview it playing"): Hint =>
  ctx.vis.enabled
    ? hint(text, `ludo preview ${sheet}`)
    : hint("Animate another move for the same character with Ludo", `ludo sprite animate --initial-image <a frame> --motion-prompt "<what it does>"`);
