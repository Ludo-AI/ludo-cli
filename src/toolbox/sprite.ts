import fs from "node:fs";
import path from "node:path";
import { CliError, EXIT } from "../errors.js";
import { printJson, type Ctx } from "../generate.js";
import type { Grid } from "../tty/preview.js";
import { backgroundOf, CONFIDENT, countFrames, guessGrid } from "./grid.js";
import { baseOf, carriedChunks, freeName, loadImageFile, shown, writePng, type Loaded } from "./io.js";
import { joinFrames, sliceSheet } from "./sheet.js";
import { applyFrameOps, parseFrameList, parseHolds, type FrameOps } from "./frames.js";
import { analyseLoop, frameDifferences } from "./loop.js";
import { gridFlag, positiveInt, positiveNumber } from "./flags.js";
import { hint, TOOLS, type ToolCall } from "./registry.js";

// A sheet's grid: --grid, else its Ludo stamp, else detected. A detection
// that is not sure refuses (exit code 12) with its best guess.
function sheetGrid(src: Loaded, call: ToolCall): { grid: Grid; from: "flag" | "stamp" | "detected"; confidence?: number } {
  const { width, height } = src.image;
  const flagGrid = gridFlag(call);
  let out: ReturnType<typeof sheetGrid>;
  if (flagGrid) {
    out = { grid: { ...flagGrid, frames: countFrames(src.image, flagGrid.cols, flagGrid.rows), fps: src.grid?.fps ?? 10 }, from: "flag" };
  } else if (src.grid) {
    out = { grid: src.grid, from: "stamp" };
  } else {
    const guess = guessGrid(src.image);
    if (guess.confidence < CONFIDENT) {
      const sure = (a: typeof guess.x) => a.confidence >= CONFIDENT;
      const best = `${sure(guess.x) ? guess.x.count : "?"} columns x ${sure(guess.y) ? guess.y.count : "?"} rows`;
      throw new CliError(
        `Could not tell the grid of ${src.file} for sure (best guess: ${best})`,
        EXIT.BAD_INPUT,
        `Pass it with --grid ${sure(guess.x) ? guess.x.count : "<columns>"}x${sure(guess.y) ? guess.y.count : "<rows>"}.`,
        { guess: { cols: guess.cols, rows: guess.rows, confidence: Math.round(guess.confidence * 100) / 100 } }
      );
    }
    out = { grid: { cols: guess.cols, rows: guess.rows, frames: guess.frames, fps: 10 }, from: "detected", confidence: Math.round(guess.confidence * 100) / 100 };
  }
  if (out.grid.cols > width || out.grid.rows > height) {
    throw new CliError(`A ${out.grid.cols}x${out.grid.rows} grid does not fit a ${width}x${height} image`, EXIT.USAGE);
  }
  return out;
}

// "walk-2.png" before "walk-10.png".
const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

// The files to join: each argument is a PNG, or a folder whose PNGs are
// taken in natural order.
function frameFiles(args: string[]): string[] {
  return args.flatMap(arg => {
    const stat = fs.statSync(arg, { throwIfNoEntry: false });
    if (!stat?.isDirectory()) return [arg];
    const pngs = fs.readdirSync(arg).filter(f => /\.png$/i.test(f)).sort(natural.compare);
    if (!pngs.length) throw new CliError(`No PNG files in ${arg}`, EXIT.USAGE);
    return pngs.map(f => path.join(arg, f));
  });
}

// walk-01.png ... walk-12.png -> "walk"
function commonBase(files: string[]): string {
  const names = files.map(f => baseOf(f).replace(/[-_ .]*\d+$/, ""));
  return names.every(n => n === names[0]) && names[0] ? names[0] : "sheet";
}

