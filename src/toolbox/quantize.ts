// Colour quantization: Xiaolin Wu's "Efficient Statistical Computations for
// Optimal Color Quantization" (Graphics Gems II, 1991, pp. 126-133), written
// here from the paper and the C code published with it.
//
// Colours go into a 32x32x32 histogram (5 bits a channel) that keeps, per
// cell, the pixel count and the sums of r, g, b and r²+g²+b², all as
// cumulative 3-D moments so any box's totals cost eight lookups. Starting
// from the whole cube, the box with the largest variance is cut in two, on
// the axis and at the plane that most reduce the summed squared error, until
// there are as many boxes as colours wanted. Each box's colour is the mean of
// the pixels in it.

const SIDE = 33; // 32 bins a channel, plus a zero row/column/plane at 0
const CELLS = SIDE * SIDE * SIDE;
const at = (r: number, g: number, b: number) => (r * SIDE + g) * SIDE + b;

const RED = 0;
const GREEN = 1;
const BLUE = 2;

interface Box {
  r0: number; // exclusive
  r1: number; // inclusive
  g0: number;
  g1: number;
  b0: number;
  b1: number;
  vol: number; // histogram cells in the box
}

export type Rgb = [number, number, number];

export class WuQuantizer {
  private wt = new Float64Array(CELLS);
  private mr = new Float64Array(CELLS);
  private mg = new Float64Array(CELLS);
  private mb = new Float64Array(CELLS);
  private m2 = new Float64Array(CELLS);
  private pixels = 0;

  add(r: number, g: number, b: number, weight = 1) {
    const i = at((r >> 3) + 1, (g >> 3) + 1, (b >> 3) + 1);
    this.wt[i] += weight;
    this.mr[i] += r * weight;
    this.mg[i] += g * weight;
    this.mb[i] += b * weight;
    this.m2[i] += (r * r + g * g + b * b) * weight;
    this.pixels += weight;
  }

