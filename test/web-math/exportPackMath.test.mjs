// Ported unchanged from prometheus-web src/pages/SpriteGenerator/exportPackMath.test.js
// (commit 91985ab3); only the imports differ. Keep it in step with the web's.
import { describe, it, expect } from './vitest.mjs';
import {
  getFrameIndexFromPercentage,
  getActualFrameIndex,
  calculateGroundOffsetFromBounds,
  getGroundOffsetRange,
  calculateCharacterBounds,
  calculateAnimationCharacterHeight,
  calculateTargetHeight,
  baseScale,
  finalScale,
  persistAlignmentData,
  hydrateAlignmentMultiplier,
  normalizedFrameExtent,
  normalizedFrameSize,
  computePackNormalization,
  computeFramePlacement,
  uniquifyNames,
  applyTargetFrameSize,
  MAX_TARGET_FRAME_PX,
} from '../../dist/toolbox/packMath.js';

// Rendered character height of sprite i = its measured height * its final scale.
const renderedHeight = (result, i, animCharHeight) =>
  animCharHeight * result.scales[i];

// Build an ImageData-shaped fixture. `rects` = opaque rectangles [x0,y0,x1,y1] inclusive.
function makeImageData(width, height, rects = []) {
  const data = new Uint8ClampedArray(width * height * 4); // all alpha=0
  for (const [x0, y0, x1, y1, alpha = 255] of rects) {
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        data[(y * width + x) * 4 + 3] = alpha;
      }
    }
  }
  return { data, width, height };
}

describe('getFrameIndexFromPercentage', () => {
  it('maps 0% to frame 0', () => {
    expect(getFrameIndexFromPercentage(0, 36)).toBe(0);
  });
  it('maps 100% to last frame', () => {
    expect(getFrameIndexFromPercentage(100, 36)).toBe(35);
  });
  it('maps 50% with Math.round', () => {
    expect(getFrameIndexFromPercentage(50, 36)).toBe(18);
  });
  it('returns 0 when totalFrames <= 1', () => {
    expect(getFrameIndexFromPercentage(50, 1)).toBe(0);
    expect(getFrameIndexFromPercentage(75, 0)).toBe(0);
  });
  it('rounds 25% over 4 frames to 1', () => {
    expect(getFrameIndexFromPercentage(25, 4)).toBe(1);
  });
  it('rounds boundary 99.5% over 100 frames to 99', () => {
    // (99.5/100)*99 = 98.505 => 99
    expect(getFrameIndexFromPercentage(99.5, 100)).toBe(99);
  });
});

describe('getActualFrameIndex', () => {
  it('passes through in-range index', () => {
    expect(getActualFrameIndex(0, 36)).toBe(0);
    expect(getActualFrameIndex(35, 36)).toBe(35);
    expect(getActualFrameIndex(18, 20)).toBe(18);
  });
  it('clamps over-index to last frame', () => {
    expect(getActualFrameIndex(40, 36)).toBe(35);
  });
  it('clamps to 0 for single-frame animation', () => {
    expect(getActualFrameIndex(50, 1)).toBe(0);
  });
});

describe('calculateGroundOffsetFromBounds', () => {
  it('returns 0 for null trimBounds', () => {
    expect(calculateGroundOffsetFromBounds({ maxY: 100 }, null)).toBe(0);
  });
  it('computes positive space below character', () => {
    // last row 99 -> bottom edge 100; charBottomInTrim = 100 - 20 = 80;
    // spaceBelow = 150 - 80 = 70
    expect(
      calculateGroundOffsetFromBounds({ maxY: 99 }, { cropY: 20, height: 150 })
    ).toBe(70);
  });
  it('returns 0 when character bottom equals trim bottom', () => {
    // maxY is the last row: a 200-row box from row 0 ends on row 199
    expect(
      calculateGroundOffsetFromBounds({ maxY: 199 }, { cropY: 0, height: 200 })
    ).toBe(0);
    expect(
      calculateGroundOffsetFromBounds({ maxY: 169 }, { cropY: 20, height: 150 })
    ).toBe(0);
  });
  it('counts the last row as part of the character', () => {
    // feet on row 148 of a 150-row box leave one empty row below
    expect(
      calculateGroundOffsetFromBounds({ maxY: 148 }, { cropY: 0, height: 150 })
    ).toBe(1);
  });
  it('returns negative when character sits below trim bottom', () => {
    // charBottomInTrim = 160 - 0 = 160; spaceBelow = 150 - 160 = -10
    expect(
      calculateGroundOffsetFromBounds({ maxY: 159 }, { cropY: 0, height: 150 })
    ).toBe(-10);
  });
  it('rounds the result', () => {
    expect(
      calculateGroundOffsetFromBounds({ maxY: 99 }, { cropY: 0, height: 150.6 })
    ).toBe(51);
  });
});

