import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FAST,
  LIVE,
  MAX_COLLAPSE_RUN,
  NotIt,
  PPM,
  RAY,
  RESCALE_BELOW,
  RESCALE_FACTOR,
  UNIT,
  costFromRate,
  costRatePpm,
  effectiveShares,
} from '../src/index.ts';
import type { NotItEvent } from '../src/index.ts';
import { R, absDiff, at, expectError, make, viewsAt, withHolders } from './helpers.ts';

const CLAIM = 1000n * UNIT;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

test('FAST and LIVE carry the spec parameters', () => {
  assert.deepEqual(FAST, {
    roundNs: 180_000_000_000n,
    maxCostPpm: 50_000,
    minCostPpm: 2_000,
    cutPpm: 150_000,
    claimAmount: CLAIM,
    claimCap: 100_000,
  });
  assert.deepEqual(LIVE, { ...FAST, roundNs: 3_600_000_000_000n });
  assert.equal(MAX_COLLAPSE_RUN, 8);
});

test('new() validates its parameters with ERR_PARAMS', () => {
  expectError(() => make({ roundNs: 999_999_999n }), 'ERR_PARAMS');
  expectError(() => make({ minCostPpm: 0 }), 'ERR_PARAMS');
  expectError(() => make({ minCostPpm: 60_000 }), 'ERR_PARAMS'); // min > max
  expectError(() => make({ maxCostPpm: 1_000_000 }), 'ERR_PARAMS');
  expectError(() => make({ cutPpm: 0 }), 'ERR_PARAMS');
  expectError(() => make({ cutPpm: 1_000_000 }), 'ERR_PARAMS');
  expectError(() => make({ claimAmount: 0n }), 'ERR_PARAMS');
  expectError(() => make({ claimAmount: 10n ** 28n, claimCap: 100_000 }), 'ERR_PARAMS'); // > 10^32 claimable
  expectError(() => make({ maxCostPpm: 1.5 }), 'ERR_PARAMS');
  assert.doesNotThrow(() => make({ roundNs: 1_000_000_000n, minCostPpm: 7, maxCostPpm: 7, cutPpm: 999_999 }));
  assert.doesNotThrow(() => make({ claimAmount: 10n ** 27n, claimCap: 100_000 })); // exactly 10^32
});

// ---------------------------------------------------------------------------
// claim
// ---------------------------------------------------------------------------

test('claim mints claim_amount once per account and auto-registers', () => {
  const e = make();
  assert.deepEqual(e.account('alice', 0n), {
    registered: false,
    claimed: false,
    balance: 0n,
    saves: 0,
    burned: 0n,
    collected: 0n,
    isIt: false,
  });
  e.claim('alice', 0n);
  assert.equal(e.balanceOf('alice', 0n), CLAIM);
  assert.equal(e.totalSupply(0n), CLAIM);
  const a = e.account('alice', 0n);
  assert.equal(a.registered, true);
  assert.equal(a.claimed, true);
  assert.equal(e.state(0n).claimsMade, 1);

  expectError(() => e.claim('alice', 0n), 'ERR_ALREADY_CLAIMED');
  expectError(() => e.claim('alice', at(5)), 'ERR_ALREADY_CLAIMED');
  assert.equal(e.balanceOf('alice', at(5)), CLAIM);

  // A registered account with a zero balance can still claim.
  e.register('bob');
  assert.equal(e.account('bob', 0n).registered, true);
  e.claim('bob', 0n);
  assert.equal(e.balanceOf('bob', 0n), CLAIM);
  assert.equal(e.totalSupply(0n), 2n * CLAIM);
});

test('claim cap closes the faucet', () => {
  const e = make({ claimCap: 2 });
  assert.equal(e.state(0n).claimOpen, true);
  e.claim('a', 0n);
  e.claim('b', 0n);
  assert.equal(e.state(0n).claimOpen, false);
  expectError(() => e.claim('c', 0n), 'ERR_CLAIMS_CLOSED');
  assert.equal(e.account('c', 0n).registered, false);
  assert.equal(e.state(0n).claimsMade, 2);
  // Already-claimed is checked before the cap.
  expectError(() => e.claim('a', 0n), 'ERR_ALREADY_CLAIMED');
});

test('a claim does not change round_supply of the current round', () => {
  const e = withHolders(['alice']);
  assert.equal(e.state(at(1)).roundSupply, CLAIM);
  e.claim('bob', at(1));
  assert.equal(e.state(at(1)).roundSupply, CLAIM);
  assert.equal(e.state(at(1)).totalSupply, 2n * CLAIM);
  assert.equal(e.state(at(2)).roundSupply, 2n * CLAIM);
});

// ---------------------------------------------------------------------------
// Cost curve
// ---------------------------------------------------------------------------

test('cost curve: endpoints and midpoint', () => {
  const e = withHolders(['alice']); // round supply 1000 NOTIT from round 1
  // Open: max_cost_ppm = 5 %.
  assert.equal(e.costAt(at(1)), 50n * UNIT);
  // Midpoint: 50_000 − floor(48_000 / 2) = 26_000 ppm.
  assert.equal(e.costAt(at(1, R / 2n)), 26n * UNIT);
  // Last nanosecond: floor(48_000 × (R − 1) / R) = 47_999, so 2_001 ppm (min is only reached at the deadline itself).
  assert.equal(e.costAt(at(1, R - 1n)), (CLAIM * 2_001n) / PPM);
  assert.equal(e.state(at(1, R / 2n)).costNow, 26n * UNIT);

  // The pure helpers agree, and hit min_cost_ppm exactly at elapsed = round_ns.
  assert.equal(costRatePpm(FAST, 0n), 50_000n);
  assert.equal(costRatePpm(FAST, R / 2n), 26_000n);
  assert.equal(costRatePpm(FAST, R - 1n), 2_001n);
  assert.equal(costRatePpm(FAST, R), 2_000n);
  assert.equal(costFromRate(CLAIM, 2_000n), 2n * UNIT);
  // cost is never below 1 unit.
  assert.equal(costFromRate(10n, 2_000n), 1n);
});

