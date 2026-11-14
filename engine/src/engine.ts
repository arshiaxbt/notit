// Not It ($NOTIT) rules engine. A literal BigInt transcription of docs/SPEC.md v2, §2–§8.
//
// The engine has no clock and no randomness: every call takes `now` (nanoseconds).
// u128/u256 values are bigint; u32 counters, round numbers, scales and millisecond
// values are plain numbers. Every division is a floor unless marked as a ceil.
//
// Erasable TypeScript only (no enums, namespaces or parameter properties) so Node can
// run this file directly and Vite can import it as source. No node: imports.

// ---------------------------------------------------------------------------
// Constants (§2)
// ---------------------------------------------------------------------------

export const DECIMALS = 18;
/** Fixed-point scale of `index`. */
export const RAY = 10n ** 27n;
/** Parts-per-million scale for rates. */
export const PPM = 1_000_000n;
/** Unsaved rounds charged in a row. */
export const MAX_COLLAPSE_RUN = 8;
/** Rescale when `index` falls below this. */
export const RESCALE_BELOW = 10n ** 18n;
/** Rescale multiplier. */
export const RESCALE_FACTOR = 10n ** 9n;
/** 1 NOTIT in base units. */
export const UNIT = 10n ** 18n;

const NS_PER_MS = 1_000_000n;
const U32_MAX = 0xffff_ffff;
const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;
const MAX_CLAIMABLE = 10n ** 32n;

// ---------------------------------------------------------------------------
// Errors (§10)
// ---------------------------------------------------------------------------

export type ErrorCode =
  | 'ERR_PARAMS'
  | 'ERR_ALREADY_CLAIMED'
  | 'ERR_CLAIMS_CLOSED'
  | 'ERR_STORAGE'
  | 'ERR_ALREADY_SAVED'
  | 'ERR_NOTHING_TO_SAVE'
  | 'ERR_WRONG_ROUND'
  | 'ERR_COST_TOO_HIGH'
  | 'ERR_INSUFFICIENT'
  | 'ERR_UNREGISTERED'
  | 'ERR_ZERO_AMOUNT'
  | 'ERR_SELF_TRANSFER';

export const ERROR_CODES: readonly ErrorCode[] = [
  'ERR_PARAMS',
  'ERR_ALREADY_CLAIMED',
  'ERR_CLAIMS_CLOSED',
  'ERR_STORAGE',
  'ERR_ALREADY_SAVED',
  'ERR_NOTHING_TO_SAVE',
  'ERR_WRONG_ROUND',
  'ERR_COST_TOO_HIGH',
  'ERR_INSUFFICIENT',
  'ERR_UNREGISTERED',
  'ERR_ZERO_AMOUNT',
  'ERR_SELF_TRANSFER',
];

/** Thrown by every failed action. `message` starts with the code, like the contract panic. */
export class NotItError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = 'NotItError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Config (§2, §8)
// ---------------------------------------------------------------------------

export interface Config {
  roundNs: bigint;
  maxCostPpm: number;
  minCostPpm: number;
  cutPpm: number;
  claimAmount: bigint;
  claimCap: number;
  genesisNs: bigint;
}

export const FAST: Omit<Config, 'genesisNs'> = Object.freeze({
  roundNs: 180n * 1_000_000_000n,
  maxCostPpm: 50_000,
  minCostPpm: 2_000,
  cutPpm: 150_000,
  claimAmount: 1_000n * UNIT,
  claimCap: 100_000,
});

export const LIVE: Omit<Config, 'genesisNs'> = Object.freeze({
  ...FAST,
  roundNs: 3_600n * 1_000_000_000n,
});

function isU32(x: unknown): x is number {
  return typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= U32_MAX;
}

function isUint(x: unknown, max: bigint): x is bigint {
  return typeof x === 'bigint' && x >= 0n && x <= max;
}

