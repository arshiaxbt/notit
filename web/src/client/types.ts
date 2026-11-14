/**
 * Client interface used by the web app (docs/SPEC.md §9) and the view types
 * from §6. In the UI layer every u128/u256 and every nanosecond timestamp is
 * a bigint; clients convert from the JSON decimal strings at the boundary.
 */

export interface ConfigView {
  roundNs: bigint;
  maxCostPpm: number;
  minCostPpm: number;
  cutPpm: number;
  claimAmount: bigint;
  claimCap: number;
  genesisNs: bigint;
  decimals: number;
  /** Unsaved rounds charged in a row before the game goes dormant (8). */
  maxCollapseRun: number;
}

export interface StatsView {
  roundsSaved: number;
  roundsCollapsed: number;
  currentStreak: number;
  longestStreak: number;
  closestCallMs: number | null;
  totalBurned: bigint;
  /** Everything ever paid to It by unsaved rounds. */
  totalPaid: bigint;
}

export interface StateView {
  nowNs: bigint;
  round: number;
  roundStartNs: bigint;
  roundEndNs: bigint;
  saved: boolean;
  /** This round's volunteer. */
  hero: string | null;
  /** The last volunteer: collects the cut if this round ends unsaved. */
  it: string | null;
  /** True if an unsaved close of this round would be charged. */
  armed: boolean;
  /** Unsaved charged rounds in a row so far. */
  collapseRun: number;
  /** 0 if the round is saved or there is nothing to save. */
  costNow: bigint;
  roundSupply: bigint;
  totalSupply: bigint;
  index: bigint;
  scale: number;
  claimsMade: number;
  claimOpen: boolean;
  stats: StatsView;
}

export interface AccountView {
  registered: boolean;
  claimed: boolean;
  balance: bigint;
  saves: number;
  burned: bigint;
  /** Total received as It from unsaved rounds. */
  collected: bigint;
  isIt: boolean;
}

export type HistoryEntry =
  | { kind: 'saved'; round: number; hero: string; cost: bigint; msLeft: number }
  | { kind: 'collapsed'; firstRound: number; lastRound: number; count: number; it: string; paid: bigint };

export interface Hero {
  accountId: string;
  saves: number;
  burned: bigint;
  collected: bigint;
}

/** Guards sent with `volunteer` so a late transaction cannot overpay (SPEC §5.2). */
export interface VolunteerGuard {
  /** The round the UI is showing. */
  round: number;
  /** The most the caller agrees to burn. */
  maxCost: bigint;
}

/** SPEC §9 leaves TxResult open; this is the shape the UI relies on. */
export type TxResult =
  | { ok: true; txHash?: string; cost?: bigint; msLeft?: number; settled?: number }
  | { ok: false; code: string; message: string; txHash?: string };

export interface NotItClient {
  getConfig(): Promise<ConfigView>;
  getState(): Promise<StateView>;
  getAccount(id: string): Promise<AccountView>;
  getHistory(from: number, limit: number): Promise<HistoryEntry[]>;
  getHistoryLen(): Promise<number>;
  getHeroes(from: number, limit: number): Promise<Hero[]>;
  claim(): Promise<TxResult>;
  volunteer(guard: VolunteerGuard): Promise<TxResult>;
  poke(): Promise<TxResult>;
  accountId(): string | null;
}

/**
 * Optional extras a client may offer on top of SPEC §9. The UI never requires
 * them: a plain NotItClient works.
 */
export interface GameClient extends NotItClient {
  /** Game seconds per real second. 1 on chain; >1 on the demo clock. */
  timeScale?(): number;
  /** Suggested poll interval in ms. */
  pollMs?: number;
}

/** One simulated holder shown in Demo mode. */
export interface CrowdMember {
  accountId: string;
  strategy: string;
  blurb: string;
  balance: bigint;
  saves: number;
  burned: bigint;
  collected: bigint;
  isIt: boolean;
}

/** Controls that only exist in Demo mode (MockClient). */
export interface DemoControls {
  roundSeconds(): number;
  setRoundSeconds(seconds: number): void;
  crowd(): CrowdMember[];
}

export const ROUND_SPEEDS = [10, 30, 180] as const;
