// `ludo toolbox image nineslice|adjacency|contrast` and `video info`, on
// inputs drawn or built here: a 9-slice panel, Wang and blob tilesets, flat
// colours, and MP4, WebM and Ogg files assembled box by box. Real encodes
// through ffmpeg are checked against ffprobe when it is installed.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { encodePng } from "../dist/tty/png.js";
import { BLOB_MASKS, contrastRatio, luminance, nineSlice, silhouetteAlike } from "../dist/toolbox/image-analysis.js";

const exec = promisify(execFile);
const CLI = path.join(import.meta.dirname, "..", "dist", "cli.js");
const FFMPEG = spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;

const ludo = async (dir, args) => {
  try {
    const { stdout } = await exec(process.execPath, [CLI, "toolbox", ...args, "--json"], { cwd: dir, env: { ...process.env, LUDO_TELEMETRY: "0", LUDO_CONFIG_DIR: path.join(dir, ".config") } });
    return { code: 0, out: JSON.parse(stdout) };
  } catch (err) {
    return { code: err.code, stderr: err.stderr, out: err.stdout ? JSON.parse(err.stdout) : undefined };
  }
};
const tmp = name => fs.mkdtempSync(path.join(os.tmpdir(), `ludo-${name}-`));
const blank = (w, h) => ({ width: w, height: h, rgba: new Uint8Array(w * h * 4) });
const put = (img, x, y, c) => img.rgba.set(c.length === 3 ? [...c, 255] : c, (y * img.width + x) * 4);
const fill = (img, x0, y0, w, h, c) => {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) put(img, x, y, c);
};

// ---- nineslice ----

// A 64x48 panel inside a 2 px transparent border: a 3 px frame, a solid
// body, and an ornament in each corner of a different size (left 10,
// right 13 wide; top 9, bottom 7 tall), so each margin is its own number.
function panel({ dashed = false } = {}) {
  const img = blank(68, 52);
  fill(img, 2, 2, 64, 48, [40, 30, 60]);
  fill(img, 5, 5, 58, 42, [230, 210, 170]);
  if (dashed) for (let x = 2; x < 66; x++) if (x % 4 < 2) for (const y of [2, 3, 4, 47, 48, 49]) put(img, x, y, [250, 200, 40]);
  const ornament = (x0, y0, w, h) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) put(img, x, y, (x + 2 * y) % 5 < 2 ? [200, 40, 40] : [90, 20, 20]);
  };
  ornament(2, 2, 10, 9); // top-left
  ornament(66 - 13, 2, 13, 9); // top-right
  ornament(2, 50 - 7, 10, 7); // bottom-left
  ornament(66 - 13, 50 - 7, 13, 7); // bottom-right
  return img;
}

test("nineslice finds each margin of a drawn panel, and the engines' settings for it", async () => {
  const s = nineSlice(panel());
  assert.deepEqual([s.horizontal.from, s.horizontal.to, s.vertical.from, s.vertical.to], [12, 52, 11, 42]);
  assert.equal(s.horizontal.period, 1);
  assert.ok(s.horizontal.confidence > 0.9 && s.vertical.confidence > 0.9, JSON.stringify(s));

  const dir = tmp("nineslice");
  fs.writeFileSync(path.join(dir, "panel.png"), encodePng(panel()));
  const r = await ludo(dir, ["image", "nineslice", "panel.png", "--overlay", "--out", dir]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.out.margins, { left: 12, right: 15, top: 11, bottom: 9 });
  assert.deepEqual(r.out.center, { fill: "solid", color: "#e6d2aa", alpha: 1 });
  assert.deepEqual(r.out.transparent_border, { left: 2, top: 2, right: 2, bottom: 2 });
  const e = r.out.exports;
  assert.deepEqual([e.godot.patch_margin_left, e.godot.patch_margin_top, e.godot.patch_margin_right, e.godot.patch_margin_bottom, e.godot.axis_stretch_horizontal], [12, 11, 15, 9, 0]);
  // Unity's Vector4 is left, bottom, right, top; CSS is top, right, bottom, left.
  assert.equal(e.unity.meta, "spriteBorder: {x: 12, y: 9, z: 15, w: 11}");
  assert.match(e.css, /border-image-slice: 11 15 9 12 fill;/);
  assert.match(e.phaser, /, width, height, 12, 15, 11, 9\)$/);
  assert.match(r.out.hint.command, /^ludo toolbox image trim panel\.png$/);
  assert.ok(fs.existsSync(path.join(dir, "panel-nineslice.png")));
});

