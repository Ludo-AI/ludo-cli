import { Api } from "./api.js";
import { VERSION } from "./config.js";
import { CliError, EXIT } from "./errors.js";
import { openBrowser } from "./login.js";

// `ludo signup`: creates an account and subscribes it to a plan in one
// payment, with no web login. The API hands out a Stripe-hosted checkout link
// for an email and a plan, and a secret device_code. Whoever pays the link
// (the person, or an agent with a wallet of its own) creates the account, and
// Ludo emails that address a connect code. The key is issued only to a caller
// holding both: the device_code kept here, and the code from the mailbox. So
// starting a signup for someone else's address yields nothing.

export interface SignupStart {
  device_code: string;
  checkout_url: string;
  email: string;
  plan: { id: string; name: string; interval: string; amount: number; currency: string };
  expires_in: number;
  code_expires_in?: number;
  interval: number;
}

export interface SignupRequest {
  email: string;
  plan: string;
  interval?: string;
  name?: string;
}

// Where a signup is, as one poll reports it.
export type SignupState =
  | { status: "pending" }
  | { status: "code_required"; email_hint?: string }
  | { status: "code_wrong"; attempts_left?: number; message?: string }
  | { status: "completed"; api_key: string; email?: string; plan_name?: string }
  | { status: "failed"; message?: string }
  | { status: "expired" };

// An error the server gave as its final word on this signup: the pending
// entry is no use any more and may be forgotten. Anything else (network, a
// proxy's 403, a deploy's 404, a rate limit) leaves it to be continued.
export function finalError(message: string, exitCode: number, hint?: string): CliError {
  return new CliError(message, exitCode, hint, { signupFinal: true });
}

export function isFinal(err: unknown): boolean {
  return err instanceof CliError && !!(err.details as { signupFinal?: boolean } | undefined)?.signupFinal;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export function priceLine(plan: SignupStart["plan"]): string {
  const amount = plan.amount.toLocaleString("en-US", { style: "currency", currency: (plan.currency || "usd").toUpperCase() });
  return `${plan.name} plan, ${amount} per ${plan.interval}`;
}

export async function startSignup(apiUrl: string, request: SignupRequest): Promise<SignupStart> {
  const { body } = await new Api(apiUrl, undefined).call("POST", "/cli/signup/start", {
    body: { ...request, platform: process.platform, client_version: VERSION }
  });
  return body;
}

// --- paying with a Link token (`--quote`, `--payment-token`) ---
//
// The browserless way: the account holder approves a spend for Ludo in Link
// (Stripe's agent wallet), Link gives the agent a Shared Payment Token
// (spt_...), and Ludo charges it directly. The key comes back in the same
// response: whoever presents a token that pays is the payer, so there is no
// emailed code to wait for. A recurring token pays the renewals too.

export interface SignupQuote {
  plan: SignupStart["plan"];
  amount_minor: number;
  network_id: string;
  test_mode: boolean;
  link_cli_command: string;
  steps: string[];
}

export interface SignupPaid {
  status: "completed";
  api_key: string;
  email: string;
  plan_name?: string;
  plan?: SignupStart["plan"];
  renews: boolean;
  period_end?: number;
  message?: string;
}

export async function quoteSignup(apiUrl: string, plan: string, interval?: string, email?: string): Promise<SignupQuote> {
  const { body } = await new Api(apiUrl, undefined).call("GET", "/cli/signup/quote", {
    query: { plan, ...(interval ? { interval } : {}), ...(email ? { email } : {}) }
  });
  return body;
}

export async function paySignup(apiUrl: string, request: SignupRequest & { payment_token: string }): Promise<SignupPaid> {
  // One attempt only: a retried payment could charge twice.
  const { body } = await new Api(apiUrl, undefined).call("POST", "/cli/signup/pay", {
    body: { ...request, platform: process.platform, client_version: VERSION },
    retry: false,
    // The server makes several Stripe calls, each retried; never give up on
    // a payment before it has answered.
    timeoutMs: 300_000
  });
  return body;
}

// One poll. `code` is the connect code from the email, when there is one to try.
export async function pollSignup(apiUrl: string, deviceCode: string, code?: string): Promise<SignupState> {
  const res = await new Api(apiUrl, undefined).request("POST", "/cli/signup/token", {
    body: { device_code: deviceCode, ...(code ? { code } : {}) }
  });
  if (res.status === 429) throw new CliError("Too many signup checks from this network", EXIT.RATE_LIMITED, "Wait a few minutes, then run `ludo signup --continue`.");
  const known = ["pending", "code_required", "code_wrong", "completed", "failed", "expired"];
  if (res.status >= 200 && res.status < 300 && res.body && typeof res.body === "object" && known.includes(res.body.status)) {
    return res.body as SignupState;
  }
  // Not an answer about this signup: keep it and let the person try again.
  throw new CliError(
    (res.body && typeof res.body === "object" && res.body.message) || `Could not check the signup (HTTP ${res.status})`,
    EXIT.ERROR,
    "Run `ludo signup --continue` to try again."
  );
}

// Polls while the checkout is unpaid. Resolves with the first state that is
// not "pending", or "pending" when the link's time ran out.
export async function waitForPayment(apiUrl: string, pending: { device_code: string; expires_at: number; interval?: number }): Promise<SignupState> {
  const baseInterval = Math.max(0.01, pending.interval || 5) * 1000;
  let interval = baseInterval;
  let failures = 0;
  // One poll even when the link has just expired: the payment may have landed
  // in its last seconds.
  for (;;) {
    let state: SignupState | undefined;
    try {
      state = await pollSignup(apiUrl, pending.device_code);
      failures = 0;
      interval = baseInterval;
    } catch (err) {
      // Wi-Fi handoff, sleep, a deploy, a rate limit: whoever is paying is
      // still on Stripe's page, and the signup waits for us.
      if (++failures >= 20) throw err;
      interval = Math.min(interval * 2, 15_000);
    }
    if (state && state.status !== "pending") return state;
    if (Date.now() >= pending.expires_at) return { status: "pending" };
    await sleep(interval);
  }
}

export function showCheckout(started: SignupStart, opts: { log: (msg: string) => void; openBrowser: boolean }): void {
  opts.log(`Creating a Ludo account for ${started.email}: ${priceLine(started.plan)}.`);
  opts.log("Pay on this Stripe page to create the account:");
  opts.log(`\n  ${started.checkout_url}\n`);
  opts.log(`The link works for ${Math.round(started.expires_in / 60)} minutes. Nothing is created or charged until it is paid.`);
  opts.log(`Once paid, we email ${started.email} a code that connects this CLI.`);
  if (opts.openBrowser && openBrowser(started.checkout_url)) opts.log("Opened it in your browser.");
}
