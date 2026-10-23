// The Export Pack math of the Ludo web app, ported as-is from
// prometheus-web src/pages/SpriteGenerator/exportPackMath.js (commit
// 3a1f2e92, 2026-10-19), so `ludo toolbox sprite pack` sizes and places
// frames exactly as the web does. Its 71 tests run here unchanged
// (test/web-math/). Only TypeScript types were added; keep the behaviour
// identical to the web's, and fix bugs in both places.
//
// The functions take ImageData-shaped `{ data, width, height }`; pass a
// toolbox Image as `{ data: img.rgba, width, height }`.

export interface PixelData {
  data: ArrayLike<number>;
  width: number;
  height: number;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
}

export interface TrimBounds {
  width: number;
  height: number;
  cropX: number;
  cropY: number;
  cropWidth: number;
  cropHeight: number;
}

/** Convert percentage (0-100) to frame index for an animation. */
export const getFrameIndexFromPercentage = (percentage: number, totalFrames: number) => {
  if (totalFrames <= 1) return 0;
  return Math.round((percentage / 100) * (totalFrames - 1));
};

/** Get actual frame index, clamped to available frames. */
export const getActualFrameIndex = (requestedIndex: number, totalFrames: number) => {
  return Math.min(requestedIndex, totalFrames - 1);
};

/** Calculate ground offset (space below character) from character bounds. */
export const calculateGroundOffsetFromBounds = (charBounds: { maxY: number }, trimBounds: { cropY: number; height: number } | null | undefined) => {
  if (!trimBounds) return 0;
  const charBottomInTrim = charBounds.maxY - trimBounds.cropY;
  const spaceBelow = trimBounds.height - charBottomInTrim;
  return Math.round(spaceBelow);
};

/** Get the min/max range of per-sprite ground offsets. */
export const getGroundOffsetRange = (processedData: unknown[] | null | undefined, getOffsetFn: (i: number) => number) => {
  if (!processedData) return { min: 0, max: 0 };
  const allOffsets = processedData.map((_, i) => getOffsetFn(i));
  return {
    min: Math.min(0, ...allOffsets),
    max: Math.max(0, ...allOffsets)
  };
};

/** Scan ImageData alpha channel for the non-transparent bounding box. */
export const calculateCharacterBounds = (imageData: PixelData): Bounds => {
  const { data, width, height } = imageData;
  let minX = width,
    minY = height,
    maxX = 0,
    maxY = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = data[(y * width + x) * 4 + 3];
      if (alpha > 10) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }

  // If no character found, return full bounds (pixels are 0-indexed).
  if (minX > maxX) {
    return {
      minX: 0,
      minY: 0,
      maxX: width - 1,
      maxY: height - 1,
      width,
      height
    };
  }

  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX + 1,
    height: maxY - minY + 1
  };
};

/**
 * Representative character height for a single animation (frame 0).
 * calculateBoundsFn is injected for testability; defaults to the pure scan above.
 */
export const calculateAnimationCharacterHeight = (animData: { frames?: PixelData[] }, calculateBoundsFn: (f: PixelData) => { height: number } = calculateCharacterBounds) => {
  if (!animData.frames || animData.frames.length === 0) {
    return 256;
  }
  const frame0 = animData.frames[0];
  const bounds = calculateBoundsFn(frame0);
  return bounds.height || 256;
};

/**
 * Target character height = smallest representative height across all animations
 * (scale down rather than up, preserving quality).
 * calcHeightFn is injected for testability.
 */
export const calculateTargetHeight = <T>(allAnimationData: T[], calcHeightFn: (a: T) => number = calculateAnimationCharacterHeight as unknown as (a: T) => number) => {
  let minHeight = Infinity;
  allAnimationData.forEach(animData => {
    const animHeight = calcHeightFn(animData);
    minHeight = Math.min(minHeight, animHeight);
  });
  return minHeight !== Infinity ? minHeight : 256;
};

/** Baseline scale for one animation to match the pack baseline. */
export const baseScale = (targetHeight: number, animCharHeight: number) => targetHeight / animCharHeight;

