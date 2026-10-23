import { CliError, EXIT } from "../errors.js";
import { printJson, type Ctx } from "../generate.js";
import { MAX_TOOLBOX_PIXELS, type Image } from "../tty/png.js";
import type { Grid } from "../tty/preview.js";
import { countFrames } from "./grid.js";
import { baseOf, carriedChunks, engineFiles, freeName, loadImageFile, shown, writePng, type Loaded } from "./io.js";
import { crop, joinFrames, sliceSheet } from "./sheet.js";
import { gridFlag, positiveInt, textFlag } from "./flags.js";
import {
  contentBox,
  emptiness,
  extrude,
  flip,
  pad,
  rotate,
  scaleDown,
  scaleUp,
  trimAgain,
  trimFlipped,
  trimPadded,
  trimRotated,
  trimScaled,
  type Sides,
  type Trim
} from "./pixels.js";
import { hint, TOOLS, type ToolCall, type ToolFlag } from "./registry.js";

// Every image tool runs the same way: one image, or every frame of a sheet
// whose grid is known (its Ludo stamp, or --grid) with the same numbers, then
// the result saved as a new file (or over the input with --in-place). A sheet
// is never guessed at here: without a stamp or --grid it is one image.

interface Edit {
  frames: Image[];
  trim?: Trim; // the trim record the result carries, if any
  extrude?: number; // the repeated border it carries, if any
  facts?: Record<string, unknown>; // extra JSON fields
  says: string; // the line people read
}

const SHARED: ToolFlag[] = [
  { flag: "--grid", value: "CxR", description: "A sheet's grid, to edit each frame alike (default: its Ludo stamp, else one image)" },
  { flag: "--in-place", description: "Replace the input instead of saving a new file" }
];

function gridOf(src: Loaded, call: ToolCall): Grid | undefined {
  const flagGrid = gridFlag(call);
  const grid = flagGrid ? { ...flagGrid, frames: countFrames(src.image, flagGrid.cols, flagGrid.rows), fps: src.grid?.fps ?? 10 } : src.grid;
  if (!grid) return undefined;
  if (grid.cols > src.image.width || grid.rows > src.image.height) {
    throw new CliError(`A ${grid.cols}x${grid.rows} grid does not fit a ${src.image.width}x${src.image.height} image`, EXIT.USAGE);
  }
  return grid.cols * grid.rows > 1 ? grid : undefined;
}

async function runEdit(ctx: Ctx, call: ToolCall, usage: string, edit: (frames: Image[], src: Loaded) => Edit, extruding = false): Promise<number> {
  if (call.args.length !== 1) throw new CliError(`Usage: ${usage}`, EXIT.USAGE);
  const src = loadImageFile(call.args[0]);
  // The border extrude repeats is not part of the frames: any other edit
  // would treat it as if it were.
  if (src.extrude && !extruding) {
    throw new CliError(`${src.file} is extruded (by ${src.extrude}), so this would edit its repeated border too`, EXIT.BAD_INPUT, "Extrude last: edit the file from before the extrude, then extrude it again.");
  }
  const grid = gridOf(src, call);
  const frames = grid ? sliceSheet(src.image, grid.cols, grid.rows, grid.frames) : [src.image];
  const done = edit(frames, src);
  const { width: fw, height: fh } = done.frames[0];
  if (!fw || !fh) throw new CliError("That leaves no pixels at all", EXIT.USAGE);
  const rows = grid ? Math.ceil(done.frames.length / grid.cols) : 1;
  if (fw * fh * done.frames.length > MAX_TOOLBOX_PIXELS || fw * (grid?.cols ?? 1) * fh * rows > MAX_TOOLBOX_PIXELS) {
    throw new CliError(`The result would be over ${MAX_TOOLBOX_PIXELS / 1024 / 1024} megapixels`, EXIT.USAGE);
  }
  const out: Image = grid ? joinFrames(done.frames, grid.cols).sheet : done.frames[0];
  const outGrid: Grid | undefined = grid ? { cols: grid.cols, rows, frames: done.frames.length, fps: grid.fps } : undefined;

  const inPlace = call.flags.has("--in-place");
  if (inPlace && !/\.png$/i.test(src.file)) throw new CliError("--in-place only replaces PNG files", EXIT.USAGE);
  const file = inPlace ? src.file : freeName(ctx.outDir, ctx.globals.name || baseOf(src.file), ".png");
  writePng(file, out, carriedChunks(src, outGrid, { trim: done.trim, extrude: done.extrude }));
  const engine = outGrid ? engineFiles(ctx, file, out, outGrid, { trim: done.trim, extrude: done.extrude }) : [];

  const next = grid
    ? hint("Preview it playing", `ludo preview ${shown(file)}`)
    : hint("Animate it with Ludo", `ludo sprite animate --initial-image ${shown(file)} --motion-prompt "<what it does>"`);
  if (ctx.jsonOut) {
    printJson(
      {
        image: shown(file),
        width: out.width,
        height: out.height,
        ...(outGrid ? { grid: { cols: outGrid.cols, rows: outGrid.rows, frames: outGrid.frames, frame_width: fw, frame_height: fh, fps: outGrid.fps } } : {}),
        ...done.facts,
        ...(engine.length ? { engine_files: engine.map(shown) } : {}),
        ...(ctx.globals.quiet ? {} : { hint: next })
      },
      false
    );
  } else {
    process.stdout.write(`${done.says}${grid ? ` (each of ${done.frames.length} frames)` : ""}\n`);
    process.stdout.write(`${inPlace ? "Replaced" : "Saved"} ${shown(file)} (${out.width}x${out.height}${outGrid ? `, ${outGrid.cols}x${outGrid.rows} grid of ${fw}x${fh}` : ""})\n`);
    for (const f of engine) process.stdout.write(`Saved ${shown(f)}\n`);
    if (!ctx.globals.quiet) process.stderr.write(`Next: ${next.text}: ${next.command}\n`);
  }
  return EXIT.OK;
}