TOOLS.push({
  group: "sprite",
  name: "slice",
  args: "<sheet>",
  summary: "Cut a spritesheet into one PNG per frame",
  details: [
    "The grid comes from --grid, else from the sheet's Ludo stamp (sheets the CLI downloaded carry",
    "one), else it is detected. A detection that is not sure stops and asks for --grid (exit code 12).",
    "Empty cells at the end of the sheet are padding, not frames. A packed atlas (frames of",
    "different sizes) is not a grid, so detection refuses it."
  ],
  flags: [
    { flag: "--grid", value: "CxR", description: "Columns x rows, like 6x4" },
    { flag: "--frames", value: "n", description: "Keep the first n frames (default: the stamp's count, else up to the last non-empty cell)" }
  ],
  async run(ctx: Ctx, call: ToolCall) {
    if (call.args.length !== 1) throw new CliError("Usage: ludo toolbox sprite slice <sheet> [--grid CxR]", EXIT.USAGE);
    const src = loadImageFile(call.args[0]);
    const wanted = positiveInt(call, "--frames");

    const { grid, from, confidence } = sheetGrid(src, call);
    const cells = grid.cols * grid.rows;
    if (wanted !== undefined && wanted > cells) throw new CliError(`--frames ${wanted} is more than the ${cells} cells of a ${grid.cols}x${grid.rows} grid`, EXIT.USAGE);
    const frames = Math.min(wanted ?? grid.frames, cells);

    const images = sliceSheet(src.image, grid.cols, grid.rows, frames);
    const base = ctx.globals.name || baseOf(src.file);
    const dir = freeName(ctx.outDir, base);
    const digits = Math.max(2, String(frames).length);
    const chunks = carriedChunks(src);
    const files = images.map((img, i) => {
      const file = path.join(dir, `${base}-${String(i + 1).padStart(digits, "0")}.png`);
      writePng(file, img, chunks);
      return file;
    });

    const frameSize = { frame_width: images[0].width, frame_height: images[0].height };
    const next = hint("Turn a frame into a new animation with Ludo", `ludo sprite animate --initial-image ${shown(files[0])} --motion-prompt "<what it does>"`);
    if (ctx.jsonOut) {
      printJson(
        {
          sheet: shown(src.file),
          grid: { cols: grid.cols, rows: grid.rows, frames, ...frameSize, fps: grid.fps },
          grid_from: from,
          ...(confidence !== undefined ? { confidence } : {}),
          dir: shown(dir),
          files: files.map(shown),
          ...(ctx.globals.quiet ? {} : { hint: next })
        },
        false
      );
    } else {
      const how = from === "flag" ? "from --grid" : from === "stamp" ? "from its Ludo stamp" : `detected, ${Math.round(confidence! * 100)}% sure`;
      process.stdout.write(`${frames} frames of ${frameSize.frame_width}x${frameSize.frame_height} (${grid.cols}x${grid.rows} grid, ${how})\n`);
      process.stdout.write(`Saved to ${shown(dir)}${path.sep}\n`);
      if (!ctx.globals.quiet) process.stderr.write(`Next: ${next.text}: ${next.command}\n`);
    }
    return EXIT.OK;
  }
});

TOOLS.push({
  group: "sprite",
  name: "join",
  args: "<frames...>",
  summary: "Put frames back together into one spritesheet",
  details: [
    "Frames are PNG files, or folders of them taken in natural order (walk-2 before walk-10).",
    "Frames of different sizes are centred in cells of the largest one. The sheet remembers its",
    "grid, so `ludo preview` plays it and `ludo toolbox sprite slice` cuts it back exactly."
  ],
  flags: [
    { flag: "--cols", value: "n", description: "Frames per row (default: a near-square grid)" },
    { flag: "--fps", value: "n", description: "Frame rate the sheet remembers for previews and exports (default: 10)" }
  ],
  async run(ctx: Ctx, call: ToolCall) {
    if (!call.args.length) throw new CliError("Usage: ludo toolbox sprite join <frames...> [--cols n]", EXIT.USAGE);
    const files = frameFiles(call.args);
    const frames = files.map(loadImageFile);
    const cols = Math.min(positiveInt(call, "--cols") ?? Math.ceil(Math.sqrt(frames.length)), frames.length);
    const fps = positiveNumber(call, "--fps") ?? 10;
    const { sheet, cellW, cellH, rows } = joinFrames(
      frames.map(f => f.image),
      cols
    );
    const grid: Grid = { cols, rows, frames: frames.length, fps };
    const file = freeName(ctx.outDir, ctx.globals.name || commonBase(files), ".png");
    writePng(file, sheet, carriedChunks(frames[0], grid));
    const resized = frames.some(f => f.image.width !== cellW || f.image.height !== cellH);

    const next = hint("Preview it playing", `ludo preview ${shown(file)}`);
    if (ctx.jsonOut) {
      printJson(
        {
          sheet: shown(file),
          grid: { cols, rows, frames: frames.length, frame_width: cellW, frame_height: cellH, fps },
          centred: resized,
          ...(ctx.globals.quiet ? {} : { hint: next })
        },
        false
      );
    } else {
      process.stdout.write(`${frames.length} frames of ${cellW}x${cellH} in a ${cols}x${rows} grid${resized ? " (smaller frames centred)" : ""}\n`);
      process.stdout.write(`Saved ${shown(file)}\n`);
      if (!ctx.globals.quiet) process.stderr.write(`Next: ${next.text}: ${next.command}\n`);
    }
    return EXIT.OK;
  }
});

