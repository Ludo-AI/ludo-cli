import type { Image } from "../tty/png.js";
import { cleanMask, dilateEllipse, nccMatchAll, resizeNearestMask, roundEven, warpAffineNearest } from "./cv.js";
import { resizePillow } from "./resample.js";

// Where the next animation's first frame goes so it continues from the
// previous one's last frame: an offset and a scale for frame B against
// frame A. The web's Export Sequence asks the ML service for these
// (/utils/align-images); this is that service's get_alignment_factors
// (ai-server ludo_utils/image_alignment.py, master 66b4aead, Oct 15 2026),
// line for line, with Pillow's resizes from resample.ts and OpenCV's
// operations from cv.ts, so the CLI places animations where the web does:
//  - the smaller image is upscaled (Lanczos) and both are centred on one
//    canvas;
//  - content is alpha above 200;
//  - a coarse sweep at 256 px over scales 0.7 to 1.4 in steps of 0.1:
//    normalized cross-correlation (TM_CCOEFF_NORMED) of premultiplied grey
//    at every offset, times the ratio of the two content areas;
//  - from a coarse hit of at least 0.65, both images are cut down to what
//    they have in common there (plus 1% of their size), and a ternary search
//    at 512 px narrows the scale within one coarse step; scale 1 is always
//    tried too;
//  - the best score wins, ties going to scale 1 and then the smaller move;
//  - below 0.65, the bottom edges and horizontal centres of mass of the
//    content are lined up instead, with the scale from the content heights
//    (the route passes fallback_scale=True); a move over 20% of the canvas
//    or a size ratio over 3 gives no move at all.
// dx, dy: where B's top-left goes, in A's pixels. scale: B's size against
// its own.

export interface Alignment {
  dx: number;
  dy: number;
  scale: number;
  confidence: number; // the match score, 0 when the content was lined up instead
  method: "ncc" | "ground" | "none"; // none: no match and no ground, B is left where it is
}

const CONFIDENCE_THRESHOLD = 0.65;
const MIN_SCALE = 0.7;
const MAX_SCALE = 1.4;
const SCALE_STEP = 0.1;
const MAX_SCALE_STEPS = 7;
const SWEEP_RESOLUTION = 256;
const TERNARY_RESOLUTION = 512;
const TRIM_DILATION = 0.01;
const MIN_COMPONENT = 0.005;
const FALLBACK_MAX_OFFSET = 0.2;
const FALLBACK_MAX_SIZE_RATIO = 3;

/** get_alpha_mask: alpha above the threshold. */
function alphaMask(img: Image, threshold: number): Uint8Array {
  const m = new Uint8Array(img.width * img.height);
  for (let i = 0; i < m.length; i++) m[i] = img.rgba[i * 4 + 3] > threshold ? 1 : 0;
  return m;
}

/** _premultiplied_gray, in numpy's float32 arithmetic. */
export function premultipliedGray(img: Image): Float32Array {
  const f = Math.fround;
  const [cr, cg, cb] = [f(0.299), f(0.587), f(0.114)];
  const out = new Float32Array(img.width * img.height);
  const d = img.rgba;
  for (let i = 0; i < out.length; i++) {
    const a = f(d[i * 4 + 3] / 255);
    out[i] = f(f(f(cr * f(d[i * 4] * a)) + f(cg * f(d[i * 4 + 1] * a))) + f(cb * f(d[i * 4 + 2] * a)));
  }
  return out;
}

const sum = (m: Uint8Array) => m.reduce((s, v) => s + v, 0);

