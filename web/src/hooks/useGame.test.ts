import { describe, expect, it } from 'vitest';
import { ManualClock } from '../client/clock';
import { DEMO_ACCOUNT, MockClient } from '../client/MockClient';
import type { GameClient } from '../client/types';
import { amendClose, fetchSnapshot, outcomeOfRound } from './useGame';
import type { GameSnapshot, RoundClose } from './useGame';

/** Wraps a client and counts the view calls made through it. */
function counting(inner: MockClient) {
  const calls: Record<string, number> = {};
  const wrap =
    <A extends unknown[], R>(name: string, fn: (...args: A) => R) =>
    (...args: A): R => {
      calls[name] = (calls[name] ?? 0) + 1;
      return fn(...args);
    };
  const client: GameClient = {
    getConfig: wrap('getConfig', () => inner.getConfig()),
    getState: wrap('getState', () => inner.getState()),
    getAccount: wrap('getAccount', (id: string) => inner.getAccount(id)),
    getHistory: wrap('getHistory', (from: number, limit: number) => inner.getHistory(from, limit)),
    getHistoryLen: wrap('getHistoryLen', () => inner.getHistoryLen()),
    getHeroes: wrap('getHeroes', (from: number, limit: number) => inner.getHeroes(from, limit)),
    claim: () => inner.claim(),
    volunteer: (guard) => inner.volunteer(guard),
    poke: () => inner.poke(),
    accountId: () => inner.accountId(),
  };
  const total = () => Object.values(calls).reduce((a, b) => a + b, 0);
  return { client, calls, total };
}

const START = 1_800_000_000n * 1_000_000_000n;

describe('polling', () => {
  it('fetches history and heroes only when something they depend on has changed', async () => {
    const clock = new ManualClock(START);
    const mock = new MockClient({ clock, seed: 3 });
    const { client, calls, total } = counting(mock);
    const config = await mock.getConfig();

    const first = await fetchSnapshot(client, config);
    expect(calls.getHistory).toBe(1);
    expect(calls.getHeroes).toBe(1);
    const afterFirst = total();

    // A second later, mid-round, nothing has happened: three light calls, the rest reused.
    clock.advanceNs(1_000_000_000n);
    const second = await fetchSnapshot(client, config, first);
    expect(total() - afterFirst).toBe(3);
    expect(calls.getHistory).toBe(1);
    expect(calls.getHeroes).toBe(1);
    expect(second.history).toBe(first.history);
    expect(second.heroes).toBe(first.heroes);
    expect(second.state.nowNs).toBe(first.state.nowNs + 1_000_000_000n);

    // The round closes: everything is fetched again.
    clock.advanceNs(config.roundNs);
    const third = await fetchSnapshot(client, config, second);
    expect(third.state.round).toBe(first.state.round + 1);
    expect(calls.getHistory).toBe(2);
    expect(calls.getHeroes).toBe(2);
    expect(third.slowKey).not.toBe(second.slowKey);
  });

  it('refetches when your own balance changes', async () => {
    const clock = new ManualClock(START);
    const mock = new MockClient({ clock, seed: 3 });
    const { client, calls } = counting(mock);
    const config = await mock.getConfig();
    const first = await fetchSnapshot(client, config);
    await mock.claim();
    const second = await fetchSnapshot(client, config, first);
    // After collapses the index has moved, so a claim lands a few units short of the round number.
    const balance = second.account?.balance ?? 0n;
    expect(config.claimAmount - balance >= 0n && config.claimAmount - balance < 1_000n).toBe(true);
    expect(calls.getHistory).toBe(2);
    expect(second.accountId).toBe(DEMO_ACCOUNT);
  });
});

describe('outcomeOfRound', () => {
  it('reads a round from the history', () => {
    const history = [
      { kind: 'saved' as const, round: 4, hero: 'a', cost: 5n, msLeft: 1000 },
      { kind: 'collapsed' as const, firstRound: 5, lastRound: 6, count: 2, it: 'a', paid: 9n },
      { kind: 'saved' as const, round: 8, hero: 'b', cost: 7n, msLeft: 2000 },
    ];
    expect(outcomeOfRound(history, 4)).toMatchObject({ kind: 'saved', hero: 'a' });
    expect(outcomeOfRound(history, 6)).toMatchObject({ kind: 'collapsed', it: 'a' });
    expect(outcomeOfRound(history, 7)).toMatchObject({ kind: 'dormant' });
    expect(outcomeOfRound(history, 8)).toMatchObject({ kind: 'saved', hero: 'b', msLeft: 2000 });
  });
});

describe('amendClose', () => {
  const close: RoundClose = {
    id: 1,
    round: 7,
    kind: 'collapsed',
    hero: null,
    cost: 0n,
    msLeft: 0,
    it: 'it.testnet',
    roundsClosed: 1,
    balanceBefore: 1_000n,
    balanceAfter: 1_000n, // the first poll after the close still carried the old balance
    at: 10_000,
  };
  const snap = (round: number, balance: bigint | null) =>
    ({ state: { round }, account: balance === null ? null : { balance } }) as unknown as GameSnapshot;

  it('takes a balance that moves just after a charged close as part of that close', () => {
    expect(amendClose(close, snap(8, 850n), 12_000)).toEqual({ ...close, balanceAfter: 850n });
  });

  it('leaves everything else alone', () => {
    expect(amendClose(close, snap(8, 1_000n), 12_000)).toBeNull(); // nothing moved
    expect(amendClose(close, snap(8, 850n), 30_000)).toBeNull(); // too late: some other change
    expect(amendClose(close, snap(9, 850n), 12_000)).toBeNull(); // a later round
    expect(amendClose(close, snap(8, null), 12_000)).toBeNull(); // signed out
    expect(amendClose({ ...close, balanceAfter: 850n }, snap(8, 700n), 12_000)).toBeNull(); // already had its change
    expect(amendClose({ ...close, kind: 'saved' }, snap(8, 850n), 12_000)).toBeNull(); // saved rounds charge nobody
    expect(amendClose(null, snap(8, 850n), 12_000)).toBeNull();
  });
});
