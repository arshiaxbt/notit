/**
 * Testnet implementation of NotItClient (SPEC §9).
 *
 * Views go through an RPC provider; `claim`, `volunteer` and `poke` go
 * through whichever signer is active (a guest key or a wallet). This file has
 * no dependency on near-api-js or the wallet connector: the provider and the
 * signer are handed in (see chain.ts and wallet.ts, which load those
 * libraries lazily), so Demo mode never downloads them and the unit tests can
 * use fakes.
 *
 * Views return u128/u256 and ns timestamps as decimal strings with
 * snake_case keys; the `to*View` helpers convert them at this boundary so
 * the rest of the app only sees bigint and camelCase.
 */
import { describeError, errorCode } from './errors';
import type {
  AccountView,
  ConfigView,
  GameClient,
  Hero,
  HistoryEntry,
  StateView,
  TxResult,
  VolunteerGuard,
} from './types';

/* ---- JSON shapes returned by the contract views (SPEC §6, §7) ---- */

export interface RawConfig {
  round_ns: string;
  max_cost_ppm: number;
  min_cost_ppm: number;
  cut_ppm: number;
  claim_amount: string;
  claim_cap: number;
  genesis_ns: string;
  decimals: number;
  max_collapse_run: number;
}

export interface RawState {
  now_ns: string;
  round: number;
  round_start_ns: string;
  round_end_ns: string;
  saved: boolean;
  hero: string | null;
  it: string | null;
  armed: boolean;
  collapse_run: number;
  cost_now: string;
  round_supply: string;
  total_supply: string;
  index: string;
  scale: number;
  claims_made: number;
  claim_open: boolean;
  stats: {
    rounds_saved: number;
    rounds_collapsed: number;
    current_streak: number;
    longest_streak: number;
    closest_call_ms: number | null;
    total_burned: string;
    total_paid: string;
  };
}

export interface RawAccount {
  registered: boolean;
  claimed: boolean;
  balance: string;
  saves: number;
  burned: string;
  collected: string;
  is_it: boolean;
}

export type RawHistoryEntry =
  | { kind: 'saved'; round: number; hero: string; cost: string; ms_left: number }
  | { kind: 'collapsed'; first_round: number; last_round: number; count: number; it: string; paid: string };

export interface RawHero {
  account_id: string;
  saves: number;
  burned: string;
  collected: string;
}

/* ---- Converters: ready to use, covered by the type checker ---- */

export function toConfigView(r: RawConfig): ConfigView {
  return {
    roundNs: BigInt(r.round_ns),
    maxCostPpm: r.max_cost_ppm,
    minCostPpm: r.min_cost_ppm,
    cutPpm: r.cut_ppm,
    claimAmount: BigInt(r.claim_amount),
    claimCap: r.claim_cap,
    genesisNs: BigInt(r.genesis_ns),
    decimals: r.decimals,
    maxCollapseRun: r.max_collapse_run,
  };
}

export function toStateView(r: RawState): StateView {
  return {
    nowNs: BigInt(r.now_ns),
    round: r.round,
    roundStartNs: BigInt(r.round_start_ns),
    roundEndNs: BigInt(r.round_end_ns),
    saved: r.saved,
    hero: r.hero,
    it: r.it,
    armed: r.armed,
    collapseRun: r.collapse_run,
    costNow: BigInt(r.cost_now),
    roundSupply: BigInt(r.round_supply),
    totalSupply: BigInt(r.total_supply),
    index: BigInt(r.index),
    scale: r.scale,
    claimsMade: r.claims_made,
    claimOpen: r.claim_open,
    stats: {
      roundsSaved: r.stats.rounds_saved,
      roundsCollapsed: r.stats.rounds_collapsed,
      currentStreak: r.stats.current_streak,
      longestStreak: r.stats.longest_streak,
      closestCallMs: r.stats.closest_call_ms,
      totalBurned: BigInt(r.stats.total_burned),
      totalPaid: BigInt(r.stats.total_paid),
    },
  };
}

export function toAccountView(r: RawAccount): AccountView {
  return {
    registered: r.registered,
    claimed: r.claimed,
    balance: BigInt(r.balance),
    saves: r.saves,
    burned: BigInt(r.burned),
    collected: BigInt(r.collected),
    isIt: r.is_it,
  };
}

export function toHistoryEntry(r: RawHistoryEntry): HistoryEntry {
  return r.kind === 'saved'
    ? { kind: 'saved', round: r.round, hero: r.hero, cost: BigInt(r.cost), msLeft: r.ms_left }
    : {
        kind: 'collapsed',
        firstRound: r.first_round,
        lastRound: r.last_round,
        count: r.count,
        it: r.it,
        paid: BigInt(r.paid),
      };
}

export function toHero(r: RawHero): Hero {
  return { accountId: r.account_id, saves: r.saves, burned: BigInt(r.burned), collected: BigInt(r.collected) };
}

/* ---- Provider and signer seams ---- */

/** The two RPC calls the client needs. `FailoverRpcProvider` from near-api-js fits. */
export interface ChainProvider {
  callFunction(params: { contractId: string; method: string; args: Record<string, unknown> }): Promise<unknown>;
  viewAccessKeyList(params: { accountId: string }): Promise<{ keys: unknown[] }>;
}

