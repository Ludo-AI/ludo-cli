import { spawnSync } from "node:child_process";
import { CliError, EXIT } from "../errors.js";
import type { Image } from "../tty/png.js";

// Video in and out through the ffmpeg the system has (the toolbox does not
// carry a video codec). Frames cross as raw RGBA on a pipe.

export interface VideoInfo {
  width: number;
  height: number;
  fps: number;
  duration: number; // seconds, 0 when the container does not say
  codec: string;
  alpha: boolean; // VP8/VP9 with an alpha channel (WebM's alpha_mode tag)
}

export const run = (cmd: string, args: string[], input?: Buffer) =>
  spawnSync(cmd, args, { input, maxBuffer: 2 ** 31, timeout: 10 * 60_000, windowsHide: true });

export function haveFfmpeg(): boolean {
  try {
    return run("ffmpeg", ["-version"]).status === 0 && run("ffprobe", ["-version"]).status === 0;
  } catch {
    return false;
  }
}

export const FFMPEG_INSTALL = process.platform === "darwin" ? "brew install ffmpeg" : process.platform === "win32" ? "winget install ffmpeg" : "sudo apt install ffmpeg (or your system's package)";

export function needFfmpeg(what = "Video", otherwise?: string) {
  if (haveFfmpeg()) return;
  throw new CliError(`${what} needs ffmpeg, which is not installed (ffmpeg and ffprobe on the PATH)`, EXIT.BAD_INPUT, `Install it: ${FFMPEG_INSTALL}${otherwise ? `; or ${otherwise}` : ""}`);
}

const rate = (r: string | undefined) => {
  const [a, b = "1"] = (r ?? "").split("/");
  const v = Number(a) / Number(b);
  return Number.isFinite(v) && v > 0 ? v : 0;
};

export function probeVideo(file: string): VideoInfo {
  const res = run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate,avg_frame_rate,codec_name:stream_tags=alpha_mode:format=duration", "-of", "json", file]);
  let info: { streams?: { width: number; height: number; r_frame_rate?: string; avg_frame_rate?: string; codec_name?: string; tags?: Record<string, string> }[]; format?: { duration?: string } };
  try {
    info = JSON.parse(res.stdout.toString());
  } catch {
    info = {};
  }
  const s = info.streams?.[0];
  if (res.status !== 0 || !s?.width || !s.height) throw new CliError(`Cannot read ${file} as a video: ${res.stderr.toString().trim().split("\n").pop() || "ffprobe found no video stream"}`, EXIT.BAD_INPUT);
  return {
    width: s.width,
    height: s.height,
    fps: rate(s.avg_frame_rate) || rate(s.r_frame_rate) || 30,
    duration: Number(info.format?.duration) || 0,
    codec: s.codec_name ?? "",
    alpha: /^(vp8|vp9)$/.test(s.codec_name ?? "") && s.tags?.alpha_mode === "1"
  };
}

export interface DecodeOptions {
  fps?: number; // resample to this rate (default: the video's)
  start?: number; // seconds
  duration?: number; // seconds
  width?: number; // resize to this width (height keeps the aspect)
  maxPixels: number; // refuse more than this in all frames together
}

// The frames as RGBA, after ffmpeg's fps and scale filters.
export function decodeVideo(file: string, info: VideoInfo, opts: DecodeOptions): Image[] {
  const w = opts.width ?? info.width;
  const h = opts.width ? Math.max(2, Math.round((info.height * opts.width) / info.width / 2) * 2) : info.height;
  const fps = opts.fps ?? info.fps;
  const seconds = opts.duration ?? Math.max(0, (info.duration || 0) - (opts.start ?? 0));
  if (seconds && w * h * Math.ceil(seconds * fps + 1) > opts.maxPixels) {
    throw new CliError(
      `${Math.ceil(seconds * fps)} frames of ${w}x${h} would be over ${opts.maxPixels / 1024 / 1024} megapixels`,
      EXIT.USAGE,
      "Take fewer frames (--fps, --start, --duration) or smaller ones (--width)."
    );
  }
  const filters = [`fps=${fps}`, ...(opts.width ? [`scale=${w}:${h}:flags=lanczos`] : [])];
  const args = [
    "-v",
    "error",
    // ffmpeg's own VP8/VP9 decoders drop alpha; libvpx keeps it.
    ...(info.alpha ? ["-c:v", info.codec === "vp8" ? "libvpx" : "libvpx-vp9"] : []),
    ...(opts.start ? ["-ss", String(opts.start)] : []),
    ...(opts.duration ? ["-t", String(opts.duration)] : []),
    "-i",
    file,
    "-vf",
    filters.join(","),
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgba",
    "pipe:1"
  ];
  const res = run("ffmpeg", args);
  if (res.status !== 0) throw new CliError(`ffmpeg could not decode ${file}: ${res.stderr.toString().trim().split("\n").pop()}`, EXIT.BAD_INPUT);
  const size = w * h * 4;
  const out: Image[] = [];
  for (let o = 0; o + size <= res.stdout.length; o += size) out.push({ width: w, height: h, rgba: new Uint8Array(res.stdout.subarray(o, o + size)) });
  if (!out.length) throw new CliError(`${file} gave no frames${opts.start ? ` after ${opts.start} s` : ""}`, EXIT.BAD_INPUT);
  return out;
}

export const VIDEO_FORMATS = ["webm", "mp4", "mov"] as const;
export type VideoFormat = (typeof VIDEO_FORMATS)[number];

// The encoder settings per format: WebM is VP9 with alpha, MOV ProRes 4444
// with alpha (editors), MP4 H.264 on a background (it has no alpha) at even
// sizes (4:2:0 needs them).
export function encodeVideo(frames: Image[], fps: number, format: VideoFormat, file: string, background: [number, number, number]) {
  let [w, h] = [frames[0].width, frames[0].height];
  let raw: Buffer;
  if (format === "mp4") {
    const [ew, eh] = [w + (w % 2), h + (h % 2)];
    raw = Buffer.alloc(ew * eh * 4 * frames.length);
    frames.forEach((f, k) => {
      const base = k * ew * eh * 4;
      for (let y = 0; y < eh; y++) {
        for (let x = 0; x < ew; x++) {
          const o = base + (y * ew + x) * 4;
          const inside = x < w && y < h;
          const i = (y * w + x) * 4;
          const a = inside ? f.rgba[i + 3] / 255 : 0;
          for (let c = 0; c < 3; c++) raw[o + c] = Math.round((inside ? f.rgba[i + c] : 0) * a + background[c] * (1 - a));
          raw[o + 3] = 255;
        }
      }
    });
    [w, h] = [ew, eh];
  } else {
    raw = Buffer.concat(frames.map(f => Buffer.from(f.rgba.buffer, f.rgba.byteOffset, f.rgba.length)));
  }
  const codec: Record<VideoFormat, string[]> = {
    webm: ["-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", "24", "-row-mt", "1", "-auto-alt-ref", "0"],
    mp4: ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-preset", "slow", "-movflags", "+faststart"],
    mov: ["-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le", "-vendor", "apl0"]
  };
  const res = run("ffmpeg", ["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${w}x${h}`, "-r", String(fps), "-i", "pipe:0", ...codec[format], file], raw);
  if (res.status !== 0) {
    const why = res.stderr.toString().trim().split("\n").pop() ?? "";
    throw new CliError(`ffmpeg could not write ${file}: ${why}`, EXIT.BAD_INPUT, /Unknown encoder/.test(why) ? "This ffmpeg was built without that encoder; try another --format." : undefined);
  }
  return { width: w, height: h };
}
