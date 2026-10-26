import fs from "node:fs";
import path from "node:path";
import { CliError, EXIT } from "../errors.js";
import { printJson, type Ctx } from "../generate.js";
import type { Image } from "../tty/png.js";
import { findGodotProject } from "../tty/godot.js";
import { writeUnityTileset } from "../tty/unity.js";
import { baseOf, freeName, loadImageFile, shown, writePng } from "./io.js";
import { crop } from "./sheet.js";
import { positiveInt, textFlag } from "./flags.js";
import { hint, TOOLS, type ToolCall } from "./registry.js";
import { noteFact } from "../telemetry.js";

// Tilesets: the tiles of a sheet of them, with spacing between tiles and a
// margin around them, as Tiled lays them out (columns = floor((width - 2 *
// margin + spacing) / (tile + spacing))), and the tileset files engines
// read: Tiled's .tsx, a Godot 4 TileSet .tres (one TileSetAtlasSource),
// Unity's .png.meta sliced into tiles (what a Tile Palette takes).

export interface TileRect {
  x: number;
  y: number;
  w: number;
  h: number;
  col: number;
  row: number;
}

export interface TileLayout {
  tileWidth: number;
  tileHeight: number;
  spacing: number;
  margin: number;
  columns: number;
  rows: number;
}

export function tileLayout(width: number, height: number, tileWidth: number, tileHeight: number, spacing = 0, margin = 0): TileLayout {
  const columns = Math.floor((width - 2 * margin + spacing) / (tileWidth + spacing));
  const rows = Math.floor((height - 2 * margin + spacing) / (tileHeight + spacing));
  return { tileWidth, tileHeight, spacing, margin, columns: Math.max(0, columns), rows: Math.max(0, rows) };
}

export function tileRects(l: TileLayout): TileRect[] {
  const out: TileRect[] = [];
  for (let row = 0; row < l.rows; row++) {
    for (let col = 0; col < l.columns; col++) out.push({ x: l.margin + col * (l.tileWidth + l.spacing), y: l.margin + row * (l.tileHeight + l.spacing), w: l.tileWidth, h: l.tileHeight, col, row });
  }
  return out;
}

export const isEmpty = (img: Image, r: TileRect) => {
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (img.rgba[(y * img.width + x) * 4 + 3]) return false;
  return true;
};

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

