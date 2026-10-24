import path from "node:path";
import { CliError, EXIT } from "../errors.js";
import { printJson, type Ctx } from "../generate.js";
import { MAX_TOOLBOX_PIXELS, type Image } from "../tty/png.js";
import type { Grid } from "../tty/preview.js";
import { countFrames } from "./grid.js";
import { baseOf, carriedChunks, engineFiles, freeName, loadImageFile, shown, writePng, type Loaded } from "./io.js";
import { crop, frameRects, joinFrames, sliceSheet } from "./sheet.js";
import { gridFlag, hexColour, positiveInt, textFlag } from "./flags.js";
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
  trimScaledBy,
  type Sides,
  type Trim
} from "./pixels.js";
import { hint, TOOLS, type ToolCall, type ToolFlag } from "./registry.js";
import { resizeNearest, resizePillow } from "./resample.js";
import { unfake, type ReduceMethod } from "./unfake.js";
import { PaletteMap, quantizeFrames } from "./quantize.js";
import { coloursOf, hexOf, loadPalette, PALETTE_EXTENSIONS, PaletteError, savePalette } from "./palette.js";
import { applyKey, borderColour, keyMask } from "./key.js";

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
    const fill = colourFlag === undefined ? undefined : hexColour(colourFlag, "--color");
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

const FILTERS = ["nearest", "bilinear", "bicubic", "lanczos"] as const;

// --by: N or 1/N (whole factors, pixel-perfect), or any factor from 1/16 to
// 16 as a decimal (1.5) or a fraction (2/3).
function parseFactor(raw: string | undefined): { up: number; down: number; f: number } | undefined {
  const m = raw === undefined ? null : /^\s*(\d+(?:\.\d+)?|\.\d+)\s*(?:\/\s*(\d+(?:\.\d+)?)\s*)?$/.exec(raw);
  if (!m) return undefined;
  const [a, b] = [Number(m[1]), m[2] === undefined ? 1 : Number(m[2])];
  const f = a / b;
  if (!(f >= 1 / 16 && f <= 16) || f === 1) return undefined;
  if (Number.isInteger(f)) return { up: f, down: 1, f };
  if (a === 1 && Number.isInteger(b)) return { up: 1, down: b, f };
  return { up: 0, down: 0, f };
}

TOOLS.push({
  group: "image",
  name: "scale",
  args: "<image>",
  summary: "Scale up or down: pixel-perfect by whole factors, or by any factor",
  details: [
    "By a whole factor every pixel becomes a block of N x N (--by N), or every block of N x N becomes",
    "the pixel at its centre (--by 1/N, as ImageMagick's -sample), so scaling up and back down gives the",
    "very same pixels. Pixels left over when the size does not divide by N are dropped (the JSON says",
    "how many). Any other factor (--by 1.5, --by 2/3) sizes the result to the rounded size, each pixel",
    "taking the source pixel under its centre; --filter smooths instead, for art that is not pixel art.",
    "Filters are Pillow's and give its very pixels."
  ],
  flags: [
    { flag: "--by", value: "N|1/N|F", description: "2 to 16 or 1/2 to 1/16 pixel-perfect, or any factor from 1/16 to 16 (1.5, 0.75, 2/3)" },
    { flag: "--filter", value: "name", description: "nearest (default), bilinear, bicubic or lanczos" },
    ...SHARED
  ],
  async run(ctx, call) {
    const raw = textFlag(call, "--by");
    const factor = parseFactor(raw);
    if (!factor) throw usageError(`--by takes a factor from 1/16 to 16 other than 1: 2, 1/2, 1.5 or 2/3 (got "${raw ?? ""}")`);
    const filterRaw = (textFlag(call, "--filter") ?? (call.flags.has("--filter") ? "" : "nearest")).toLowerCase();
    if (!(FILTERS as readonly string[]).includes(filterRaw)) throw usageError(`--filter takes ${FILTERS.join(", ")} (got "${filterRaw}")`);
    const filter = filterRaw as (typeof FILTERS)[number];
    const { up, down, f } = factor;
    const whole = filter === "nearest" && (up > 1 || down > 1);
    const label = whole ? (up > 1 ? String(up) : `1/${down}`) : raw!.replace(/\s+/g, "");
    return runEdit(ctx, call, "ludo toolbox image scale <image> --by 2", (frames, src) => {
      const { width, height } = frames[0];
      if (whole) {
        if (width < down || height < down) throw usageError(`A ${width}x${height} ${frames.length > 1 ? "frame" : "image"} is too small to scale by 1/${down}`);
        const out = frames.map(fr => (up > 1 ? scaleUp(fr, up) : scaleDown(fr, down)));
        const trim = trimScaled(src.trim, up, down);
        const dropped = { right: width % down, bottom: height % down };
        return {
          frames: out,
          trim,
          facts: { scale: up > 1 ? up : `1/${down}`, ...(dropped.right || dropped.bottom ? { dropped } : {}), ...trimJson(trim) },
          says: `Scaled ${width}x${height} by ${label} to ${out[0].width}x${out[0].height}`
        };
      }
      const [w, h] = [Math.max(1, Math.round(width * f)), Math.max(1, Math.round(height * f))];
      const out = frames.map(fr => (filter === "nearest" ? resizeNearest(fr, w, h) : resizePillow(fr, w, h, filter)));
      const trim = trimScaledBy(src.trim, f, w, h);
      return {
        frames: out,
        trim,
        facts: { scale: f, filter, ...trimJson(trim) },
        says: `Scaled ${width}x${height} by ${label} to ${w}x${h}${filter === "nearest" ? "" : ` (${filter})`}`
      };
    });
  }
});

