import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NotIt } from '../src/index.ts';
import {
  SCENARIO_ACCOUNTS,
  SCENARIO_CONFIG,
  SNAPSHOT_EVERY,
  applyStep,
  fromScenarioConfig,
  generateScenarios,
  replayScenarios,
  scenariosToJson,
} from '../src/scenarios.ts';
import type { ScenarioFile } from '../src/scenarios.ts';

interface Snap {
  scale: number;
  round: number;
  it: string | null;
  total_shares: string;
  stats: { rounds_collapsed: number; total_paid: string };
  accounts: { id: string; shares: string }[];
  heroes: { id: string; collected: string }[];
  history: { kind: string; paid?: string; it?: string; count?: number }[];
}

const file = generateScenarios();
const json = scenariosToJson(file);

test('scenarios are deterministic: two runs give byte-identical JSON', () => {
  assert.equal(scenariosToJson(generateScenarios()), json);
  assert.notEqual(scenariosToJson(generateScenarios({ seed: 1000 })), json);
  // The file is plain JSON and stays under the size budget.
  const parsed = JSON.parse(json) as ScenarioFile;
  assert.deepEqual(parsed, file);
  assert.ok(json.length < 700_000, `scenarios.json is ${json.length} bytes`);
});

test('scenarios replay on a fresh engine: every error code and every snapshot matches', () => {
  assert.deepEqual(replayScenarios(JSON.parse(json) as ScenarioFile), []);
  // The replayer does notice differences.
  const broken = JSON.parse(json) as ScenarioFile;
  const step = broken.scenarios[0]!.steps.find((s) => s.error === null && s.op === 'volunteer')!;
  step.error = 'ERR_ALREADY_SAVED';
  assert.equal(replayScenarios(broken).length, 1);
});

test('scenario file follows the agreed format', () => {
  assert.deepEqual(file.config, {
    round_ns: '100000000000',
    max_cost_ppm: 50000,
    min_cost_ppm: 2000,
    cut_ppm: 150000,
    claim_amount: '1000000000000000000000',
    claim_cap: 100000,
    genesis_ns: '1000000000000000000',
  });
  assert.deepEqual(fromScenarioConfig(file.config), { ...SCENARIO_CONFIG });
  assert.deepEqual(
    file.scenarios.map((s) => s.name.replace(/-\d+$/, '')).filter((n, i, all) => all.indexOf(n) === i),
    ['mixed', 'rescale', 'net-paid-clamp', 'it-unregisters'],
  );
  assert.equal(file.scenarios.filter((s) => s.name.startsWith('rescale-')).length, 6);
  assert.equal(new Set(file.scenarios.map((s) => s.seed)).size, file.scenarios.length);

  const keys: Record<string, string[]> = {
    claim: ['op', 'caller', 'now', 'error'],
    volunteer: ['op', 'caller', 'now', 'round', 'max_cost', 'error'],
    transfer: ['op', 'caller', 'to', 'amount', 'now', 'error'],
    unregister: ['op', 'caller', 'force', 'now', 'error'],
    register: ['op', 'caller', 'now', 'error'],
    poke: ['op', 'caller', 'now', 'error'],
  };
  const genesis = BigInt(file.config.genesis_ns);
  for (const s of file.scenarios) {
    let prev = genesis;
    s.steps.forEach((step, i) => {
      const now = BigInt(step.now);
      assert.ok(now >= prev, `${s.name} step ${i}: now went backwards`);
      prev = now;
      assert.ok(SCENARIO_ACCOUNTS.includes(step.caller));
      if (step.to !== undefined) assert.ok(SCENARIO_ACCOUNTS.includes(step.to));
      assert.deepEqual(
        Object.keys(step).filter((k) => k !== 'snapshot'),
        keys[step.op],
      );
      assert.ok(step.error === null || /^ERR_[A-Z_]+$/.test(step.error));
      const last = i === s.steps.length - 1;
      if ((i + 1) % SNAPSHOT_EVERY === 0 || last) {
        assert.equal(typeof step.snapshot, 'object', `${s.name} step ${i} needs a snapshot`);
        assert.equal(Object.keys(step).at(-1), 'snapshot');
      }
    });
  }
});