/** Combine baseline scale with the user's per-sprite size multiplier. */
export const finalScale = (baseScaleValue: number, sizeMultiplier: number) => baseScaleValue * sizeMultiplier;

/** Persist size as an absolute rendered height (baseline-independent). */
export const persistAlignmentData = (targetHeight: number, sizeMultiplier: number, groundOffset: number, horizontalOffset: number) => ({
  sizeHeightPx: targetHeight * sizeMultiplier,
  groundOffset,
  horizontalOffset
});

/** Restore a baseline-relative multiplier from a saved absolute height. */
export const hydrateAlignmentMultiplier = (sizeHeightPx: number, currentTargetHeight: number) => (currentTargetHeight > 0 ? sizeHeightPx / currentTargetHeight : 0);

/**
 * Normalized frame dimension math, extracted from the export loop.
 * scaledDim is the scaled width or height of a frame; offsetExtent is the
 * additional pixels needed for offsets (vertical: maxGroundOffset - minGroundOffset;
 * horizontal: maxAbsHorizontalOffset * 2).
 */
export const normalizedFrameExtent = (scaledDim: number, offsetExtent: number) => scaledDim + offsetExtent;

/** Final canvas dimension: ceil with a 1px floor to avoid canvas errors. */
export const normalizedFrameSize = (maxNormalizedDim: number, padding = 0) => Math.max(1, Math.ceil(maxNormalizedDim + padding * 2));

export interface PackSprite {
  animCharHeight: number;
  frameBounds?: { width: number; height: number }[];
  sizeMultiplier?: number; // default 1
  groundOffset?: number; // source px, default 0
  horizontalOffset?: number; // source px, default 0
}

export interface TargetFrameSize {
  w?: number | string;
  h?: number | string;
}

/**
 * Full animation-pack normalization, composed from the primitives above — the
 * exact algorithm ExportAnimationPackModal runs to size a pack. Extracted here
 * (rather than inline) so the tests guard the real behavior end to end.
 *
 * Given each sprite's representative character height, its per-frame content
 * bounds (pre-scale), and the user's per-sprite adjustments, it returns:
 *  - targetHeight: the shared baseline (height of the shortest sprite),
 *  - scales: the final scale applied to each sprite,
 *  - frameSize: the single normalized frame size every exported sheet uses.
 *
 * Ground offsets are scaled per sprite then taken as a global extent; the
 * horizontal extent is the max absolute scaled horizontal offset (both sides). This
 * mirrors the inline export math (the offset extents are constant across all
 * frames, so they are computed once here). An optional targetFrameSize
 * ({ w, h }) grows the frame to a user-chosen size (see applyTargetFrameSize).
 */
export const computePackNormalization = (sprites: PackSprite[] = [], targetFrameSize?: TargetFrameSize | null) => {
  const targetHeight = calculateTargetHeight(sprites, s => s.animCharHeight);

  const scales = sprites.map(s => finalScale(baseScale(targetHeight, s.animCharHeight), s.sizeMultiplier ?? 1));

  // Offset extents are global across the pack (identical for every frame).
  const scaledGroundOffsets = sprites.map((s, i) => (s.groundOffset || 0) * scales[i]);
  const groundExtent = Math.max(0, ...scaledGroundOffsets) - Math.min(0, ...scaledGroundOffsets);
  // computeFramePlacement shifts the sprite by horizontalOffset * scale, so the
  // room reserved on each side must be scaled the same way, or a sprite scaled
  // above 1 is drawn past the frame edge and clipped.
  const horizontalExtent = (sprites.length ? Math.max(...sprites.map((s, i) => Math.abs((s.horizontalOffset || 0) * scales[i]))) : 0) * 2;

  let maxWidth = 0;
  let maxHeight = 0;
  sprites.forEach((s, i) => {
    (s.frameBounds || []).forEach(b => {
      maxWidth = Math.max(maxWidth, normalizedFrameExtent(b.width * scales[i], horizontalExtent));
      maxHeight = Math.max(maxHeight, normalizedFrameExtent(b.height * scales[i], groundExtent));
    });
  });

  return {
    targetHeight,
    scales,
    frameSize: applyTargetFrameSize(
      {
        width: normalizedFrameSize(maxWidth),
        height: normalizedFrameSize(maxHeight)
      },
      targetFrameSize
    )
  };
};