test("nineslice: a border that repeats is a tile band, whole periods only", () => {
  const s = nineSlice(panel({ dashed: true }));
  assert.equal(s.horizontal.period, 4);
  assert.equal((s.horizontal.to - s.horizontal.from + 1) % 4, 0);
  assert.ok(s.horizontal.from >= 12 && s.horizontal.to <= 52, JSON.stringify(s.horizontal));
  assert.equal(s.vertical.period, 1);
  assert.equal(s.centre.fill, "tile");
});

test("nineslice refuses art with no band that repeats, and says why", async () => {
  // Noise: no two columns alike.
  const img = blank(48, 48);
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % 256);
  for (let y = 0; y < 48; y++) for (let x = 0; x < 48; x++) put(img, x, y, [rand(), rand(), rand()]);
  const dir = tmp("nineslice-noise");
  fs.writeFileSync(path.join(dir, "noise.png"), encodePng(img));
  const r = await ludo(dir, ["image", "nineslice", "noise.png"]);
  assert.equal(r.code, 12);
  assert.match(r.stderr, /No confident 9-slice/);
  assert.equal(r.out.error.details.horizontal.stretchable, false);
});

// ---- adjacency ----

const A = [60, 160, 70];
const B = [150, 110, 60];

function sheet(cases, cols, size, paint) {
  const img = blank(cols * size, Math.ceil(cases.length / cols) * size);
  cases.forEach((c, k) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const v = paint(c, x, y);
      if (v) put(img, (k % cols) * size + x, Math.floor(k / cols) * size + y, v);
    }
  });
  return img;
}

// Edge Wang: each pixel takes the colour of the side it is nearest.
const edgeWang = codes => sheet(codes, 4, 16, (c, x, y) => {
  const d = [y, 15 - x, 15 - y, x];
  return (c >> d.indexOf(Math.min(...d))) & 1 ? A : B;
});
// Corner Wang: each quarter takes its corner's colour (NE 1, SE 2, SW 4, NW 8).
const cornerWang = () => sheet([...Array(16).keys()], 4, 16, (c, x, y) => ((c >> (y < 8 ? (x < 8 ? 3 : 0) : x < 8 ? 2 : 1)) & 1 ? A : B));
// The blob: a 3x3 of 6 px cells, the centre always A, each neighbour cell A
// when its bit is set, else transparent.
const blob = masks => sheet(masks, 8, 18, (m, x, y) => {
  const bit = { "1,1": -1, "1,0": 1, "2,0": 2, "2,1": 4, "2,2": 8, "1,2": 16, "0,2": 32, "0,1": 64, "0,0": 128 }[`${Math.floor(x / 6)},${Math.floor(y / 6)}`];
  return bit === -1 || m & bit ? A : undefined;
});