test('cost is 0 when there is nothing to save or the round is saved', () => {
  const e = withHolders(['alice']);
  assert.equal(e.costAt(0n), 0n); // round 0: round_supply == 0
  assert.equal(e.state(0n).costNow, 0n);
  e.volunteer('alice', at(1));
  assert.equal(e.costAt(at(1, 5n)), 0n);
  assert.equal(e.state(at(1, 5n)).saved, true);
});

// ---------------------------------------------------------------------------
// volunteer
// ---------------------------------------------------------------------------

test('volunteer burns exactly the cost and makes the caller hero and It', () => {
  const e = withHolders(['alice', 'bob']);
  const now = at(1, R / 2n);
  const cost = e.costAt(now);
  assert.equal(cost, 52n * UNIT); // 2000 × 2.6 %
  const res = e.volunteer('alice', now);
  assert.deepEqual(res, { cost, msLeft: 90_000 });

  // index == RAY here, so the balance falls by the cost exactly.
  assert.equal(e.balanceOf('alice', now), CLAIM - cost);
  assert.equal(e.balanceOf('bob', now), CLAIM);
  assert.equal(e.totalSupply(now), 2n * CLAIM - cost);

  const s = e.state(now);
  assert.equal(s.saved, true);
  assert.equal(s.hero, 'alice');
  assert.equal(s.it, 'alice');
  assert.equal(s.armed, true);
  assert.equal(s.collapseRun, 0);
  assert.equal(s.costNow, 0n);
  assert.equal(s.roundSupply, 2n * CLAIM); // the snapshot taken at round open
  assert.equal(s.stats.totalBurned, cost);
  assert.equal(s.stats.closestCallMs, 90_000);
  assert.equal(s.stats.roundsSaved, 0); // counted when the round closes

  assert.deepEqual(e.history(now), [{ kind: 'saved', round: 1, hero: 'alice', cost, msLeft: 90_000 }]);
  assert.deepEqual(e.heroes(), [{ accountId: 'alice', saves: 1, burned: cost, collected: 0n }]);
  const a = e.account('alice', now);
  assert.equal(a.saves, 1);
  assert.equal(a.burned, cost);
  assert.equal(a.isIt, true);
  assert.equal(e.account('bob', now).isIt, false);
});

test('a second volunteer in the same round is rejected and changes nothing', () => {
  const e = withHolders(['alice', 'bob']);
  e.volunteer('alice', at(1));
  const before = e.snapshot();
  expectError(() => e.volunteer('bob', at(1, 10n)), 'ERR_ALREADY_SAVED');
  expectError(() => e.volunteer('alice', at(1, R - 1n)), 'ERR_ALREADY_SAVED');
  assert.equal(e.snapshot(), before);
  // The next round can be saved again, by anyone (including It).
  e.volunteer('bob', at(2, R - 1n));
  assert.equal(e.state(at(2, R - 1n)).it, 'bob');
  e.volunteer('bob', at(3));
  assert.equal(e.heroes().find((h) => h.accountId === 'bob')!.saves, 2);
});

test('volunteer: nothing to save, insufficient balance, unregistered caller', () => {
  const e = withHolders(['alice']);
  expectError(() => e.volunteer('alice', 0n), 'ERR_NOTHING_TO_SAVE'); // round 0 has round_supply 0
  expectError(() => e.volunteer('nobody', at(1)), 'ERR_INSUFFICIENT'); // unregistered
  e.register('poor');
  expectError(() => e.volunteer('poor', at(1)), 'ERR_INSUFFICIENT');
  e.transfer('alice', 'poor', UNIT, at(1)); // 1 NOTIT; the cost at open is 50
  expectError(() => e.volunteer('poor', at(1)), 'ERR_INSUFFICIENT');
  // ...but it can afford exactly the cost once it holds it.
  const now = at(1, R - 1n);
  const cost = e.costAt(now); // 2.001 NOTIT
  e.transfer('alice', 'poor', cost - UNIT, now);
  assert.equal(e.volunteer('poor', now).cost, cost);
  assert.equal(e.balanceOf('poor', now), 0n);
});

test('volunteer guards: round and max_cost', () => {
  const e = withHolders(['alice', 'bob']);
  const now = at(3, R / 2n);
  const cost = e.costAt(now);
  const before = e.snapshot();
  expectError(() => e.volunteer('alice', now, { round: 2 }), 'ERR_WRONG_ROUND');
  expectError(() => e.volunteer('alice', now, { round: 4 }), 'ERR_WRONG_ROUND');
  expectError(() => e.volunteer('alice', now, { maxCost: cost - 1n }), 'ERR_COST_TOO_HIGH');
  expectError(() => e.volunteer('alice', now, { round: 3, maxCost: 0n }), 'ERR_COST_TOO_HIGH');
  // The round guard is checked before the cost guard.
  expectError(() => e.volunteer('alice', now, { round: 2, maxCost: 0n }), 'ERR_WRONG_ROUND');
  assert.equal(e.snapshot(), before);
  // A transaction meant for round 3 that lands at the start of round 4 fails instead of paying the opening price.
  expectError(() => e.volunteer('alice', at(4), { round: 3, maxCost: cost }), 'ERR_WRONG_ROUND');
  assert.deepEqual(e.volunteer('alice', now, { round: 3, maxCost: cost }), { cost, msLeft: 90_000 });
  // Guards are checked after ERR_ALREADY_SAVED.
  expectError(() => e.volunteer('bob', now, { round: 99 }), 'ERR_ALREADY_SAVED');
});

test('a saved round only updates the streak when it closes', () => {
  const e = withHolders(['alice', 'bob']);
  e.volunteer('alice', at(1));
  e.volunteer('bob', at(2));
  e.volunteer('alice', at(3));
  const before = e.balanceOf('bob', at(3));
  const s = e.state(at(4));
  assert.equal(s.stats.roundsSaved, 3);
  assert.equal(s.stats.currentStreak, 3);
  assert.equal(s.stats.longestStreak, 3);
  assert.equal(s.stats.roundsCollapsed, 0);
  assert.equal(s.index, RAY); // no mint, no cut
  assert.equal(e.balanceOf('bob', at(4)), before);
  // Round 4 is not saved: it collapses, and the streak resets but the record stays.
  const t = e.state(at(5));
  assert.equal(t.stats.currentStreak, 0);
  assert.equal(t.stats.longestStreak, 3);
  assert.equal(t.stats.roundsCollapsed, 1);
});