// Tiled's external tileset (TSX, format 1.10).
export function tiledTsx(name: string, image: string, width: number, height: number, l: TileLayout): string {
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<tileset version="1.10" tiledversion="1.11.0" name="${xml(name)}" tilewidth="${l.tileWidth}" tileheight="${l.tileHeight}"${l.spacing ? ` spacing="${l.spacing}"` : ""}${l.margin ? ` margin="${l.margin}"` : ""} tilecount="${l.columns * l.rows}" columns="${l.columns}">`,
    ` <image source="${xml(image)}" width="${width}" height="${height}"/>`,
    `</tileset>`,
    ``
  ].join("\n");
}

// A Godot 4 TileSet with one atlas source holding the tiles given (empty
// ones left out, as Godot's own atlas editor leaves them).
export function godotTileSet(texturePath: string, l: TileLayout, tiles: TileRect[]): string {
  const v = (x: number, y: number) => `Vector2i(${x}, ${y})`;
  return [
    `[gd_resource type="TileSet" format=3]`,
    ``,
    `[ext_resource type="Texture2D" path="${texturePath.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}" id="1_tiles"]`,
    ``,
    `[sub_resource type="TileSetAtlasSource" id="TileSetAtlasSource_1"]`,
    `texture = ExtResource("1_tiles")`,
    ...(l.margin ? [`margins = ${v(l.margin, l.margin)}`] : []),
    ...(l.spacing ? [`separation = ${v(l.spacing, l.spacing)}`] : []),
    `texture_region_size = ${v(l.tileWidth, l.tileHeight)}`,
    ...tiles.map(t => `${t.col}:${t.row}/0 = 0`),
    ``,
    `[resource]`,
    `tile_size = ${v(l.tileWidth, l.tileHeight)}`,
    `sources/0 = SubResource("TileSetAtlasSource_1")`,
    ``
  ].join("\n");
}

export const sizeFlag = (raw: string | undefined): [number, number] | undefined => {
  if (raw === undefined) return undefined;
  const m = /^\s*(\d+)\s*(?:x\s*(\d+))?\s*$/i.exec(raw);
  if (!m) throw new CliError(`--size takes WxH or one number for square tiles, like 16x16 or 32 (got "${raw}")`, EXIT.USAGE);
  const [w, h] = [Number(m[1]), Number(m[2] ?? m[1])];
  if (w < 1 || h < 1 || w > 4096 || h > 4096) throw new CliError("--size takes 1 to 4096 pixels a side", EXIT.USAGE);
  return [w, h];
};

const writeNew = (file: string, text: string) => {
  const dir = path.dirname(file);
  const ext = path.extname(file);
  const base = path.basename(file, ext);
  for (let n = 1; ; n++) {
    const target = path.join(dir, `${base}${n > 1 ? `-${n}` : ""}${ext}`);
    try {
      fs.writeFileSync(target, text, { flag: "wx" });
      return target;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
};

TOOLS.push({
  group: "image",
  name: "tiles",
  args: "<tileset>",
  summary: "Cut a tileset into tiles, or write the tileset files Tiled, Godot and Unity read",
  details: [
    "Tiles are --size apart with --spacing between them and --margin around them, as Tiled counts them.",
    "With no other flag every tile is saved as its own PNG (empty ones skipped) in a folder. Instead:",
    "  --tiled          a Tiled tileset (.tsx) next to the image",
    "  --engine godot   a Godot 4 TileSet (.tres): one atlas source, every non-empty tile",
    "  --engine unity   the image's .png.meta, sliced into one sprite per tile, for a Tile Palette",
    "Add --split to also save the tiles."
  ],
  flags: [
    { flag: "--size", value: "WxH", description: "Tile size in pixels, like 16x16 (or 16)" },
    { flag: "--spacing", value: "px", description: "Pixels between tiles (default 0)" },
    { flag: "--margin", value: "px", description: "Pixels around the tiles (default 0)" },
    { flag: "--tiled", description: "Write a Tiled tileset (.tsx) next to the image" },
    { flag: "--split", description: "Save every tile as its own PNG (the default without --tiled or --engine)" },
    { flag: "--keep-empty", description: "Keep fully transparent tiles too" }
  ],
  async run(ctx: Ctx, call: ToolCall) {
    if (call.args.length !== 1) throw new CliError("Usage: ludo toolbox image tiles <tileset> --size 16x16", EXIT.USAGE);
    const size = sizeFlag(textFlag(call, "--size"));
    if (!size) throw new CliError("Pass the tile size with --size, like --size 16x16", EXIT.USAGE);
    const nonNegative = (flag: string) => {
      const raw = textFlag(call, flag);
      const v = raw === undefined ? 0 : Number(raw);
      if (!Number.isInteger(v) || v < 0 || v > 1024) throw new CliError(`${flag} takes 0 to 1024 pixels (got "${raw}")`, EXIT.USAGE);
      return v;
    };
    const [spacing, margin] = [nonNegative("--spacing"), nonNegative("--margin")];
    const engine = ctx.globals.engine;
    if (engine === "texturepacker") throw new CliError("Tilesets export to Tiled (--tiled), Godot or Unity, not TexturePacker", EXIT.USAGE);
    const src = loadImageFile(call.args[0]);
    const { width, height } = src.image;
    const layout = tileLayout(width, height, size[0], size[1], spacing, margin);
    if (!layout.columns || !layout.rows) throw new CliError(`${size[0]}x${size[1]} tiles do not fit a ${width}x${height} image`, EXIT.USAGE);
    const all = tileRects(layout);
    const keepEmpty = call.flags.has("--keep-empty");
    const tiles = keepEmpty ? all : all.filter(r => !isEmpty(src.image, r));
    const used = { w: margin * 2 + layout.columns * (size[0] + spacing) - spacing, h: margin * 2 + layout.rows * (size[1] + spacing) - spacing };
    noteFact("frames", all.length);
    if (engine) noteFact("engine", engine);

    const files: string[] = [];
    if (call.flags.has("--tiled") || engine) {
      if (!/\.png$/i.test(src.file)) throw new CliError("Tileset files point at a PNG: convert the image to PNG first", EXIT.USAGE);
    }
    if (call.flags.has("--tiled")) {
      files.push(writeNew(src.file.replace(/\.png$/i, ".tsx"), tiledTsx(baseOf(src.file), path.basename(src.file), width, height, layout)));
    }
    if (engine === "godot") {
      const abs = path.resolve(src.file);
      const project = findGodotProject(path.dirname(abs));
      const texture = project ? `res://${path.relative(project, abs).split(path.sep).join("/")}` : path.basename(abs);
      files.push(writeNew(src.file.replace(/\.png$/i, ".tres"), godotTileSet(texture, layout, tiles)));
    }
    if (engine === "unity") files.push(writeUnityTileset(src.file, width, height, tiles));
    let folder: string | undefined;
    let first: string | undefined;
    if (call.flags.has("--split") || (!call.flags.has("--tiled") && !engine)) {
      folder = freeName(ctx.outDir, ctx.globals.name || `${baseOf(src.file)}-tiles`);
      const digits = String(all.length - 1).length;
      for (const t of tiles) {
        const file = path.join(folder, `tile-${String(t.row * layout.columns + t.col).padStart(digits, "0")}.png`);
        writePng(file, crop(src.image, t));
        first ??= file;
      }
    }

    const next = hint("Check a tile repeats without seams", `ludo toolbox image repeat ${first ? shown(first) : "<tile>"}`);
    const leftover = width - used.w || height - used.h ? { right: width - used.w, bottom: height - used.h } : undefined;
    if (ctx.jsonOut) {
      printJson(
        {
          tileset: shown(src.file),
          tile_width: size[0],
          tile_height: size[1],
          spacing,
          margin,
          columns: layout.columns,
          rows: layout.rows,
          tiles: all.length,
          empty: all.length - all.filter(r => !isEmpty(src.image, r)).length,
          ...(leftover ? { unused_pixels: leftover } : {}),
          ...(folder ? { folder: shown(folder), saved: tiles.length } : {}),
          ...(files.length ? { files: files.map(shown) } : {}),
          ...(ctx.globals.quiet ? {} : { hint: next })
        },
        false
      );
    } else {
      process.stdout.write(`${layout.columns}x${layout.rows} tiles of ${size[0]}x${size[1]}${all.length - tiles.length ? `, ${all.length - tiles.length} empty skipped` : ""}${leftover ? ` (${leftover.right} px right and ${leftover.bottom} px below left over)` : ""}\n`);
      if (folder) process.stdout.write(`Saved ${tiles.length} tiles in ${shown(folder)}\n`);
      for (const f of files) process.stdout.write(`Saved ${shown(f)}\n`);
      if (!ctx.globals.quiet) process.stderr.write(`Next: ${next.text}: ${next.command}\n`);
    }
    return EXIT.OK;
  }
});

