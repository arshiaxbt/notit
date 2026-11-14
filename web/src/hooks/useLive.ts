import { costAt, msLeftAt, ratePpmAt } from '../lib/cost';
import type { Game } from './useGame';
import { useTicker } from './useTicker';

/** Values derived locally from the last snapshot, refreshed several times a second. */
export interface Live {
  nowNs: bigint;
  /** Game milliseconds left in the round. */
  msLeft: number;
  /** 0 at the start of the round, 1 at the deadline. */
  progress: number;
  /** Cost to volunteer right now; 0 if saved or nothing to save. */
  cost: bigint;
  /** Cost rate right now, ppm of round supply. */
  ratePpm: bigint;
}

const IDLE: Live = { nowNs: 0n, msLeft: 0, progress: 0, cost: 0n, ratePpm: 0n };

export function useLive(game: Game, fps = 12): Live {
  return useTicker(() => {
    const snap = game.snapshot;
    if (!snap) return IDLE;
    const { state, config } = snap;
    let nowNs = game.nowNs();
    if (nowNs < state.nowNs) nowNs = state.nowNs;
    // Never run past the end of the round on screen: the next poll brings the new one.
    if (nowNs >= state.roundEndNs) nowNs = state.roundEndNs - 1n;
    const msLeft = msLeftAt(state.roundEndNs, nowNs);
    const roundMs = Number(config.roundNs / 1_000_000n);
    const progress = roundMs > 0 ? Math.min(1, Math.max(0, 1 - msLeft / roundMs)) : 0;
    const cost = state.saved ? 0n : costAt(config, state.roundSupply, state.roundStartNs, nowNs);
    return { nowNs, msLeft, progress, cost, ratePpm: ratePpmAt(config, state.roundStartNs, nowNs) };
  }, fps);
}
