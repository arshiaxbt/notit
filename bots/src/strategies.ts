// What each bot does in a round. A strategy sees the public state and its own balance and
// answers one question: volunteer now, or not.

import type { Config, State } from "./chain.ts";

export interface View {
  state: State;
  config: Config;
  balance: bigint;
  isIt: boolean;
  /** Fraction of the round that has elapsed, 0..1. */
  progress: number;
  /** One uniform random number per bot per round, so "sometimes" is decided once a round. */
  roll: number;
}

export type Strategy = (view: View) => boolean;

const PPM = 1_000_000n;

/** What a collapse of this round would cost this holder. */
function lossIfUnsaved(view: View): bigint {
  if (!view.state.armed || view.isIt) return 0n;
  return (view.balance * BigInt(view.config.cut_ppm)) / PPM;
}

/**
 * guardian — rational and myopic: once the round is in its last quarter, volunteers as soon
 * as the cost is below what a collapse would cost it. Never volunteers while it is It.
 */
const guardian: Strategy = (view) => view.progress >= 0.75 && BigInt(view.state.cost_now) < lossIfUnsaved(view);

/**
 * usurper — wants to be It: when nobody is It, or the game is dormant, or It has been
 * collecting for two rounds, it pays to take over once the cost has fallen halfway.
 * Otherwise it defends its balance like a guardian, but only in 60 % of rounds.
 */
const usurper: Strategy = (view) => {
  if (view.isIt) return false;
  const wantsThrone = view.state.it === null || !view.state.armed || view.state.collapse_run >= 2;
  return (wantsThrone && view.progress >= 0.5) || (view.roll < 0.6 && guardian(view));
};

/** flaky — a guardian that only shows up in 45 % of rounds. This is where collapses come from. */
const flaky: Strategy = (view) => view.roll < 0.45 && guardian(view);

/** saint — steps up early in one round out of five, whatever it costs. */
const saint: Strategy = (view) => !view.isIt && view.roll < 0.2 && view.progress >= 0.3;

/** idle — holds and never acts. Idle holders are the ones who pay It. */
const idle: Strategy = () => false;

export const STRATEGIES: Record<string, Strategy> = { guardian, usurper, flaky, saint, idle };

/** Default line-up: mostly unreliable, so rounds are sometimes saved and sometimes not. */
export const LINEUP = ["usurper", "flaky", "flaky", "saint", "idle", "idle"];