// ---------------------------------------------------------------------------
// Dormant and collapsed rounds
// ---------------------------------------------------------------------------

test('before the first volunteer the game is dormant: nothing is charged', () => {
  const e = withHolders(['alice', 'bob']);
  const s = e.state(at(50, 7n));
  assert.equal(s.round, 50);
  assert.equal(s.it, null);
  assert.equal(s.armed, false);
  assert.equal(s.index, RAY);
  assert.equal(s.roundSupply, 2n * CLAIM);
  assert.equal(s.totalSupply, 2n * CLAIM);
  assert.deepEqual(s.stats, {
    roundsSaved: 0,
    roundsCollapsed: 0,
    currentStreak: 0,
    longestStreak: 0,
    closestCallMs: null,
    totalBurned: 0n,
    totalPaid: 0n,
  });
  assert.equal(e.balanceOf('alice', at(50)), CLAIM);
  assert.deepEqual(e.history(at(50)), []);
  assert.equal(e.poke(at(50)), 1);
  assert.equal(e.balanceOf('bob', at(50)), CLAIM);
  assert.deepEqual(e.history(at(50)), []);
  // An engine nobody ever claimed from stays empty.
  const empty = make();
  assert.equal(empty.poke(at(10)), 1);
  assert.equal(empty.state(at(10)).roundSupply, 0n);
  expectError(() => empty.volunteer('alice', at(10)), 'ERR_NOTHING_TO_SAVE');
});

test('a collapse mints the pot to It, reports it net of its own cut, and conserves the supply', () => {
  const e = withHolders(['alice', 'bob', 'carol']);
  const { cost } = e.volunteer('alice', at(1)); // 150 NOTIT, alice is It
  assert.equal(cost, 150n * UNIT);
  const aliceBefore = e.balanceOf('alice', at(2));
  const bobBefore = e.balanceOf('bob', at(2));
  const supplyBefore = e.totalSupply(at(2));
  assert.equal(supplyBefore, 2850n * UNIT);
  assert.equal(e.state(at(2)).armed, true);

  // Round 2 goes unsaved. Expected values, straight from §4.1:
  const totalShares = 2850n * UNIT; // index was RAY, so shares == units
  const index = (RAY * 850_000n) / PPM;
  const pot = supplyBefore - (totalShares * index) / RAY;
  const minted = (pot * RAY) / index;
  assert.equal(pot, (2850n * UNIT * 15n) / 100n); // 427.5 NOTIT: 15 % of everything, It included
  // Step 3b: what It collects is reported net of the cut on its own 850 NOTIT.
  const net = pot - (aliceBefore - (aliceBefore * index) / RAY);
  assert.equal(net, 300n * UNIT); // 15 % of bob's and carol's 1000 each

  assert.equal(e.poke(at(3)), 2); // closes round 1 (saved) and round 2 (collapsed)
  const s = e.state(at(3));
  assert.equal(s.index, index);
  assert.equal(s.scale, 0);
  assert.equal(s.stats.roundsCollapsed, 1);
  assert.equal(s.stats.totalPaid, net);
  assert.equal(s.collapseRun, 1);
  assert.equal(s.it, 'alice');
  assert.equal(JSON.parse(e.snapshot()).total_shares, (totalShares + minted).toString());

  // Everybody is cut by 15 %; It gets the whole pot on top, so it ends up `net` ahead.
  assert.equal(e.balanceOf('bob', at(3)), (bobBefore * 85n) / 100n);
  assert.equal(e.balanceOf('carol', at(3)), (bobBefore * 85n) / 100n);
  const aliceAfter = e.balanceOf('alice', at(3));
  assert.ok(absDiff(aliceAfter, (aliceBefore * 85n) / 100n + pot) <= 1n);
  assert.ok(absDiff(aliceAfter - aliceBefore, net) <= 1n);
  assert.equal(e.account('alice', at(3)).collected, net);
  assert.deepEqual(e.heroes(), [{ accountId: 'alice', saves: 1, burned: cost, collected: net }]);

  // Supply is conserved (within rounding), and balances never add up to more than the supply.
  const supplyAfter = e.totalSupply(at(3));
  assert.ok(supplyAfter <= supplyBefore && supplyBefore - supplyAfter <= 1n);
  const sum = aliceAfter + e.balanceOf('bob', at(3)) + e.balanceOf('carol', at(3));
  assert.ok(sum <= supplyAfter && supplyAfter - sum <= 3n);
  assert.equal(s.roundSupply, supplyAfter);

  assert.deepEqual(e.history(at(3)), [
    { kind: 'saved', round: 1, hero: 'alice', cost, msLeft: 180_000 },
    { kind: 'collapsed', firstRound: 2, lastRound: 2, count: 1, it: 'alice', paid: net },
  ]);
});

test('net paid is clamped at 0 when rounding makes It\'s own cut exceed the pot', () => {
  // alice is It and owns everything except one dust share left behind by bob's
  // ceil-rounded transfer. Then floor(T·i) − floor(T·i') can be 1 unit less than
  // floor(e·i) − floor(e·i'), and step 3b would go negative without the clamp.
  const e = make({ claimAmount: CLAIM + 561n });
  e.claim('alice', 0n);
  e.claim('bob', 0n);
  e.volunteer('alice', at(1, 80_000n));
  e.poke(at(3)); // round 2 collapsed: index = 0.85 RAY
  e.transfer('bob', 'alice', e.balanceOf('bob', at(3)), at(3));
  e.volunteer('alice', at(3, R - 1n)); // re-arm
  e.poke(at(4));
  const snap = JSON.parse(e.snapshot());
  const total = BigInt(snap.total_shares);
  const alice = BigInt(snap.accounts[0].shares);
  const index = BigInt(snap.index);
  const after = (index * 850_000n) / PPM;
  assert.equal(snap.accounts[1].shares, '1'); // bob's dust
  assert.equal(total - alice, 1n);
  const pot = (total * index) / RAY - (total * after) / RAY;
  const ownCut = (alice * index) / RAY - (alice * after) / RAY;
  assert.equal(pot - ownCut, -1n); // the literal formula underflows here

  const paidBefore = e.state(at(4)).stats.totalPaid;
  assert.equal(e.poke(at(5)), 1); // round 4 collapses without throwing
  const s = e.state(at(5));
  assert.equal(s.stats.roundsCollapsed, 2);
  assert.equal(s.stats.totalPaid, paidBefore); // clamped: nothing collected
  const h = e.history(at(5));
  const lastEntry = h[h.length - 1]!;
  assert.ok(lastEntry.kind === 'collapsed' && lastEntry.paid === 0n);
});

