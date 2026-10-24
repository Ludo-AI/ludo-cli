WebP test files.

- Every `.webp` not starting with `made-` is from libwebp's test data,
  [webmproject/libwebp-test-data](https://github.com/webmproject/libwebp-test-data)
  at commit 06ddd96 (August 2025), except `bryce.webp` (3.5 MB) and
  `lossless_big_random_alpha.webp` (14 MB), left out for size; our decoder
  matches dwebp on those two as well. The lossy `vp80-*` files are the VP8
  conformance vectors; `lossless_vec_*` cover every combination of the VP8L
  transforms (see that repository's `lossless_vec_list.txt`). That
  repository has no licence file of its own; it is the WebM Project's test
  data for libwebp, whose BSD licence is `LICENSE-BSD` here.
- `made-*.webp` are written by `scripts/webp-corpus-make.mjs` with libwebp
  1.6's own tools (img2webp, webpmux, cwebp, gif2webp) from synthetic frames
  and from `../gif/anim-gr.gif` (image-gif's corpus, MIT): animations with
  every blend and dispose case, sub-frames, lossy frames with alpha, mixed
  lossy and lossless frames, and spritesheet-like stills.

`expected.json` is written by `scripts/webp-corpus-expected.mjs`: what dwebp
decodes each still image to (its default, "fancy" upsampling), and what
Pillow shows for each frame of an animation (libwebp's WebPAnimDecoder), with
the durations and loop count `webpmux -info` reports. dwebp and Pillow agree
on every still but `bad_palette_index.webp`: its VP8L header says it has no
alpha, so Pillow reads it as RGB and makes it opaque, while dwebp keeps the
transparent black its out-of-range palette indices decode to.
