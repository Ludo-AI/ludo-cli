import fs from "node:fs";
import path from "node:path";
import { CliError, EXIT } from "../errors.js";
import { printJson, type Ctx } from "../generate.js";
import type { Image } from "../tty/png.js";
import { baseOf, freeName, loadImageFile, shown, writePng, type Loaded } from "./io.js";
import { positiveInt } from "./flags.js";
import { natural } from "./sprite.js";
import { canvas, checkerboard, drawImage, fitText, scaled, text, textHeight, textWidth, type Rgba } from "./draw.js";
import { GLYPHS } from "./font.js";
import { hint, TOOLS, type ToolCall } from "./registry.js";

// `ludo toolbox image contact`: one labelled PNG of several images, for an
// agent that can read one picture more easily than a folder. It draws a
// picture of them and never changes them. (A sheet's frames, with its
// measures drawn on, is `ludo toolbox sprite metrics --overlay`.)

const usage = (message: string) => new CliError(message, EXIT.USAGE);

const BG: Rgba = [22, 22, 29, 255];
const INK: Rgba = [232, 232, 240, 255];
const DIM: Rgba = [150, 150, 165, 255];
const SIZE = 2; // font pixels: 2 keeps labels readable after a viewer shrinks the image
export const MAX_SIDE = 2048;
const M = 12; // margin
const GAP = 6; // between cells

const round = (v: number, places = 2) => Math.round(v * 10 ** places) / 10 ** places;

function maxSideFlag(call: ToolCall): number {
  const v = positiveInt(call, "--max-size") ?? MAX_SIDE;
  if (v < 256 || v > 8192) throw usage("--max-size takes pixels from 256 to 8192");
  return v;
}

// ---- image contact ----

const IMAGE_FILE = /\.(png|webp|gif|jpe?g)$/i;

// Each argument is an image, or a folder whose images are taken in natural order.
function imageFiles(args: string[]): string[] {
  return args.flatMap(arg => {
    const stat = fs.statSync(arg, { throwIfNoEntry: false });
    if (!stat?.isDirectory()) return [arg];
    const found = fs.readdirSync(arg).filter(f => IMAGE_FILE.test(f)).sort(natural.compare);
    if (!found.length) throw usage(`No PNG, WebP, GIF or JPEG files in ${arg}`);
    return found.map(f => path.join(arg, f));
  });
}

export interface ImageContactLayout {
  cols: number;
  rows: number;
  cell: number; // the square each image is fitted into
  width: number;
  height: number;
  pitchX: number;
  pitchY: number;
  firstX: number;
  firstY: number;
}

const CAPTION_H = 2 * (textHeight(SIZE) + 4) + 4;
const IMAGE_HEADER_H = M + textHeight(SIZE) + 10;

function imageLayoutAt(count: number, cols: number, cell: number): ImageContactLayout {
  const rows = Math.ceil(count / cols);
  const pitchX = cell + GAP * 2;
  const pitchY = cell + CAPTION_H + GAP * 2;
  return { cols, rows, cell, width: 2 * M + cols * pitchX - 2 * GAP, height: IMAGE_HEADER_H + rows * pitchY - 2 * GAP + M, pitchX, pitchY, firstX: M, firstY: IMAGE_HEADER_H };
}

// The biggest square cell, up to `maxCell`, over every column count that
// keeps the picture within `maxSide`.
export function imageContactLayout(count: number, maxSide = MAX_SIDE, maxCell = 256, wantCols?: number): ImageContactLayout {
  let best: ImageContactLayout | undefined;
  for (let cols = wantCols ?? 1; cols <= (wantCols ?? count); cols++) {
    let cell = maxCell;
    while (cell >= 16) {
      const l = imageLayoutAt(count, cols, cell);
      if (l.width <= maxSide && l.height <= maxSide) break;
      cell--;
    }
    if (cell < 16) continue;
    const l = imageLayoutAt(count, cols, cell);
    const squareness = (x: ImageContactLayout) => Math.min(x.width, x.height) / Math.max(x.width, x.height);
    const empty = (x: ImageContactLayout) => x.cols * x.rows - count;
    // The biggest cells; then the fewest empty ones; then the squarer picture.
    if (!best || l.cell > best.cell || (l.cell === best.cell && (empty(l) < empty(best) || (empty(l) === empty(best) && squareness(l) > squareness(best))))) best = l;
  }
  if (!best) throw new CliError(`${count} images do not fit a ${maxSide} px picture`, EXIT.USAGE, "Pass fewer images, or allow more with --max-size.");
  return best;
}