// Largest user-set frame edge, so a typo can't allocate a giant canvas per
// frame. Matches the sequence exporter's cap.
export const MAX_TARGET_FRAME_PX = 4096;

/**
 * Grow the auto-normalized frame to a user-chosen size ({ w, h }, blank = auto).
 * Each axis takes the larger of the two, so content is never cropped. Frames
 * stay ground-aligned and centered (computeFramePlacement measures from the
 * bottom and the center), so the extra space lands above and on both sides.
 */
export const applyTargetFrameSize = (frameSize: { width: number; height: number }, target?: TargetFrameSize | null) => {
  const t = (v: unknown) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_TARGET_FRAME_PX) : 0;
  };
  return {
    width: Math.max(frameSize.width, t(target?.w)),
    height: Math.max(frameSize.height, t(target?.h))
  };
};

/**
 * Where to draw one sprite frame inside its canvas cell, so every sprite's feet
 * sit on a shared ground line and the character is horizontally centered (with
 * the user's offsets applied). Extracted verbatim from the export render loops
 * (single-frame mode uses origin 0,0; spritesheet-grid mode uses the cell's
 * top-left frameOrigin).
 *
 * groundOffset is already SCALED (per-sprite source offset * scale); the
 * horizontal offset is raw and scaled here, mirroring the original code.
 * Returns integer charX/charY (rounded) plus the ground line and center used.
 */
export const computeFramePlacement = ({
  frameOriginX = 0,
  frameOriginY = 0,
  frameWidth,
  frameHeight,
  padding = 0,
  maxGroundOffset,
  groundOffset,
  scaledWidth,
  scaledHeight,
  horizontalOffset = 0,
  scale = 1
}: {
  frameOriginX?: number;
  frameOriginY?: number;
  frameWidth: number;
  frameHeight: number;
  padding?: number;
  maxGroundOffset: number;
  groundOffset: number;
  scaledWidth: number;
  scaledHeight: number;
  horizontalOffset?: number;
  scale?: number;
}) => {
  const groundLineY = frameOriginY + frameHeight - padding - maxGroundOffset;
  const centerX = frameOriginX + frameWidth / 2;
  const spriteBottomY = groundLineY + groundOffset;
  const charY = Math.round(spriteBottomY - scaledHeight);
  const charX = Math.round(centerX - scaledWidth / 2 + horizontalOffset * scale);
  return { groundLineY, centerX, charX, charY };
};

/**
 * De-duplicate a list of names, preserving order: each name is sanitized to a
 * \W-free slug, and repeats get -1, -2, … suffixes.
 */
export const uniquifyNames = (names: string[]) => {
  const counts: Record<string, number> = {};
  return names.map(name => {
    const sanitized = name.replace(/\W+/g, "-");
    if (counts[sanitized] === undefined) {
      counts[sanitized] = 0;
      return sanitized;
    }
    counts[sanitized] += 1;
    return `${sanitized}-${counts[sanitized]}`;
  });
};

// ---- From ExportAnimationPackModal.jsx (calculateAnimationTrimBounds), the
// one piece of pack math still inline there. ----

/**
 * The union of every frame's character bounds: one crop box for the whole
 * animation, so frames do not shift against each other.
 */
export const calculateAnimationTrimBounds = (animData: { frames: PixelData[] }): TrimBounds => {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  animData.frames.forEach(frame => {
    const bounds = calculateCharacterBounds(frame);
    minX = Math.min(minX, bounds.minX);
    minY = Math.min(minY, bounds.minY);
    maxX = Math.max(maxX, bounds.maxX);
    maxY = Math.max(maxY, bounds.maxY);
  });
  const unionWidth = maxX - minX + 1;
  const unionHeight = maxY - minY + 1;
  return {
    width: unionWidth,
    height: unionHeight,
    cropX: minX,
    cropY: minY,
    cropWidth: unionWidth,
    cropHeight: unionHeight
  };
};
