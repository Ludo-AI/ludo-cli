// Ported unchanged from prometheus-web src/pages/SpriteGenerator/exportSequenceMath.test.js
// (commit 7a6a45be); only the imports differ. Keep it in step with the web's.
import { describe, it, expect } from './vitest.mjs';
import {
  sanitizeName,
  sequenceGrid,
  gridCell,
  sheetSize,
  nextSequenceSlot,
  sequenceCanvasBounds,
  cropBounds,
  paddedFrameLayout,
  MAX_SEQUENCE_FRAME_PX,
  MIN_SEQUENCE_SIZE_PX,
  frameFooting,
  footedAlignment,
} from '../../dist/toolbox/sequenceMath.js';

describe('sanitizeName', () => {
  it('lowercases and hyphenates', () => {
    expect(sanitizeName('My Cool Pack')).toBe('my-cool-pack');
    expect(sanitizeName('Hero_Walk 01!')).toBe('hero-walk-01');
  });
  it('trims leading/trailing separators', () => {
    expect(sanitizeName('  --Hello-- ')).toBe('hello');
  });
  it('falls back when the result is empty', () => {
    expect(sanitizeName('', 'sequence')).toBe('sequence');
    expect(sanitizeName('!!!', 'sequence')).toBe('sequence');
    expect(sanitizeName(null, 'fallback')).toBe('fallback');
  });
  it('returns empty string fallback by default', () => {
    expect(sanitizeName('###')).toBe('');
  });
});

describe('sequenceGrid', () => {
  it('produces a square grid for perfect squares', () => {
    expect(sequenceGrid(1)).toEqual({ cols: 1, rows: 1 });
    expect(sequenceGrid(4)).toEqual({ cols: 2, rows: 2 });
    expect(sequenceGrid(9)).toEqual({ cols: 3, rows: 3 });
  });
  it('uses ceil(sqrt) columns and packs the remaining rows', () => {
    expect(sequenceGrid(5)).toEqual({ cols: 3, rows: 2 }); // ceil(2.23)=3, ceil(5/3)=2
    expect(sequenceGrid(10)).toEqual({ cols: 4, rows: 3 }); // ceil(3.16)=4, ceil(10/4)=3
    expect(sequenceGrid(36)).toEqual({ cols: 6, rows: 6 });
  });
  it('returns a zero grid for an empty count', () => {
    expect(sequenceGrid(0)).toEqual({ cols: 0, rows: 0 });
  });
});

describe('gridCell', () => {
  it('maps an index to row-major (col, row)', () => {
    expect(gridCell(0, 3)).toEqual({ col: 0, row: 0 });
    expect(gridCell(2, 3)).toEqual({ col: 2, row: 0 });
    expect(gridCell(3, 3)).toEqual({ col: 0, row: 1 });
    expect(gridCell(5, 3)).toEqual({ col: 2, row: 1 });
  });
});

describe('sheetSize', () => {
  it('multiplies cell size by grid dimensions', () => {
    expect(sheetSize(2, 2, 10, 20)).toEqual({ width: 20, height: 40 });
    expect(sheetSize(6, 6, 64, 64)).toEqual({ width: 384, height: 384 });
  });
});

describe('nextSequenceSlot', () => {
  it('offsets position by dx/dy and scales the raw size', () => {
    const prev = { x: 0, y: 0, w: 100, h: 100 };
    expect(
      nextSequenceSlot(prev, { dx: 10, dy: -5, scale: 0.5 }, 80, 80)
    ).toEqual({ x: 10, y: -5, w: 40, h: 40 });
  });
  it('is identity in position with dx=dy=0, scale=1', () => {
    const prev = { x: 7, y: 3, w: 100, h: 100 };
    expect(nextSequenceSlot(prev, { dx: 0, dy: 0, scale: 1 }, 50, 60)).toEqual({
      x: 7,
      y: 3,
      w: 50,
      h: 60,
    });
  });
  it('rounds the scaled size', () => {
    const prev = { x: 0, y: 0, w: 0, h: 0 };
    const s = nextSequenceSlot(prev, { scale: 0.333 }, 100, 100);
    expect(s.w).toBe(33); // round(33.3)
    expect(s.h).toBe(33);
  });
});

