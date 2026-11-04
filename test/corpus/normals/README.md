Normal maps made by Sprite Fusion Sprite Normals 0.1.0
(https://github.com/hugo-dz/spritefusion-sprite-normals, commit d14b067, by
Hugo Duprez), MIT (LICENSE-MIT here), built with `cargo build --release
--locked` and run on macOS arm64. `ludo toolbox image normals` is a port of
it and must give the same bytes.

- `islands.png`, `soft.png`, `threshold.png`, `strokes.png`, `sheet.png`,
  `sheet-rows.png` and `speck.png` are synthetic sprites (separate islands,
  soft alpha, alpha 7 and 8 around the 0.03 threshold, a lone pixel, a 1 px
  line, a diagonal and art at the edge, a Ludo-stamped 3x2 sheet whose art
  fills its cells, a 3x3 sheet stamped with 6 frames so its last row is
  empty, and a 2x2 sheet whose last cell is a 3 px speck). `<name>_n.png` is
  the reference's normal map of each, with its defaults (the three sheets
  with `--frame-size 16x16`).
- `expected.json` holds, for more cases (each flag the toolbox takes, real
  sprites from `../align`, `../gif/anim-gr.gif`), the size and the sha256 of
  the reference's RGBA, RGB under transparent pixels included.

All of it is written by `scripts/normals-corpus-expected.mjs`.
