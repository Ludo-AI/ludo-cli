// Pixel art made the ways image models make it, with known answers: whole
// upscales (on and off phase, with stray pixels), canvases resampled to a
// fractional cell size, hand-drawn cells that wander, soft (filtered)
// upscales, and things that are not upscales at all. Shared by
// test/unfake.test.mjs and scripts/unfake-fixtures.mjs.
import { resizePillow } from "../dist/toolbox/resample.js";

const rng = s => () => ((s = (s * 16807) % 2147483647) / 2147483647);

// Sprite-like art: a blob of a few colours in flat runs, on transparency.
export function art(cw, ch, seed, colours = 6) {
  const r = rng(seed);
  const pal = Array.from({ length: colours }, () => [(r() * 256) | 0, (r() * 256) | 0, (r() * 256) | 0]);
  const rgba = new Uint8Array(cw * ch * 4);
  let c = pal[0];
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const dx = (x - cw / 2) / (cw / 2.4);
      const dy = (y - ch / 2) / (ch / 2.2);
      if (dx * dx + dy * dy > 1) continue;
      if (r() < 0.3) c = pal[(r() * colours) | 0];
      rgba.set([...c, 255], (y * cw + x) * 4);
    }
  }
  return { width: cw, height: ch, rgba };
}

// Cells drawn between the given pixel boundaries (cells.width + 1 of them).
export function drawn(cells, xb, yb) {
  const w = xb.at(-1);
  const h = yb.at(-1);
  const out = new Uint8Array(w * h * 4);
  for (let y = 0, cy = 0; y < h; y++) {
    while (y >= yb[cy + 1]) cy++;
    for (let x = 0, cx = 0; x < w; x++) {
      while (x >= xb[cx + 1]) cx++;
      const i = (cy * cells.width + cx) * 4;
      out.set(cells.rgba.subarray(i, i + 4), (y * w + x) * 4);
    }
  }
  return { width: w, height: h, rgba: out };
}

const lattice = (n, s, cut = 0) => [0, ...Array.from({ length: n }, (_, i) => (i + 1) * s - cut)].filter((v, i, a) => i === 0 || v > a[i - 1]);

export function corpus() {
  const out = [];
  let seed = 1;
  for (const s of [2, 3, 4, 6, 8, 12]) {
    const cells = art(48, 40, seed++);
    out.push({ name: `whole-${s}`, img: drawn(cells, lattice(48, s), lattice(40, s)), cells, scale: s });
    const cut = Math.floor(s / 2);
    out.push({ name: `whole-${s}-phase`, img: drawn(cells, lattice(48, s, cut), lattice(40, s, cut)), cells, scale: s });
  }
  // Stray pixels: 20 of an exact 4x upscale's pixels flipped (about 1%
  // of its colour changes off the grid).
  {
    const cells = art(64, 64, seed++);
    const img = drawn(cells, lattice(64, 4), lattice(64, 4));
    const r = rng(77);
    for (let k = 0; k < 20; k++) img.rgba.set([(r() * 256) | 0, 0, 0, 255], (((r() * img.width * img.height) | 0) * 4));
    out.push({ name: "whole-4-strays", img, cells, scale: 4 });
  }
  for (const [n, size] of [[100, 1024], [128, 500], [64, 400], [200, 2048]]) {
    const cells = art(n, n, seed++);
    const b = Array.from({ length: n + 1 }, (_, i) => Math.round((i * size) / n));
    out.push({ name: `resampled-${n}-to-${size}`, img: drawn(cells, b, b), cells, scale: size / n });
  }
  {
    const r = rng(99);
    const cells = art(20, 18, seed++);
    const wander = n => {
      const b = [0];
      for (let i = 0; i < n; i++) b.push(b.at(-1) + 40 + ((r() * 10) | 0));
      return b;
    };
    out.push({ name: "hand-drawn-43", img: drawn(cells, wander(20), wander(18)), cells });
  }
  for (const [s, f] of [[6, "bilinear"], [8, "bicubic"], [4, "lanczos"]]) {
    const cells = art(64, 64, seed++, 8);
    out.push({ name: `soft-${s}-${f}`, img: resizePillow(cells, 64 * s, 64 * s, f), cells, scale: s });
  }
  {
    const r = rng(7);
    const img = { width: 300, height: 300, rgba: new Uint8Array(300 * 300 * 4) };
    for (let i = 0; i < img.rgba.length; i++) img.rgba[i] = i % 4 === 3 ? 255 : (r() * 256) | 0;
    out.push({ name: "noise", img });
  }
  out.push({ name: "native-art", img: art(96, 96, seed++, 12), scale: 1 });
  return out;
}
