// GIF block parsing and LZW decoding, vendored from omggif 1.0.10
// (GifReader and GifReaderLZWOutputIndexStream), by Dean McNamee:
// https://github.com/deanm/omggif. Compositing frames is ours (gif.ts).
//
// Changes from the original, so a broken or hostile file fails cleanly
// instead of hanging, printing or reading out of bounds:
//  - every read checks the end of the buffer, and errors are GifFormatError;
//  - a Graphic Control Extension applies to the next image only (GIF89a,
//    section 23), not to every image after it;
//  - unknown extensions (Plain Text, others) are skipped, not refused;
//  - the NETSCAPE2.0 test checks the block size is 11 (the original took any
//    other size for a loop block);
//  - the LZW decoder refuses a code beyond the next free one and a minimum
//    code size outside 1-8 (1 is out of spec, but ImageMagick and Pillow
//    read it), reports how many pixels it decoded instead of logging, keeps
//    what fits when the data runs longer than the image, and never chases a
//    prefix chain longer than the table;
//  - a file cut short in its last image keeps that image's data so far;
//  - the blit functions are not taken.
//
// (c) Dean McNamee <dean@gmail.com>, 2013.
//
// https://github.com/deanm/omggif
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to
// deal in the Software without restriction, including without limitation the
// rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
// sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
// FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
// IN THE SOFTWARE.

export class GifFormatError extends Error {}

export interface GifFrameInfo {
  x: number;
  y: number;
  width: number;
  height: number;
  has_local_palette: boolean;
  palette_offset: number | null; // null: no palette at all
  palette_size: number;
  data_offset: number;
  data_length: number;
  transparent_index: number | null;
  interlaced: boolean;
  delay: number; // centiseconds
  disposal: number;
}

export interface GifStructure {
  width: number;
  height: number;
  background: number;
  loop_count: number | null; // null: no NETSCAPE2.0 block (plays once)
  frames: GifFrameInfo[];
  complete: boolean; // false when the file ends before its trailer
}