TOOLS.push({
  group: "image",
  name: "key",
  args: "<image>",
  summary: "Make a solid background colour transparent (a colour key)",
  details: [
    "Takes away the background colour around the art: the pixels within --fuzz of it that connect to",
    "the image's edges, so the same colour inside the sprite (eyes, highlights) stays. --everywhere takes",
    "every pixel of that colour instead. The colour is the most common one on the border unless given.",
    "--fuzz is ImageMagick's (-fuzz 10% -transparent <colour> takes the same pixels as --everywhere).",
    "On a sheet every frame is keyed on its own edges. For painted or photographed backgrounds, use",
    "ludo image remove-background."
  ],
  flags: [
    { flag: "--color", value: "hex", description: "The background colour (default: the most common colour on the border)" },
    { flag: "--fuzz", value: "percent", description: "How far from it still counts, 0 to 100 (default 10)" },
    { flag: "--everywhere", description: "Take that colour everywhere, not only where it touches the edges" },
    ...SHARED
  ],
  async run(ctx, call) {
    const rawFuzz = textFlag(call, "--fuzz");
    const fuzz = rawFuzz === undefined ? 10 : Number(rawFuzz.replace(/%$/, ""));
    if (!(fuzz >= 0 && fuzz <= 100)) throw usageError(`--fuzz takes a percentage from 0 to 100 (got "${rawFuzz}")`);
    const given = textFlag(call, "--color");
    const everywhere = call.flags.has("--everywhere");
    return runEdit(ctx, call, "ludo toolbox image key <image> [--color #ffffff]", (frames, src) => {
      const key = given ? hexColour(given, "--color") : borderColour(src.image);
      if (!key) {
        throw new CliError(`${src.file} has no solid colour around its edges to take away`, EXIT.BAD_INPUT, "Name the colour with --color, or use ludo image remove-background.");
      }
      let taken = 0;
      const out = frames.map(f => {
        const mask = keyMask(f, key, fuzz / 100, !everywhere);
        for (const m of mask) taken += m;
        return applyKey(f, mask);
      });
      if (!taken) throw new CliError(`No pixel of ${src.file} is within ${fuzz}% of ${hex(key)}${everywhere ? "" : " at its edges"}`, EXIT.BAD_INPUT, "Raise --fuzz, or name the colour with --color.");
      const total = frames.reduce((n, f) => n + f.width * f.height, 0);
      return {
        frames: out,
        trim: src.trim,
        facts: { color: hex(key), fuzz, everywhere, pixels_taken: taken, share_taken: Math.round((taken / total) * 1000) / 1000, ...trimJson(src.trim) },
        says: `Took away ${hex(key)} (fuzz ${fuzz}%${everywhere ? ", everywhere" : ""}): ${taken} pixels, ${Math.round((taken / total) * 100)}% of the image`
      };
    });
  }
});