test('at most 8 unsaved rounds in a row are charged, then the game is dormant until re-armed', () => {
  const e = withHolders(['alice', 'bob', 'carol']);
  e.volunteer('alice', at(1));
  const supply = e.totalSupply(at(1));
  const bob1 = e.balanceOf('bob', at(1));

  // Rounds 2..9 collapse (8 of them); rounds 10.. are dormant.
  let index = RAY;
  for (let i = 0; i < 8; i++) index = (index * 850_000n) / PPM;
  for (const round of [10, 11, 500, 1_000_000]) {
    const s = e.state(at(round));
    assert.equal(s.round, round);
    assert.equal(s.stats.roundsCollapsed, 8);
    assert.equal(s.collapseRun, 8);
    assert.equal(s.armed, false);
    assert.equal(s.it, 'alice');
    assert.equal(s.index, index);
    assert.ok(supply - s.totalSupply <= 8n);
  }
  // Mid-run views: after 3 collapses the game is still armed.
  const mid = e.state(at(5));
  assert.equal(mid.stats.roundsCollapsed, 3);
  assert.equal(mid.collapseRun, 3);
  assert.equal(mid.armed, true);

  assert.equal(e.poke(at(500)), 9); // 1 saved + 8 collapsed; the dormant rounds are skipped
  assert.equal(e.poke(at(501)), 1); // one dormant round closed by the loop body
  assert.equal(e.poke(at(501)), 0);
  const bobCut = e.balanceOf('bob', at(501));
  assert.ok(absDiff(bobCut, (bob1 * index) / RAY) <= 1n); // 1000 × 0.85^8 ≈ 272.49
  assert.deepEqual(e.history(at(501)).slice(1), [
    { kind: 'collapsed', firstRound: 2, lastRound: 9, count: 8, it: 'alice', paid: e.state(at(501)).stats.totalPaid },
  ]);

  // A dormant round can still be saved: that re-arms the game with a new It.
  const now = at(600, R - 1n);
  e.volunteer('bob', now);
  const armed = e.state(now);
  assert.equal(armed.it, 'bob');
  assert.equal(armed.collapseRun, 0);
  assert.equal(armed.armed, true);
  const paidToAlice = armed.stats.totalPaid;

  const later = e.state(at(700));
  assert.equal(later.stats.roundsCollapsed, 16);
  assert.equal(later.collapseRun, 8);
  assert.equal(later.armed, false);
  const h = e.history(at(700));
  assert.equal(h.length, 4);
  assert.deepEqual(h[3], {
    kind: 'collapsed',
    firstRound: 601,
    lastRound: 608,
    count: 8,
    it: 'bob',
    paid: later.stats.totalPaid - paidToAlice,
  });
  assert.equal(e.account('bob', at(700)).collected, later.stats.totalPaid - paidToAlice);
  assert.equal(e.account('alice', at(700)).collected, paidToAlice);

  // It can re-arm the game itself, too.
  e.volunteer('bob', at(700));
  assert.equal(e.state(at(700)).armed, true);
  assert.equal(e.state(at(800)).stats.roundsCollapsed, 24);
});

test('collapsed rounds are stored run-length encoded', () => {
  const e = withHolders(['alice', 'bob']);
  e.volunteer('alice', at(1));
  // Settle the same run in several calls: the entry is extended, not duplicated.
  e.poke(at(3)); // round 2 collapsed
  assert.equal(e.history(at(3)).length, 2);
  e.poke(at(4)); // round 3
  e.poke(at(6)); // rounds 4, 5
  const h = e.history(at(6));
  assert.equal(h.length, 2);
  const run = h[1]!;
  assert.ok(run.kind === 'collapsed');
  assert.deepEqual([run.firstRound, run.lastRound, run.count, run.it], [2, 5, 4, 'alice']);
  assert.equal(run.paid, e.state(at(6)).stats.totalPaid);

  // A save by somebody else ends the run; later collapses start a new entry for the new It.
  e.volunteer('bob', at(6));
  e.poke(at(9)); // 6 saved, 7 and 8 collapsed
  const h2 = e.history(at(9));
  assert.deepEqual(
    h2.map((x) => x.kind),
    ['saved', 'collapsed', 'saved', 'collapsed'],
  );
  const run2 = h2[3]!;
  assert.ok(run2.kind === 'collapsed');
  assert.deepEqual([run2.firstRound, run2.lastRound, run2.count, run2.it], [7, 8, 2, 'bob']);

  // Same It again after its own save: not adjacent to its old run, so a new entry.
  e.volunteer('bob', at(9));
  e.poke(at(11)); // 9 saved, 10 collapsed
  const h3 = e.history(at(11));
  assert.equal(h3.length, 6);
  const run3 = h3[5]!;
  assert.ok(run3.kind === 'collapsed');
  assert.deepEqual([run3.firstRound, run3.lastRound, run3.count, run3.it], [10, 10, 1, 'bob']);
  assert.equal(e.state(at(11)).stats.roundsCollapsed, 7);
});

