// The three lab experiments, as plain functions a UI can call with its own parameters.
// Browser-safe: no node: imports. Results are plain data (bigint for token amounts);
// use `labToJson` to serialise them.

import { FAST, UNIT } from './engine.ts';
import { mulberry32, simulate } from './sim.ts';
import type { AgentSpec, SimConfig, SimResult } from './sim.ts';
import { mixedEquilibriumFailure, mixedEquilibriumP } from './strategies.ts';
import type { StrategySpec } from './strategies.ts';

// ---------------------------------------------------------------------------
// Small numeric helpers
// ---------------------------------------------------------------------------

/** Base units → NOTIT as a float (for ratios and charts; not exact). */
export function toTokens(units: bigint): number {
  return Number(units) / 1e18;
}

/** Gini coefficient of non-negative values (0 = equal, → 1 = one holder has everything). */
export function gini(values: number[]): number {
  const xs = [...values].sort((a, b) => a - b);
  const n = xs.length;
  let total = 0;
  let weighted = 0;
  for (let i = 0; i < n; i++) {
    total += xs[i]!;
    weighted += (i + 1) * xs[i]!;
  }
  if (n === 0 || total === 0) return 0;
  return (2 * weighted) / (n * total) - (n + 1) / n;
}

/** `count` Pareto(minTokens, alpha) draws, floored to whole tokens, in base units. */
export function paretoBalances(count: number, seed: number, alpha = 1.16, minTokens = 100): bigint[] {
  const rng = mulberry32(seed);
  const out: bigint[] = [];
  for (let i = 0; i < count; i++) {
    const u = 1 - rng(); // (0, 1]
    out.push(BigInt(Math.floor(minTokens * Math.pow(u, -1 / alpha))) * UNIT);
  }
  return out;
}

function ratio(a: bigint, b: bigint): number {
  return b === 0n ? 0 : Number(a) / Number(b);
}

function sum(xs: bigint[]): bigint {
  let t = 0n;
  for (const x of xs) t += x;
  return t;
}

// ---------------------------------------------------------------------------
// A. Bystander effect
// ---------------------------------------------------------------------------

export interface BystanderOptions {
  /** Numbers of players. Default [3, 5, 10, 20, 30, 45, 60, 75, 100]. */
  ns?: number[];
  /** Independent one-round trials per N. Default 2000. */
  trials?: number;
  /** Default 1001. N players use seed + N. */
  seed?: number;
  slotsPerRound?: number;
  config?: Partial<SimConfig>;
  /** Balance handed to every account, base units. Default 1000 NOTIT. */
  balance?: bigint;
}

export interface BystanderRow {
  /** Players (It excluded). */
  n: number;
  /** A player's balance in the armed round, base units. */
  playerBalance: bigint;
  /** Cost in the final slot of the armed round, base units. */
  finalCost: bigint;
  /** q = c / (cut × x) (§11), from the two actual values above. */
  q: number;
  /** Equilibrium probability that one player volunteers: 1 − q^(1/(n−1)). */
  p: number;
  /** Theory P(fail) = q^(n/(n−1)); 1 if q ≥ 1. */
  theory: number;
  /** Simulated share of trials nobody saved. */
  simulated: number;
  /** simulated − theory. */
  diff: number;
  trials: number;
  failed: number;
}

export interface BystanderResult {
  trials: number;
  seed: number;
  rows: BystanderRow[];
}

/**
 * N players with equal balances, all `mixedFinalBlock`, plus one extra account with
 * the same starting balance that became It in a setup round and never volunteers
 * again. Every trial is one armed round on a fresh engine, so the players stay equal
 * and the simulated failure rate is directly comparable with the one-shot theory of
 * §11, computed from the players' actual balance and the actual final-slot cost.
 */
