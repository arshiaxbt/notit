// Deterministic simulator: agents with balances and strategies play rounds against a
// real NotIt engine. No Math.random, no Date.now, no node: imports — the same options
// always give the same result, in Node and in a browser.

import { FAST, MAX_COLLAPSE_RUN, NotIt, NotItError } from './engine.ts';
import type { Config } from './engine.ts';
import { makeStrategy } from './strategies.ts';
import type { RoundContext, SlotContext, Strategy, StrategySpec } from './strategies.ts';

/** mulberry32: a small seeded PRNG returning floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Parameters of the rules a simulation may override (the faucet is managed by the simulator). */
export type SimConfig = Pick<Config, 'roundNs' | 'maxCostPpm' | 'minCostPpm' | 'cutPpm'>;

export interface AgentSpec {
  /** Defaults to `agent-<index>`. */
  id?: string;
  /** Balance handed out before the game starts, in base units (10^18 per NOTIT). */
  balance: bigint;
  /** A built-in spec (instantiated per agent) or a custom strategy object (do not share stateful ones). */
  strategy: StrategySpec | Strategy;
}

export interface SimOptions {
  agents: AgentSpec[];
  rounds: number;
  /** Default 1. */
  seed?: number;
  /** Decision points per round; the last one is the final block. Default 20. */
  slotsPerRound?: number;
  /** Rule overrides on top of FAST. */
  config?: Partial<SimConfig>;
  /**
   * Index of an agent that volunteers in a setup round (in its final slot, at the
   * lowest cost) before the measured rounds, so the game starts armed with that
   * agent as It. Default: no setup round — the game starts dormant, with no It.
   */
  initialIt?: number;
  /**
   * Play every round as an independent trial on a fresh engine with the starting
   * balances (and the setup round, if any). Default false: one engine, rounds in sequence.
   */
  resetEachRound?: boolean;
  /** How many completed rounds `recentFailureRate` looks back over. Default 20. */
  failureWindow?: number;
  /** Record one entry per round in `timeline`. Default false. */
  timeline?: boolean;
}

export interface AgentResult {
  id: string;
  strategy: string;
  /** Balance when the first measured round opened (after the setup round, if any). */
  balanceStart: bigint;
  /** Balance after the last round closed (with `resetEachRound`: after the last trial). */
  balanceEnd: bigint;
  saves: number;
  /** Tokens burned by volunteering, base units. */
  burned: bigint;
  /** Collected as It from collapsed rounds, net of the cut on its own balance (the contract's `collected`). */
  collected: bigint;
  /** volunteer() calls rejected with ERR_INSUFFICIENT. */
  rejected: number;
  /** volunteer() calls that missed the deadline. */
  missed: number;
}

/** saved: somebody volunteered. collapsed: nobody did and the cut was paid to It. dormant: nobody did and nothing was charged. */
export type RoundOutcome = 'saved' | 'collapsed' | 'dormant';

export interface RoundRecord {
  round: number;
  outcome: RoundOutcome;
  /** Index into `agents` of the volunteer, or -1. */
  hero: number;
  /** Index into `agents` of It when the round closed, or -1. */
  it: number;
  /** Slot of the save, or -1. */
  slot: number;
  /** Burned by the volunteer (0 if not saved). */
  cost: bigint;
  /** Paid to It, net of the cut on its own balance (0 unless collapsed). */
  paid: bigint;
  /** Fraction of the round left when it was saved (0 if not saved). */
  secondsLeftFraction: number;
  /** Total supply when the round opened. */
  supply: bigint;
}