test('scenarios cover the errors, the guards, unregistration and the rescale', () => {
  const steps = file.scenarios.flatMap((s) => s.steps);
  const errors = new Set(steps.map((s) => s.error));
  for (const code of [
    null,
    'ERR_ALREADY_CLAIMED',
    'ERR_ALREADY_SAVED',
    'ERR_NOTHING_TO_SAVE',
    'ERR_WRONG_ROUND',
    'ERR_COST_TOO_HIGH',
    'ERR_INSUFFICIENT',
    'ERR_UNREGISTERED',
    'ERR_ZERO_AMOUNT',
    'ERR_SELF_TRANSFER',
  ]) {
    assert.ok(errors.has(code), `no step expects ${String(code)}`);
  }
  for (const op of ['claim', 'volunteer', 'transfer', 'unregister', 'register', 'poke']) {
    assert.ok(steps.filter((s) => s.op === op).length >= 20, `too few ${op} steps`);
  }
  // Guards: none, round only, max_cost only, both; and both kinds succeed somewhere.
  const vol = steps.filter((s) => s.op === 'volunteer');
  assert.ok(vol.some((s) => s.round === null && s.max_cost === null && s.error === null));
  assert.ok(vol.some((s) => s.round !== null && s.max_cost !== null && s.error === null));
  assert.ok(vol.some((s) => s.round !== null && s.max_cost === null));
  assert.ok(vol.some((s) => s.round === null && s.max_cost !== null));
  // Unregister: forced and unforced, each followed later by a failed re-claim of the same account.
  assert.ok(steps.some((s) => s.op === 'unregister' && s.force === true));
  assert.ok(steps.some((s) => s.op === 'unregister' && s.force === false));
  assert.ok(steps.every((s) => s.op !== 'unregister' || s.error === null));
  assert.ok(steps.every((s) => s.op !== 'register' || s.error === null));
  let reclaims = 0;
  let itVolunteers = 0;
  let unregisteredIt = 0;
  let unregisteredItWithPending = 0;
  const config = fromScenarioConfig(file.config);
  for (const s of file.scenarios) {
    const engine = new NotIt(config);
    const gone = new Set<string>();
    for (const step of s.steps) {
      const it = (JSON.parse(engine.snapshot()) as Snap).it;
      if (step.op === 'volunteer' && step.caller === it && step.error === null) itVolunteers += 1;
      if (step.op === 'unregister' && step.caller === it) {
        unregisteredIt += 1;
        // Pending: rounds that will close as collapsed when this very call settles.
        const stored = (JSON.parse(engine.snapshot()) as Snap).stats.rounds_collapsed;
        if (engine.state(BigInt(step.now)).stats.roundsCollapsed > stored) unregisteredItWithPending += 1;
      }
      if (step.op === 'claim' && gone.has(step.caller)) {
        assert.equal(step.error, 'ERR_ALREADY_CLAIMED');
        reclaims += 1;
      }
      applyStep(engine, step);
      if (step.op === 'unregister' && (engine.account(step.caller, BigInt(step.now)).claimed)) gone.add(step.caller);
    }
  }
  assert.ok(reclaims >= 20, `only ${reclaims} re-claims after unregistering`);
  assert.ok(itVolunteers >= 20, `only ${itVolunteers} volunteers by the current It`);
  assert.ok(unregisteredIt >= 3, `It unregisters only ${unregisteredIt} times`);
  assert.ok(unregisteredItWithPending >= 2, 'It never unregisters with collapses pending');

  // Time steps: same block, inside a round, a few rounds, and long jumps.
  const R = BigInt(file.config.round_ns);
  const gaps = file.scenarios.flatMap((s) => s.steps.slice(1).map((step, i) => BigInt(step.now) - BigInt(s.steps[i]!.now)));
  assert.ok(gaps.filter((g) => g === 0n).length > 50);
  assert.ok(gaps.filter((g) => g > 0n && g < R / 8n).length > 300);
  assert.ok(gaps.filter((g) => g >= R / 2n && g <= 3n * R).length > 200);
  assert.ok(gaps.filter((g) => g >= 9n * R).length > 100);

  // Rescale: every rescale scenario crosses 10^18 at least once, one of them twice.
  const finals = file.scenarios
    .filter((s) => s.name.startsWith('rescale-'))
    .map((s) => s.steps.at(-1)!.snapshot as Snap);
  assert.equal(finals.length, 6);
  for (const f of finals) assert.ok(f.scale >= 1 && f.stats.rounds_collapsed >= 128);
  assert.ok(finals.some((f) => f.scale >= 2));
  const snapshots = steps.filter((s) => s.snapshot !== undefined).map((s) => s.snapshot as Snap);
  assert.ok(snapshots.some((x) => x.scale >= 1));
  assert.ok(snapshots.some((x) => x.scale === 0 && x.stats.rounds_collapsed > 0));
});