export function runBystander(options: BystanderOptions = {}): BystanderResult {
  const ns = options.ns ?? [3, 5, 10, 20, 30, 45, 60, 75, 100];
  const trials = options.trials ?? 2000;
  const seed = options.seed ?? 1001;
  const balance = options.balance ?? 1000n * UNIT;
  const cut = (options.config?.cutPpm ?? FAST.cutPpm) / 1e6;
  const rows: BystanderRow[] = [];
  for (const n of ns) {
    const agents: AgentSpec[] = [];
    for (let i = 0; i < n; i++) agents.push({ id: `player-${i + 1}`, balance, strategy: { kind: 'mixedFinalBlock' } });
    agents.push({ id: 'it', balance, strategy: { kind: 'freeRider' } });
    const sim = simulate({
      agents,
      rounds: trials,
      seed: seed + n,
      slotsPerRound: options.slotsPerRound,
      config: options.config,
      initialIt: n,
      resetEachRound: true,
    });
    const playerBalance = sim.agents[0]!.balanceStart;
    const finalCost = sim.opening.costFinal;
    const q = Number(finalCost) / (cut * Number(playerBalance));
    const theory = mixedEquilibriumFailure(q, n);
    rows.push({
      n,
      playerBalance,
      finalCost,
      q,
      p: mixedEquilibriumP(q, n),
      theory,
      simulated: sim.failureRate,
      diff: sim.failureRate - theory,
      trials,
      failed: sim.collapsed + sim.dormant,
    });
  }
  return { trials, seed, rows };
}

// ---------------------------------------------------------------------------
// B. Who pays
// ---------------------------------------------------------------------------

export interface WhoPaysOptions {
  /** Default 50. */
  holders?: number;
  /** Default 500. */
  rounds?: number;
  /** Default 2002. */
  seed?: number;
  /** Pareto shape of the starting balances. Default 1.16 (the "80/20" shape). */
  alpha?: number;
  /** Smallest starting balance in whole NOTIT. Default 100. */
  minTokens?: number;
  /** Strategies to compare, one run each. Default rationalTimer and throneAware, patience 1. */
  strategies?: StrategySpec[];
  /** How many of the largest starting holders count as "top". Default 5. */
  top?: number;
  slotsPerRound?: number;
  config?: Partial<SimConfig>;
}

export interface WhoPaysRun {
  strategy: string;
  /** Share of rounds saved / collapsed (cut paid to It) / dormant (nobody volunteered, nothing charged). */
  savedShare: number;
  collapsedShare: number;
  dormantShare: number;
  /** Mean fraction of the round left when it was saved; null if no round was saved. */
  avgSecondsLeftFraction: number | null;
  /** Share of all burned tokens paid by the top holders (ranked by starting balance). */
  topBurnShare: number;
  /** Share of all saves made by the top holders. */
  topSaveShare: number;
  totalBurned: bigint;
  /** Total paid to It by collapsed rounds, net of the cut on It's own balance (the contract's `total_paid`). */
  totalPaid: bigint;
  giniEnd: number;
  supplyEnd: bigint;
  /** Share of the final supply held by the top holders. */
  topSupplyShareEnd: number;
  /** Share of the final supply held by whoever is It at the end (0 if nobody). */
  itSupplyShareEnd: number;
}

export interface WhoPaysResult {
  holders: number;
  rounds: number;
  seed: number;
  alpha: number;
  top: number;
  /** The holder that volunteered in the setup round (the largest one), so the game starts armed. */
  initialIt: string;
  supplyStart: bigint;
  giniStart: number;
  /** Share of the starting supply held by the top holders. */
  topSupplyShareStart: number;
  runs: WhoPaysRun[];
  /** The same strategies from a cold start: no setup round, nobody is It. */
  coldStart: WhoPaysColdStart[];
}

export interface WhoPaysColdStart {
  strategy: string;
  savedShare: number;
  dormantShare: number;
  /** First round (1-based) somebody volunteered, or null if nobody ever did. */
  firstSavedRound: number | null;
}

const DEFAULT_COMPARISON: StrategySpec[] = [
  { kind: 'rationalTimer', patience: 1 },
  { kind: 'throneAware', patience: 1 },
];

interface Comparison {
  supplyStart: bigint;
  giniStart: number;
  topSupplyShareStart: number;
  runs: WhoPaysRun[];
}