const usageError = (message: string) => new CliError(message, EXIT.USAGE);

const trimJson = (t: Trim | undefined) =>
  t ? { trim: { x: t.x, y: t.y, width: t.w, height: t.h, source_width: t.source_w, source_height: t.source_h } } : {};

function parseSides(spec: string, flag: string): Sides {
  const parts = spec.split(",").map(p => p.trim());
  const nums = parts.map(Number);
  if (![1, 2, 4].includes(parts.length) || nums.some(n => !Number.isInteger(n) || n < 0) || parts.some(p => p === "")) {
    throw usageError(`${flag} takes pixels: 8 (all sides), 8,4 (top and bottom, left and right) or 1,2,3,4 (top, right, bottom, left); got "${spec}"`);
  }
  const [t, r = t, b = t, l = r] = nums;
  return { top: t, right: r, bottom: b, left: l };
}

// #rgb, #rrggbb or #rrggbbaa.
function parseColour(spec: string): [number, number, number, number] {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(spec.trim());
  if (!m) throw usageError(`--color takes a hex colour like #1e1e2e or #1e1e2e80 (got "${spec}")`);
  const hex = m[1].length === 3 ? [...m[1]].map(c => c + c).join("") : m[1];
  const v = (i: number) => parseInt(hex.slice(i, i + 2), 16);
  return [v(0), v(2), v(4), hex.length === 8 ? v(6) : 255];
}

const ANCHORS = ["center", "top", "bottom", "left", "right", "top-left", "top-right", "bottom-left", "bottom-right"];

TOOLS.push({
  group: "image",
  name: "trim",
  args: "<image>",
  summary: "Cut away the empty border",
  details: [
    "Empty means transparent, or on an image with no transparency at all, the colour that fills its",
    "border. On a sheet every frame is cut to one shared box, the smallest that holds every frame, so",
    "the frames stay aligned. The result remembers where the box sat (exports report it, and",
    "`ludo toolbox image pad --restore` puts the border back)."
  ],
  flags: [{ flag: "--threshold", value: "alpha", description: "Pixels this transparent or more count as empty, 0-254 (default 0: only fully clear)" }, ...SHARED],
  async run(ctx, call) {
    const raw = textFlag(call, "--threshold");
    const threshold = raw === undefined ? 0 : Number(raw);
    if (!Number.isInteger(threshold) || threshold < 0 || threshold > 254) throw usageError("--threshold must be a whole number from 0 to 254");
    return runEdit(ctx, call, "ludo toolbox image trim <image> [--threshold 0]", (frames, src) => {
      const { width, height } = frames[0];
      const box = contentBox(frames, emptiness(frames, threshold));
      if (!box) throw new CliError(`${src.file} is empty: there is nothing to keep`, EXIT.BAD_INPUT);
      const trim = trimAgain(src.trim, box, width, height);
      const removed = { top: box.y, right: width - box.x - box.w, bottom: height - box.y - box.h, left: box.x };
      const any = removed.top + removed.right + removed.bottom + removed.left > 0;
      return {
        frames: frames.map(f => crop(f, box)),
        trim,
        facts: { removed, ...trimJson(trim) },
        says: any
          ? `Trimmed ${width}x${height} to ${box.w}x${box.h} (top ${removed.top}, right ${removed.right}, bottom ${removed.bottom}, left ${removed.left})`
          : `Nothing to trim: ${width}x${height} has no empty border`
      };
    });
  }
});

