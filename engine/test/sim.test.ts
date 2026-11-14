import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FAST,
  UNIT,
  altruist,
  freeRider,
  gini,
  labToJson,
  makeStrategy,
  mixedEquilibriumFailure,
  mixedEquilibriumP,
  mixedFinalBlock,
  mulberry32,
  paretoBalances,
  rationalTimer,
  simulate,
  slotElapsedNs,
  sniper,
  throneAware,
  throneValue,
} from '../src/index.ts';
import type { AgentSpec, SlotContext, StrategySpec } from '../src/index.ts';

const T = 1000n * UNIT;

function crowd(count: number, strategy: StrategySpec, balance = T): AgentSpec[] {
  return Array.from({ length: count }, () => ({ balance, strategy }));
}

function ctx(overrides: Partial<SlotContext> = {}): SlotContext {
  return {
    round: 1,
    slot: 0,
    slots: 20,
    isFinalSlot: false,
    armed: true,
    isIt: false,
    contenders: 10,
    balance: 1000,
    supply: 11_000,
    costNow: 100,
    costFinal: 22,
    cut: 0.15,
    maxCollapseRun: 8,
    recentFailureRate: 0,
    rng: () => 0.5,
    ...overrides,
  };
}

test('mulberry32 is deterministic and stays in [0, 1)', () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  const c = mulberry32(43);
  const xs = Array.from({ length: 1000 }, () => a());
  assert.deepEqual(
    xs,
    Array.from({ length: 1000 }, () => b()),
  );
  assert.notEqual(xs[0], c());
  assert.ok(xs.every((x) => x >= 0 && x < 1));
  const mean = xs.reduce((t, x) => t + x, 0) / xs.length;
  assert.ok(Math.abs(mean - 0.5) < 0.05);
});

test('slots run from the round opening to the final nanosecond', () => {
  const R = FAST.roundNs;
  assert.equal(slotElapsedNs(0, 20, R), 0n);
  assert.equal(slotElapsedNs(19, 20, R), R - 1n);
  assert.equal(slotElapsedNs(0, 1, R), R - 1n);
  for (let s = 1; s < 20; s++) assert.ok(slotElapsedNs(s, 20, R) > slotElapsedNs(s - 1, 20, R));
});

test('mixed equilibrium formulas (§11)', () => {
  assert.equal(mixedEquilibriumP(1, 10), 0);
  assert.equal(mixedEquilibriumP(1.5, 10), 0);
  assert.equal(mixedEquilibriumP(Number.NaN, 10), 0);
  assert.equal(mixedEquilibriumP(Number.POSITIVE_INFINITY, 10), 0);
  assert.equal(mixedEquilibriumP(0.5, 1), 1);
  assert.equal(mixedEquilibriumP(0.25, 2), 0.75);
  assert.equal(mixedEquilibriumP(0.25, 3), 0.5);
  assert.equal(mixedEquilibriumFailure(0.25, 3), 0.125); // (1 − p)^n = 0.5^3
  assert.equal(mixedEquilibriumFailure(1.2, 3), 1);
  assert.equal(mixedEquilibriumFailure(0.5, 1), 0);
  for (const [q, n] of [
    [0.3, 5],
    [0.8, 60],
  ] as const) {
    const p = mixedEquilibriumP(q, n);
    assert.ok(Math.abs(Math.pow(1 - p, n) - mixedEquilibriumFailure(q, n)) < 1e-12);
    // Indifference: the cost equals the expected loss avoided, q = (1 − p)^(n − 1).
    assert.ok(Math.abs(Math.pow(1 - p, n - 1) - q) < 1e-12);
  }
});

