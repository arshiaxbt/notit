// Holder strategies for the simulator, using the payoffs of SPEC §11. Decisions are
// made with real (floating-point) numbers; the engine itself stays integer-only.
// Browser-safe: no node: imports.

/**
 * What an agent does in a slot:
 * - `pass`: nothing.
 * - `volunteer`: sends volunteer(); it lands in this slot.
 * - `miss`: sends volunteer(), but the transaction lands after the deadline. With the
 *   `round` guard of §5.2 it fails with ERR_WRONG_ROUND at no cost, so the simulator
 *   just counts it.
 */
export type Decision = 'pass' | 'volunteer' | 'miss';

/** Given to `startRound` once per round, before slot 0. */
export interface RoundContext {
  round: number;
  slots: number;
  rng: () => number;
}

/**
 * Given to `decide` once per slot while the round is still unsaved. The simulator
 * reuses one object for every call, so strategies must not keep a reference to it.
 * Amounts are base units converted to floating point.
 */
export interface SlotContext {
  round: number;
  /** 0-based slot within the round. */
  slot: number;
  slots: number;
  /** True in the last slot (the final block before the deadline). */
  isFinalSlot: boolean;
  /** True if this round is charged when nobody volunteers (§3 `armed`). */
  armed: boolean;
  /** True if the deciding agent is It (the last volunteer). */
  isIt: boolean;
  /** n of §11: agents with a positive balance, It excluded. */
  contenders: number;
  /** The agent's own balance. */
  balance: number;
  /** Total supply when the round opened. */
  supply: number;
  /** Sacrifice cost in this slot. */
  costNow: number;
  /** Sacrifice cost in the final slot. */
  costFinal: number;
  /** cut_ppm as a fraction (0.15). */
  cut: number;
  /** MAX_COLLAPSE_RUN: how many unsaved rounds in a row are charged after a volunteer. */
  maxCollapseRun: number;
  /**
   * Share of the recently completed rounds (the simulator's `failureWindow`) that
   * nobody saved, collapsed or dormant. 0 before any round has completed.
   */
  recentFailureRate: number;
  rng: () => number;
}

export interface Strategy {
  readonly kind: string;
  startRound?(ctx: RoundContext): void;
  decide(ctx: SlotContext): Decision;
}

/** Serialisable description of a built-in strategy (what a UI would store). */
export type StrategySpec =
  | { kind: 'mixedFinalBlock' }
  | { kind: 'rationalTimer'; patience?: number }
  | { kind: 'throneAware'; patience?: number }
  | { kind: 'altruist'; h: number }
  | { kind: 'freeRider' }
  | { kind: 'sniper'; missRate: number };

export const STRATEGY_KINDS = [
  'mixedFinalBlock',
  'rationalTimer',
  'throneAware',
  'altruist',
  'freeRider',
  'sniper',
] as const;

export interface Equilibrium {
  /** Probability that one holder volunteers. */
  p: number;
  /** Probability that nobody volunteers: (1 − p)^n. */
  fail: number;
}

/**
 * The symmetric equilibrium of the final block under the deployed rule, where only
 * the FIRST volunteer pays (later calls fail with ERR_ALREADY_SAVED and burn nothing).
 *
 * n identical myopic holders (It excluded) decide at once; each submits with
 * probability p; the first submitter in a uniformly random order pays c;
 * q = c / (cut × x). A submitter pays with probability E[1/(K+1)], K ~ Binomial(n−1, p),
 * which is (1 − (1−p)^n) / (n·p); a non-submitter loses cut × x only if nobody
 * submits, probability (1−p)^(n−1). Indifference:
 *
 *   q × (1 − (1−p)^n) / (n·p) = (1−p)^(n−1)
 *
 * Equivalently h(p) = q with h(p) = n·p·(1−p)^(n−1) / (1 − (1−p)^n) = n / Σ_{k<n} (1−p)^(−k),
 * which falls strictly from 1 (p → 0) to 0 (p = 1). So for 0 < q < 1 and n ≥ 2 there is
 * exactly one interior solution, found here by bisection; for q ≥ 1 nobody volunteers
 * (p = 0, fail = 1). A lone holder (n = 1) always pays when it submits, so it
 * volunteers for sure whenever q < 1.
 *
 * This is the only SYMMETRIC equilibrium. The game also has n asymmetric ones in
 * which one designated holder always volunteers and nobody else does (fail = 0).
 */