/** One continuous run per strategy (every holder playing it) from the same balances, seed and initial It. */
function compareStrategies(
  agentsFor: (strategy: StrategySpec) => AgentSpec[],
  strategies: StrategySpec[],
  topIdx: number[],
  initialIt: number,
  rounds: number,
  seed: number,
  slotsPerRound: number | undefined,
  config: Partial<SimConfig> | undefined,
): Comparison {
  const out: Comparison = { supplyStart: 0n, giniStart: 0, topSupplyShareStart: 0, runs: [] };
  for (const strategy of strategies) {
    const sim = simulate({ agents: agentsFor(strategy), rounds, seed, slotsPerRound, config, initialIt });
    const topAgents = topIdx.map((i) => sim.agents[i]!);
    const startTotal = sum(sim.agents.map((a) => a.balanceStart));
    const endTotal = sum(sim.agents.map((a) => a.balanceEnd));
    out.supplyStart = sim.supplyStart;
    out.giniStart = gini(sim.agents.map((a) => toTokens(a.balanceStart)));
    out.topSupplyShareStart = ratio(sum(topAgents.map((a) => a.balanceStart)), startTotal);
    out.runs.push({
      strategy: sim.agents[0]!.strategy,
      savedShare: rounds === 0 ? 0 : sim.saved / rounds,
      collapsedShare: rounds === 0 ? 0 : sim.collapsed / rounds,
      dormantShare: rounds === 0 ? 0 : sim.dormant / rounds,
      avgSecondsLeftFraction: sim.avgSecondsLeftFraction,
      topBurnShare: ratio(sum(topAgents.map((a) => a.burned)), sim.totalBurned),
      topSaveShare: sim.saved === 0 ? 0 : topAgents.reduce((t, a) => t + a.saves, 0) / sim.saved,
      totalBurned: sim.totalBurned,
      totalPaid: sim.totalPaid,
      giniEnd: gini(sim.agents.map((a) => toTokens(a.balanceEnd))),
      supplyEnd: sim.supplyEnd,
      topSupplyShareEnd: ratio(sum(topAgents.map((a) => a.balanceEnd)), endTotal),
      itSupplyShareEnd: sim.itEnd < 0 ? 0 : ratio(sim.agents[sim.itEnd]!.balanceEnd, endTotal),
    });
  }
  return out;
}

function holderId(i: number, holders: number): string {
  return `holder-${String(i + 1).padStart(String(holders).length, '0')}`;
}

/**
 * Holders with Pareto-distributed balances; one continuous run per strategy, every
 * holder playing it. Both runs start from the same balances with the same It: the
 * largest holder volunteers in a setup round, otherwise myopic holders would never
 * start the game.
 */
export function runWhoPays(options: WhoPaysOptions = {}): WhoPaysResult {
  const holders = options.holders ?? 50;
  const rounds = options.rounds ?? 500;
  const seed = options.seed ?? 2002;
  const alpha = options.alpha ?? 1.16;
  const top = Math.min(options.top ?? 5, holders);
  const strategies = options.strategies ?? DEFAULT_COMPARISON;
  const balances = paretoBalances(holders, seed, alpha, options.minTokens ?? 100);
  // Rank by starting balance, largest first (ties: lower index first).
  const ranked = balances.map((b, i) => ({ b, i }));
  ranked.sort((x, y) => (x.b === y.b ? x.i - y.i : x.b > y.b ? -1 : 1));
  const topIdx = ranked.slice(0, top).map((x) => x.i);
  const largest = ranked[0]!.i;
  const agentsFor = (strategy: StrategySpec): AgentSpec[] =>
    balances.map((balance, i) => ({ id: holderId(i, holders), balance, strategy }));

  const cmp = compareStrategies(agentsFor, strategies, topIdx, largest, rounds, seed + 1, options.slotsPerRound, options.config);

  const coldStart: WhoPaysColdStart[] = strategies.map((strategy) => {
    const sim = simulate({
      agents: agentsFor(strategy),
      rounds,
      seed: seed + 1,
      slotsPerRound: options.slotsPerRound,
      config: options.config,
    });
    return {
      strategy: sim.agents[0]!.strategy,
      savedShare: rounds === 0 ? 0 : sim.saved / rounds,
      dormantShare: rounds === 0 ? 0 : sim.dormant / rounds,
      firstSavedRound: sim.firstSavedRound,
    };
  });

  return {
    holders,
    rounds,
    seed,
    alpha,
    top,
    initialIt: holderId(largest, holders),
    supplyStart: cmp.supplyStart,
    giniStart: cmp.giniStart,
    topSupplyShareStart: cmp.topSupplyShareStart,
    runs: cmp.runs,
    coldStart,
  };
}