  /** At most `max` colours for the pixels added so far (fewer when fewer suffice). */
  palette(max: number): Rgb[] {
    if (!this.pixels) return [];
    // Cumulated copies, so pixels can still be added afterwards.
    const [wt, mr, mg, mb, m2] = [this.wt, this.mr, this.mg, this.mb, this.m2].map(cumulated);

    const vol = (c: Box, m: Float64Array) =>
      m[at(c.r1, c.g1, c.b1)] -
      m[at(c.r1, c.g1, c.b0)] -
      m[at(c.r1, c.g0, c.b1)] +
      m[at(c.r1, c.g0, c.b0)] -
      m[at(c.r0, c.g1, c.b1)] +
      m[at(c.r0, c.g1, c.b0)] +
      m[at(c.r0, c.g0, c.b1)] -
      m[at(c.r0, c.g0, c.b0)];

    // The part of vol() that does not depend on the cutting plane's position.
    const bottom = (c: Box, dir: number, m: Float64Array) =>
      dir === RED
        ? -m[at(c.r0, c.g1, c.b1)] + m[at(c.r0, c.g1, c.b0)] + m[at(c.r0, c.g0, c.b1)] - m[at(c.r0, c.g0, c.b0)]
        : dir === GREEN
          ? -m[at(c.r1, c.g0, c.b1)] + m[at(c.r1, c.g0, c.b0)] + m[at(c.r0, c.g0, c.b1)] - m[at(c.r0, c.g0, c.b0)]
          : -m[at(c.r1, c.g1, c.b0)] + m[at(c.r1, c.g0, c.b0)] + m[at(c.r0, c.g1, c.b0)] - m[at(c.r0, c.g0, c.b0)];

    // The rest of it, for a plane at `pos`.
    const top = (c: Box, dir: number, pos: number, m: Float64Array) =>
      dir === RED
        ? m[at(pos, c.g1, c.b1)] - m[at(pos, c.g1, c.b0)] - m[at(pos, c.g0, c.b1)] + m[at(pos, c.g0, c.b0)]
        : dir === GREEN
          ? m[at(c.r1, pos, c.b1)] - m[at(c.r1, pos, c.b0)] - m[at(c.r0, pos, c.b1)] + m[at(c.r0, pos, c.b0)]
          : m[at(c.r1, c.g1, pos)] - m[at(c.r1, c.g0, pos)] - m[at(c.r0, c.g1, pos)] + m[at(c.r0, c.g0, pos)];

    // The box's summed squared distance from its mean.
    const variance = (c: Box) => {
      const dr = vol(c, mr);
      const dg = vol(c, mg);
      const db = vol(c, mb);
      return vol(c, m2) - (dr * dr + dg * dg + db * db) / vol(c, wt);
    };

    // The cut along `dir` that leaves the two halves with the most between-
    // class variance (equivalently, the least squared error).
    const maximize = (c: Box, dir: number, first: number, last: number, whole: number[]) => {
      const base = [bottom(c, dir, mr), bottom(c, dir, mg), bottom(c, dir, mb), bottom(c, dir, wt)];
      let max = 0;
      let cut = -1;
      for (let i = first; i < last; i++) {
        let hr = base[0] + top(c, dir, i, mr);
        let hg = base[1] + top(c, dir, i, mg);
        let hb = base[2] + top(c, dir, i, mb);
        let hw = base[3] + top(c, dir, i, wt);
        if (hw === 0) continue;
        let temp = (hr * hr + hg * hg + hb * hb) / hw;
        hr = whole[0] - hr;
        hg = whole[1] - hg;
        hb = whole[2] - hb;
        hw = whole[3] - hw;
        if (hw === 0) continue;
        temp += (hr * hr + hg * hg + hb * hb) / hw;
        if (temp > max) {
          max = temp;
          cut = i;
        }
      }
      return { max, cut };
    };

    const cutBox = (set1: Box, set2: Box): boolean => {
      const whole = [vol(set1, mr), vol(set1, mg), vol(set1, mb), vol(set1, wt)];
      const red = maximize(set1, RED, set1.r0 + 1, set1.r1, whole);
      const green = maximize(set1, GREEN, set1.g0 + 1, set1.g1, whole);
      const blue = maximize(set1, BLUE, set1.b0 + 1, set1.b1, whole);
      let dir: number;
      if (red.max >= green.max && red.max >= blue.max) {
        dir = RED;
        if (red.cut < 0) return false; // can't split the box
      } else dir = green.max >= red.max && green.max >= blue.max ? GREEN : BLUE;

      set2.r1 = set1.r1;
      set2.g1 = set1.g1;
      set2.b1 = set1.b1;
      if (dir === RED) {
        set2.r0 = set1.r1 = red.cut;
        set2.g0 = set1.g0;
        set2.b0 = set1.b0;
      } else if (dir === GREEN) {
        set2.g0 = set1.g1 = green.cut;
        set2.r0 = set1.r0;
        set2.b0 = set1.b0;
      } else {
        set2.b0 = set1.b1 = blue.cut;
        set2.r0 = set1.r0;
        set2.g0 = set1.g0;
      }
      set1.vol = (set1.r1 - set1.r0) * (set1.g1 - set1.g0) * (set1.b1 - set1.b0);
      set2.vol = (set2.r1 - set2.r0) * (set2.g1 - set2.g0) * (set2.b1 - set2.b0);
      return true;
    };

    const cubes: Box[] = Array.from({ length: max }, () => ({ r0: 0, r1: 0, g0: 0, g1: 0, b0: 0, b1: 0, vol: 0 }));
    Object.assign(cubes[0], { r1: SIDE - 1, g1: SIDE - 1, b1: SIDE - 1 });
    const vv = new Float64Array(max);
    let count = max;
    let next = 0;
    for (let i = 1; i < count; i++) {
      if (cutBox(cubes[next], cubes[i])) {
        vv[next] = cubes[next].vol > 1 ? variance(cubes[next]) : 0;
        vv[i] = cubes[i].vol > 1 ? variance(cubes[i]) : 0;
      } else {
        vv[next] = 0; // don't try to split this box again
        i--; // didn't create box i
      }
      next = 0;
      let temp = vv[0];
      for (let k = 1; k <= i; k++) {
        if (vv[k] > temp) {
          temp = vv[k];
          next = k;
        }
      }
      if (temp <= 0) {
        count = i + 1; // only got this many boxes
        break;
      }
    }

    const colours: Rgb[] = [];
    for (let k = 0; k < count; k++) {
      const w = vol(cubes[k], wt);
      if (w > 0) colours.push([Math.round(vol(cubes[k], mr) / w), Math.round(vol(cubes[k], mg) / w), Math.round(vol(cubes[k], mb) / w)]);
    }
    return colours;
  }
}

