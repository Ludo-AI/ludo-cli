import { encodePng, type Image } from "./png.js";

// Real images in terminals that can show them. Two protocols cover the
// terminals that matter: Kitty's graphics protocol (Kitty, Ghostty, WezTerm)
// and iTerm2's inline images (iTerm2, WezTerm). Everything else gets no
// picture rather than a blurry one; see preview.ts for the pixel-art case.

export type Protocol = "kitty" | "iterm" | undefined;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function detectProtocol(env = process.env): Protocol {
  // tmux swallows both protocols unless passthrough is configured.
  if (env.TMUX || env.TERM_PROGRAM === "tmux" || /^screen/.test(env.TERM || "")) return undefined;
  if (env.KITTY_WINDOW_ID || env.TERM === "xterm-kitty" || env.TERM_PROGRAM === "ghostty" || env.GHOSTTY_RESOURCES_DIR) return "kitty";
  if (env.TERM_PROGRAM === "WezTerm") return "kitty";
  if (env.TERM_PROGRAM === "iTerm.app" || env.LC_TERMINAL === "iTerm2") return "iterm";
  return undefined;
}

export function crop(img: Image, r: Rect): Image {
  const rgba = new Uint8Array(r.w * r.h * 4);
  for (let y = 0; y < r.h; y++) {
    const from = ((r.y + y) * img.width + r.x) * 4;
    rgba.set(img.rgba.subarray(from, from + r.w * 4), y * r.w * 4);
  }
  return { width: r.w, height: r.h, rgba };
}

// Terminal cells are about twice as tall as they are wide.
export function cellSize(img: { width: number; height: number }, maxCols: number, maxRows: number): { cols: number; rows: number } {
  const aspect = img.width / img.height; // width over height, in pixels
  let rows = maxRows;
  let cols = Math.round(rows * 2 * aspect);
  if (cols > maxCols) {
    cols = maxCols;
    rows = Math.max(1, Math.round(cols / (2 * aspect)));
  }
  return { cols: Math.max(1, cols), rows: Math.max(1, rows) };
}

// Kitty: PNG data (f=100) in 4096-byte base64 chunks. `id` lets a later
// transmit replace the image in place (how animation works); C=1 keeps the
// cursor still so frames can be redrawn at the same spot.
export function kittySequence(png: Buffer, cols: number, rows: number, id?: number): string {
  const b64 = png.toString("base64");
  const parts: string[] = [];
  for (let i = 0; i < b64.length; i += 4096) parts.push(b64.slice(i, i + 4096));
  const head = `a=T,f=100,q=2,C=1,c=${cols},r=${rows}${id ? `,i=${id},p=1` : ""}`;
  return parts.map((chunk, n) => `\x1b_G${n === 0 ? head + "," : ""}m=${n < parts.length - 1 ? 1 : 0};${chunk}\x1b\\`).join("");
}

// iTerm2: the whole file in one OSC 1337 sequence, sized in cells.
export function itermSequence(png: Buffer, cols: number, rows: number): string {
  return `\x1b]1337;File=inline=1;size=${png.length};width=${cols};height=${rows};preserveAspectRatio=1:${png.toString("base64")}\x07`;
}

export function imageSequence(protocol: Exclude<Protocol, undefined>, img: Image, cols: number, rows: number, id?: number): string {
  const png = encodePng(img, { fast: true });
  return protocol === "kitty" ? kittySequence(png, cols, rows, id) : itermSequence(png, cols, rows);
}
