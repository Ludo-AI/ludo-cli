import fs from "node:fs";
import path from "node:path";
import { CliError, EXIT } from "../errors.js";
import { printJson, type Ctx } from "../generate.js";
import { GRID_KEY } from "../tty/preview.js";
import { MAX_TOOLBOX_PIXELS, textChunk, type Image } from "../tty/png.js";
import { baseOf, engineFiles, freeName, loadImageFile, shown, writePng } from "./io.js";
import { crop, joinFrames, sliceSheet } from "./sheet.js";
import { scaleUp } from "./pixels.js";
import { gridFlag, hexColour, positiveInt, positiveNumber, textFlag } from "./flags.js";
import { resolveGrid } from "./sprite.js";
import { decodeVideo, encodeVideo, needFfmpeg, probeVideo, VIDEO_FORMATS, type VideoFormat } from "./video.js";
import { hint, TOOLS, type ToolCall } from "./registry.js";

// Spritesheets from video clips and back, through the system's ffmpeg.

const usage = (message: string) => new CliError(message, EXIT.USAGE);

const seconds = (call: ToolCall, flag: string) => {
  const raw = textFlag(call, flag);
  if (raw === undefined) return undefined;
  const v = Number(raw.replace(/s$/, ""));
  if (!(v >= 0) || !Number.isFinite(v)) throw usage(`${flag} takes seconds, like 1.5 (got "${raw}")`);
  return v;
};

TOOLS.push({
  group: "sprite",
  name: "from-video",
  args: "<video>",
  summary: "Turn a video clip into a spritesheet",
  details: [
    "Every frame of the clip (or of --start for --duration, at --fps) laid out in a grid and stamped",
    "with it, so every sheet tool, preview and engine export takes the result. Needs ffmpeg; WebM",
    "with alpha keeps its alpha. A Ludo animation needs none of this: it comes as a spritesheet."
  ],
  flags: [
    { flag: "--fps", value: "n", description: "Frames per second to take (default: the video's)" },
    { flag: "--start", value: "seconds", description: "Where to begin (default 0)" },
    { flag: "--duration", value: "seconds", description: "How long to take (default: to the end)" },
    { flag: "--width", value: "px", description: "Resize frames to this width, keeping the aspect" },
    { flag: "--cols", value: "n", description: "Frames per row (default: a near-square grid)" }
  ],
  async run(ctx: Ctx, call: ToolCall) {
    if (call.args.length !== 1) throw usage("Usage: ludo toolbox sprite from-video <video> [--fps n]");
    const file = call.args[0];
    if (!fs.existsSync(file)) throw usage(`File not found: ${file}`);
    needFfmpeg();
    const fps = positiveNumber(call, "--fps");
    if (fps !== undefined && fps > 120) throw usage("--fps goes up to 120");
    const width = positiveInt(call, "--width");
    if (width !== undefined && (width < 2 || width > 8192)) throw usage("--width takes 2 to 8192");
    const info = probeVideo(file);
    const frames = decodeVideo(file, info, { fps, start: seconds(call, "--start"), duration: seconds(call, "--duration"), width, maxPixels: MAX_TOOLBOX_PIXELS });
    const n = frames.length;
    const cols = Math.min(n, positiveInt(call, "--cols") ?? Math.ceil(Math.sqrt(n)));
    const { sheet, rows } = joinFrames(frames, cols);
    const rate = Math.round((fps ?? info.fps) * 1000) / 1000;
    const grid = { cols, rows, frames: n, fps: rate };
    const out = freeName(ctx.outDir, ctx.globals.name || baseOf(file), ".png");
    writePng(out, sheet, [textChunk(GRID_KEY, JSON.stringify(grid))]);
    const engine = engineFiles(ctx, out, sheet, grid);
    const next = hint("Preview it playing", `ludo preview ${shown(out)}`);
    if (ctx.jsonOut) {
      printJson(
        {
          video: shown(file),
          sheet: shown(out),
          width: sheet.width,
          height: sheet.height,
          grid: { cols, rows, frames: n, frame_width: frames[0].width, frame_height: frames[0].height, fps: rate },
          source: { width: info.width, height: info.height, fps: Math.round(info.fps * 1000) / 1000, codec: info.codec, alpha: info.alpha },
          ...(engine.length ? { engine_files: engine.map(shown) } : {}),
          ...(ctx.globals.quiet ? {} : { hint: next })
        },
        false
      );
    } else {
      process.stdout.write(`${n} frames of ${frames[0].width}x${frames[0].height} at ${rate} fps\n`);
      process.stdout.write(`Saved ${shown(out)} (${cols}x${rows} grid)\n`);
      for (const f of engine) process.stdout.write(`Saved ${shown(f)}\n`);
      if (!ctx.globals.quiet) process.stderr.write(`Next: ${next.text}: ${next.command}\n`);
    }
    return EXIT.OK;
  }
});