export function firstPaysEquilibrium(n: number, q: number): Equilibrium {
  if (!(q < 1) || n < 1) return { p: 0, fail: 1 };
  if (q <= 0 || n === 1) return { p: 1, fail: 0 };
  // h(p), written with log1p/expm1 so that tiny p (q close to 1) keeps its precision.
  const h = (p: number): number => {
    const l = Math.log1p(-p); // ln(1 − p); −Infinity at p = 1
    return (n * p * Math.exp((n - 1) * l)) / -Math.expm1(n * l);
  };
  let lo = 0; // h(lo) > q
  let hi = 1; // h(hi) < q
  for (let i = 0; i < 2000; i++) {
    const mid = (lo + hi) / 2;
    if (mid <= lo || mid >= hi) break;
    if (h(mid) > q) lo = mid;
    else hi = mid;
  }
  const p = (lo + hi) / 2;
  return { p, fail: Math.exp(n * Math.log1p(-p)) };
}

/**
 * The textbook volunteer's dilemma, in which EVERY volunteer pays:
 * p = 1 − q^(1/(n−1)), fail = q^(n/(n−1)). Not the deployed rule; kept for comparison.
 */
export function classicDilemma(n: number, q: number): Equilibrium {
  if (!(q < 1) || n < 1) return { p: 0, fail: 1 };
  if (q <= 0 || n === 1) return { p: 1, fail: 0 };
  return { p: 1 - Math.pow(q, 1 / (n - 1)), fail: Math.pow(q, n / (n - 1)) };
}

/**
 * Equilibrium volunteering probability for `contenders` holders: `firstPaysEquilibrium(contenders, q).p`.
 * (Before the first-pays correction this returned the textbook value; that is now `classicDilemma`.)
 */
export function mixedEquilibriumP(q: number, contenders: number): number {
  return firstPaysEquilibrium(contenders, q).p;
}

/** Equilibrium probability that nobody volunteers: `firstPaysEquilibrium(contenders, q).fail`. */
export function mixedEquilibriumFailure(q: number, contenders: number): number {
  return firstPaysEquilibrium(contenders, q).fail;
}

/**
 * Estimated value of becoming It for a holder with balance `x` out of `supply`: the
 * expected collapse income of the next rounds if each of them independently goes
 * unsaved with probability `f`. The k-th unsaved round in a row pays
 * cut × (supply − x) × (1 − cut)^(k−1); the run is charged for `maxRun` rounds at most
 * and ends as soon as somebody else volunteers:
 *   cut × (supply − x) × Σ_{k=1..maxRun} f^k × (1 − cut)^(k−1)
 */
export function throneValue(x: number, supply: number, cut: number, f: number, maxRun: number): number {
  if (!(f > 0) || !(supply > x)) return 0;
  let weight = 0;
  let term = f;
  for (let k = 1; k <= maxRun; k++) {
    weight += term;
    term *= f * (1 - cut);
  }
  return cut * (supply - x) * weight;
}

/**
 * Myopic, final block only. In an armed round, a holder who is not It waits for the
 * final slot and volunteers with the first-pays equilibrium probability
 * (`firstPaysEquilibrium`) for q = cost_at_final_slot / (cut × own_balance) and
 * n = holders other than It. Never volunteers in a dormant round (nothing would be
 * charged) or as It.
 */
