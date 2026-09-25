import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decodePng, isPng, type Image } from "./png.js";

// Any image a preview might meet. PNG is decoded in-process; WebP, JPEG and
// the rest go through a converter the system already has (sips on macOS,
// dwebp, ImageMagick or ffmpeg elsewhere) into a temporary PNG. No converter,
// no preview: the caller says so and nothing else changes.

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
  if (/\.webp$/i.test(src)) list.push(["dwebp", ["-quiet", src, "-o", dst]]);
  list.push(["magick", [src, `png:${dst}`]], ["convert", [src, `png:${dst}`]], ["ffmpeg", ["-loglevel", "quiet", "-y", "-i", src, "-frames:v", "1", dst]]);
  return list;
}

// Writes a PNG copy of any image the system can convert. Returns false when
// no converter is available or the conversion failed (dst is then absent).
export function convertToPng(src: string, dst: string): boolean {
  try {
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

  const tmp = path.join(os.tmpdir(), `ludo-preview-${process.pid}-${Date.now()}.png`);
  try {
    return convertToPng(file, tmp) ? decodePng(fs.readFileSync(tmp)) : undefined;
  } catch {
    return undefined;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