// How much a tile jumps where it wraps: the mean colour step across the
// wrap (last column to first, over all rows) against the larger inner steps
// (the 95th percentile of the mean steps across every inner column
// boundary); the same down the rows. Near 1 or below, the wrap is no bigger
// than the edges inside the art; well above, it shows. (Against the inner
// steps as a whole, not the ones beside the wrap: in upscaled pixel art the
// columns inside an art pixel do not change at all.)
export function seams(img: Image): { x: number; y: number } {
  const { width: w, height: h, rgba } = img;
  const d = (a: number, b: number) => {
    const aa = rgba[a + 3] / 255;
    const ba = rgba[b + 3] / 255;
    return Math.abs(rgba[a] * aa - rgba[b] * ba) + Math.abs(rgba[a + 1] * aa - rgba[b + 1] * ba) + Math.abs(rgba[a + 2] * aa - rgba[b + 2] * ba) + Math.abs(rgba[a + 3] - rgba[b + 3]);
  };
  // `at(i, k)`: pixel i along the line, line k.
  const ratio = (lines: number, len: number, at: (i: number, k: number) => number) => {
    if (len < 3) return 1;
    const step = (i: number) => {
      let s = 0;
      for (let k = 0; k < lines; k++) s += d(at(i, k), at((i + 1) % len, k));
      return s / lines;
    };
    const inner = Array.from({ length: len - 1 }, (_, i) => step(i)).sort((a, b) => a - b);
    const p95 = inner[Math.min(inner.length - 1, Math.floor(inner.length * 0.95))];
    return (step(len - 1) + 1) / (p95 + 1);
  };
  const x = ratio(h, w, (i, y) => (y * w + i) * 4);
  const y = ratio(w, h, (i, x) => (i * w + x) * 4);
  return { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 };
}

