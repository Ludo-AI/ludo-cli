import fs from "node:fs";
import path from "node:path";
import { CliError, EXIT } from "../errors.js";
import { printJson, type Ctx } from "../generate.js";
import type { Grid } from "../tty/preview.js";
import { backgroundOf, CONFIDENT, countFrames, guessGrid } from "./grid.js";
import { baseOf, carriedChunks, engineFiles, freeName, loadImageFile, shown, writePng, type Layout, type Loaded } from "./io.js";
import { noteFact } from "../telemetry.js";
import { crop, joinFrames, sliceSheet } from "./sheet.js";
import { applyFrameOps, parseFrameList, parseHolds, type FrameOps } from "./frames.js";
import { analyseLoop, CLEAN, frameDifferences, VISIBLE, type LoopReport } from "./loop.js";
import { gridFlag, hexColour, positiveInt, positiveNumber, textFlag } from "./flags.js";
import { makeGif, MAX_GIF_FPS } from "./gif.js";
import { scaleUp } from "./pixels.js";
import { MAX_TOOLBOX_PIXELS } from "../tty/png.js";
import { hint, TOOLS, type ToolCall } from "./registry.js";
// Used when a tool runs, never as the modules load: the two import each other.
import { metricsOrFail, pivotChoice, sheetFrames } from "./sprite-analysis.js";

// A sheet's grid: --grid, else its Ludo stamp (or a GIF's frames), else detected.
// A detection that is not sure refuses (exit code 12) with its best guess.
function sheetGrid(src: Loaded, call: ToolCall) {
  return resolveGrid(src, gridFlag(call));
}

export function resolveGrid(src: Loaded, flagGrid: { cols: number; rows: number } | undefined, flag = "--grid"): { grid: Grid; from: "flag" | "stamp" | "gif" | "webp" | "detected"; confidence?: number } {
  const { width, height } = src.image;
  let out: ReturnType<typeof resolveGrid>;
  if (flagGrid) {
    out = { grid: { ...flagGrid, frames: countFrames(src.image, flagGrid.cols, flagGrid.rows), fps: src.grid?.fps ?? 10 }, from: "flag" };
  } else if (src.grid) {
    out = { grid: src.grid, from: src.animation ?? "stamp" };
  } else {
    const guess = guessGrid(src.image);
    if (guess.confidence < CONFIDENT) {
      const sure = (a: typeof guess.x) => a.confidence >= CONFIDENT;
      const best = `${sure(guess.x) ? guess.x.count : "?"} columns x ${sure(guess.y) ? guess.y.count : "?"} rows`;
      noteFact("grid_from", "unsure");
      throw new CliError(
        `Could not tell the grid of ${src.file} for sure (best guess: ${best})`,
        EXIT.BAD_INPUT,
        `Pass it with ${flag} ${sure(guess.x) ? guess.x.count : "<columns>"}x${sure(guess.y) ? guess.y.count : "<rows>"}.`,
        { guess: { cols: guess.cols, rows: guess.rows, confidence: Math.round(guess.confidence * 100) / 100 } }
      );
    }
    out = { grid: { cols: guess.cols, rows: guess.rows, frames: guess.frames, fps: 10 }, from: "detected", confidence: Math.round(guess.confidence * 100) / 100 };
  }
  noteFact("grid_from", out.from);
  noteFact("frames", out.grid.frames);
  if (out.grid.cols > width || out.grid.rows > height) {
    throw new CliError(`A ${out.grid.cols}x${out.grid.rows} grid does not fit a ${width}x${height} image`, EXIT.USAGE);
  }
  return out;
}

const layoutOf = (src: Loaded): Layout => ({ trim: src.trim, extrude: src.extrude });

const savedLines = (files: string[]) => files.map(f => `Saved ${shown(f)}\n`).join("");

// "walk-2.png" before "walk-10.png".
export const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