test('strategies follow the §11 payoffs', () => {
  // rationalTimer: volunteer iff armed, not It and cost < cut × balance × patience.
  const timer = rationalTimer();
  assert.equal(timer.decide(ctx({ costNow: 149 })), 'volunteer');
  assert.equal(timer.decide(ctx({ costNow: 150 })), 'pass');
  assert.equal(timer.decide(ctx({ costNow: 1, armed: false })), 'pass');
  assert.equal(timer.decide(ctx({ costNow: 1, isIt: true })), 'pass');
  assert.equal(rationalTimer(0.5).decide(ctx({ costNow: 76 })), 'pass');
  assert.equal(rationalTimer(0.5).decide(ctx({ costNow: 74 })), 'volunteer');
  assert.throws(() => rationalTimer(0));
  assert.throws(() => rationalTimer(1.1));

  // throneAware: the same when no round has failed recently...
  const throne = throneAware();
  assert.equal(throne.decide(ctx({ costNow: 149 })), 'volunteer');
  assert.equal(throne.decide(ctx({ costNow: 150 })), 'pass');
  assert.equal(throne.decide(ctx({ costNow: 1, armed: false })), 'pass');
  assert.equal(throne.decide(ctx({ costNow: 1, isIt: true, recentFailureRate: 1 })), 'pass');
  // ...but failures make the throne worth paying for, even in a dormant round.
  assert.equal(throneValue(1000, 11_000, 0.15, 0, 8), 0);
  assert.ok(Math.abs(throneValue(1000, 11_000, 0.15, 1, 1) - 1500) < 1e-9);
  assert.ok(Math.abs(throneValue(1000, 11_000, 0.15, 0.5, 2) - 1500 * (0.5 + 0.25 * 0.85)) < 1e-9);
  assert.ok(Math.abs(throneValue(1000, 11_000, 0.15, 1, 8) - 10_000 * (1 - Math.pow(0.85, 8))) < 1e-6);
  assert.equal(throne.decide(ctx({ costNow: 500, armed: false, recentFailureRate: 0.5 })), 'volunteer');
  assert.equal(throne.decide(ctx({ costNow: 200, recentFailureRate: 0.05 })), 'volunteer'); // 150 + ~78
  assert.equal(throne.decide(ctx({ costNow: 240, recentFailureRate: 0.05 })), 'pass');

  // mixedFinalBlock: final slot only, probability p*.
  const mixed = mixedFinalBlock();
  assert.equal(mixed.decide(ctx({ rng: () => 0 })), 'pass'); // not the final slot
  const p = mixedEquilibriumP(22 / 150, 10);
  assert.equal(mixed.decide(ctx({ isFinalSlot: true, rng: () => p - 1e-9 })), 'volunteer');
  assert.equal(mixed.decide(ctx({ isFinalSlot: true, rng: () => p + 1e-9 })), 'pass');
  assert.equal(mixed.decide(ctx({ isFinalSlot: true, rng: () => 0, costFinal: 150 })), 'pass'); // q >= 1
  assert.equal(mixed.decide(ctx({ isFinalSlot: true, rng: () => 0, armed: false })), 'pass');
  assert.equal(mixed.decide(ctx({ isFinalSlot: true, rng: () => 0, isIt: true })), 'pass');
  assert.equal(mixed.decide(ctx({ isFinalSlot: true, rng: () => 0, balance: 0 })), 'pass');

  // sniper, freeRider, altruist.
  assert.equal(sniper(0.2).decide(ctx({ rng: () => 0 })), 'pass');
  assert.equal(sniper(0.2).decide(ctx({ isFinalSlot: true, rng: () => 0.1 })), 'miss');
  assert.equal(sniper(0.2).decide(ctx({ isFinalSlot: true, rng: () => 0.3, isIt: true })), 'volunteer');
  assert.equal(freeRider().decide(ctx({ costNow: 0, isFinalSlot: true })), 'pass');
  const always = altruist(1);
  always.startRound!({ round: 1, slots: 20, rng: () => 0.26 }); // slot floor(0.26 × 20) = 5
  assert.equal(always.decide(ctx({ slot: 4 })), 'pass');
  assert.equal(always.decide(ctx({ slot: 5, costNow: 1e9 })), 'volunteer');
  const never = altruist(0);
  never.startRound!({ round: 1, slots: 20, rng: () => 0 });
  for (let s = 0; s < 20; s++) assert.equal(never.decide(ctx({ slot: s })), 'pass');

  assert.equal(makeStrategy({ kind: 'throneAware' }).kind, 'throneAware');
  assert.equal(makeStrategy({ kind: 'sniper', missRate: 0.5 }).kind, 'sniper');
  assert.throws(() => makeStrategy({ kind: 'nope' } as unknown as StrategySpec));
});