test('the settle loop jumps over any number of dormant rounds in one call', () => {
  // Dormant from the start: one loop iteration covers millions of rounds.
  const idle = withHolders(['alice']);
  const far = at(5_000_000, 3n);
  assert.equal(idle.poke(far), 1);
  assert.equal(idle.state(far).round, 5_000_000);
  assert.equal(JSON.parse(idle.snapshot()).round, 5_000_000);
  assert.equal(idle.state(far).roundSupply, CLAIM);
  // Actions work right away, however long nobody called (there is no "behind" state).
  idle.volunteer('alice', far, { round: 5_000_000 });
  assert.equal(idle.state(far).hero, 'alice');

  // Armed: 1 saved + 8 collapsed closes, then the jump.
  assert.equal(idle.poke(at(9_000_000)), MAX_COLLAPSE_RUN + 1);
  const s = idle.state(at(9_000_000));
  assert.equal(s.round, 9_000_000);
  assert.equal(s.stats.roundsSaved, 1);
  assert.equal(s.stats.roundsCollapsed, 8);
  assert.equal(idle.poke(at(9_000_000)), 0);

  // A lone holder who is It pays itself: its balance only moves by rounding.
  assert.ok(CLAIM - s.totalSupply - s.stats.totalBurned <= 8n);
  assert.equal(s.stats.totalPaid, 0n); // net of its own cut, a lone It collects nothing
  assert.ok(absDiff(idle.balanceOf('alice', at(9_000_000)), s.totalSupply) <= 1n);
});

// ---------------------------------------------------------------------------
// unregister
// ---------------------------------------------------------------------------

test('unregister: needs a zero balance unless forced; forced burns the shares', () => {
  const e = withHolders(['alice', 'bob']);
  assert.equal(e.unregister('nobody', false, 0n), false);
  assert.equal(e.unregister('nobody', true, 0n), false);
  assert.equal(e.unregister('alice', false, 0n), false); // has a balance
  assert.equal(e.account('alice', 0n).registered, true);
  e.register('empty');
  assert.equal(e.unregister('empty', false, 0n), true);
  assert.equal(e.account('empty', 0n).registered, false);

  const events: NotItEvent[] = [];
  e.onEvent = (ev) => events.push(ev);
  assert.equal(e.unregister('alice', true, 0n), true);
  assert.deepEqual(events, [
    { standard: 'nep141', version: '1.0.0', event: 'ft_burn', data: [{ owner_id: 'alice', amount: CLAIM.toString() }] },
  ]);
  assert.equal(e.account('alice', 0n).registered, false);
  assert.equal(e.balanceOf('alice', 0n), 0n);
  assert.equal(e.totalSupply(0n), CLAIM);
  // `claimed` survives unregistration.
  assert.equal(e.account('alice', 0n).claimed, true);
  expectError(() => e.claim('alice', 0n), 'ERR_ALREADY_CLAIMED');
  expectError(() => e.transfer('bob', 'alice', 1n, 0n), 'ERR_UNREGISTERED');
});

test('It unregistering makes the game dormant', () => {
  const e = withHolders(['alice', 'bob', 'carol']);
  const { cost } = e.volunteer('alice', at(1));
  e.poke(at(3)); // round 2 collapsed, paid to alice
  const paid = e.state(at(3)).stats.totalPaid;
  assert.ok(paid > 0n);
  const bob = e.balanceOf('bob', at(3));

  assert.equal(e.unregister('alice', true, at(3)), true);
  const s = e.state(at(3));
  assert.equal(s.it, null);
  assert.equal(s.armed, false);
  assert.equal(e.account('alice', at(3)).isIt, false);
  assert.equal(JSON.parse(e.snapshot()).it, null);

  // Nothing is charged any more...
  const later = e.state(at(40));
  assert.equal(later.stats.roundsCollapsed, 1);
  assert.equal(later.stats.totalPaid, paid);
  assert.equal(e.balanceOf('bob', at(40)), bob);
  assert.equal(e.poke(at(40)), 1);
  // ...the hero record survives...
  assert.deepEqual(e.heroes(at(40)), [{ accountId: 'alice', saves: 1, burned: cost, collected: paid }]);
  assert.equal(e.account('alice', at(40)).collected, paid);
  // ...and the next volunteer re-arms the game.
  e.volunteer('bob', at(40));
  assert.equal(e.state(at(40)).armed, true);
  assert.equal(e.state(at(42)).stats.roundsCollapsed, 2);

  // Re-registering does not make the old It "It" again.
  const f = withHolders(['alice', 'bob']);
  f.volunteer('alice', at(1));
  f.unregister('alice', true, at(1));
  f.register('alice');
  assert.equal(f.state(at(5)).it, null);
  assert.equal(f.state(at(5)).stats.roundsCollapsed, 0);
});

test('unregister settles first: It is paid for pending rounds before it leaves', () => {
  const build = (): NotIt => {
    const x = withHolders(['alice', 'bob', 'carol']);
    x.volunteer('alice', at(1));
    x.transfer('alice', 'bob', x.balanceOf('alice', at(1)), at(1)); // alice is It with zero shares
    return x;
  };
  // Nothing pending: an empty It can leave without force.
  const calm = build();
  assert.equal(calm.balanceOf('alice', at(1)), 0n);
  assert.equal(calm.unregister('alice', false, at(1, R - 1n)), true);
  assert.equal(calm.state(at(9)).it, null);
  assert.equal(calm.state(at(9)).stats.roundsCollapsed, 0);

  // Rounds 2..4 ended unsaved and nobody has called since: settling pays alice three
  // pots, so she is no longer empty and the unforced unregister is refused.
  const e = build();
  const before = e.snapshot();
  const owed = e.balanceOf('alice', at(5));
  const supply = e.totalSupply(at(5));
  assert.ok(owed > 0n);
  assert.equal(e.unregister('alice', false, at(5)), false);
  assert.equal(e.snapshot(), before); // refused: nothing written, not even the settlement
  assert.equal(JSON.parse(before).round, 1);

  // Forced: the settlement is committed (three collapses paid to alice), then her shares are burned.
  const events: NotItEvent[] = [];
  e.onEvent = (ev) => events.push(ev);
  assert.equal(e.unregister('alice', true, at(5)), true);
  const s = e.state(at(5));
  assert.equal(JSON.parse(e.snapshot()).round, 5);
  assert.equal(s.stats.roundsCollapsed, 3);
  assert.equal(s.stats.roundsSaved, 1);
  assert.ok(absDiff(s.stats.totalPaid, owed) <= 3n); // she had nothing, so what she collected is what she held
  assert.equal(s.it, null);
  assert.equal(s.armed, false);
  assert.equal(e.account('alice', at(5)).registered, false);
  assert.equal(e.account('alice', at(5)).collected, s.stats.totalPaid);
  assert.ok(absDiff(s.totalSupply, supply - owed) <= 3n);
  assert.deepEqual(
    events.map((ev) => ev.event),
    ['rounds_closed', 'ft_burn'],
  );
  assert.deepEqual(events[1]!.data, [{ owner_id: 'alice', amount: owed.toString() }]);
  const run = e.history(at(5)).at(-1)!;
  assert.ok(run.kind === 'collapsed' && run.count === 3 && run.it === 'alice');
  // The rest of the crowd keeps the 15 % cuts they paid; nothing more is charged.
  assert.equal(e.state(at(40)).stats.roundsCollapsed, 3);

  // Views agree with what a forced unregister then does (virtual settlement is the same code).
  const g = build();
  assert.equal(g.account('alice', at(5)).balance, owed);
});