describe('getGroundOffsetRange', () => {
  it('returns {0,0} for null data', () => {
    expect(getGroundOffsetRange(null, () => 5)).toEqual({ min: 0, max: 0 });
  });
  it('clamps min at 0 when all offsets positive', () => {
    const data = [0, 0, 0];
    expect(getGroundOffsetRange(data, (i) => [0, 10, 5][i])).toEqual({
      min: 0,
      max: 10,
    });
  });
  it('captures negative min and positive max', () => {
    const data = [0, 0, 0];
    expect(getGroundOffsetRange(data, (i) => [-5, 0, 10][i])).toEqual({
      min: -5,
      max: 10,
    });
  });
  it('returns {0,0} when all offsets are zero', () => {
    expect(getGroundOffsetRange([0, 0, 0], () => 0)).toEqual({
      min: 0,
      max: 0,
    });
  });
  it('clamps min at 0 for uniform positive offsets', () => {
    expect(getGroundOffsetRange([0, 0, 0], () => 3)).toEqual({
      min: 0,
      max: 3,
    });
  });
});

describe('calculateCharacterBounds', () => {
  it('finds the bounding box of an opaque rect', () => {
    const img = makeImageData(256, 256, [[10, 20, 100, 150]]);
    expect(calculateCharacterBounds(img)).toEqual({
      minX: 10,
      minY: 20,
      maxX: 100,
      maxY: 150,
      width: 91,
      height: 131,
    });
  });
  it('returns full bounds when fully transparent', () => {
    const img = makeImageData(256, 256, []);
    expect(calculateCharacterBounds(img)).toEqual({
      minX: 0,
      minY: 0,
      maxX: 255,
      maxY: 255,
      width: 256,
      height: 256,
    });
  });
  it('handles a single opaque pixel', () => {
    const img = makeImageData(64, 64, [[50, 60, 50, 60]]);
    expect(calculateCharacterBounds(img)).toMatchObject({
      minX: 50,
      minY: 60,
      maxX: 50,
      maxY: 60,
      width: 1,
      height: 1,
    });
  });
  it('treats alpha <= 10 as transparent (full bounds)', () => {
    const img = makeImageData(8, 8, [[2, 2, 4, 4, 10]]); // alpha exactly 10 => invisible
    expect(calculateCharacterBounds(img)).toMatchObject({
      width: 8,
      height: 8,
    });
  });
  it('treats alpha = 11 as visible (threshold)', () => {
    const img = makeImageData(8, 8, [[2, 2, 4, 4, 11]]);
    expect(calculateCharacterBounds(img)).toMatchObject({
      minX: 2,
      minY: 2,
      maxX: 4,
      maxY: 4,
    });
  });
});

describe('calculateAnimationCharacterHeight', () => {
  it('returns 256 fallback for empty frames', () => {
    expect(calculateAnimationCharacterHeight({ frames: [] })).toBe(256);
    expect(calculateAnimationCharacterHeight({})).toBe(256);
  });
  it('uses injected bounds fn on frame 0', () => {
    const animData = { frames: ['F0', 'F1'] };
    const stub = (f) => ({ height: f === 'F0' ? 100 : 999 });
    expect(calculateAnimationCharacterHeight(animData, stub)).toBe(100);
  });
  it('measures a real fixture frame 0', () => {
    const frame0 = makeImageData(256, 256, [[0, 0, 0, 99]]); // height 100
    expect(calculateAnimationCharacterHeight({ frames: [frame0] })).toBe(100);
  });
});

describe('calculateTargetHeight', () => {
  const stub = (h) => () => h;
  it('returns the minimum height across animations', () => {
    const data = [{}, {}];
    let calls = 0;
    const heights = [150, 200];
    expect(calculateTargetHeight(data, () => heights[calls++])).toBe(150);
  });
  it('returns the common height when all equal', () => {
    expect(calculateTargetHeight([{}, {}, {}], stub(256))).toBe(256);
  });
  it('returns 256 for an empty array', () => {
    expect(calculateTargetHeight([])).toBe(256);
  });
  it('returns the single animation height', () => {
    expect(calculateTargetHeight([{}], stub(200))).toBe(200);
  });
  it('skips Infinity heights via Math.min baseline', () => {
    const data = [{}, {}];
    const heights = [100, Infinity];
    let i = 0;
    expect(calculateTargetHeight(data, () => heights[i++])).toBe(100);
  });
});

