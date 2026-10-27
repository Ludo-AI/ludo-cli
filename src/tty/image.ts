import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decodePng, encodePng, isPng, type Image } from "./png.js";
import { decodeWebpPreview, isWebp } from "./webp.js";

// Any image a preview might meet. PNG and WebP are decoded in-process; JPEG
// and the rest go through a converter the system already has (sips on
// macOS, ImageMagick or ffmpeg elsewhere) into a temporary PNG. No
// converter, no preview: the caller says so and nothing else changes.

function which(cmd: string): boolean {
  try {
    return spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

function converters(src: string, dst: string): [string, string[]][] {
  const list: [string, string[]][] = [];
  if (process.platform === "darwin") list.push(["sips", ["-s", "format", "png", src, "--out", dst]]);
  list.push(["magick", [src, `png:${dst}`]], ["convert", [src, `png:${dst}`]], ["ffmpeg", ["-loglevel", "quiet", "-y", "-i", src, "-frames:v", "1", dst]]);
  return list;
}

// Writes a PNG copy of any image: a WebP (an animation's first frame) in
// process, anything else through a converter. Returns false when it cannot
// (dst is then absent).
export function convertToPng(src: string, dst: string): boolean {
  try {
    const buf = fs.readFileSync(src);
    if (isWebp(buf)) {
      const img = decodeWebpPreview(buf);
      if (img) fs.writeFileSync(dst, encodePng(img));
      return !!img;
    }
    for (const [cmd, args] of converters(src, dst)) {
      if (!(process.platform === "darwin" && cmd === "sips") && !which(cmd)) continue;
      const res = spawnSync(cmd, args, { stdio: "ignore", timeout: 60_000 });
      if (res.status === 0 && fs.existsSync(dst) && isPng(fs.readFileSync(dst))) return true;
      fs.rmSync(dst, { force: true });
    }
  } catch {
    fs.rmSync(dst, { force: true });
  }
  return false;
}

export function loadImage(file: string): Image | undefined {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return undefined;
  }
  if (isPng(buf)) return decodePng(buf);
  if (isWebp(buf)) return decodeWebpPreview(buf);

  const tmp = path.join(os.tmpdir(), `ludo-preview-${process.pid}-${Date.now()}.png`);
  try {
    return convertToPng(file, tmp) ? decodePng(fs.readFileSync(tmp)) : undefined;
  } catch {
    return undefined;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
