import fs from "node:fs";
import path from "node:path";
import { EXIT } from "../errors.js";
import { printJson, type Ctx } from "../generate.js";
import { MAX_TOOLBOX_PIXELS } from "../tty/png.js";
import { keepLoop, type Grid } from "../tty/preview.js";
import { carriedChunks, engineFiles, freeName, shown, writePng } from "./io.js";
import { layoutSheet } from "./sheet.js";
import { buildPack, type ArtMode } from "./pack.js";
import { MAX_TARGET_FRAME_PX, uniquifyNames } from "./packMath.js";
import { folderName, frameSizeFlag, manifestPath, parseNumber, perAnimation, readInputs, readManifest, usage, type SavedAnimation } from "./animations.js";
import { textFlag } from "./flags.js";
import { hint, TOOLS, type ToolCall } from "./registry.js";

// `ludo toolbox sprite pack`: the web app's Export Pack, offline. The pixel
// work is pack.ts; this reads the inputs and per-animation flags, writes the
// sheets (or frames) and a pack.json manifest that re-runs the pack exactly.

const MANIFEST_VERSION = 1;
const MODES = ["sheets", "frames"] as const;
type Mode = (typeof MODES)[number];

interface ManifestAnimation extends SavedAnimation {
  size: number;
  ground: number;
  offset_x: number;
}

interface Manifest {
  ludo: "toolbox sprite pack";
  version: number;
  name: string;
  mode: Mode;
  art: ArtMode;
  frame_size: { width?: number; height?: number } | null;
  animations: ManifestAnimation[];
}

