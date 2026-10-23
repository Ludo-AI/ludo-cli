import type { Image } from "../tty/png.js";
import { resizeSmooth } from "./resample.js";

// Where the next animation's first frame goes so it continues from the
// previous one's last frame: an offset and a scale for frame B against
// frame A. A rewrite on RGBA buffers of the web app's alignSprites.js
// (prometheus-web src/pages/SpriteGenerator, canvas code it never calls; the
// web asks the ML service's alignImages instead). Its algorithm, unchanged:
//  - a scale estimate from the content heights, and 7 candidates around it
//    (x0.85 to x1.15);
//  - both frames downsampled so A is at most 128 px, as premultiplied
//    luminance;
//  - for each scale, normalized cross-correlation (NCC) over the overlap, at
//    offsets within 30% of the size of the centred position: every 4th
//    offset, then every offset within 5 of the best;
//  - the best hit refined at full resolution, +-2 px;
//  - below a confidence of 0.4, the bottom edges and the horizontal centres
//    of mass are lined up instead ("ground").
// Two changes: resizing is resample.ts's (Pillow's) rather than a browser
// canvas's, and the ground fallback measures B at the scale it returns
// (alignSprites measured B unscaled, which misplaces it when the scale is not
// 1). The result also keeps the NCC score measured, where alignSprites
// returned 0 for the fallback.
//
// dx, dy: where B's top-left goes, in A's pixels. scale: B's size against
// its own.

export interface Alignment {
  dx: number;
  dy: number;
  scale: number;
  confidence: number; // the best NCC score, -1 to 1 (NaN when not matched)
  method: "ncc" | "ground";
}

export interface AlignOptions {
  confidenceThreshold?: number;
  matchResolution?: number;
  searchRadiusFraction?: number;
}

const ALPHA = 10; // content is alpha above this, as everywhere in the toolbox

/** Premultiplied-alpha luminance (Rec. 601 weights). */
function gray(img: Image): Float32Array {
  const out = new Float32Array(img.width * img.height);
  const d = img.rgba;
  for (let i = 0; i < out.length; i++) {
    const o = i * 4;
    out[i] = (0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2]) * (d[o + 3] / 255);
  }
  return out;
}

/** The box around the content; the whole image when there is none. */
function contentBounds(img: Image) {
  const { width: w, height: h, rgba } = img;
  let [x0, y0, x1, y1] = [w, h, 0, 0];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (rgba[(y * w + x) * 4 + 3] > ALPHA) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x0 > x1) return { x0: 0, y0: 0, x1: w - 1, y1: h - 1, w, h };
  return { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/**
 * NCC between g1 and g2 placed at (dx, dy) in g1, over their overlap. -1 when
 * the overlap is under 4 px a side or under 20% of the smaller image.
 */
export function nccAtOffset(g1: Float32Array, w1: number, h1: number, g2: Float32Array, w2: number, h2: number, dx: number, dy: number): number {
  const ox0 = Math.max(0, dx);
  const oy0 = Math.max(0, dy);
  const ow = Math.min(w1, dx + w2) - ox0;
  const oh = Math.min(h1, dy + h2) - oy0;
  if (ow < 4 || oh < 4) return -1;
  if (ow * oh < Math.min(w1 * h1, w2 * h2) * 0.2) return -1;

  const n = ow * oh;
  let s1 = 0;
  let s2 = 0;
  for (let y = 0; y < oh; y++) {
    const r1 = (oy0 + y) * w1 + ox0;
    const r2 = (oy0 - dy + y) * w2 + (ox0 - dx);
    for (let x = 0; x < ow; x++) {
      s1 += g1[r1 + x];
      s2 += g2[r2 + x];
    }
  }
  const m1 = s1 / n;
  const m2 = s2 / n;
  let num = 0;
  let d1 = 0;
  let d2 = 0;
  for (let y = 0; y < oh; y++) {
    const r1 = (oy0 + y) * w1 + ox0;
    const r2 = (oy0 - dy + y) * w2 + (ox0 - dx);
    for (let x = 0; x < ow; x++) {
      const a = g1[r1 + x] - m1;
      const b = g2[r2 + x] - m2;
      num += a * b;
      d1 += a * a;
      d2 += b * b;
    }
  }
  const denom = Math.sqrt(d1 * d2);
  return denom > 1e-10 ? num / denom : 0;
}

/** Coarse (stride 4) then fine search around the centred position. */
function boundedNccSearch(g1: Float32Array, w1: number, h1: number, g2: Float32Array, w2: number, h2: number, radius: number) {
  const cx = Math.round((w1 - w2) / 2);
  const cy = Math.round((h1 - h2) / 2);
  const stride = 4;
  let [bestDx, bestDy, bestConf] = [cx, cy, -1];
  for (let dy = cy - radius; dy <= cy + radius; dy += stride) {
    for (let dx = cx - radius; dx <= cx + radius; dx += stride) {
      const c = nccAtOffset(g1, w1, h1, g2, w2, h2, dx, dy);
      if (c > bestConf) [bestConf, bestDx, bestDy] = [c, dx, dy];
    }
  }
  const fine = stride + 1;
  const [fDx, fDy] = [bestDx, bestDy];
  for (let dy = fDy - fine; dy <= fDy + fine; dy++) {
    for (let dx = fDx - fine; dx <= fDx + fine; dx++) {
      const c = nccAtOffset(g1, w1, h1, g2, w2, h2, dx, dy);
      if (c > bestConf) [bestConf, bestDx, bestDy] = [c, dx, dy];
    }
  }
  return { dx: bestDx, dy: bestDy, confidence: bestConf };
}

/**
 * Line up the bottom edges of the content and the horizontal centres of mass,
 * with B at `scale`.
 */
export function alignGround(a: Image, b: Image, scale = 1): { dx: number; dy: number } {
  const measure = (img: Image) => {
    let bottom = -1;
    let sum = 0;
    let count = 0;
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        if (img.rgba[(y * img.width + x) * 4 + 3] > ALPHA) {
          bottom = y;
          sum += x;
          count++;
        }
      }
    }
    // Pixel centres: column x is at x + 0.5; the bottom edge is row + 1.
    return { bottom: bottom + 1, cx: count ? sum / count + 0.5 : img.width / 2 };
  };
  const ma = measure(a);
  const mb = measure(b);
  return { dx: Math.round(ma.cx - mb.cx * scale) || 0, dy: Math.round(ma.bottom - mb.bottom * scale) || 0 };
}

