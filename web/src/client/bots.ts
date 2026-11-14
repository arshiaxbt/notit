/**
 * The simulated crowd for Demo mode. Each bot follows one named strategy.
 * A strategy looks at the round as it opens and answers: "at what point in
 * this round, if any, will I volunteer?" (a fraction 0..1 of the round).
 * Whoever gets there first saves the round; if every bot answers "never",
 * or aims past the deadline, the round ends unsaved and everyone pays It.
 */
import type { Rng } from './rng';

export interface BotContext {
  rng: Rng;
  /** This bot's balance when the round opens. */
  balance: bigint;
  /** Supply snapshot the cost is based on. */
  roundSupply: bigint;
  maxCostPpm: number;
  minCostPpm: number;
  cutPpm: number;
  /** True if the previous round collapsed. */
  lastCollapsed: boolean;
  /** This bot is It: it collects if the round ends unsaved. */
  isIt: boolean;
  /** An unsaved close of this round would be charged. */
  armed: boolean;
}

export interface Strategy {
  id: string;
  name: string;
  blurb: string;
  /** Fraction of the round at which the bot volunteers, or null for "not this round". */
  decide(ctx: BotContext): number | null;
}

/** Fraction of the round at which the cost rate falls to `ppm`. */
function whenRateIs(ctx: BotContext, ppm: number): number {
  const span = ctx.maxCostPpm - ctx.minCostPpm;
  if (span <= 0) return 0;
  return Math.min(1, Math.max(0, (ctx.maxCostPpm - ppm) / span));
}

/** What a charged collapse would take from this bot, as ppm of the round supply. */
function lossPpm(ctx: BotContext): number {
  if (ctx.roundSupply <= 0n) return 0;
  const sharePpm = Number((ctx.balance * 1_000_000n) / ctx.roundSupply);
  return (ctx.cutPpm * sharePpm) / 1_000_000;
}

/**
 * Whoever is It never volunteers: It collects if the round fails, and paying
 * again would only cost them. Every strategy below starts from that.
 */
function unlessIt(decide: (ctx: BotContext) => number | null): (ctx: BotContext) => number | null {
  return (ctx) => (ctx.isIt ? null : decide(ctx));
}

export const STRATEGIES = {
  earlyBird: {
    id: 'early-bird',
    name: 'Early bird',
    blurb: 'Now and then pays early, at a high cost, just to be sure.',
    decide: unlessIt(({ rng }) => (rng.chance(0.03) ? rng.range(0.1, 0.45) : null)),
  },
  fairShare: {
    id: 'takes-a-turn',
    name: 'Takes a turn',
    blurb: 'Steps up about one round in sixteen, somewhere in the second half.',
    decide: unlessIt(({ rng }) => (rng.chance(0.06) ? rng.range(0.5, 0.95) : null)),
  },
  maths: {
    id: 'does-the-maths',
    name: 'Does the maths',
    blurb: 'Pays once the cost is less than the 15% a collapse would take. Not always watching.',
    decide: unlessIt((ctx) => {
      if (!ctx.armed || !ctx.rng.chance(0.22)) return null;
      const tolerable = lossPpm(ctx);
      if (tolerable < ctx.minCostPpm) return null;
      return Math.min(0.985, whenRateIs(ctx, tolerable) + ctx.rng.range(0, 0.08));
    }),
  },
  whale: {
    id: 'whale',
    name: 'Whale',
    blurb: 'Holds the most, so a cut costs them the most. Pays when the cost is half of that loss.',
    decide: unlessIt((ctx) => {
      if (!ctx.armed || !ctx.rng.chance(0.3)) return null;
      const tolerable = 0.5 * lossPpm(ctx);
      if (tolerable < ctx.minCostPpm) return null;
      return Math.min(0.985, Math.max(whenRateIs(ctx, tolerable), ctx.rng.range(0.3, 0.8)));
    }),
  },
  throne: {
    id: 'throne-seeker',
    name: 'Wants to be It',
    blurb: 'Pays late and cheap to become It, then waits for the crowd to fail.',
    decide: unlessIt(({ rng }) => (rng.chance(0.15) ? rng.range(0.88, 0.99) : null)),
  },
  sniper: {
    id: 'sniper',
    name: 'Last-second sniper',
    blurb: 'Aims for the final seconds to pay the least. Sometimes misses.',
    // Aims at 94%–102% of the round: anything at or past 100% is a miss.
    decide: unlessIt(({ rng }) => (rng.chance(0.22) ? rng.range(0.94, 1.02) : null)),
  },
  guilty: {
    id: 'guilty',
    name: 'Guilty conscience',
    blurb: 'Mostly sits still, but steps up right after a collapse.',
    decide: unlessIt(({ rng, lastCollapsed }) => (rng.chance(lastCollapsed ? 0.6 : 0.02) ? rng.range(0.3, 0.8) : null)),
  },
  freeRider: {
    id: 'free-rider',
    name: 'Not it!',
    blurb: 'Never pays. Says "not it" and hopes someone else will.',
    decide: () => null,
  },
} satisfies Record<string, Strategy>;

export interface BotSpec {
  accountId: string;
  strategy: Strategy;
  /** Extra faucet claims funnelled to this bot at the start (makes a whale). */
  extraClaims?: number;
}

export const DEFAULT_CROWD: BotSpec[] = [
  { accountId: 'pip.demo', strategy: STRATEGIES.sniper },
  { accountId: 'juno.demo', strategy: STRATEGIES.fairShare },
  { accountId: 'otis.demo', strategy: STRATEGIES.freeRider },
  { accountId: 'bea.demo', strategy: STRATEGIES.maths },
  { accountId: 'big-mo.demo', strategy: STRATEGIES.whale, extraClaims: 4 },
  { accountId: 'noor.demo', strategy: STRATEGIES.throne },
  { accountId: 'sami.demo', strategy: STRATEGIES.guilty },
  { accountId: 'tess.demo', strategy: STRATEGIES.freeRider },
  { accountId: 'ravi.demo', strategy: STRATEGIES.sniper },
  { accountId: 'lola.demo', strategy: STRATEGIES.earlyBird },
  { accountId: 'kofi.demo', strategy: STRATEGIES.maths },
  { accountId: 'ines.demo', strategy: STRATEGIES.throne },
  { accountId: 'hugo.demo', strategy: STRATEGIES.sniper },
  { accountId: 'yuki.demo', strategy: STRATEGIES.fairShare },
  { accountId: 'dot.demo', strategy: STRATEGIES.guilty },
  { accountId: 'abe.demo', strategy: STRATEGIES.freeRider },
];