test("adjacency names an edge Wang set and lists the cases it lacks", async () => {
  const dir = tmp("adjacency-edge");
  fs.writeFileSync(path.join(dir, "edge.png"), encodePng(edgeWang([...Array(16).keys()].filter(c => c !== 5 && c !== 10))));
  const r = await ludo(dir, ["image", "adjacency", "edge.png", "--size", "16"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.out.tiles, 14);
  assert.equal(r.out.layout.type, "wang-edge-16");
  assert.equal(r.out.layout.present, 14);
  // A is the colour of whichever side of the two is the commoner at the tiles' centres.
  const name = c => (r.out.terrains[0].color === "#3ca046" ? c : { A: "B", B: "A" }[c]);
  const missing = r.out.layout.missing_cases.map(m => [m.n, m.e, m.s, m.w].map(name).join(""));
  assert.deepEqual(missing.sort(), ["ABAB", "BABA"]);
  assert.match(r.out.hint.command, /adjacency edge\.png --size 16x16 --engine godot$/);
});

test("adjacency: a corner Wang set's rules are exactly its matching corners", async () => {
  const dir = tmp("adjacency-corner");
  fs.writeFileSync(path.join(dir, "corner.png"), encodePng(cornerWang()));
  const r = await ludo(dir, ["image", "adjacency", "corner.png", "--size", "16"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.out.layout.type, "wang-corner-16");
  assert.deepEqual(r.out.layout.missing_cases, []);
  assert.deepEqual(r.out.edge_classes, { east_west: 4, north_south: 4 });
  const bit = (c, k) => (c >> k) & 1; // NE 0, SE 1, SW 2, NW 3
  for (const rule of r.out.rules) {
    const a = rule.tile;
    const east = [...Array(16).keys()].filter(b => bit(a, 0) === bit(b, 3) && bit(a, 1) === bit(b, 2));
    const south = [...Array(16).keys()].filter(b => bit(a, 1) === bit(b, 0) && bit(a, 2) === bit(b, 3));
    assert.deepEqual(rule.east, east, `east of ${a}`);
    assert.deepEqual(rule.south, south, `south of ${a}`);
    assert.equal(rule.seamless, a === 0 || a === 15, `tile ${a}`);
  }
});

test("adjacency: the 47-tile blob, its Godot terrain set and its Tiled wangset", async () => {
  assert.equal(BLOB_MASKS.length, 47);
  const dir = tmp("adjacency-blob");
  const masks = BLOB_MASKS.filter(m => m !== 7 && m !== 255);
  fs.writeFileSync(path.join(dir, "blob.png"), encodePng(blob(masks)));
  const r = await ludo(dir, ["image", "adjacency", "blob.png", "--size", "18", "--tiled", "--engine", "godot", "--overlay", "--out", dir]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.out.layout.type, "blob-47");
  assert.deepEqual(r.out.layout.missing_cases, [{ mask: 7, joined: ["n", "ne", "e"] }, { mask: 255, joined: ["n", "ne", "e", "se", "s", "sw", "w", "nw"] }]);
  assert.equal(r.out.terrains[1].alpha, 0);
  assert.deepEqual(r.out.files, ["blob-terrain.tsx", "blob-terrain.tres"]);
  const tres = fs.readFileSync(path.join(dir, "blob-terrain.tres"), "utf8");
  assert.match(tres, /\[resource\]\ntile_size = Vector2i\(18, 18\)\nterrain_set_0\/mode = 0\nterrain_set_0\/terrain_0\/name = "A"\nterrain_set_0\/terrain_0\/color = Color\(0\.2353, 0\.6275, 0\.2745, 1\)\nsources/);
  // Tile 3 is mask 5 (north and east, not the corner): two side bits, the
  // transparent rest unset.
  const t3 = r.out.layout.tiles.find(t => t.tile === 3);
  assert.equal(t3.mask, 5);
  assert.match(tres, /\n3:0\/0 = 0\n3:0\/0\/terrain_set = 0\n3:0\/0\/terrain = 0\n3:0\/0\/terrains_peering_bit\/top_side = 0\n3:0\/0\/terrains_peering_bit\/right_side = 0\n4:0/);
  const tsx = fs.readFileSync(path.join(dir, "blob-terrain.tsx"), "utf8");
  assert.match(tsx, /<wangset name="terrain" type="mixed" tile="-1">\n   <wangcolor name="A" color="#3ca046" tile="-1" probability="1"\/>\n/);
  assert.match(tsx, /<wangtile tileid="3" wangid="1,0,1,0,0,0,0,0"\/>/);
  assert.match(tsx, /<\/wangsets>\n<\/tileset>\n$/);
  assert.ok(fs.existsSync(path.join(dir, "blob-adjacency.png")));
});

test("adjacency with one terrain finds no layout and writes no terrain set", async () => {
  const dir = tmp("adjacency-flat");
  const img = blank(32, 16);
  fill(img, 0, 0, 32, 16, A);
  fs.writeFileSync(path.join(dir, "flat.png"), encodePng(img));
  const r = await ludo(dir, ["image", "adjacency", "flat.png", "--size", "16"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.out.layout, null);
  assert.ok(r.out.rules.every(x => x.seamless && x.east.length === 2));
  assert.match(r.out.hint.command, /^ludo toolbox image tiles flat\.png --size 16x16 --tiled$/);
  const g = await ludo(dir, ["image", "adjacency", "flat.png", "--size", "16", "--engine", "godot"]);
  assert.equal(g.code, 12);
  assert.match(g.stderr, /No known autotile layout/);
});

// ---- contrast ----

test("contrast ratios are WCAG's", () => {
  assert.equal(Math.round(contrastRatio(luminance(255, 255, 255), luminance(0, 0, 0)) * 100) / 100, 21);
  // #767676 on white is the classic just-passing 4.54:1.
  assert.equal(Math.round(contrastRatio(luminance(0x76, 0x76, 0x76), luminance(255, 255, 255)) * 100) / 100, 4.54);
});

test("contrast: a grey sprite reads on black, not on a grey near its own", async () => {
  const dir = tmp("contrast");
  const sprite = blank(40, 60);
  fill(sprite, 10, 5, 20, 50, [128, 128, 128]);
  fs.writeFileSync(path.join(dir, "grey.png"), encodePng(sprite));
  // A background image: black on the left half, white on the right.
  const bg = blank(64, 64);
  fill(bg, 0, 0, 32, 64, [0, 0, 0]);
  fill(bg, 32, 0, 32, 64, [255, 255, 255]);
  fs.writeFileSync(path.join(dir, "half.png"), encodePng(bg));
  const r = await ludo(dir, ["image", "contrast", "grey.png", "--on", "#000000,#777777", "--on", "half.png", "--size", "25", "--overlay", "--out", dir]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.out.art, { width: 20, height: 50 });
  assert.deepEqual(r.out.on_screen, { width: 10, height: 25 });
  const [black, grey, half] = r.out.backgrounds;
  assert.equal(black.background, "#000000");
  assert.equal(black.median_ratio, 5.32);
  assert.equal(black.share_below, 0);
  assert.equal(black.readable, true);
  assert.equal(grey.readable, false);
  assert.equal(grey.share_below, 1);
  assert.ok(grey.worst_regions.length > 0);
  assert.equal(half.placements, 16);
  assert.equal(r.out.readable, false);
  assert.match(r.out.hint.command, /^ludo toolbox image outline grey\.png --color #(000000|ffffff)$/);
  assert.ok(fs.existsSync(path.join(dir, "grey-contrast.png")));
});

test("contrast --against: the same shape mirrored reads alike, a different one does not", async () => {
  const L = blank(30, 40);
  fill(L, 0, 0, 8, 40, [200, 50, 50]);
  fill(L, 0, 32, 30, 8, [200, 50, 50]);
  const mirrored = blank(30, 40);
  fill(mirrored, 22, 0, 8, 40, [50, 50, 200]);
  fill(mirrored, 0, 32, 30, 8, [50, 50, 200]);
  const disc = blank(40, 40);
  for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) if ((x - 19.5) ** 2 + (y - 19.5) ** 2 <= 400) put(disc, x, y, [50, 200, 50]);
  assert.deepEqual(silhouetteAlike(L, mirrored), { iou: 1, mirrored: true });
  const dir = tmp("contrast-against");
  fs.writeFileSync(path.join(dir, "l.png"), encodePng(L));
  fs.writeFileSync(path.join(dir, "m.png"), encodePng(mirrored));
  fs.writeFileSync(path.join(dir, "disc.png"), encodePng(disc));
  const r = await ludo(dir, ["image", "contrast", "l.png", "--on", "#ffffff", "--against", "m.png,disc.png"]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.out.against.map(a => [a.sprite, a.verdict, a.mirrored]), [["m.png", "alike", true], ["disc.png", "distinct", false]]);
  assert.equal(r.out.hint, undefined);
  const opaque = blank(8, 8);
  fill(opaque, 0, 0, 8, 8, A);
  fs.writeFileSync(path.join(dir, "opaque.png"), encodePng(opaque));
  const o = await ludo(dir, ["image", "contrast", "opaque.png", "--on", "#ffffff"]);
  assert.equal(o.code, 12);
  assert.match(o.stderr, /remove-background/);
});

// ---- video info ----

const u32 = v => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(v);
  return b;
};
const u16 = v => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(v);
  return b;
};
const box = (type, ...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([u32(8 + body.length), Buffer.from(type, "latin1"), body]);
};
const full = (type, version, ...parts) => box(type, Buffer.from([version, 0, 0, 0]), ...parts);

// A 2 s 30 fps 320x240 H.264 track (keyframes every 15 frames) and an AAC
// LC 44.1 kHz stereo one: just the boxes, no media data.
function mp4() {
  const frames = 60;
  const visual = Buffer.concat([Buffer.alloc(6), u16(1), Buffer.alloc(16), u16(320), u16(240), u32(0x480000), u32(0x480000), u32(0), u16(1), Buffer.alloc(32), u16(24), u16(0xffff)]);
  const avc1 = box("avc1", visual, box("avcC", Buffer.from([1, 100, 0, 31, 0xff, 0xe0])));
  const video = box(
    "trak",
    full("tkhd", 0, u32(0), u32(0), u32(1), u32(0), u32(2000), Buffer.alloc(52), u32(320 << 16), u32(240 << 16)),
    box(
      "mdia",
      full("mdhd", 0, u32(0), u32(0), u32(15360), u32(30720), u32(0)),
      full("hdlr", 0, u32(0), Buffer.from("vide"), Buffer.alloc(13)),
      box("minf", box("stbl", full("stsd", 0, u32(1), avc1), full("stts", 0, u32(1), u32(frames), u32(512)), full("stss", 0, u32(4), u32(1), u32(16), u32(31), u32(46)), full("stsz", 0, u32(0), u32(frames), Buffer.alloc(frames * 4))))
    )
  );
  // esds: ES_Descriptor > DecoderConfig (0x40, AAC) > DecoderSpecificInfo
  // 0x12 0x10: object type 2 (LC), rate index 4 (44100), 2 channels.
  const esds = full("esds", 0, Buffer.from([0x03, 0x19, 0, 1, 0, 0x04, 0x11, 0x40, 0x15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x05, 0x02, 0x12, 0x10, 0x06, 0x01, 0x02]));
  const mp4a = box("mp4a", Buffer.alloc(6), u16(1), Buffer.alloc(8), u16(2), u16(16), u16(0), u16(0), u32(44100 * 65536), esds);
  const audio = box(
    "trak",
    full("tkhd", 0, u32(0), u32(0), u32(2), u32(0), u32(2000), Buffer.alloc(60)),
    box("mdia", full("mdhd", 0, u32(0), u32(0), u32(44100), u32(88200), u32(0)), full("hdlr", 0, u32(0), Buffer.from("soun"), Buffer.alloc(13)), box("minf", box("stbl", full("stsd", 0, u32(1), mp4a), full("stts", 0, u32(1), u32(87), u32(1024)))))
  );
  const mvhd = full("mvhd", 0, u32(0), u32(0), u32(1000), u32(2000), Buffer.alloc(80));
  return Buffer.concat([box("ftyp", Buffer.from("isom"), u32(512), Buffer.from("isomiso2avc1mp41")), box("moov", mvhd, video, audio), box("mdat")]);
}

// EBML: an ID (its bytes as written) and a size (here always 8 bytes long).
const el = (id, ...parts) => {
  const body = Buffer.concat(parts.map(p => (typeof p === "number" ? Buffer.from([p]) : typeof p === "string" ? Buffer.from(p) : p)));
  const size = Buffer.alloc(8);
  size.writeBigUInt64BE(BigInt(body.length) | (1n << 56n));
  return Buffer.concat([Buffer.from(id.toString(16).padStart(id > 0xffffff ? 8 : id > 0xffff ? 6 : id > 0xff ? 4 : 2, "0"), "hex"), size, body]);
};

// An element of unknown size, as a live recording writes its Segment and
// Clusters.
const unsized = (id, ...parts) => {
  const e = el(id, ...parts);
  const head = Buffer.from(id.toString(16).padStart(8, "0"), "hex");
  return Buffer.concat([head, Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), e.subarray(head.length + 8)]);
};

