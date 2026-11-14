import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatLab,
  formatTokens,
  labToJson,
  runBystander,
  runDispersed,
  runForwardLooking,
  runLab,
  runMixedCrowd,
  runWhoPays,
} from '../src/index.ts';

test('lab output is deterministic: two full runs give the same JSON and the same text', () => {
  const first = runLab();
  const second = runLab();
  const json = labToJson(first);
  assert.equal(labToJson(second), json);
  assert.equal(formatLab(second), formatLab(first));
  // The JSON is plain data (bigints as decimal strings) and round-trips.
  const parsed = JSON.parse(json);
  assert.deepEqual(Object.keys(parsed), ['bystander', 'whoPays', 'dispersed', 'mixedCrowd', 'forwardLooking']);
  assert.equal(typeof parsed.mixedCrowd.supplyStart, 'string');
  assert.equal(labToJson(parsed), json);

  // A. Simulation tracks the first-pays equilibrium; the big crowds never save.
  assert.deepEqual(
    first.bystander.rows.map((r) => r.n),
    [3, 5, 10, 20, 30, 45, 60, 75, 100],
  );
  for (const r of first.bystander.rows) {
    assert.equal(r.trials, 2000);
    // Within sampling error of the equilibrium: 3.5 standard errors of a binomial share.
    const se = Math.sqrt((r.equilibriumFail * (1 - r.equilibriumFail)) / r.trials);
    assert.ok(Math.abs(r.diff) <= 3.5 * se, `N=${r.n}: equilibrium ${r.equilibriumFail}, simulated ${r.simulated}`);
    assert.equal(r.diff, r.simulated - r.equilibriumFail);
    assert.equal(r.simulated, r.failed / r.trials);
    // Older field names still carry the equilibrium values.
    assert.equal(r.p, r.equilibriumP);
    assert.equal(r.theory, r.equilibriumFail);
    // Only the first volunteer pays, so the round fails less often than in the textbook dilemma.
    if (r.q < 1) assert.ok(r.equilibriumFail < r.classicFail && r.equilibriumP > r.classicP);
    else assert.deepEqual([r.equilibriumFail, r.classicFail, r.equilibriumP], [1, 1, 0]);
  }
  const theory = first.bystander.rows.map((r) => r.theory);
  for (let i = 1; i < theory.length; i++) assert.ok(theory[i]! >= theory[i - 1]!);
  assert.equal(first.bystander.rows[8]!.theory, 1);
  assert.equal(first.bystander.rows[8]!.simulated, 1);

  // B. Two strategies from the same armed start; myopic holders never start a cold game.
  assert.deepEqual(
    first.whoPays.runs.map((r) => r.strategy),
    ['rationalTimer', 'throneAware'],
  );
  for (const r of first.whoPays.runs) {
    assert.ok(Math.abs(r.savedShare + r.collapsedShare + r.dormantShare - 1) < 1e-12);
    assert.ok(r.giniEnd >= 0 && r.giniEnd < 1);
  }
  assert.equal(first.whoPays.coldStart[0]!.savedShare, 0);
  assert.equal(first.whoPays.coldStart[0]!.firstSavedRound, null);
  assert.ok(first.whoPays.coldStart[1]!.savedShare > 0.9);

  // B2. 100 equal holders: myopic ones let It collect 8 rounds and then the game sleeps;
  // throne-aware ones keep contesting.
  const d = first.dispersed;
  assert.equal(d.holders, 100);
  assert.deepEqual(
    d.runs.map((r) => r.strategy),
    ['rationalTimer', 'throneAware'],
  );
  const [myopic, throne] = [d.runs[0]!, d.runs[1]!];
  assert.equal(myopic.savedShare, 0);
  assert.equal(myopic.collapsedShare, 8 / 500);
  assert.equal(myopic.totalBurned, 0n);
  assert.ok(Math.abs(myopic.itSupplyShareEnd - (1 - 0.99 * Math.pow(0.85, 8))) < 0.01);
  assert.ok(myopic.totalPaid > 0n && myopic.supplyEnd <= d.supplyStart && d.supplyStart - myopic.supplyEnd <= 8n);
  assert.ok(throne.savedShare > 0.9);
  assert.ok(throne.totalBurned > 0n);
  assert.ok(throne.itSupplyShareEnd < 0.5);

  // D. The free-entry bound from the config, next to the throneAware crowds.
  const f = first.forwardLooking;
  assert.ok(Math.abs(f.bound - 0.002 / 0.152) < 1e-15); // 1.32 % with the deployed parameters
  assert.deepEqual(
    f.runs.map((r) => r.holders),
    [20, 50, 100, 200],
  );
  for (const r of f.runs) {
    assert.equal(r.saved + r.collapsed + r.dormant, f.rounds);
    assert.equal(r.unsavedRate, (r.collapsed + r.dormant) / f.rounds);
    assert.equal(r.withinBound, r.unsavedRate <= f.bound);
  }
  assert.ok(f.runs.slice(0, 3).every((r) => r.withinBound));
  // The 100-holder run is the throneAware run of B2.
  assert.ok(Math.abs(f.runs[2]!.unsavedRate - (1 - throne.savedShare)) < 1e-12);

  // C. The free riders lose share to the accounts that volunteer.
  const c = first.mixedCrowd;
  assert.equal(c.holders, 40);
  assert.equal(c.saved + c.collapsed + c.dormant, 1000);
  assert.equal(c.freeRiderShareStart, 0.75);
  assert.ok(c.freeRiderShareEnd < c.freeRiderShareStart);
  assert.ok(c.supplyEnd < c.supplyStart);
});