TOOLS.push({
  group: "sprite",
  name: "video",
  args: "<sheet>",
  summary: "Turn a spritesheet into a video: WebM or MOV with transparency, or MP4",
  details: [
    "  --format webm  VP9 with alpha: plays in browsers, Unity's VideoPlayer and most engines (default)",
    "  --format mov   ProRes 4444 with alpha: for video editors",
    "  --format mp4   H.264 on --background (MP4 has no transparency): for sharing anywhere",
    "--loops plays the animation that many times in the one file. Needs ffmpeg."
  ],
  flags: [
    { flag: "--format", value: "name", description: "webm (default), mov or mp4" },
    { flag: "--fps", value: "n", description: "Frame rate (default: the sheet's, else 10)" },
    { flag: "--loops", value: "n", description: "Play the animation this many times (default 1)" },
    { flag: "--scale", value: "n", description: "Enlarge every pixel to n x n, for small pixel art (2-16)" },
    { flag: "--background", value: "hex", description: "MP4's background (default #ffffff)" },
    { flag: "--grid", value: "CxR", description: "The sheet's grid, when it has no Ludo stamp and detection is unsure" }
  ],
  async run(ctx: Ctx, call: ToolCall) {
    if (call.args.length !== 1) throw usage("Usage: ludo toolbox sprite video <sheet> [--format webm|mov|mp4]");
    const format = (textFlag(call, "--format") ?? "webm").toLowerCase() as VideoFormat;
    if (!(VIDEO_FORMATS as readonly string[]).includes(format)) throw usage(`--format takes ${VIDEO_FORMATS.join(", ")} (got "${format}")`);
    const loops = positiveInt(call, "--loops") ?? 1;
    if (loops > 100) throw usage("--loops goes up to 100");
    const scale = positiveInt(call, "--scale") ?? 1;
    if (scale > 16) throw usage("--scale goes up to 16");
    const bg = hexColour(textFlag(call, "--background") ?? "#ffffff", "--background");
    const src = loadImageFile(call.args[0]);
    const { grid } = resolveGrid(src, gridFlag(call));
    const fps = positiveNumber(call, "--fps") ?? grid.fps;
    if (fps > 120) throw usage("--fps goes up to 120");
    needFfmpeg();
    const e = src.extrude ?? 0;
    let frames: Image[] = sliceSheet(src.image, grid.cols, grid.rows, grid.frames).map(f => (e ? crop(f, { x: e, y: e, w: f.width - 2 * e, h: f.height - 2 * e }) : f));
    if (scale > 1) frames = frames.map(f => scaleUp(f, scale));
    if (frames[0].width * frames[0].height * frames.length * loops > MAX_TOOLBOX_PIXELS * 4) throw usage("That video would be too big: fewer --loops or a smaller --scale");
    const played = Array.from({ length: loops }, () => frames).flat();
    const out = freeName(ctx.outDir, ctx.globals.name || baseOf(src.file), `.${format}`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const size = encodeVideo(played, fps, format, out, [bg[0], bg[1], bg[2]]);
    const bytes = fs.statSync(out).size;
    const next = hint("Animate another move for the same character with Ludo", `ludo sprite animate --initial-image <a frame> --motion-prompt "<what it does>"`);
    if (ctx.jsonOut) {
      printJson(
        {
          sheet: shown(src.file),
          video: shown(out),
          format,
          width: size.width,
          height: size.height,
          frames: played.length,
          fps,
          seconds: Math.round((played.length / fps) * 1000) / 1000,
          transparent: format !== "mp4",
          bytes,
          ...(ctx.globals.quiet ? {} : { hint: next })
        },
        false
      );
    } else {
      process.stdout.write(`${played.length} frames of ${size.width}x${size.height} at ${fps} fps (${(played.length / fps).toFixed(2)} s), ${format === "mp4" ? "on a background" : "transparent"}\n`);
      process.stdout.write(`Saved ${shown(out)} (${Math.max(1, Math.round(bytes / 1024))} KB)\n`);
      if (!ctx.globals.quiet) process.stderr.write(`Next: ${next.text}: ${next.command}\n`);
    }
    return EXIT.OK;
  }
});