test('simulate is deterministic for a seed', () => {
  const options = {
    agents: [
      ...crowd(3, { kind: 'altruist', h: 0.4 }),
      ...crowd(3, { kind: 'sniper', missRate: 0.3 }),
      ...crowd(10, { kind: 'freeRider' }),
    ],
    rounds: 300,
    seed: 99,
    timeline: true,
  };
  const a = simulate(options);
  const b = simulate(options);
  assert.equal(labToJson(a), labToJson(b));
  assert.notEqual(labToJson(simulate({ ...options, seed: 100 })), labToJson(a));
  assert.equal(a.timeline.length, 300);
  assert.equal(a.saved + a.collapsed + a.dormant, 300);
  assert.equal(a.saved, a.timeline.filter((t) => t.outcome === 'saved').length);
  assert.equal(
    a.saved,
    a.agents.reduce((t, x) => t + x.saves, 0),
  );
  assert.equal(
    a.savedBySlot.reduce((t, x) => t + x, 0),
    a.saved,
  );
});

test('simulate: free riders alone never start the game', () => {
  const s = simulate({ agents: crowd(5, { kind: 'freeRider' }), rounds: 50, seed: 1 });
  assert.equal(s.dormant, 50);
  assert.equal(s.saved + s.collapsed, 0);
  assert.equal(s.failureRate, 1);
  assert.equal(s.opening.armed, false);
  assert.equal(s.opening.it, -1);
  assert.equal(s.supplyStart, 5n * T);
  assert.equal(s.supplyEnd, 5n * T);
  assert.equal(s.avgSecondsLeftFraction, null);
  assert.equal(s.firstSavedRound, null);
  assert.equal(s.firstFailedRound, 1);
  for (const a of s.agents) assert.equal(a.balanceEnd, T);
});

test('simulate: with a setup It and nobody volunteering, 8 rounds are charged and the rest are dormant', () => {
  const s = simulate({ agents: crowd(5, { kind: 'freeRider' }), rounds: 30, seed: 1, initialIt: 2, timeline: true });
  assert.equal(s.opening.armed, true);
  assert.equal(s.opening.it, 2);
  assert.equal(s.collapsed, 8);
  assert.equal(s.dormant, 22);
  assert.equal(s.itEnd, 2);
  assert.deepEqual(
    s.timeline.map((t) => t.outcome[0]).join(''),
    'c'.repeat(8) + 'd'.repeat(22),
  );
  // The setup volunteer paid the final-slot cost (0.2001 % of 5000) before the measured rounds.
  const setupCost = (5n * T * 2_001n) / 1_000_000n;
  assert.equal(s.agents[2]!.balanceStart, T - setupCost);
  assert.equal(s.supplyStart, 5n * T - setupCost);
  assert.equal(s.opening.costOpen, (s.supplyStart * 50_000n) / 1_000_000n);
  assert.equal(s.opening.costFinal, (s.supplyStart * 2_001n) / 1_000_000n);
  // Collapses conserve the supply and move 1 − 0.85^8 of everybody else's balance to It.
  assert.ok(s.supplyStart - s.supplyEnd <= 8n);
  const keep = Math.pow(0.85, 8);
  for (const i of [0, 1, 3, 4]) {
    assert.ok(Math.abs(Number(s.agents[i]!.balanceEnd) / Number(T) - keep) < 1e-12);
    assert.equal(s.agents[i]!.collected, 0n);
  }
  assert.equal(s.agents[2]!.collected, s.totalPaid);
  // `paid` is net of It's own cut: it is It's balance gain (within rounding) and what the others lost.
  const gain = s.agents[2]!.balanceEnd - s.agents[2]!.balanceStart;
  assert.ok(gain - s.totalPaid <= 8n && s.totalPaid - gain <= 8n);
  assert.ok(Math.abs(Number(s.totalPaid) / Number(4n * T) - (1 - keep)) < 1e-12);
  assert.equal(s.totalBurned, 0n);
});