// The scale that fits an image in a cell: whole factors up (pixel art keeps
// its pixels), any factor down.
export function fitScale(w: number, h: number, cell: number): number {
  const s = cell / Math.max(w, h);
  return s >= 1 ? Math.floor(s) : s;
}

// A name in the picture's font: accents dropped (héros -> heros), and each
// run of characters it has no glyph for (ドラゴン) as ~ and four hex digits
// of the run's hash, so names in other scripts still tell apart.
export function drawableName(name: string): string {
  const plain = name.normalize("NFD").replace(/\p{M}/gu, "");
  let out = "";
  let run = "";
  const flush = () => {
    if (!run) return;
    let h = 0x811c9dc5; // FNV-1a
    for (const ch of run) h = Math.imul(h ^ ch.codePointAt(0)!, 0x01000193) >>> 0;
    out += `~${(h & 0xffff).toString(16).padStart(4, "0")}`;
    run = "";
  };
  for (const ch of plain) {
    if (GLYPHS.has(ch)) (flush(), (out += ch));
    else run += ch;
  }
  flush();
  return out;
}

// A name cut in the middle to fit, keeping its start and more of its end
// (takes of one prompt differ at the end: createImage-9f3a2b...-3.png).
export function fitMiddle(s: string, width: number, size = 1): string {
  if (textWidth(s, size) <= width) return s;
  const chars = [...s];
  for (let keep = chars.length - 1; keep > 1; keep--) {
    const tail = Math.ceil((2 * keep) / 3);
    const cut = chars.slice(0, keep - tail).join("") + "..." + chars.slice(chars.length - tail).join("");
    if (textWidth(cut, size) <= width) return cut;
  }
  return fitText(s, width, size);
}

export function drawImageContact(images: { name: string; image: Image; size?: string }[], opts: { maxSide: number; cell?: number; cols?: number; title: string }) {
  const l = imageContactLayout(images.length, opts.maxSide, opts.cell ?? 256, opts.cols);
  const img = canvas(l.width, l.height, BG);
  text(img, M, M, fitText(opts.title, l.width - 2 * M, SIZE), INK, SIZE);
  const placed = images.map(({ name, image, size }, k) => {
    const x = l.firstX + (k % l.cols) * l.pitchX;
    const y = l.firstY + Math.floor(k / l.cols) * l.pitchY;
    const s = fitScale(image.width, image.height, l.cell);
    const shownImg = scaled(image, s);
    checkerboard(img, x, y, l.cell, l.cell);
    const ix = x + Math.floor((l.cell - shownImg.width) / 2);
    const iy = y + Math.floor((l.cell - shownImg.height) / 2);
    drawImage(img, shownImg, ix, iy);
    // Numbered, so a cell is named even when its name is cut.
    const number = `${k + 1} `;
    const caption = number + fitMiddle(drawableName(name), l.cell - textWidth(number, SIZE), SIZE);
    text(img, x, y + l.cell + 4, caption, INK, SIZE);
    text(img, x, y + l.cell + 8 + textHeight(SIZE), fitText(`${size ?? `${image.width}x${image.height}`}${s !== 1 ? ` at ${round(s, 2)}x` : ""}`, l.cell, SIZE), DIM, SIZE);
    return { x, y, scale: s, label: caption, drawn: { x: ix, y: iy, width: shownImg.width, height: shownImg.height } };
  });
  return { image: img, layout: l, placed };
}