export interface SimResult {
  seed: number;
  slotsPerRound: number;
  rounds: number;
  saved: number;
  collapsed: number;
  dormant: number;
  /** Share of rounds that were not saved: (collapsed + dormant) / rounds. */
  failureRate: number;
  /** Longest run of saved rounds (same rule as the contract's `longest_streak`). */
  longestStreak: number;
  /** First measured round (1-based) that was saved, or null. */
  firstSavedRound: number | null;
  /** First measured round (1-based) that was not saved, or null. */
  firstFailedRound: number | null;
  /** The first measured round as it opened: supply, armed, It and the cost at slot 0 and in the final slot. */
  opening: { supply: bigint; armed: boolean; it: number; costOpen: bigint; costFinal: bigint };
  supplyStart: bigint;
  /** Total supply after the last round closed (with `resetEachRound`: after the last trial). */
  supplyEnd: bigint;
  /** Burned by volunteers in the measured rounds. */
  totalBurned: bigint;
  /** Paid to It by collapsed rounds in the measured rounds, net of the cut on It's own balance (the contract's `total_paid`). */
  totalPaid: bigint;
  /** Mean fraction of the round left at the moment of the save; null if nothing was saved. */
  avgSecondsLeftFraction: number | null;
  /** Number of saves per slot. */
  savedBySlot: number[];
  /** Index of It after the last round, or -1. */
  itEnd: number;
  agents: AgentResult[];
  timeline: RoundRecord[];
}

const FAUCET = 'faucet.sim';

/** Elapsed nanoseconds of a slot: slot 0 is the round opening, the last slot is the final nanosecond. */
export function slotElapsedNs(slot: number, slots: number, roundNs: bigint): bigint {
  if (slots <= 1) return roundNs - 1n;
  return ((roundNs - 1n) * BigInt(slot)) / BigInt(slots - 1);
}

function isStrategy(s: StrategySpec | Strategy): s is Strategy {
  return typeof (s as Strategy).decide === 'function';
}