// The files to join: each argument is a PNG, or a folder whose PNGs are
// taken in natural order.
export function frameFiles(args: string[]): string[] {
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

    // An extruded sheet's frames come out without the repeated border, and
    // each keeps the sheet's trim record, so joining them back restores both.
    const e = src.extrude ?? 0;
    const images = sliceSheet(src.image, grid.cols, grid.rows, frames).map(img => (e ? crop(img, { x: e, y: e, w: img.width - 2 * e, h: img.height - 2 * e }) : img));
    const base = ctx.globals.name || baseOf(src.file);
    const dir = freeName(ctx.outDir, base);
    const digits = Math.max(2, String(frames).length);
    const chunks = carriedChunks(src, undefined, { trim: src.trim });
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
      const how = from === "flag" ? "from --grid" : from === "stamp" ? "from its Ludo stamp" : from === "gif" ? "the GIF's frames" : from === "webp" ? "the WebP's frames" : `detected, ${Math.round(confidence! * 100)}% sure`;
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
    const resized = frames.some(f => f.image.width !== cellW || f.image.height !== cellH);
    // Frames that all say the same about themselves (cut from one trimmed or
    // extruded sheet) pass it on to the new sheet.
    const shared = (pick: (f: Loaded) => unknown) => frames.every(f => JSON.stringify(pick(f)) === JSON.stringify(pick(frames[0])));
    const layout: Layout = resized ? {} : { trim: shared(f => f.trim) ? frames[0].trim : undefined, extrude: shared(f => f.extrude) ? frames[0].extrude : undefined };
    writePng(file, sheet, carriedChunks(frames[0], grid, layout));
    const engine = engineFiles(ctx, file, sheet, grid, layout);

    const next = hint("Preview it playing", `ludo preview ${shown(file)}`);
    if (ctx.jsonOut) {
      printJson(
        {
          sheet: shown(file),
          grid: { cols, rows, frames: frames.length, frame_width: cellW, frame_height: cellH, fps },
          centred: resized,
          ...(engine.length ? { engine_files: engine.map(shown) } : {}),
          ...(ctx.globals.quiet ? {} : { hint: next })
        },
        false
      );
    } else {
      process.stdout.write(`${frames.length} frames of ${cellW}x${cellH} in a ${cols}x${rows} grid${resized ? " (smaller frames centred)" : ""}\n`);
      process.stdout.write(savedLines([file, ...engine]));
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
    writePng(file, sheet, carriedChunks(src, out, layoutOf(src)));
    const engine = engineFiles(ctx, file, sheet, out, layoutOf(src));

    const next = hint("Preview it playing", `ludo preview ${shown(file)}`);
    if (ctx.jsonOut) {
      printJson(
        {
          sheet: shown(file),
          grid: { cols, rows, frames: order.length, frame_width: cellW, frame_height: cellH, fps },
          order,
          ...(engine.length ? { engine_files: engine.map(shown) } : {}),
          ...(ctx.globals.quiet ? {} : { hint: next })
        },
        false
      );
    } else {
      process.stdout.write(`${n} frames -> ${order.length}: ${order.join(" ")}\n`);
      process.stdout.write(`${inPlace ? "Replaced" : "Saved"} ${shown(file)} (${cols}x${rows} grid)\n${savedLines(engine)}`);
      if (!ctx.globals.quiet) process.stderr.write(`Next: ${next.text}: ${next.command}\n`);
    }
    return EXIT.OK;
  }
});

// One sheet's loop report. A sheet of one frame has nothing to loop.
function inspectLoop(call: ToolCall, file: string) {
  const src = loadImageFile(file);
  const { grid, from } = sheetGrid(src, call);
  const n = grid.frames;
  if (n < 2) throw new CliError(`${src.file} has a single frame; there is nothing to loop`, EXIT.BAD_INPUT);
  const cells = sliceSheet(src.image, grid.cols, grid.rows, n);
  return { src, grid, from, cells, report: analyseLoop(frameDifferences(cells, backgroundOf(src.image))) };
}

const qualityWord = (q: number | null) => (q === null ? "static" : q >= CLEAN ? "loops cleanly" : q >= VISIBLE ? "a small hitch at the seam" : "a hitch at the seam");
const seamText = (r: LoopReport) =>
  r.seam.verdict === "repeat" ? `the last ${r.seam.repeats === 1 ? "frame repeats the first" : `${r.seam.repeats} frames repeat the first ${r.seam.repeats}`}` : `seam ${r.seam.ratio}x a typical step`;