TOOLS.push({
  group: "image",
  name: "repeat",
  args: "<tile>",
  summary: "Lay a tile out N x M times, and say whether its edges meet without a seam",
  details: [
    "The tile repeated --times (default 3x3), to look at; the JSON (and the line) say how much the tile",
    "jumps where it wraps, against the larger edges inside it: about 1 or less joins like the art,",
    "2.5 or more shows as a line."
  ],
  flags: [{ flag: "--times", value: "NxM", description: "Copies across and down (default 3x3)" }],
  async run(ctx: Ctx, call: ToolCall) {
    if (call.args.length !== 1) throw new CliError("Usage: ludo toolbox image repeat <tile> [--times 3x3]", EXIT.USAGE);
    const raw = textFlag(call, "--times") ?? "3x3";
    const m = /^\s*(\d+)\s*x\s*(\d+)\s*$/i.exec(raw);
    if (!m || +m[1] < 1 || +m[2] < 1 || +m[1] * +m[2] > 256) throw new CliError(`--times takes NxM, at most 256 copies (got "${raw}")`, EXIT.USAGE);
    const [nx, ny] = [Number(m[1]), Number(m[2])];
    const src = loadImageFile(call.args[0]);
    const { width: w, height: h } = src.image;
    const out: Image = { width: w * nx, height: h * ny, rgba: new Uint8Array(w * nx * h * ny * 4) };
    for (let y = 0; y < h * ny; y++) {
      for (let k = 0; k < nx; k++) out.rgba.set(src.image.rgba.subarray((y % h) * w * 4, ((y % h) + 1) * w * 4), (y * w * nx + k * w) * 4);
    }
    const s = seams(src.image);
    const file = freeName(ctx.outDir, ctx.globals.name || `${baseOf(src.file)}-x${nx}x${ny}`, ".png");
    writePng(file, out);
    const verdict = (v: number) => (v < 1.5 ? "seamless" : v < 2.5 ? "a faint seam" : "a visible seam");
    if (ctx.jsonOut) {
      printJson({ tile: shown(src.file), image: shown(file), width: out.width, height: out.height, seams: { across: s.x, down: s.y }, verdict: { across: verdict(s.x), down: verdict(s.y) } }, false);
    } else {
      process.stdout.write(`Across: ${verdict(s.x)} (${s.x}x its inner edges). Down: ${verdict(s.y)} (${s.y}x)\n`);
      process.stdout.write(`Saved ${shown(file)} (${out.width}x${out.height})\n`);
    }
    return EXIT.OK;
  }
});