test('simulate: rationalTimer needs an It, throneAware starts by itself', () => {
  const equal = (kind: 'rationalTimer' | 'throneAware'): AgentSpec[] => crowd(20, { kind });
  // 20 equal holders hold 5 % each: cut × x = 0.75 % of supply > the 0.2 % final cost.
  const cold = simulate({ agents: equal('rationalTimer'), rounds: 60, seed: 3 });
  assert.equal(cold.saved, 0);
  assert.equal(cold.dormant, 60);
  const armed = simulate({ agents: equal('rationalTimer'), rounds: 60, seed: 3, initialIt: 0 });
  assert.equal(armed.saved, 60);
  assert.equal(armed.totalPaid, 0n);
  // Nobody pays more than cut × own balance, and the supply only shrinks by the burns.
  assert.equal(armed.supplyStart - armed.supplyEnd, armed.totalBurned);
  const throne = simulate({ agents: equal('throneAware'), rounds: 60, seed: 3 });
  assert.equal(throne.firstSavedRound, 2); // round 1 goes by dormant; that failure makes the throne worth taking
  assert.equal(throne.saved, 59);
  assert.equal(throne.dormant, 1);
});

test('simulate: resetEachRound plays independent trials', () => {
  const agents: AgentSpec[] = [...crowd(10, { kind: 'mixedFinalBlock' }), { balance: T, strategy: { kind: 'freeRider' } }];
  const s = simulate({ agents, rounds: 400, seed: 5, initialIt: 10, resetEachRound: true, timeline: true });
  assert.equal(s.saved + s.collapsed, 400);
  assert.equal(s.dormant, 0);
  // Every trial opens with the same supply: holdings never drift.
  assert.ok(s.timeline.every((t) => t.supply === s.supplyStart));
  assert.ok(s.collapsed > 10 && s.collapsed < 100); // theory: about 12 %
  assert.ok(s.savedBySlot.slice(0, 19).every((x) => x === 0));
});

test('simulate rejects bad options', () => {
  assert.throws(() => simulate({ agents: [], rounds: 1 }));
  assert.throws(() => simulate({ agents: crowd(1, { kind: 'freeRider' }), rounds: -1 }));
  assert.throws(() => simulate({ agents: crowd(1, { kind: 'freeRider' }), rounds: 1, slotsPerRound: 0 }));
  assert.throws(() => simulate({ agents: crowd(2, { kind: 'freeRider' }), rounds: 1, initialIt: 2 }));
  assert.throws(() =>
    simulate({
      agents: [
        { id: 'x', balance: T, strategy: { kind: 'freeRider' } },
        { id: 'x', balance: T, strategy: { kind: 'freeRider' } },
      ],
      rounds: 1,
    }),
  );
});

test('gini and paretoBalances', () => {
  assert.equal(gini([1, 1, 1, 1]), 0);
  assert.equal(gini([0, 0, 0, 8]), 0.75);
  assert.equal(gini([]), 0);
  const a = paretoBalances(50, 7);
  assert.deepEqual(a, paretoBalances(50, 7));
  assert.equal(a.length, 50);
  assert.ok(a.every((x) => x >= 100n * UNIT && x % UNIT === 0n));
});