// ---------------------------------------------------------------------------
// transfer
// ---------------------------------------------------------------------------

test('transfer moves the amount and conserves total shares', () => {
  const e = withHolders(['alice', 'bob']);
  e.register('carol');
  const sharesBefore = JSON.parse(e.snapshot()).total_shares;
  e.transfer('alice', 'carol', 300n * UNIT, 0n);
  assert.equal(e.balanceOf('alice', 0n), 700n * UNIT);
  assert.equal(e.balanceOf('carol', 0n), 300n * UNIT);
  assert.equal(e.totalSupply(0n), 2n * CLAIM);
  assert.equal(JSON.parse(e.snapshot()).total_shares, sharesBefore);

  // After a collapse the index is no longer RAY: the receiver gets at least `amount`,
  // the sender pays at most one unit more, and total shares still do not move.
  e.volunteer('bob', at(1));
  e.poke(at(3));
  const now = at(3);
  const shares = JSON.parse(e.snapshot()).total_shares;
  const a = e.balanceOf('alice', now);
  const c = e.balanceOf('carol', now);
  const amount = 123_456_789_123_456_789n;
  e.transfer('alice', 'carol', amount, now);
  const got = e.balanceOf('carol', now) - c;
  const paid = a - e.balanceOf('alice', now);
  assert.ok(got >= amount && got - amount <= 1n);
  assert.ok(paid >= amount && paid - amount <= 1n);
  assert.equal(JSON.parse(e.snapshot()).total_shares, shares);
  // The whole balance can always be sent.
  const all = e.balanceOf('alice', now);
  e.transfer('alice', 'carol', all, now);
  assert.equal(e.balanceOf('alice', now), 0n);
  assert.equal(JSON.parse(e.snapshot()).total_shares, shares);
});

test('transfer rejects zero, self, unregistered and insufficient', () => {
  const e = withHolders(['alice', 'bob']);
  const before = e.snapshot();
  expectError(() => e.transfer('alice', 'bob', 0n, 0n), 'ERR_ZERO_AMOUNT');
  expectError(() => e.transfer('alice', 'alice', 1n, 0n), 'ERR_SELF_TRANSFER');
  expectError(() => e.transfer('alice', 'nobody', 1n, 0n), 'ERR_UNREGISTERED');
  expectError(() => e.transfer('nobody', 'alice', 1n, 0n), 'ERR_UNREGISTERED');
  expectError(() => e.transfer('alice', 'bob', CLAIM + 1n, 0n), 'ERR_INSUFFICIENT');
  // Order of the checks: zero amount, then self, then registration.
  expectError(() => e.transfer('nobody', 'nobody', 0n, 0n), 'ERR_ZERO_AMOUNT');
  expectError(() => e.transfer('nobody', 'nobody', 1n, 0n), 'ERR_SELF_TRANSFER');
  assert.equal(e.snapshot(), before);
  e.transfer('alice', 'bob', CLAIM, 0n);
  assert.equal(e.balanceOf('bob', 0n), 2n * CLAIM);
});

// ---------------------------------------------------------------------------
// Rescale
// ---------------------------------------------------------------------------

/** alice volunteers at the last nanosecond every 9th round, so 8 collapses follow each save. */
function collapseUntilRescale(e: NotIt, hero: string, ids: string[]): { round: number; before: bigint[]; after: bigint[] } {
  let round = 1;
  for (let cycle = 0; cycle < 40; cycle++) {
    e.volunteer(hero, at(round, R - 1n), { round });
    for (let k = 1; k <= 8; k++) {
      const scaleBefore = e.state(at(round + k)).scale;
      const before = ids.map((id) => e.balanceOf(id, at(round + k)));
      e.poke(at(round + k + 1)); // closes round + k as collapsed
      if (e.state(at(round + k + 1)).scale !== scaleBefore) {
        return { round: round + k + 1, before, after: ids.map((id) => e.balanceOf(id, at(round + k + 1))) };
      }
    }
    round += 9;
  }
  throw new Error('no rescale happened');
}