test('experiments take custom parameters', () => {
  const a = runBystander({ ns: [4, 8], trials: 200, seed: 5 });
  assert.equal(a.rows.length, 2);
  assert.equal(a.trials, 200);
  assert.deepEqual(a, runBystander({ ns: [4, 8], trials: 200, seed: 5 }));
  // q = c / (cut × x) from the actual numbers of the armed round.
  for (const r of a.rows) {
    assert.ok(Math.abs(r.q - Number(r.finalCost) / (0.15 * Number(r.playerBalance))) < 1e-15);
    assert.equal(r.playerBalance, 1000n * 10n ** 18n);
  }

  const b = runWhoPays({ holders: 12, rounds: 40, seed: 9, strategies: [{ kind: 'throneAware', patience: 0.5 }] });
  assert.equal(b.runs.length, 1);
  assert.equal(b.coldStart.length, 1);
  assert.equal(b.holders, 12);

  const d = runDispersed({ holders: 20, rounds: 30, seed: 3, strategies: [{ kind: 'rationalTimer' }] });
  assert.equal(d.holders, 20);
  assert.equal(d.initialIt, 'holder-20');
  assert.equal(d.runs.length, 1);
  assert.equal(d.runs[0]!.savedShare, 1); // 5 % each is above the 1.33 % threshold

  const f = runForwardLooking({ holders: [10], rounds: 50, config: { minCostPpm: 3_000, cutPpm: 100_000 } });
  assert.ok(Math.abs(f.bound - 0.003 / 0.103) < 1e-15);
  assert.equal(f.runs.length, 1);
  assert.equal(f.runs[0]!.holderShare, 0.1);

  const c = runMixedCrowd({ altruists: 2, snipers: 2, freeRiders: 6, rounds: 100, seed: 4, h: 0.5, missRate: 0.1 });
  assert.equal(c.holders, 10);
  assert.deepEqual(
    c.groups.map((g) => g.count),
    [2, 2, 6],
  );
  assert.equal(c.freeRiderShareStart, 0.6);
});

test('formatTokens is locale-independent', () => {
  assert.equal(formatTokens(0n), '0.00');
  assert.equal(formatTokens(1_234_567_891_234_567_890_123_456n), '1,234,567.89');
  assert.equal(formatTokens(999_999_999_999_999_999n), '0.99');
  assert.equal(formatTokens(1_000n * 10n ** 18n, 0), '1,000');
});