/** _normalize_sizes: the smaller image upscaled to the larger's max side, both centred on one canvas. */
function normalizeSizes(img1: Image, img2: Image) {
  const target = Math.max(img1.width, img1.height, img2.width, img2.height);
  const up = (img: Image) => {
    const m = Math.max(img.width, img.height);
    if (m >= target) return { img, scale: 1 };
    const s = target / m;
    return { img: resizePillow(img, Math.trunc(img.width * s), Math.trunc(img.height * s), "lanczos"), scale: s };
  };
  const a = up(img1);
  const b = up(img2);
  const tw = Math.max(a.img.width, b.img.width);
  const th = Math.max(a.img.height, b.img.height);
  const pad = (img: Image) => {
    const ox = Math.floor((tw - img.width) / 2);
    const oy = Math.floor((th - img.height) / 2);
    if (img.width === tw && img.height === th) return { img, ox: 0, oy: 0 };
    const rgba = new Uint8Array(tw * th * 4);
    for (let y = 0; y < img.height; y++) rgba.set(img.rgba.subarray(y * img.width * 4, (y + 1) * img.width * 4), ((y + oy) * tw + ox) * 4);
    return { img: { width: tw, height: th, rgba }, ox, oy };
  };
  const p1 = pad(a.img);
  const p2 = pad(b.img);
  return { img1: p1.img, img2: p2.img, up1: a.scale, up2: b.scale, ox1: p1.ox, oy1: p1.oy, ox2: p2.ox, oy2: p2.oy };
}

type Candidate = [dx: number, dy: number, scale: number, confidence: number];

// A's side of _align_ncc, the same on every call for one A, mask and
// resolution (the ternary search makes up to 15), so it is kept.
const downsamples = new WeakMap<Image, { mask: Uint8Array; resolution: number; value: { ds: number; img1ds: Image; gray1: Float32Array; srcArea: number } }>();
function downsampled(img1: Image, mask1: Uint8Array, resolution: number) {
  const kept = downsamples.get(img1);
  if (kept && kept.mask === mask1 && kept.resolution === resolution) return kept.value;
  const maxDim = Math.max(img1.width, img1.height);
  const ds = maxDim > resolution ? resolution / maxDim : 1;
  let img1ds = img1;
  let mask1ds = mask1;
  if (ds < 1) {
    img1ds = resizePillow(img1, Math.max(1, roundEven(img1.width * ds)), Math.max(1, roundEven(img1.height * ds)), "bilinear");
    mask1ds = resizeNearestMask(mask1, img1.width, img1.height, img1ds.width, img1ds.height);
  }
  const value = { ds, img1ds, gray1: premultipliedGray(img1ds), srcArea: sum(mask1ds) };
  downsamples.set(img1, { mask: mask1, resolution, value });
  return value;
}

/**
 * _align_ncc: for each scale, B resized by scale * downsample, matched over
 * A at a max side of `resolution`; the score is weighted by the ratio of the
 * two content areas.
 */
function alignNcc(img1: Image, img2: Image, mask1: Uint8Array, mask2: Uint8Array, scales: number[], resolution: number): Candidate[] {
  const { ds, img1ds, gray1, srcArea } = downsampled(img1, mask1, resolution);
  const tried = scales.map(scale => {
    const combined = scale * ds;
    let img2s = img2;
    let mask2s = mask2;
    if (!(combined === 1 && scale === 1)) {
      const w = Math.max(1, roundEven(img2.width * combined));
      const h = Math.max(1, roundEven(img2.height * combined));
      img2s = resizePillow(img2, w, h, "bilinear");
      mask2s = resizeNearestMask(mask2, img2.width, img2.height, w, h);
    }
    const tmplArea = sum(mask2s);
    const overlap = srcArea > 0 && tmplArea > 0 ? Math.min(tmplArea, srcArea) / Math.max(tmplArea, srcArea) : 0;
    return { scale, overlap, template: { gray: premultipliedGray(img2s), width: img2s.width, height: img2s.height } };
  });
  const matches = nccMatchAll(gray1, img1ds.width, img1ds.height, tried.map(t => t.template));
  const out: Candidate[] = [];
  tried.forEach(({ scale, overlap }, i) => {
    const res = matches[i];
    if (!res) return;
    const [dx, dy] = ds < 1 ? [roundEven(res.dx / ds), roundEven(res.dy / ds)] : [res.dx, res.dy];
    out.push([dx, dy, scale, res.confidence * overlap]);
  });
  return out;
}