TOOLS.push({
  group: "sprite",
  name: "pack",
  args: "<sheets...>",
  summary: "Bring several animations of one character to one size and ground line, in one frame size",
  details: [
    "The Ludo web app's Export Pack, offline. Each input is a spritesheet (or a folder of frames) of one",
    "animation. Each is cropped to the box around all its frames, scaled so frame 1's character matches",
    "the shortest one, and drawn centred with frame 1's feet on a shared ground line, in a frame size",
    "every animation shares. Each sheet keeps its own grid.",
    "",
    "Adjust an animation by its file name, its label or its position: --size walk=1.2, --ground 2=-3.",
    "A value with no name applies to all. --ground is the web's Vertical value (pixels, up is",
    "positive); the output gives each animation's, so you can nudge it. The pack folder gets a",
    "pack.json that re-runs it exactly: ludo toolbox sprite pack --manifest <pack>/pack.json (flags",
    "given with it override it).",
    "",
    "--art smooth resizes with area averaging when shrinking and bicubic when enlarging; pixel uses",
    "nearest neighbour. Sheets whose size does not divide by their grid are cut into whole-pixel cells.",
    "--name names the pack's folder (default animation-pack); --engine texturepacker|godot writes engine",
    "files next to each sheet, named after its animation."
  ],
  flags: [
    { flag: "--mode", value: "sheets|frames", description: "One spritesheet per animation (default), or a folder of frames each" },
    { flag: "--art", value: "smooth|pixel", description: "Resizing for painted art (default) or pixel art" },
    { flag: "--frame-size", value: "WxH", description: "Grow the shared frame to at least this size, like 256x256 (or 256x, x256)" },
    { flag: "--size", value: "[anim=]n", description: "Scale an animation's character by n after matching heights (default 1)" },
    { flag: "--ground", value: "[anim=]px", description: "Raise (or lower, negative) an animation against the ground line" },
    { flag: "--offset-x", value: "[anim=]px", description: "Move an animation right (or left, negative)" },
    { flag: "--label", value: "anim=name", description: "Name an animation's output (default: its file name)" },
    { flag: "--fps", value: "[anim=]n", description: "Frame rate the sheets remember (default: each sheet's, else 10)" },
    { flag: "--grid", value: "[anim=]CxR", description: "A sheet's grid, when it has no Ludo stamp and detection is unsure" },
    { flag: "--manifest", value: "file", description: "Re-run a pack from its pack.json" }
  ],
  async run(ctx: Ctx, call: ToolCall) {
    const manifestFile = textFlag(call, "--manifest");
    if (manifestFile !== undefined && call.args.length) throw usage("Pass the animations or --manifest, not both");
    if (manifestFile === undefined && !call.args.length) throw usage("Usage: ludo toolbox sprite pack <sheets...> (or --manifest pack.json)");
    const manifest = manifestFile !== undefined ? readManifest<Manifest>(manifestFile, "sprite pack", MANIFEST_VERSION, "pack") : undefined;
    const base = manifestFile !== undefined ? path.dirname(path.resolve(manifestFile)) : process.cwd();

    const mode = (textFlag(call, "--mode") ?? manifest?.mode ?? "sheets") as Mode;
    if (!MODES.includes(mode)) throw usage(`--mode is sheets or frames (got "${mode}")`);
    const art = (textFlag(call, "--art") ?? manifest?.art ?? "smooth") as ArtMode;
    if (art !== "smooth" && art !== "pixel") throw usage(`--art is smooth or pixel (got "${art}")`);
    const frameSize = frameSizeFlag(textFlag(call, "--frame-size"), MAX_TARGET_FRAME_PX) ?? manifest?.frame_size ?? undefined;

    const inputs = manifest ? manifest.animations.map(a => path.resolve(base, a.input)) : call.args;
    const { animations, names, warnings } = readInputs(call, inputs, manifest?.animations);

    const sizes = perAnimation(call, "--size", names, parseNumber("--size", n => n > 0 && n <= 16, "a number above 0, up to 16"));
    const grounds = perAnimation(call, "--ground", names, parseNumber("--ground", Number.isInteger, "whole pixels, like -3"));
    const offsets = perAnimation(call, "--offset-x", names, parseNumber("--offset-x", Number.isInteger, "whole pixels, like 4"));
    const fpsFlags = perAnimation(call, "--fps", names, parseNumber("--fps", n => n > 0, "a number above 0"));
    const at = <T>(map: Map<number, T>, i: number, saved: T | undefined) => (map.has(i) ? map.get(i) : saved);

    const pack = buildPack(
      animations.map((a, i) => ({
        frames: a.frames,
        size: at(sizes, i, manifest?.animations[i].size),
        ground: at(grounds, i, manifest?.animations[i].ground),
        offsetX: at(offsets, i, manifest?.animations[i].offset_x)
      })),
      { art, frameSize: frameSize ? { w: frameSize.width, h: frameSize.height } : undefined }
    );
    const { frameWidth: fw, frameHeight: fh } = pack;
    for (const a of animations) {
      if (fw * a.grid.cols * fh * a.grid.rows > MAX_TOOLBOX_PIXELS) {
        throw usage(`A ${a.grid.cols}x${a.grid.rows} sheet of ${fw}x${fh} frames is over ${MAX_TOOLBOX_PIXELS / 1024 / 1024} megapixels`, "Use smaller --size values, or --mode frames.");
      }
    }

    const labels = uniquifyNames(names.map(n => n[n.length - 1]));
    const packName = ctx.globals.name ?? manifest?.name ?? "Animation Pack";
    const dir = freeName(ctx.outDir, folderName(packName, "animation-pack"));
    fs.mkdirSync(dir, { recursive: true });

    const results = animations.map((a, i) => {
      const packed = pack.animations[i];
      const fps = at(fpsFlags, i, manifest?.animations[i].fps) ?? a.grid.fps;
      const grid: Grid = keepLoop({ cols: a.grid.cols, rows: a.grid.rows, frames: a.grid.frames, fps }, a.grid);
      let files: string[];
      let engine: string[] = [];
      if (mode === "sheets") {
        const sheet = layoutSheet(packed.frames, grid.cols, grid.rows);
        const file = path.join(dir, `${labels[i]}.png`);
        writePng(file, sheet, a.src ? carriedChunks(a.src, grid) : []);
        engine = engineFiles(ctx, file, sheet, grid, {}, labels[i]);
        files = [file];
      } else {
        const folder = path.join(dir, labels[i]);
        files = packed.frames.map((f, k) => {
          const file = path.join(folder, `frame_${String(k).padStart(3, "0")}.png`);
          writePng(file, f, a.src ? carriedChunks(a.src) : []);
          return file;
        });
      }
      return { a, packed, fps, files, engine };
    });

    const manifestOut = path.join(dir, "pack.json");
    const saved: Manifest = {
      ludo: "toolbox sprite pack",
      version: MANIFEST_VERSION,
      name: packName,
      mode,
      art,
      frame_size: frameSize ?? null,
      animations: results.map(({ a, packed, fps }, i) => ({
        input: manifestPath(dir, a.input),
        kind: a.kind,
        ...(a.sha256 ? { sha256: a.sha256 } : {}),
        label: labels[i],
        grid: { cols: a.grid.cols, rows: a.grid.rows, frames: a.grid.frames },
        fps,
        size: packed.size,
        ground: packed.ground,
        offset_x: packed.offsetX
      }))
    };
    fs.writeFileSync(manifestOut, JSON.stringify(saved, null, 2) + "\n");

    const groundLine = Math.round(pack.groundLine * 100) / 100;
    const next = hint("Animate another move for the same character with Ludo, then add it to the pack", `ludo sprite animate --initial-image <a frame> --motion-prompt "<what it does>"`);
    if (ctx.jsonOut) {
      printJson(
        {
          pack: shown(dir),
          manifest: shown(manifestOut),
          mode,
          art,
          frame_width: fw,
          frame_height: fh,
          ground_line: groundLine,
          target_height: pack.targetHeight,
          animations: results.map(({ a, packed, fps, files, engine }, i) => ({
            input: shown(a.input),
            label: labels[i],
            frames: a.grid.frames,
            grid: { cols: a.grid.cols, rows: a.grid.rows },
            fps,
            scale: Math.round(packed.scale * 10000) / 10000,
            size: packed.size,
            ground: packed.ground,
            ground_auto: packed.groundAuto,
            offset_x: packed.offsetX,
            ...(mode === "sheets" ? { sheet: shown(files[0]) } : { dir: shown(path.dirname(files[0])) }),
            ...(engine.length ? { engine_files: engine.map(shown) } : {})
          })),
          ...(warnings.length ? { warnings } : {}),
          ...(ctx.globals.quiet ? {} : { hint: next })
        },
        false
      );
    } else {
      const out = (line: string) => process.stdout.write(line + "\n");
      out(`${animations.length} animations in ${fw}x${fh} frames (${art} art); the ground line is ${groundLine} px above the frame bottom`);
      const width = Math.max(...labels.map(l => l.length));
      results.forEach(({ a, packed, files, engine }, i) => {
        const where = mode === "sheets" ? shown(files[0]) : `${shown(path.dirname(files[0]))}${path.sep}`;
        out(`  ${labels[i].padEnd(width)}  ${String(a.grid.frames).padStart(3)} frames  scale ${packed.scale.toFixed(2)}  ground ${packed.ground}  -> ${where}${engine.length ? ` + ${engine.map(shown).join(", ")}` : ""}`);
      });
      out(`Saved ${shown(dir)}${path.sep}; re-run it with: ludo toolbox sprite pack --manifest ${shown(manifestOut)}`);
      for (const w of warnings) process.stderr.write(`Note: ${w}\n`);
      if (!ctx.globals.quiet) process.stderr.write(`Next: ${next.text}: ${next.command}\n`);
    }
    return EXIT.OK;
  }
});