test('rescale: balances agree across it and accounts catch up lazily', () => {
  const ids = ['alice', 'bob', 'carol'];
  const e = withHolders(ids);
  const supply0 = e.totalSupply(0n);
  const { round, before, after } = collapseUntilRescale(e, 'alice', ids);
  const now = at(round);
  const s = e.state(now);
  assert.equal(s.scale, 1);
  assert.equal(s.stats.roundsCollapsed, 128); // 0.85^128 < 10^-9
  assert.ok(s.index >= RESCALE_BELOW && s.index < RAY);

  // Across the rescaling collapse: bob and carol are cut by 15 % as usual, It gets the pot.
  assert.ok(absDiff(after[1]!, (before[1]! * 85n) / 100n) <= 2n);
  assert.ok(absDiff(after[2]!, (before[2]! * 85n) / 100n) <= 2n);
  const sumBefore = before[0]! + before[1]! + before[2]!;
  const sumAfter = after[0]! + after[1]! + after[2]!;
  assert.ok(absDiff(sumBefore, sumAfter) <= 4n);
  assert.ok(sumAfter <= s.totalSupply && s.totalSupply - sumAfter <= 4n);
  // Nothing but the burns has left the supply in 128 collapses (rounding only).
  assert.ok(supply0 - s.stats.totalBurned - s.totalSupply <= 300n);

  // Stored state: the global scale moved, accounts did not (snapshot is not normalised).
  const snap = JSON.parse(e.snapshot());
  assert.equal(snap.scale, 1);
  const stored = (id: string): { shares: string; scale: number } => snap.accounts.find((a: { id: string }) => a.id === id);
  assert.equal(stored('bob').scale, 0);
  assert.equal(stored('carol').scale, 0);
  assert.equal(stored('alice').scale, 0); // It was normalised (step 4) before the rescale (step 5)
  assert.equal(stored('bob').shares, CLAIM.toString()); // untouched since the claim
  assert.equal(effectiveShares(BigInt(stored('bob').shares), 0, 1), CLAIM / RESCALE_FACTOR);
  assert.equal(e.balanceOf('bob', now), ((CLAIM / RESCALE_FACTOR) * s.index) / RAY);

  // A write normalises: bob sends half to carol; both are now stored at scale 1 and still add up.
  const bob = e.balanceOf('bob', now);
  const carol = e.balanceOf('carol', now);
  e.transfer('bob', 'carol', bob / 2n, now);
  const snap2 = JSON.parse(e.snapshot());
  const stored2 = (id: string): { shares: string; scale: number } => snap2.accounts.find((a: { id: string }) => a.id === id);
  assert.equal(stored2('bob').scale, 1);
  assert.equal(stored2('carol').scale, 1);
  assert.equal(stored2('alice').scale, 0);
  assert.equal(snap2.total_shares, snap.total_shares);
  assert.ok(absDiff(e.balanceOf('bob', now) + e.balanceOf('carol', now), bob + carol) <= 2n);
  assert.ok(absDiff(e.balanceOf('carol', now), carol + bob / 2n) <= 2n);

  // The normalised accounts keep working: claim, volunteer, collapse, views.
  e.claim('dave', now);
  assert.ok(absDiff(e.balanceOf('dave', now), CLAIM) <= 2n);
  assert.equal(JSON.parse(e.snapshot()).accounts.find((a: { id: string }) => a.id === 'dave').scale, 1);
  const t = at(round + 1, R - 1n);
  const cost = e.costAt(t);
  const daveBefore = e.balanceOf('dave', t);
  e.volunteer('dave', t, { round: round + 1 });
  const burned = daveBefore - e.balanceOf('dave', t);
  assert.ok(burned >= cost && burned - cost <= 2n);
  assert.equal(e.state(t).it, 'dave');
  // The old It (stored at scale 0) is normalised on its next write and keeps its balance.
  const alice = e.balanceOf('alice', t);
  e.transfer('alice', 'bob', 1n, t);
  assert.equal(JSON.parse(e.snapshot()).accounts.find((a: { id: string }) => a.id === 'alice').scale, 1);
  assert.ok(absDiff(e.balanceOf('alice', t), alice - 1n) <= 2n);

  const supply = e.totalSupply(t);
  const views = viewsAt(e, [...ids, 'dave'], at(round + 4));
  e.poke(at(round + 4)); // dave's round saved, then 2 collapses paid to dave
  assert.deepEqual(viewsAt(e, [...ids, 'dave'], at(round + 4)), views);
  assert.equal(e.state(at(round + 4)).stats.roundsCollapsed, 130);
  assert.ok(supply - e.totalSupply(at(round + 4)) <= 2n);
});

test('rescale: virtual views across a pending rescale equal the stored result', () => {
  const ids = ['alice', 'bob', 'carol'];
  const a = withHolders(ids);
  const b = withHolders(ids);
  // Drive both engines identically until just before the rescaling collapse...
  const { round } = collapseUntilRescale(a, 'alice', ids);
  let r = 1;
  while (r + 9 < round) {
    b.volunteer('alice', at(r, R - 1n), { round: r });
    r += 9;
    b.poke(at(r));
  }
  b.volunteer('alice', at(r, R - 1n), { round: r });
  // ...then let `b` see the rest of the run only through views.
  assert.equal(JSON.parse(b.snapshot()).scale, 0);
  const now = at(r + 9, 5n);
  const views = viewsAt(b, ids, now);
  assert.equal(b.state(now).scale, 1);
  assert.equal(b.state(now).stats.roundsCollapsed, 128);
  b.poke(now);
  assert.equal(JSON.parse(b.snapshot()).scale, 1);
  assert.deepEqual(viewsAt(b, ids, now), views);
  // And it matches the engine that settled round by round.
  a.poke(now);
  assert.equal(a.snapshot(), b.snapshot());
});

// ---------------------------------------------------------------------------
// Views and snapshot
// ---------------------------------------------------------------------------

test('views with virtual settlement equal the state after poke()', () => {
  const ids = ['alice', 'bob', 'carol', 'nobody'];
  const e = withHolders(['alice', 'bob', 'carol']);
  e.volunteer('alice', at(1, R / 3n));
  e.volunteer('bob', at(2, R - 1n));

  for (const now of [at(2, R - 1n), at(3), at(4, 17n), at(7, R / 2n), at(11), at(12), at(1000, 1n)]) {
    const stored = e.snapshot();
    const virtual = viewsAt(e, ids, now);
    assert.equal(e.snapshot(), stored, 'views must not write');
    const fresh = withHolders(['alice', 'bob', 'carol']);
    fresh.volunteer('alice', at(1, R / 3n));
    fresh.volunteer('bob', at(2, R - 1n));
    fresh.poke(now);
    assert.deepEqual(viewsAt(fresh, ids, now), virtual, `poke then view at ${now}`);
  }

  // The same on one engine, settling as it goes (extends the stored run-length entry).
  for (const now of [at(4), at(6, 9n), at(30)]) {
    const virtual = viewsAt(e, ids, now);
    e.poke(now);
    assert.deepEqual(viewsAt(e, ids, now), virtual);
  }
  const s = e.state(at(30));
  assert.equal(s.round, 30);
  assert.equal(s.roundStartNs, at(30));
  assert.equal(s.roundEndNs, at(31));
  assert.equal(s.nowNs, at(30));
  assert.equal(s.stats.roundsSaved, 2);
  assert.equal(s.stats.roundsCollapsed, 8);
  assert.equal(e.history(at(30)).length, 3);
});