TOOLS.push({
  group: "image",
  name: "pad",
  args: "<image>",
  summary: "Add a border, grow to a size, or put back what trim cut",
  details: [
    "Pass one of --by, --to or --restore. The border is transparent unless --color. On a sheet every",
    "frame gets the same border, so the frames stay aligned."
  ],
  flags: [
    { flag: "--by", value: "px", description: "Border in pixels: 8, 8,4 (top/bottom, left/right) or 1,2,3,4 (top, right, bottom, left)" },
    { flag: "--to", value: "WxH", description: "Grow each frame to this size" },
    { flag: "--anchor", value: "where", description: "With --to, where it sits: center (default), top, bottom, left, right, top-left..." },
    { flag: "--restore", description: "Put back the border `ludo toolbox image trim` cut, to the original size" },
    { flag: "--color", value: "hex", description: "Border colour, like #1e1e2e or #1e1e2e80 (default transparent)" },
    ...SHARED
  ],
  async run(ctx, call) {
    const by = textFlag(call, "--by");
    const to = textFlag(call, "--to");
    const restore = call.flags.has("--restore");
    if ([by !== undefined, to !== undefined, restore].filter(Boolean).length !== 1) throw usageError("Pass one of --by, --to or --restore");
    const anchor = textFlag(call, "--anchor") ?? "center";
    if (!ANCHORS.includes(anchor)) throw usageError(`--anchor is one of ${ANCHORS.join(", ")} (got "${anchor}")`);
    if (call.flags.has("--anchor") && to === undefined) throw usageError("--anchor only goes with --to");
    const colourFlag = textFlag(call, "--color");
    const fill = colourFlag === undefined ? undefined : parseColour(colourFlag);
    return runEdit(ctx, call, "ludo toolbox image pad <image> --by 8 | --to WxH | --restore", (frames, src) => {
      const { width, height } = frames[0];
      let sides: Sides;
      if (restore) {
        const t = src.trim;
        if (!t) throw new CliError(`${src.file} has no trim record: it was not cut by \`ludo toolbox image trim\``, EXIT.BAD_INPUT);
        if (t.w !== width || t.h !== height) {
          throw new CliError(`${src.file}'s frames are ${width}x${height}, but its trim record is for ${t.w}x${t.h}; it was changed since`, EXIT.BAD_INPUT);
        }
        sides = { top: t.y, right: t.source_w - t.x - t.w, bottom: t.source_h - t.y - t.h, left: t.x };
      } else if (to !== undefined) {
        const m = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(to.trim());
        if (!m) throw usageError(`--to takes width x height, like --to 128x128 (got "${to}")`);
        const [tw, th] = [Number(m[1]), Number(m[2])];
        if (tw < width || th < height) throw usageError(`--to ${tw}x${th} is smaller than the ${width}x${height} ${frames.length > 1 ? "frames" : "image"}; trim it instead`);
        const [dx, dy] = [tw - width, th - height];
        const left = anchor.includes("left") ? 0 : anchor.includes("right") ? dx : dx >> 1;
        const top = anchor.includes("top") ? 0 : anchor.includes("bottom") ? dy : dy >> 1;
        sides = { top, right: dx - left, bottom: dy - top, left };
      } else {
        sides = parseSides(by!, "--by");
      }
      const out = frames.map(f => pad(f, sides, fill));
      const trim = restore ? undefined : trimPadded(src.trim, sides);
      return {
        frames: out,
        trim,
        facts: { added: sides, ...trimJson(trim) },
        says: restore
          ? `Restored ${width}x${height} to its original ${out[0].width}x${out[0].height}`
          : `Padded ${width}x${height} to ${out[0].width}x${out[0].height}`
      };
    });
  }
});

TOOLS.push({
  group: "image",
  name: "extrude",
  args: "<image>",
  summary: "Repeat the edge pixels outward, so frames or tiles do not bleed",
  details: [
    "TexturePacker's extrude: a frame or tile grows by the amount on every side, filled with copies",
    "of its own edge pixels, so filtering and rounding at its edge never sample a neighbour. The",
    "result remembers the border, so --engine exports keep it out of each frame; do it last, as the",
    "other image tools refuse an extruded file."
  ],
  flags: [{ flag: "--by", value: "px", description: "Pixels to add on every side, 1-64 (default 1)" }, ...SHARED],
  async run(ctx, call) {
    const n = positiveInt(call, "--by") ?? 1;
    if (n > 64) throw usageError("--by is at most 64");
    return runEdit(
      ctx,
      call,
      "ludo toolbox image extrude <image> [--by 1]",
      (frames, src) => {
        const out = frames.map(f => extrude(f, n));
        const total = (src.extrude ?? 0) + n;
        return {
          frames: out,
          trim: src.trim,
          extrude: total,
          facts: { extruded: total, ...trimJson(src.trim) },
          says: `Extruded ${frames[0].width}x${frames[0].height} by ${n} to ${out[0].width}x${out[0].height}`
        };
      },
      true
    );
  }
});

