/**
 * Demo mode: the rules engine running in the browser, a clock that can run
 * faster than real time, a crowd of simulated holders, and one "you" account
 * that starts with nothing claimed. No wallet, no keys, no network.
 *
 * There is no timer in here. Every call first replays whatever the crowd did
 * between the last call and "now" on the demo clock, at the exact game times
 * the bots chose, then answers. That keeps it deterministic and testable.
 */
import { FAST, MAX_COLLAPSE_RUN, NotIt } from '@notit/engine';
import type { Config } from '@notit/engine';
import { DEFAULT_CROWD } from './bots';
import { describeError, errorCode } from './errors';
import type { BotSpec } from './bots';
import { ScaledClock } from './clock';
import type { Clock } from './clock';
import { makeRng } from './rng';
import type { Rng } from './rng';
import type {
  AccountView,
  ConfigView,
  CrowdMember,
  DemoControls,
  GameClient,
  Hero,
  HistoryEntry,
  StateView,
  TxResult,
  VolunteerGuard,
} from './types';

export const DEMO_ACCOUNT = 'you.demo';
/** Chosen so the demo opens on a lively history: a streak, a few collapses, a close call. */
const DEFAULT_SEED = 3;

export interface MockOptions {
  /** Seed for the crowd's choices. Same seed, same history. */
  seed?: number;
  /** If set, the crowd is re-seeded with this once the played-in history is done. */
  liveSeed?: number;
  /** Real seconds one round takes. Default 30. */
  roundSeconds?: number;
  /** Rounds already played when the demo opens, so the page is not empty. */
  warmupRounds?: number;
  /** How far into the current round the demo opens (0..1). */
  openAt?: number;
  /** Game time at which the demo opens, ns. Defaults to the wall clock. */
  startNs?: bigint;
  /** Supply your own clock (tests use ManualClock). */
  clock?: Clock;
  crowd?: BotSpec[];
  /** Engine parameters. Defaults to the `fast` instance from SPEC §2. */
  params?: Omit<Config, 'genesisNs'>;
}

interface Move {
  at: bigint;
  bot: string;
}

export class MockClient implements GameClient, DemoControls {
  readonly pollMs = 1000;

  private readonly opts: MockOptions;
  private readonly params: Omit<Config, 'genesisNs'>;
  private readonly specs: BotSpec[];
  /** The crowd as it stands now: bots that run dry are replaced by newcomers. */
  private bots: Array<{ accountId: string; base: string; generation: number; spec: BotSpec }> = [];
  private clock!: Clock;
  private engine!: NotIt;
  private config!: Config;
  private rng!: Rng;
  private secondsPerRound: number;
  /** Round whose bot moves are being replayed. */
  private cursor = 0;
  private plan: Move[] | null = null;
  private planIdx = 0;

  constructor(opts: MockOptions = {}) {
    this.opts = opts;
    this.params = opts.params ?? FAST;
    this.specs = opts.crowd ?? DEFAULT_CROWD;
    this.secondsPerRound = opts.roundSeconds ?? 30;
    this.start();
  }

  // ---------- set-up ----------

  private gameSecondsPerRound(): number {
    return Number(this.params.roundNs) / 1e9;
  }

  private start(): void {
    const { roundNs } = this.params;
    this.rng = makeRng(this.opts.seed ?? DEFAULT_SEED);

    const rate = this.gameSecondsPerRound() / this.secondsPerRound;
    if (this.opts.clock) {
      this.clock = this.opts.clock;
    } else {
      const startNs = this.opts.startNs ?? BigInt(Date.now()) * 1_000_000n;
      this.clock = new ScaledClock(startNs, rate);
    }
    const startNs = this.clock.now();
    const warmup = BigInt(this.opts.warmupRounds ?? 64);
    const openAt = Math.min(0.95, Math.max(0, this.opts.openAt ?? 0.3));
    const into = (roundNs * BigInt(Math.round(openAt * 1000))) / 1000n;
    const genesisNs = startNs - warmup * roundNs - into;

    this.config = { ...this.params, genesisNs };
    this.engine = new NotIt(this.config);
    this.cursor = 0;
    this.plan = null;
    this.planIdx = 0;

    // Everyone in the crowd claims at genesis. A whale is built by letting a
    // few throwaway accounts claim and pass their tokens on.
    this.bots = this.specs.map((spec) => ({
      accountId: spec.accountId,
      base: spec.accountId.replace(/\.demo$/, ''),
      generation: 1,
      spec,
    }));
    for (const spec of this.specs) {
      this.engine.claim(spec.accountId, genesisNs);
      for (let i = 0; i < (spec.extraClaims ?? 0); i++) {
        const donor = `${spec.accountId.replace(/\.demo$/, '')}-friend-${i + 1}.demo`;
        this.engine.claim(donor, genesisNs);
        this.engine.transfer(donor, spec.accountId, this.engine.balanceOf(donor, genesisNs), genesisNs);
      }
    }
    this.catchUp();
    // The current round was planned during the catch-up; later rounds use the live seed.
    if (this.opts.liveSeed !== undefined) this.rng = makeRng(this.opts.liveSeed);
  }

