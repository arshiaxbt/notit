// Scenario generator for the differential test against the Rust contract.
//
// `npm run scenarios` writes engine/out/scenarios.json: a fixed config and a list of
// scenarios, each a list of steps (calls with a block time `now` and the expected
// error code) with the engine's `snapshot()` attached to every 8th step and to the
// last step. Deterministic: seeded mulberry32, no clock — two runs are byte-identical.
//
// Replay protocol (the generator does exactly this, see `applyStep`):
//   1. run the step's call at block time `now`; its error code must equal `error`
//      (null = success);
//   2. then, success or error, call poke() at the same `now`;
//   3. if the step carries `snapshot`, the stored state must now equal it.
// Because of (2) the stored state is comparable whether or not a failed call rolls
// back the settlement it ran. `register` is storage_deposit (never an error, also
// when the account is already registered) and does not settle. `unregister` is
// storage_unregister at block time `now`; it settles first, and it is only generated
// where it succeeds (forced, or on an account whose effective shares are zero after
// that settlement).
//
// This file uses node:fs for the command-line entry and is not exported from index.ts.

import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { NotIt, NotItError, PPM, RAY } from './engine.ts';
import type { Config } from './engine.ts';
import { mulberry32 } from './sim.ts';

// ---------------------------------------------------------------------------
// File format
// ---------------------------------------------------------------------------

export type ScenarioOp = 'claim' | 'volunteer' | 'transfer' | 'unregister' | 'register' | 'poke';

export interface ScenarioStep {
  op: ScenarioOp;
  caller: string;
  /** transfer: receiver. */
  to?: string;
  /** transfer: amount in base units. */
  amount?: string;
  /** unregister: the `force` argument. */
  force?: boolean;
  /** Block time of the call, nanoseconds; non-decreasing within a scenario. */
  now: string;
  /** volunteer: the `round` guard, or null for none. */
  round?: number | null;
  /** volunteer: the `max_cost` guard, or null for none. */
  max_cost?: string | null;
  /** Expected ERR_* code, or null for success. */
  error: string | null;
  /** Stored state after this step and its poke: the object `snapshot()` serialises. */
  snapshot?: unknown;
}

export interface Scenario {
  name: string;
  seed: number;
  steps: ScenarioStep[];
}

export interface ScenarioConfig {
  round_ns: string;
  max_cost_ppm: number;
  min_cost_ppm: number;
  cut_ppm: number;
  claim_amount: string;
  claim_cap: number;
  genesis_ns: string;
}

export interface ScenarioFile {
  config: ScenarioConfig;
  scenarios: Scenario[];
}

export const SCENARIO_CONFIG: Config = Object.freeze({
  roundNs: 100_000_000_000n,
  maxCostPpm: 50_000,
  minCostPpm: 2_000,
  cutPpm: 150_000,
  claimAmount: 1_000n * 10n ** 18n,
  claimCap: 100_000,
  genesisNs: 10n ** 18n,
});

export const SCENARIO_ACCOUNTS: readonly string[] = [
  'a0.test',
  'a1.test',
  'a2.test',
  'a3.test',
  'a4.test',
  'a5.test',
  'a6.test',
  'a7.test',
];

/** A snapshot is attached to every SNAPSHOT_EVERY-th step and to the last step. */
export const SNAPSHOT_EVERY = 8;

export function toScenarioConfig(c: Config): ScenarioConfig {
  return {
    round_ns: c.roundNs.toString(),
    max_cost_ppm: c.maxCostPpm,
    min_cost_ppm: c.minCostPpm,
    cut_ppm: c.cutPpm,
    claim_amount: c.claimAmount.toString(),
    claim_cap: c.claimCap,
    genesis_ns: c.genesisNs.toString(),
  };
}

export function fromScenarioConfig(c: ScenarioConfig): Config {
  return {
    roundNs: BigInt(c.round_ns),
    maxCostPpm: c.max_cost_ppm,
    minCostPpm: c.min_cost_ppm,
    cutPpm: c.cut_ppm,
    claimAmount: BigInt(c.claim_amount),
    claimCap: c.claim_cap,
    genesisNs: BigInt(c.genesis_ns),
  };
}

// ---------------------------------------------------------------------------
// Applying a step (shared by the generator and the replayer)
// ---------------------------------------------------------------------------

