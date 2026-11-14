/**
 * Polls a NotItClient and keeps one consistent snapshot of the game.
 *
 * Between polls nothing is fetched: the countdown and the falling cost are
 * derived locally from the config and the last snapshot (`nowNs()` estimates
 * the game clock, `lib/cost.ts` does the arithmetic), so the numbers move
 * smoothly at any poll interval. When the local clock reaches the end of the
 * round the hook polls straight away instead of waiting for the next tick.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isGentle } from '../client/errors';
import type {
  AccountView,
  ConfigView,
  GameClient,
  Hero,
  HistoryEntry,
  StateView,
  TxResult,
  VolunteerGuard,
} from '../client/types';

export interface GameSnapshot {
  config: ConfigView;
  state: StateView;
  accountId: string | null;
  account: AccountView | null;
  /** Account view of whoever is It, if anyone. */
  itAccount: AccountView | null;
  /** Most recent entries, oldest first (up to HISTORY_WINDOW). */
  history: HistoryEntry[];
  historyLen: number;
  heroes: Hero[];
  /** Identifies what `history`, `heroes` and `itAccount` were fetched for. */
  slowKey: string;
  /** performance.now() when this snapshot arrived. */
  receivedAt: number;
}

/** saved: someone volunteered. collapsed: unsaved and charged. dormant: unsaved, nothing charged. */
export type CloseKind = 'saved' | 'collapsed' | 'dormant';

/** What happened when the last round closed. */
export interface RoundClose {
  /** Unique per event, for keying animations. */
  id: number;
  round: number;
  kind: CloseKind;
  hero: string | null;
  cost: bigint;
  msLeft: number;
  /** Who collected, for a collapsed round. */
  it: string | null;
  /** Rounds that closed since the previous poll (usually 1). */
  roundsClosed: number;
  balanceBefore: bigint | null;
  balanceAfter: bigint | null;
  /** performance.now() when the close was noticed. */
  at: number;
}

/**
 * Public RPC nodes are not all at the same block: the poll that first shows a
 * new round can still carry the old balance. If the balance moves in the first
 * seconds after a charged close, that movement belongs to the close.
 */
export function amendClose(close: RoundClose | null, next: GameSnapshot, nowMs: number, windowMs = 8000): RoundClose | null {
  if (!close || close.kind !== 'collapsed' || nowMs - close.at > windowMs) return null;
  if (next.state.round !== close.round + 1 || !next.account) return null;
  if (close.balanceBefore === null || close.balanceAfter !== close.balanceBefore) return null;
  if (next.account.balance === close.balanceBefore) return null;
  return { ...close, balanceAfter: next.account.balance };
}

export type Action = 'claim' | 'volunteer';

export interface Game {
  snapshot: GameSnapshot | null;
  /** Set when polling fails; the last good snapshot stays on screen. */
  error: string | null;
  /** True while the snapshot on screen belongs to the previous client and the new one has not answered yet. */
  stale: boolean;
  lastClose: RoundClose | null;
  /** Action currently in flight. */
  pending: Action | null;
  /** Result message of the last action, if it failed. `gentle` means it cost the player nothing. */
  notice: { id: number; text: string; gentle: boolean } | null;
  dismissNotice(): void;
  /** The last transaction sent, for a link to the explorer (chain clients only). */
  lastTx: { id: number; hash: string; action: Action; ok: boolean } | null;
  /** Best estimate of the game clock right now, in ns. */
  nowNs(): bigint;
  refresh(): Promise<void>;
  claim(): Promise<TxResult | null>;
  /** Volunteers with the guards from SPEC §5.2: the round and cost on screen. */
  volunteer(guard: VolunteerGuard): Promise<TxResult | null>;
}

export interface UseGameOptions {
  /** Poll interval in ms. Defaults to the client's `pollMs`, else 1000. */
  pollMs?: number;
  /**
   * While this stays the same across a change of client (Fast to Live, say), the last
   * picture stays on screen, marked stale, until the new client's first answer: never an
   * empty frame. A different key (Demo to Testnet) starts from nothing.
   */
  holdKey?: string;
}

const HISTORY_WINDOW = 100;

export interface RoundOutcome {
  kind: CloseKind;
  hero: string | null;
  cost: bigint;
  msLeft: number;
  it: string | null;
}

/** How one round ended, judged from the history. */
export function outcomeOfRound(history: HistoryEntry[], round: number): RoundOutcome {
  for (let i = history.length - 1; i >= 0; i--) {
    const e = history[i]!;
    if (e.kind === 'saved') {
      if (e.round === round) return { kind: 'saved', hero: e.hero, cost: e.cost, msLeft: e.msLeft, it: e.hero };
      if (e.round < round) break;
    } else {
      if (e.firstRound <= round && round <= e.lastRound) {
        return { kind: 'collapsed', hero: null, cost: 0n, msLeft: 0, it: e.it };
      }
      if (e.lastRound < round) break;
    }
  }
  return { kind: 'dormant', hero: null, cost: 0n, msLeft: 0, it: null };
}