// Several takes of one animation, the best loop first.
function compareLoops(ctx: Ctx, call: ToolCall): number {
  const rows = call.args.map(file => {
    const { src, grid, report } = inspectLoop(call, file);
    return { sheet: shown(src.file), frames: grid.frames, quality: report.quality, seam: report.seam, jumps: report.jumps, holds: report.holds, mirrored: report.mirrored, report };
  });
  rows.sort((a, b) => (b.quality ?? -1) - (a.quality ?? -1));
  const top = rows[0];
  const listed = rows.map(({ report, ...row }) => row);
  const next = top.quality !== null ? hint("Preview the best one", `ludo preview ${top.sheet}`) : undefined;
  if (ctx.jsonOut) {
    printJson({ sheets: listed, best: top.quality !== null ? top.sheet : null, ...(ctx.globals.quiet || !next ? {} : { hint: next }) }, false);
    return EXIT.OK;
  }
  const width = Math.max(...rows.map(r => r.sheet.length));
  process.stdout.write(`${rows.length} sheets, the best loop first:\n`);
  rows.forEach((r, i) =>
    process.stdout.write(
      `  ${String(i + 1).padStart(2)}. ${r.sheet.padEnd(width)}  ${r.quality === null ? "  -" : r.quality.toFixed(2)}  ${qualityWord(r.quality)}` +
        `${r.quality === null ? "" : ` (${seamText(r.report)})`}${r.jumps.length ? `; big steps into ${r.jumps.join(", ")}` : ""}\n`
    )
  );
  if (!ctx.globals.quiet && next) process.stderr.write(`Next: ${next.text}: ${next.command}\n`);
  return EXIT.OK;
}

TOOLS.push({
  group: "sprite",
  name: "loop",
  args: "<sheet> [<sheet>...]",
  summary: "How well an animation loops (0 to 1), or which of several takes loops best",
  details: [
    "Compares every frame with every other (the frame-difference matrix of Video Textures,",
    "Schödl et al. 2000) and scores the seam, the step from the last frame back to the first,",
    `against the animation's typical step: 1 when it plays like any other step, ${CLEAN} and up clean,`,
    `under ${VISIBLE} a hitch a player sees. Much bigger is a jump; much smaller, the motion hovering at`,
    "the loop point; none, a pose shown twice. Big steps inside the clip are listed, not scored.",
    "Held frames (--hold) do not count, and a ping-pong is reported as mirrored. Given several sheets",
    "(takes of one animation, like `--n 4`), it ranks them, the best loop first. It only measures,",
    "and never cuts. Ludo's sheets come cut to their loop already; if one of Ludo's does not loop,",
    "`ludo sprite edit --edit-mode fix_loop` repairs it."
  ],
  flags: [{ flag: "--grid", value: "CxR", description: "The sheet's grid, when it has no Ludo stamp and detection is unsure" }],
  async run(ctx: Ctx, call: ToolCall) {
    if (!call.args.length) throw new CliError("Usage: ludo toolbox sprite loop <sheet> [<sheet>...]", EXIT.USAGE);
    if (call.args.length > 1) return compareLoops(ctx, call);
    const { src, grid, from, cells, report } = inspectLoop(call, call.args[0]);
    const n = grid.frames;
    const { seam, quality } = report;
    const sheetArg = shown(src.file);
    const next =
      quality === null
        ? undefined
        : quality >= VISIBLE
          ? hint("Preview it playing", `ludo preview ${sheetArg}`)
          : hint("If Ludo made it, Ludo can repair the loop (1 credit a second)", "ludo sprite edit --spritesheet-url <its spritesheet_url> --edit-mode fix_loop");

    if (ctx.jsonOut) {
      printJson(
        {
          sheet: sheetArg,
          grid: { cols: grid.cols, rows: grid.rows, frames: n, frame_width: cells[0].width, frame_height: cells[0].height, fps: grid.fps },
          grid_from: from,
          quality,
          seam,
          steps: report.steps,
          holds: report.holds,
          jumps: report.jumps,
          mirrored: report.mirrored,
          // n x n numbers stop being useful to anyone well before 64 frames.
          ...(n <= 64 ? { matrix: report.matrix } : {}),
          ...(ctx.globals.quiet || !next ? {} : { hint: next })
        },
        false
      );
    } else {
      const out = (line: string) => process.stdout.write(line + "\n");
      out(`${n} frames (${grid.cols}x${grid.rows} grid${from === "stamp" ? ", from its Ludo stamp" : from === "gif" ? ", the GIF's frames" : from === "webp" ? ", the WebP's frames" : from === "flag" ? "" : ", detected"})`);
      if (quality === null) out("No frame moves: there is nothing to loop.");
      else {
        out(`Loop quality ${quality.toFixed(2)}: ${qualityWord(quality)} (${seamText(report)}, ${n} -> 1).`);
        if (seam.verdict === "repeat") out("So the loop shows that pose twice.");
        if (report.mirrored) out("It plays forward then back (a ping-pong).");
        if (report.holds.length) out(`Held frames: ${report.holds.join(", ")}.`);
        if (report.jumps.length) out(`Big steps (over twice the typical one) into frames ${report.jumps.join(", ")}.`);
        out(`Steps: ${report.steps.slice(0, -1).join(" ")} | seam ${seam.ratio}`);
      }
      if (!ctx.globals.quiet && next) process.stderr.write(`Next: ${next.text}: ${next.command}\n`);
    }
    return EXIT.OK;
  }
});