export function parseGif(buf: Uint8Array): GifStructure {
  let p = 0;
  const byte = () => {
    if (p >= buf.length) throw new GifFormatError("the file is truncated");
    return buf[p++];
  };
  const u16 = () => byte() | (byte() << 8);

  // - Header (GIF87a or GIF89a).
  if (buf.length < 13 || buf[p++] !== 0x47 || buf[p++] !== 0x49 || buf[p++] !== 0x46 || buf[p++] !== 0x38 || ((buf[p++] + 1) & 0xfd) !== 0x38 || buf[p++] !== 0x61) {
    throw new GifFormatError("not a GIF (no GIF87a/GIF89a header)");
  }

  // - Logical Screen Descriptor.
  const width = u16();
  const height = u16();
  const pf0 = byte(); // <Packed Fields>.
  const global_palette_flag = pf0 >> 7;
  const num_global_colors_pow2 = pf0 & 0x7;
  const num_global_colors = 1 << (num_global_colors_pow2 + 1);
  const background = byte();
  byte(); // Pixel aspect ratio (unused?).

  let global_palette_offset: number | null = null;
  let global_palette_size = 0;

  if (global_palette_flag) {
    global_palette_offset = p;
    global_palette_size = num_global_colors;
    p += num_global_colors * 3; // Seek past palette.
    if (p > buf.length) throw new GifFormatError("the file is truncated");
  }

  const skipSubBlocks = () => {
    while (true) {
      const block_size = byte();
      if (block_size === 0) break; // 0 size is terminator
      p += block_size;
    }
  };

  let no_eof = true;
  let trailer = false;
  const frames: GifFrameInfo[] = [];

  let delay = 0;
  let transparent_index: number | null = null;
  let disposal = 0; // 0 - No disposal specified.
  let loop_count: number | null = null;

  while (no_eof && p < buf.length) {
    switch (byte()) {
      case 0x21: // Extension
        switch (byte()) {
          case 0xff: // Application specific block
            // Try if it's a Netscape block (with animation loop counter).
            if (
              buf[p] === 0x0b &&
              // NETSCAPE2.0
              buf[p + 1] == 0x4e && buf[p + 2] == 0x45 && buf[p + 3] == 0x54 &&
              buf[p + 4] == 0x53 && buf[p + 5] == 0x43 && buf[p + 6] == 0x41 &&
              buf[p + 7] == 0x50 && buf[p + 8] == 0x45 && buf[p + 9] == 0x32 &&
              buf[p + 10] == 0x2e && buf[p + 11] == 0x30 &&
              // Sub-block
              buf[p + 12] == 0x03 && buf[p + 13] == 0x01 && buf[p + 16] == 0
            ) {
              p += 14;
              loop_count = u16();
              p++; // Skip terminator.
            } else {
              // We don't know what it is, just try to get past it.
              skipSubBlocks();
            }
            break;

          case 0xf9: {
            // Graphics Control Extension
            if (byte() !== 0x4 || buf[p + 4] !== 0) throw new GifFormatError("bad graphic control extension");
            const pf1 = byte();
            delay = u16();
            transparent_index = byte();
            if ((pf1 & 1) === 0) transparent_index = null;
            disposal = (pf1 >> 2) & 0x7;
            p++; // Skip terminator.
            break;
          }

          default: // Comment, Plain Text and anything else: skipped.
            skipSubBlocks();
        }
        break;

      case 0x2c: {
        // Image Descriptor.
        const x = u16();
        const y = u16();
        const w = u16();
        const h = u16();
        const pf2 = byte();
        const local_palette_flag = pf2 >> 7;
        const interlace_flag = (pf2 >> 6) & 1;
        const num_local_colors_pow2 = pf2 & 0x7;
        const num_local_colors = 1 << (num_local_colors_pow2 + 1);
        let palette_offset = global_palette_offset;
        let palette_size = global_palette_size;
        let has_local_palette = false;
        if (local_palette_flag) {
          has_local_palette = true;
          palette_offset = p; // Override with local palette.
          palette_size = num_local_colors;
          p += num_local_colors * 3; // Seek past palette.
          if (p > buf.length) throw new GifFormatError("the file is truncated");
        }

        const data_offset = p;

        if (p >= buf.length) throw new GifFormatError("the file is truncated");
        p++; // codesize
        // A file cut short in its last image keeps what it has of it, as
        // browsers show it.
        let cut = false;
        try {
          skipSubBlocks();
        } catch (err) {
          if (!(err instanceof GifFormatError)) throw err;
          cut = true;
          p = buf.length;
        }
        if (p > buf.length) {
          cut = true;
          p = buf.length;
        }

        frames.push({
          x,
          y,
          width: w,
          height: h,
          has_local_palette,
          palette_offset,
          palette_size,
          data_offset,
          data_length: p - data_offset,
          transparent_index,
          interlaced: !!interlace_flag,
          delay,
          disposal
        });
        // The control block was for this image only.
        delay = 0;
        transparent_index = null;
        disposal = 0;
        if (cut) no_eof = false;
        break;
      }

      case 0x3b: // Trailer Marker (end of file).
        no_eof = false;
        trailer = true;
        break;

      default:
        throw new GifFormatError(`unknown block 0x${buf[p - 1].toString(16)}`);
    }
  }

  return { width, height, background, loop_count, frames, complete: trailer };
}

/**
 * Decodes one image's LZW data at `p` into `output` (palette indices) and
 * returns how many pixels it decoded: fewer than output.length when the data
 * stops early, which browsers show as transparent.
 */