test('the net-paid-clamp scenario hits the rounding case of step 3b', () => {
  const s = file.scenarios.find((x) => x.name === 'net-paid-clamp')!;
  assert.ok(s.steps.every((step) => step.error === null));
  // The collapse of round 4 pays nothing net: total_paid is the same before and after it.
  const withSnap = s.steps.filter((step) => step.snapshot !== undefined).map((step) => step.snapshot as Snap);
  assert.equal(withSnap.length, 3);
  const [before, after] = [withSnap[0]!, withSnap[1]!];
  assert.equal(after.stats.rounds_collapsed, before.stats.rounds_collapsed + 1);
  assert.equal(after.stats.total_paid, before.stats.total_paid);
  assert.equal(after.history.at(-1)!.kind, 'collapsed');
  assert.equal(after.history.at(-1)!.paid, '0');
});

test('the it-unregisters scenario: unregister settles first, with a snapshot right after', () => {
  const s = file.scenarios.find((x) => x.name === 'it-unregisters')!;
  const config = fromScenarioConfig(file.config);
  const engine = new NotIt(config);
  const seen: { force: boolean; pending: number; owed: bigint; before: Snap; after: Snap }[] = [];
  for (const step of s.steps) {
    const before = JSON.parse(engine.snapshot()) as Snap;
    const now = BigInt(step.now);
    const pending = engine.state(now).stats.roundsCollapsed - before.stats.rounds_collapsed;
    const owed = engine.balanceOf(step.caller, now);
    applyStep(engine, step);
    if (step.op !== 'unregister') continue;
    assert.equal(before.it, step.caller, 'the account that leaves is It');
    assert.equal(step.error, null);
    assert.equal(typeof step.snapshot, 'object', 'snapshot right after the unregister');
    seen.push({ force: step.force === true, pending, owed, before, after: step.snapshot as Snap });
  }
  assert.equal(seen.length, 3);
  for (const u of seen) {
    assert.equal(u.after.it, null);
    assert.equal(u.after.stats.rounds_collapsed, u.before.stats.rounds_collapsed + u.pending);
  }
  const [empty, funded, drained] = [seen[0]!, seen[1]!, seen[2]!];
  // An empty It with nothing pending leaves without force and burns nothing.
  assert.deepEqual([empty.force, empty.pending, empty.owed], [false, 0, 0n]);
  assert.equal(empty.after.total_shares, empty.before.total_shares);
  // Two pending rounds are paid to It first, then everything it holds is burned.
  assert.deepEqual([funded.force, funded.pending], [true, 2]);
  assert.ok(BigInt(funded.after.stats.total_paid) > BigInt(funded.before.stats.total_paid));
  assert.equal(funded.after.history.at(-1)!.kind, 'collapsed');
  assert.equal(funded.after.history.at(-1)!.count, 2);
  // An It with no shares of its own is minted four pending pots, so it needs force.
  assert.deepEqual([drained.force, drained.pending], [true, 4]);
  assert.ok(drained.owed > 0n);
  const leaver = s.steps.filter((x) => x.op === 'unregister').at(-1)!.caller;
  const stored = drained.before.accounts.find((a) => a.id === leaver)!;
  assert.ok(BigInt(stored.shares) <= 1n); // nothing but dust before the settlement
  const paid = BigInt(drained.after.stats.total_paid) - BigInt(drained.before.stats.total_paid);
  assert.ok(paid > 0n && paid - drained.owed <= 4n && drained.owed - paid <= 4n);
});