  // ---------- the crowd ----------

  private planRound(round: number, startNs: bigint): Move[] {
    const { roundNs } = this.config;
    // Settle up to this round first so balances and the supply snapshot are current.
    this.engine.poke(startNs);
    const st = this.engine.state(startNs);
    if (st.roundSupply === 0n || st.round !== round) return [];
    const lastCollapsed = st.collapseRun > 0;
    const floorCost = (st.roundSupply * BigInt(this.config.minCostPpm)) / 1_000_000n;
    const dust = st.roundSupply / 400n;
    const moves: Move[] = [];
    for (const bot of this.bots) {
      const spec = bot.spec;
      let balance = this.engine.balanceOf(bot.accountId, startNs);
      const isIt = st.it === bot.accountId;
      // Volunteers burn and bystanders get cut: a bot that is down to dust or
      // cannot afford even the cheapest save leaves, and a newcomer with a
      // fresh claim takes its place. Whoever is It stays to collect.
      const spent = balance < floorCost * 2n || balance < dust;
      if (spent && !isIt && this.config.claimAmount >= floorCost * 4n && st.claimOpen) {
        const next = `${bot.base}-${bot.generation + 1}.demo`;
        try {
          this.engine.claim(next, startNs);
          bot.generation += 1;
          bot.accountId = next;
          balance = this.engine.balanceOf(next, startNs);
        } catch {
          // Faucet closed: the bot stays as it is.
        }
      }
      const frac = spec.strategy.decide({
        rng: this.rng,
        balance,
        roundSupply: st.roundSupply,
        maxCostPpm: this.config.maxCostPpm,
        minCostPpm: this.config.minCostPpm,
        cutPpm: this.config.cutPpm,
        lastCollapsed,
        isIt,
        armed: st.armed,
      });
      if (frac === null || !(frac >= 0) || frac >= 1) continue; // at or past the bell: too late
      const offset = (roundNs * BigInt(Math.floor(frac * 1_000_000))) / 1_000_000n;
      moves.push({ at: startNs + offset, bot: bot.accountId });
    }
    moves.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    return moves;
  }

  /** Replays everything the crowd did up to `now` and settles closed rounds. */
  private catchUp(): bigint {
    const now = this.clock.now();
    const { roundNs, genesisNs } = this.config;
    for (;;) {
      const startNs = genesisNs + BigInt(this.cursor) * roundNs;
      if (now < startNs) break;
      if (this.plan === null) {
        this.plan = this.planRound(this.cursor, startNs);
        this.planIdx = 0;
      }
      while (this.planIdx < this.plan.length) {
        const move = this.plan[this.planIdx]!;
        if (move.at > now) break;
        this.planIdx++;
        try {
          this.engine.volunteer(move.bot, move.at);
          this.planIdx = this.plan.length; // saved: the rest stand down
        } catch {
          // Already saved or cannot afford it: the bot shrugs.
        }
      }
      if (now >= startNs + roundNs) {
        this.cursor++;
        this.plan = null;
        continue;
      }
      break;
    }
    this.engine.poke(now);
    return now;
  }

  // ---------- NotItClient ----------

  accountId(): string {
    return DEMO_ACCOUNT;
  }

  timeScale(): number {
    return this.clock.rate();
  }

  async getConfig(): Promise<ConfigView> {
    const c = this.config;
    return {
      roundNs: c.roundNs,
      maxCostPpm: c.maxCostPpm,
      minCostPpm: c.minCostPpm,
      cutPpm: c.cutPpm,
      claimAmount: c.claimAmount,
      claimCap: c.claimCap,
      genesisNs: c.genesisNs,
      decimals: 18,
      maxCollapseRun: MAX_COLLAPSE_RUN,
    };
  }