/**
 * What the slower-moving views depend on. History, heroes and It's account
 * only change when a round closes, somebody volunteers or the supply moves,
 * so they are fetched again only when this key changes. That keeps a quiet
 * poll down to three small view calls, which matters on public RPC endpoints
 * that rate-limit.
 */
function slowKey(state: StateView, historyLen: number, accountId: string | null, account: AccountView | null): string {
  return [
    historyLen,
    state.round,
    state.saved,
    state.hero ?? '',
    state.it ?? '',
    state.collapseRun,
    state.stats.roundsSaved,
    state.stats.roundsCollapsed,
    state.totalSupply,
    accountId ?? '',
    account?.balance ?? '',
  ].join('|');
}

/** One poll. Pass the previous snapshot to reuse the slower views when nothing they depend on has changed. */
/** True if `next` describes an earlier moment of the same game than `shown`. */
export function isBehind(shown: GameSnapshot, next: GameSnapshot): boolean {
  if (next.state.round < shown.state.round) return true;
  return next.state.round === shown.state.round && shown.state.saved && !next.state.saved;
}

export async function fetchSnapshot(client: GameClient, config: ConfigView, prev: GameSnapshot | null = null): Promise<GameSnapshot> {
  const accountId = client.accountId();
  // One after another, not all at once: public RPC endpoints refuse bursts.
  const state = await client.getState();
  const historyLen = await client.getHistoryLen();
  const account = accountId ? await client.getAccount(accountId) : null;
  const key = slowKey(state, historyLen, accountId, account);
  if (prev && prev.slowKey === key) {
    const itAccount = state.it !== null && state.it === accountId ? account : prev.itAccount;
    return { ...prev, state, accountId, account, itAccount, historyLen, receivedAt: performance.now() };
  }
  const from = Math.max(0, historyLen - HISTORY_WINDOW);
  const [history, heroes, itAccount] = await Promise.all([
    client.getHistory(from, HISTORY_WINDOW),
    client.getHeroes(0, 100),
    state.it === null ? Promise.resolve(null) : state.it === accountId ? Promise.resolve(account) : client.getAccount(state.it),
  ]);
  return { config, state, accountId, account, itAccount, history, historyLen, heroes, slowKey: key, receivedAt: performance.now() };
}