// One scene per sheet: Godot characters usually play every move on one
// AnimatedSprite2D, whose one offset fits all of them only when they share
// the frame size and pivot.
const GODOT_ONE_SHEET =
  "The .tscn is an AnimatedSprite2D playing this sheet, its offset on the node. To play a character's moves on one AnimatedSprite2D, they share that offset: right only when the sheets have one frame size and pivot (`ludo toolbox sprite compare <its sheets>` says), otherwise keep a node per sheet or change the offset with the animation.";

TOOLS.push({
  group: "sprite",
  name: "export",
  args: "<sheet>",
  summary: "Write engine files for a spritesheet: a TexturePacker JSON atlas, Godot SpriteFrames or Unity sprites",
  details: [
    "The files go next to the sheet, which they refer to by name: keep them side by side.",
    "  --engine texturepacker  a JSON atlas (TexturePacker's JSON Hash) for PixiJS (Assets.load,",
    "                          sheet.animations) and Phaser (load.atlas, anims.createFromAseprite)",
    "  --engine godot          a Godot 4 SpriteFrames .tres for an AnimatedSprite2D",
    "  --engine unity          the sheet's .png.meta, which imports it sliced into one sprite per frame,",
    "                          and an .anim clip that plays them on a SpriteRenderer (in a Unity project,",
    "                          export a sheet under Assets/; an existing .meta keeps its guid)",
    "Frames are keyed 0, 1, 2... in playing order. A sheet trimmed or extruded by `ludo toolbox image`",
    "exports each frame's original size and offset, and keeps the repeated border out of the frames.",
    "Any toolbox tool that writes a sheet also takes --engine.",
    "",
    "Without --pivot every frame pivots on its centre. --pivot feet puts it on the ground line between",
    "the feet, as `ludo toolbox sprite metrics` measures it (a sheet that does not stand on a ground line",
    "gets its centre of mass, and the output says so); mass or X,Y (frame pixels) also work. Unity gets",
    "it as each sprite's custom pivot; Godot, whose SpriteFrames has none, also gets a .tscn scene: an",
    "AnimatedSprite2D playing this one sheet, with the offset that puts the pivot at the node's origin",
    "(one offset per node: a character's sheets share one AnimatedSprite2D only with one frame size and",
    "pivot). --ppu sets Unity's pixels per unit (default 100): use the one `ludo toolbox sprite compare`",
    "gives the character. Godot 2D, PixiJS and Phaser draw one pixel per unit and take no --ppu."
  ],
  flags: [
    { flag: "--animation", value: "name", description: "The animation's name (default: the file's name; \"default\" for Godot)" },
    { flag: "--fps", value: "n", description: "Frame rate (default: the sheet's, else 10)" },
    { flag: "--pivot", value: "feet|mass|X,Y", description: "Godot and Unity: pivot on the ground line between the feet, the centre of mass, or X,Y in frame pixels (default: the frame's centre)" },
    { flag: "--ppu", value: "n", description: "Unity's pixels per unit (default 100)" },
    { flag: "--grid", value: "CxR", description: "The sheet's grid, when it has no Ludo stamp and detection is unsure" }
  ],
  async run(ctx: Ctx, call: ToolCall) {
    if (call.args.length !== 1) throw new CliError("Usage: ludo toolbox sprite export <sheet> --engine texturepacker|godot|unity", EXIT.USAGE);
    if (!ctx.globals.engine) throw new CliError("Pass --engine texturepacker, godot or unity", EXIT.USAGE);
    const src = loadImageFile(call.args[0]);
    if (!/\.png$/i.test(src.file)) throw new CliError("Engine files point at a PNG: convert the sheet to PNG first", EXIT.USAGE);
    const { grid, from } = sheetGrid(src, call);
    const fps = positiveNumber(call, "--fps") ?? grid.fps;
    const raw = call.flags.get("--animation");
    if (raw === true || (typeof raw === "string" && !raw.trim())) throw new CliError("--animation needs a name", EXIT.USAGE);
    const out = { ...grid, fps };
    const engine = ctx.globals.engine;
    const ppu = positiveNumber(call, "--ppu");
    if (ppu !== undefined && engine !== "unity") {
      throw new CliError(
        "--ppu is Unity's pixels per unit: use it with --engine unity",
        EXIT.USAGE,
        engine === "godot"
          ? "Godot 2D draws one pixel per unit, so leave it out; for a Sprite3D, set pixel_size to 1 / ppu (`ludo toolbox sprite compare` lists it as godot.pixel_size)."
          : "PixiJS and Phaser draw one pixel per unit, so leave it out."
      );
    }
    // The pivot as `sprite metrics` measures it, in the untrimmed frame.
    let pivot: { x: number; y: number; kind: string; why: string } | undefined;
    if (call.flags.has("--pivot")) {
      const choice = pivotChoice(call);
      if (engine === "texturepacker") throw new CliError("--pivot is written for Godot and Unity", EXIT.USAGE, `For Phaser or PixiJS, set the origin (anchor) that \`ludo toolbox sprite metrics ${shown(src.file)}\` gives.`);
      const { masks, fw, fh } = sheetFrames(src, grid, 128);
      pivot = metricsOrFail(masks, fw, fh, choice, src.file, 128).pivot;
    }
    const files = engineFiles(ctx, src.file, src.image, out, layoutOf(src), typeof raw === "string" ? raw.trim() : undefined, { ...(pivot ? { pivot } : {}), ...(ppu ? { ppu } : {}) });

    const next = hint("Animate another move for the same character with Ludo", `ludo sprite animate --initial-image <a frame> --motion-prompt "<what it does>" --engine ${ctx.globals.engine}`);
    if (ctx.jsonOut) {
      printJson(
        {
          sheet: shown(src.file),
          grid: { cols: grid.cols, rows: grid.rows, frames: grid.frames, fps },
          grid_from: from,
          ...(src.trim ? { trimmed: true } : {}),
          ...(src.extrude ? { extrude: src.extrude } : {}),
          ...(pivot ? { pivot } : {}),
          ...(engine === "unity" ? { pixels_per_unit: ppu ?? 100 } : {}),
          ...(pivot && engine === "godot" ? { godot_scene: GODOT_ONE_SHEET } : {}),
          engine_files: files.map(shown),
          ...(ctx.globals.quiet ? {} : { hint: next })
        },
        false
      );
    } else {
      process.stdout.write(`${grid.frames} frames (${grid.cols}x${grid.rows} grid) at ${fps} fps\n`);
      if (pivot) process.stdout.write(`Pivot ${pivot.x}, ${pivot.y} (${pivot.kind}): ${pivot.why}\n`);
      process.stdout.write(savedLines(files));
      if (pivot && engine === "godot") process.stdout.write(`${GODOT_ONE_SHEET}\n`);
      if (!ctx.globals.quiet) process.stderr.write(`Next: ${next.text}: ${next.command}\n`);
    }
    return EXIT.OK;
  }
});