export function simulate(options: SimOptions): SimResult {
  const rounds = options.rounds;
  const slots = options.slotsPerRound ?? 20;
  const seed = options.seed ?? 1;
  const window = options.failureWindow ?? 20;
  if (!Number.isInteger(rounds) || rounds < 0) throw new Error('simulate: rounds must be a non-negative integer');
  if (!Number.isInteger(slots) || slots < 1) throw new Error('simulate: slotsPerRound must be a positive integer');
  if (!Number.isInteger(window) || window < 1) throw new Error('simulate: failureWindow must be a positive integer');
  const n = options.agents.length;
  if (n === 0) throw new Error('simulate: at least one agent is required');
  const initialIt = options.initialIt ?? -1;
  if (!Number.isInteger(initialIt) || initialIt < -1 || initialIt >= n) {
    throw new Error('simulate: initialIt must be an agent index');
  }

  const rules: SimConfig = {
    roundNs: FAST.roundNs,
    maxCostPpm: FAST.maxCostPpm,
    minCostPpm: FAST.minCostPpm,
    cutPpm: FAST.cutPpm,
    ...options.config,
  };
  const roundNs = rules.roundNs;

  const ids: string[] = [];
  const indexOf = new Map<string, number>();
  const strategies: Strategy[] = [];
  let total = 0n;
  options.agents.forEach((a, i) => {
    const id = a.id ?? `agent-${i}`;
    if (id === FAUCET || indexOf.has(id)) throw new Error(`simulate: duplicate agent id ${id}`);
    if (a.balance < 0n) throw new Error(`simulate: negative balance for ${id}`);
    indexOf.set(id, i);
    ids.push(id);
    strategies.push(isStrategy(a.strategy) ? a.strategy : makeStrategy(a.strategy));
    total += a.balance;
  });

  const slotOffsets: bigint[] = [];
  for (let s = 0; s < slots; s++) slotOffsets.push(slotElapsedNs(s, slots, roundNs));
  const finalOffset = slotOffsets[slots - 1]!;
  // Engine round 0 hands out the balances; round 1 is the setup round if there is one.
  const firstRound = initialIt >= 0 ? 2 : 1;
  const t0 = BigInt(firstRound) * roundNs;

  // The world is built in round 0 (which can never be saved or charged): one faucet
  // account claims the whole supply and hands every agent its balance. At index = RAY
  // one share is one unit, so the faucet ends with exactly zero.
  const buildWorld = (): NotIt => {
    const engine = new NotIt({
      ...rules,
      claimAmount: total > 0n ? total : 1n,
      claimCap: 1,
      genesisNs: 0n,
    });
    if (total > 0n) engine.claim(FAUCET, 0n);
    for (let i = 0; i < n; i++) {
      engine.register(ids[i]!);
      const balance = options.agents[i]!.balance;
      if (balance > 0n) engine.transfer(FAUCET, ids[i]!, balance, 0n);
    }
    if (initialIt >= 0) engine.volunteer(ids[initialIt]!, roundNs + finalOffset, { round: 1 });
    engine.poke(t0);
    return engine;
  };

  const rng = mulberry32(seed);
  const reset = options.resetEachRound === true;
  const keepTimeline = options.timeline === true;

  const saves = new Array<number>(n).fill(0);
  const burned = new Array<bigint>(n).fill(0n);
  const collected = new Array<bigint>(n).fill(0n);
  const rejected = new Array<number>(n).fill(0);
  const missed = new Array<number>(n).fill(0);
  const savedBySlot = new Array<number>(slots).fill(0);
  const balances = new Float64Array(n);
  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  const roundNsFloat = Number(roundNs);
  // Ring buffer of the last `window` outcomes (1 = not saved).
  const recent = new Uint8Array(window);
  let recentCount = 0;
  let recentFailed = 0;

  const roundCtx: RoundContext = { round: 0, slots, rng };
  const ctx: SlotContext = {
    round: 0,
    slot: 0,
    slots,
    isFinalSlot: false,
    armed: false,
    isIt: false,
    contenders: 0,
    balance: 0,
    supply: 0,
    costNow: 0,
    costFinal: 0,
    cut: rules.cutPpm / 1e6,
    maxCollapseRun: MAX_COLLAPSE_RUN,
    recentFailureRate: 0,
    rng,
  };

  let engine = buildWorld();
  const first = engine.state(t0);
  const opening = {
    supply: first.totalSupply,
    armed: first.armed,
    it: first.it === null ? -1 : (indexOf.get(first.it) ?? -1),
    costOpen: engine.costAt(t0),
    costFinal: engine.costAt(t0 + finalOffset),
  };
  const balanceStart: bigint[] = [];
  for (let i = 0; i < n; i++) balanceStart.push(engine.balanceOf(ids[i]!, t0));

  let saved = 0;
  let collapsed = 0;
  let dormant = 0;
  let streak = 0;
  let longestStreak = 0;
  let firstSavedRound: number | null = null;
  let firstFailedRound: number | null = null;
  let totalBurned = 0n;
  let totalPaid = 0n;
  let leftSum = 0;
  let end = t0;
  const timeline: RoundRecord[] = [];

  for (let r = 1; r <= rounds; r++) {
    if (reset && r > 1) engine = buildWorld();
    const start = reset ? t0 : t0 + BigInt(r - 1) * roundNs;
    end = start + roundNs;
    const open = engine.state(start);
    const itIdx = open.it === null ? -1 : (indexOf.get(open.it) ?? -1);

    let heroIdx = -1;
    let heroSlot = -1;
    let heroCost = 0n;
    let left = 0;

    if (open.roundSupply > 0n) {
      let contenders = 0;
      for (let i = 0; i < n; i++) {
        const b = Number(engine.balanceOf(ids[i]!, start));
        balances[i] = b;
        if (b > 0 && i !== itIdx) contenders += 1;
      }
      roundCtx.round = r;
      for (let i = 0; i < n; i++) {
        const st = strategies[i]!;
        if (st.startRound !== undefined) st.startRound(roundCtx);
      }
      ctx.round = r;
      ctx.armed = open.armed;
      ctx.contenders = contenders;
      ctx.supply = Number(open.roundSupply);
      ctx.costFinal = Number(engine.costAt(start + finalOffset));
      ctx.recentFailureRate = recentCount === 0 ? 0 : recentFailed / recentCount;

      slotLoop: for (let s = 0; s < slots; s++) {
        const now = start + slotOffsets[s]!;
        ctx.slot = s;
        ctx.isFinalSlot = s === slots - 1;
        ctx.costNow = ctx.isFinalSlot ? ctx.costFinal : Number(engine.costAt(now));
        // Agents act in a fresh random order every slot (Fisher–Yates).
        for (let i = n - 1; i > 0; i--) {
          const j = Math.floor(rng() * (i + 1));
          const tmp = order[i]!;
          order[i] = order[j]!;
          order[j] = tmp;
        }
        for (let k = 0; k < n; k++) {
          const i = order[k]!;
          ctx.balance = balances[i]!;
          ctx.isIt = i === itIdx;
          const decision = strategies[i]!.decide(ctx);
          if (decision === 'pass') continue;
          if (decision === 'miss') {
            missed[i]! += 1;
            continue;
          }
          try {
            const res = engine.volunteer(ids[i]!, now, { round: open.round });
            heroIdx = i;
            heroSlot = s;
            heroCost = res.cost;
            left = Number(roundNs - slotOffsets[s]!) / roundNsFloat;
            // The first call wins; every later call this round would fail with
            // ERR_ALREADY_SAVED at no cost, so the rest of the round is skipped.
            break slotLoop;
          } catch (e) {
            if (e instanceof NotItError && e.code === 'ERR_INSUFFICIENT') rejected[i]! += 1;
            else throw e;
          }
        }
      }
    }

    // Close the round and read what the engine did with it.
    engine.poke(end);
    const close = engine.state(end);
    const paid = close.stats.totalPaid - open.stats.totalPaid;
    let outcome: RoundOutcome;
    if (heroIdx >= 0) {
      outcome = 'saved';
      if (firstSavedRound === null) firstSavedRound = r;
      saved += 1;
      saves[heroIdx]! += 1;
      burned[heroIdx]! += heroCost;
      totalBurned += heroCost;
      savedBySlot[heroSlot]! += 1;
      leftSum += left;
      streak += 1;
      if (streak > longestStreak) longestStreak = streak;
    } else {
      if (firstFailedRound === null) firstFailedRound = r;
      if (close.stats.roundsCollapsed > open.stats.roundsCollapsed) {
        outcome = 'collapsed';
        collapsed += 1;
        streak = 0;
        totalPaid += paid;
        if (itIdx >= 0) collected[itIdx]! += paid;
      } else {
        outcome = 'dormant';
        dormant += 1;
      }
    }
    const failedBit = heroIdx >= 0 ? 0 : 1;
    if (recentCount < window) recentCount += 1;
    else recentFailed -= recent[(r - 1) % window]!;
    recent[(r - 1) % window] = failedBit;
    recentFailed += failedBit;

    if (keepTimeline) {
      timeline.push({
        round: r,
        outcome,
        hero: heroIdx,
        it: close.it === null ? -1 : (indexOf.get(close.it) ?? -1),
        slot: heroSlot,
        cost: heroCost,
        paid,
        secondsLeftFraction: left,
        supply: open.totalSupply,
      });
    }
  }

  const final = engine.state(end);
  const agents: AgentResult[] = [];
  for (let i = 0; i < n; i++) {
    agents.push({
      id: ids[i]!,
      strategy: strategies[i]!.kind,
      balanceStart: balanceStart[i]!,
      balanceEnd: engine.balanceOf(ids[i]!, end),
      saves: saves[i]!,
      burned: burned[i]!,
      collected: collected[i]!,
      rejected: rejected[i]!,
      missed: missed[i]!,
    });
  }

  return {
    seed,
    slotsPerRound: slots,
    rounds,
    saved,
    collapsed,
    dormant,
    failureRate: rounds === 0 ? 0 : (collapsed + dormant) / rounds,
    longestStreak,
    firstSavedRound,
    firstFailedRound,
    opening,
    supplyStart: opening.supply,
    supplyEnd: final.totalSupply,
    totalBurned,
    totalPaid,
    avgSecondsLeftFraction: saved === 0 ? null : leftSum / saved,
    savedBySlot,
    itEnd: final.it === null ? -1 : (indexOf.get(final.it) ?? -1),
    agents,
    timeline,
  };
}
