import type { Image } from "../tty/png.js";

// A colour key: pixels close enough to one colour become transparent, either
// the region of them connected to the image's edges (the background, not the
// same colour inside the sprite) or every one of them.
//
// "Close enough" is ImageMagick's -fuzz against a given colour
// (MagickCore/pixel.c IsFuzzyEquivalencePixelInfo, 7.1.2, as `-fuzz F
// -transparent colour` uses it): with f the fuzz as a share of full scale,
// a pixel matches the key when 3·Δa² + s·(Δr² + Δg² + Δb²) <= 3·f², where s
// is the product of their alphas (so a fully transparent pixel matches a
// transparent key whatever its colour). The connected region is what
// ImageMagick's floodfill (`-draw "color x,y floodfill"`, Heckbert's
// scanline seed fill) selects, the 4-connected matching pixels around each
// seed; here the seeds are every matching pixel on the border. (Its
// floodfill gives the seed colour a fuzz of its own too, so it takes what
// this takes at √2 times the fuzz.) test/toolbox.test.mjs checks both
// against ImageMagick.

export type Rgba = [number, number, number, number];

export function fuzzyMatch(fuzz: number): (px: Uint8Array, i: number, key: Rgba) => boolean {
  const f = fuzz * 255;
  const limit = 3 * f * f;
  return (px, i, key) => {
    const da = px[i + 3] - key[3];
    let d = 3 * da * da;
    if (d > limit) return false;
    const s = (px[i + 3] / 255) * (key[3] / 255);
    if (s <= Number.EPSILON) return true;
    const dr = px[i] - key[0];
    const dg = px[i + 1] - key[1];
    const db = px[i + 2] - key[2];
    d += s * (dr * dr + dg * dg + db * db);
    return d <= limit;
  };
}

// The most common opaque colour on the border, if the border is mostly
// opaque (a background to take away).
export function borderColour(img: Image): Rgba | undefined {
  const { width: w, height: h, rgba } = img;
  const counts = new Map<number, number>();
  let n = 0;
  const tally = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    n++;
    if (rgba[i + 3] < 255) return;
    const k = (rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2];
    counts.set(k, (counts.get(k) ?? 0) + 1);
  };
  for (let x = 0; x < w; x++) {
    tally(x, 0);
    if (h > 1) tally(x, h - 1);
  }
  for (let y = 1; y < h - 1; y++) {
    tally(0, y);
    if (w > 1) tally(w - 1, y);
  }
  let best = -1;
  let bestN = 0;
  for (const [k, c] of counts) {
    if (c > bestN) {
      bestN = c;
      best = k;
    }
  }
  return bestN * 2 > n ? [(best >> 16) & 255, (best >> 8) & 255, best & 255, 255] : undefined;
}

// Which pixels the key takes: 1 for taken. `edges`: those 4-connected to a
// matching border pixel; else every matching pixel.
export function keyMask(img: Image, key: Rgba, fuzz: number, edges: boolean): Uint8Array {
  const { width: w, height: h, rgba } = img;
  const match = fuzzyMatch(fuzz);
  const mask = new Uint8Array(w * h);
  if (!edges) {
    for (let p = 0; p < w * h; p++) if (match(rgba, p * 4, key)) mask[p] = 1;
    return mask;
  }
  const stack: number[] = [];
  const seed = (x: number, y: number) => {
    const p = y * w + x;
    if (!mask[p] && match(rgba, p * 4, key)) {
      mask[p] = 1;
      stack.push(p);
    }
  };
  for (let x = 0; x < w; x++) {
    seed(x, 0);
    seed(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    seed(0, y);
    seed(w - 1, y);
  }
  while (stack.length) {
    const p = stack.pop()!;
    const x = p % w;
    const y = (p - x) / w;
    if (x > 0) seed(x - 1, y);
    if (x < w - 1) seed(x + 1, y);
    if (y > 0) seed(x, y - 1);
    if (y < h - 1) seed(x, y + 1);
  }
  return mask;
}

export function applyKey(img: Image, mask: Uint8Array): Image {
  const rgba = img.rgba.slice();
  for (let p = 0; p < mask.length; p++) if (mask[p]) rgba.fill(0, p * 4, p * 4 + 4);
  return { width: img.width, height: img.height, rgba };
}