// ---------------------------------------------------------------------------
// B2. A dispersed crowd
// ---------------------------------------------------------------------------

export interface DispersedOptions {
  /** Equal holders, It included. Default 100 (1 % each, below the min_cost / cut = 1.33 % threshold). */
  holders?: number;
  /** Default 500. */
  rounds?: number;
  /** Default 2502. */
  seed?: number;
  /** Balance handed to every holder, base units. Default 1000 NOTIT. */
  balance?: bigint;
  /** Strategies to compare, one run each. Default rationalTimer and throneAware, patience 1. */
  strategies?: StrategySpec[];
  /** How many holders count as "top" (equal balances: the first ones by id). Default 5. */
  top?: number;
  slotsPerRound?: number;
  config?: Partial<SimConfig>;
}

export interface DispersedResult {
  holders: number;
  rounds: number;
  seed: number;
  top: number;
  /** The holder that volunteered in the setup round (the last one by id). */
  initialIt: string;
  supplyStart: bigint;
  giniStart: number;
  topSupplyShareStart: number;
  runs: WhoPaysRun[];
}

/**
 * Equal holders, each too small for a myopic holder to volunteer (cut × balance is
 * below the lowest cost). The last holder volunteers in a setup round, so both runs
 * start armed with the same It; then one continuous run per strategy.
 */
export function runDispersed(options: DispersedOptions = {}): DispersedResult {
  const holders = options.holders ?? 100;
  const rounds = options.rounds ?? 500;
  const seed = options.seed ?? 2502;
  const balance = options.balance ?? 1000n * UNIT;
  const top = Math.min(options.top ?? 5, holders);
  const strategies = options.strategies ?? DEFAULT_COMPARISON;
  const initialIt = holders - 1;
  const topIdx = Array.from({ length: top }, (_, i) => i);
  const agentsFor = (strategy: StrategySpec): AgentSpec[] =>
    Array.from({ length: holders }, (_, i) => ({ id: holderId(i, holders), balance, strategy }));
  const cmp = compareStrategies(agentsFor, strategies, topIdx, initialIt, rounds, seed, options.slotsPerRound, options.config);
  return {
    holders,
    rounds,
    seed,
    top,
    initialIt: holderId(initialIt, holders),
    supplyStart: cmp.supplyStart,
    giniStart: cmp.giniStart,
    topSupplyShareStart: cmp.topSupplyShareStart,
    runs: cmp.runs,
  };
}

// ---------------------------------------------------------------------------
// C. The idle get taxed (mixed crowd)
// ---------------------------------------------------------------------------

export interface MixedCrowdOptions {
  /** Default 4. */
  altruists?: number;
  /** Altruist probability of volunteering per round. Default 0.3. */
  h?: number;
  /** Default 6. */
  snipers?: number;
  /** Probability a sniper's transaction misses the deadline. Default 0.2. */
  missRate?: number;
  /** Default 30. */
  freeRiders?: number;
  /** Default 1000. */
  rounds?: number;
  /** Default 3003. */
  seed?: number;
  /** Starting balance of every holder, base units. Default 1000 NOTIT. */
  balance?: bigint;
  slotsPerRound?: number;
  config?: Partial<SimConfig>;
}

export interface MixedCrowdGroup {
  strategy: string;
  count: number;
  saves: number;
  burned: bigint;
  /** Collected as It from collapsed rounds, net of the cut on its own balance. */
  collected: bigint;
  /** volunteer() calls rejected because the caller could not afford the cost. */
  rejected: number;
  /** volunteer() calls that missed the deadline. */
  missed: number;
  /** Combined share of all balances held by the group at the start / at the end. */
  shareStart: number;
  shareEnd: number;
}