/** Runs one step on `engine`, then pokes at the same `now`. Returns the error code of the call, or null. */
export function applyStep(engine: NotIt, step: ScenarioStep): string | null {
  const now = BigInt(step.now);
  let error: string | null = null;
  try {
    switch (step.op) {
      case 'claim':
        engine.claim(step.caller, now);
        break;
      case 'volunteer': {
        const guard: { round?: number; maxCost?: bigint } = {};
        if (step.round !== null && step.round !== undefined) guard.round = step.round;
        if (step.max_cost !== null && step.max_cost !== undefined) guard.maxCost = BigInt(step.max_cost);
        engine.volunteer(step.caller, now, guard);
        break;
      }
      case 'transfer':
        engine.transfer(step.caller, step.to!, BigInt(step.amount!), now);
        break;
      case 'unregister':
        if (!engine.unregister(step.caller, step.force === true, now)) {
          throw new Error(`scenario bug: unregister(${step.caller}, ${String(step.force)}) was refused`);
        }
        break;
      case 'register':
        engine.register(step.caller);
        break;
      case 'poke':
        engine.poke(now);
        break;
      default:
        throw new Error(`unknown op ${String(step.op)}`);
    }
  } catch (e) {
    if (e instanceof NotItError) error = e.code;
    else throw e;
  }
  engine.poke(now);
  return error;
}

/**
 * Replays a scenario file on fresh engines and returns every mismatch (empty = the
 * file is consistent with this engine). The Rust replayer should do the same.
 */