export function useGame(client: GameClient, options: UseGameOptions = {}): Game {
  const pollMs = options.pollMs ?? client.pollMs ?? 1000;
  const [snapshot, setSnapshot] = useState<GameSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const heldKey = useRef<string | undefined>(options.holdKey);
  const [lastClose, setLastClose] = useState<RoundClose | null>(null);
  const [pending, setPending] = useState<Action | null>(null);
  const [notice, setNotice] = useState<{ id: number; text: string; gentle: boolean } | null>(null);
  const [lastTx, setLastTx] = useState<Game['lastTx']>(null);
  // Chain clock: the freshest "chain time minus local time" seen recently, in ns.
  const offsets = useRef<bigint[]>([]);

  const snapRef = useRef<GameSnapshot | null>(null);
  const configRef = useRef<ConfigView | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const closeRef = useRef<RoundClose | null>(null);
  const seq = useRef(0);
  const applied = useRef(0);
  const eventId = useRef(0);
  const clientRef = useRef(client);

  // A different client is a different game: drop everything.
  if (clientRef.current !== client) {
    clientRef.current = client;
    snapRef.current = null;
    configRef.current = null;
    inFlight.current = null;
    closeRef.current = null;
    offsets.current = [];
  }

  const refresh = useCallback((): Promise<void> => {
    if (inFlight.current) return inFlight.current;
    const forClient = client;
    const mySeq = ++seq.current;
    const run = (async () => {
      try {
        if (!configRef.current) configRef.current = await forClient.getConfig();
        const next = await fetchSnapshot(forClient, configRef.current, snapRef.current);
        // Ignore answers for another client, or older than one already shown.
        if (clientRef.current !== forClient || mySeq < applied.current) return;
        // Public nodes are not all at the same block. An answer from one that is behind (an
        // earlier round, or this round not yet saved when we have already seen it saved)
        // must not undo what is on screen.
        const shown = snapRef.current;
        if (shown && isBehind(shown, next)) return;
        applied.current = mySeq;
        // A view answers with the timestamp of a block that is already a little
        // old, by a different amount each time. The largest recent offset is
        // the least stale one, and using it keeps the countdown from jumping.
        offsets.current.push(next.state.nowNs - BigInt(Math.round(next.receivedAt * 1e6)));
        if (offsets.current.length > 20) offsets.current.shift();
        const prev = snapRef.current;
        if (prev && next.state.round > prev.state.round) {
          const closedRound = next.state.round - 1;
          const o = outcomeOfRound(next.history, closedRound);
          const close: RoundClose = {
            id: ++eventId.current,
            round: closedRound,
            ...o,
            roundsClosed: next.state.round - prev.state.round,
            balanceBefore: prev.account?.balance ?? null,
            balanceAfter: next.account?.balance ?? null,
            at: performance.now(),
          };
          closeRef.current = close;
          setLastClose(close);
        } else {
          const amended = amendClose(closeRef.current, next, performance.now());
          if (amended) {
            closeRef.current = amended;
            setLastClose(amended);
          }
        }
        snapRef.current = next;
        setSnapshot(next);
        setStale(false);
        setError(null);
      } catch (e) {
        if (clientRef.current !== forClient) return;
        // Nothing of this client's to show: drop a picture held over from the last one.
        if (snapRef.current === null) {
          setSnapshot(null);
          setStale(false);
        }
        setError(e instanceof Error ? e.message : String(e));
      }
    })().finally(() => {
      if (inFlight.current === run) inFlight.current = null;
    });
    inFlight.current = run;
    return run;
  }, [client]);

  const nowNs = useCallback((): bigint => {
    const s = snapRef.current;
    if (!s) return 0n;
    const scale = clientRef.current.timeScale?.();
    if (scale !== undefined) {
      // Demo clock: exact at the moment of the snapshot, and it may run fast.
      const elapsedMs = performance.now() - s.receivedAt;
      return s.state.nowNs + BigInt(Math.round(elapsedMs * scale * 1e6));
    }
    // Chain clock: local time plus the offset learnt from `now_ns`.
    let offset = offsets.current[0] ?? 0n;
    for (const o of offsets.current) if (o > offset) offset = o;
    const estimate = BigInt(Math.round(performance.now() * 1e6)) + offset;
    return estimate > s.state.nowNs ? estimate : s.state.nowNs;
  }, []);

  // Reset on client change, then poll.
  useEffect(() => {
    const hold = options.holdKey !== undefined && heldKey.current === options.holdKey;
    heldKey.current = options.holdKey;
    if (hold) setStale(true);
    else {
      setSnapshot(null);
      setStale(false);
    }
    setError(null);
    setLastClose(null);
    setNotice(null);
    setLastTx(null);
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      void refresh();
    }, pollMs);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [client, pollMs, refresh]);

  // Poll the moment the local clock says the round is over. On chain the
  // answer can lag a block or two, so keep asking, gently, until it rolls.
  useEffect(() => {
    if (!snapshot) return;
    const scale = client.timeScale?.();
    const leftMs = Number(snapshot.state.roundEndNs - nowNs()) / 1e6 / (scale ?? 1);
    if (leftMs > pollMs) return;
    const wait = leftMs > 0 ? leftMs + (scale === undefined ? 400 : 30) : scale === undefined ? 900 : 30;
    const t = window.setTimeout(() => {
      if (document.visibilityState !== 'hidden') void refresh();
    }, wait);
    return () => window.clearTimeout(t);
  }, [snapshot, client, pollMs, refresh, nowNs]);

  const busy = useRef(false);
  const act = useCallback(
    async (action: Action, guard?: VolunteerGuard): Promise<TxResult | null> => {
      // A ref, not the state: two clicks in the same frame must not send twice.
      if (busy.current) return null;
      busy.current = true;
      const forClient = client;
      setPending(action);
      try {
        const res = action === 'volunteer' && guard ? await client.volunteer(guard) : await client.claim();
        if (res.ok) {
          // The transaction is final, but the node we read from may be a block behind. Stay
          // "in flight" until one snapshot shows the result, so the button, the seat, who is It
          // and every figure change together and nothing is half-new.
          const me = client.accountId();
          const landed = (snap: GameSnapshot | null) => {
            if (!snap) return false;
            if (action === 'claim') return !!snap.account && snap.account.claimed && snap.account.balance > 0n;
            return snap.state.round > (guard?.round ?? 0) || (snap.state.saved && snap.state.hero === me);
          };
          for (let attempt = 0; attempt < 12 && clientRef.current === forClient; attempt++) {
            inFlight.current = null;
            await refresh();
            if (landed(snapRef.current)) break;
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
          setNotice(null);
        } else {
          setNotice({ id: ++eventId.current, text: res.message, gentle: isGentle(res.code) });
          inFlight.current = null;
          await refresh();
        }
        if (res.txHash) setLastTx({ id: ++eventId.current, hash: res.txHash, action, ok: res.ok });
        return res;
      } catch (e) {
        setNotice({ id: ++eventId.current, text: e instanceof Error ? e.message : 'That did not go through.', gentle: false });
        return null;
      } finally {
        busy.current = false;
        setPending(null);
      }
    },
    [client, refresh],
  );

  const claim = useCallback(() => act('claim'), [act]);
  const volunteer = useCallback((guard: VolunteerGuard) => act('volunteer', guard), [act]);
  const dismissNotice = useCallback(() => setNotice(null), []);

  return useMemo(
    () => ({ snapshot, error, stale, lastClose, pending, notice, dismissNotice, lastTx, nowNs, refresh, claim, volunteer }),
    [snapshot, error, stale, lastClose, pending, notice, dismissNotice, lastTx, nowNs, refresh, claim, volunteer],
  );
}
