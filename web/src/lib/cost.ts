/**
 * Local copy of the sacrifice-cost formula (SPEC §5.2 step 3) so the UI can
 * move the cost smoothly between polls. Must match the engine's `costAt`
 * exactly for any `now` inside the round; see cost.test.ts.
 */

export const PPM = 1_000_000n;

export interface CostParams {
  roundNs: bigint;
  maxCostPpm: number;
  minCostPpm: number;
}

function clampElapsed(p: CostParams, roundStartNs: bigint, nowNs: bigint): bigint {
  let elapsed = nowNs - roundStartNs;
  if (elapsed < 0n) elapsed = 0n;
  if (elapsed >= p.roundNs) elapsed = p.roundNs - 1n;
  return elapsed;
}

/** Cost rate in ppm of round supply at `nowNs`. */
export function ratePpmAt(p: CostParams, roundStartNs: bigint, nowNs: bigint): bigint {
  const elapsed = clampElapsed(p, roundStartNs, nowNs);
  const span = BigInt(p.maxCostPpm - p.minCostPpm);
  return BigInt(p.maxCostPpm) - (span * elapsed) / p.roundNs;
}

/** Sacrifice cost in units at `nowNs`. 0 when there is nothing to save. */
export function costAt(p: CostParams, roundSupply: bigint, roundStartNs: bigint, nowNs: bigint): bigint {
  if (roundSupply <= 0n) return 0n;
  const cost = (roundSupply * ratePpmAt(p, roundStartNs, nowNs)) / PPM;
  return cost < 1n ? 1n : cost;
}

/** Milliseconds left in the round, floored, never negative. */
export function msLeftAt(roundEndNs: bigint, nowNs: bigint): number {
  const left = roundEndNs - nowNs;
  return left <= 0n ? 0 : Number(left / 1_000_000n);
}

export interface Outcomes {
  /** Balance if someone else saves the round: nothing changes. */
  keep: bigint;
  /** Balance after an unsaved, charged round: the cut goes to It. */
  ifCollapsed: bigint;
  /** What the cut takes from this balance. */
  cutAmount: bigint;
  /** Balance after you burn `cost` now. Null if you cannot afford it. */
  ifYouDoIt: bigint | null;
}

/** What each ending does to one balance (SPEC §11). Display maths; rounding is floor. */
export function outcomesFor(balance: bigint, cost: bigint, cutPpm: number): Outcomes {
  const ifCollapsed = (balance * (PPM - BigInt(cutPpm))) / PPM;
  return {
    keep: balance,
    ifCollapsed,
    cutAmount: balance - ifCollapsed,
    ifYouDoIt: cost > 0n && balance >= cost ? balance - cost : null,
  };
}

/**
 * What It gains, net, if the round ends unsaved: the cut on everyone else's
 * balance. (It's own balance is cut too, but the whole pot comes back to It.)
 */
export function itCollects(totalSupply: bigint, itBalance: bigint, cutPpm: number): bigint {
  const others = totalSupply > itBalance ? totalSupply - itBalance : 0n;
  return (others * BigInt(cutPpm)) / PPM;
}

/** The guard the UI sends with volunteer(): the cost on screen plus a 2% margin. */
export function maxCostFor(shownCost: bigint): bigint {
  return shownCost + shownCost / 50n + 1n;
}
