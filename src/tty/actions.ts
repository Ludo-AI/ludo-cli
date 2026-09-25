import { spawn, spawnSync } from "node:child_process";

// --open, --play and --copy: hand a result to the desktop. Each spawns one
// detached command and never waits on it or fails the generation.

function detached(cmd: string, args: string[]): boolean {
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function has(cmd: string): boolean {
  try {
    return spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

// Opens a file in its default app (Aseprite for sprites, if that is yours).
export function openFile(file: string): boolean {
  if (process.platform === "darwin") return detached("open", [file]);
  if (process.platform === "win32") return detached("cmd", ["/c", "start", '""', file]);
  return detached("xdg-open", [file]);
}

// Plays an audio file in the background, or falls back to its default app.
export function playAudio(file: string): boolean {
  if (process.platform === "darwin") return detached("afplay", [file]);
  if (process.platform === "linux") {
    if (has("paplay")) return detached("paplay", [file]);
    if (has("ffplay")) return detached("ffplay", ["-nodisp", "-autoexit", "-loglevel", "quiet", file]);
    if (/\.wav$/i.test(file) && has("aplay")) return detached("aplay", ["-q", file]);
  }
  return openFile(file);
}

export function copyText(text: string): boolean {
  const tools: [string, string[]][] =
    process.platform === "darwin"
      ? [["pbcopy", []]]
      : process.platform === "win32"
        ? [["clip", []]]
        : [
            ["wl-copy", []],
            ["xclip", ["-selection", "clipboard"]],
            ["xsel", ["--clipboard", "--input"]]
          ];
  for (const [cmd, args] of tools) {
    if (process.platform !== "darwin" && !has(cmd)) continue;
    try {
      if (spawnSync(cmd, args, { input: text, stdio: ["pipe", "ignore", "ignore"] }).status === 0) return true;
    } catch {
      // Try the next tool.
    }
  }
  return false;
}

export const AUDIO_EXT = /\.(mp3|wav|ogg|m4a|flac|aac)$/i;
export const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;