TOOLS.push({
  group: "sprite",
  name: "gif",
  args: "<sheet>",
  summary: "Turn a spritesheet into an animated GIF",
  details: [
    "GIF has 256 colours and no partial transparency. Pixels whose alpha is under --alpha-threshold",
    "become transparent and the rest opaque; --matte blends soft edges into the colour the GIF will",
    "sit on, so they do not fringe dark. Every frame shares one palette: the sheet's own colours when",
    "it has 256 or fewer (255 with transparency), else the closest 256 by Wu's quantizer, no dithering.",
    "Delays are whole hundredths of a second, so 12 fps plays 8 and 9 alternately; 50 fps is the most",
    "browsers play. An extruded sheet (`ludo toolbox image extrude`) plays without its repeated border."
  ],
  flags: [
    { flag: "--fps", value: "n", description: `Frame rate (default: the sheet's, else 10; at most ${MAX_GIF_FPS})` },
    { flag: "--scale", value: "n", description: "Enlarge every pixel to n x n, for small pixel art (2-16)" },
    { flag: "--alpha-threshold", value: "n", description: "Alpha below this is transparent, 1-255 (default 128)" },
    { flag: "--matte", value: "hex", description: "Blend semi-transparent edges over this colour, like #1e1e2e" },
    { flag: "--once", description: "Play once instead of looping forever" },
    { flag: "--grid", value: "CxR", description: "The sheet's grid, when it has no Ludo stamp and detection is unsure" }
  ],
  async run(ctx: Ctx, call: ToolCall) {
    if (call.args.length !== 1) throw new CliError("Usage: ludo toolbox sprite gif <sheet> [--fps n]", EXIT.USAGE);
    const scale = positiveInt(call, "--scale") ?? 1;
    if (scale > 16) throw new CliError("--scale goes up to 16", EXIT.USAGE);
    const thresholdRaw = call.flags.get("--alpha-threshold");
    const threshold = thresholdRaw === undefined ? 128 : Number(thresholdRaw);
    if (!Number.isInteger(threshold) || threshold < 1 || threshold > 255) throw new CliError("--alpha-threshold must be a whole number from 1 to 255", EXIT.USAGE);
    const matteText = textFlag(call, "--matte");
    const matte = matteText === undefined ? undefined : hexColour(matteText, "--matte");
    if (matte && matte[3] !== 255) throw new CliError("--matte takes an opaque colour (no alpha)", EXIT.USAGE);

    const src = loadImageFile(call.args[0]);
    const { grid, from } = sheetGrid(src, call);
    const fps = positiveNumber(call, "--fps") ?? grid.fps;
    const e = src.extrude ?? 0;
    let frames = sliceSheet(src.image, grid.cols, grid.rows, grid.frames).map(img => (e ? crop(img, { x: e, y: e, w: img.width - 2 * e, h: img.height - 2 * e }) : img));
    const [w, h] = [frames[0].width * scale, frames[0].height * scale];
    if (w > 65535 || h > 65535) throw new CliError(`A GIF is at most 65535 pixels a side; ${w}x${h} is too big`, EXIT.USAGE);
    if (w * h * frames.length > MAX_TOOLBOX_PIXELS) throw new CliError(`${frames.length} frames of ${w}x${h} is over ${MAX_TOOLBOX_PIXELS / 1024 / 1024} megapixels`, EXIT.USAGE);
    if (scale > 1) frames = frames.map(f => scaleUp(f, scale));

    const gif = makeGif(frames, { fps, alphaThreshold: threshold, matte: matte && [matte[0], matte[1], matte[2]], loop: !call.flags.has("--once") });
    const file = freeName(ctx.outDir, ctx.globals.name || baseOf(src.file), ".gif");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, gif.bytes);

    const next = hint("Animate another move for the same character with Ludo", `ludo sprite animate --initial-image <a frame> --motion-prompt "<what it does>"`);
    if (ctx.jsonOut) {
      printJson(
        {
          sheet: shown(src.file),
          gif: shown(file),
          grid: { cols: grid.cols, rows: grid.rows, frames: grid.frames, fps: grid.fps },
          grid_from: from,
          width: w,
          height: h,
          fps: gif.fps,
          ...(gif.fps !== fps ? { fps_asked: fps } : {}),
          colours: gif.colours,
          palette: gif.exact ? "exact" : "quantized",
          transparent: gif.transparent,
          loops: !call.flags.has("--once"),
          bytes: gif.bytes.length,
          ...(ctx.globals.quiet ? {} : { hint: next })
        },
        false
      );
    } else {
      const colours = gif.exact ? `${gif.colours} colours, all kept` : `reduced to ${gif.colours} colours`;
      process.stdout.write(`${grid.frames} frames of ${w}x${h} at ${gif.fps} fps${gif.fps !== fps ? ` (${fps} asked; GIF plays ${MAX_GIF_FPS} at most)` : ""}, ${colours}${gif.transparent ? ", transparent background" : ""}\n`);
      process.stdout.write(`Saved ${shown(file)} (${Math.max(1, Math.round(gif.bytes.length / 1024))} KB)\n`);
      if (!ctx.globals.quiet) process.stderr.write(`Next: ${next.text}: ${next.command}\n`);
    }
    return EXIT.OK;
  }
});
