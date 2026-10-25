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
  model: "3D models"
};

export const TOOLS: Tool[] = [];

// The one next-step line a tool may print: on stderr for people, as `hint`
// in JSON for agents. --quiet drops it.
export interface Hint {
  text: string;
  command: string;
}

export const hint = (text: string, command: string): Hint => {
  const id = hintId(command);
  if (id) noteFact("hint", id);
  return { text, command };
};