/** _apply_keep: alpha zeroed where keep is 0. */
function applyKeep(img: Image, keep: Uint8Array): Image {
  const rgba = img.rgba.slice();
  for (let i = 0; i < keep.length; i++) if (!keep[i]) rgba[i * 4 + 3] = 0;
  return { width: img.width, height: img.height, rgba };
}

/**
 * _trim_to_overlap: both images cut down to the content they share with B
 * scaled by `scale` and moved to (dx, dy), widened by a dilation of 1% of
 * the size to absorb the coarse transform's error.
 */
function trimToOverlap(img1: Image, img2: Image, mask1: Uint8Array, mask2: Uint8Array, dx: number, dy: number, scale: number) {
  const [w1, h1, w2, h2] = [img1.width, img1.height, img2.width, img2.height];
  const m = [scale, 0, dx, 0, scale, dy];
  const mask2in1 = warpAffineNearest(mask2, w2, h2, m, w1, h1, false);
  const overlap = new Uint8Array(w1 * h1);
  let any = false;
  for (let i = 0; i < overlap.length; i++) {
    overlap[i] = mask1[i] && mask2in1[i] ? 1 : 0;
    if (overlap[i]) any = true;
  }
  if (!any) return { img1, img2, mask1, mask2 };
  const k = Math.max(1, roundEven(Math.max(h1, w1) * TRIM_DILATION));
  const keep1 = dilateEllipse(overlap, w1, h1, k);
  const keep2 = warpAffineNearest(keep1, w1, h1, m, w2, h2, true);
  return {
    img1: applyKeep(img1, keep1),
    img2: applyKeep(img2, keep2),
    mask1: mask1.map((v, i) => v * keep1[i]),
    mask2: mask2.map((v, i) => v * keep2[i]),
  };
}

/**
 * _align_ground with scale=True: specks removed, then the bottom rows and
 * the horizontal centres of mass lined up, B scaled by the ratio of the
 * content heights (kept only within 1/3 to 3). A move over 20% of the
 * canvas gives no move.
 */
function alignGroundMasks(mask1: Uint8Array, mask2: Uint8Array, w: number, h: number): { dx: number; dy: number; scale: number } {
  const c1 = cleanMask(mask1, w, h, MIN_COMPONENT);
  const c2 = cleanMask(mask2, w, h, MIN_COMPONENT);
  const measure = (m: Uint8Array) => {
    let [top, ground, sx, n] = [-1, -1, 0, 0];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!m[y * w + x]) continue;
        if (top < 0) top = y;
        ground = y;
        sx += x;
        n++;
      }
    }
    return { top, ground, cx: n ? sx / n : 0, n };
  };
  const a = measure(c1);
  const b = measure(c2);
  if (!a.n || !b.n) return { dx: 0, dy: 0, scale: 1 };
  let scale = 1;
  const [ha, hb] = [a.ground - a.top, b.ground - b.top];
  if (ha > 0 && hb > 0) {
    const s = ha / hb;
    if (s >= 1 / FALLBACK_MAX_SIZE_RATIO && s <= FALLBACK_MAX_SIZE_RATIO) scale = s;
  }
  const dy = roundEven(a.ground - b.ground * scale);
  const dx = roundEven(a.cx - b.cx * scale);
  if (Math.abs(dx) > w * FALLBACK_MAX_OFFSET || Math.abs(dy) > h * FALLBACK_MAX_OFFSET) return { dx: 0, dy: 0, scale: 1 };
  return { dx, dy, scale };
}

