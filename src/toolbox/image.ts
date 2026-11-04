import fs from "node:fs";
import path from "node:path";
import { CliError, EXIT } from "../errors.js";
import { printJson, type Ctx } from "../generate.js";
import { MAX_TOOLBOX_PIXELS, type Image } from "../tty/png.js";
import { keepLoop, type Grid } from "../tty/preview.js";
import { countFrames } from "./grid.js";
import { baseOf, carriedChunks, engineFiles, freeName, loadImageFile, shown, writePng, type Loaded } from "./io.js";
import { blit, crop, joinFrames, sliceSheet } from "./sheet.js";
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
import { hint, playHint, TOOLS, type ToolCall, type ToolFlag } from "./registry.js";
import { resizeNearest, resizePillow } from "./resample.js";
import { PaletteMap } from "./quantize.js";
import { coloursOf, hexOf, loadPalette, PALETTE_EXTENSIONS, PaletteError, savePalette } from "./palette.js";
import { dropShadow, margins, outline, type Shape } from "./effects.js";
import { MAX_NORMAL_PIXELS, NORMAL_DEFAULTS, NORMAL_RANGES, normalMap, normalPadding, type NormalSettings } from "./normals.js";
import { encodeWebp } from "../tty/webp-encode.js";

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
  const outGrid: Grid | undefined = grid ? keepLoop({ cols: grid.cols, rows, frames: done.frames.length, fps: grid.fps }, grid) : undefined;

  const inPlace = call.flags.has("--in-place");
  if (inPlace && !/\.png$/i.test(src.file)) throw new CliError("--in-place only replaces PNG files", EXIT.USAGE);
  const file = inPlace ? src.file : freeName(ctx.outDir, ctx.globals.name || baseOf(src.file), ".png");
  writePng(file, out, carriedChunks(src, outGrid, { trim: done.trim, extrude: done.extrude }));
  const engine = outGrid ? engineFiles(ctx, file, out, outGrid, { trim: done.trim, extrude: done.extrude }) : [];

  const next = grid
    ? playHint(ctx, shown(file))
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
      throw new CliError(`${src.file} has ${colours.length} colours, too many for a palette file (at most 1024)`, EXIT.BAD_INPUT);
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
  summary: "Map art onto a given palette, or swap one palette for another",
  details: [
    "  --palette <file|hexes>   every colour becomes its nearest in that palette (a Lospec palette, or",
    "                           another sprite's colours)",
    "  --swap <A> --to <B>      each colour of palette A becomes the colour at the same place in B",
    "                           (an enemy in red becomes one in blue); colours not in A stay",
    "Palettes are files (.hex, .gpl, .pal, .txt, or an image's colours from .png) or hex lists",
    "(#1a1c2c,#5d275d). Nearest is by RGB distance. To turn a picture into pixel art with fewer",
    "colours, Ludo converts it: ludo image convert-to-pixel-art."
  ],
  flags: [
    { flag: "--palette", value: "file|hexes", description: "Map every colour to its nearest in this palette" },
    { flag: "--swap", value: "file|hexes", description: "The colours to replace (with --to)" },
    { flag: "--to", value: "file|hexes", description: "What they become, in the same order" },
    { flag: "--save-palette", value: "file", description: "Also write the result's palette (.hex, .gpl, .pal, .txt or .png)" },
    ...SHARED
  ],
  async run(ctx, call) {
    const modes = ["--palette", "--swap"].filter(f => call.flags.has(f));
    if (modes.length !== 1) throw usageError("Pass one of --palette or --swap (with --to)");
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
    const target = call.flags.has("--palette") ? pal("--palette") : undefined;
    const swap = call.flags.has("--swap") ? { from: pal("--swap"), to: pal("--to") } : undefined;
    if (swap && swap.from.length !== swap.to.length) throw usageError(`--swap has ${swap.from.length} colours and --to ${swap.to.length}: they pair up in order`);
    return runEdit(ctx, call, "ludo toolbox image recolor <image> --palette pico-8.hex", (frames, src) => {
      const before = coloursOf(frames).length;
      let changed = 0;
      // Each colour once: its nearest (or its swap), remembered.
      const map = target ? new PaletteMap(target) : undefined;
      const swaps = new Map(swap?.from.map((c, i) => [(c[0] << 16) | (c[1] << 8) | c[2], swap.to[i]]));
      const out: Image[] = frames.map(f => {
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

// Room around every frame for an effect that reaches `need` pixels past
// the content on each side: only what is missing is added, the same to all
// frames.
function roomFor(frames: Image[], need: Sides): Sides {
  const m = margins(frames);
  const short = (n: number, have: number) => Math.max(0, n - (Number.isFinite(have) ? have : n));
  return { top: short(need.top, m.top), right: short(need.right, m.right), bottom: short(need.bottom, m.bottom), left: short(need.left, m.left) };
}

const anyRoom = (s: Sides) => s.top + s.right + s.bottom + s.left > 0;

const SHAPES = ["circle", "square", "diamond"] as const;

TOOLS.push({
  group: "image",
  name: "outline",
  args: "<image>",
  summary: "Draw an outline around the art",
  details: [
    "Every pixel within --width of the art (by --shape: circle, square or diamond, as ImageMagick's",
    "Disk, Square and Diamond kernels) gets the outline colour, under the art; soft edges keep their",
    "softness. A 1 px circle is the classic pixel-art outline (no corners); square fills them. The",
    "canvas grows only where the outline would run off it, every frame of a sheet alike."
  ],
  flags: [
    { flag: "--color", value: "hex", description: "Outline colour (default #000000; #rrggbbaa for see-through)" },
    { flag: "--width", value: "px", description: "Thickness, 1 to 32 (default 1)" },
    { flag: "--shape", value: "name", description: "circle (default), square or diamond" },
    ...SHARED
  ],
  async run(ctx, call) {
    const colour = hexColour(textFlag(call, "--color") ?? "#000000", "--color");
    const n = call.flags.has("--width") ? positiveInt(call, "--width")! : 1;
    if (n > 32) throw usageError("--width takes 1 to 32");
    const shape = (textFlag(call, "--shape") ?? "circle").toLowerCase() as Shape;
    if (!(SHAPES as readonly string[]).includes(shape)) throw usageError(`--shape takes ${SHAPES.join(", ")} (got "${shape}")`);
    return runEdit(ctx, call, "ludo toolbox image outline <image> [--width 1] [--color #000000]", (frames, src) => {
      const room = roomFor(frames, { top: n, right: n, bottom: n, left: n });
      const grown = anyRoom(room) ? frames.map(f => pad(f, room)) : frames;
      const trim = anyRoom(room) ? trimPadded(src.trim, room) : src.trim;
      return {
        frames: grown.map(f => outline(f, colour, n, shape)),
        trim,
        facts: { color: hex(colour), outline_width: n, shape, ...(anyRoom(room) ? { grown: room } : {}), ...trimJson(trim) },
        says: `Outlined ${n} px ${shape} in ${hex(colour)}${anyRoom(room) ? `, the canvas grown to ${grown[0].width}x${grown[0].height} to fit it` : ""}`
      };
    });
  }
});

TOOLS.push({
  group: "image",
  name: "shadow",
  args: "<image>",
  summary: "Put a drop shadow under the art",
  details: [
    "The art's own shape, moved by --offset (right and down are positive), in --color at --opacity,",
    "under the art. The canvas grows only where the shadow would run off it, every frame alike."
  ],
  flags: [
    { flag: "--offset", value: "x,y", description: "How far the shadow falls, in pixels (default 2,2)" },
    { flag: "--color", value: "hex", description: "Shadow colour (default #000000)" },
    { flag: "--opacity", value: "percent", description: "0 to 100 (default 50)" },
    ...SHARED
  ],
  async run(ctx, call) {
    const rawOffset = textFlag(call, "--offset") ?? "2,2";
    const m = /^\s*(-?\d+)\s*,\s*(-?\d+)\s*$/.exec(rawOffset);
    if (!m) throw usageError(`--offset takes x,y in pixels, like 2,2 or -3,4 (got "${rawOffset}")`);
    const [dx, dy] = [Number(m[1]), Number(m[2])];
    if (Math.abs(dx) > 256 || Math.abs(dy) > 256 || (!dx && !dy)) throw usageError("--offset takes -256 to 256 on each axis, not 0,0");
    const rawOpacity = textFlag(call, "--opacity");
    const opacity = rawOpacity === undefined ? 50 : Number(rawOpacity.replace(/%$/, ""));
    if (!(opacity > 0 && opacity <= 100)) throw usageError(`--opacity takes 1 to 100 (got "${rawOpacity}")`);
    const base = hexColour(textFlag(call, "--color") ?? "#000000", "--color");
    const colour: [number, number, number, number] = [base[0], base[1], base[2], Math.round((base[3] * opacity) / 100)];
    return runEdit(ctx, call, "ludo toolbox image shadow <image> [--offset 2,2]", (frames, src) => {
      const room = roomFor(frames, { top: Math.max(0, -dy), right: Math.max(0, dx), bottom: Math.max(0, dy), left: Math.max(0, -dx) });
      const grown = anyRoom(room) ? frames.map(f => pad(f, room)) : frames;
      const trim = anyRoom(room) ? trimPadded(src.trim, room) : src.trim;
      return {
        frames: grown.map(f => dropShadow(f, dx, dy, colour)),
        trim,
        facts: { offset: [dx, dy], color: hex(base), opacity, ...(anyRoom(room) ? { grown: room } : {}), ...trimJson(trim) },
        says: `Shadow at ${dx},${dy} in ${hex(base)} at ${opacity}%${anyRoom(room) ? `, the canvas grown to ${grown[0].width}x${grown[0].height} to fit it` : ""}`
      };
    });
  }
});

// --normal-strength and the like: a number in the original's range, read as
// f32 as it reads them.
function normalFlag(call: ToolCall, flag: string, fallback: number, min: number, max: number): number {
  const raw = call.flags.get(flag);
  if (raw === undefined) return fallback;
  const n = typeof raw === "string" && /^\s*[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?\s*$/i.test(raw) ? Math.fround(Number(raw)) : NaN;
  if (!(n >= Math.fround(min) && n <= Math.fround(max))) throw usageError(`${flag} takes a number from ${min} to ${max} (got "${raw === true ? "" : raw}")`);
  return n;
}

// An f32 as its shortest decimal (0.6, not 0.6000000238418579).
const shortest = (v: number) => {
  for (let digits = 1; digits < 9; digits++) if (Math.fround(Number(v.toPrecision(digits))) === v) return Number(v.toPrecision(digits));
  return v;
};

const rangeOf = (key: keyof NormalSettings) => NORMAL_RANGES.find(r => r.key === key)!;

// Frames this big (longer side, px) get a --shape-radius suggestion.
const BIG_ART = 256;

// The chunks that say how to show colours; a normal map is data and has none.
const COLOUR_SPACE = new Set(["gAMA", "cHRM", "sRGB", "iCCP"]);

// A normal map has to lie on its art pixel for pixel, so this does not go
// through runEdit: the sheet is never cut and joined again. Every cell of
// the whole cols x rows grid is mapped where it is (an empty or nearly
// empty cell too), and the map has the art's very size, alpha and grid.
async function runNormals(ctx: Ctx, call: ToolCall, settings: NormalSettings): Promise<number> {
  if (call.args.length !== 1) throw usageError("Usage: ludo toolbox image normals <image> [--normal-strength 1.5]");
  const src = loadImageFile(call.args[0]);
  if (src.extrude) {
    throw new CliError(`${src.file} is extruded (by ${src.extrude}), so this would map its repeated border too`, EXIT.BAD_INPUT, "Make the normal map from the file before the extrude, then extrude both alike.");
  }
  const grid = gridOf(src, call);
  const { width, height } = src.image;
  const cols = grid?.cols ?? 1;
  const rows = grid?.rows ?? 1;
  if (width % cols || height % rows) {
    throw new CliError(
      `A ${width}x${height} image does not split into ${cols}x${rows} frames of one whole size, so its normal map would not line up with it`,
      call.flags.has("--grid") ? EXIT.USAGE : EXIT.BAD_INPUT,
      `Its width has to be a multiple of ${cols} and its height of ${rows}: pad or crop it first, or pass the right --grid.`
    );
  }
  const [fw, fh] = [width / cols, height / rows];
  const pad = normalPadding(settings);
  if ((fw + 2 * pad) * (fh + 2 * pad) > MAX_NORMAL_PIXELS) {
    throw new CliError(`A ${fw}x${fh} ${grid ? "frame" : "image"} is too large for a normal map (at most ${MAX_NORMAL_PIXELS / 1024 / 1024} megapixels a frame, with a ${pad} px border)`, EXIT.BAD_INPUT, "Split it into smaller images first.");
  }
  const out: Image = { width, height, rgba: new Uint8Array(width * height * 4) };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) blit(out, normalMap(crop(src.image, { x: c * fw, y: r * fh, w: fw, h: fh }), settings), c * fw, r * fh);
  }

  const file = freeName(ctx.outDir, ctx.globals.name || `${baseOf(src.file)}_n`, ".png");
  const chunks = carriedChunks(src, grid, { trim: src.trim }).filter(c => !COLOUR_SPACE.has(c.type));
  // The flat normal under clear pixels is read by filtering: it is kept.
  writePng(file, out, chunks, { keepClearRgb: true });
  const notes: string[] = [];
  // Engine files would set the map up as sprite colour (sRGB): none yet.
  if (ctx.globals.engine) notes.push(`No ${ctx.globals.engine} files for a normal map: import it in the engine as a normal map (linear, not sRGB).`);
  // The default radius rounds only the outer few pixels: right for pixel
  // art, flat in the middle on big art. There is no telling the right value
  // from the pixels, so this only suggests one (the longer side / 48).
  const side = Math.max(fw, fh);
  if (side >= BIG_ART && !call.flags.has("--shape-radius")) {
    const tryRadius = Math.max(8, Math.round(side / 48));
    const smooth = call.flags.has("--detail-scale") ? "" : " --detail-scale 3";
    notes.push(`${grid ? "Each frame" : "This art"} is ${fw}x${fh}: at the default --shape-radius 4 only its outer few pixels are rounded and the middle stays flat. Try --shape-radius ${tryRadius}${smooth} (see --help).`);
  }

  const format = settings.format;
  const next = hint("Look at it beside the art", `ludo toolbox image contact ${shown(src.file)} ${shown(file)}`);
  const says = `Made ${format === "opengl" ? "an OpenGL" : "a DirectX"} normal map, a data texture to import as linear, not sRGB`;
  if (ctx.jsonOut) {
    printJson(
      {
        image: shown(file),
        width,
        height,
        ...(grid ? { grid: { cols, rows, frames: grid.frames, frame_width: fw, frame_height: fh, fps: grid.fps } } : {}),
        normal_format: format,
        normal_strength: shortest(settings.normalStrength),
        detail_strength: shortest(settings.detailStrength),
        detail_scale: shortest(settings.detailScale),
        shape_strength: shortest(settings.shapeStrength),
        shape_radius: shortest(settings.shapeRadius),
        ...trimJson(src.trim),
        ...(notes.length ? { notes } : {}),
        ...(ctx.globals.quiet ? {} : { hint: next })
      },
      false
    );
  } else {
    process.stdout.write(`${says}${grid ? ` (each of ${cols * rows} cells)` : ""}\n`);
    process.stdout.write(`Saved ${shown(file)} (${width}x${height}${grid ? `, ${cols}x${rows} grid of ${fw}x${fh}` : ""})\n`);
    for (const n of notes) process.stderr.write(`Note: ${n}\n`);
    if (!ctx.globals.quiet) process.stderr.write(`Next: ${next.text}: ${next.command}\n`);
  }
  return EXIT.OK;
}

TOOLS.push({
  group: "image",
  name: "normals",
  args: "<image>",
  summary: "Make a normal map, so lights in the engine shade the art",
  details: [
    "Each pixel's colour says which way it faces. The art's silhouette rounds it (thicker parts rise",
    "more) and its painted shading adds the detail; every separate part (a sword apart from the hand)",
    "is shaped on its own, and pixels that are clear or nearly so get the flat normal (128,128,255).",
    "The map is the art's size, pixel for pixel, with its alpha and grid, saved as <name>_n.png (the art",
    "is never replaced). On a sheet every cell is mapped on its own; the sheet must divide into its grid.",
    "It is a data texture, not colour: import it as a normal map, or as linear (never sRGB). No engine",
    "files are written for it yet. Ported from Sprite Fusion Sprite Normals (MIT,",
    "github.com/hugo-dz/spritefusion-sprite-normals): at the default settings it gives that tool's very",
    "pixels; with other values a rare pixel may differ by 1.",
    "",
    "--shape-radius is the one setting that depends on the art's size, and nothing in the pixels says",
    "its right value. It is how far in from the edge, in pixels, the silhouette keeps rising before it",
    "levels off (--shape-strength is how high it rises). The default 4 suits pixel art: a 32 or 64 px",
    "sprite is rounded right through. On bigger art only the rim is rounded and the middle stays flat,",
    "so the painted shading does all the work and brush strokes come out as embossed bumps. Raise it to",
    "about the frame's longer side / 48 (16 for a 768 px character): each part gets its volume and",
    "limbs and props stay apart; add --detail-scale 3 so brush texture is smoothed before it turns into",
    "bumps. Much more, toward half the art's thickness, swells the whole sprite into one tent with",
    "creases down the middle of each shape. Frames of 256 px and up get a note with a value to try."
  ],
  flags: [
    { flag: "--normal-strength", value: "n", description: "How steep the whole relief is, 0 to 8 (default 1.5)" },
    { flag: "--detail-strength", value: "n", description: "How much the painted shading adds, 0 to 8 (default 6)" },
    { flag: "--detail-scale", value: "px", description: "How far the shading is smoothed first, 0.6 to 8 (default 0.6; 3 for painted art)" },
    { flag: "--shape-strength", value: "n", description: "How high the silhouette rises, 0 to 8 (default 1.15)" },
    { flag: "--shape-radius", value: "px", description: "How far in from the edge it keeps rising, 0.5 to 512 (default 4, for pixel art; see above)" },
    { flag: "--normal-format", value: "name", description: "opengl (default; Godot, Unity) or directx (green reversed; Unreal)" },
    SHARED[0]
  ],
  refuses: { "--in-place": "A normal map does not replace its art: it is saved beside it, as <name>_n.png (drop --in-place)" },
  async run(ctx, call) {
    const format = (textFlag(call, "--normal-format") ?? (call.flags.has("--normal-format") ? "" : "opengl")).toLowerCase();
    if (format !== "opengl" && format !== "directx") throw usageError(`--normal-format takes opengl or directx (got "${format}")`);
    const value = (flag: string, key: keyof NormalSettings) => normalFlag(call, flag, NORMAL_DEFAULTS[key] as number, rangeOf(key).min, rangeOf(key).max);
    return runNormals(ctx, call, {
      ...NORMAL_DEFAULTS,
      normalStrength: value("--normal-strength", "normalStrength"),
      detailStrength: value("--detail-strength", "detailStrength"),
      detailScale: value("--detail-scale", "detailScale"),
      shapeStrength: value("--shape-strength", "shapeStrength"),
      shapeRadius: value("--shape-radius", "shapeRadius"),
      format
    });
  }
});

TOOLS.push({
  group: "image",
  name: "convert",
  args: "<image>",
  summary: "Save an image as PNG or lossless WebP",
  details: [
    "Reads PNG, GIF, WebP (still or animated; an animation comes out as a sheet) and, through a converter",
    "the system has, JPEG and others. --to webp is lossless: the same pixels, usually smaller than PNG.",
    "WebP keeps no Ludo grid stamp, so a sheet's grid has to be given again (--grid) when it is read back."
  ],
  flags: [{ flag: "--to", value: "format", description: "png or webp (default png)" }],
  async run(ctx, call) {
    if (call.args.length !== 1) throw usageError("Usage: ludo toolbox image convert <image> --to webp");
    const to = (textFlag(call, "--to") ?? "png").toLowerCase().replace(/^\./, "");
    if (to !== "png" && to !== "webp") throw usageError(`--to takes png or webp (got "${to}")`);
    const src = loadImageFile(call.args[0]);
    const file = freeName(ctx.outDir, ctx.globals.name || baseOf(src.file), `.${to}`);
    if (to === "png") writePng(file, src.image, carriedChunks(src, src.grid, { trim: src.trim, extrude: src.extrude }));
    else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, encodeWebp(src.image));
    }
    const bytes = fs.statSync(file).size;
    const lost = to === "webp" && (src.grid || src.trim || src.extrude) ? "its grid, trim and extrude stamps (WebP keeps none)" : undefined;
    if (ctx.jsonOut) {
      printJson({ image: shown(src.file), saved: shown(file), format: to, width: src.image.width, height: src.image.height, bytes, ...(src.grid ? { grid: src.grid } : {}), ...(lost ? { dropped: lost } : {}) }, false);
    } else {
      process.stdout.write(`Saved ${shown(file)} (${src.image.width}x${src.image.height}, ${Math.max(1, Math.round(bytes / 1024))} KB)\n`);
      if (lost) process.stderr.write(`Note: the WebP drops ${lost}; pass --grid ${src.grid ? `${src.grid.cols}x${src.grid.rows}` : "CxR"} when you use it as a sheet.\n`);
    }
    return EXIT.OK;
  }
});

const hex = (c: number[]) => `#${c.slice(0, 3).map(v => v.toString(16).padStart(2, "0")).join("")}${c[3] === 255 ? "" : c[3].toString(16).padStart(2, "0")}`;

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