// Running sums, so m[r][g][b] holds the total of every cell at or below
// (r, g, b).
function cumulated(cells: Float64Array): Float64Array {
  const m = Float64Array.from(cells);
  const area = new Float64Array(SIDE);
  for (let r = 1; r < SIDE; r++) {
    area.fill(0);
    for (let g = 1; g < SIDE; g++) {
      let line = 0;
      for (let b = 1; b < SIDE; b++) {
        const i = at(r, g, b);
        line += m[i];
        area[b] += line;
        m[i] = m[at(r - 1, g, b)] + area[b];
      }
    }
  }
  return m;
}

/** The nearest palette colour (squared RGB distance) of each colour asked, remembered. */
export class PaletteMap {
  private cache = new Map<number, number>();
  constructor(private palette: Rgb[]) {}
  index(r: number, g: number, b: number): number {
    const key = (r << 16) | (g << 8) | b;
    let best = this.cache.get(key);
    if (best !== undefined) return best;
    let bestD = Infinity;
    best = 0;
    const p = this.palette;
    for (let i = 0; i < p.length; i++) {
      const dr = p[i][0] - r;
      const dg = p[i][1] - g;
      const db = p[i][2] - b;
      const d = dr * dr + dg * dg + db * db;
      if (d < bestD) {
        bestD = d;
        best = i;
        if (!d) break;
      }
    }
    this.cache.set(key, best);
    return best;
  }
}

/**
 * Frames reduced to at most `max` colours together (one palette for all, from
 * their opaque pixels; alpha kept as it is). Frames that already use no more
 * than `max` colours come back unchanged.
 */
export function quantizeFrames(frames: { width: number; height: number; rgba: Uint8Array }[], max: number): { frames: typeof frames; palette: Rgb[]; before: number } {
  const seen = new Set<number>();
  const wu = new WuQuantizer();
  for (const f of frames) {
    for (let i = 0; i < f.rgba.length; i += 4) {
      if (!f.rgba[i + 3]) continue;
      seen.add((f.rgba[i] << 16) | (f.rgba[i + 1] << 8) | f.rgba[i + 2]);
      wu.add(f.rgba[i], f.rgba[i + 1], f.rgba[i + 2]);
    }
  }
  if (seen.size <= max) return { frames, palette: [...seen].map(c => [(c >> 16) & 255, (c >> 8) & 255, c & 255] as Rgb), before: seen.size };
  const palette = wu.palette(max).map(c => c.map(Math.round) as Rgb);
  const map = new PaletteMap(palette);
  const out = frames.map(f => {
    const rgba = f.rgba.slice();
    for (let i = 0; i < rgba.length; i += 4) {
      if (!rgba[i + 3]) continue;
      const p = palette[map.index(rgba[i], rgba[i + 1], rgba[i + 2])];
      rgba[i] = p[0];
      rgba[i + 1] = p[1];
      rgba[i + 2] = p[2];
    }
    return { width: f.width, height: f.height, rgba };
  });
  return { frames: out, palette, before: seen.size };
}