export interface MixedCrowdResult {
  holders: number;
  rounds: number;
  seed: number;
  /** Share of rounds nobody saved (collapsed + dormant). */
  failureRate: number;
  saved: number;
  collapsed: number;
  dormant: number;
  /** Longest run of saved rounds. */
  longestStreak: number;
  supplyStart: bigint;
  supplyEnd: bigint;
  totalBurned: bigint;
  /** Paid to It by collapsed rounds, net of the cut on It's own balance. */
  totalPaid: bigint;
  /** Combined balance share of the free riders at the start / at the end. */
  freeRiderShareStart: number;
  freeRiderShareEnd: number;
  groups: MixedCrowdGroup[];
}

/**
 * Altruists, snipers and free riders with equal starting balances, one continuous
 * run from a dormant start (nobody is It until the first volunteer).
 */
export function runMixedCrowd(options: MixedCrowdOptions = {}): MixedCrowdResult {
  const altruists = options.altruists ?? 4;
  const snipers = options.snipers ?? 6;
  const freeRiders = options.freeRiders ?? 30;
  const h = options.h ?? 0.3;
  const missRate = options.missRate ?? 0.2;
  const rounds = options.rounds ?? 1000;
  const seed = options.seed ?? 3003;
  const balance = options.balance ?? 1000n * UNIT;
  const agents: AgentSpec[] = [];
  for (let i = 1; i <= altruists; i++) agents.push({ id: `altruist-${i}`, balance, strategy: { kind: 'altruist', h } });
  for (let i = 1; i <= snipers; i++) agents.push({ id: `sniper-${i}`, balance, strategy: { kind: 'sniper', missRate } });
  for (let i = 1; i <= freeRiders; i++) agents.push({ id: `rider-${i}`, balance, strategy: { kind: 'freeRider' } });

  const sim: SimResult = simulate({
    agents,
    rounds,
    seed,
    slotsPerRound: options.slotsPerRound,
    config: options.config,
  });

  const startTotal = sum(sim.agents.map((a) => a.balanceStart));
  const endTotal = sum(sim.agents.map((a) => a.balanceEnd));
  const groups: MixedCrowdGroup[] = [];
  for (const strategy of ['altruist', 'sniper', 'freeRider']) {
    const members = sim.agents.filter((a) => a.strategy === strategy);
    if (members.length === 0) continue;
    groups.push({
      strategy,
      count: members.length,
      saves: members.reduce((t, a) => t + a.saves, 0),
      burned: sum(members.map((a) => a.burned)),
      collected: sum(members.map((a) => a.collected)),
      rejected: members.reduce((t, a) => t + a.rejected, 0),
      missed: members.reduce((t, a) => t + a.missed, 0),
      shareStart: ratio(sum(members.map((a) => a.balanceStart)), startTotal),
      shareEnd: ratio(sum(members.map((a) => a.balanceEnd)), endTotal),
    });
  }
  const riders = groups.find((g) => g.strategy === 'freeRider');

  return {
    holders: agents.length,
    rounds,
    seed,
    failureRate: sim.failureRate,
    saved: sim.saved,
    collapsed: sim.collapsed,
    dormant: sim.dormant,
    longestStreak: sim.longestStreak,
    supplyStart: sim.supplyStart,
    supplyEnd: sim.supplyEnd,
    totalBurned: sim.totalBurned,
    totalPaid: sim.totalPaid,
    freeRiderShareStart: riders === undefined ? 0 : riders.shareStart,
    freeRiderShareEnd: riders === undefined ? 0 : riders.shareEnd,
    groups,
  };
}

// ---------------------------------------------------------------------------
// The lab: all three with their fixed seeds, plus text and JSON rendering
// ---------------------------------------------------------------------------

export interface LabOptions {
  bystander?: BystanderOptions;
  whoPays?: WhoPaysOptions;
  dispersed?: DispersedOptions;
  mixedCrowd?: MixedCrowdOptions;
}

export interface LabResult {
  bystander: BystanderResult;
  whoPays: WhoPaysResult;
  dispersed: DispersedResult;
  mixedCrowd: MixedCrowdResult;
}

