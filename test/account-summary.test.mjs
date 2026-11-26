import { test } from "node:test";
import assert from "node:assert/strict";
import { accountSummary } from "../dist/login.js";
import { apiError } from "../dist/api.js";

const OWN = {
  credits: { available: 1840.5, plan_credits: 2000, used: 460, extra: 300.5, resets_at: 1790000000, team_pool: false, paused: false, grace_until: null },
  plan: { name: "Studio", api_access: true },
  auto_topup: { enabled: true, threshold: 200, credits: 1000 },
  billing_url: "http://web.test/account/billing"
};

// A team member: the server sends billing_url for every account, but the top-up
// endpoints refuse members, so the summary must not offer them.
const MEMBER = { ...OWN, credits: { ...OWN.credits, team_pool: true }, auto_topup: null };

test("an account of its own is offered ludo topup and the billing page", () => {
  const text = accountSummary(OWN);
  assert.match(text, /Buy credits: `ludo topup --credits <n>`/);
  assert.match(text, /Change plan or auto top-up: http:\/\/web\.test\/account\/billing/);
  assert.doesNotMatch(text, /team owner/);
});

test("a team member is pointed at the team owner, not at ludo topup", () => {
  const text = accountSummary(MEMBER);
  assert.match(text, /\(team pool\)/);
  assert.match(text, /Auto top-up: managed by your team owner/);
  assert.match(text, /Credits are bought by your team owner/);
  assert.doesNotMatch(text, /ludo topup/);
  assert.doesNotMatch(text, /Change plan or auto top-up/);
});

test("the out-of-credits hint names the team owner case", () => {
  const err = apiError({ status: 402, body: { message: "You're on a roll!" } });
  assert.match(err.hint, /ludo topup/);
  assert.match(err.hint, /team owner/);
});