TOOLS.push({
  group: "image",
  name: "contact",
  args: "<images...>",
  summary: "One PNG of several images side by side, each labelled with its name and size",
  details: [
    "For an agent comparing a set: icons, a UI kit, a character's variations, takes of one prompt.",
    "Images are files, or folders of them taken in natural order (icon-2 before icon-10). Each is",
    "fitted into a square cell on a checkerboard: enlarged by whole factors (pixel art keeps its",
    "pixels), or shrunk to fit; its number, its name (cut in the middle when long) and its real size",
    "are printed under it. An animated GIF or WebP shows as its frames' sheet, captioned with one frame's",
    "size and the frame count. A file that does not read is left out with a note. The picture is at most",
    `${MAX_SIDE} px a side. It only draws: the images are not changed.`
  ],
  flags: [
    { flag: "--cols", value: "n", description: "Images per row (default: whatever shows them largest)" },
    { flag: "--cell", value: "px", description: "The largest cell (default 256)" },
    { flag: "--max-size", value: "px", description: `The picture's longest side (default ${MAX_SIDE})` }
  ],
  async run(ctx: Ctx, call: ToolCall) {
    if (!call.args.length) throw usage("Usage: ludo toolbox image contact <images...>");
    const maxSide = maxSideFlag(call);
    const cell = positiveInt(call, "--cell") ?? 256;
    if (cell < 16 || cell > 1024) throw usage("--cell takes pixels from 16 to 1024");
    const files = imageFiles(call.args);
    if (files.length > 400) throw usage(`${files.length} images is too many for one picture; the limit is 400`);
    const cols = positiveInt(call, "--cols");
    if (cols !== undefined && cols > files.length) throw usage(`--cols ${cols} is more than the ${files.length} images`);
    // A file that does not read is left out, with a note, not the whole picture.
    const skipped: { file: string; error: string }[] = [];
    const loaded = files.flatMap(f => {
      try {
        return [loadImageFile(f)];
      } catch (err) {
        if (!(err instanceof CliError)) throw err;
        skipped.push({ file: shown(f), error: err.message });
        return [];
      }
    });
    if (!loaded.length) throw new CliError(`None of the images could be read: ${skipped.map(x => x.error).join("; ")}`, EXIT.BAD_INPUT);
    if (cols !== undefined && cols > loaded.length) throw usage(`--cols ${cols} is more than the ${loaded.length} images read`);
    // An animated GIF or WebP is drawn as its frames' sheet, captioned with its own size.
    const own = (s: Loaded) => (s.animation && s.grid ? { width: s.image.width / s.grid.cols, height: s.image.height / s.grid.rows, frames: s.grid.frames } : { width: s.image.width, height: s.image.height });
    const items = loaded.map(s => {
      const o = own(s);
      return { name: path.basename(s.file), image: s.image, size: `${o.width}x${o.height}${"frames" in o ? `, ${o.frames} frames` : ""}` };
    });
    const sheet = drawImageContact(items, { maxSide, cell, cols, title: `${items.length} images${skipped.length ? ` (${skipped.length} unreadable, left out)` : ""}` });
    const l = sheet.layout;
    const file = freeName(ctx.outDir, ctx.globals.name || (files.length === 1 ? `${baseOf(files[0])}-contact` : "contact"), ".png");
    writePng(file, sheet.image);

    const next = hint("Change one of them with Ludo", `ludo image edit --image <one of them> --prompt "<the change>"`);
    if (ctx.jsonOut) {
      printJson(
        {
          image: shown(file),
          width: l.width,
          height: l.height,
          layout: { cols: l.cols, rows: l.rows, cell: l.cell, first_cell: { x: l.firstX, y: l.firstY }, pitch: { x: l.pitchX, y: l.pitchY } },
          images: loaded.map((s, k) => {
            const o = own(s);
            return { number: k + 1, file: shown(s.file), label: sheet.placed[k].label, ...o, scale: round(sheet.placed[k].scale, 3), at: sheet.placed[k].drawn };
          }),
          ...(skipped.length ? { skipped } : {}),
          legend: {
            checkerboard: "transparent pixels",
            caption:
              "the image's number and file name (cut in the middle when long; accents dropped, and characters the font lacks as ~ and a hash), then its size in pixels (an animated GIF or WebP: one frame's, and how many; it is drawn as its frames side by side) and the scale it is shown at, when not 1"
          },
          ...(ctx.globals.quiet ? {} : { hint: next })
        },
        false
      );
    } else {
      process.stdout.write(`${items.length} images in a ${l.cols}x${l.rows} grid of ${l.cell} px cells\n`);
      sheet.placed.forEach((p, k) => {
        if (p.label !== `${k + 1} ${items[k].name}`) process.stdout.write(`  ${k + 1}  ${shown(loaded[k].file)}\n`);
      });
      for (const x of skipped) process.stdout.write(`Skipped ${x.file}: ${x.error}\n`);
      process.stdout.write(`Saved ${shown(file)} (${l.width}x${l.height})\n`);
      if (!ctx.globals.quiet) process.stderr.write(`Next: ${next.text}: ${next.command}\n`);
    }
    return EXIT.OK;
  }
});