TOOLS.push({
  group: "image",
  name: "scale",
  args: "<image>",
  summary: "Scale pixel art up or down by a whole factor, nearest neighbour",
  details: [
    "Every pixel becomes a block of N x N (--by N), or every block of N x N becomes the pixel at its",
    "centre (--by 1/N, as ImageMagick's -sample), so scaling up and back down gives the very same",
    "pixels. Pixels left over when the size does not divide by N are dropped (the JSON says how many)."
  ],
  flags: [{ flag: "--by", value: "N|1/N", description: "2 to 16 to scale up, 1/2 to 1/16 to scale down" }, ...SHARED],
  async run(ctx, call) {
    const raw = textFlag(call, "--by");
    const m = raw === undefined ? null : /^(?:(\d+)|1\s*\/\s*(\d+))$/.exec(raw.trim());
    const up = m?.[1] ? Number(m[1]) : 1;
    const down = m?.[2] ? Number(m[2]) : 1;
    if (!m || up * down < 2 || up > 16 || down > 16) throw usageError(`--by takes 2 to 16, or 1/2 to 1/16 (got "${raw ?? ""}")`);
    return runEdit(ctx, call, "ludo toolbox image scale <image> --by 2", (frames, src) => {
      const { width, height } = frames[0];
      if (width < down || height < down) throw usageError(`A ${width}x${height} ${frames.length > 1 ? "frame" : "image"} is too small to scale by 1/${down}`);
      const out = frames.map(f => (up > 1 ? scaleUp(f, up) : scaleDown(f, down)));
      const trim = trimScaled(src.trim, up, down);
      const dropped = { right: width % down, bottom: height % down };
      return {
        frames: out,
        trim,
        facts: { scale: up > 1 ? up : `1/${down}`, ...(dropped.right || dropped.bottom ? { dropped } : {}), ...trimJson(trim) },
        says: `Scaled ${width}x${height} by ${up > 1 ? up : `1/${down}`} to ${out[0].width}x${out[0].height}`
      };
    });
  }
});

TOOLS.push({
  group: "image",
  name: "flip",
  args: "<image>",
  summary: "Mirror left-right (the default) or upside down",
  details: ["A character facing right then faces left. On a sheet every frame flips in its own cell."],
  flags: [
    { flag: "--horizontal", description: "Mirror left-right (the default)" },
    { flag: "--vertical", description: "Mirror top-bottom" },
    ...SHARED
  ],
  async run(ctx, call) {
    const axes: ("horizontal" | "vertical")[] = [];
    if (call.flags.has("--horizontal") || !call.flags.has("--vertical")) axes.push("horizontal");
    if (call.flags.has("--vertical")) axes.push("vertical");
    return runEdit(ctx, call, "ludo toolbox image flip <image> [--vertical]", (frames, src) => {
      const out = frames.map(f => axes.reduce((img, a) => flip(img, a), f));
      const trim = axes.reduce<Trim | undefined>((t, a) => trimFlipped(t, a), src.trim);
      return { frames: out, trim, facts: { flipped: axes, ...trimJson(trim) }, says: `Flipped ${axes.join(" and ")}` };
    });
  }
});

TOOLS.push({
  group: "image",
  name: "rotate",
  args: "<image>",
  summary: "Turn by 90, 180 or 270 degrees clockwise",
  details: ["On a sheet every frame turns in its own cell; frames that are not square swap width and height."],
  flags: [{ flag: "--by", value: "degrees", description: "90, 180, 270 or -90, clockwise (default 90)" }, ...SHARED],
  async run(ctx, call) {
    const raw = textFlag(call, "--by") ?? (call.flags.has("--by") ? "" : "90");
    const degrees = Number(raw);
    if (![90, 180, 270, -90, -180, -270].includes(degrees)) throw usageError(`--by takes 90, 180, 270 or -90 (got "${raw}")`);
    const turns = (((degrees / 90) % 4) + 4) % 4;
    return runEdit(ctx, call, "ludo toolbox image rotate <image> [--by 90]", (frames, src) => {
      const out = frames.map(f => rotate(f, turns));
      const trim = trimRotated(src.trim, turns);
      return { frames: out, trim, facts: { rotated: turns * 90, ...trimJson(trim) }, says: `Rotated ${turns * 90} degrees clockwise` };
    });
  }
});
