import fs from "node:fs";
import path from "node:path";
import { CliError, EXIT } from "../errors.js";
import { printJson, type Ctx } from "../generate.js";
import { MAX_TOOLBOX_PIXELS, type Image } from "../tty/png.js";
import type { Grid } from "../tty/preview.js";
import { carriedChunks, engineFiles, freeName, shown, writePng } from "./io.js";
import { layoutSheet } from "./sheet.js";
import type { ArtMode } from "./pack.js";
import { uniquifyNames } from "./packMath.js";
import { buildSequence, type AlignMode, type Transition } from "./sequence.js";
import { MAX_SEQUENCE_FRAME_PX, sequenceGrid } from "./sequenceMath.js";
import { folderName, frameSizeFlag, manifestPath, parseNumber, perAnimation, readInputs, readManifest, usage, type SavedAnimation } from "./animations.js";
import { textFlag } from "./flags.js";
import { hint, TOOLS, type ToolCall } from "./registry.js";

// `ludo toolbox sprite sequence`: the web app's Export Sequence, offline. The
// pixel work is sequence.ts; this reads the inputs and flags, writes the
// sheet(s) or frames and a sequence.json manifest that re-runs it exactly,
// alignment included.

const MANIFEST_VERSION = 1;
const MODES = ["single", "separate", "frames"] as const;
type Mode = (typeof MODES)[number];
const ALIGNS: AlignMode[] = ["auto", "ground", "none"];
const METHODS: Transition["method"][] = ["ncc", "ground", "none"];

interface SavedTransition {
  dx: number;
  dy: number;
  scale: number;
  method: Transition["method"];
  confidence: number | null;
}

interface Manifest {
  ludo: "toolbox sprite sequence";
  version: number;
  name: string;
  mode: Mode;
  art: ArtMode;
  align: AlignMode;
  frame_size: { width?: number; height?: number } | null;
  size: number | null;
  vertical: number | null;
  horizontal: number | null;
  animations: SavedAnimation[];
  transitions: SavedTransition[];
}

const round = (n: number, digits: number) => Math.round(n * 10 ** digits) / 10 ** digits;
const confidence = (t: Transition) => (Number.isNaN(t.confidence) ? null : round(t.confidence, 3));

// A transition from a manifest, possibly edited by hand.
function savedTransition(t: SavedTransition | undefined, file: string, i: number): Transition {
  const ok = t && [t.dx, t.dy, t.scale].every(Number.isFinite) && t.scale > 0 && t.scale <= 16;
  if (!ok) throw new CliError(`${file}: transition ${i + 1} needs whole-pixel dx and dy and a scale above 0, up to 16`, EXIT.BAD_INPUT);
  return { dx: Math.round(t.dx), dy: Math.round(t.dy), scale: t.scale, confidence: t.confidence ?? Number.NaN, method: METHODS.includes(t.method) ? t.method : "none" };
}