describe('baseScale', () => {
  it('returns 1 for matching heights', () => {
    expect(baseScale(100, 100)).toBe(1);
  });
  it('scales down a taller sprite', () => {
    expect(baseScale(100, 200)).toBe(0.5);
  });
  it('scales up a shorter sprite', () => {
    expect(baseScale(100, 50)).toBe(2);
    expect(baseScale(256, 128)).toBe(2);
  });
  it('produces extreme scale for tiny sprites', () => {
    expect(baseScale(100, 1)).toBe(100);
  });
});

describe('finalScale', () => {
  it('combines base scale and multiplier', () => {
    expect(finalScale(1, 1)).toBe(1);
    expect(finalScale(0.5, 2)).toBe(1);
    expect(finalScale(2, 0.5)).toBe(1);
    expect(finalScale(1.5, 1.5)).toBe(2.25);
    expect(finalScale(0.5, 1)).toBe(0.5);
  });
});

describe('persistAlignmentData', () => {
  it('stores size as absolute px and passes offsets through', () => {
    expect(persistAlignmentData(100, 1.5, 0, 0)).toEqual({
      sizeHeightPx: 150,
      groundOffset: 0,
      horizontalOffset: 0,
    });
    expect(persistAlignmentData(256, 1, 10, -5)).toEqual({
      sizeHeightPx: 256,
      groundOffset: 10,
      horizontalOffset: -5,
    });
  });
  it('yields 0 px when targetHeight is 0', () => {
    expect(persistAlignmentData(0, 1, 0, 0).sizeHeightPx).toBe(0);
  });
});

describe('hydrateAlignmentMultiplier', () => {
  it('round-trips with persistAlignmentData on the same baseline', () => {
    const saved = persistAlignmentData(100, 1.5, 0, 0);
    expect(hydrateAlignmentMultiplier(saved.sizeHeightPx, 100)).toBe(1.5);
  });
  it('preserves absolute height when baseline halves', () => {
    expect(hydrateAlignmentMultiplier(150, 75)).toBe(2);
  });
  it('returns 1 when saved px equals baseline', () => {
    expect(hydrateAlignmentMultiplier(256, 256)).toBe(1);
    expect(hydrateAlignmentMultiplier(200, 200)).toBe(1);
  });
  it('returns 0 when currentTargetHeight is 0', () => {
    expect(hydrateAlignmentMultiplier(150, 0)).toBe(0);
  });
});

describe('normalizedFrameExtent / normalizedFrameSize', () => {
  it('adds offset extent to scaled dimension', () => {
    // vertical: scaledHeight + (maxGroundOffset - minGroundOffset)
    expect(normalizedFrameExtent(100, 10 - -5)).toBe(115);
    // horizontal: scaledWidth + maxAbsHorizontalOffset * 2
    expect(normalizedFrameExtent(80, 6 * 2)).toBe(92);
  });
  it('ceils and applies a 1px floor', () => {
    expect(normalizedFrameSize(99.2)).toBe(100);
    expect(normalizedFrameSize(0)).toBe(1);
    expect(normalizedFrameSize(50, 2)).toBe(54); // 50 + 2*2 = 54
  });
});

// ---------------------------------------------------------------------------
// Whole-algorithm tests: computePackNormalization is the exact composition the
// export modal runs. These verify the integrated behavior (not just the units)
// and the invariants the pack-alignment feature is built around.
// ---------------------------------------------------------------------------

