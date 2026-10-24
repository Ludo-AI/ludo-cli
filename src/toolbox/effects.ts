import type { Image } from "../tty/png.js";

// Outlines and drop shadows: a layer made from the sprite's alpha, put under
// the sprite.
//
// The outline's layer is the alpha dilated (each pixel takes the largest
// alpha within the shape around it: ImageMagick's `-morphology Dilate` with
// its Square, Diamond or Disk kernel, which hold the offsets with
// max(|x|,|y|), |x|+|y| or x²+y² at most N), in the outline colour. The
// shadow's is the alpha moved by an offset, in the shadow colour at an
// opacity. The sprite goes over either with Pillow's alpha_composite
// (libImaging/AlphaComposite.c, 13.0, its integer arithmetic to the bit), so
// soft edges blend as they do there. test/toolbox.test.mjs checks the
// dilation against ImageMagick and the compositing against Pillow.

export type Shape = "square" | "diamond" | "circle";

const PRECISION_BITS = 7;
const shiftForDiv255 = (a: number) => (((a >>> 8) + a) >>> 8);

// `src` over `dst`, same size (Pillow's ImagingAlphaComposite).
export function alphaComposite(dst: Image, src: Image): Image {
  const out = new Uint8Array(dst.rgba.length);
  const d = dst.rgba;
  const s = src.rgba;
  for (let i = 0; i < out.length; i += 4) {
    const sa = s[i + 3];
    if (sa === 0) {
      out[i] = d[i];
      out[i + 1] = d[i + 1];
      out[i + 2] = d[i + 2];
      out[i + 3] = d[i + 3];
      continue;
    }
    const blend = d[i + 3] * (255 - sa);
    const outa255 = sa * 255 + blend;
    const coef1 = Math.floor((sa * 255 * 255 * (1 << PRECISION_BITS)) / outa255);
    const coef2 = 255 * (1 << PRECISION_BITS) - coef1;
    for (let c = 0; c < 3; c++) out[i + c] = shiftForDiv255(s[i + c] * coef1 + d[i + c] * coef2 + (0x80 << PRECISION_BITS)) >>> PRECISION_BITS;
    out[i + 3] = shiftForDiv255(outa255 + 0x80);
  }
  return { width: dst.width, height: dst.height, rgba: out };
}

export function kernel(shape: Shape, n: number): [number, number][] {
  const out: [number, number][] = [];
  for (let y = -n; y <= n; y++) {
    for (let x = -n; x <= n; x++) {
      const inside = shape === "square" ? true : shape === "diamond" ? Math.abs(x) + Math.abs(y) <= n : x * x + y * y <= n * n;
      if (inside) out.push([x, y]);
    }
  }
  return out;
}

// Each pixel's alpha: the largest within the kernel around it (outside the
// image counts as 0).
export function dilateAlpha(img: Image, shape: Shape, n: number): Uint8Array {
  const { width: w, height: h, rgba } = img;
  const k = kernel(shape, n);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = 0;
      for (const [dx, dy] of k) {
        const sx = x + dx;
        const sy = y + dy;
        if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
        const a = rgba[(sy * w + sx) * 4 + 3];
        if (a > m && (m = a) === 255) break;
      }
      out[y * w + x] = m;
    }
  }
  return out;
}

function layer(w: number, h: number, alpha: Uint8Array, colour: [number, number, number, number]): Image {
  const rgba = new Uint8Array(w * h * 4);
  for (let p = 0; p < w * h; p++) {
    const a = Math.round((alpha[p] * colour[3]) / 255);
    if (a) rgba.set([colour[0], colour[1], colour[2], a], p * 4);
  }
  return { width: w, height: h, rgba };
}

export function outline(img: Image, colour: [number, number, number, number], n: number, shape: Shape): Image {
  return alphaComposite(layer(img.width, img.height, dilateAlpha(img, shape, n), colour), img);
}

export function dropShadow(img: Image, dx: number, dy: number, colour: [number, number, number, number]): Image {
  const { width: w, height: h, rgba } = img;
  const moved = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = y - dy;
    if (sy < 0 || sy >= h) continue;
    for (let x = 0; x < w; x++) {
      const sx = x - dx;
      if (sx >= 0 && sx < w) moved[y * w + x] = rgba[(sy * w + sx) * 4 + 3];
    }
  }
  return alphaComposite(layer(w, h, moved, colour), img);
}

// How close the content (alpha over 0) of any frame comes to each edge; the
// full size where a frame is empty.
export function margins(frames: Image[]): { top: number; right: number; bottom: number; left: number } {
  const m = { top: Infinity, right: Infinity, bottom: Infinity, left: Infinity };
  for (const f of frames) {
    for (let y = 0; y < f.height; y++) {
      for (let x = 0; x < f.width; x++) {
        if (!f.rgba[(y * f.width + x) * 4 + 3]) continue;
        m.top = Math.min(m.top, y);
        m.left = Math.min(m.left, x);
        m.bottom = Math.min(m.bottom, f.height - 1 - y);
        m.right = Math.min(m.right, f.width - 1 - x);
      }
    }
  }
  return m;
}