/** Validation of `new` (§2). Throws NotItError('ERR_PARAMS'). */
export function validateConfig(c: Config): void {
  const fail = (why: string): never => {
    throw new NotItError('ERR_PARAMS', why);
  };
  if (!isUint(c.roundNs, U64_MAX)) fail('round_ns must be a u64');
  if (!isUint(c.genesisNs, U64_MAX)) fail('genesis_ns must be a u64');
  if (!isUint(c.claimAmount, U128_MAX)) fail('claim_amount must be a u128');
  if (!isU32(c.maxCostPpm)) fail('max_cost_ppm must be a u32');
  if (!isU32(c.minCostPpm)) fail('min_cost_ppm must be a u32');
  if (!isU32(c.cutPpm)) fail('cut_ppm must be a u32');
  if (!isU32(c.claimCap)) fail('claim_cap must be a u32');
  const ppm = Number(PPM);
  if (c.roundNs < 1_000_000_000n) fail('round_ns >= 10^9');
  if (!(0 < c.minCostPpm && c.minCostPpm <= c.maxCostPpm && c.maxCostPpm < ppm)) {
    fail('0 < min_cost_ppm <= max_cost_ppm < PPM');
  }
  if (!(0 < c.cutPpm && c.cutPpm < ppm)) fail('0 < cut_ppm < PPM');
  if (!(c.claimAmount > 0n)) fail('claim_amount > 0');
  if (c.claimAmount * BigInt(c.claimCap) > MAX_CLAIMABLE) fail('claim_amount * claim_cap <= 10^32');
}

// ---------------------------------------------------------------------------
// View and history types (§6, §7)
// ---------------------------------------------------------------------------

export interface Stats {
  roundsSaved: number;
  roundsCollapsed: number;
  currentStreak: number;
  longestStreak: number;
  closestCallMs: number | null;
  totalBurned: bigint;
  totalPaid: bigint;
}

/** `get_state()` in camelCase. */
export interface State {
  nowNs: bigint;
  round: number;
  roundStartNs: bigint;
  roundEndNs: bigint;
  saved: boolean;
  /** This round's volunteer. */
  hero: string | null;
  /** The last volunteer (collects if this round collapses). */
  it: string | null;
  /** True if an unsaved close of this round would be charged. */
  armed: boolean;
  /** Unsaved charged rounds in a row so far. */
  collapseRun: number;
  /** 0 if the round is saved or round_supply == 0. */
  costNow: bigint;
  roundSupply: bigint;
  totalSupply: bigint;
  index: bigint;
  scale: number;
  claimsMade: number;
  claimOpen: boolean;
  stats: Stats;
}

/** `get_account()` in camelCase. */
export interface Account {
  registered: boolean;
  claimed: boolean;
  balance: bigint;
  saves: number;
  burned: bigint;
  collected: bigint;
  isIt: boolean;
}

export interface SavedEntry {
  kind: 'saved';
  round: number;
  hero: string;
  cost: bigint;
  msLeft: number;
}

export interface CollapsedEntry {
  kind: 'collapsed';
  firstRound: number;
  lastRound: number;
  count: number;
  it: string;
  paid: bigint;
}

export type HistoryEntry = SavedEntry | CollapsedEntry;

export interface Hero {
  accountId: string;
  saves: number;
  burned: bigint;
  collected: bigint;
}

export interface VolunteerGuard {
  /** Fail with ERR_WRONG_ROUND unless this is the current round. */
  round?: number;
  /** Fail with ERR_COST_TOO_HIGH if the cost is above this. */
  maxCost?: bigint;
}