describe('computePackNormalization (composition)', () => {
  it("normalizes all sprites to the shortest sprite's height (no offsets)", () => {
    const sprites = [
      { animCharHeight: 100, frameBounds: [{ width: 50, height: 100 }] },
      { animCharHeight: 200, frameBounds: [{ width: 80, height: 200 }] },
    ];
    const r = computePackNormalization(sprites);
    expect(r.targetHeight).toBe(100); // = min(100, 200)
    expect(r.scales).toEqual([1, 0.5]); // 100/100, 100/200
    // The widest scaled frame is A's 50px; both heights collapse to 100.
    expect(r.frameSize).toEqual({ width: 50, height: 100 });
    // Both rendered character heights equal the baseline.
    expect(renderedHeight(r, 0, 100)).toBe(100);
    expect(renderedHeight(r, 1, 200)).toBe(100);
  });

  it('applies per-sprite size multipliers on top of the baseline scale', () => {
    const sprites = [
      {
        animCharHeight: 100,
        sizeMultiplier: 1,
        frameBounds: [{ width: 50, height: 100 }],
      },
      {
        animCharHeight: 200,
        sizeMultiplier: 2,
        frameBounds: [{ width: 80, height: 200 }],
      },
    ];
    const r = computePackNormalization(sprites);
    // B is twice the baseline: 200 * (100/200) * 2 = 200px rendered.
    expect(renderedHeight(r, 0, 100)).toBe(100);
    expect(renderedHeight(r, 1, 200)).toBe(200);
    expect(r.frameSize.height).toBe(200); // B now drives the height
  });

  it('expands the frame box by the global scaled ground extent', () => {
    const sprites = [
      {
        animCharHeight: 100,
        groundOffset: 20, // 20 source px * scale 1 = 20 output px
        frameBounds: [{ width: 40, height: 100 }],
      },
      {
        animCharHeight: 100,
        groundOffset: 0,
        frameBounds: [{ width: 40, height: 100 }],
      },
    ];
    const r = computePackNormalization(sprites);
    // groundExtent = max(0,20,0) - min(0,20,0) = 20; height = 100 + 20.
    expect(r.frameSize.height).toBe(120);
  });

  it('expands the frame box by twice the max absolute horizontal offset', () => {
    const sprites = [
      {
        animCharHeight: 100,
        horizontalOffset: 10,
        frameBounds: [{ width: 50, height: 100 }],
      },
      {
        animCharHeight: 100,
        horizontalOffset: -3,
        frameBounds: [{ width: 50, height: 100 }],
      },
    ];
    const r = computePackNormalization(sprites);
    // horizontalExtent = max(|10|,|-3|) * 2 = 20; width = 50 + 20.
    expect(r.frameSize.width).toBe(70);
  });

  it('scales the horizontal offset room with each sprite, so nothing is clipped', () => {
    const sprites = [
      {
        animCharHeight: 100,
        frameBounds: [{ width: 50, height: 100 }],
      },
      {
        animCharHeight: 100,
        sizeMultiplier: 2,
        horizontalOffset: 10,
        frameBounds: [{ width: 50, height: 100 }],
      },
    ];
    const r = computePackNormalization(sprites);
    // Sprite 2 is drawn at scale 2 and shifted 10 * 2 = 20 px, so each side
    // needs 20 px: width = 50 * 2 + 40.
    expect(r.scales).toEqual([1, 2]);
    expect(r.frameSize.width).toBe(140);

    // The shifted sprite stays inside the frame.
    const { charX } = computeFramePlacement({
      frameWidth: r.frameSize.width,
      frameHeight: r.frameSize.height,
      maxGroundOffset: 0,
      groundOffset: 0,
      scaledWidth: 50 * 2,
      scaledHeight: 100 * 2,
      horizontalOffset: 10,
      scale: 2,
    });
    expect(charX).toBeGreaterThanOrEqual(0);
    expect(charX + 50 * 2).toBeLessThanOrEqual(r.frameSize.width);
  });

  it('handles a single sprite and the empty pack safely', () => {
    expect(
      computePackNormalization([{ animCharHeight: 128, frameBounds: [] }])
    ).toMatchObject({ targetHeight: 128, scales: [1] });
    expect(computePackNormalization([])).toMatchObject({
      targetHeight: 256, // calculateTargetHeight fallback
      scales: [],
      frameSize: { width: 1, height: 1 }, // 1px floor
    });
  });
});