test('a failed action reverts the settlement it ran', () => {
  const e = withHolders(['alice', 'bob']);
  e.volunteer('alice', at(1));
  const before = e.snapshot();
  expectError(() => e.volunteer('nobody', at(5)), 'ERR_INSUFFICIENT');
  expectError(() => e.transfer('alice', 'bob', 0n, at(5)), 'ERR_ZERO_AMOUNT');
  expectError(() => e.claim('alice', at(5)), 'ERR_ALREADY_CLAIMED');
  expectError(() => e.volunteer('bob', at(5), { round: 4 }), 'ERR_WRONG_ROUND');
  assert.equal(e.snapshot(), before);
  assert.equal(JSON.parse(e.snapshot()).round, 1);
  // A successful action commits the settlement together with its own writes.
  e.transfer('alice', 'bob', 1n, at(5));
  const snap = JSON.parse(e.snapshot());
  assert.equal(snap.round, 5);
  assert.equal(snap.stats.rounds_collapsed, 3);
  // Affordability is judged after the pending collapses: It can spend the pot it is owed.
  const f = withHolders(['alice', 'bob']);
  f.volunteer('alice', at(1));
  const owed = f.balanceOf('alice', at(9));
  assert.ok(owed > CLAIM);
  f.transfer('alice', 'bob', owed, at(9));
  assert.equal(f.balanceOf('alice', at(9)), 0n);
});

test('snapshot() is canonical and stable', () => {
  const e = make();
  assert.equal(
    e.snapshot(),
    '{"index":"1000000000000000000000000000","scale":0,"total_shares":"0","round":0,"round_supply":"0",' +
      '"round_hero":null,"it":null,"collapse_run":0,"claims_made":0,' +
      '"stats":{"rounds_saved":0,"rounds_collapsed":0,"current_streak":0,"longest_streak":0,' +
      '"closest_call_ms":null,"total_burned":"0","total_paid":"0"},' +
      '"accounts":[],"heroes":[],"history":[]}',
  );

  const build = (order: string[]): NotIt => {
    const x = make();
    for (const id of order) x.claim(id, 0n);
    x.register('zed');
    x.volunteer('carol', at(1, R / 2n)); // 3000 × 2.6 % = 78
    x.volunteer('alice', at(2)); // 2922 × 5 % = 146.1
    x.poke(at(4)); // round 2 saved, round 3 collapsed
    return x;
  };
  const a = build(['bob', 'alice', 'carol']);
  const golden =
    '{"index":"850000000000000000000000000","scale":0,"total_shares":"3265764705882352941176","round":4,' +
    '"round_supply":"2775899999999999999999","round_hero":null,"it":"alice","collapse_run":1,"claims_made":3,' +
    '"stats":{"rounds_saved":2,"rounds_collapsed":1,"current_streak":0,"longest_streak":2,' +
    '"closest_call_ms":90000,"total_burned":"224100000000000000000","total_paid":"288300000000000000000"},' +
    '"accounts":[{"id":"alice","shares":"1343764705882352941176","scale":0,"claimed":true},' +
    '{"id":"bob","shares":"1000000000000000000000","scale":0,"claimed":true},' +
    '{"id":"carol","shares":"922000000000000000000","scale":0,"claimed":true},' +
    '{"id":"zed","shares":"0","scale":0,"claimed":false}],' +
    '"heroes":[{"id":"alice","saves":1,"burned":"146100000000000000000","collected":"288300000000000000000"},' +
    '{"id":"carol","saves":1,"burned":"78000000000000000000","collected":"0"}],' +
    '"history":[{"kind":"saved","round":1,"hero":"carol","cost":"78000000000000000000","ms_left":90000},' +
    '{"kind":"saved","round":2,"hero":"alice","cost":"146100000000000000000","ms_left":180000},' +
    '{"kind":"collapsed","first_round":3,"last_round":3,"count":1,"it":"alice","paid":"288300000000000000000"}]}';
  assert.equal(a.snapshot(), golden);
  assert.equal(a.snapshot(), a.snapshot());
  // Views do not disturb it, and the insertion order of accounts does not matter.
  viewsAt(a, ['alice', 'bob'], at(50));
  assert.equal(a.snapshot(), golden);
  assert.equal(build(['carol', 'bob', 'alice']).snapshot(), golden);
  // It is valid JSON with the key order of SPEC §8.
  assert.deepEqual(Object.keys(JSON.parse(golden)), [
    'index',
    'scale',
    'total_shares',
    'round',
    'round_supply',
    'round_hero',
    'it',
    'collapse_run',
    'claims_made',
    'stats',
    'accounts',
    'heroes',
    'history',
  ]);
});

test('events mirror the NEP-297 logs of successful calls', () => {
  const e = make();
  const events: NotItEvent[] = [];
  e.onEvent = (ev) => events.push(ev);
  e.claim('alice', 0n);
  e.claim('bob', 0n);
  e.volunteer('alice', at(1));
  e.transfer('alice', 'bob', 5n, at(1));
  expectError(() => e.volunteer('bob', at(1)), 'ERR_ALREADY_SAVED');
  e.poke(at(4));
  const s = e.state(at(4));
  assert.deepEqual(
    events.map((ev) => ev.event),
    ['ft_mint', 'ft_mint', 'rounds_closed', 'ft_burn', 'round_saved', 'ft_transfer', 'rounds_closed'],
  );
  assert.deepEqual(events[2]!.data, {
    from_round: 0,
    to_round: 1,
    saved: 0,
    collapsed: 0,
    paid: '0',
    it: null,
    index: RAY.toString(),
    scale: 0,
  });
  assert.deepEqual(events[4]!.data, { round: 1, hero: 'alice', cost: (100n * UNIT).toString(), ms_left: 180_000 });
  assert.deepEqual(events[6]!.data, {
    from_round: 1,
    to_round: 4,
    saved: 1,
    collapsed: 2,
    paid: s.stats.totalPaid.toString(),
    it: 'alice',
    index: s.index.toString(),
    scale: 0,
  });
});
