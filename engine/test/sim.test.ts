import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FAST,
  UNIT,
  altruist,
  classicDilemma,
  firstPaysEquilibrium,
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

/** Left side minus right side of the indifference equation, evaluated without cancellation. */
function indifference(n: number, q: number, p: number): number {
  const l = Math.log1p(-p);
  return (q * -Math.expm1(n * l)) / (n * p) - Math.exp((n - 1) * l);
}

test('first-pays equilibrium: the solver satisfies the indifference equation', () => {
  for (const [n, q] of [
    [2, 0.5],
    [3, 0.0533],
    [5, 0.9],
    [10, 0.1464],
    [30, 0.4127],
    [60, 0.8121],
    [100, 0.999],
    [300, 0.37],
    [7, 1e-6],
  ] as const) {
    const { p, fail } = firstPaysEquilibrium(n, q);
    assert.ok(p > 0 && p < 1, `n=${n} q=${q}: p=${p}`);
    assert.ok(Math.abs(indifference(n, q, p)) < 1e-9, `n=${n} q=${q}: residual ${indifference(n, q, p)}`);
    assert.ok(Math.abs(fail - Math.pow(1 - p, n)) < 1e-12);
    // Only the first submitter pays, so holders volunteer more readily than in the textbook dilemma.
    const classic = classicDilemma(n, q);
    assert.ok(p > classic.p && fail < classic.fail, `n=${n} q=${q}`);
  }
  // Closed form for two holders: q(1 + u)/2 = u with u = 1 − p.
  const two = firstPaysEquilibrium(2, 0.5);
  assert.ok(Math.abs(two.p - 2 / 3) < 1e-12 && Math.abs(two.fail - 1 / 9) < 1e-12);
  // The values of the review: about 0.3 %, 3.6 %, 20 %, 66 % at 3, 10, 30, 60 players.
  assert.ok(Math.abs(firstPaysEquilibrium(3, 0.0533).fail - 0.003) < 0.0005);
  assert.ok(Math.abs(firstPaysEquilibrium(10, 0.1464).fail - 0.0357) < 0.0005);
  assert.ok(Math.abs(firstPaysEquilibrium(30, 0.4127).fail - 0.1995) < 0.0005);
  assert.ok(Math.abs(firstPaysEquilibrium(60, 0.8121).fail - 0.6642) < 0.0005);
});

test('first-pays equilibrium: the chance to pay is E[1/(K+1)] for K ~ Binomial(n−1, p)', () => {
  for (const [n, p] of [
    [2, 0.3],
    [5, 0.6],
    [12, 0.07],
    [40, 0.02],
  ] as const) {
    let expected = 0;
    let binom = 1; // C(n−1, k)
    for (let k = 0; k < n; k++) {
      expected += (binom * Math.pow(p, k) * Math.pow(1 - p, n - 1 - k)) / (k + 1);
      binom = (binom * (n - 1 - k)) / (k + 1);
    }
    assert.ok(Math.abs(expected - (1 - Math.pow(1 - p, n)) / (n * p)) < 1e-12);
  }
});

test('first-pays equilibrium: boundaries and monotonicity', () => {
  // q ≥ 1: the cheapest save costs more than a collapse; nobody volunteers.
  for (const q of [1, 1.0118, 5, Number.POSITIVE_INFINITY, Number.NaN]) {
    assert.deepEqual(firstPaysEquilibrium(10, q), { p: 0, fail: 1 });
    assert.deepEqual(classicDilemma(10, q), { p: 0, fail: 1 });
  }
  // A lone holder always pays when it submits: it volunteers for sure whenever q < 1.
  assert.deepEqual(firstPaysEquilibrium(1, 0.5), { p: 1, fail: 0 });
  assert.deepEqual(firstPaysEquilibrium(4, 0), { p: 1, fail: 0 });
  assert.deepEqual(firstPaysEquilibrium(0, 0.5), { p: 0, fail: 1 });
  // q just below 1: p is tiny but positive, and the round almost surely fails.
  const edge = firstPaysEquilibrium(50, 1 - 1e-9);
  assert.ok(edge.p > 0 && edge.p < 1e-9 && edge.fail > 0.999999 && edge.fail < 1);
  assert.ok(Math.abs(indifference(50, 1 - 1e-9, edge.p)) < 1e-12);

  // As in experiment A: q grows with the crowd, q = min_cost × (n + 1) / cut. P(fail) rises with n and reaches 1.
  let previous = 0;
  for (let n = 2; n <= 90; n++) {
    const { fail } = firstPaysEquilibrium(n, (0.002 * (n + 1)) / 0.15);
    assert.ok(fail >= previous, `P(fail) fell at n=${n}`);
    assert.ok(n < 74 ? fail < 1 : fail === 1, `n=${n}: ${fail}`);
    previous = fail;
  }
  // For a fixed q, a bigger crowd fails more often too, and p falls.
  for (let n = 2; n < 60; n++) {
    assert.ok(firstPaysEquilibrium(n + 1, 0.4).fail > firstPaysEquilibrium(n, 0.4).fail);
    assert.ok(firstPaysEquilibrium(n + 1, 0.4).p < firstPaysEquilibrium(n, 0.4).p);
  }
});

test('the textbook formula is kept as classicDilemma; the mixedEquilibrium* helpers follow the deployed rule', () => {
  assert.deepEqual(classicDilemma(2, 0.25), { p: 0.75, fail: 0.0625 });
  assert.equal(classicDilemma(3, 0.25).p, 0.5);
  assert.equal(classicDilemma(3, 0.25).fail, 0.125); // (1 − p)^n = 0.5^3
  assert.deepEqual(classicDilemma(1, 0.5), { p: 1, fail: 0 });
  for (const [q, n] of [
    [0.3, 5],
    [0.8, 60],
  ] as const) {
    const c = classicDilemma(n, q);
    assert.ok(Math.abs(Math.pow(1 - c.p, n) - c.fail) < 1e-12);
    assert.ok(Math.abs(Math.pow(1 - c.p, n - 1) - q) < 1e-12); // its indifference: q = (1 − p)^(n − 1)
    assert.equal(mixedEquilibriumP(q, n), firstPaysEquilibrium(n, q).p);
    assert.equal(mixedEquilibriumFailure(q, n), firstPaysEquilibrium(n, q).fail);
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
  assert.ok(s.collapsed >= 3 && s.collapsed <= 35, `collapsed ${s.collapsed}`); // equilibrium: about 3.6 % of 400
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