describe('computePackNormalization (invariants the feature depends on)', () => {
  // Build a sprite descriptor where the saved size is reapplied via hydrate.
  const withSaved = (animCharHeight, sizeHeightPx, targetHeight) => ({
    animCharHeight,
    sizeMultiplier: hydrateAlignmentMultiplier(sizeHeightPx, targetHeight),
    frameBounds: [{ width: 10, height: animCharHeight }],
  });

  it("persist -> hydrate keeps a sprite's absolute height when the shortest sprite changes", () => {
    // Pack 1: A (tall) + B (short). Baseline = 100. User pins A to 140px.
    const pack1 = [
      { animCharHeight: 200, frameBounds: [{ width: 10, height: 200 }] },
      { animCharHeight: 100, frameBounds: [{ width: 10, height: 100 }] },
    ];
    const r1 = computePackNormalization(pack1);
    expect(r1.targetHeight).toBe(100);
    const desiredA = 140;
    const savedA = persistAlignmentData(
      r1.targetHeight,
      desiredA / r1.targetHeight, // the multiplier that yields 140px
      0,
      0
    ).sizeHeightPx;
    expect(savedA).toBe(140);

    // Pack 2: a SHORTER sprite C joins, so the baseline drops to 50.
    const pack2 = [
      withSaved(200, savedA, 50), // A, size re-derived from saved 140px
      { animCharHeight: 100, frameBounds: [{ width: 10, height: 100 }] },
      { animCharHeight: 50, frameBounds: [{ width: 10, height: 50 }] }, // C, shortest
    ];
    const r2 = computePackNormalization(pack2);
    expect(r2.targetHeight).toBe(50); // baseline changed
    // A still renders at exactly 140px despite the new baseline.
    expect(renderedHeight(r2, 0, 200)).toBeCloseTo(140, 6);
  });

  it('preserves relative size ratios between sprites across baseline changes', () => {
    // A is 1.5x B in both packs, regardless of the shortest sprite.
    const ratio = (sprites, hA, hB) => {
      const r = computePackNormalization(sprites);
      return renderedHeight(r, 0, hA) / renderedHeight(r, 1, hB);
    };
    const pack1 = [
      { animCharHeight: 100, sizeMultiplier: 1.5, frameBounds: [] },
      { animCharHeight: 100, sizeMultiplier: 1, frameBounds: [] },
    ];
    const pack2 = [
      { animCharHeight: 100, sizeMultiplier: 1.5, frameBounds: [] },
      { animCharHeight: 100, sizeMultiplier: 1, frameBounds: [] },
      { animCharHeight: 40, sizeMultiplier: 1, frameBounds: [] }, // shrinks baseline
    ];
    expect(ratio(pack1, 100, 100)).toBeCloseTo(1.5, 6);
    expect(ratio(pack2, 100, 100)).toBeCloseTo(1.5, 6);
  });

  it('keeps every pinned sprite at its saved absolute height when a shorter sprite is added', () => {
    // Pack baseline 100; pin A->180px, B->90px.
    const base = 100;
    const savedA = persistAlignmentData(base, 1.8, 0, 0).sizeHeightPx; // 180
    const savedB = persistAlignmentData(base, 0.9, 0, 0).sizeHeightPx; // 90
    // New shorter sprite drops the baseline to 25.
    const pack = [
      withSaved(150, savedA, 25),
      withSaved(120, savedB, 25),
      { animCharHeight: 25, frameBounds: [] }, // shortest
    ];
    const r = computePackNormalization(pack);
    expect(r.targetHeight).toBe(25);
    expect(renderedHeight(r, 0, 150)).toBeCloseTo(180, 6);
    expect(renderedHeight(r, 1, 120)).toBeCloseTo(90, 6);
  });
});

describe('computeFramePlacement', () => {
  const base = {
    frameWidth: 100,
    frameHeight: 100,
    padding: 0,
    maxGroundOffset: 0,
    groundOffset: 0,
    scaledWidth: 40,
    scaledHeight: 80,
    horizontalOffset: 0,
    scale: 1,
  };

  it('centers the sprite horizontally when there is no horizontal offset', () => {
    const { charX, centerX } = computeFramePlacement(base);
    expect(centerX).toBe(50); // 100/2
    expect(charX).toBe(30); // 50 - 40/2
  });

  it("places the sprite's feet exactly on the ground line when ground offset is 0", () => {
    const { charY, groundLineY } = computeFramePlacement(base);
    expect(groundLineY).toBe(100); // bottom of the cell
    expect(charY).toBe(20); // 100 - 80
    expect(charY + base.scaledHeight).toBe(groundLineY); // feet on the line
  });

  it('reserves space at the bottom equal to maxGroundOffset', () => {
    const { groundLineY, charY } = computeFramePlacement({
      ...base,
      maxGroundOffset: 15,
    });
    expect(groundLineY).toBe(85); // 100 - 0 - 15
    expect(charY).toBe(5);
  });

  it('pushes a sprite down by its own (scaled) ground offset', () => {
    const { charY } = computeFramePlacement({
      ...base,
      maxGroundOffset: 15,
      groundOffset: 10, // this sprite sits 10px below the line
    });
    // groundLineY = 85; spriteBottomY = 95; charY = 95 - 80 = 15
    expect(charY).toBe(15);
  });

  it('applies the horizontal offset scaled by the sprite scale', () => {
    const { charX } = computeFramePlacement({
      ...base,
      horizontalOffset: 5,
      scale: 2,
    });
    // 50 - 20 + 5*2 = 40
    expect(charX).toBe(40);
  });

  it('rounds charX/charY to integer pixels', () => {
    const { charX, charY } = computeFramePlacement({
      ...base,
      scaledWidth: 41, // 50 - 20.5 = 29.5 -> 30
      scaledHeight: 79.4, // 100 - 79.4 = 20.6 -> 21
    });
    expect(charX).toBe(30);
    expect(charY).toBe(21);
  });

  it('offsets placement into a grid cell by exactly (frameOriginX, frameOriginY)', () => {
    const single = computeFramePlacement(base);
    const inCell = computeFramePlacement({
      ...base,
      frameOriginX: 200, // e.g. col 2 * width 100
      frameOriginY: 300, // e.g. row 3 * height 100
    });
    expect(inCell.charX).toBe(single.charX + 200);
    expect(inCell.charY).toBe(single.charY + 300);
    expect(inCell.groundLineY).toBe(single.groundLineY + 300);
    expect(inCell.centerX).toBe(single.centerX + 200);
  });
});

