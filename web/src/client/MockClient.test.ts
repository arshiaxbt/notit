import { describe, expect, it } from 'vitest';
import { FAST } from '@notit/engine';
import { ManualClock } from './clock';
import { DEMO_ACCOUNT, MockClient } from './MockClient';
import type { HistoryEntry } from './types';

const START = 1_800_000_000n * 1_000_000_000n;
const ROUND = FAST.roundNs;

async function allHistory(client: MockClient): Promise<HistoryEntry[]> {
  const len = await client.getHistoryLen();
  const out: HistoryEntry[] = [];
  for (let from = 0; from < len; from += 100) out.push(...(await client.getHistory(from, 100)));
  return out;
}

describe('MockClient', () => {
  it('opens with a played-in history and an unclaimed "you"', async () => {
    const clock = new ManualClock(START);
    const client = new MockClient({ clock, seed: 1 });
    const state = await client.getState();
    expect(state.round).toBe(64);
    expect(state.stats.roundsSaved).toBeGreaterThan(20);
    expect(state.stats.roundsSaved + state.stats.roundsCollapsed).toBeLessThanOrEqual(63); // round 0 is empty
    expect(state.totalSupply > 0n).toBe(true);
    expect(state.it).not.toBeNull();
    const you = await client.getAccount(DEMO_ACCOUNT);
    expect(you.claimed).toBe(false);
    expect(you.balance).toBe(0n);
    expect(client.accountId()).toBe(DEMO_ACCOUNT);
  });

  it('produces both saved and collapsed rounds over a long run', async () => {
    const clock = new ManualClock(START);
    const client = new MockClient({ clock, seed: 42, warmupRounds: 0 });
    const rounds = 600;
    // Step in thirds of a round, the way a polling UI would.
    for (let i = 0; i < rounds * 3; i++) {
      clock.advanceNs(ROUND / 3n);
      await client.getState();
    }
    const state = await client.getState();
    const { roundsSaved, roundsCollapsed } = state.stats;
    expect(roundsSaved + roundsCollapsed).toBeGreaterThanOrEqual(rounds - 20);
    expect(roundsSaved).toBeGreaterThan(0);
    expect(roundsCollapsed).toBeGreaterThan(0);
    // The crowd should save most rounds but clearly not all of them.
    const rate = roundsSaved / (roundsSaved + roundsCollapsed);
    expect(rate).toBeGreaterThan(0.6);
    expect(rate).toBeLessThan(0.97);
    // The demo keeps going: there is still a supply and somebody is It.
    expect(state.totalSupply > 0n).toBe(true);
    expect(state.it).not.toBeNull();
    expect(state.stats.totalBurned > 0n).toBe(true);
    expect(state.stats.totalPaid > 0n).toBe(true);

    const history = await allHistory(client);
    expect(history.some((e) => e.kind === 'saved')).toBe(true);
    const collapses = history.filter((e) => e.kind === 'collapsed');
    expect(collapses.length).toBeGreaterThan(0);
    // Every collapse paid somebody, and never charged more than 8 rounds in a row.
    for (const e of collapses) {
      if (e.kind !== 'collapsed') continue;
      expect(e.paid > 0n).toBe(true);
      expect(e.count).toBeLessThanOrEqual(8);
    }
    // Somebody who was It has collected.
    expect((await client.getHeroes(0, 100)).some((h) => h.collected > 0n)).toBe(true);
    // More than one strategy ends up on the hero wall.
    const heroes = await client.getHeroes(0, 100);
    expect(heroes.length).toBeGreaterThan(3);
    expect(state.stats.longestStreak).toBeGreaterThan(3);
  });

  it('gives the same history whether polled often or all at once', async () => {
    const a = new ManualClock(START);
    const b = new ManualClock(START);
    const often = new MockClient({ clock: a, seed: 7, warmupRounds: 0 });
    const once = new MockClient({ clock: b, seed: 7, warmupRounds: 0 });
    for (let i = 0; i < 50 * 10; i++) {
      a.advanceNs(ROUND / 10n);
      await often.getState();
    }
    b.advanceNs(ROUND * 50n);
    expect(await allHistory(once)).toEqual(await allHistory(often));
    expect((await once.getState()).index).toBe((await often.getState()).index);
  });

  it('lets you claim once, volunteer with a guard, and become It', async () => {
    const clock = new ManualClock(START);
    const client = new MockClient({ clock, seed: 3, crowd: [] });
    const guardNow = async () => {
      const st = await client.getState();
      return { round: st.round, maxCost: st.costNow + st.costNow / 50n + 1n };
    };
    // With no crowd there is no supply yet.
    expect((await client.volunteer(await guardNow())).ok).toBe(false);

    expect((await client.claim()).ok).toBe(true);
    const again = await client.claim();
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.code).toBe('ERR_ALREADY_CLAIMED');
    const before = await client.getAccount(DEMO_ACCOUNT);
    expect(before.balance).toBe(FAST.claimAmount);
    expect(before.isIt).toBe(false);

    // The claim counts from the next round. Nobody is It yet, so nothing is charged.
    clock.advanceNs(ROUND);
    const st = await client.getState();
    expect(st.roundSupply).toBe(FAST.claimAmount);
    expect(st.costNow > 0n).toBe(true);
    expect(st.it).toBeNull();
    expect(st.armed).toBe(false);

    // A stale guard is refused and burns nothing.
    const stale = await client.volunteer({ round: st.round - 1, maxCost: st.costNow });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.code).toBe('ERR_WRONG_ROUND');
    const tooLow = await client.volunteer({ round: st.round, maxCost: st.costNow / 2n });
    expect(tooLow.ok).toBe(false);
    if (!tooLow.ok) expect(tooLow.code).toBe('ERR_COST_TOO_HIGH');
    expect((await client.getAccount(DEMO_ACCOUNT)).balance).toBe(before.balance);

    const res = await client.volunteer(await guardNow());
    expect(res.ok).toBe(true);
    const saved = await client.getState();
    expect(saved.saved).toBe(true);
    expect(saved.hero).toBe(DEMO_ACCOUNT);
    expect(saved.it).toBe(DEMO_ACCOUNT);
    expect(saved.costNow).toBe(0n);
    const after = await client.getAccount(DEMO_ACCOUNT);
    expect(after.saves).toBe(1);
    expect(after.isIt).toBe(true);
    if (res.ok) expect(before.balance - after.balance).toBe(res.cost);

    const second = await client.volunteer(await guardNow());
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe('ERR_ALREADY_SAVED');

    // A saved round pays nobody: the balance is unchanged when it closes.
    clock.advanceNs(ROUND);
    expect((await client.getAccount(DEMO_ACCOUNT)).balance).toBe(after.balance);
    expect((await client.getState()).armed).toBe(true);
  });

  it('runs the clock faster when the round is shortened', () => {
    const client = new MockClient({ seed: 5 });
    expect(client.roundSeconds()).toBe(30);
    expect(client.timeScale()).toBe(6);
    client.setRoundSeconds(10);
    expect(client.timeScale()).toBe(18);
    client.setRoundSeconds(180);
    expect(client.timeScale()).toBe(1);
  });

  it('lists the crowd with named strategies', () => {
    const client = new MockClient({ clock: new ManualClock(START), seed: 9 });
    const crowd = client.crowd();
    expect(crowd.length).toBeGreaterThan(8);
    expect(new Set(crowd.map((c) => c.strategy)).size).toBeGreaterThan(4);
    expect(crowd.every((c) => c.balance > 0n)).toBe(true);
    expect(crowd.filter((c) => c.isIt).length).toBeLessThanOrEqual(1);
  });
});
