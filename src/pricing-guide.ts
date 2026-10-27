import { Api, apiError } from "./api.js";
import { resolveApiKey, resolveApiUrl } from "./config.js";
import { CliError, EXIT } from "./errors.js";
import { printJson, type Ctx } from "./generate.js";

// `ludo pricing`: what Ludo's plans cost and include, and the rules an agent
// needs before it tells a user to pay (API, MCP and CLI need Pro or Studio,
// and there every generation costs credits). The server writes all of it
// (GET /pricing), so plans and rules change without a CLI release. Works
// logged out, and with a key on a plan that has no API access: the server
// answers those too.

interface Plan {
  name: string;
  summary?: string;
  api_access: boolean;
  credits_per_month: number | null;
  credits_at_signup: number | null;
  seats: number;
  active_projects: string;
  queue_concurrency: number;
  prices: { interval: string; amount: number; per_month?: number; credits_granted: number }[];
  included: string[];
  not_included: string[];
}

const amount = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
const money = (n: number, currency: string) => (currency.toLowerCase() === "usd" ? `$${amount(n)}` : `${amount(n)} ${currency.toUpperCase()}`);
const num = (n: number) => n.toLocaleString("en-US");

function planText(p: Plan, currency: string): string {
  const price = p.prices.length
    ? p.prices
        .map(x => (x.interval === "year" ? `${money(x.amount, currency)}/year (${money(x.per_month ?? x.amount / 12, currency)}/month)` : `${money(x.amount, currency)}/month`))
        .join(" or ")
    : "free";
  const credits = p.credits_per_month !== null ? `${num(p.credits_per_month)} credits a month` : `${num(p.credits_at_signup || 0)} credits at sign-up`;
  const lines = [
    `${p.name}: ${price}`,
    `  ${credits} · ${p.seats} seat${p.seats === 1 ? "" : "s"} · ${p.queue_concurrency} generation${p.queue_concurrency === 1 ? "" : "s"} at a time · API, MCP and CLI: ${p.api_access ? "yes" : "no"}`
  ];
  for (const s of p.included) lines.push(`  + ${s}`);
  for (const s of p.not_included) lines.push(`  - no ${s.charAt(0).toLowerCase()}${s.slice(1)}`);
  return lines.join("\n");
}

export async function pricing(ctx: Ctx): Promise<number> {
  const apiUrl = resolveApiUrl(ctx.globals.apiUrl);
  const res = await new Api(apiUrl, resolveApiKey(ctx.globals.apiKey)).request("GET", "/pricing", { timeoutMs: 15_000 });
  if (res.status === 404) {
    throw new CliError("This Ludo server has no pricing guide yet", EXIT.ERROR, "See https://ludo.ai/pricing");
  }
  if (res.status !== 200) throw apiError(res);
  const guide = res.body;
  if (ctx.jsonOut) {
    printJson(guide, false);
    return EXIT.OK;
  }
  const currency = guide.currency || "usd";
  const out = [guide.summary, "", ...guide.plans.map((p: Plan) => planText(p, currency) + "\n")];
  const top = guide.top_ups;
  if (top?.brackets?.length) {
    const brackets = top.brackets.map((b: { credits: number; cents: number }) => `${num(b.credits)} for ${money(b.cents / 100, currency)}`).join(", ");
    out.push(`Extra credits (${top.eligible}): ${num(top.min_credits)} to ${num(top.max_credits)} at a time; ${brackets}.`, "");
  }
  out.push("Good to know:");
  for (const r of guide.rules || []) out.push(`  • ${r.text}`);
  out.push("", `Each command's price: ludo <group> <command> --help. Plans: ${guide.links?.pricing}. Buy or change plan: ludo billing.`);
  process.stdout.write(out.join("\n") + "\n");
  return EXIT.OK;
}