TOOLS.push({
  group: "image",
  name: "palette",
  args: "<image>",
  summary: "List an image's colours, most used first, and save them as a palette file",
  details: [
    "A sheet's colours are counted over all its frames. --save writes them in the format its extension",
    "names: .hex (Lospec), .gpl (GIMP, Aseprite), .pal (JASC, Aseprite), .txt (Paint.NET) or .png (one",
    "pixel per colour). Use it with `ludo toolbox image recolor --palette` to give other art the same colours."
  ],
  flags: [
    { flag: "--save", value: "file", description: "Write the palette to a .hex, .gpl, .pal, .txt or .png file" },
    { flag: "--top", value: "n", description: "List this many colours (default 16; the JSON and --save have them all)" }
  ],
  async run(ctx, call) {
    if (call.args.length !== 1) throw new CliError("Usage: ludo toolbox image palette <image> [--save palette.hex]", EXIT.USAGE);
    const src = loadImageFile(call.args[0]);
    const save = textFlag(call, "--save");
    if (save !== undefined && !PALETTE_EXTENSIONS.includes(path.extname(save).toLowerCase())) {
      throw usageError(`--save writes ${PALETTE_EXTENSIONS.join(", ")} files (got "${save}")`);
    }
    const top = call.flags.has("--top") ? positiveInt(call, "--top")! : 16;
    const colours = coloursOf([src.image]).sort((a, b) => b.count - a.count);
    if (!colours.length) throw new CliError(`${src.file} is transparent all over: it has no colours`, EXIT.BAD_INPUT);
    if (save !== undefined && colours.length > 1024) {
      throw new CliError(`${src.file} has ${colours.length} colours, too many for a palette file`, EXIT.BAD_INPUT, `Reduce them first: ludo toolbox image recolor ${shown(src.file)} --colors 32`);
    }
    if (save !== undefined) savePalette(save, colours.map(c => c.colour));
    const pixels = colours.reduce((n, c) => n + c.count, 0);
    const next = hint("Give other art these colours", `ludo toolbox image recolor <image> --palette ${save !== undefined ? shown(save) : shown(src.file)}`);
    if (ctx.jsonOut) {
      printJson(
        {
          image: shown(src.file),
          count: colours.length,
          colors: colours.slice(0, 4096).map(c => ({ hex: hexOf(c.colour), pixels: c.count })),
          ...(save !== undefined ? { saved: shown(save) } : {}),
          ...(ctx.globals.quiet ? {} : { hint: next })
        },
        false
      );
    } else {
      process.stdout.write(`${colours.length} colours in ${pixels} opaque pixels\n`);
      for (const c of colours.slice(0, top)) process.stdout.write(`  ${hexOf(c.colour)}  ${((c.count / pixels) * 100).toFixed(1).padStart(5)}%\n`);
      if (colours.length > top) process.stdout.write(`  ... and ${colours.length - top} more\n`);
      if (save !== undefined) process.stdout.write(`Saved ${shown(save)}\n`);
      if (!ctx.globals.quiet) process.stderr.write(`Next: ${next.text}: ${next.command}\n`);
    }
    return EXIT.OK;
  }
});