TOOLS.push({
  group: "sprite",
  name: "frames",
  args: "<sheet>",
  summary: "Drop, reorder, reverse, ping-pong or hold frames of a spritesheet",
  details: [
    "Frame numbers start at 1 and always mean the original sheet's frames. The edits apply in this",
    "order, whatever the order of the flags: --order, --drop, --reverse, --pingpong, --hold.",
    "A PNG has no timing, so --hold repeats the frame in the sheet. The result keeps the frame size",
    "and is saved as a new sheet unless --in-place."
  ],
  flags: [
    { flag: "--drop", value: "frames", description: "Remove these frames: 3 or 1,5-7" },
    { flag: "--order", value: "frames", description: "Keep these frames in this order: 1-4,8,6 (repeats allowed)" },
    { flag: "--reverse", description: "Play backwards" },
    { flag: "--pingpong", description: "Play forward then back, without repeating the first and last frame" },
    { flag: "--hold", value: "FxN", description: "Show frame F N times: 4x3, or 4x3,9x2" },
    { flag: "--cols", value: "n", description: "Frames per row in the result (default: the sheet's)" },
    { flag: "--fps", value: "n", description: "Frame rate the result remembers (default: the sheet's, else 10)" },
    { flag: "--grid", value: "CxR", description: "The sheet's grid, when it has no Ludo stamp and detection is unsure" },
    { flag: "--in-place", description: "Replace the input sheet instead of saving a new one" }
  ],
  async run(ctx: Ctx, call: ToolCall) {
    if (call.args.length !== 1) throw new CliError("Usage: ludo toolbox sprite frames <sheet> [--drop 3] [--hold 4x2] ...", EXIT.USAGE);
    const src = loadImageFile(call.args[0]);
    const { grid } = sheetGrid(src, call);
    const n = grid.frames;
    const text = (flag: string) => {
      const v = call.flags.get(flag);
      return typeof v === "string" ? v : undefined;
    };
    const parsed = <T>(fn: () => T): T => {
      try {
        return fn();
      } catch (err) {
        throw new CliError((err as Error).message, EXIT.USAGE);
      }
    };
    const ops: FrameOps = {
      order: text("--order") !== undefined ? parsed(() => parseFrameList(text("--order")!, n, "--order")) : undefined,
      drop: text("--drop") !== undefined ? parsed(() => parseFrameList(text("--drop")!, n, "--drop")) : undefined,
      reverse: call.flags.has("--reverse"),
      pingpong: call.flags.has("--pingpong"),
      hold: text("--hold") !== undefined ? parsed(() => parseHolds(text("--hold")!, n, "--hold")) : undefined
    };
    if (!ops.order && !ops.drop && !ops.reverse && !ops.pingpong && !ops.hold) {
      throw new CliError("Nothing to do: pass --drop, --order, --reverse, --pingpong or --hold", EXIT.USAGE);
    }
    const order = applyFrameOps(n, ops);
    if (!order.length) throw new CliError("No frames left", EXIT.USAGE);
    if (order.length > 4096) throw new CliError(`That makes ${order.length} frames; the limit is 4096`, EXIT.USAGE);

    const cells = sliceSheet(src.image, grid.cols, grid.rows, n);
    const cols = Math.min(positiveInt(call, "--cols") ?? grid.cols, order.length);
    const fps = positiveNumber(call, "--fps") ?? grid.fps;
    const { sheet, cellW, cellH, rows } = joinFrames(
      order.map(f => cells[f - 1]),
      cols
    );
    const out: Grid = { cols, rows, frames: order.length, fps };
    const inPlace = call.flags.has("--in-place");
    if (inPlace && !/\.png$/i.test(src.file)) throw new CliError("--in-place only replaces PNG files", EXIT.USAGE);
    const file = inPlace ? src.file : freeName(ctx.outDir, ctx.globals.name || baseOf(src.file), ".png");
    writePng(file, sheet, carriedChunks(src, out));

    const next = hint("Preview it playing", `ludo preview ${shown(file)}`);
    if (ctx.jsonOut) {
      printJson(
        {
          sheet: shown(file),
          grid: { cols, rows, frames: order.length, frame_width: cellW, frame_height: cellH, fps },
          order,
          ...(ctx.globals.quiet ? {} : { hint: next })
        },
        false
      );
    } else {
      process.stdout.write(`${n} frames -> ${order.length}: ${order.join(" ")}\n`);
      process.stdout.write(`${inPlace ? "Replaced" : "Saved"} ${shown(file)} (${cols}x${rows} grid)\n`);
      if (!ctx.globals.quiet) process.stderr.write(`Next: ${next.text}: ${next.command}\n`);
    }
    return EXIT.OK;
  }
});