export function mixedFinalBlock(): Strategy {
  // The bisection is not free; identical rounds (same q and n) reuse the last answer.
  let lastQ = Number.NaN;
  let lastN = -1;
  let lastP = 0;
  return {
    kind: 'mixedFinalBlock',
    decide(ctx) {
      if (!ctx.isFinalSlot || !ctx.armed || ctx.isIt) return 'pass';
      const q = ctx.costFinal / (ctx.cut * ctx.balance);
      if (q !== lastQ || ctx.contenders !== lastN) {
        lastQ = q;
        lastN = ctx.contenders;
        lastP = firstPaysEquilibrium(ctx.contenders, q).p;
      }
      if (lastP <= 0) return 'pass';
      return ctx.rng() < lastP ? 'volunteer' : 'pass';
    },
  };
}

/**
 * Myopic timer (§11). In an armed round, a holder who is not It volunteers at the
 * first slot where cost_now < cut × own_balance × patience; never otherwise.
 * `patience` is in (0, 1]: lower values wait for a cheaper price.
 */
export function rationalTimer(patience = 1): Strategy {
  if (!(patience > 0 && patience <= 1)) throw new Error('rationalTimer: patience must be in (0, 1]');
  return {
    kind: 'rationalTimer',
    decide(ctx) {
      if (!ctx.armed || ctx.isIt) return 'pass';
      return ctx.costNow < ctx.cut * ctx.balance * patience ? 'volunteer' : 'pass';
    },
  };
}

/**
 * `rationalTimer` plus the value of the throne. A holder who is not It volunteers at
 * the first slot where
 *   cost_now < (loss_avoided + throneValue) × patience
 * with loss_avoided = cut × own_balance in an armed round (0 in a dormant one) and
 * throneValue estimated from the observed recent failure rate (see `throneValue`).
 * Unlike the myopic strategies it can start or restart a dormant game.
 */
export function throneAware(patience = 1): Strategy {
  if (!(patience > 0 && patience <= 1)) throw new Error('throneAware: patience must be in (0, 1]');
  return {
    kind: 'throneAware',
    decide(ctx) {
      if (ctx.isIt) return 'pass';
      const avoided = ctx.armed ? ctx.cut * ctx.balance : 0;
      const throne = throneValue(ctx.balance, ctx.supply, ctx.cut, ctx.recentFailureRate, ctx.maxCollapseRun);
      return ctx.costNow < (avoided + throne) * patience ? 'volunteer' : 'pass';
    },
  };
}

/** With probability `h` per round, volunteers at a uniformly random slot, whatever the price or its role. */
export function altruist(h: number): Strategy {
  if (!(h >= 0 && h <= 1)) throw new Error('altruist: h must be in [0, 1]');
  let planned = -1;
  return {
    kind: 'altruist',
    startRound(ctx) {
      planned = ctx.rng() < h ? Math.floor(ctx.rng() * ctx.slots) : -1;
    },
    decide(ctx) {
      return ctx.slot === planned ? 'volunteer' : 'pass';
    },
  };
}

/** Never volunteers. */
export function freeRider(): Strategy {
  return {
    kind: 'freeRider',
    decide() {
      return 'pass';
    },
  };
}

/** Always volunteers in the final slot, but misses the deadline with probability `missRate`. */
export function sniper(missRate: number): Strategy {
  if (!(missRate >= 0 && missRate <= 1)) throw new Error('sniper: missRate must be in [0, 1]');
  return {
    kind: 'sniper',
    decide(ctx) {
      if (!ctx.isFinalSlot) return 'pass';
      return ctx.rng() < missRate ? 'miss' : 'volunteer';
    },
  };
}

/** Build a fresh strategy instance (strategies may keep per-agent state) from a spec. */
export function makeStrategy(spec: StrategySpec): Strategy {
  switch (spec.kind) {
    case 'mixedFinalBlock':
      return mixedFinalBlock();
    case 'rationalTimer':
      return rationalTimer(spec.patience ?? 1);
    case 'throneAware':
      return throneAware(spec.patience ?? 1);
    case 'altruist':
      return altruist(spec.h);
    case 'freeRider':
      return freeRider();
    case 'sniper':
      return sniper(spec.missRate);
    default:
      throw new Error(`unknown strategy: ${JSON.stringify(spec)}`);
  }
}
