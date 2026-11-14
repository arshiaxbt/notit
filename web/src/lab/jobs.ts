/**
 * The Lab's work, as small pure jobs. Each one calls the simulator and the
 * experiment functions of `@notit/engine`; nothing here knows about React or
 * workers, so the same code runs in the Web Worker and (as a fallback) on the
 * main thread.
 */
import {
  FAST,
  UNIT,
  classicDilemma,
  firstPaysEquilibrium,
  runBystander,
  runForwardLooking,
  runMixedCrowd,
  runWhoPays,
  simulate,
  toTokens,
} from '@notit/engine';
import type { AgentSpec, ForwardLookingResult, MixedCrowdResult, StrategySpec, WhoPaysResult } from '@notit/engine';

export type BystanderPreset = 'equilibrium' | 'myopic' | 'throne' | 'snipers' | 'altruists';

export const PRESETS: Record<BystanderPreset, { label: string; blurb: string; spec: StrategySpec }> = {
  equilibrium: {
    label: 'Coin-flippers (the equilibrium)',
    blurb: 'Everyone waits for the final moment, then volunteers with the probability the equilibrium predicts.',
    spec: { kind: 'mixedFinalBlock' },
  },
  myopic: {
    label: 'Rule followers',
    blurb: 'Each holder pays as soon as the cost is less than what an unsaved round would take from them.',
    spec: { kind: 'rationalTimer' },
  },
  throne: {
    label: 'Also want to be It',
    blurb: 'Like rule followers, but they also count what being It could earn them later.',
    spec: { kind: 'throneAware' },
  },
  snipers: {
    label: 'Last-second snipers',
    blurb: 'Everyone tries in the final block, and one try in five lands too late.',
    spec: { kind: 'sniper', missRate: 0.2 },
  },
  altruists: {
    label: 'Occasional altruists',
    blurb: 'Each holder volunteers in 5% of rounds, whatever the price.',
    spec: { kind: 'altruist', h: 0.05 },
  },
};

/** Crowd sizes always simulated for the curve; the chosen size is added to them. */
export const SWEEP = [2, 3, 5, 8, 12, 20, 30, 45, 60, 75, 100, 150, 200, 300];

export interface BystanderRow {
  n: number;
  /** q = cost in the final block / (cut × a player's balance), SPEC §11. */
  q: number;
  /** Equilibrium chance that one holder volunteers, under the deployed rule: only the first volunteer pays. */
  p: number;
  /** That equilibrium's chance that nobody volunteers. */
  equilibrium: number;
  /** The same chance in the textbook dilemma, where every volunteer pays. For comparison only. */
  classic: number;
  /** Simulated share of rounds nobody saved. */
  simulated: number;
  trials: number;
  failed: number;
}

export interface PathPoint {
  round: number;
  /** Supply when the round opened, whole NOTIT. */
  supply: number;
  outcome: 'saved' | 'collapsed' | 'dormant';
}

export interface PathResult {
  n: number;
  rounds: number;
  points: PathPoint[];
  saved: number;
  collapsed: number;
  dormant: number;
  supplyStart: bigint;
  supplyEnd: bigint;
  totalBurned: bigint;
  /** Value moved from the other holders to It by unsaved rounds. */
  totalPaid: bigint;
}

export type Job =
  | { kind: 'row'; n: number; trials: number; preset: BystanderPreset; seed: number }
  | { kind: 'path'; n: number; rounds: number; preset: BystanderPreset; seed: number }
  | { kind: 'whoPays'; holders: number; rounds: number; seed: number }
  | { kind: 'forwardLooking' }
  | { kind: 'mixedCrowd'; altruists: number; snipers: number; freeRiders: number; missRate: number; rounds: number; seed: number };

export interface JobResults {
  row: BystanderRow;
  path: PathResult;
  whoPays: WhoPaysResult;
  forwardLooking: ForwardLookingResult;
  mixedCrowd: MixedCrowdResult;
}

const BALANCE = 1000n * UNIT;

