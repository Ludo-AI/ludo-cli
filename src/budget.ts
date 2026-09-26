import fs from "node:fs";
import path from "node:path";
import { cacheDir } from "./config.js";
import { CliError, EXIT } from "./errors.js";
import { formatCredits, type Price } from "./pricing.js";
import { stateDir, writeJsonFile, type Project } from "./project.js";

// The spending guard. Two limits, checked before anything is submitted:
//
//   --max-credits <n>   this command may spend at most n (all variations or
//                       batch items together)
//   budget              LUDO_MAX_CREDITS, else the project's max_credits: the
//                       running total of what the CLI has spent in this
//                       project (or on this machine, outside a project) may
//                       not pass it. `ludo spend` shows it, `ludo spend reset`
//                       starts a new tally.
//
// Estimates are upper bounds (see pricing.ts); the tally records what jobs
// were actually charged. A command whose price cannot be known up front is
// refused while a limit is set, unless --force.

export interface Spend {
  spent: number;
  jobs: number;
  since: string;
}

export function spendFile(project: Project | undefined): string {
  return path.join(stateDir(project, cacheDir()), "spend.json");
}

export function readSpend(project: Project | undefined): Spend {
  try {
    const s = JSON.parse(fs.readFileSync(spendFile(project), "utf8"));
    if (typeof s.spent === "number") return { spent: s.spent, jobs: s.jobs || 0, since: s.since || new Date().toISOString() };
  } catch {
    // No tally yet.
  }
  return { spent: 0, jobs: 0, since: new Date().toISOString() };
}

export function recordSpend(project: Project | undefined, credits: unknown) {
  if (typeof credits !== "number" || !(credits > 0)) return;
  const s = readSpend(project);
  writeJsonFile(spendFile(project), { ...s, spent: Math.round((s.spent + credits) * 100) / 100, jobs: s.jobs + 1 });
}

export function resetSpend(project: Project | undefined): Spend {
  const s = { spent: 0, jobs: 0, since: new Date().toISOString() };
  writeJsonFile(spendFile(project), s);
  return s;
}

export function budgetLimit(project: Project | undefined): { limit?: number; source?: string } {
  const env = process.env.LUDO_MAX_CREDITS;
  if (env !== undefined && env !== "") {
    const n = Number(env);
    if (!Number.isFinite(n) || n < 0) throw new CliError(`LUDO_MAX_CREDITS must be a number of credits (got "${env}")`, EXIT.USAGE);
    return { limit: n, source: "LUDO_MAX_CREDITS" };
  }
  if (project?.config.max_credits !== undefined) return { limit: project.config.max_credits, source: `max_credits in ${project.file}` };
  return {};
}

// Adds up the estimates of everything about to be submitted.
export function totalOf(prices: Price[]): Price {
  if (prices.some(p => p.credits === undefined)) return { exact: false, note: prices.find(p => p.credits === undefined)?.note };
  return {
    credits: Math.round(prices.reduce((sum, p) => sum + (p.credits || 0), 0) * 10) / 10,
    exact: prices.every(p => p.exact),
    note: prices.find(p => !p.exact)?.note
  };
}

export function checkBudget(project: Project | undefined, total: Price, opts: { maxCredits?: number; force: boolean }) {
  const { limit, source } = budgetLimit(project);
  if (opts.maxCredits === undefined && limit === undefined) return;
  if (total.credits === undefined) {
    if (opts.force) return;
    throw new CliError(
      `The price of this request cannot be known before it runs (${total.note || "unknown"}), and a spending limit is set.`,
      EXIT.BUDGET,
      "Check the price in the command's --help, then pass --force to run it anyway."
    );
  }
  if (opts.maxCredits !== undefined && total.credits > opts.maxCredits) {
    throw new CliError(
      `This would cost ${total.exact ? "" : "up to "}${formatCredits(total.credits)}, over --max-credits ${opts.maxCredits}.`,
      EXIT.BUDGET,
      "Raise --max-credits, or lower the duration, model or --n."
    );
  }
  if (limit !== undefined) {
    const { spent } = readSpend(project);
    if (spent + total.credits > limit) {
      throw new CliError(
        `Spending budget reached: ${formatCredits(spent)} spent of ${formatCredits(limit)} (${source}); this would cost ${total.exact ? "" : "up to "}${formatCredits(total.credits)}.`,
        EXIT.BUDGET,
        "Ask the user before spending more. They can raise the budget or start a new tally with `ludo spend reset`."
      );
    }
  }
}
