import fs from "node:fs";
import path from "node:path";
import { CliError, EXIT } from "../errors.js";
import { printJson, type Ctx } from "../generate.js";
import { parseGrid, type Grid } from "../tty/preview.js";
import { CONFIDENT, countFrames, guessGrid } from "./grid.js";
import { baseOf, carriedChunks, freeName, loadImageFile, shown, writePng, type Loaded } from "./io.js";
import { joinFrames, sliceSheet } from "./sheet.js";
import { applyFrameOps, parseFrameList, parseHolds, type FrameOps } from "./frames.js";
import { hint, TOOLS, type ToolCall } from "./registry.js";

function positiveInt(call: ToolCall, flag: string): number | undefined {
  const raw = call.flags.get(flag);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (raw === true || !Number.isInteger(n) || n < 1) throw new CliError(`${flag} must be a whole number above 0`, EXIT.USAGE);
  return n;
}

function positiveNumber(call: ToolCall, flag: string): number | undefined {
  const raw = call.flags.get(flag);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (raw === true || !Number.isFinite(n) || n <= 0) throw new CliError(`${flag} must be a number above 0`, EXIT.USAGE);
  return n;
}

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

function gridFlag(call: ToolCall): { cols: number; rows: number } | undefined {
  const raw = call.flags.get("--grid");
  if (raw === undefined) return undefined;
  const grid = typeof raw === "string" ? parseGrid(raw) : undefined;
  if (!grid || grid.cols < 1 || grid.rows < 1) throw new CliError(`--grid takes columns x rows, like --grid 6x4 (got "${raw}")`, EXIT.USAGE);
  return grid;
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