/** N players with the same strategy, plus one account that is already It and sits still. */
function crowd(n: number, spec: StrategySpec): AgentSpec[] {
  const agents: AgentSpec[] = [];
  for (let i = 0; i < n; i++) agents.push({ id: `player-${i + 1}`, balance: BALANCE, strategy: spec });
  agents.push({ id: 'it', balance: BALANCE, strategy: { kind: 'freeRider' } });
  return agents;
}

/** One point of the failure-rate curve: `trials` independent armed rounds with N players. */
export function bystanderRow(n: number, trials: number, preset: BystanderPreset, seed: number): BystanderRow {
  if (preset === 'equilibrium') {
    // The engine's own experiment: all players `mixedFinalBlock`.
    const r = runBystander({ ns: [n], trials, seed }).rows[0]!;
    return { n: r.n, q: r.q, p: r.equilibriumP, equilibrium: r.equilibriumFail, classic: r.classicFail, simulated: r.simulated, trials: r.trials, failed: r.failed };
  }
  // Same set-up as runBystander, with a different strategy for the players.
  const sim = simulate({
    agents: crowd(n, PRESETS[preset].spec),
    rounds: trials,
    seed: seed + n,
    initialIt: n,
    resetEachRound: true,
  });
  const cut = FAST.cutPpm / 1e6;
  const q = Number(sim.opening.costFinal) / (cut * Number(sim.agents[0]!.balanceStart));
  return {
    n,
    q,
    p: firstPaysEquilibrium(n, q).p,
    equilibrium: firstPaysEquilibrium(n, q).fail,
    classic: classicDilemma(n, q).fail,
    simulated: sim.failureRate,
    trials,
    failed: sim.collapsed + sim.dormant,
  };
}

/** One continuous game with N players: the supply round by round. */
export function supplyPath(n: number, rounds: number, preset: BystanderPreset, seed: number): PathResult {
  const sim = simulate({
    agents: crowd(n, PRESETS[preset].spec),
    rounds,
    seed: seed + 7 * n,
    initialIt: n,
    timeline: true,
  });
  return {
    n,
    rounds,
    points: sim.timeline.map((t) => ({ round: t.round, supply: toTokens(t.supply), outcome: t.outcome })),
    saved: sim.saved,
    collapsed: sim.collapsed,
    dormant: sim.dormant,
    supplyStart: sim.supplyStart,
    supplyEnd: sim.supplyEnd,
    totalBurned: sim.totalBurned,
    totalPaid: sim.totalPaid,
  };
}

/** q of SPEC §11 for N holders plus It, all with equal balances: the cheapest save over what an unsaved round takes. */
function qFor(n: number): number {
  return (FAST.minCostPpm * (n + 1)) / FAST.cutPpm;
}

/** The equilibrium curve under the deployed rule (only the first volunteer pays). */
export function equilibriumFailure(n: number): number {
  return firstPaysEquilibrium(n, qFor(n)).fail;
}

/** The textbook dilemma's curve, where every volunteer pays. For comparison only. */
export function classicFailure(n: number): number {
  return classicDilemma(n, qFor(n)).fail;
}

/** Smallest crowd for which even the cheapest save costs a player more than a collapse. */
export function nobodyPaysFrom(): number {
  return Math.ceil(FAST.cutPpm / FAST.minCostPpm) - 1;
}

export function runJob<K extends Job['kind']>(job: Extract<Job, { kind: K }>): JobResults[K];
export function runJob(job: Job): JobResults[Job['kind']] {
  switch (job.kind) {
    case 'row':
      return bystanderRow(job.n, job.trials, job.preset, job.seed);
    case 'path':
      return supplyPath(job.n, job.rounds, job.preset, job.seed);
    case 'whoPays':
      return runWhoPays({ holders: job.holders, rounds: job.rounds, seed: job.seed });
    case 'forwardLooking':
      return runForwardLooking();
    case 'mixedCrowd':
      return runMixedCrowd({
        altruists: job.altruists,
        snipers: job.snipers,
        freeRiders: job.freeRiders,
        missRate: job.missRate,
        rounds: job.rounds,
        seed: job.seed,
      });
  }
}