/** What came back from a transaction, reduced to what the UI uses. */
export interface TxOutcome {
  txHash?: string;
  logs: string[];
  /** The contract's JSON return value, if it returned one. */
  returnValue?: unknown;
}

export interface FunctionCall {
  contractId: string;
  method: string;
  args: Record<string, unknown>;
  /** Attached deposit in yoctoNEAR. */
  deposit: bigint;
  /** Gas in Tgas. */
  gasTera: number;
}

/**
 * Something that can sign and send one function call. It must reject when the
 * contract refuses the call, with an error whose text contains the ERR_* code.
 */
export interface ChainSigner {
  readonly accountId: string;
  readonly kind: 'guest' | 'wallet';
  call(call: FunctionCall): Promise<TxOutcome>;
}

/** Failure of a sent transaction, carrying its hash for the explorer link. */
export class TxFailure extends Error {
  txHash?: string;
  constructor(message: string, txHash?: string) {
    super(message);
    this.name = 'TxFailure';
    this.txHash = txHash;
  }
}

interface RawOutcome {
  transaction?: { hash?: string };
  transaction_outcome?: { id?: string };
  receipts_outcome?: Array<{ outcome?: { logs?: string[]; status?: unknown } }>;
  status?: unknown;
}

function decodeBase64(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/**
 * Reduces a NEAR `FinalExecutionOutcome` (what near-api-js and wallets return)
 * to a TxOutcome. Throws TxFailure if the transaction or any receipt failed.
 */
export function outcomeToTx(raw: unknown): TxOutcome {
  const o = (raw ?? {}) as RawOutcome;
  const txHash = o.transaction?.hash ?? o.transaction_outcome?.id;
  const logs: string[] = [];
  for (const r of o.receipts_outcome ?? []) {
    for (const line of r.outcome?.logs ?? []) logs.push(line);
    const st = r.outcome?.status;
    if (st && typeof st === 'object' && 'Failure' in st) {
      throw new TxFailure(JSON.stringify((st as { Failure: unknown }).Failure), txHash);
    }
  }
  const status = o.status;
  let returnValue: unknown;
  if (status && typeof status === 'object') {
    if ('Failure' in status) throw new TxFailure(JSON.stringify((status as { Failure: unknown }).Failure), txHash);
    const value = (status as { SuccessValue?: unknown }).SuccessValue;
    if (typeof value === 'string' && value !== '') {
      try {
        returnValue = JSON.parse(decodeBase64(value));
      } catch {
        returnValue = undefined;
      }
    }
  }
  return { txHash, logs, returnValue };
}

export interface RoundSaved {
  round: number;
  hero: string;
  cost: bigint;
  msLeft: number;
}

/** Finds the `round_saved` event (SPEC §7) in a transaction's log lines. */
export function parseRoundSaved(logs: string[]): RoundSaved | null {
  for (const line of logs) {
    if (!line.startsWith('EVENT_JSON:')) continue;
    try {
      const ev = JSON.parse(line.slice('EVENT_JSON:'.length)) as { standard?: string; event?: string; data?: unknown };
      if (ev.standard !== 'notit' || ev.event !== 'round_saved') continue;
      const d = (Array.isArray(ev.data) ? ev.data[0] : ev.data) as
        | { round?: number; hero?: string; cost?: string | number; ms_left?: number }
        | undefined;
      if (!d || d.cost === undefined) continue;
      return { round: Number(d.round), hero: String(d.hero ?? ''), cost: BigInt(d.cost), msLeft: Number(d.ms_left ?? 0) };
    } catch {
      /* not JSON: some other log line */
    }
  }
  return null;
}

/**
 * The transaction hash attached to a thrown error, if the library kept one.
 * near-api-js throws e.g. `HostGuestPanicError` with the whole outcome in
 * `transactionResult`.
 */
export function errorTxHash(e: unknown): string | undefined {
  if (!e || typeof e !== 'object') return undefined;
  const o = e as {
    txHash?: unknown;
    transactionResult?: { transaction?: { hash?: unknown }; transaction_outcome?: { id?: unknown } };
    transaction_outcome?: { id?: unknown };
    transactionHash?: unknown;
    context?: { transactionHash?: unknown };
  };
  const candidates = [
    o.txHash,
    o.transactionResult?.transaction?.hash,
    o.transactionResult?.transaction_outcome?.id,
    o.transaction_outcome?.id,
    o.transactionHash,
    o.context?.transactionHash,
  ];
  for (const v of candidates) if (typeof v === 'string' && v !== '') return v;
  return undefined;
}

/* ---- The client ---- */

export interface NearClientOptions {
  contractId: string;
  /** A provider, or a function that loads one on first use. */
  provider: ChainProvider | (() => Promise<ChainProvider>);
  /** Poll interval for views, ms. */
  pollMs?: number;
}

export interface LockStatus {
  /** True when the contract account has no access keys at all. */
  locked: boolean;
  keys: number;
}

const GAS_TERA = 30;

export class NearClient implements GameClient {
  readonly pollMs: number;
  readonly contractId: string;
  private readonly providerSource: ChainProvider | (() => Promise<ChainProvider>);
  private providerPromise: Promise<ChainProvider> | null = null;
  private signer: ChainSigner | null = null;

  constructor(options: NearClientOptions) {
    this.contractId = options.contractId;
    this.providerSource = options.provider;
    this.pollMs = options.pollMs ?? 3000;
  }

  private provider(): Promise<ChainProvider> {
    if (!this.providerPromise) {
      const src = this.providerSource;
      this.providerPromise = typeof src === 'function' ? src() : Promise.resolve(src);
      // A failed load must not stick: the next call tries again.
      this.providerPromise.catch(() => {
        this.providerPromise = null;
      });
    }
    return this.providerPromise;
  }

  private async view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    const provider = await this.provider();
    return (await provider.callFunction({ contractId: this.contractId, method, args })) as T;
  }

  /** The active signer: a guest key or a wallet. Null means read-only. */
  setSigner(signer: ChainSigner | null): void {
    this.signer = signer;
  }

  accountId(): string | null {
    return this.signer?.accountId ?? null;
  }

  async getConfig(): Promise<ConfigView> {
    return toConfigView(await this.view<RawConfig>('get_config'));
  }

  async getState(): Promise<StateView> {
    return toStateView(await this.view<RawState>('get_state'));
  }

  async getAccount(id: string): Promise<AccountView> {
    return toAccountView(await this.view<RawAccount>('get_account', { account_id: id }));
  }

  async getHistory(from: number, limit: number): Promise<HistoryEntry[]> {
    const rows = await this.view<RawHistoryEntry[]>('get_history', {
      from_index: Math.max(0, from),
      limit: Math.min(100, Math.max(0, limit)),
    });
    return rows.map(toHistoryEntry);
  }

  async getHistoryLen(): Promise<number> {
    return Number(await this.view<number>('get_history_len'));
  }

  async getHeroes(from: number, limit: number): Promise<Hero[]> {
    const rows = await this.view<RawHero[]>('get_heroes', {
      from_index: Math.max(0, from),
      limit: Math.min(100, Math.max(0, limit)),
    });
    return rows.map(toHero);
  }

  /** Whether anybody still holds a key to the contract account. */
  async getLockStatus(): Promise<LockStatus> {
    const provider = await this.provider();
    const list = await provider.viewAccessKeyList({ accountId: this.contractId });
    const keys = Array.isArray(list.keys) ? list.keys.length : 0;
    return { locked: keys === 0, keys };
  }

  private fail(e: unknown): TxResult {
    const code = errorCode(e);
    return { ok: false, code, message: describeError(code), txHash: errorTxHash(e) };
  }

  private noAccount(): TxResult {
    return { ok: false, code: 'ERR_NO_ACCOUNT', message: describeError('ERR_NO_ACCOUNT') };
  }

  /**
   * Claims from the faucet. The call is payable: an account the contract has
   * not seen yet must attach the storage fee, which is read from the contract
   * (`storage_balance_bounds().min`), never hard-coded.
   */
  async claim(): Promise<TxResult> {
    const signer = this.signer;
    if (!signer) return this.noAccount();
    try {
      const account = await this.view<RawAccount>('get_account', { account_id: signer.accountId });
      let deposit = 0n;
      if (!account.registered) {
        const bounds = await this.view<{ min: string }>('storage_balance_bounds');
        deposit = BigInt(bounds.min);
      }
      const out = await signer.call({ contractId: this.contractId, method: 'claim', args: {}, deposit, gasTera: GAS_TERA });
      return { ok: true, txHash: out.txHash };
    } catch (e) {
      return this.fail(e);
    }
  }

  /** Volunteers with both guards of SPEC §5.2, so a late transaction cannot overpay. */
  async volunteer(guard: VolunteerGuard): Promise<TxResult> {
    const signer = this.signer;
    if (!signer) return this.noAccount();
    try {
      const out = await signer.call({
        contractId: this.contractId,
        method: 'volunteer',
        args: { round: guard.round, max_cost: guard.maxCost.toString() },
        deposit: 0n,
        gasTera: GAS_TERA,
      });
      const saved = parseRoundSaved(out.logs);
      let cost = saved?.cost;
      if (cost === undefined && (typeof out.returnValue === 'string' || typeof out.returnValue === 'number')) {
        try {
          cost = BigInt(out.returnValue);
        } catch {
          cost = undefined;
        }
      }
      return { ok: true, txHash: out.txHash, cost, msLeft: saved?.msLeft };
    } catch (e) {
      return this.fail(e);
    }
  }

  async poke(): Promise<TxResult> {
    const signer = this.signer;
    if (!signer) return this.noAccount();
    try {
      const out = await signer.call({ contractId: this.contractId, method: 'poke', args: {}, deposit: 0n, gasTera: GAS_TERA });
      const settled = typeof out.returnValue === 'number' ? out.returnValue : undefined;
      return { ok: true, txHash: out.txHash, settled };
    } catch (e) {
      return this.fail(e);
    }
  }
}
