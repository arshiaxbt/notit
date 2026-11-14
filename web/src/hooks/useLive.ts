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
  /** True when the round in the last snapshot is over and the next one is being shown from the local clock. */
  rolled: boolean;
  /** The round the clock is showing: the snapshot's, or the one after it once the local clock has rolled over. */
  round: number;
}

const IDLE: Live = { nowNs: 0n, msLeft: 0, progress: 0, cost: 0n, ratePpm: 0n, rolled: false, round: 0 };

export function useLive(game: Game, fps = 12): Live {
  return useTicker(() => {
    const snap = game.snapshot;
    if (!snap) return IDLE;
    const { state, config } = snap;
    let nowNs = game.nowNs();
    if (nowNs < state.nowNs) nowNs = state.nowNs;
    const roundMs = Number(config.roundNs / 1_000_000n);
    if (nowNs >= state.roundEndNs && config.roundNs > 0n) {
      // The round on screen is over and the chain has not answered yet. Rounds follow each
      // other without a gap, so the next one is shown at once from the local clock; a round
      // that ends unsaved moves tokens but burns none, so the supply it starts from is known.
      const ahead = (nowNs - state.roundEndNs) / config.roundNs;
      const start = state.roundEndNs + ahead * config.roundNs;
      const msLeft = msLeftAt(start + config.roundNs, nowNs);
      const progress = roundMs > 0 ? Math.min(1, Math.max(0, 1 - msLeft / roundMs)) : 0;
      return { nowNs, msLeft, progress, cost: costAt(config, state.totalSupply, start, nowNs), ratePpm: ratePpmAt(config, start, nowNs), rolled: true, round: state.round + 1 + Number(ahead) };
    }
    const msLeft = msLeftAt(state.roundEndNs, nowNs);
    const progress = roundMs > 0 ? Math.min(1, Math.max(0, 1 - msLeft / roundMs)) : 0;
    const cost = state.saved ? 0n : costAt(config, state.roundSupply, state.roundStartNs, nowNs);
    return { nowNs, msLeft, progress, cost, ratePpm: ratePpmAt(config, state.roundStartNs, nowNs), rolled: false, round: state.round };
  }, fps);
}