  async getState(): Promise<StateView> {
    const now = this.catchUp();
    const s = this.engine.state(now);
    return {
      nowNs: s.nowNs,
      round: Number(s.round),
      roundStartNs: s.roundStartNs,
      roundEndNs: s.roundEndNs,
      saved: s.saved,
      hero: s.hero ?? null,
      it: s.it ?? null,
      armed: s.armed,
      collapseRun: s.collapseRun,
      costNow: s.costNow,
      roundSupply: s.roundSupply,
      totalSupply: s.totalSupply,
      index: s.index,
      scale: s.scale,
      claimsMade: s.claimsMade,
      claimOpen: s.claimOpen,
      stats: {
        roundsSaved: s.stats.roundsSaved,
        roundsCollapsed: s.stats.roundsCollapsed,
        currentStreak: s.stats.currentStreak,
        longestStreak: s.stats.longestStreak,
        closestCallMs: s.stats.closestCallMs ?? null,
        totalBurned: s.stats.totalBurned,
        totalPaid: s.stats.totalPaid,
      },
    };
  }

  async getAccount(id: string): Promise<AccountView> {
    const now = this.catchUp();
    const a = this.engine.account(id, now);
    return {
      registered: a.registered,
      claimed: a.claimed,
      balance: a.balance,
      saves: a.saves,
      burned: a.burned,
      collected: a.collected,
      isIt: a.isIt,
    };
  }

  private allHistory(now: bigint): HistoryEntry[] {
    return this.engine.history(now).map((e): HistoryEntry =>
      e.kind === 'saved'
        ? { kind: 'saved', round: Number(e.round), hero: e.hero, cost: e.cost, msLeft: e.msLeft }
        : {
            kind: 'collapsed',
            firstRound: Number(e.firstRound),
            lastRound: Number(e.lastRound),
            count: e.count,
            it: e.it,
            paid: e.paid,
          },
    );
  }

  async getHistory(from: number, limit: number): Promise<HistoryEntry[]> {
    const now = this.catchUp();
    const start = Math.max(0, from);
    return this.allHistory(now).slice(start, start + Math.min(100, Math.max(0, limit)));
  }

  async getHistoryLen(): Promise<number> {
    const now = this.catchUp();
    return this.engine.history(now).length;
  }

  async getHeroes(from: number, limit: number): Promise<Hero[]> {
    this.catchUp();
    const start = Math.max(0, from);
    return this.engine
      .heroes()
      .slice(start, start + Math.min(100, Math.max(0, limit)))
      .map((h) => ({ accountId: h.accountId, saves: h.saves, burned: h.burned, collected: h.collected }));
  }

  private fail(e: unknown): TxResult {
    const code = errorCode(e);
    return { ok: false, code, message: describeError(code) };
  }

  async claim(): Promise<TxResult> {
    const now = this.catchUp();
    try {
      this.engine.claim(DEMO_ACCOUNT, now);
      return { ok: true };
    } catch (e) {
      return this.fail(e);
    }
  }

  async volunteer(guard: VolunteerGuard): Promise<TxResult> {
    const now = this.catchUp();
    try {
      const r = this.engine.volunteer(DEMO_ACCOUNT, now, { round: guard.round, maxCost: guard.maxCost });
      return { ok: true, cost: r.cost, msLeft: r.msLeft };
    } catch (e) {
      return this.fail(e);
    }
  }

  async poke(): Promise<TxResult> {
    const now = this.clock.now();
    try {
      const settled = this.engine.poke(now);
      this.catchUp();
      return { ok: true, settled };
    } catch (e) {
      return this.fail(e);
    }
  }

  // ---------- DemoControls ----------

  roundSeconds(): number {
    return this.secondsPerRound;
  }

  setRoundSeconds(seconds: number): void {
    if (!(seconds > 0)) return;
    this.catchUp();
    this.secondsPerRound = seconds;
    this.clock.setRate(this.gameSecondsPerRound() / seconds);
  }

  crowd(): CrowdMember[] {
    const now = this.catchUp();
    return this.bots.map((bot) => {
      const a = this.engine.account(bot.accountId, now);
      return {
        accountId: bot.accountId,
        strategy: bot.spec.strategy.name,
        blurb: bot.spec.strategy.blurb,
        balance: a.balance,
        saves: a.saves,
        burned: a.burned,
        collected: a.collected,
        isIt: a.isIt,
      };
    });
  }
}