describe('sequenceCanvasBounds', () => {
  it('computes the bbox, canvas size, and shift for positive slots', () => {
    const slots = [
      { x: 0, y: 0, w: 100, h: 100 },
      { x: 10, y: -5, w: 40, h: 40 },
    ];
    expect(sequenceCanvasBounds(slots)).toEqual({
      minX: 0,
      minY: -5,
      maxX: 100, // max(0+100, 10+40)
      maxY: 100, // max(0+100, -5+40)
      canvasW: 100,
      canvasH: 105, // ceil(100 - (-5))
      shiftX: 0,
      shiftY: 5, // -minY
    });
  });
  it('handles a single slot', () => {
    expect(sequenceCanvasBounds([{ x: 0, y: 0, w: 50, h: 60 }])).toMatchObject({
      canvasW: 50,
      canvasH: 60,
      shiftX: 0,
      shiftY: 0,
    });
  });

  // Invariant: after shifting, every slot fits inside [0, canvasW] x [0, canvasH].
  it('produces a canvas that contains every chained slot once shifted', () => {
    const ref = { x: 0, y: 0, w: 120, h: 90 };
    const steps = [
      { dx: -30, dy: 10, scale: 0.5, rawW: 100, rawH: 100 },
      { dx: 25, dy: -40, scale: 1.2, rawW: 80, rawH: 80 },
      { dx: 5, dy: 60, scale: 1, rawW: 60, rawH: 140 },
    ];
    const slots = [ref];
    for (const st of steps) {
      slots.push(
        nextSequenceSlot(slots[slots.length - 1], st, st.rawW, st.rawH)
      );
    }
    const { canvasW, canvasH, shiftX, shiftY } = sequenceCanvasBounds(slots);
    for (const s of slots) {
      expect(s.x + shiftX).toBeGreaterThanOrEqual(0);
      expect(s.y + shiftY).toBeGreaterThanOrEqual(0);
      expect(s.x + shiftX + s.w).toBeLessThanOrEqual(canvasW);
      expect(s.y + shiftY + s.h).toBeLessThanOrEqual(canvasH);
    }
  });
});

describe('cropBounds', () => {
  it('unions per-frame content bounds into a tight crop', () => {
    const list = [
      { minX: 5, minY: 10, maxX: 50, maxY: 80 },
      { minX: 2, minY: 15, maxX: 40, maxY: 90 },
    ];
    expect(cropBounds(list, 100, 100)).toEqual({
      minX: 2,
      minY: 10,
      maxX: 50,
      maxY: 90,
      cropW: 49, // 50 - 2 + 1
      cropH: 81, // 90 - 10 + 1
    });
  });
  it("uses a single frame's bounds verbatim", () => {
    expect(
      cropBounds([{ minX: 0, minY: 0, maxX: 9, maxY: 19 }], 64, 64)
    ).toMatchObject({ cropW: 10, cropH: 20 });
  });
});