TOOLS.push({
  group: "sprite",
  name: "loop",
  args: "<sheet>",
  summary: "Check that an animation loops, and find the best loop inside it",
  details: [
    "Compares every frame with every other (the frame-difference matrix of Video Textures,",
    "Schödl et al. 2000) and reads the seam from the last frame back to the first against the",
    "animation's typical step: about one step is smooth, much more is a jump, almost none means the",
    "last frame repeats the first (the loop stutters). When the seam is bad it finds the longest",
    "run of frames that loops cleanly; --apply saves the sheet trimmed to it. Held frames",
    "(--hold) do not count as steps, and a ping-pong is reported as mirrored."
  ],
  flags: [
    { flag: "--apply", description: "Save the sheet trimmed to the best loop" },
    { flag: "--min-frames", value: "n", description: "Shortest loop worth keeping (default: half the frames)" },
    { flag: "--cols", value: "n", description: "Frames per row in the trimmed sheet (default: the sheet's)" },
    { flag: "--grid", value: "CxR", description: "The sheet's grid, when it has no Ludo stamp and detection is unsure" },
    { flag: "--in-place", description: "With --apply, replace the input sheet instead of saving a new one" }
  ],
  async run(ctx: Ctx, call: ToolCall) {
    if (call.args.length !== 1) throw new CliError("Usage: ludo toolbox sprite loop <sheet> [--apply]", EXIT.USAGE);
    const src = loadImageFile(call.args[0]);
    const { grid, from } = sheetGrid(src, call);
    const n = grid.frames;
    if (n < 2) throw new CliError(`${src.file} has a single frame; there is nothing to loop`, EXIT.BAD_INPUT);
    const minFrames = positiveInt(call, "--min-frames");
    if (minFrames !== undefined && minFrames > n) throw new CliError(`--min-frames ${minFrames} is more than the sheet's ${n} frames`, EXIT.USAGE);
    const apply = call.flags.has("--apply");
    const inPlace = call.flags.has("--in-place");
    if (inPlace && !apply) throw new CliError("--in-place only goes with --apply", EXIT.USAGE);

    const cells = sliceSheet(src.image, grid.cols, grid.rows, n);
    const report = analyseLoop(frameDifferences(cells, backgroundOf(src.image)), minFrames);
    const { best, seam } = report;
    const trims = !!best && best.frames < n;

    if (apply && !best && seam.verdict !== "static") {
      throw new CliError(
        `No run of frames in ${src.file} loops cleanly, so nothing was trimmed`,
        EXIT.BAD_INPUT,
        "If Ludo made it, Ludo can re-cut the loop from its source video, free: ludo sprite adjust --spritesheet-url <its spritesheet_url> --loop",
        { seam, steps: report.steps }
      );
    }
    let saved: string | undefined;
    if (apply && trims) {
      if (inPlace && !/\.png$/i.test(src.file)) throw new CliError("--in-place only replaces PNG files", EXIT.USAGE);
      const cols = Math.min(positiveInt(call, "--cols") ?? grid.cols, best.frames);
      const { sheet, rows } = joinFrames(cells.slice(best.start - 1, best.end), cols);
      saved = inPlace ? src.file : freeName(ctx.outDir, ctx.globals.name || baseOf(src.file), ".png");
      writePng(saved, sheet, carriedChunks(src, { cols, rows, frames: best.frames, fps: grid.fps }));
    }

    const sheetArg = shown(src.file);
    const next =
      seam.verdict === "static"
        ? undefined
        : !best
          ? hint("If Ludo made it, Ludo can re-cut the loop from its source video, free", "ludo sprite adjust --spritesheet-url <its spritesheet_url> --loop")
          : trims && !apply
            ? hint("Trim it to that loop", `ludo toolbox sprite loop ${sheetArg} --apply`)
            : hint("Preview it playing", `ludo preview ${shown(saved ?? src.file)}`);

    if (ctx.jsonOut) {
      printJson(
        {
          sheet: sheetArg,
          grid: { cols: grid.cols, rows: grid.rows, frames: n, frame_width: cells[0].width, frame_height: cells[0].height, fps: grid.fps },
          grid_from: from,
          seam,
          steps: report.steps,
          holds: report.holds,
          jumps: report.jumps,
          mirrored: report.mirrored,
          best: best ?? null,
          ...(apply ? { applied: saved ? shown(saved) : null } : {}),
          // n x n numbers stop being useful to anyone well before 64 frames.
          ...(n <= 64 ? { matrix: report.matrix } : {}),
          ...(ctx.globals.quiet || !next ? {} : { hint: next })
        },
        false
      );
    } else {
      const out = (line: string) => process.stdout.write(line + "\n");
      out(`${n} frames (${grid.cols}x${grid.rows} grid${from === "stamp" ? ", from its Ludo stamp" : from === "flag" ? "" : ", detected"})`);
      const seamText = `${n} -> 1 is ${seam.ratio}x a typical step`;
      if (seam.verdict === "static") out("No frame moves: there is nothing to loop.");
      else if (seam.verdict === "smooth") out(`Loops smoothly: the seam ${seamText}.`);
      else if (seam.verdict === "repeat") {
        out(seam.repeats === 1 ? "The last frame repeats the first, so the loop shows it twice." : `The last ${seam.repeats} frames repeat the first ${seam.repeats}, so the loop shows them twice.`);
      }
      else out(`Jumps at the seam: ${seamText}.`);
      if (report.mirrored) out("It plays forward then back (a ping-pong).");
      if (report.holds.length) out(`Held frames: ${report.holds.join(", ")}.`);
      if (report.jumps.length) out(`Big steps (over twice the typical one) into frames ${report.jumps.join(", ")}.`);
      if (seam.verdict !== "static" && seam.verdict !== "smooth") {
        out(best ? `Best loop: frames ${best.start}-${best.end} (${best.frames} frames, seam ${best.seam}x a step).` : "No run of frames inside it loops cleanly.");
      }
      if (seam.verdict !== "static") out(`Steps: ${report.steps.slice(0, -1).join(" ")} | seam ${seam.ratio}`);
      if (apply) out(saved ? `${inPlace ? "Replaced" : "Saved"} ${shown(saved)} (frames ${best!.start}-${best!.end})` : "Nothing written.");
      if (!ctx.globals.quiet && next) process.stderr.write(`Next: ${next.text}: ${next.command}\n`);
    }
    return EXIT.OK;
  }
});