export function replayScenarios(file: ScenarioFile): string[] {
  const problems: string[] = [];
  const config = fromScenarioConfig(file.config);
  for (const scenario of file.scenarios) {
    const engine = new NotIt(config);
    scenario.steps.forEach((step, i) => {
      const where = `${scenario.name} step ${i} (${step.op})`;
      const error = applyStep(engine, step);
      if (error !== step.error) problems.push(`${where}: error ${String(error)}, expected ${String(step.error)}`);
      if (step.snapshot !== undefined && JSON.stringify(step.snapshot) !== engine.snapshot()) {
        problems.push(`${where}: snapshot differs`);
      }
    });
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

interface StoredAccount {
  id: string;
  shares: string;
  scale: number;
  claimed: boolean;
}

interface StoredState {
  index: string;
  scale: number;
  total_shares: string;
  it: string | null;
  accounts: StoredAccount[];
}

/** Builds one scenario: owns the engine, the clock and the PRNG, and records every step. */
class Builder {
  readonly config: Config;
  readonly engine: NotIt;
  readonly rng: () => number;
  readonly steps: ScenarioStep[] = [];
  now: bigint;

  constructor(config: Config, seed: number) {
    this.config = config;
    this.engine = new NotIt(config);
    this.rng = mulberry32(seed);
    this.now = config.genesisNs;
  }

  // ----- randomness -----

  chance(p: number): boolean {
    return this.rng() < p;
  }

  int(n: number): number {
    return Math.floor(this.rng() * n);
  }

  pick<T>(xs: readonly T[]): T {
    return xs[this.int(xs.length)]!;
  }

  /** Fisher–Yates shuffle of a copy. */
  shuffled<T>(xs: readonly T[]): T[] {
    const out = [...xs];
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      const tmp = out[i]!;
      out[i] = out[j]!;
      out[j] = tmp;
    }
    return out;
  }

  /** Uniform-ish bigint in [0, n). */
  below(n: bigint): bigint {
    if (n <= 0n) return 0n;
    const hi = BigInt(Math.floor(this.rng() * 4294967296));
    const lo = BigInt(Math.floor(this.rng() * 4294967296));
    return (((hi << 32n) | lo) * n) >> 64n;
  }

  // ----- clock and state -----

  get round(): number {
    return Number((this.now - this.config.genesisNs) / this.config.roundNs);
  }

  roundStart(round: number): bigint {
    return this.config.genesisNs + BigInt(round) * this.config.roundNs;
  }

  /** The last nanosecond of `round`: the cheapest moment to volunteer. */
  floorOf(round: number): bigint {
    return this.roundStart(round + 1) - 1n;
  }

  stored(): StoredState {
    return JSON.parse(this.engine.snapshot()) as StoredState;
  }

  registered(): string[] {
    return this.stored().accounts.map((a) => a.id);
  }

  balance(id: string): bigint {
    return this.engine.balanceOf(id, this.now);
  }

  /** Registered accounts with a positive balance at `now`. */
  funded(): string[] {
    return this.registered().filter((id) => this.balance(id) > 0n);
  }

  richest(): string | null {
    let best: string | null = null;
    let bestBalance = 0n;
    for (const id of this.registered()) {
      const b = this.balance(id);
      if (b > bestBalance) {
        best = id;
        bestBalance = b;
      }
    }
    return best;
  }

  // ----- recording -----

  /** `applied`: the call has already been made on the engine (and succeeded); only the poke is left. */
  private record(step: ScenarioStep, applied = false): string | null {
    if (applied) this.engine.poke(this.now);
    else step.error = applyStep(this.engine, step);
    this.steps.push(step);
    if (this.steps.length % SNAPSHOT_EVERY === 0) step.snapshot = JSON.parse(this.engine.snapshot());
    return step.error;
  }

  claim(caller: string): string | null {
    return this.record({ op: 'claim', caller, now: this.now.toString(), error: null });
  }

  volunteer(caller: string, round: number | null, maxCost: bigint | null): string | null {
    return this.record({
      op: 'volunteer',
      caller,
      now: this.now.toString(),
      round,
      max_cost: maxCost === null ? null : maxCost.toString(),
      error: null,
    });
  }

  transfer(caller: string, to: string, amount: bigint): string | null {
    return this.record({ op: 'transfer', caller, to, amount: amount.toString(), now: this.now.toString(), error: null });
  }

  unregister(caller: string, force: boolean): string | null {
    return this.record({ op: 'unregister', caller, force, now: this.now.toString(), error: null });
  }

  /**
   * storage_unregister without `force` if the engine accepts it (zero effective
   * shares after settling at `now`), otherwise with `force`. A refused unregister
   * writes nothing, so trying first is safe. Returns the `force` that was recorded.
   */
  unregisterGently(caller: string): boolean {
    if (this.engine.unregister(caller, false, this.now)) {
      this.record({ op: 'unregister', caller, force: false, now: this.now.toString(), error: null }, true);
      return false;
    }
    this.unregister(caller, true);
    return true;
  }

  register(caller: string): string | null {
    return this.record({ op: 'register', caller, now: this.now.toString(), error: null });
  }

  poke(caller: string): string | null {
    return this.record({ op: 'poke', caller, now: this.now.toString(), error: null });
  }

  /** Attach a snapshot to the step just recorded (besides the regular every-8th ones). */
  snap(): void {
    const last = this.steps[this.steps.length - 1];
    if (last !== undefined && last.snapshot === undefined) last.snapshot = JSON.parse(this.engine.snapshot());
  }

  finish(name: string, seed: number): Scenario {
    this.snap();
    return { name, seed, steps: this.steps };
  }

  // ----- random building blocks -----

  /** A volunteer call with a random caller and a random (possibly wrong) guard. */
  randomVolunteer(): void {
    const state = this.engine.state(this.now);
    const cost = this.engine.costAt(this.now);
    const caller = state.it !== null && this.chance(0.2) ? state.it : this.pick(SCENARIO_ACCOUNTS);
    const v = this.rng();
    if (v < 0.3) this.volunteer(caller, null, null);
    else if (v < 0.55) this.volunteer(caller, state.round, cost);
    else if (v < 0.65) this.volunteer(caller, state.round, null);
    else if (v < 0.75) this.volunteer(caller, null, cost + this.below(10n ** 18n));
    else if (v < 0.87) {
      // wrong round guard
      const wrong = this.chance(0.5) ? state.round + 1 : Math.max(0, state.round - 1 - this.int(3));
      this.volunteer(caller, wrong === state.round ? state.round + 2 : wrong, this.chance(0.5) ? cost : null);
    } else {
      // max_cost guard set too low
      const low = cost > 0n ? (this.chance(0.5) ? cost - 1n : cost / 2n) : 0n;
      this.volunteer(caller, this.chance(0.5) ? state.round : null, low);
    }
  }

  /** A transfer: mostly valid, sometimes zero, to self, to an unregistered account or above the balance. */
  randomTransfer(): void {
    const funded = this.funded();
    const from = funded.length > 0 && this.chance(0.75) ? this.pick(funded) : this.pick(SCENARIO_ACCOUNTS);
    const others = SCENARIO_ACCOUNTS.filter((id) => id !== from);
    const registered = new Set(this.registered());
    const registeredOthers = others.filter((id) => registered.has(id));
    const unregisteredOthers = others.filter((id) => !registered.has(id));
    const to = registeredOthers.length > 0 && this.chance(0.85) ? this.pick(registeredOthers) : this.pick(others);
    const balance = this.balance(from);
    const v = this.rng();
    if (v < 0.48) this.transfer(from, to, balance > 0n ? (balance * BigInt(1 + this.int(99))) / 100n + 1n : 1n);
    else if (v < 0.6) this.transfer(from, to, balance > 0n ? balance : 1n); // the whole balance
    else if (v < 0.68) this.transfer(from, to, 1n);
    else if (v < 0.76) this.transfer(from, to, 0n);
    else if (v < 0.83) this.transfer(from, from, balance > 0n ? balance / 2n + 1n : 5n);
    else if (v < 0.92) this.transfer(from, to, balance + 1n + this.below(10n ** 18n));
    else this.transfer(from, unregisteredOthers.length > 0 ? this.pick(unregisteredOthers) : to, balance / 3n + 1n);
  }

  /**
   * storage_unregister where it is sure to succeed: forced, or unforced on an
   * account with zero effective shares. Returns the account, or null if nobody is
   * registered.
   */
  randomUnregister(): string | null {
    const ids = this.registered();
    if (ids.length === 0) return null;
    const id = this.pick(ids);
    if (this.chance(0.5)) this.unregister(id, true);
    else this.unregisterGently(id);
    return id;
  }
}

/** Random calls with varied time steps: inside a round, 1–3 rounds, and jumps of 9–40 rounds. */
function mixedScenario(name: string, seed: number, steps: number, config: Config): Scenario {
  const b = new Builder(config, seed);
  const R = config.roundNs;
  const queue: (() => void)[] = [];
  let unregisters = 0;

  // A few claims at or right after genesis so there is something to play with.
  const starters = 3 + b.int(4);
  const order = b.shuffled(SCENARIO_ACCOUNTS);
  for (let i = 0; i < starters && b.steps.length < steps; i++) {
    if (i > 0 && b.chance(0.5)) b.now += b.below(R / 20n);
    b.claim(order[i]!);
  }

  while (b.steps.length < steps) {
    // Advance the clock.
    const t = b.rng();
    if (t < 0.12) {
      // same block time as the previous step
    } else if (t < 0.5) b.now += b.below(R / 8n);
    else if (t < 0.6) {
      const floor = b.floorOf(b.round);
      b.now = b.now === floor ? floor + 1n : floor; // the last nanosecond, or the first of the next round
    } else if (t < 0.68) b.now = b.roundStart(b.round + 1);
    else if (t < 0.92) b.now += BigInt(1 + b.int(3)) * R - b.below(R / 2n);
    else b.now += BigInt(9 + b.int(32)) * R + b.below(R);

    // A queued follow-up (re-register / re-claim after an unregister) usually goes first.
    if (queue.length > 0 && b.chance(0.6)) {
      queue.shift()!();
      continue;
    }

    const u = b.rng();
    if (u < 0.36) b.randomVolunteer();
    else if (u < 0.61) b.randomTransfer();
    else if (u < 0.72) b.claim(b.pick(SCENARIO_ACCOUNTS));
    else if (u < 0.86) b.poke(b.pick(SCENARIO_ACCOUNTS));
    else if (u < 0.93) b.register(b.pick(SCENARIO_ACCOUNTS));
    else if (unregisters < 4 && b.funded().length > 2) {
      const gone = b.randomUnregister();
      if (gone !== null) {
        unregisters += 1;
        // Claiming again must fail with ERR_ALREADY_CLAIMED, before and after re-registering.
        if (b.chance(0.5)) queue.push(() => b.claim(gone));
        queue.push(() => b.register(gone));
        queue.push(() => b.claim(gone));
      }
    } else b.randomVolunteer();
  }
  return b.finish(name, seed);
}

/**
 * Long-running: volunteer at the floor of the round, jump 10 rounds (8 collapses and
 * a dormant round), repeat. After 128 collapses the index falls below 10^18 and the
 * contract rescales; a full scenario rescales several times.
 */
function rescaleScenario(name: string, seed: number, steps: number, config: Config): Scenario {
  const b = new Builder(config, seed);
  const R = config.roundNs;
  const holders = 3 + b.int(4);
  const order = b.shuffled(SCENARIO_ACCOUNTS);
  for (let i = 0; i < holders && b.steps.length < steps; i++) b.claim(order[i]!);

  while (b.steps.length < steps) {
    // Volunteer in the last nanosecond of the first round that is still open.
    let round = b.round;
    if (b.engine.state(b.now).saved) round += 1;
    b.now = b.floorOf(round);
    const funded = b.funded();
    const rich = b.richest();
    const caller = rich !== null && b.chance(0.75) ? rich : funded.length > 0 ? b.pick(funded) : b.pick(SCENARIO_ACCOUNTS);
    const cost = b.engine.costAt(b.now);
    const g = b.rng();
    if (g < 0.5) b.volunteer(caller, null, null);
    else if (g < 0.85) b.volunteer(caller, round, cost);
    else b.volunteer(caller, round, null);
    if (b.steps.length >= steps) break;

    // Sometimes something else happens while the game is armed.
    if (b.chance(0.12)) {
      b.now += b.below(R / 2n);
      if (b.chance(0.6)) b.randomTransfer();
      else b.randomVolunteer();
      if (b.steps.length >= steps) break;
    }

    // Jump 10 rounds and touch the contract.
    b.now += 10n * R;
    const u = b.rng();
    if (u < 0.5) b.poke(b.pick(SCENARIO_ACCOUNTS));
    else if (u < 0.8) b.randomTransfer();
    else if (u < 0.9) b.claim(b.pick(SCENARIO_ACCOUNTS));
    else b.register(b.pick(SCENARIO_ACCOUNTS));
  }
  return b.finish(name, seed);
}

/**
 * A targeted case for §4.1 step 3b: It owns everything except one dust share, and
 * floor rounding makes the cut on It's own balance one unit larger than the pot, so
 * the net `paid` must be clamped at 0 (an unchecked u128 subtraction would underflow).
 * The amount a third account passes on before it is force-unregistered (which burns
 * the rest and makes the totals uneven) is varied until the stored numbers hit that case.
 */
function clampScenario(name: string, seed: number, config: Config): Scenario {
  const [a, c, d] = [SCENARIO_ACCOUNTS[0]!, SCENARIO_ACCOUNTS[1]!, SCENARIO_ACCOUNTS[2]!];
  const keep = PPM - BigInt(config.cutPpm);
  for (let k = 0; k < 20_000; k++) {
    const b = new Builder(config, seed);
    b.claim(a);
    b.claim(c);
    b.claim(d);
    b.transfer(d, c, 1n + 7_919n * BigInt(k));
    b.unregister(d, true);
    b.now = b.roundStart(1);
    b.volunteer(a, 1, null);
    b.now = b.roundStart(3); // round 2 collapsed: the index is no longer RAY
    b.transfer(c, a, b.balance(c)); // ceil-rounded: may leave one dust share behind
    b.now = b.floorOf(3);
    b.volunteer(a, 3, null); // re-arm
    b.now = b.roundStart(4);
    b.poke(c);
    const s = b.stored();
    const total = BigInt(s.total_shares);
    const own = BigInt(s.accounts.find((x) => x.id === a)!.shares);
    const index = BigInt(s.index);
    const after = (index * keep) / PPM;
    const pot = (total * index) / RAY - (total * after) / RAY;
    const ownCut = (own * index) / RAY - (own * after) / RAY;
    if (pot < ownCut) {
      b.now = b.roundStart(5); // round 4 collapses with net paid clamped at 0
      b.poke(c);
      b.snap();
      b.now = b.roundStart(14);
      b.poke(a);
      return b.finish(name, seed);
    }
  }
  throw new Error('clampScenario: no amount produced the rounding case');
}

/**
 * It leaves. storage_unregister settles first, so an It with unsaved rounds pending
 * is paid for them and the forced unregister then burns what it holds, pot included.
 * Three cases, each followed by a snapshot: an empty It with nothing pending (no
 * force needed), an It that still has its balance, and an It that had sent its whole
 * balance away (no shares until the pending pots are minted, so it needs `force`).
 */
function itUnregistersScenario(name: string, seed: number, config: Config): Scenario {
  const b = new Builder(config, seed);
  const R = config.roundNs;
  const [a0, a1, a2, a3] = [SCENARIO_ACCOUNTS[0]!, SCENARIO_ACCOUNTS[1]!, SCENARIO_ACCOUNTS[2]!, SCENARIO_ACCOUNTS[3]!];
  for (const id of [a0, a1, a2, a3]) b.claim(id);

  // 1. While the index is still RAY (a whole balance moves exactly): a2 becomes It,
  //    sends everything to a3 and, with nothing pending, leaves without force.
  let round = 1;
  b.now = b.floorOf(round);
  b.volunteer(a2, round, null);
  b.transfer(a2, a3, b.balance(a2));
  if (b.unregisterGently(a2)) throw new Error('itUnregistersScenario: a2 should have been empty');
  b.snap();

  // 2. a0 becomes It in round 2; rounds 3 and 4 end unsaved and nobody calls until
  //    a0 unregisters in round 5.
  round = 2;
  b.now = b.roundStart(round) + R / 3n;
  b.volunteer(a0, round, null);
  b.now = b.roundStart(round + 3) + b.below(R);
  b.unregister(a0, true);
  b.snap();
  b.now += 2n * R; // nothing is charged without an It
  b.poke(a1);
  b.claim(a0); // ERR_ALREADY_CLAIMED: `claimed` survives
  b.register(a0);

  // 3. a1 becomes It and sends its whole balance to a3, then leaves 5 rounds later:
  //    the 4 pending pots are minted to it first, so it needs `force`, and they are burned.
  round = b.round + 1;
  b.now = b.floorOf(round);
  b.volunteer(a1, round, null);
  b.transfer(a1, a3, b.balance(a1));
  b.now = b.roundStart(round + 5) + b.below(R);
  b.unregister(a1, true);
  b.snap();
  b.now += 3n * R;
  b.poke(a3);
  return b.finish(name, seed);
}

export interface ScenarioOptions {
  /** Random mixed scenarios. Default 34. */
  mixed?: number;
  /** Long-running rescale scenarios. Default 6. */
  rescale?: number;
  /** Steps per mixed scenario. Default 48. */
  mixedSteps?: number;
  /**
   * Steps per rescale scenario; an array gives each scenario its own length (cycled).
   * Default [96, 56, 56]: 56 steps reach the first rescale, 96 the second.
   */
  rescaleSteps?: number | number[];
  /** Seed of the first scenario; each following one uses the next integer. Default 1. */
  seed?: number;
  config?: Config;
}

export function generateScenarios(options: ScenarioOptions = {}): ScenarioFile {
  const config = options.config ?? SCENARIO_CONFIG;
  const mixed = options.mixed ?? 34;
  const rescale = options.rescale ?? 6;
  const mixedSteps = options.mixedSteps ?? 48;
  const rescaleOption = options.rescaleSteps ?? [96, 56, 56];
  const rescaleSteps = typeof rescaleOption === 'number' ? [rescaleOption] : rescaleOption;
  let seed = options.seed ?? 1;
  const pad = (i: number): string => String(i + 1).padStart(2, '0');
  const scenarios: Scenario[] = [];
  for (let i = 0; i < mixed; i++) scenarios.push(mixedScenario(`mixed-${pad(i)}`, seed++, mixedSteps, config));
  for (let i = 0; i < rescale; i++) {
    scenarios.push(rescaleScenario(`rescale-${pad(i)}`, seed++, rescaleSteps[i % rescaleSteps.length]!, config));
  }
  scenarios.push(clampScenario('net-paid-clamp', seed++, config));
  scenarios.push(itUnregistersScenario('it-unregisters', seed++, config));
  return { config: toScenarioConfig(config), scenarios };
}

/**
 * The size the brief first asked for: 40 scenarios of 120 steps. With a snapshot on
 * every 8th step that is about 2.2 MB, so it is not the default (`--full` writes it
 * to out/scenarios-full.json).
 */
export const FULL_SCENARIOS: ScenarioOptions = { mixed: 34, mixedSteps: 120, rescale: 6, rescaleSteps: 120 };

/** Compact JSON, one scenario per line. */
export function scenariosToJson(file: ScenarioFile): string {
  const lines = file.scenarios.map((s) => JSON.stringify(s));
  return `{"config":${JSON.stringify(file.config)},"scenarios":[\n${lines.join(',\n')}\n]}\n`;
}

// ---------------------------------------------------------------------------
// Command-line entry: node src/scenarios.ts
// ---------------------------------------------------------------------------

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  const full = process.argv.includes('--full');
  const name = full ? 'scenarios-full.json' : 'scenarios.json';
  const file = generateScenarios(full ? FULL_SCENARIOS : {});
  const problems = replayScenarios(file);
  if (problems.length > 0) throw new Error(`scenarios do not replay:\n${problems.join('\n')}`);
  const json = scenariosToJson(file);
  const outDir = new URL('../out/', import.meta.url);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(new URL(name, outDir), json);
  const steps = file.scenarios.reduce((t, s) => t + s.steps.length, 0);
  const snapshots = file.scenarios.reduce((t, s) => t + s.steps.filter((x) => x.snapshot !== undefined).length, 0);
  process.stdout.write(
    `wrote out/${name}: ${file.scenarios.length} scenarios, ${steps} steps, ${snapshots} snapshots, ${json.length} bytes\n`,
  );
}
