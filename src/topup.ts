import type { Api } from "./api.js";

// `ludo topup`: extra credits for the logged-in account, with the holder's
// approval every time and never on the card saved on the account. Two ways
// to pay: a one-time Link Shared Payment Token (`--quote`, then
// `--payment-token`), charged at once with the credits in the account when
// the command returns; or a Stripe payment page for someone to pay, which the
// CLI waits on. Prices are the web app's top-up prices for the account's plan.

export interface TopupQuote {
  credits: number;
  amount: number;
  amount_minor: number;
  currency: string;
  tier?: string;
  min_credits: number;
  max_credits: number;
  step_credits: number;
  network_id?: string;
  test_mode?: boolean;
  link_cli_command?: string;
}

export interface TopupPaid {
  // "paid": the money is taken and the credits are on their way.
  status: "completed" | "paid";
  credits: number;
  amount: number;
  currency: string;
  invoice_id: string;
  extra_credits?: number;
}

export interface TopupCheckout {
  checkout_url: string;
  session_id: string;
  credits: number;
  amount: number;
  currency: string;
  expires_in: number;
}

export type TopupState =
  | { status: "open"; credits: number; checkout_url?: string }
  | { status: "paid"; credits: number; invoice_id?: string }
  | { status: "completed"; credits: number; invoice_id?: string }
  | { status: "expired"; credits: number };

export function money(amount: number, currency: string): string {
  return amount.toLocaleString("en-US", { style: "currency", currency: (currency || "usd").toUpperCase() });
}

export async function quoteTopup(api: Api, credits: number): Promise<TopupQuote> {
  return (await api.call("GET", "/cli/topup/quote", { query: { credits } })).body;
}

export async function payTopup(api: Api, credits: number, paymentToken: string): Promise<TopupPaid> {
  // One attempt only: a retried payment could charge twice.
  return (await api.call("POST", "/cli/topup/pay", { body: { credits, payment_token: paymentToken }, retry: false, timeoutMs: 300_000 })).body;
}

// `replace` ends the account's open payment page first, so two cannot both
// be paid.
export async function checkoutTopup(api: Api, credits: number, replace = false): Promise<TopupCheckout> {
  return (await api.call("POST", "/cli/topup/checkout", { body: { credits, ...(replace ? { replace: true } : {}) }, retry: false })).body;
}

export async function topupStatus(api: Api, sessionId: string): Promise<TopupState> {
  return (await api.call("GET", "/cli/topup/status", { query: { session: sessionId } })).body;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Polls a payment-page top-up until its credits are in, it expires, or the
// deadline passes (then it is still open).
export async function waitForTopup(api: Api, sessionId: string, until: number, intervalMs = 5000): Promise<TopupState> {
  for (;;) {
    const state = await topupStatus(api, sessionId);
    if (state.status === "completed" || state.status === "expired" || Date.now() >= until) return state;
    await sleep(intervalMs);
  }
}