describe('paddedFrameLayout', () => {
  it('keeps the content size when nothing is set', () => {
    expect(paddedFrameLayout(604, 595, null, null)).toMatchObject({
      frameW: 604,
      frameH: 595,
      scale: 1,
      drawW: 604,
      drawH: 595,
      offsetX: 0,
      offsetY: 0,
      vertical: 0,
      horizontal: 0,
    });
  });
  it('treats empty strings (blank inputs) as unset', () => {
    expect(
      paddedFrameLayout(604, 595, '', '', {
        size: '',
        vertical: '',
        horizontal: '',
      })
    ).toMatchObject({ frameW: 604, frameH: 595, scale: 1 });
  });
  it('pads up to the target and centers the content by default', () => {
    expect(paddedFrameLayout(604, 595, 640, 640)).toMatchObject({
      frameW: 640,
      frameH: 640,
      drawW: 604,
      drawH: 595,
      offsetX: 18,
      offsetY: 22,
      vertical: 23,
      horizontal: 0,
    });
  });
  it('a frame smaller than the content grows to fit it (never crops)', () => {
    expect(paddedFrameLayout(604, 595, 500, 700)).toMatchObject({
      frameW: 604,
      frameH: 700,
      offsetX: 0,
    });
  });

  describe('vertical (px up from the bottom edge, like the pack ground)', () => {
    it('0 puts the content on the bottom edge', () => {
      expect(
        paddedFrameLayout(604, 595, 640, 640, { vertical: 0 })
      ).toMatchObject({ offsetY: 45, vertical: 0 });
    });
    it('positive moves it up, clamped at the top edge', () => {
      expect(
        paddedFrameLayout(604, 595, 640, 640, { vertical: 10 }).offsetY
      ).toBe(35);
      expect(
        paddedFrameLayout(604, 595, 640, 640, { vertical: 999 })
      ).toMatchObject({ offsetY: 0, vertical: 45 });
      expect(
        paddedFrameLayout(604, 595, 640, 640, { vertical: -5 })
      ).toMatchObject({ offsetY: 45, vertical: 0 });
    });
  });

  describe('horizontal (px from center, positive right)', () => {
    it('moves the content right and left of center', () => {
      expect(
        paddedFrameLayout(604, 595, 640, 640, { horizontal: 5 }).offsetX
      ).toBe(23);
      expect(
        paddedFrameLayout(604, 595, 640, 640, { horizontal: -5 }).offsetX
      ).toBe(13);
    });
    it('clamps at both edges', () => {
      const l = paddedFrameLayout(604, 595, 640, 640, { horizontal: -999 });
      expect(l.offsetX).toBe(0);
      expect(l.horizontal).toBe(l.hMin);
      const r = paddedFrameLayout(604, 595, 640, 640, { horizontal: 999 });
      expect(r.offsetX + r.drawW).toBe(r.frameW);
      expect(r.horizontal).toBe(r.hMax);
    });
    it('covers the whole range for odd leftover space', () => {
      // 37px of room: -18..19, and both ends are flush.
      const l = paddedFrameLayout(100, 100, 137, 100);
      expect([l.hMin, l.hMax]).toEqual([-18, 19]);
    });
  });

  describe('size (rendered content height in px, like the pack Size)', () => {
    it('scales the content to the given height', () => {
      expect(
        paddedFrameLayout(200, 100, 800, 300, { size: 200 })
      ).toMatchObject({ scale: 2, drawW: 400, drawH: 200 });
    });
    it('grows only until the content fills a set frame size', () => {
      // 200x100 in 800x300: height allows 3x, width 4x.
      const l = paddedFrameLayout(200, 100, 800, 300, { size: 9999 });
      expect(l).toMatchObject({ scale: 3, drawH: 300, sizeMax: 300 });
      expect(l.drawW).toBeLessThanOrEqual(l.frameW);
    });
    it('never overshoots the frame through rounding at the fit limit', () => {
      const l = paddedFrameLayout(604, 595, 640, 640, { size: 9999 });
      expect(l.drawW).toBeLessThanOrEqual(640);
      expect(l.drawH).toBeLessThanOrEqual(640);
      expect([l.frameW, l.frameH]).toEqual([640, 640]);
    });
    it('can shrink, e.g. to fit a frame smaller than the content', () => {
      const l = paddedFrameLayout(604, 595, 512, 512, { size: 500 });
      expect(l).toMatchObject({ frameW: 512, frameH: 512, drawH: 500 });
      expect(l.drawW).toBeLessThanOrEqual(512);
    });
    it('with no frame size the frame follows the scaled content', () => {
      expect(
        paddedFrameLayout(200, 100, null, null, { size: 150 })
      ).toMatchObject({ frameW: 300, frameH: 150, slackX: 0, slackY: 0 });
    });
    it('guards against giant canvases and tiny sizes', () => {
      expect(
        paddedFrameLayout(200, 100, null, null, { size: 1e6 }).frameW
      ).toBe(MAX_SEQUENCE_FRAME_PX);
      expect(paddedFrameLayout(200, 100, null, null, { size: 0.2 }).drawH).toBe(
        MIN_SEQUENCE_SIZE_PX
      );
    });
    it('caps a typed frame size too', () => {
      const l = paddedFrameLayout(297, 168, 30020, 400);
      expect(l.frameW).toBe(MAX_SEQUENCE_FRAME_PX);
      expect(l.frameH).toBe(400);
    });
    it('reports the size actually rendered when the frame caps it', () => {
      // A 300px-wide frame limits a 297x168 animation to ~1.01x, so a stored
      // 218px becomes 170px (the Size input shows drawH, not the stored value).
      const l = paddedFrameLayout(297, 168, 300, 400, { size: 218 });
      expect(l.drawH).toBe(170);
      expect(l.sizeMax).toBe(170);
      expect(l.drawW).toBeLessThanOrEqual(300);
    });
  });

  it('the same values place any sequence the same way (copyable)', () => {
    // Two differently sized animations with the same values end up the same
    // height, with their lowest point the same distance above the bottom edge.
    const values = { size: 400, vertical: 12, horizontal: -8 };
    const a = paddedFrameLayout(604, 595, 640, 640, values);
    const b = paddedFrameLayout(300, 520, 640, 640, values);
    for (const l of [a, b]) {
      expect(l.drawH).toBe(400);
      expect(l.frameH - (l.offsetY + l.drawH)).toBe(12);
      // Odd widths can't sit exactly on the center line: within half a pixel.
      expect(
        Math.abs(l.offsetX + l.drawW / 2 - l.frameW / 2 + 8)
      ).toBeLessThanOrEqual(0.5);
    }
  });

  it('every frame stays inside for any combination of values', () => {
    for (const size of [null, 50, 300, 595, 700, 5000])
      for (const vertical of [null, -50, 0, 20, 5000])
        for (const horizontal of [-5000, -10, 0, 10, 5000]) {
          const l = paddedFrameLayout(604, 595, 640, 640, {
            size,
            vertical,
            horizontal,
          });
          expect(l.offsetX).toBeGreaterThanOrEqual(0);
          expect(l.offsetY).toBeGreaterThanOrEqual(0);
          expect(l.offsetX + l.drawW).toBeLessThanOrEqual(l.frameW);
          expect(l.offsetY + l.drawH).toBeLessThanOrEqual(l.frameH);
        }
  });
});