TOOLS.push({
  group: "sprite",
  name: "sequence",
  args: "<sheets...>",
  summary: "Chain animations one after another (idle, jump, land) so the moves join up",
  details: [
    "The Ludo web app's Export Sequence, offline. Each input is a spritesheet (or a folder of frames) of",
    "one animation, in the order they play; give one twice to play it twice. Each animation is placed so",
    "its first frame continues from the last frame of the one before: --align auto finds the offset and",
    "scale that best match the two frames (image matching, NCC), or lines up their feet and centres when",
    "the match is poor; ground always does the latter; none puts every animation at the same spot. The",
    "output gives each transition's offset and confidence.",
    "",
    "All frames are then cropped to the box around everything that moves. --frame-size sets the output",
    "frame (grown if the content is bigger), --size the content's height in pixels, --vertical its",
    "distance from the frame bottom (default: centred) and --horizontal its offset from the centre: the",
    "web's Size, Vertical and Horizontal.",
    "",
    "--mode single writes one sheet; separate, one sheet per animation, numbered; frames, one PNG each.",
    "The folder gets a sequence.json that re-runs it exactly, with its alignment: ludo toolbox sprite",
    "sequence --manifest <dir>/sequence.json (flags given with it override it; --align aligns again).",
    "Edit a transition's dx, dy or scale there to adjust it by hand.",
    "",
    "--art smooth resizes with area averaging when shrinking and bicubic when enlarging; pixel uses",
    "nearest neighbour. --name names the folder (default animation-sequence); --engine",
    "texturepacker|godot writes engine files next to each sheet."
  ],
  flags: [
    { flag: "--mode", value: "single|separate|frames", description: "One sheet (default), one per animation, or one PNG per frame" },
    { flag: "--align", value: "auto|ground|none", description: "How each animation continues from the one before (default auto)" },
    { flag: "--art", value: "smooth|pixel", description: "Resizing for painted art (default) or pixel art" },
    { flag: "--frame-size", value: "WxH", description: "Output frame size, like 256x256 (or 256x, x256); grown to fit" },
    { flag: "--size", value: "px", description: "Height of the content in the frame (default: as it is)" },
    { flag: "--vertical", value: "px", description: "Content's distance from the frame bottom (default: centred)" },
    { flag: "--horizontal", value: "px", description: "Content's offset from the frame centre, right is positive" },
    { flag: "--label", value: "anim=name", description: "Name an animation's output (default: its file name)" },
    { flag: "--fps", value: "[anim=]n", description: "Frame rate the sheets remember (default: each sheet's, else 10)" },
    { flag: "--grid", value: "[anim=]CxR", description: "A sheet's grid, when it has no Ludo stamp and detection is unsure" },
    { flag: "--manifest", value: "file", description: "Re-run a sequence from its sequence.json" }
  ],
  async run(ctx: Ctx, call: ToolCall) {
    const manifestFile = textFlag(call, "--manifest");
    if (manifestFile !== undefined && call.args.length) throw usage("Pass the animations or --manifest, not both");
    if (manifestFile === undefined && !call.args.length) throw usage("Usage: ludo toolbox sprite sequence <sheets...> (or --manifest sequence.json)");
    const manifest = manifestFile !== undefined ? readManifest<Manifest>(manifestFile, "sprite sequence", MANIFEST_VERSION, "sequence") : undefined;
    const base = manifestFile !== undefined ? path.dirname(path.resolve(manifestFile)) : process.cwd();

    const mode = (textFlag(call, "--mode") ?? manifest?.mode ?? "single") as Mode;
    if (!MODES.includes(mode)) throw usage(`--mode is single, separate or frames (got "${mode}")`);
    const art = (textFlag(call, "--art") ?? manifest?.art ?? "smooth") as ArtMode;
    if (art !== "smooth" && art !== "pixel") throw usage(`--art is smooth or pixel (got "${art}")`);
    const alignFlag = textFlag(call, "--align") as AlignMode | undefined;
    if (alignFlag !== undefined && !ALIGNS.includes(alignFlag)) throw usage(`--align is auto, ground or none (got "${alignFlag}")`);
    const align = alignFlag ?? manifest?.align ?? "auto";
    const frameSize = frameSizeFlag(textFlag(call, "--frame-size"), MAX_SEQUENCE_FRAME_PX) ?? manifest?.frame_size ?? undefined;
    const pixels = (flag: string, check: (n: number) => boolean, what: string) => {
      const v = textFlag(call, flag);
      return v === undefined ? undefined : parseNumber(flag, check, what)(v);
    };
    const size = pixels("--size", n => Number.isInteger(n) && n >= 1 && n <= MAX_SEQUENCE_FRAME_PX, `whole pixels, 1 to ${MAX_SEQUENCE_FRAME_PX}`) ?? manifest?.size ?? null;
    const vertical = pixels("--vertical", n => Number.isInteger(n) && n >= 0, "whole pixels, 0 or more") ?? manifest?.vertical ?? null;
    const horizontal = pixels("--horizontal", Number.isInteger, "whole pixels, like -4") ?? manifest?.horizontal ?? null;

    const inputs = manifest ? manifest.animations.map(a => path.resolve(base, a.input)) : call.args;
    const { animations, names, warnings } = readInputs(call, inputs, manifest?.animations);
    const fpsFlags = perAnimation(call, "--fps", names, parseNumber("--fps", n => n > 0, "a number above 0"));
    const fps = animations.map((a, i) => fpsFlags.get(i) ?? manifest?.animations[i].fps ?? a.grid.fps);

    // A manifest's transitions are kept unless --align asks to align again.
    const kept = manifest && alignFlag === undefined ? animations.slice(1).map((_, i) => savedTransition(manifest.transitions?.[i], manifestFile!, i)) : undefined;
    if (kept && warnings.length) warnings.push("The saved alignment was kept; add --align auto to align again");

    const seq = buildSequence(
      animations.map(a => a.frames),
      { art, align, transitions: kept, frameSize: frameSize ? { w: frameSize.width, h: frameSize.height } : undefined, placement: { size, vertical, horizontal } }
    );
    const { frameW: fw, frameH: fh } = seq.layout;
    const total = animations.reduce((n, a) => n + a.frames.length, 0);
    const sheetGrids = mode === "single" ? [sequenceGrid(total)] : mode === "separate" ? animations.map(a => sequenceGrid(a.frames.length)) : [];
    for (const g of sheetGrids) {
      if (fw * g.cols * fh * g.rows > MAX_TOOLBOX_PIXELS) throw usage(`A ${g.cols}x${g.rows} sheet of ${fw}x${fh} frames is over ${MAX_TOOLBOX_PIXELS / 1024 / 1024} megapixels`, "Use a smaller --size, or --mode frames.");
    }

    const labels = uniquifyNames(names.map(n => n[n.length - 1]));
    seq.transitions.forEach((t, i) => {
      if (!kept && align === "auto" && t.method === "ground") {
        warnings.push(`${labels[i]} -> ${labels[i + 1]}: the frames did not match well (confidence ${confidence(t)}), so their feet and centres were lined up instead; check it, or set it in the manifest`);
      }
    });
    if (mode !== "separate" && new Set(fps).size > 1) warnings.push(`The animations have different frame rates (${fps.join(", ")}); the ${mode === "single" ? "sheet" : "sequence"} uses ${fps[0]}`);

    const name = ctx.globals.name ?? manifest?.name ?? "Animation Sequence";
    const slug = folderName(name, "animation-sequence");
    const dir = freeName(ctx.outDir, slug);
    fs.mkdirSync(dir, { recursive: true });
    const chunks = (i: number, grid?: Grid) => (animations[i].src ? carriedChunks(animations[i].src!, grid) : []);
    const sheetOf = (frames: Image[], cols: number, rows: number) => layoutSheet(frames, cols, rows);

    const sheets: { file: string; label: string; grid: Grid; engine: string[] }[] = [];
    const frameFilesOut: string[] = [];
    if (mode === "single") {
      const { cols, rows } = sheetGrids[0];
      const grid: Grid = { cols, rows, frames: total, fps: fps[0] };
      const sheet = sheetOf(seq.frames.flat(), cols, rows);
      const file = path.join(dir, `${slug}.png`);
      writePng(file, sheet, chunks(0, grid));
      sheets.push({ file, label: slug, grid, engine: engineFiles(ctx, file, sheet, grid, {}, slug) });
    } else if (mode === "separate") {
      seq.frames.forEach((frames, i) => {
        const { cols, rows } = sheetGrids[i];
        const grid: Grid = { cols, rows, frames: frames.length, fps: fps[i] };
        const sheet = sheetOf(frames, cols, rows);
        const file = path.join(dir, `${String(i + 1).padStart(2, "0")}-${labels[i]}.png`);
        writePng(file, sheet, chunks(i, grid));
        sheets.push({ file, label: labels[i], grid, engine: engineFiles(ctx, file, sheet, grid, {}, labels[i]) });
      });
    } else {
      seq.frames.flat().forEach((f, k) => {
        const file = path.join(dir, `frame_${String(k).padStart(4, "0")}.png`);
        writePng(file, f, chunks(0));
        frameFilesOut.push(file);
      });
    }

    const manifestOut = path.join(dir, "sequence.json");
    const saved: Manifest = {
      ludo: "toolbox sprite sequence",
      version: MANIFEST_VERSION,
      name,
      mode,
      art,
      align,
      frame_size: frameSize ?? null,
      size,
      vertical,
      horizontal,
      animations: animations.map((a, i) => ({
        input: manifestPath(dir, a.input),
        kind: a.kind,
        ...(a.sha256 ? { sha256: a.sha256 } : {}),
        label: labels[i],
        grid: { cols: a.grid.cols, rows: a.grid.rows, frames: a.grid.frames },
        fps: fps[i]
      })),
      transitions: seq.transitions.map(t => ({ dx: t.dx, dy: t.dy, scale: t.scale, method: t.method, confidence: confidence(t) }))
    };
    fs.writeFileSync(manifestOut, JSON.stringify(saved, null, 2) + "\n");

    const transitions = seq.transitions.map((t, i) => ({ from: labels[i], to: labels[i + 1], dx: t.dx, dy: t.dy, scale: round(t.scale, 4), method: t.method, confidence: confidence(t), ...(kept ? { saved: true } : {}) }));
    const next =
      mode === "single"
        ? hint("Preview it as a GIF", `ludo toolbox sprite gif ${shown(sheets[0].file)}`)
        : hint("Animate the next move for the same character with Ludo, then add it to the sequence", `ludo sprite animate --initial-image <a frame> --motion-prompt "<what it does>"`);
    if (ctx.jsonOut) {
      printJson(
        {
          sequence: shown(dir),
          manifest: shown(manifestOut),
          mode,
          art,
          align,
          frame_width: fw,
          frame_height: fh,
          frames: total,
          content: { width: seq.content.width, height: seq.content.height },
          size: seq.layout.drawH,
          vertical: seq.layout.vertical,
          horizontal: seq.layout.horizontal,
          transitions,
          animations: animations.map((a, i) => ({ input: shown(a.input), label: labels[i], frames: a.frames.length, fps: fps[i], ...(mode === "separate" ? { sheet: shown(sheets[i].file) } : {}) })),
          ...(mode === "single" ? { sheet: shown(sheets[0].file), grid: { cols: sheets[0].grid.cols, rows: sheets[0].grid.rows } } : {}),
          ...(mode === "frames" ? { dir: shown(dir), first_frame: shown(frameFilesOut[0]) } : {}),
          ...(sheets.some(s => s.engine.length) ? { engine_files: sheets.flatMap(s => s.engine).map(shown) } : {}),
          ...(warnings.length ? { warnings } : {}),
          ...(ctx.globals.quiet ? {} : { hint: next })
        },
        false
      );
    } else {
      const out = (line: string) => process.stdout.write(line + "\n");
      out(`${animations.length} animation${animations.length === 1 ? "" : "s"}, ${total} frames of ${fw}x${fh} (${art} art)`);
      const width = Math.max(...transitions.map(t => `${t.from} -> ${t.to}`.length), 0);
      for (const t of transitions) {
        const how = t.method === "ncc" ? `matched, confidence ${t.confidence}` : t.method === "ground" ? "feet and centres lined up" : "not aligned";
        out(`  ${`${t.from} -> ${t.to}`.padEnd(width)}  moved ${t.dx}, ${t.dy} px, scale ${t.scale.toFixed(2)} (${t.saved ? "saved; " : ""}${how})`);
      }
      if (mode === "frames") out(`  -> ${shown(dir)}${path.sep}frame_0000.png ... frame_${String(total - 1).padStart(4, "0")}.png`);
      for (const s of sheets) out(`  -> ${shown(s.file)} (${s.grid.cols}x${s.grid.rows})${s.engine.length ? ` + ${s.engine.map(shown).join(", ")}` : ""}`);
      out(`Saved ${shown(dir)}${path.sep}; re-run it with: ludo toolbox sprite sequence --manifest ${shown(manifestOut)}`);
      for (const w of warnings) process.stderr.write(`Note: ${w}\n`);
      if (!ctx.globals.quiet) process.stderr.write(`Next: ${next.text}: ${next.command}\n`);
    }
    return EXIT.OK;
  }
});