export function lzwDecode(code_stream: Uint8Array, p: number, output: Uint8Array): number {
  const output_length = output.length;
  const at = (i: number) => (i < code_stream.length ? code_stream[i] : 0);
  const min_code_size = at(p++);
  if (min_code_size < 1 || min_code_size > 8) throw new GifFormatError(`bad LZW minimum code size ${min_code_size}`);

  const clear_code = 1 << min_code_size;
  const eoi_code = clear_code + 1;
  let next_code = eoi_code + 1;

  let cur_code_size = min_code_size + 1; // Number of bits per code.
  // NOTE: This shares the same name as the encoder, but has a different
  // meaning here.  Here this masks each code coming from the code stream.
  let code_mask = (1 << cur_code_size) - 1;
  let cur_shift = 0;
  let cur = 0;

  let op = 0; // Output pointer.

  let subblock_size = at(p++);

  const code_table = new Int32Array(4096); // Can be signed, we only use 20 bits.

  let prev_code: number | null = null; // Track code-1.

  while (true) {
    // Read up to two bytes, making sure we always 12-bits for max sized code.
    while (cur_shift < 16) {
      if (subblock_size === 0 || p >= code_stream.length) break; // No more data to be read.

      cur |= code_stream[p++] << cur_shift;
      cur_shift += 8;

      if (subblock_size === 1) {
        // Never let it get to 0 to hold logic above.
        subblock_size = at(p++); // Next subblock.
      } else {
        --subblock_size;
      }
    }

    if (cur_shift < cur_code_size) break;

    const code = cur & code_mask;
    cur >>= cur_code_size;
    cur_shift -= cur_code_size;

    if (code === clear_code) {
      // We don't actually have to clear the table.  This could be a good idea
      // for greater error checking, but we don't really do any anyway.  We
      // will just track it with next_code and overwrite old entries.

      next_code = eoi_code + 1;
      cur_code_size = min_code_size + 1;
      code_mask = (1 << cur_code_size) - 1;

      prev_code = null;
      continue;
    } else if (code === eoi_code) {
      break;
    }
    // A code not yet in the table, other than the one about to be added.
    if (code > next_code || (code === next_code && prev_code === null)) break;

    // The code table stores the prefix entry in 12 bits and then the suffix
    // byte in 8 bits, so each entry is 20 bits.

    const chase_code: number = code < next_code ? code : prev_code!;

    // Chase what we will output, either {CODE} or {CODE-1}.
    let chase_length = 0;
    let chase = chase_code;
    while (chase > clear_code) {
      chase = code_table[chase] >> 8;
      if (++chase_length > 4096) throw new GifFormatError("corrupt LZW data");
    }

    const k = chase;

    const op_end = op + chase_length + (chase_code !== code ? 1 : 0);
    if (op_end >= output_length) {
      // The stream holds more than the image: keep what fits.
      const full = new Uint8Array(chase_length + 2);
      let n = 0;
      full[n++] = k;
      let c2 = chase_code;
      const tail: number[] = [];
      for (let l = chase_length; l--; ) {
        tail.push(code_table[c2] & 0xff);
        c2 = code_table[c2] >> 8;
      }
      for (let i = tail.length - 1; i >= 0; i--) full[n++] = tail[i];
      if (chase_code !== code) full[n++] = k;
      const fit = Math.min(n, output_length - op);
      output.set(full.subarray(0, fit), op);
      return op + fit;
    }

    // Already have the first byte from the chase, might as well write it fast.
    output[op++] = k;

    op += chase_length;
    let b = op; // Track pointer, writing backwards.

    if (chase_code !== code)
      // The case of emitting {CODE-1} + k.
      output[op++] = k;

    chase = chase_code;
    while (chase_length--) {
      chase = code_table[chase];
      output[--b] = chase & 0xff; // Write backwards.
      chase >>= 8; // Pull down to the prefix code.
    }

    if (prev_code !== null && next_code < 4096) {
      code_table[next_code++] = (prev_code << 8) | k;
      // For now just check if we hit the max 12-bits (then a clear code should
      // follow, also of course encoded in 12-bits).
      if (next_code >= code_mask + 1 && cur_code_size < 12) {
        ++cur_code_size;
        code_mask = (code_mask << 1) | 1;
      }
    }

    prev_code = code;
  }

  return op;
}