// A WebM with a 64x48 VP8 track with alpha at 25 fps, 50 frames, a
// keyframe every 10, and a Vorbis track at 48 kHz mono. Live: the Segment
// and two Clusters of unknown size, and no Duration (MediaRecorder's way).
function webm({ live = false } = {}) {
  const simple = Array.from({ length: 50 }, (_, i) => {
    const b = Buffer.alloc(5);
    b[0] = 0x81;
    b.writeInt16BE(live && i >= 25 ? (i - 25) * 40 : i * 40, 1);
    b[3] = i % 10 === 0 ? 0x80 : 0;
    b[4] = 0x90; // a byte of frame: VP8 version 0
    return el(0xa3, b);
  });
  const f64 = v => {
    const b = Buffer.alloc(8);
    b.writeDoubleBE(v);
    return b;
  };
  const segment = live ? unsized : el;
  const clusters = live ? [unsized(0x1f43b675, el(0xe7, 0), ...simple.slice(0, 25)), unsized(0x1f43b675, el(0xe7, Buffer.from([0x03, 0xe8])), ...simple.slice(25))] : [el(0x1f43b675, el(0xe7, 0), ...simple)];
  return Buffer.concat([
    el(0x1a45dfa3, el(0x4282, "webm")),
    segment(
      0x18538067,
      el(0x1549a966, el(0x2ad7b1, Buffer.from([0x0f, 0x42, 0x40])), ...(live ? [] : [el(0x4489, f64(2000))])),
      el(
        0x1654ae6b,
        el(0xae, el(0xd7, 1), el(0x73c5, 7), el(0x83, 1), el(0x86, "V_VP8"), el(0xe0, el(0xb0, 64), el(0xba, 48), el(0x53c0, 1))),
        el(0xae, el(0xd7, 2), el(0x73c5, 8), el(0x83, 2), el(0x86, "A_VORBIS"), el(0xe1, el(0xb5, f64(48000)), el(0x9f, 1)))
      ),
      ...clusters
    )
  ]);
}