export function runLab(options: LabOptions = {}): LabResult {
  return {
    bystander: runBystander(options.bystander),
    whoPays: runWhoPays(options.whoPays),
    dispersed: runDispersed(options.dispersed),
    mixedCrowd: runMixedCrowd(options.mixedCrowd),
  };
}

/** JSON with bigints as decimal strings (base units), 2-space indent, trailing newline. */
export function labToJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n';
}

/** Base units → "1,234,567.89" (floored; locale-independent). */
export function formatTokens(units: bigint, decimals = 2): string {
  const scale = 10n ** BigInt(18 - decimals);
  const scaled = units / scale;
  const unit = 10n ** BigInt(decimals);
  const whole = (scaled / unit).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (decimals === 0) return whole;
  return `${whole}.${(scaled % unit).toString().padStart(decimals, '0')}`;
}

function pct(x: number, digits = 1): string {
  return `${(x * 100).toFixed(digits)}%`;
}

function signed(x: number, digits: number): string {
  const s = x.toFixed(digits);
  return x >= 0 && Number(s) !== 0 ? `+${s}` : Number(s) === 0 ? (0).toFixed(digits) : s;
}

function table(headers: string[], rows: string[][], leftAligned: number[] = []): string[] {
  const widths = headers.map((h, c) => Math.max(h.length, ...rows.map((r) => r[c]!.length)));
  const line = (cells: string[]): string =>
    cells
      .map((cell, c) => (leftAligned.includes(c) ? cell.padEnd(widths[c]!) : cell.padStart(widths[c]!)))
      .join('  ')
      .trimEnd();
  return [line(headers), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(line)];
}

/** The rows shared by experiments B and B2: one column per strategy. */
function comparisonTable(runs: WhoPaysRun[], top: number, giniStart: number): string[] {
  const col = (f: (r: WhoPaysRun) => string): string[] => runs.map(f);
  return table(
    ['', ...runs.map((r) => r.strategy)],
    [
      ['Rounds saved', ...col((r) => pct(r.savedShare))],
      ['Rounds collapsed (cut paid to It)', ...col((r) => pct(r.collapsedShare))],
      ['Rounds dormant (nothing charged)', ...col((r) => pct(r.dormantShare))],
      [
        'Average fraction of the round left when saved',
        ...col((r) => (r.avgSecondsLeftFraction === null ? 'n/a' : r.avgSecondsLeftFraction.toFixed(4))),
      ],
      [`Share of all burns paid by the top ${top} holders`, ...col((r) => (r.totalBurned === 0n ? 'n/a' : pct(r.topBurnShare)))],
      [`Share of all saves made by the top ${top} holders`, ...col((r) => (r.totalBurned === 0n ? 'n/a' : pct(r.topSaveShare)))],
      ['Total burned by volunteers (NOTIT)', ...col((r) => formatTokens(r.totalBurned))],
      ["Total paid to It, net of It's own cut (NOTIT)", ...col((r) => formatTokens(r.totalPaid))],
      ['Gini at start', ...col(() => giniStart.toFixed(4))],
      ['Gini at end', ...col((r) => r.giniEnd.toFixed(4))],
      [`Supply share of the top ${top} holders at end`, ...col((r) => pct(r.topSupplyShareEnd))],
      ['Supply share of It at end', ...col((r) => pct(r.itSupplyShareEnd))],
      ['Supply at end (NOTIT)', ...col((r) => formatTokens(r.supplyEnd))],
    ],
    [0],
  );
}

function keyValues(pairs: [string, string][]): string[] {
  const width = Math.max(...pairs.map(([k]) => k.length));
  return pairs.map(([k, v]) => `${k.padEnd(width)}  ${v}`);
}

