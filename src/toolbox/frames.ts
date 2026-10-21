// Frame-list edits for `ludo toolbox sprite frames`, on frame numbers alone
// (1-based, as people count them). Pure: no pixels, no files.

export interface FrameOps {
  order?: number[]; // the frames to keep, in this order (repeats allowed)
  drop?: number[];
  reverse?: boolean;
  pingpong?: boolean; // play forward, then back without repeating the ends
  hold?: Map<number, number>; // frame -> how many times it shows
}

// "1,3,5-8" -> [1, 3, 5, 6, 7, 8]; "8-5" counts down. Every number must be a
// frame of the sheet.
export function parseFrameList(spec: string, frames: number, flag: string): number[] {
  const out: number[] = [];
  for (const part of spec.split(",").map(p => p.trim())) {
    const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part);
    if (!m) throw new Error(`${flag} takes frame numbers and ranges, like 1,3,5-8 (got "${spec}")`);
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    for (const n of [a, b]) if (n < 1 || n > frames) throw new Error(`${flag}: frame ${n} does not exist; the sheet has frames 1-${frames}`);
    const step = a <= b ? 1 : -1;
    for (let n = a; n !== b + step; n += step) out.push(n);
  }
  return out;
}

// "4x3" -> frame 4 shows 3 times; several as "4x3,9x2".
export function parseHolds(spec: string, frames: number, flag: string): Map<number, number> {
  const out = new Map<number, number>();
  for (const part of spec.split(",").map(p => p.trim())) {
    const m = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(part);
    if (!m) throw new Error(`${flag} takes <frame>x<times>, like 4x3 (got "${part}")`);
    const [frame, times] = [Number(m[1]), Number(m[2])];
    if (frame < 1 || frame > frames) throw new Error(`${flag}: frame ${frame} does not exist; the sheet has frames 1-${frames}`);
    if (times < 1 || times > 100) throw new Error(`${flag}: a frame shows 1 to 100 times (got ${times})`);
    out.set(frame, times);
  }
  return out;
}

// Applied in a fixed order, whatever the order of the flags: pick (--order),
// drop, reverse, ping-pong, then hold. Frame numbers always mean the
// original sheet's frames.
export function applyFrameOps(frames: number, ops: FrameOps): number[] {
  let seq = ops.order ? [...ops.order] : Array.from({ length: frames }, (_, i) => i + 1);
  if (ops.drop) {
    const drop = new Set(ops.drop);
    seq = seq.filter(n => !drop.has(n));
  }
  if (ops.reverse) seq.reverse();
  if (ops.pingpong && seq.length > 2) seq = [...seq, ...seq.slice(1, -1).reverse()];
  if (ops.hold) seq = seq.flatMap(n => Array(ops.hold!.get(n) ?? 1).fill(n));
  return seq;
}