TOOLS.push({
  group: "image",
  name: "recolor",
  args: "<image>",
  summary: "Fewer colours, a given palette, or one palette swapped for another",
  details: [
    "  --colors N               at most N colours, chosen for the image (Wu's quantizer, no dithering)",
    "  --palette <file|hexes>   every colour becomes its nearest in that palette (a Lospec palette, or",
    "                           another sprite's colours)",
    "  --swap <A> --to <B>      each colour of palette A becomes the colour at the same place in B",
    "                           (an enemy in red becomes one in blue); colours not in A stay",
    "Palettes are files (.hex, .gpl, .pal, .txt, or an image's colours from .png) or hex lists",
    "(#1a1c2c,#5d275d). On a sheet the frames share one palette. Nearest is by RGB distance."
  ],
  flags: [
    { flag: "--colors", value: "N", description: "At most N colours (2 to 256)" },
    { flag: "--palette", value: "file|hexes", description: "Map every colour to its nearest in this palette" },
    { flag: "--swap", value: "file|hexes", description: "The colours to replace (with --to)" },
    { flag: "--to", value: "file|hexes", description: "What they become, in the same order" },
    { flag: "--save-palette", value: "file", description: "Also write the result's palette (.hex, .gpl, .pal, .txt or .png)" },
    ...SHARED
  ],
  async run(ctx, call) {
    const modes = ["--colors", "--palette", "--swap"].filter(f => call.flags.has(f));
    if (modes.length !== 1) throw usageError("Pass one of --colors, --palette or --swap (with --to)");
    if (call.flags.has("--swap") !== call.flags.has("--to")) throw usageError("--swap and --to go together");
    const savePal = textFlag(call, "--save-palette");
    if (savePal !== undefined && !PALETTE_EXTENSIONS.includes(path.extname(savePal).toLowerCase())) {
      throw usageError(`--save-palette writes ${PALETTE_EXTENSIONS.join(", ")} files (got "${savePal}")`);
    }
    const pal = (flag: string) => {
      try {
        const p = loadPalette(textFlag(call, flag) ?? "");
        if (!p.length) throw new PaletteError("it has no colours");
        return p;
      } catch (err) {
        if (err instanceof PaletteError) throw new CliError(`${flag}: ${err.message}`, EXIT.BAD_INPUT);
        throw err;
      }
    };
    let colours: number | undefined;
    if (call.flags.has("--colors")) {
      colours = positiveInt(call, "--colors");
      if (colours === undefined || colours < 2 || colours > 256) throw usageError("--colors takes 2 to 256");
    }
    const target = call.flags.has("--palette") ? pal("--palette") : undefined;
    const swap = call.flags.has("--swap") ? { from: pal("--swap"), to: pal("--to") } : undefined;
    if (swap && swap.from.length !== swap.to.length) throw usageError(`--swap has ${swap.from.length} colours and --to ${swap.to.length}: they pair up in order`);
    return runEdit(ctx, call, "ludo toolbox image recolor <image> --colors 16", (frames, src) => {
      const before = coloursOf(frames).length;
      let out: Image[];
      let changed = 0;
      if (colours) out = quantizeFrames(frames, colours).frames;
      else {
        // Each colour once: its nearest (or its swap), remembered.
        const map = target ? new PaletteMap(target) : undefined;
        const swaps = new Map(swap?.from.map((c, i) => [(c[0] << 16) | (c[1] << 8) | c[2], swap.to[i]]));
        out = frames.map(f => {
          const rgba = f.rgba.slice();
          for (let i = 0; i < rgba.length; i += 4) {
            if (!rgba[i + 3]) continue;
            const c = map ? target![map.index(rgba[i], rgba[i + 1], rgba[i + 2])] : swaps.get((rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2]);
            if (!c || (c[0] === rgba[i] && c[1] === rgba[i + 1] && c[2] === rgba[i + 2])) continue;
            rgba[i] = c[0];
            rgba[i + 1] = c[1];
            rgba[i + 2] = c[2];
            changed++;
          }
          return { width: f.width, height: f.height, rgba };
        });
      }
      const after = coloursOf(out);
      if (savePal !== undefined) savePalette(savePal, after.sort((a, b) => b.count - a.count).map(c => c.colour));
      return {
        frames: out,
        trim: src.trim,
        facts: {
          colors: { before, after: after.length },
          ...(swap ? { swapped_pixels: changed } : {}),
          ...(savePal !== undefined ? { palette_saved: shown(savePal) } : {}),
          ...trimJson(src.trim)
        },
        says: swap ? `Swapped ${swap.from.length} colours: ${changed} pixels changed` : `${before} colours to ${after.length}`
      };
    });
  }
});

const hex = (c: number[]) => `#${c.slice(0, 3).map(v => v.toString(16).padStart(2, "0")).join("")}${c[3] === 255 ? "" : c[3].toString(16).padStart(2, "0")}`;

const METHODS = ["dominant", "median", "mode", "mean", "nearest"] as const;

