// The Export Sequence math of the Ludo web app, ported as-is from
// prometheus-web src/pages/SpriteGenerator/exportSequenceMath.js (commit
// 91985ab3, 2026-10-23), so `ludo toolbox sprite sequence` chains, crops and
// lays out frames exactly as the web does. Its 36 tests run here unchanged
// (test/web-math/). Only TypeScript types were added; keep the behaviour
// identical to the web's, and fix bugs in both places.

export interface Slot {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Placement {
  size?: number | string | null;
  vertical?: number | string | null;
  horizontal?: number | string | null;
}

/** Sanitize a name into a lowercase hyphenated slug, with a fallback. */
export const sanitizeName = (str: string | null | undefined, fallback = "") =>
  (str || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || fallback;

/**
 * Rectangular grid for `count` frames: a square-ish layout that always fits.
 * cols = ceil(sqrt(count)); rows = ceil(count / cols).
 */
export const sequenceGrid = (count: number) => {
  const cols = Math.ceil(Math.sqrt(count));
  const rows = cols ? Math.ceil(count / cols) : 0;
  return { cols, rows };
};

/** Row/col of frame `index` in a grid with `cols` columns (row-major). */
export const gridCell = (index: number, cols: number) => ({
  col: index % cols,
  row: Math.floor(index / cols)
});

/** Pixel size of a sheet holding cols×rows cells of uniformW×uniformH. */
export const sheetSize = (cols: number, rows: number, uniformW: number, uniformH: number) => ({
  width: cols * uniformW,
  height: rows * uniformH
});

/**
 * Next slot in the alignment chain. Given the previous sprite's slot and the
 * server-returned offset {dx, dy, scale} plus the next sprite's raw frame size,
 * place the next sprite in the shared coordinate space.
 */
export const nextSequenceSlot = (prev: Slot, { dx = 0, dy = 0, scale = 1 }: { dx?: number; dy?: number; scale?: number }, rawW: number, rawH: number): Slot => ({
  x: prev.x + dx,
  y: prev.y + dy,
  w: Math.round(rawW * scale),
  h: Math.round(rawH * scale)
});

/**
 * Global bounding box over all chained slots → the canvas size that contains
 * them all, plus the shift that moves the box origin to (0, 0).
 */
export const sequenceCanvasBounds = (slots: Slot[]) => {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const s of slots) {
    minX = Math.min(minX, s.x);
    minY = Math.min(minY, s.y);
    maxX = Math.max(maxX, s.x + s.w);
    maxY = Math.max(maxY, s.y + s.h);
  }
  return {
    minX,
    minY,
    maxX,
    maxY,
    canvasW: Math.ceil(maxX - minX),
    canvasH: Math.ceil(maxY - minY),
    // -minX, normalized so a zero origin reads 0 instead of -0 (identical for
    // the downstream drawImage shift).
    shiftX: minX ? -minX : 0,
    shiftY: minY ? -minY : 0
  };
};

// Largest frame edge the layout will produce, so a typo'd Size or frame size
// can't allocate a giant canvas for every frame.
export const MAX_SEQUENCE_FRAME_PX = 4096;
// 1, not higher: Size shows the real rendered height, so a higher floor would
// snap the first typed digit ("2" on the way to "250") up to it.
export const MIN_SEQUENCE_SIZE_PX = 1;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const num = (v: unknown) => {
  if (v === "" || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Place the tightly-cropped content (the union of every frame's bounds) in the
 * output frame, using the same absolute-pixel controls as the animation-pack
 * exporter, so values can be copied between sequences and packs:
 *  - size: rendered height of the content in px (null = native).
 *  - vertical: px from the bottom edge (the ground line) up to the content's
 *    lowest point (null = centered).
 *  - horizontal: px from the frame center to the content center, positive to
 *    the right (null = 0).
 *
 * Each axis of the frame is the user's target size, grown to fit the content
 * when the content is bigger, so the content is never cropped. Size can shrink
 * freely but only grows until the content fills a set frame size. Offsets are
 * clamped to the leftover space, so every frame stays inside the boundaries.
 */
export const paddedFrameLayout = (contentW: number, contentH: number, targetW: unknown, targetH: unknown, { size, vertical, horizontal }: Placement = {}) => {
  const tW = clamp(Math.round(num(targetW) || 0), 0, MAX_SEQUENCE_FRAME_PX);
  const tH = clamp(Math.round(num(targetH) || 0), 0, MAX_SEQUENCE_FRAME_PX);

  // Largest scale: fill the set frame axes, but never cap below native (a frame
  // smaller than the content just grows). With no frame size, only the canvas
  // guard applies.
  const fitScales: number[] = [];
  if (tW) fitScales.push(tW / contentW);
  if (tH) fitScales.push(tH / contentH);
  const guardScale = MAX_SEQUENCE_FRAME_PX / Math.max(contentW, contentH, 1);
  const maxScale = Math.min(guardScale, fitScales.length ? Math.max(1, Math.min(...fitScales)) : guardScale);
  const minScale = Math.min(1, MIN_SEQUENCE_SIZE_PX / contentH);

  const sizePx = num(size);
  const scale = clamp(sizePx ? sizePx / contentH : 1, minScale, maxScale);

  // Rounding at the fit limit can overshoot the target by a pixel.
  const fits = (t: number, c: number) => t && scale <= t / c + 1e-9;
  let drawW = Math.max(1, Math.round(contentW * scale));
  let drawH = Math.max(1, Math.round(contentH * scale));
  if (fits(tW, contentW)) drawW = Math.min(drawW, tW);
  if (fits(tH, contentH)) drawH = Math.min(drawH, tH);

  const frameW = Math.max(tW, drawW);
  const frameH = Math.max(tH, drawH);
  const slackX = frameW - drawW;
  const slackY = frameH - drawH;

  const vPx = num(vertical);
  const v = clamp(vPx == null ? Math.ceil(slackY / 2) : Math.round(vPx), 0, slackY);
  const hMin = -Math.floor(slackX / 2);
  const hMax = slackX + hMin;
  const h = clamp(Math.round(num(horizontal) || 0), hMin, hMax);

  return {
    frameW,
    frameH,
    scale,
    drawW,
    drawH,
    slackX,
    slackY,
    sizeMin: Math.max(1, Math.round(contentH * minScale)),
    sizeMax: Math.round(contentH * maxScale),
    vertical: v,
    horizontal: h,
    hMin,
    hMax,
    offsetX: -hMin + h,
    offsetY: slackY - v
  };
};

/**
 * Union of per-frame content bounds → the tight crop rectangle. Seeded with the
 * canvas size so an empty list yields the full canvas (matching the original).
 * Each input bound is { minX, minY, maxX, maxY }.
 */
export const cropBounds = (boundsList: { minX: number; minY: number; maxX: number; maxY: number }[], canvasW: number, canvasH: number) => {
  let cMinX = canvasW,
    cMinY = canvasH,
    cMaxX = 0,
    cMaxY = 0;
  for (const b of boundsList) {
    cMinX = Math.min(cMinX, b.minX);
    cMinY = Math.min(cMinY, b.minY);
    cMaxX = Math.max(cMaxX, b.maxX);
    cMaxY = Math.max(cMaxY, b.maxY);
  }
  return {
    minX: cMinX,
    minY: cMinY,
    maxX: cMaxX,
    maxY: cMaxY,
    cropW: cMaxX - cMinX + 1,
    cropH: cMaxY - cMinY + 1
  };
};
