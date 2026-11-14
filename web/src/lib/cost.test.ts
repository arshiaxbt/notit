import { describe, expect, it } from 'vitest';
import { FAST, LIVE, NotIt } from '@notit/engine';
import { costAt, itCollects, maxCostFor, msLeftAt, outcomesFor, ratePpmAt } from './cost';

const GENESIS = 1_700_000_000n * 1_000_000_000n;

describe('local cost interpolation', () => {
  for (const [name, params] of [
    ['fast', FAST],
    ['live', LIVE],
  ] as const) {
    it(`matches the engine's costAt across a round (${name})`, () => {
      const engine = new NotIt({ ...params, genesisNs: GENESIS });
      for (const who of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) engine.claim(who, GENESIS);
      const roundNs = params.roundNs;

      // Someone volunteers in round 1 (the burn makes the supply an odd number),
      // then round 2 goes unsaved, so round 3 opens after a charged collapse.
      engine.volunteer('a', GENESIS + roundNs + roundNs / 7n);
      const start = GENESIS + 3n * roundNs;
      const st = engine.state(start);
      expect(st.round).toBe(3);
      expect(st.roundSupply > 0n).toBe(true);

      const fractions = [0n, 1n, 137n, 2_500n, 3_333n, 5_000n, 7_777n, 9_000n, 9_990n, 9_999n];
      for (const f of fractions) {
        const now = start + (roundNs * f) / 10_000n;
        expect(costAt(params, st.roundSupply, st.roundStartNs, now)).toBe(engine.costAt(now));
        expect(costAt(params, st.roundSupply, st.roundStartNs, now)).toBe(engine.state(now).costNow);
      }
      // First and last nanosecond of the round.
      expect(costAt(params, st.roundSupply, start, start)).toBe(engine.costAt(start));
      const last = start + roundNs - 1n;
      expect(costAt(params, st.roundSupply, start, last)).toBe(engine.costAt(last));
    });
  }

  it('falls from the max rate to just above the min rate', () => {
    const start = GENESIS;
    expect(ratePpmAt(FAST, start, start)).toBe(50_000n);
    expect(ratePpmAt(FAST, start, start + FAST.roundNs / 2n)).toBe(26_000n);
    expect(ratePpmAt(FAST, start, start + FAST.roundNs - 1n)).toBe(2_001n);
    // Clamped outside the round, so a late frame never shows a negative rate.
    expect(ratePpmAt(FAST, start, start + FAST.roundNs * 2n)).toBe(2_001n);
    expect(ratePpmAt(FAST, start, start - 5n)).toBe(50_000n);
  });

  it('never goes below one unit, and is zero with nothing to save', () => {
    expect(costAt(FAST, 10n, GENESIS, GENESIS + FAST.roundNs - 1n)).toBe(1n);
    expect(costAt(FAST, 0n, GENESIS, GENESIS)).toBe(0n);
  });

  it('charges exactly what the UI showed when you volunteer', () => {
    const engine = new NotIt({ ...FAST, genesisNs: GENESIS });
    for (const who of ['a', 'b', 'c']) engine.claim(who, GENESIS);
    const start = GENESIS + FAST.roundNs;
    const now = start + (FAST.roundNs * 2n) / 3n;
    const st = engine.state(now);
    const shown = costAt(FAST, st.roundSupply, st.roundStartNs, now);
    const { cost, msLeft } = engine.volunteer('a', now);
    expect(cost).toBe(shown);
    expect(msLeft).toBe(msLeftAt(st.roundEndNs, now));
  });
});

describe('outcomes', () => {
  const U = 10n ** 18n;
  it('projects the three endings', () => {
    const o = outcomesFor(1_000n * U, 100n * U, FAST.cutPpm);
    expect(o.keep).toBe(1_000n * U);
    expect(o.ifCollapsed).toBe(850n * U);
    expect(o.cutAmount).toBe(150n * U);
    expect(o.ifYouDoIt).toBe(900n * U);
  });
  it('says so when you cannot afford it', () => {
    expect(outcomesFor(50n * U, 100n * U, FAST.cutPpm).ifYouDoIt).toBeNull();
  });

  it('matches what the engine pays It after an unsaved round', () => {
    const engine = new NotIt({ ...FAST, genesisNs: GENESIS });
    for (const who of ['a', 'b', 'c', 'd']) engine.claim(who, GENESIS);
    const r1 = GENESIS + FAST.roundNs;
    engine.volunteer('a', r1 + FAST.roundNs / 2n); // a is It
    const r2 = r1 + FAST.roundNs;
    const before = engine.state(r2);
    const itBefore = engine.balanceOf('a', r2);
    const bBefore = engine.balanceOf('b', r2);
    expect(before.it).toBe('a');
    expect(before.armed).toBe(true);
    const predicted = itCollects(before.totalSupply, itBefore, FAST.cutPpm);
    const predictedB = outcomesFor(bBefore, 0n, FAST.cutPpm).ifCollapsed;

    const r3 = r2 + FAST.roundNs; // round 2 closed unsaved
    const gained = engine.balanceOf('a', r3) - itBefore;
    const diff = gained > predicted ? gained - predicted : predicted - gained;
    expect(diff < 1_000n).toBe(true); // equal up to rounding dust
    const bAfter = engine.balanceOf('b', r3);
    const diffB = bAfter > predictedB ? bAfter - predictedB : predictedB - bAfter;
    expect(diffB < 1_000n).toBe(true);
    // A collapse moves value; it does not create or destroy it.
    const supplyDiff = before.totalSupply - engine.totalSupply(r3);
    expect(supplyDiff >= 0n && supplyDiff < 1_000n).toBe(true);
  });
});

describe('volunteer guard', () => {
  it('allows the cost on screen plus two percent', () => {
    expect(maxCostFor(1_000n)).toBe(1_021n);
    expect(maxCostFor(0n)).toBe(1n);
  });
  it('lets a slightly later call through and stops a call in the next round', () => {
    const engine = new NotIt({ ...FAST, genesisNs: GENESIS });
    for (const who of ['a', 'b', 'c']) engine.claim(who, GENESIS);
    const start = GENESIS + FAST.roundNs;
    const seenAt = start + FAST.roundNs / 2n;
    const st = engine.state(seenAt);
    const guard = { round: st.round, maxCost: maxCostFor(costAt(FAST, st.roundSupply, st.roundStartNs, seenAt)) };
    // Lands in the next round, where the cost has reset to its maximum.
    expect(() => engine.volunteer('a', start + FAST.roundNs + 5n, guard)).toThrow(/ERR_WRONG_ROUND/);
    expect(() => engine.volunteer('a', start + FAST.roundNs + 5n, { maxCost: guard.maxCost })).toThrow(/ERR_COST_TOO_HIGH/);
  });
});