// The scale estimate: the ratio of the content heights.
const heightRatio = (a: Image, b: Image) => contentBounds(a).h / Math.max(1, contentBounds(b).h);

/** The fallback on its own: B at the content-height ratio, on A's ground. */
export function groundAlignment(a: Image, b: Image, confidence = Number.NaN): Alignment {
  const scale = heightRatio(a, b);
  return { ...alignGround(a, b, scale), scale, confidence, method: "ground" };
}

export function alignSprites(a: Image, b: Image, options: AlignOptions = {}): Alignment {
  const { confidenceThreshold = 0.4, matchResolution = 128, searchRadiusFraction = 0.3 } = options;

  const baseScale = heightRatio(a, b);
  const scales = [0.85, 0.925, 0.975, 1, 1.025, 1.075, 1.15].map(f => baseScale * f);

  const maxDim = Math.max(a.width, a.height);
  const ds = maxDim > matchResolution ? matchResolution / maxDim : 1;
  const dsW1 = Math.max(1, Math.round(a.width * ds));
  const dsH1 = Math.max(1, Math.round(a.height * ds));
  const g1ds = gray(ds < 1 ? resizeSmooth(a, dsW1, dsH1) : a);
  const radius = Math.round(Math.max(dsW1, dsH1) * searchRadiusFraction);

  let best: Alignment = { dx: 0, dy: 0, scale: baseScale, confidence: -1, method: "ncc" };
  for (const scale of scales) {
    const w = Math.max(1, Math.round(b.width * scale * ds));
    const h = Math.max(1, Math.round(b.height * scale * ds));
    if (w < 4 || h < 4) continue;
    const g2 = gray(resizeSmooth(b, w, h));
    const r = boundedNccSearch(g1ds, dsW1, dsH1, g2, w, h, radius);
    if (r.confidence > best.confidence) {
      best = { dx: ds < 1 ? Math.round(r.dx / ds) : r.dx, dy: ds < 1 ? Math.round(r.dy / ds) : r.dy, scale, confidence: r.confidence, method: "ncc" };
    }
  }

  // A good hit found on the downsample: refine it at full resolution.
  if (best.confidence >= confidenceThreshold && ds < 1) {
    const w = Math.max(1, Math.round(b.width * best.scale));
    const h = Math.max(1, Math.round(b.height * best.scale));
    const g1 = gray(a);
    const g2 = gray(w === b.width && h === b.height ? b : resizeSmooth(b, w, h));
    let [vBest, vDx, vDy] = [-1, best.dx, best.dy];
    for (let dy = best.dy - 2; dy <= best.dy + 2; dy++) {
      for (let dx = best.dx - 2; dx <= best.dx + 2; dx++) {
        const c = nccAtOffset(g1, a.width, a.height, g2, w, h, dx, dy);
        if (c > vBest) [vBest, vDx, vDy] = [c, dx, dy];
      }
    }
    best = { ...best, dx: vDx, dy: vDy, confidence: vBest };
  }

  if (best.confidence < confidenceThreshold) return groundAlignment(a, b, best.confidence);
  return best;
}
