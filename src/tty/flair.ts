import path from "node:path";
import { armRestore, type Visuals } from "./visuals.js";

// The small touches for a person at a terminal: a one-line spinner with the
// real status and a rotating line of flavour, the next step after a result,
// a credits bar and the logo. All of it is text; nothing here is required.

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const FLAVOR: Record<string, string[]> = {
  sprite: ["sketching keyframes", "tweening the in-betweens", "counting frames", "polishing pixels", "checking the loop point"],
  image: ["mixing the palette", "blocking in shapes", "sharpening edges", "adding highlights"],
  model: ["sculpting the mesh", "unwrapping UVs", "baking textures", "placing the bones", "weight painting"],
  video: ["setting up the camera", "rendering frames", "color grading"],
  audio: ["tuning the synths", "recording foley", "mixing levels", "mastering"],
  default: ["working on it", "almost there"]
};

function flavorFor(label: string): string[] {
  const group = label.split(" ")[0];
  return FLAVOR[group] || FLAVOR.default;
}

export interface Spinner {
  update(status: string, elapsedS: number): void;
  stop(): void;
}

export function spinner(label: string, v: Visuals): Spinner {
  armRestore();
  const lines = flavorFor(label);
  let status = "queued";
  let elapsed = 0;
  let tick = 0;
  const started = Date.now();
  const draw = () => {
    const secs = Math.max(elapsed, Math.round((Date.now() - started) / 1000));
    const flavor = status === "running" ? ` · ${lines[Math.floor(tick / 50) % lines.length]}…` : "";
    const text = `${FRAMES[tick % FRAMES.length]} ${label}: ${status} (${secs}s)${flavor}`;
    process.stderr.write(`\r\x1b[K${text.slice(0, Math.max(10, v.columns - 1))}`);
    tick++;
  };
  const timer = setInterval(draw, 120);
  timer.unref();
  draw();
  return {
    update(s, e) {
      status = s;
      elapsed = Math.round(e);
    },
    stop() {
      clearInterval(timer);
      process.stderr.write("\r\x1b[K");
    }
  };
}

const q = (p: string) => (/[\s"'$]/.test(p) ? JSON.stringify(p) : p);

// What to try next with a fresh result: teaches the pipeline, costs nothing.
export function nextStep(taskType: string | undefined, files: { path: string }[], body?: Record<string, unknown>): string | undefined {
  const find = (re: RegExp) => files.find(f => re.test(f.path))?.path;
  const png = find(/\.png$/i);
  const glb = find(/\.glb$/i);
  switch (taskType) {
    case "createImage":
    case "generateWithStyle":
    case "editImage":
    case "generatePose":
    case "rotateSprite":
      if (!png) return undefined;
      if (body?.image_type === "sprite" || taskType === "generatePose" || taskType === "rotateSprite") {
        return `Animate it: ludo sprite animate --initial-image ${q(png)} --motion-prompt "idle breathing"`;
      }
      return `Make it 3D: ludo model create --image ${q(png)}`;
    case "removeBackground":
      return png ? `Animate it: ludo sprite animate --initial-image ${q(png)} --motion-prompt "walk cycle"` : undefined;
    case "animateSprite":
    case "animateSpriteKeyframes":
    case "transferMotion":
    case "editSpritesheet": {
      const sheet = files.find(f => /\.png$/i.test(f.path) && !/-frame|frames/i.test(path.basename(f.path)))?.path;
      return sheet ? `Watch it again: ludo preview ${q(sheet)}   Into Godot: add --engine godot next time` : undefined;
    }
    case "create3DModel":
      return glb ? `Rig it: ludo model rig --model ${q(glb)}` : undefined;
    case "rigModel":
      return glb ? `Animate it: ludo model animate --model ${q(glb)} --prompt "victory dance"` : undefined;
    default:
      return undefined;
  }
}

// "▰▰▰▰▰▰▱▱▱▱ 1,840 / 2,000"
export function creditsBar(available: number, planCredits: number, width = 20): string {
  const total = Math.max(planCredits, available, 1);
  const filled = Math.max(0, Math.min(width, Math.round((available / total) * width)));
  return "▰".repeat(filled) + "▱".repeat(width - filled);
}

// Ludo's logo, drawn small with half blocks: a rounded "L" mark in the brand
// gradient. Six rows, only on a bare `ludo` at a terminal.
export function logo(v: Visuals): string {
  const rows = ["██      ", "██      ", "██      ", "██      ", "████████", "████████"];
  const from = [124, 58, 237];
  const to = [236, 72, 153];
  return rows
    .map((row, y) =>
      [...row]
        .map((ch, x) => {
          if (ch === " ") return " ";
          const t = (x + y) / (row.length + rows.length);
          const c = from.map((f, i) => Math.round(f + (to[i] - f) * t));
          return v.truecolor ? `\x1b[38;2;${c[0]};${c[1]};${c[2]}m█` : `\x1b[38;5;135m█`;
        })
        .join("") + "\x1b[0m"
    )
    .join("\n");
}