/** NEP-297 events, in the JSON shape the contract logs (amounts as decimal strings). */
export type NotItEvent =
  | { standard: 'nep141'; version: '1.0.0'; event: 'ft_mint'; data: [{ owner_id: string; amount: string }] }
  | { standard: 'nep141'; version: '1.0.0'; event: 'ft_burn'; data: [{ owner_id: string; amount: string }] }
  | {
      standard: 'nep141';
      version: '1.0.0';
      event: 'ft_transfer';
      data: [{ old_owner_id: string; new_owner_id: string; amount: string }];
    }
  | {
      standard: 'notit';
      version: '1.0.0';
      event: 'round_saved';
      data: { round: number; hero: string; cost: string; ms_left: number };
    }
  | {
      standard: 'notit';
      version: '1.0.0';
      event: 'rounds_closed';
      data: {
        from_round: number;
        to_round: number;
        saved: number;
        collapsed: number;
        paid: string;
        it: string | null;
        index: string;
        scale: number;
      };
    };

// ---------------------------------------------------------------------------
// Pure arithmetic helpers
// ---------------------------------------------------------------------------

/** `rate_ppm` of §5.2 for `elapsedNs` into a round (0 ≤ elapsedNs < roundNs). */
export function costRatePpm(
  config: Pick<Config, 'roundNs' | 'maxCostPpm' | 'minCostPpm'>,
  elapsedNs: bigint,
): bigint {
  const max = BigInt(config.maxCostPpm);
  const min = BigInt(config.minCostPpm);
  return max - ((max - min) * elapsedNs) / config.roundNs;
}

/** `cost` of §5.2: max(1, floor(round_supply × rate_ppm / PPM)). */
export function costFromRate(roundSupply: bigint, ratePpm: bigint): bigint {
  const cost = (roundSupply * ratePpm) / PPM;
  return cost > 1n ? cost : 1n;
}