/** _run_alignment on two images of one size. */
function runAlignment(img1: Image, img2: Image): Alignment {
  const mask1 = alphaMask(img1, 200);
  const mask2 = alphaMask(img2, 200);
  if (!sum(mask1) || !sum(mask2)) return { dx: 0, dy: 0, scale: 1, confidence: 0, method: "none" };

  const scales: number[] = [];
  for (let s = MIN_SCALE; s <= MAX_SCALE + 0.001; s += SCALE_STEP) scales.push(Math.round(s * 1000) / 1000);
  if (!scales.includes(1)) scales.push(1);
  scales.sort((p, q) => p - q);

  // Phase 1: the coarse sweep.
  const coarse = alignNcc(img1, img2, mask1, mask2, scales, SWEEP_RESOLUTION);
  let candidates: Candidate[] = coarse;
  const best = coarse.reduce<Candidate | null>((b, c) => (!b || c[3] > b[3] ? c : b), null);
  if (best && best[3] >= CONFIDENCE_THRESHOLD) {
    // Phase 2: a ternary search over the scale on what the two share.
    const [dx0, dy0, scale0] = best;
    const t = trimToOverlap(img1, img2, mask1, mask2, dx0, dy0, scale0);
    let lo = Math.max(MIN_SCALE, scale0 - SCALE_STEP);
    let hi = Math.min(MAX_SCALE, scale0 + SCALE_STEP);
    candidates = [];
    for (let step = 0; step < MAX_SCALE_STEPS; step++) {
      if (hi - lo < 1e-5) break;
      const m1 = lo + (hi - lo) / 3;
      const m2 = hi - (hi - lo) / 3;
      const found = alignNcc(t.img1, t.img2, t.mask1, t.mask2, [m1, m2], TERNARY_RESOLUTION);
      candidates.push(...found);
      const score = (m: number) => found.filter(c => Math.abs(c[2] - m) < 1e-5).reduce((s, c) => Math.max(s, c[3]), -1);
      if (score(m1) >= score(m2)) hi = m2;
      else lo = m1;
    }
    if (!candidates.length) candidates = alignNcc(t.img1, t.img2, t.mask1, t.mask2, [scale0], TERNARY_RESOLUTION);
    candidates.push(...alignNcc(t.img1, t.img2, t.mask1, t.mask2, [1], TERNARY_RESOLUTION));
  }

  // Ties go to the identity, then to the smaller move.
  candidates = [...candidates].sort((p, q) => q[3] - p[3] || Math.abs(p[2] - 1) - Math.abs(q[2] - 1) || Math.abs(p[0]) + Math.abs(p[1]) - (Math.abs(q[0]) + Math.abs(q[1])));
  if (candidates.length && candidates[0][3] >= CONFIDENCE_THRESHOLD) {
    const [dx, dy, scale, confidence] = candidates[0];
    return { dx, dy, scale, confidence, method: "ncc" };
  }
  const g = alignGroundMasks(mask1, mask2, img1.width, img1.height);
  return { ...g, confidence: 0, method: g.dx === 0 && g.dy === 0 && g.scale === 1 ? "none" : "ground" };
}

// get_alignment_factors' last step: from the normalized canvas back to the
// two images as given.
function denormalize(n: ReturnType<typeof normalizeSizes>, r: Alignment): Alignment {
  const scale = (n.up2 / n.up1) * r.scale;
  const dx = roundEven((n.ox2 * r.scale + r.dx - n.ox1) / n.up1);
  const dy = roundEven((n.oy2 * r.scale + r.dy - n.oy1) / n.up1);
  return { ...r, dx, dy, scale };
}

/** get_alignment_factors(img1, img2, fallback_scale=True), as /utils/align-images calls it. */
export function alignSprites(a: Image, b: Image): Alignment {
  const n = normalizeSizes(a, b);
  return denormalize(n, runAlignment(n.img1, n.img2));
}

/** Only the fallback: the content's bottom edges and centres lined up (`--align ground`). */
export function groundAlignment(a: Image, b: Image): Alignment {
  const n = normalizeSizes(a, b);
  const g = alignGroundMasks(alphaMask(n.img1, 200), alphaMask(n.img2, 200), n.img1.width, n.img1.height);
  return denormalize(n, { ...g, confidence: Number.NaN, method: g.dx === 0 && g.dy === 0 && g.scale === 1 ? "none" : "ground" });
}