TOOLS.push({
  group: "image",
  name: "snap",
  args: "<image>",
  summary: "Put AI pixel art back on its own grid: one pixel per art pixel",
  details: [
    "Image models draw \"pixel art\" big (a 128 px sprite at 6x), soft at the edges, often off any whole",
    "grid (200 cells resampled to 2048 px is 10.24 px a cell), or with cells that wander by a few pixels.",
    "This finds the art pixel's size and phase and gives each cell one colour, its most common one.",
    "An exact upscale (98% of colour edges on one grid) comes back losslessly; anything else goes",
    "through the detectors of unfake.js (MIT): tiled edge periods, fractional grids and",
    "cells fitted to hand-drawn edges. The JSON says how much of the image the result explains (fit);",
    "art already at one pixel per pixel can still look periodic, so check a low fit, or pass --scale.",
    "On a sheet the grid is found once for the whole sheet and every frame is cut the same way."
  ],
  flags: [
    { flag: "--scale", value: "N", description: "The art pixel's size, when you know it (may be fractional: 10.24); found otherwise" },
    { flag: "--method", value: "name", description: "How a cell becomes a pixel: dominant (default), median, mode, mean or nearest" },
    { flag: "--colors", value: "N", description: "At most N colours in the result (default: keep them all)" },
    { flag: "--keep-size", description: "Draw the result back at its whole-pixel scale: about the same size, on a clean grid" },
    ...SHARED
  ],
  async run(ctx, call) {
    const rawScale = textFlag(call, "--scale");
    const scale = rawScale === undefined ? undefined : Number(rawScale);
    if (scale !== undefined && !(scale >= 1 && scale <= 256)) throw usageError(`--scale takes a pixel size from 1 to 256 (got "${rawScale}")`);
    const method = (textFlag(call, "--method") ?? "dominant").toLowerCase() as ReduceMethod;
    if (!(METHODS as readonly string[]).includes(method)) throw usageError(`--method takes ${METHODS.join(", ")} (got "${method}")`);
    const colours = call.flags.has("--colors") ? positiveInt(call, "--colors") : undefined;
    if (colours !== undefined && (colours < 2 || colours > 4096)) throw usageError("--colors takes 2 to 4096");
    return runEdit(ctx, call, "ludo toolbox image snap <image> [--scale N]", (frames, src) => {
      const grid = gridOf(src, call);
      // The whole sheet (or the image) decides the grid: more edges to go on.
      const whole = unfake(src.image, { method, ...(scale ? { scale } : {}) });
      if (whole.scale <= 1) {
        throw new CliError(
          `${src.file} has no pixel grid to snap to: it looks like one pixel per pixel already`,
          EXIT.BAD_INPUT,
          "If its pixels are a known size, pass it with --scale."
        );
      }
      let out: Image[];
      if (!grid) out = [whole.image];
      else {
        // Every frame cut on the sheet's own grid: a whole scale keeps the
        // sheet's phase, so frames do not jump a cell against each other.
        const rects = frameRects(src.image.width, src.image.height, grid.cols, grid.rows, grid.frames);
        const s = whole.scale;
        const phase = Number.isInteger(s) && whole.crop ? whole.crop : undefined;
        const each = frames.map((f, i) =>
          unfake(f, {
            method,
            scale: s,
            ...(phase ? { phase: { x: (((phase.x - rects[i].x) % s) + s) % s, y: (((phase.y - rects[i].y) % s) + s) % s } } : {})
          }).image
        );
        const w = Math.max(...each.map(f => f.width));
        const h = Math.max(...each.map(f => f.height));
        out = each.map(f => (f.width === w && f.height === h ? f : pad(f, { top: 0, left: 0, right: w - f.width, bottom: h - f.height })));
      }
      let reduced: number | undefined;
      if (colours) {
        const q = quantizeFrames(out, colours);
        if (q.frames !== out) reduced = q.before;
        out = q.frames;
      }
      const k = Math.max(1, Math.round(whole.scale));
      if (call.flags.has("--keep-size") && k > 1) out = out.map(f => scaleUp(f, k));
      const shown2 = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));
      const fit = Math.round(whole.fit * 1000) / 1000;
      const warning =
        !scale && !whole.exact && whole.fit < 0.7
          ? `The result explains only ${Math.round(whole.fit * 100)}% of the image: it may already be one pixel per pixel, or its pixels another size. Check it, or pass --scale.`
          : undefined;
      return {
        frames: out,
        facts: {
          pixel_size: Math.round(whole.scale * 10000) / 10000,
          exact: !!whole.exact,
          fit,
          ...(whole.grid ? { fractional_grid: { period: whole.grid.period.map(v => Math.round(v * 10000) / 10000), cells: whole.grid.cells } } : {}),
          ...(whole.elastic ? { fitted_to_edges: { x: whole.elastic[0], y: whole.elastic[1] } } : {}),
          ...(reduced !== undefined ? { colors: { before: reduced, after: colours } } : {}),
          ...(call.flags.has("--keep-size") ? { drawn_at: k } : {}),
          ...(src.trim ? { trim_dropped: true } : {}),
          ...(warning ? { warning } : {})
        },
        says:
          `Snapped ${frames[0].width}x${frames[0].height} to ${out[0].width}x${out[0].height}: art pixels of ${shown2(whole.scale)} px` +
          (whole.exact ? " (an exact upscale: nothing lost)" : `, explaining ${Math.round(whole.fit * 100)}% of it`) +
          (reduced !== undefined ? `, ${reduced} colours to ${colours}` : "") +
          (warning ? `\nWarning: ${warning}` : "")
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