/** `eff` of §3: shares stored at `accountScale` expressed at the current `scale`. */
export function effectiveShares(shares: bigint, accountScale: number, scale: number): bigint {
  if (accountScale === scale) return shares;
  return shares / RESCALE_FACTOR ** BigInt(scale - accountScale);
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

interface AccountRecord {
  shares: bigint;
  scale: number;
}

interface HeroRecord {
  saves: number;
  burned: bigint;
  collected: bigint;
}

/** Result of running the §4 loop without writing. */
interface Settlement {
  index: bigint;
  scale: number;
  totalShares: bigint;
  round: number;
  roundSupply: bigint;
  roundHero: string | null;
  collapseRun: number;
  roundsSaved: number;
  roundsCollapsed: number;
  currentStreak: number;
  longestStreak: number;
  totalPaid: bigint;
  /** `armed` (§3) for the round the settlement ends in. */
  armed: boolean;
  /** Stored `round` before this pass. */
  fromRound: number;
  /** Rounds closed by the loop body (skipped dormant rounds are not counted). */
  closed: number;
  closedSaved: number;
  closedCollapsed: number;
  /** Sum of what It collected in this pass, net of the cut on its own balance (§4.1 step 3b). */
  paid: bigint;
  /** It's account after this pass (meaningful when closedCollapsed > 0). */
  itShares: bigint;
  itScale: number;
  /** Extended copy of the last stored history entry, if this pass extended it. */
  replacedLast: CollapsedEntry | null;
  /** New collapsed entries created by this pass (at most one). */
  appended: CollapsedEntry[];
}

const NO_ENTRIES: CollapsedEntry[] = [];

export class NotIt {
  readonly config: Config;

  /** Optional sink for the §7 events. Only successful calls emit. */
  onEvent: ((event: NotItEvent) => void) | null = null;

  private accounts = new Map<string, AccountRecord>();
  private totalShares = 0n;
  private index = RAY;
  private scale = 0;
  private round = 0;
  private roundSupply = 0n;
  private roundHero: string | null = null;
  private it: string | null = null;
  private collapseRun = 0;
  private claimed = new Set<string>();
  private claimsMade = 0;
  private roundsSaved = 0;
  private roundsCollapsed = 0;
  private currentStreak = 0;
  private longestStreak = 0;
  private closestCallMs: number | null = null;
  private totalBurned = 0n;
  private totalPaid = 0n;
  private hist: HistoryEntry[] = [];
  private heroMap = new Map<string, HeroRecord>();

  constructor(config: Config) {
    validateConfig(config);
    this.config = Object.freeze({ ...config });
  }

  // ----- settlement (§4) ---------------------------------------------------

  /** `current_round(now)`; saturates at 0 for `now` before genesis. */
  private targetRound(now: bigint): number {
    const c = this.config;
    if (now <= c.genesisNs) return 0;
    return Number((now - c.genesisNs) / c.roundNs);
  }

  /** The §4 loop as a pure function of the stored state and `now`. */
  private settlement(now: bigint): Settlement {
    const target = this.targetRound(now);
    const fromRound = this.round;
    const it = this.it;
    const itAccount = it === null ? undefined : this.accounts.get(it);
    const itOk = itAccount !== undefined; // "it is set and registered"

    let index = this.index;
    let scale = this.scale;
    let totalShares = this.totalShares;
    let round = this.round;
    let roundSupply = this.roundSupply;
    let roundHero = this.roundHero;
    let collapseRun = this.collapseRun;
    let roundsSaved = this.roundsSaved;
    let roundsCollapsed = this.roundsCollapsed;
    let currentStreak = this.currentStreak;
    let longestStreak = this.longestStreak;
    let totalPaid = this.totalPaid;
    let itShares = itAccount === undefined ? 0n : itAccount.shares;
    let itScale = itAccount === undefined ? 0 : itAccount.scale;
    let closed = 0;
    let closedSaved = 0;
    let closedCollapsed = 0;
    let paid = 0n;
    let replacedLast: CollapsedEntry | null = null;
    let appended = NO_ENTRIES;

    if (round < target) {
      const keep = PPM - BigInt(this.config.cutPpm);
      // The entry a collapse could extend: the last history entry, if it is a collapsed one.
      const last = this.hist.length > 0 ? this.hist[this.hist.length - 1]! : null;
      let tail: CollapsedEntry | null = last !== null && last.kind === 'collapsed' ? last : null;
      let tailIsStored = tail !== null;

      while (round < target) {
        // close_round() — §4.1
        if (roundHero !== null) {
          // saved
          roundsSaved += 1;
          currentStreak += 1;
          if (currentStreak > longestStreak) longestStreak = currentStreak;
          closedSaved += 1;
        } else if (itOk && collapseRun < MAX_COLLAPSE_RUN && roundSupply > 0n) {
          // collapsed (not saved and armed)
          const before = (totalShares * index) / RAY; // 1
          const indexBefore = index;
          index = (index * keep) / PPM; // 2
          const pot = before - (totalShares * index) / RAY; // 3: gross, minted to It
          if (itScale !== scale) {
            // 4: normalise it
            itShares = effectiveShares(itShares, itScale, scale);
            itScale = scale;
          }
          // 3b: what It collects net of the cut on its own balance (shares before the mint).
          const ownCut = (itShares * indexBefore) / RAY - (itShares * index) / RAY;
          const net = pot > ownCut ? pot - ownCut : 0n; // floors can make ownCut exceed pot by 1 unit
          const minted = (pot * RAY) / index;
          itShares += minted;
          totalShares += minted;
          if (index < RESCALE_BELOW) {
            // 5: lazy rescale
            index = index * RESCALE_FACTOR;
            totalShares = totalShares / RESCALE_FACTOR;
            scale += 1;
          }
          roundsCollapsed += 1; // 6
          currentStreak = 0;
          collapseRun += 1;
          totalPaid += net;
          paid += net;
          closedCollapsed += 1;
          if (tail !== null && tail.lastRound === round - 1 && tail.it === it) {
            // 7: extend
            if (tailIsStored) {
              tail = { ...tail };
              replacedLast = tail;
              tailIsStored = false;
            }
            tail.lastRound = round;
            tail.count += 1;
            tail.paid += net;
          } else {
            tail = { kind: 'collapsed', firstRound: round, lastRound: round, count: 1, it: it!, paid: net };
            tailIsStored = false;
            if (appended === NO_ENTRIES) appended = [];
            appended.push(tail);
          }
        }
        // else dormant: nothing changes, nothing is recorded.
        closed += 1;
        round += 1;
        roundHero = null;
        roundSupply = (totalShares * index) / RAY;
        if (!(itOk && collapseRun < MAX_COLLAPSE_RUN && roundSupply > 0n)) {
          round = target; // every further unattended round is dormant
          break;
        }
      }
    }

    return {
      index,
      scale,
      totalShares,
      round,
      roundSupply,
      roundHero,
      collapseRun,
      roundsSaved,
      roundsCollapsed,
      currentStreak,
      longestStreak,
      totalPaid,
      armed: itOk && collapseRun < MAX_COLLAPSE_RUN && roundSupply > 0n,
      fromRound,
      closed,
      closedSaved,
      closedCollapsed,
      paid,
      itShares,
      itScale,
      replacedLast,
      appended,
    };
  }

  /** Write a settlement to storage. */
  private commit(s: Settlement): void {
    if (s.round === s.fromRound) return;
    this.index = s.index;
    this.scale = s.scale;
    this.totalShares = s.totalShares;
    this.round = s.round;
    this.roundSupply = s.roundSupply;
    this.roundHero = s.roundHero;
    this.collapseRun = s.collapseRun;
    this.roundsSaved = s.roundsSaved;
    this.roundsCollapsed = s.roundsCollapsed;
    this.currentStreak = s.currentStreak;
    this.longestStreak = s.longestStreak;
    this.totalPaid = s.totalPaid;
    if (s.closedCollapsed > 0) {
      const it = this.it!;
      const account = this.accounts.get(it)!;
      account.shares = s.itShares;
      account.scale = s.itScale;
      this.heroRecord(it).collected += s.paid;
      if (s.replacedLast !== null) this.hist[this.hist.length - 1] = s.replacedLast;
      for (const e of s.appended) this.hist.push(e);
    }
    if (this.onEvent !== null) {
      this.onEvent({
        standard: 'notit',
        version: '1.0.0',
        event: 'rounds_closed',
        data: {
          from_round: s.fromRound,
          to_round: s.round,
          saved: s.closedSaved,
          collapsed: s.closedCollapsed,
          paid: s.paid.toString(),
          it: this.it,
          index: s.index.toString(),
          scale: s.scale,
        },
      });
    }
  }

  private heroRecord(id: string): HeroRecord {
    let h = this.heroMap.get(id);
    if (h === undefined) {
      h = { saves: 0, burned: 0n, collected: 0n };
      this.heroMap.set(id, h);
    }
    return h;
  }

  /** Effective shares of `id` under a (virtual) settlement; undefined if unregistered. */
  private effIn(s: Settlement, id: string): bigint | undefined {
    if (s.closedCollapsed > 0 && id === this.it) return effectiveShares(s.itShares, s.itScale, s.scale);
    const account = this.accounts.get(id);
    return account === undefined ? undefined : effectiveShares(account.shares, account.scale, s.scale);
  }

  /** "Normalise": shares = eff(a), account scale = current scale. */
  private normalised(id: string): AccountRecord {
    const account = this.accounts.get(id)!;
    if (account.scale !== this.scale) {
      account.shares = effectiveShares(account.shares, account.scale, this.scale);
      account.scale = this.scale;
    }
    return account;
  }

  private costIn(s: Settlement, now: bigint): bigint {
    let elapsed = now - (this.config.genesisNs + BigInt(s.round) * this.config.roundNs);
    if (elapsed < 0n) elapsed = 0n; // only if the caller's clock ran backwards
    return costFromRate(s.roundSupply, costRatePpm(this.config, elapsed));
  }

  // ----- actions (§5) ------------------------------------------------------
  //
  // A contract panic reverts everything, including the settlement that ran first.
  // So each action computes the settlement, checks every requirement against it,
  // and only then commits the settlement and its own writes.

  /** §5.1. Registration is free in the engine, so ERR_STORAGE is never raised. */
  claim(caller: string, now: bigint): void {
    const s = this.settlement(now);
    if (this.claimed.has(caller)) throw new NotItError('ERR_ALREADY_CLAIMED');
    if (this.claimsMade >= this.config.claimCap) throw new NotItError('ERR_CLAIMS_CLOSED');
    this.commit(s);

    this.register(caller);
    const account = this.normalised(caller);
    const minted = (this.config.claimAmount * RAY) / this.index; // to_shares_floor
    account.shares += minted;
    this.totalShares += minted;
    this.claimed.add(caller);
    this.claimsMade += 1;
    if (this.onEvent !== null) {
      this.onEvent({
        standard: 'nep141',
        version: '1.0.0',
        event: 'ft_mint',
        data: [{ owner_id: caller, amount: this.config.claimAmount.toString() }],
      });
    }
  }

  /** `storage_deposit` without the deposit: zero shares at the current (stored) scale. Idempotent; does not settle. */
  register(account: string): void {
    if (!this.accounts.has(account)) this.accounts.set(account, { shares: 0n, scale: this.scale });
  }

  /**
   * `storage_unregister` (§5.5). Runs `settle(now)` first, like the other actions, so
   * an It with pending unsaved rounds is paid for them before it leaves (and then
   * needs `force`). Returns true if the account was removed. Returns false, writing
   * nothing (not even the settlement), if it was not registered or if it still has
   * effective shares and `force` is false (the contract panics there). With `force`
   * the shares are burned. If the account is It, It becomes none.
   */
  unregister(account: string, force: boolean, now: bigint): boolean {
    const s = this.settlement(now);
    const eff = this.effIn(s, account);
    if (eff === undefined) return false;
    if (eff > 0n && !force) return false;
    this.commit(s);

    if (eff > 0n) {
      this.totalShares -= eff;
      if (this.onEvent !== null) {
        this.onEvent({
          standard: 'nep141',
          version: '1.0.0',
          event: 'ft_burn',
          data: [{ owner_id: account, amount: ((eff * this.index) / RAY).toString() }],
        });
      }
    }
    this.accounts.delete(account);
    if (this.it === account) this.it = null;
    return true;
  }

  /** §5.2. */
  volunteer(caller: string, now: bigint, guard?: VolunteerGuard): { cost: bigint; msLeft: number } {
    const s = this.settlement(now);
    if (s.roundHero !== null) throw new NotItError('ERR_ALREADY_SAVED');
    if (s.roundSupply === 0n) throw new NotItError('ERR_NOTHING_TO_SAVE');
    if (guard !== undefined && guard.round !== undefined && guard.round !== s.round) {
      throw new NotItError('ERR_WRONG_ROUND');
    }
    const c = this.config;
    let elapsed = now - (c.genesisNs + BigInt(s.round) * c.roundNs);
    if (elapsed < 0n) elapsed = 0n; // only if the caller's clock ran backwards
    const cost = costFromRate(s.roundSupply, costRatePpm(c, elapsed));
    if (guard !== undefined && guard.maxCost !== undefined && cost > guard.maxCost) {
      throw new NotItError('ERR_COST_TOO_HIGH');
    }
    const burn = (cost * RAY + s.index - 1n) / s.index; // to_shares_ceil
    const have = this.effIn(s, caller);
    if (have === undefined || burn > have) throw new NotItError('ERR_INSUFFICIENT');
    this.commit(s);

    const account = this.normalised(caller);
    account.shares -= burn;
    this.totalShares -= burn;
    this.roundHero = caller;
    this.it = caller;
    this.collapseRun = 0;
    const msLeft = Number((c.roundNs - elapsed) / NS_PER_MS);

    this.totalBurned += cost;
    const hero = this.heroRecord(caller);
    hero.saves += 1;
    hero.burned += cost;
    if (this.closestCallMs === null || msLeft < this.closestCallMs) this.closestCallMs = msLeft;
    this.hist.push({ kind: 'saved', round: this.round, hero: caller, cost, msLeft });

    if (this.onEvent !== null) {
      this.onEvent({
        standard: 'nep141',
        version: '1.0.0',
        event: 'ft_burn',
        data: [{ owner_id: caller, amount: cost.toString() }],
      });
      this.onEvent({
        standard: 'notit',
        version: '1.0.0',
        event: 'round_saved',
        data: { round: this.round, hero: caller, cost: cost.toString(), ms_left: msLeft },
      });
    }
    return { cost, msLeft };
  }

  /** §5.3 `ft_transfer`. */
  transfer(from: string, to: string, amount: bigint, now: bigint): void {
    const s = this.settlement(now);
    if (amount <= 0n) throw new NotItError('ERR_ZERO_AMOUNT');
    if (to === from) throw new NotItError('ERR_SELF_TRANSFER');
    const have = this.effIn(s, from);
    if (have === undefined || !this.accounts.has(to)) throw new NotItError('ERR_UNREGISTERED');
    const moved = (amount * RAY + s.index - 1n) / s.index; // to_shares_ceil
    if (moved > have) throw new NotItError('ERR_INSUFFICIENT');
    this.commit(s);

    const sender = this.normalised(from);
    const receiver = this.normalised(to);
    sender.shares -= moved;
    receiver.shares += moved;
    if (this.onEvent !== null) {
      this.onEvent({
        standard: 'nep141',
        version: '1.0.0',
        event: 'ft_transfer',
        data: [{ old_owner_id: from, new_owner_id: to, amount: amount.toString() }],
      });
    }
  }

  /** §5.4. Returns the number of rounds closed by the loop body. Never throws. */
  poke(now: bigint): number {
    const s = this.settlement(now);
    this.commit(s);
    return s.closed;
  }

  // ----- views (§6) — virtual settlement as of `now` -------------------------

  state(now: bigint): State {
    const s = this.settlement(now);
    const c = this.config;
    const roundStartNs = c.genesisNs + BigInt(s.round) * c.roundNs;
    return {
      nowNs: now,
      round: s.round,
      roundStartNs,
      roundEndNs: roundStartNs + c.roundNs,
      saved: s.roundHero !== null,
      hero: s.roundHero,
      it: this.it,
      armed: s.armed,
      collapseRun: s.collapseRun,
      costNow: s.roundHero !== null || s.roundSupply === 0n ? 0n : this.costIn(s, now),
      roundSupply: s.roundSupply,
      totalSupply: (s.totalShares * s.index) / RAY,
      index: s.index,
      scale: s.scale,
      claimsMade: this.claimsMade,
      claimOpen: this.claimsMade < c.claimCap,
      stats: {
        roundsSaved: s.roundsSaved,
        roundsCollapsed: s.roundsCollapsed,
        currentStreak: s.currentStreak,
        longestStreak: s.longestStreak,
        closestCallMs: this.closestCallMs,
        totalBurned: this.totalBurned,
        totalPaid: s.totalPaid,
      },
    };
  }

  account(id: string, now: bigint): Account {
    const s = this.settlement(now);
    const eff = this.effIn(s, id);
    const hero = this.heroMap.get(id);
    const isIt = id === this.it;
    return {
      registered: eff !== undefined,
      claimed: this.claimed.has(id),
      balance: eff === undefined ? 0n : (eff * s.index) / RAY,
      saves: hero === undefined ? 0 : hero.saves,
      burned: hero === undefined ? 0n : hero.burned,
      collected: (hero === undefined ? 0n : hero.collected) + (isIt ? s.paid : 0n),
      isIt,
    };
  }

  /** `ft_balance_of`: floor(eff(a) × index / RAY), 0 if unregistered. */
  balanceOf(id: string, now: bigint): bigint {
    const s = this.settlement(now);
    const eff = this.effIn(s, id);
    return eff === undefined ? 0n : (eff * s.index) / RAY;
  }

  /** `ft_total_supply`: floor(total_shares × index / RAY). */
  totalSupply(now: bigint): bigint {
    const s = this.settlement(now);
    return (s.totalShares * s.index) / RAY;
  }

  /** `cost_now` of `get_state()`: what `volunteer()` would burn at `now`; 0 if saved or round_supply == 0. */
  costAt(now: bigint): bigint {
    const s = this.settlement(now);
    if (s.roundHero !== null || s.roundSupply === 0n) return 0n;
    return this.costIn(s, now);
  }

  /**
   * `get_history`, oldest first, as of `now`: rounds that would close as collapsed
   * right now are merged into the last stored entry when adjacent and paid to the
   * same It, otherwise they appear as one extra trailing entry.
   */
  history(now: bigint): HistoryEntry[] {
    const out = this.hist.map((e) => ({ ...e }));
    const s = this.settlement(now);
    if (s.replacedLast !== null) out[out.length - 1] = { ...s.replacedLast };
    for (const e of s.appended) out.push({ ...e });
    return out;
  }

  /**
   * `get_heroes`, in insertion order. Without `now`: stored values. With `now`: It's
   * `collected` includes the collapses that would be settled right now.
   */
  heroes(now?: bigint): Hero[] {
    const pending = now === undefined ? 0n : this.settlement(now).paid;
    const out: Hero[] = [];
    for (const [accountId, h] of this.heroMap) {
      out.push({
        accountId,
        saves: h.saves,
        burned: h.burned,
        collected: accountId === this.it ? h.collected + pending : h.collected,
      });
    }
    return out;
  }

  /**
   * Canonical JSON of all STORED state (no virtual settlement, accounts not
   * normalised), for differential tests. Key order per SPEC §8, no whitespace,
   * snake_case keys, big numbers as decimal strings, accounts and heroes sorted by
   * id (code-unit order), history in insertion order.
   */
  snapshot(): string {
    const accountIds = [...this.accounts.keys()].sort();
    const heroIds = [...this.heroMap.keys()].sort();
    return JSON.stringify({
      index: this.index.toString(),
      scale: this.scale,
      total_shares: this.totalShares.toString(),
      round: this.round,
      round_supply: this.roundSupply.toString(),
      round_hero: this.roundHero,
      it: this.it,
      collapse_run: this.collapseRun,
      claims_made: this.claimsMade,
      stats: {
        rounds_saved: this.roundsSaved,
        rounds_collapsed: this.roundsCollapsed,
        current_streak: this.currentStreak,
        longest_streak: this.longestStreak,
        closest_call_ms: this.closestCallMs,
        total_burned: this.totalBurned.toString(),
        total_paid: this.totalPaid.toString(),
      },
      accounts: accountIds.map((id) => {
        const a = this.accounts.get(id)!;
        return { id, shares: a.shares.toString(), scale: a.scale, claimed: this.claimed.has(id) };
      }),
      heroes: heroIds.map((id) => {
        const h = this.heroMap.get(id)!;
        return { id, saves: h.saves, burned: h.burned.toString(), collected: h.collected.toString() };
      }),
      history: this.hist.map((e) =>
        e.kind === 'saved'
          ? { kind: e.kind, round: e.round, hero: e.hero, cost: e.cost.toString(), ms_left: e.msLeft }
          : {
              kind: e.kind,
              first_round: e.firstRound,
              last_round: e.lastRound,
              count: e.count,
              it: e.it,
              paid: e.paid.toString(),
            },
      ),
    });
  }
}
