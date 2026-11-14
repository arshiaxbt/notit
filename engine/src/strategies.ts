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

/**
 * §11: symmetric mixed-equilibrium volunteering probability for n identical myopic
 * holders, p = 1 − q^(1/(n−1)) with q = c / (cut × x). 0 if q ≥ 1 (or not a number);
 * a lone contender volunteers for sure whenever q < 1.
 */
export function mixedEquilibriumP(q: number, contenders: number): number {
  if (!(q < 1)) return 0;
  if (q <= 0) return 1;
  if (contenders <= 1) return 1;
  return 1 - Math.pow(q, 1 / (contenders - 1));
}

/** §11: probability that nobody volunteers when all n contenders play p: q^(n/(n−1)). */
export function mixedEquilibriumFailure(q: number, contenders: number): number {
  if (!(q < 1)) return 1;
  if (q <= 0) return 0;
  if (contenders <= 1) return 0;
  return Math.pow(q, contenders / (contenders - 1));
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
 * Myopic, final block only (§11). In an armed round, a holder who is not It waits
 * for the final slot and volunteers with probability p = 1 − q^(1/(n−1)),
 * q = cost_at_final_slot / (cut × own_balance). Never volunteers in a dormant round
 * (nothing would be charged) or as It.
 */
export function mixedFinalBlock(): Strategy {
  return {
    kind: 'mixedFinalBlock',
    decide(ctx) {
      if (!ctx.isFinalSlot || !ctx.armed || ctx.isIt) return 'pass';
      const p = mixedEquilibriumP(ctx.costFinal / (ctx.cut * ctx.balance), ctx.contenders);
      if (p <= 0) return 'pass';
      return ctx.rng() < p ? 'volunteer' : 'pass';
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
