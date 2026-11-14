// Shared test helpers (not a test file: the runner only picks up *.test.ts).

import assert from 'node:assert/strict';
import { FAST, NotIt, NotItError } from '../src/index.ts';
import type { Config, ErrorCode } from '../src/index.ts';

/** Round length used by the tests (FAST: 180 s). */
export const R = FAST.roundNs;

/** A FAST engine with genesis at 0. */
export function make(overrides: Partial<Config> = {}): NotIt {
  return new NotIt({ ...FAST, genesisNs: 0n, ...overrides });
}

/** Time `elapsedNs` into round `round`. */
export function at(round: number, elapsedNs = 0n): bigint {
  return BigInt(round) * R + elapsedNs;
}

/** Asserts that `fn` throws NotItError with exactly `code`. */
export function expectError(fn: () => unknown, code: ErrorCode): void {
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof NotItError, `expected NotItError(${code}), got ${String(e)}`);
    assert.equal(e.code, code);
    assert.ok(e.message.startsWith(code));
    return true;
  });
}

/** An engine where `ids` each claimed 1000 NOTIT in round 0. */
export function withHolders(ids: string[], overrides: Partial<Config> = {}): NotIt {
  const e = make(overrides);
  for (const id of ids) e.claim(id, 0n);
  return e;
}

/** |a − b| for bigints. */
export function absDiff(a: bigint, b: bigint): bigint {
  return a > b ? a - b : b - a;
}

/** Everything the views report at `now`, for comparing virtual and stored settlement. */
export function viewsAt(e: NotIt, ids: string[], now: bigint): unknown {
  return {
    state: e.state(now),
    accounts: ids.map((id) => e.account(id, now)),
    balances: ids.map((id) => e.balanceOf(id, now)),
    totalSupply: e.totalSupply(now),
    costAt: e.costAt(now),
    history: e.history(now),
    heroes: e.heroes(now),
  };
}
