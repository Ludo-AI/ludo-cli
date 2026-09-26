import type { Command } from "./commands.js";

// What a generation will cost, worked out before it is submitted, from the
// pricing the spec publishes for each operation (x-credit-description):
//
//   "consumes 0.5 credits per result"   x the request's n
//   "consumes 3 credits per call"       flat
//   "Available models: Hydra (3 credits/s, shortest duration 3s, so 9 credits
//    minimum; 3s = 9, ...) · Forge (1.5 credits/s, minimum charge 4 credits
//    per generation; ...)"             per model and second
//
// Duration-priced jobs are charged max(rate x produced seconds, minimum),
// never more than for the duration requested, so the estimate is the most the
// job can cost. When the duration comes from a source file (edits, upscales)
// the longest duration the table lists stands in. `credits` is undefined when
// the price cannot be known up front.

export interface Price {
  credits?: number;
  // True when this is the price, false when it is an upper bound.
  exact: boolean;
  note?: string;
}

interface ModelRate {
  id: string;
  rate: number;
  minimum: number;
  shortest: number;
  longest: number;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

// "Eagle with Audio" -> eagle-audio, "Griffin HD" -> griffin-hd.
const modelId = (name: string) => name.trim().toLowerCase().replace(/\s+with\s+/g, "-").replace(/\s+/g, "-");

export function parseModelRates(text: string): ModelRate[] {
  const listed = text.split(/Available models:\s*/)[1];
  if (!listed) return [];
  const rates: ModelRate[] = [];
  for (const part of listed.split(" · ")) {
    const m = /^(.+?) \(([\d.]+) credits\/s(?:, shortest duration ([\d.]+)s, so ([\d.]+) credits minimum|, minimum charge ([\d.]+) credits? per generation)?(?:; ([^)]*))?\)/.exec(part.trim());
    if (!m) continue;
    const seconds = [...(m[6] || "").matchAll(/([\d.]+)s = /g)].map(x => Number(x[1]));
    rates.push({
      id: modelId(m[1]),
      rate: Number(m[2]),
      minimum: Number(m[4] || m[5] || 0),
      shortest: Number(m[3] || 0),
      longest: seconds.length ? Math.max(...seconds) : 0
    });
  }
  return rates;
}

function fieldDefault(command: Command, name: string): unknown {
  return command.fields.find(f => f.name === name)?.default;
}

export function estimatePrice(command: Command, body: Record<string, unknown>): Price {
  const text = command.creditDetail || command.credits || "";
  if (!text) return { credits: 0, exact: true };

  const perResult = /consumes ([\d.]+) credits? per result/i.exec(text);
  if (perResult) {
    const n = Number(body.n ?? fieldDefault(command, "n") ?? 1) || 1;
    return { credits: round1(Number(perResult[1]) * n), exact: true };
  }
  const perCall = /consumes ([\d.]+) credits? per call/i.exec(text);
  if (perCall) return { credits: Number(perCall[1]), exact: true };

  const rates = parseModelRates(text);
  const requested = typeof body.duration === "number" ? body.duration : (fieldDefault(command, "duration") as number | undefined);
  const longest = Math.max(0, ...rates.map(r => r.longest));

  // editSpritesheet's loop fixes and outpaints: flat per second, model ignored.
  const flat = /edit_mode "fix_loop" \/ "outpaint": flat ([\d.]+) credits? per second/i.exec(text);
  const mode = body.edit_mode ?? fieldDefault(command, "edit_mode");
  if (flat && (mode === "fix_loop" || mode === "outpaint")) {
    const seconds = requested ?? longest;
    if (!seconds) return { exact: false, note: "the price depends on the source's duration" };
    return { credits: round1(Number(flat[1]) * seconds), exact: requested !== undefined, note: requested === undefined ? "at most, for the longest duration" : undefined };
  }

  if (rates.length) {
    const model = String(body.model ?? fieldDefault(command, "model") ?? "");
    const known = rates.find(r => r.id === model);
    // An unlisted model (an alias, a new one) is priced as the dearest listed.
    const candidates = known ? [known] : rates;
    const priceFor = (r: ModelRate) => {
      const seconds = Math.max(requested ?? (r.longest || longest), r.shortest);
      return round1(Math.max(r.rate * seconds, r.minimum));
    };
    const credits = Math.max(...candidates.map(priceFor));
    const notes = [!known && "the model's price is not listed, so the dearest model's price is used", requested === undefined && "for the longest duration"].filter(Boolean);
    return { credits, exact: false, note: notes.length ? `at most (${notes.join("; ")})` : "at most" };
  }

  return { exact: false, note: "the price depends on the source file (see the command's --help)" };
}

export function formatCredits(n: number): string {
  return `${n.toLocaleString("en-US", { maximumFractionDigits: 2 })} credit${n === 1 ? "" : "s"}`;
}