// Ogg Theora: the identification page (160x120 at 24 fps, granule shift 6)
// and a last page whose granule position says frame 48 (keyframe 32, 16 after).
function ogg() {
  const page = (granule, serial, body, first) => {
    const h = Buffer.alloc(27);
    h.write("OggS", 0, "latin1");
    h[5] = first ? 2 : 4;
    h.writeBigInt64LE(granule, 6);
    h.writeUInt32LE(serial, 14);
    h[26] = 1;
    return Buffer.concat([h, Buffer.from([body.length]), body]);
  };
  const id = Buffer.alloc(42);
  Buffer.from([0x80, ...Buffer.from("theora"), 3, 2, 1]).copy(id);
  id.writeUInt16BE(10, 10);
  id.writeUInt16BE(8, 12);
  id.writeUIntBE(160, 14, 3);
  id.writeUIntBE(120, 17, 3);
  id.writeUInt32BE(24, 22);
  id.writeUInt32BE(1, 26);
  id.writeUInt16BE(6 << 5, 40);
  return Buffer.concat([page(0n, 9, id, true), page((32n << 6n) | 16n, 9, Buffer.from([0]), false)]);
}

test("video info reads an MP4 box by box: codec, profile, rate, frames, keyframes, audio", async () => {
  const dir = tmp("video-mp4");
  fs.writeFileSync(path.join(dir, "clip.mp4"), mp4());
  const r = await ludo(dir, ["video", "info", "clip.mp4"]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual([r.out.file, r.out.container, r.out.brand, r.out.duration], ["clip.mp4", "mp4", "isom", 2]);
  assert.deepEqual(r.out.video, {
    codec: "h264",
    codec_tag: "avc1",
    profile: "High, level 3.1",
    width: 320,
    height: 240,
    frames: 60,
    fps: 30,
    constant_frame_rate: true,
    keyframes: 4,
    keyframe_interval: { average: 15, max: 15, seconds: 0.5 },
    alpha: false
  });
  assert.deepEqual(r.out.audio, { codec: "aac", codec_tag: "mp4a", profile: "LC", sample_rate: 44100, channels: 2 });
  assert.deepEqual(r.out.tracks, { video: 1, audio: 1, other: 0 });
  const e = r.out.engine_support;
  assert.deepEqual([e.godot.plays, e.unity.plays, e.unreal.plays, e.browsers.plays], [false, true, true, "all"]);
  assert.match(e.godot.note, /Ogg Theora/);
  assert.match(r.out.hint.command, /^ludo toolbox sprite from-video clip\.mp4$/);
});

test("video info reads WebM's EBML: VP8 with alpha, its blocks' keyframes, Vorbis", async () => {
  const dir = tmp("video-webm");
  fs.writeFileSync(path.join(dir, "clip.webm"), webm());
  const r = await ludo(dir, ["video", "info", "clip.webm"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.out.container, "webm");
  assert.equal(r.out.duration, 2);
  const v = r.out.video;
  assert.deepEqual([v.codec, v.profile, v.width, v.height, v.fps, v.frames, v.keyframes, v.keyframe_interval.average, v.alpha], ["vp8", "profile 0", 64, 48, 25, 50, 5, 10, true]);
  assert.deepEqual(r.out.audio, { codec: "vorbis", codec_tag: "A_VORBIS", sample_rate: 48000, channels: 1 });
  assert.equal(r.out.engine_support.unity.plays, true);
  assert.match(r.out.engine_support.unity.note, /alpha included/);
  assert.equal(r.out.engine_support.browsers.safari, false);

  fs.writeFileSync(path.join(dir, "live.webm"), webm({ live: true }));
  const l = await ludo(dir, ["video", "info", "live.webm"]);
  assert.equal(l.code, 0, l.stderr);
  // No Duration: the frames' span plus one frame.
  assert.deepEqual([l.out.duration, l.out.video.frames, l.out.video.keyframes, l.out.video.fps], [2, 50, 5, 25]);
});

test("video info reads Ogg Theora, the one format Godot plays", async () => {
  const dir = tmp("video-ogg");
  fs.writeFileSync(path.join(dir, "clip.ogv"), ogg());
  const r = await ludo(dir, ["video", "info", "clip.ogv"]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual([r.out.container, r.out.video.codec, r.out.video.width, r.out.video.height, r.out.video.fps, r.out.video.frames, r.out.duration], ["ogg", "theora", 160, 120, 24, 48, 2]);
  assert.equal(r.out.engine_support.godot.plays, true);
  assert.equal(r.out.engine_support.unity.plays, false);
});

test("video info refuses what is not a video", async () => {
  const dir = tmp("video-bad");
  fs.writeFileSync(path.join(dir, "x.mp4"), Buffer.from("not a video at all"));
  const r = await ludo(dir, ["video", "info", "x.mp4"]);
  assert.equal(r.code, 12);
  assert.match(r.stderr, /reads MP4, MOV, WebM/);
  assert.equal((await ludo(dir, ["video", "info", "missing.mp4"])).code, 2);
});

const ffprobe = file =>
  JSON.parse(execFileSync("ffprobe", ["-v", "error", "-count_frames", "-show_entries", "stream=codec_type,codec_name,width,height,avg_frame_rate,nb_read_frames,sample_rate,channels:stream_tags=alpha_mode", "-of", "json", file]).toString()).streams;

test("video info agrees with ffprobe on real encodes", { skip: !FFMPEG && "ffmpeg is not installed" }, async () => {
  const dir = tmp("video-real");
  const src = ["-f", "lavfi", "-i", "testsrc2=size=96x64:rate=24:duration=2"];
  const tone = ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=2"];
  const alpha = ["-f", "lavfi", "-i", "testsrc2=size=96x64:rate=24:duration=2,format=yuva420p"];
  const encodes = {
    "h264.mp4": [...src, ...tone, "-c:v", "libx264", "-g", "12", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ac", "2"],
    "frag.mp4": [...src, "-c:v", "libx264", "-g", "12", "-pix_fmt", "yuv420p", "-movflags", "+frag_keyframe+empty_moov"],
    "alpha.webm": [...alpha, ...tone, "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-g", "24", "-c:a", "libopus"],
    "prores.mov": [...alpha, "-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le"]
  };
  for (const [name, args] of Object.entries(encodes)) {
    const made = spawnSync("ffmpeg", ["-v", "error", "-y", ...args, path.join(dir, name)]);
    if (made.status !== 0) continue; // this ffmpeg lacks the encoder
    const r = await ludo(dir, ["video", "info", name]);
    assert.equal(r.code, 0, r.stderr);
    const streams = ffprobe(path.join(dir, name));
    const v = streams.find(s => s.codec_type === "video");
    const [n, d] = v.avg_frame_rate.split("/").map(Number);
    assert.deepEqual([r.out.video.codec, r.out.video.width, r.out.video.height, r.out.video.fps, r.out.video.frames], [v.codec_name, v.width, v.height, n / d, Number(v.nb_read_frames)], name);
    assert.equal(r.out.video.alpha, name !== "h264.mp4" && name !== "frag.mp4", `${name} alpha`);
    const a = streams.find(s => s.codec_type === "audio");
    if (a) assert.deepEqual([r.out.audio.codec, r.out.audio.sample_rate, r.out.audio.channels], [a.codec_name, Number(a.sample_rate), a.channels], `${name} audio`);
    else assert.equal(r.out.audio, undefined);
  }
});