describe('uniquifyNames', () => {
  it('leaves distinct names untouched', () => {
    expect(uniquifyNames(['walk', 'jump', 'idle'])).toEqual([
      'walk',
      'jump',
      'idle',
    ]);
  });
  it('suffixes duplicates with -1, -2, …', () => {
    expect(uniquifyNames(['walk', 'walk', 'walk'])).toEqual([
      'walk',
      'walk-1',
      'walk-2',
    ]);
  });
  it('counts duplicates independently per name', () => {
    expect(uniquifyNames(['a', 'b', 'a', 'b', 'a'])).toEqual([
      'a',
      'b',
      'a-1',
      'b-1',
      'a-2',
    ]);
  });
  it('sanitizes non-word characters before comparing', () => {
    expect(uniquifyNames(['run fast!', 'run fast!'])).toEqual([
      'run-fast-',
      'run-fast--1',
    ]);
  });
  it('returns an empty list unchanged', () => {
    expect(uniquifyNames([])).toEqual([]);
  });
});

describe('applyTargetFrameSize', () => {
  const auto = { width: 297, height: 168 };
  it('keeps the auto size when no target is set', () => {
    expect(applyTargetFrameSize(auto)).toEqual(auto);
    expect(applyTargetFrameSize(auto, { w: '', h: '' })).toEqual(auto);
    expect(applyTargetFrameSize(auto, { w: 'abc', h: -5 })).toEqual(auto);
  });
  it('grows each axis to the target', () => {
    expect(applyTargetFrameSize(auto, { w: 640, h: 640 })).toEqual({
      width: 640,
      height: 640,
    });
    expect(applyTargetFrameSize(auto, { w: '640' })).toEqual({
      width: 640,
      height: 168,
    });
  });
  it('never shrinks below the auto size (never crops)', () => {
    expect(applyTargetFrameSize(auto, { w: 100, h: 100 })).toEqual(auto);
  });
  it('caps the target', () => {
    expect(applyTargetFrameSize(auto, { w: 99999 }).width).toBe(
      MAX_TARGET_FRAME_PX
    );
  });
});

describe('computePackNormalization with a target frame size', () => {
  const sprites = [
    { animCharHeight: 100, frameBounds: [{ width: 80, height: 100 }] },
    { animCharHeight: 200, frameBounds: [{ width: 120, height: 200 }] },
  ];
  it('only changes the frame size, not the scales', () => {
    const auto = computePackNormalization(sprites);
    const big = computePackNormalization(sprites, { w: 640, h: 640 });
    expect(big.scales).toEqual(auto.scales);
    expect(big.targetHeight).toBe(auto.targetHeight);
    expect(big.frameSize).toEqual({ width: 640, height: 640 });
  });
  it('keeps characters on the ground line and centered in the bigger frame', () => {
    const { frameSize } = computePackNormalization(sprites, {
      w: 640,
      h: 640,
    });
    const p = computeFramePlacement({
      frameWidth: frameSize.width,
      frameHeight: frameSize.height,
      maxGroundOffset: 0,
      groundOffset: 0,
      scaledWidth: 60,
      scaledHeight: 100,
    });
    expect(p.charY + 100).toBe(640); // feet on the bottom edge
    expect(p.charX + 30).toBe(320); // centered
  });
});