/** The plain-text report printed by `npm run lab`. */
export function formatLab(lab: LabResult): string {
  const out: string[] = [];
  const a = lab.bystander;
  out.push('NOT IT - SIMULATION LAB');
  out.push('');
  out.push(`A. Bystander effect - N equal players, all mixedFinalBlock, ${a.trials} independent one-round trials each (seed ${a.seed})`);
  out.push('   One extra equal account became It in a setup round and never volunteers. x = player balance, c = final-slot cost.');
  out.push('   q = c / (cut * x);  p = 1 - q^(1/(N-1));  theory P(fail) = q^(N/(N-1)), or 1 if q >= 1');
  out.push('');
  out.push(
    ...table(
      ['N', 'q', 'p', 'theory P(fail)', 'simulated', 'diff'],
      a.rows.map((r) => [
        String(r.n),
        r.q.toFixed(4),
        r.p.toFixed(4),
        r.theory.toFixed(4),
        r.simulated.toFixed(4),
        signed(r.diff, 4),
      ]),
    ),
  );
  out.push('');

  const b = lab.whoPays;
  out.push(`B. Who pays - ${b.holders} holders, Pareto balances (alpha ${b.alpha}), ${b.rounds} rounds per strategy (seed ${b.seed})`);
  out.push(`   Both runs start armed: the largest holder (${b.initialIt}) volunteered in a setup round.`);
  out.push(
    `   At the start: supply ${formatTokens(b.supplyStart)} NOTIT, Gini ${b.giniStart.toFixed(4)}, top ${b.top} holders own ${pct(b.topSupplyShareStart)}.`,
  );
  out.push('');
  out.push(...comparisonTable(b.runs, b.top, b.giniStart));
  out.push('');
  out.push('   The two columns are identical: with large holders present no round ever fails, so the throne is worth nothing.');
  out.push('');
  out.push('   Cold start (no setup round, nobody is It):');
  for (const k of b.coldStart) {
    const when = k.firstSavedRound === null ? 'nobody ever volunteers' : `first volunteer in round ${k.firstSavedRound}`;
    out.push(`   ${k.strategy.padEnd(13)}  ${pct(k.savedShare)} saved, ${pct(k.dormantShare)} dormant (${when})`);
  }
  out.push('');

  const d = lab.dispersed;
  out.push(`B2. A dispersed crowd - ${d.holders} equal holders (${pct(1 / d.holders, 2)} of the supply each), ${d.rounds} rounds per strategy (seed ${d.seed})`);
  out.push(`   Both runs start armed: ${d.initialIt} volunteered in a setup round. Nobody holds the 1.33% that makes a myopic save worth it.`);
  out.push(`   At the start: supply ${formatTokens(d.supplyStart)} NOTIT, Gini ${d.giniStart.toFixed(4)}.`);
  out.push('');
  out.push(...comparisonTable(d.runs, d.top, d.giniStart));
  out.push('');

  const c = lab.mixedCrowd;
  const mix = c.groups.map((g) => `${g.count} ${g.strategy}`).join(', ');
  out.push(`C. The idle get taxed - ${c.holders} holders (${mix}), ${c.rounds} rounds (seed ${c.seed})`);
  out.push('');
  out.push(
    ...keyValues([
      ['Failure rate', `${pct(c.failureRate)} (${c.saved} saved, ${c.collapsed} collapsed, ${c.dormant} dormant)`],
      ['Longest streak of saved rounds', String(c.longestStreak)],
      ['Supply at start (NOTIT)', formatTokens(c.supplyStart)],
      ['Supply at end (NOTIT)', formatTokens(c.supplyEnd)],
      ["Total paid to It, net of It's own cut (NOTIT)", formatTokens(c.totalPaid)],
      ['Balance share of the free riders, start -> end', `${pct(c.freeRiderShareStart)} -> ${pct(c.freeRiderShareEnd)}`],
    ]),
  );
  out.push('');
  out.push(
    ...table(
      ['strategy', 'holders', 'saves', 'burned (NOTIT)', 'collected (NOTIT)', 'rejected', 'missed', 'start share', 'end share'],
      c.groups.map((g) => [
        g.strategy,
        String(g.count),
        String(g.saves),
        formatTokens(g.burned),
        formatTokens(g.collected),
        String(g.rejected),
        String(g.missed),
        pct(g.shareStart),
        pct(g.shareEnd),
      ]),
      [0],
    ),
  );
  return out.join('\n') + '\n';
}