// A w x h RGBA frame with solid pixels (alpha 255) in [x0, x1) x [y0, y1).
const block = (w, h, x0, y0, x1, y1, alpha = 255) => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) data[(y * w + x) * 4 + 3] = alpha;
  return data;
};

describe('frameFooting', () => {
  it('finds the bottom edge and the horizontal centre of mass', () => {
    // Columns 10..19, rows 5..29: the bottom edge is 30, the centre 15.
    expect(frameFooting(block(40, 40, 10, 5, 20, 30), 40, 40)).toEqual({
      bottom: 30,
      centerX: 15,
    });
  });
  it('ignores pixels at alpha 200 or below (soft edges, shadows)', () => {
    const data = block(40, 40, 10, 5, 20, 30);
    const shadow = block(40, 40, 0, 30, 40, 36, 200);
    for (let i = 3; i < data.length; i += 4)
      data[i] = Math.max(data[i], shadow[i]);
    expect(frameFooting(data, 40, 40).bottom).toBe(30);
  });
  it('is null for an empty frame', () => {
    expect(frameFooting(new Uint8ClampedArray(16 * 16 * 4), 16, 16)).toBeNull();
  });
});

describe('footedAlignment', () => {
  const footA = { bottom: 100, centerX: 50 };
  const footB = { bottom: 80, centerX: 30 };
  it("a match keeps its scale and dx, and puts B's feet on A's", () => {
    const r = footedAlignment(
      { dx: 7, dy: -3, scale: 1.25, confidence: 0.9 },
      footA,
      footB
    );
    expect(r).toEqual({ dx: 7, dy: 0, scale: 1.25, confidence: 0.9 });
    // B's bottom edge lands on A's: dy + 80 * 1.25 = 100.
    expect(r.dy + footB.bottom * r.scale).toBe(footA.bottom);
  });
  it('a fallback (confidence 0) also lines up the centres', () => {
    const r = footedAlignment(
      { dx: 0, dy: 0, scale: 0.5, confidence: 0 },
      footA,
      footB
    );
    expect(r).toEqual({ dx: 35, dy: 60, scale: 0.5, confidence: 0 });
  });
  it('rounds to whole pixels', () => {
    const r = footedAlignment(
      { dx: 0, dy: 0, scale: 1.1, confidence: 0 },
      { bottom: 99, centerX: 40.5 },
      { bottom: 70, centerX: 20.25 }
    );
    expect(r.dy).toBe(Math.round(99 - 77));
    expect(r.dx).toBe(Math.round(40.5 - 22.275));
  });
  it('without footing on either side the alignment is kept', () => {
    const a = { dx: 4, dy: 5, scale: 1, confidence: 0.8 };
    expect(footedAlignment(a, null, footB)).toBe(a);
    expect(footedAlignment(a, footA, null)).toBe(a);
  });
});
