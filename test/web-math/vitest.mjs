// The slice of vitest's API that the web app's math tests use, on node:test,
// so they run here unchanged except for their import lines.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

export { describe, it };

// vitest's toEqual ignores properties that are undefined.
const defined = v =>
  Array.isArray(v) ? v.map(defined) : v && typeof v === "object" && v.constructor === Object ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, defined(x)])) : v;

function matches(actual, expected) {
  if (expected && typeof expected === "object") {
    if (!actual || typeof actual !== "object") return false;
    if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((e, i) => matches(actual[i], e));
    return Object.keys(expected).every(k => matches(actual[k], expected[k]));
  }
  return Object.is(actual, expected);
}

export function expect(actual) {
  const checks = negate => {
    const check = (ok, message) => assert.ok(negate ? !ok : ok, `${negate ? "not " : ""}${message}`);
    const fmt = v => JSON.stringify(v);
    return {
      toBe: e => check(Object.is(actual, e), `expected ${fmt(actual)} to be ${fmt(e)}`),
      toEqual: e => {
        let ok = true;
        try {
          assert.deepStrictEqual(defined(actual), defined(e));
        } catch {
          ok = false;
        }
        check(ok, `expected ${fmt(actual)} to equal ${fmt(e)}`);
      },
      toMatchObject: e => check(matches(actual, e), `expected ${fmt(actual)} to match ${fmt(e)}`),
      toBeCloseTo: (e, digits = 2) => check(Math.abs(actual - e) < 10 ** -digits / 2, `expected ${actual} to be close to ${e}`),
      toBeGreaterThan: e => check(actual > e, `expected ${actual} > ${e}`),
      toBeGreaterThanOrEqual: e => check(actual >= e, `expected ${actual} >= ${e}`),
      toBeLessThan: e => check(actual < e, `expected ${actual} < ${e}`),
      toBeLessThanOrEqual: e => check(actual <= e, `expected ${actual} <= ${e}`)
    };
  };
  return { ...checks(false), not: checks(true) };
}
