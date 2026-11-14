/**
 * The Play screen's one scene: holders on a ring, all looking away; a clock
 * ring in the middle that burns down; It in the middle seat; you at six
 * o'clock with the one button. Faces, ring and coins share one coordinate
 * system: pixels from the stage's top-left corner (see layout.ts).
 */
import { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';
import type { CrowdMember } from '../../client/types';
import type { Game, GameSnapshot, RoundClose } from '../../hooks/useGame';
import { prefersReducedMotion } from '../../hooks/useReducedMotion';
import { makeRng } from '../../client/rng';
import { useLive } from '../../hooks/useLive';
import type { Live } from '../../hooks/useLive';
import type { ChainUi } from '../../hooks/useSession';
import { itCollects, maxCostFor, outcomesFor } from '../../lib/cost';
import { NAME_MAX, NAME_MAX_COMPACT, NAME_MAX_LINE_COMPACT, formatCountdown, formatPpm, formatShare, formatToken, shortAccount, spokenCountdown } from '../../lib/format';
import { Digits, Who, cls, useTweened } from '../ui';
import { TxLink } from './Chain';
import { COMPACT_BELOW, SHORT_BELOW, sceneLayout, stableOrder } from './layout';
import type { Box, Point, SceneLayout } from './layout';

function amount(v: bigint): string {
  return formatToken(v, { maxFrac: 2, fixed: true });
}

function nameOf(id: string, me: string | null): string {
  return me !== null && id === me ? 'you' : shortAccount(id);
}

/** True when the run of unsaved rounds has hit its limit and nothing is charged until someone volunteers. */
export function isAsleep(snap: GameSnapshot): boolean {
  const s = snap.state;
  return s.it !== null && !s.saved && !s.armed && s.collapseRun >= snap.config.maxCollapseRun;
}

/* ------------------------------------------------------------------ people */

export interface Person {
  id: string;
  /** Null for a holder we cannot name. */
  name: string | null;
  /** Second half of the tooltip: a balance share or a count of saves. */
  note: string;
}

/** Everyone on the ring except you: the simulated crowd, or the accounts the chain lets us name plus the rest as plain faces. */
export function peopleFor(snap: GameSnapshot, crowd: CrowdMember[] | null, cap = 24): Person[] {
  const { state: s, accountId: me, itAccount } = snap;
  if (crowd) {
    return crowd
      .filter((c) => c.accountId !== me)
      .map((c) => ({ id: c.accountId, name: c.accountId, note: `${formatShare(c.balance, s.totalSupply, 1)} share` }));
  }
  const known: Person[] = snap.heroes
    .filter((h) => h.accountId !== me)
    .map((h) => ({
      id: h.accountId,
      name: h.accountId,
      note:
        h.accountId === s.it && itAccount ? `${formatShare(itAccount.balance, s.totalSupply, 1)} share` : `${h.saves} ${h.saves === 1 ? 'save' : 'saves'}`,
    }));
  if (s.it && s.it !== me && !known.some((k) => k.id === s.it)) {
    known.unshift({ id: s.it, name: s.it, note: itAccount ? `${formatShare(itAccount.balance, s.totalSupply, 1)} share` : '' });
  }
  const mine = snap.account?.claimed ? 1 : 0;
  const anon = Math.max(0, Math.min(s.claimsMade, cap) - mine - known.length);
  const out = known.slice(0, cap);
  for (let i = 0; i < anon; i++) out.push({ id: `anon-${i}`, name: null, note: '' });
  return out;
}

/* ------------------------------------------------------------------- faces */

interface FaceProps {
  at: Point;
  r: number;
  /** Unit vector the pupils are pushed along; (0, 0) looks straight out at the viewer. */
  gaze: Point;
  it?: boolean;
  you?: boolean;
  /** Unit vector pointing away from the centre: the way a face recoils. */
  out: Point;
  /** Place in the ring, for staggered motion. */
  index: number;
  /** Rank clockwise from twelve o'clock, for the opening sweep. */
  sweep?: number;
  label: string;
  id: string;
  tab: boolean;
  onTip(id: string | null): void;
}

const Face = memo(function Face({ at, r, gaze, it, you, out, index, sweep = 0, label, id, tab, onTip }: FaceProps) {
  const style = {
    '--r': `${r}px`,
    '--gx': gaze.x.toFixed(3),
    '--gy': gaze.y.toFixed(3),
    '--ox': out.x.toFixed(3),
    '--oy': out.y.toFixed(3),
    '--i': index,
    '--sw': sweep,
    // Placed with `translate`, so `scale` (breathing) and `transform` (the flinch) act on the face where it stands.
    translate: `${at.x.toFixed(1)}px ${at.y.toFixed(1)}px`,
  } as CSSProperties;
  return (
    <span
      className={cls('face', it && 'face--it', you && 'face--you')}
      style={style}
      role="img"
      aria-label={label}
      tabIndex={tab ? 0 : -1}
      data-face={id}
      onMouseEnter={() => onTip(id)}
      onMouseLeave={() => onTip(null)}
      onFocus={() => onTip(id)}
      onBlur={() => onTip(null)}
    >
      <i />
      <i />
    </span>
  );
});

function away(from: Point, p: Point): Point {
  const dx = p.x - from.x;
  const dy = p.y - from.y;
  const d = Math.hypot(dx, dy) || 1;
  return { x: dx / d, y: dy / d };
}

const STRAIGHT: Point = { x: 0, y: 0 };
const AT_THE_CLOCK: Point = { x: 0, y: -1 };
const DOWN: Point = { x: 0, y: 1 };

/**
 * Everyone looks away and hopes someone else does it. Now and then one face
 * steals a glance at the middle, or blinks: rarely early in a round, more
 * often and in small waves near its end. Seeded per round, driven by a few
 * timers and class names (no rendering, no per-frame work), and off when the
 * viewer prefers reduced motion.
 */
function useGlances(stage: React.RefObject<HTMLElement | null>, game: Game, round: number, active: boolean) {
  const gameRef = useRef(game);
  gameRef.current = game;
  useEffect(() => {
    if (!active || prefersReducedMotion()) return;
    const rng = makeRng((round * 2654435761) >>> 0);
    const timers = new Set<number>();
    const later = (fn: () => void, ms: number) => {
      const t = window.setTimeout(() => {
        timers.delete(t);
        fn();
      }, ms);
      timers.add(t);
    };
    const play = (el: Element | undefined, name: string, ms: number) => {
      if (!el) return;
      el.classList.add(name);
      later(() => el.classList.remove(name), ms);
    };
    const progress = () => {
      const snap = gameRef.current.snapshot;
      if (!snap) return 0;
      const total = Number(snap.config.roundNs);
      return total > 0 ? Math.min(1, Math.max(0, Number(gameRef.current.nowNs() - snap.state.roundStartNs) / total)) : 0;
    };
    const tick = () => {
      const late = progress() > 0.8;
      const el = stage.current;
      if (el && !document.hidden) {
        const faces = Array.from(el.querySelectorAll('.face:not(.face--it):not(.face--you)'));
        if (faces.length > 0) {
          const at = Math.floor(rng.next() * faces.length);
          if (rng.chance(late ? 0.85 : 0.6)) {
            // Near the end the glance spreads to a neighbour or two.
            const wave = late ? 1 + Math.floor(rng.next() * 3) : 1;
            for (let k = 0; k < wave; k++) later(() => play(faces[(at + k) % faces.length], 'face--glance', 680), k * 150);
          } else {
            play(faces[at], 'face--blink', 240);
          }
        }
      }
      later(tick, late ? rng.range(650, 1500) : rng.range(2600, 6200));
    };
    later(tick, rng.range(1200, 2800));
    return () => {
      for (const t of timers) window.clearTimeout(t);
      timers.clear();
    };
  }, [stage, round, active]);
}

/* -------------------------------------------------------------- one shared tick */

export const LiveContext = createContext<Live | null>(null);

/**
 * The cost on the button and the figures under the stage come from the same
 * tick, so they can never disagree by a frame. Only the consumers re-render.
 */
export function LiveProvider({ game, children }: { game: Game; children: ReactNode }) {
  const live = useLive(game, 10);
  return <LiveContext.Provider value={live}>{children}</LiveContext.Provider>;
}

function useSharedLive(): Live {
  const live = useContext(LiveContext);
  if (!live) throw new Error('LiveProvider is missing');
  return live;
}

/* ------------------------------------------------------------------- clock */

/** The ring that is both clock and fuse, and the time inside it. The only part of the scene that moves every frame. */
function Clock({ game, snap, layout, box, flash, asleep, scale, arriving }: { game: Game; snap: GameSnapshot; layout: SceneLayout; box: Box; flash: RoundClose | null; asleep: boolean; scale: number; arriving: boolean }) {
  // Fifteen steps a second: a step of the ring is a fraction of a pixel on chain and under two degrees in the fastest demo.
  const live = useLive(game, 15);
  const s = snap.state;
  const { center, clockR } = layout;
  const stroke = layout.compact ? 10 : 12;
  const r = clockR - stroke / 2;
  const c = 2 * Math.PI * r;
  // Once the local clock has rolled into the next round, the ring burns again at once.
  const idle = !live.rolled && (s.saved || asleep || s.roundSupply === 0n);
  const p = idle ? 0 : live.progress;
  // What the viewer waits through: real seconds, also when the demo runs its rounds fast.
  const shownMs = live.msLeft / scale;
  const text = formatCountdown(shownMs);

  // Size the numerals to the ring: digits are 0.45em wide, colons narrower.
  const digits = [...text].filter((ch) => ch >= '0' && ch <= '9').length;
  const em = digits * 0.45 + (text.length - digits) * 0.26;
  const inner = clockR - stroke;
  const size = Math.min(clockR * 0.66, (inner * 1.5) / em);

  return (
    <>
      <svg className="ring" width={box.w} height={box.h} viewBox={`0 0 ${box.w} ${box.h}`} aria-hidden="true" focusable="false">
        <g key={flash?.kind === 'collapsed' ? flash.id : 0} className={cls(flash?.kind === 'collapsed' && 'ring--paid')}>
          <circle className={cls('ring__hair', asleep && 'ring__hair--asleep')} cx={center.x} cy={center.y} r={r} strokeWidth={asleep ? stroke : 2} />
          {!asleep && (
            <circle
              className="ring__burn"
              cx={center.x}
              cy={center.y}
              r={r}
              strokeWidth={stroke}
              strokeDasharray={`${(c * (1 - p)).toFixed(2)} ${c.toFixed(2)}`}
              strokeDashoffset={(-c * p).toFixed(2)}
              transform={`rotate(-90 ${center.x} ${center.y})`}
            />
          )}
          {!idle && (
            <g className={cls('ring__tip', shownMs <= 10_000 && live.progress >= 0.8 && 'ring__tip--late')} style={{ transform: `rotate(${(p * 360).toFixed(2)}deg)`, transformOrigin: `${center.x}px ${center.y}px` }}>
              <circle cx={center.x} cy={center.y - r} r={7} />
            </g>
          )}
        </g>
        {arriving && (
          // First load: a cover in the stage's own yellow recedes clockwise from twelve, so the ring draws on.
          <circle className="ring__cover" cx={center.x} cy={center.y} r={r} strokeWidth={stroke + 16} pathLength={1} strokeDasharray="1 1" transform={`rotate(-90 ${center.x} ${center.y})`} />
        )}
      </svg>
      <div className="clock" style={{ left: center.x, top: center.y - clockR * 0.25, fontSize: `${size.toFixed(1)}px` }} aria-hidden="true">
        <Digits text={text} />
      </div>
    </>
  );
}

/* -------------------------------------------------------------- the button */

interface ActState {
  label: string;
  /** The cost printed on the button, when there is one to pay. */
  cost: string | null;
  note: string | null;
  disabled: boolean;
  action: 'claim' | 'volunteer' | null;
}

function actFor(snap: GameSnapshot, live: Live, pending: Game['pending'], scale: number): ActState {
  const { state: s, config, account, accountId: me } = snap;
  const hasTokens = !!account && account.balance > 0n;
  const none = { cost: null, note: null, disabled: true, action: null } as const;

  if (!me || !account) return { ...none, label: 'Sign in' };
  if (!hasTokens) {
    if (!account.claimed && s.claimOpen) {
      return {
        label: pending === 'claim' ? 'Sending' : `Claim ${formatToken(config.claimAmount)} NOTIT`,
        cost: null,
        note: null,
        disabled: pending !== null,
        action: 'claim',
      };
    }
    return { ...none, label: "I'll do it", note: 'No NOTIT left' };
  }
  if (s.saved) return { ...none, label: 'Saved' };
  if (s.roundSupply === 0n) return { ...none, label: 'Nothing to save' };
  const cost = amount(live.cost);
  if (account.balance < live.cost) {
    // When does the falling cost reach this balance?
    const needPpm = Number((account.balance * 1_000_000n) / s.roundSupply);
    let note = 'More than you hold';
    if (needPpm >= config.minCostPpm + 1) {
      const span = config.maxCostPpm - config.minCostPpm;
      const at = span > 0 ? (config.maxCostPpm - needPpm) / span : 0;
      const roundMs = Number(config.roundNs / 1_000_000n);
      note = `Within reach at ${formatCountdown(((1 - at) * roundMs) / scale)}`;
    }
    return { label: "I'll do it", cost, note, disabled: true, action: null };
  }
  return { label: pending === 'volunteer' ? 'Sending' : "I'll do it", cost, note: null, disabled: pending !== null, action: 'volunteer' };
}

/** One line for screen readers, refreshed sparingly. */
function spokenStatus(snap: GameSnapshot, live: Live, scale: number): string {
  const s = snap.state;
  const me = snap.accountId;
  const left = spokenCountdown(live.msLeft / scale);
  const it = s.it ? `${s.it === me ? 'You are' : `${shortAccount(s.it)} is`} It.` : 'Nobody is It yet.';
  if (s.saved && s.hero) return `Round ${s.round} is saved by ${nameOf(s.hero, me)}. ${left} until the next round. ${it}`;
  if (s.roundSupply === 0n) return `Round ${s.round}. Nothing to save yet. ${left} left.`;
  if (isAsleep(snap)) return `Round ${s.round}. The game is asleep: nothing is charged until someone volunteers. ${it}`;
  return `Round ${s.round}. ${left} left. Nobody has volunteered. The cost is ${formatToken(live.cost, { maxFrac: 2 })} NOTIT. ${it}`;
}


/** Testnet with nobody signed in: one click to play as a guest, or a wallet. */
function SignIn({ chain, claimAmount, cost, onUseDemo }: { chain: ChainUi; claimAmount: bigint; cost: string | null; onUseDemo(): void }) {
  const { session, state } = chain;
  const { guest, wallet, restoring } = state;
  const running = guest.status === 'running';
  const failed = guest.status === 'error';
  const stored = session.storedGuestId();
  // The steps, said plainly: account, a claim per deployment, then the key is locked.
  const stepText =
    guest.step === 'account'
      ? 'Creating account'
      : guest.step === 'confirm'
        ? 'Waiting for the network'
        : guest.step === 'claim'
          ? `Claiming ${formatToken(claimAmount)} NOTIT${guest.detail ? ` on ${guest.detail}` : ''}`
          : guest.step === 'lock'
            ? 'Locking the key'
            : 'Starting';

  let label = 'Play as guest';
  if (restoring) label = 'Signing in…';
  else if (running) label = 'Setting up…';
  else if (failed) label = 'Try again';
  else if (stored) label = 'Continue as guest';

  const connect = (text: string) => (
    <button type="button" className="act__link" disabled={wallet.busy || restoring} onClick={() => void session.connectWallet()}>
      {text}
    </button>
  );

  return (
    <>
      <button
        type="button"
        className={cls('act', (running || restoring) && 'act--pending')}
        disabled={running || restoring}
        title="A throwaway testnet account. Its key stays in this browser."
        onClick={() => void session.playAsGuest()}
      >
        <span className="act__label">{label}</span>
      </button>
      <div className="act__note" role="status" aria-live="polite">
        {running ? (
          <span>
            {guest.at && guest.of ? `${guest.at}/${guest.of} ` : ''}
            {stepText}
          </span>
        ) : failed && guest.error ? (
          // The whole message, and every way out as a real control: the button above tries again.
          <span className="act__say">
            {guest.error} Try again in a minute,{' '}
            <button type="button" className="act__link" onClick={onUseDemo}>
              use the demo
            </button>
            , or {connect('connect a wallet')}.
          </span>
        ) : wallet.error ? (
          <span className="act__say">
            {wallet.error} {connect('Try again')}
          </span>
        ) : (
          // Before anyone signs in: what volunteering costs right now, and the other way in.
          <>
            {cost !== null && (
              <span className="act__now">
                cost now <Digits text={cost} /> ·{' '}
              </span>
            )}
            {connect(wallet.busy ? 'Opening wallets…' : 'Connect wallet')}
          </>
        )}
      </div>
    </>
  );
}

/** The single action, with the falling cost printed on it. */
function Act({ game, snap, chain, flash, scale, onUseDemo }: { game: Game; snap: GameSnapshot; chain: ChainUi | null; flash: RoundClose | null; scale: number; onUseDemo(): void }) {
  const live = useSharedLive();
  const { state: s, config, accountId: me } = snap;
  const act = actFor(snap, live, game.pending, scale);

  // Screen readers: one polite sentence when the round or its state changes, and not in between
  // (a line announced on a timer is out of date by the time it is read).
  const [spoken, setSpoken] = useState('');
  const latest = useRef({ snap, live, scale });
  latest.current = { snap, live, scale };
  const asleepNow = isAsleep(snap);
  useEffect(() => {
    setSpoken(spokenStatus(latest.current.snap, latest.current.live, latest.current.scale));
  }, [s.round, s.saved, s.it, asleepNow, scale]);

  const guestStatus = chain?.state.guest.status;
  const signUp = chain !== null && (!me || guestStatus === 'running' || guestStatus === 'error');

  // While the transaction is in flight the cost on the button stands still at what was agreed to.
  const [sent, setSent] = useState<string | null>(null);
  useEffect(() => {
    if (game.pending === null) setSent(null);
  }, [game.pending]);
  const onAct = () => {
    if (act.action === 'claim') void game.claim();
    else if (act.action === 'volunteer') {
      setSent(amount(live.cost));
      void game.volunteer({ round: s.round, maxCost: maxCostFor(live.cost) });
    }
  };
  const pending = game.pending !== null;
  const shownCost = game.pending === 'volunteer' && sent ? sent : act.cost;

  let note: ReactNode = null;
  if (game.notice) {
    note = (
      <span role="alert" className="act__alert" title={game.notice.text}>
        <button type="button" className="act__link act__ok" onClick={game.dismissNotice}>
          OK
        </button>
        <span className="act__msg">{game.notice.text}</span>
      </span>
    );
  } else if (flash?.kind === 'collapsed' && flash.balanceBefore !== null && flash.balanceAfter !== null && flash.balanceAfter !== flash.balanceBefore) {
    // Nobody did it: what that just cost you, or paid you as It.
    const up = flash.balanceAfter > flash.balanceBefore;
    note = (
      <span className="act__paid">
        you {up ? 'collected' : 'paid'} {amount(up ? flash.balanceAfter - flash.balanceBefore : flash.balanceBefore - flash.balanceAfter)}
      </span>
    );
  } else if (act.note) {
    note = <span>{act.note}</span>;
  } else if (chain && !game.pending && game.lastTx) {
    note = <TxLink chain={chain} hash={game.lastTx.hash} label={game.lastTx.ok ? (game.lastTx.action === 'claim' ? 'Claimed' : 'Confirmed') : 'Refused'} />;
  } else if (chain && !game.pending && chain.state.guest.claimTx) {
    note = <TxLink chain={chain} hash={chain.state.guest.claimTx} label="Claimed" />;
  }

  return (
    <div className="dock">
      <p className="sr-only" role="status" aria-live="polite">
        {spoken}
      </p>
      {signUp && chain ? (
        <SignIn chain={chain} claimAmount={config.claimAmount} cost={!s.saved && s.roundSupply > 0n ? amount(live.cost) : null} onUseDemo={onUseDemo} />
      ) : (
        <>
          <button
            type="button"
            className={cls('act', pending && 'act--pending')}
            disabled={act.disabled || live.rolled || game.stale}
            aria-busy={pending || undefined}
            aria-label={shownCost && act.action === 'volunteer' && !pending ? `${act.label}: burn ${shownCost} NOTIT` : undefined}
            onClick={onAct}
          >
            <span className="act__label">{act.label}</span>
            {shownCost && (
              <span className="act__cost" aria-hidden="true">
                <Digits text={shownCost} />
              </span>
            )}
          </button>
          <div className="act__note">{note}</div>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------- stage */

/** The opening choreography has played in this page load. */
let stagePlayed = false;

function useBox(): [React.RefObject<HTMLDivElement | null>, Box] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState<Box>({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      setBox((b) => (b.w === w && b.h === h ? b : { w, h }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, box];
}

interface Props {
  game: Game;
  snap: GameSnapshot;
  /** Set in Testnet mode. */
  chain: ChainUi | null;
  /** The round that just closed, for a few seconds. */
  flash: RoundClose | null;
  /** The simulated crowd, in Demo mode. */
  crowd: CrowdMember[] | null;
  /** Game seconds per real second: 1 on chain, more when the demo runs its rounds fast. */
  scale?: number;
  onUseDemo(): void;
}

export function Scene({ game, snap, chain, flash, crowd, scale = 1, onUseDemo }: Props) {
  const [ref, box] = useBox();
  const { state: s, accountId: me } = snap;
  const asleep = isAsleep(snap);
  const youAreIt = me !== null && s.it === me;

  const people = useMemo(() => peopleFor(snap, crowd), [snap, crowd]);
  const byId = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);
  const idsKey = people.map((p) => p.id).join('|');
  const orderRef = useRef<string[]>([]);
  const order = useMemo(() => {
    orderRef.current = stableOrder(orderRef.current, idsKey === '' ? [] : idsKey.split('|'));
    return orderRef.current;
  }, [idsKey]);

  // Whoever sits in the middle leaves the ring, and the rest close up around the gap.
  const ring = useMemo(() => order.filter((id) => id !== s.it), [order, s.it]);
  // The sentence at the top and the button at the bottom are measured, not assumed: larger
  // text, or a short window, changes how much room is left for the ring.
  const pitchRef = useRef<HTMLHeadingElement | null>(null);
  const [room, setRoom] = useState<{ pitchH: number; dockH: number } | null>(null);
  const short = box.h > 0 && box.h < SHORT_BELOW && box.w >= COMPACT_BELOW;
  useLayoutEffect(() => {
    const stage = ref.current;
    const pitch = pitchRef.current;
    const dock = stage?.querySelector<HTMLElement>('.dock');
    if (!stage || !pitch || !dock) return;
    const measure = () => {
      const top = stage.getBoundingClientRect().top;
      const p = pitch.getBoundingClientRect();
      const d = dock.getBoundingClientRect();
      const visible = p.height > 2 && getComputedStyle(pitch).position === 'absolute' && p.width > 2;
      const pitchH = visible ? Math.round(p.bottom - top) + 2 : 6;
      // A pinned button covers the bottom of the stage only while the page is at the top; its height is what counts.
      const dockH = Math.round(getComputedStyle(dock).position === 'fixed' ? d.height : stage.clientHeight - (d.top - top) + 4);
      setRoom((r) => (r && r.pitchH === pitchH && r.dockH === dockH ? r : { pitchH, dockH }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(pitch);
    ro.observe(dock);
    ro.observe(stage);
    return () => ro.disconnect();
  }, [ref, short]);
  const layout = useMemo(
    () => (box.w > 0 && box.h > 0 ? sceneLayout(box, ring.length, short ? { pitchH: room?.pitchH, side: true } : (room ?? {})) : null),
    [box, ring.length, room, short],
  );
  // Every face on the ring looks straight away from the centre.
  const gazes = useMemo(() => (layout ? layout.slots.map((p) => away(layout.center, p)) : []), [layout]);
  // The order the faces arrive in on first load: clockwise from twelve o'clock.
  const sweeps = useMemo(() => {
    if (!layout) return [];
    const angle = (p: Point) => (Math.atan2(p.x - layout.center.x, layout.center.y - p.y) + 2 * Math.PI) % (2 * Math.PI);
    const byAngle = layout.slots.map((p, i) => ({ i, a: angle(p) })).sort((x, y) => x.a - y.a);
    const rank: number[] = [];
    byAngle.forEach((x, k) => (rank[x.i] = k));
    return rank;
  }, [layout]);

  const [tip, setTip] = useState<string | null>(null);
  const onTip = useCallback((id: string | null) => setTip(id), []);
  useEffect(() => {
    if (tip === null) return;
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setTip(null);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [tip]);

  // When someone steps up, every other face watches them go to the middle for half a second.
  const [watching, setWatching] = useState(false);
  const lastIt = useRef(s.it);
  useEffect(() => {
    if (lastIt.current === s.it) return;
    lastIt.current = s.it;
    if (s.it === null || prefersReducedMotion()) return;
    setWatching(true);
    const t = window.setTimeout(() => setWatching(false), 560);
    return () => window.clearTimeout(t);
  }, [s.it]);
  // First load only: the sentence settles, the clock ring draws on, the faces arrive in a sweep
  // from twelve o'clock, then your face, then the button. Never again on a refresh of the data or
  // a return to this tab, and not at all under reduced motion.
  const [arriving, setArriving] = useState(() => !stagePlayed && !prefersReducedMotion());
  useEffect(() => {
    if (!arriving) return;
    stagePlayed = true;
    const t = window.setTimeout(() => setArriving(false), 1000);
    return () => window.clearTimeout(t);
  }, [arriving]);
  useGlances(ref, game, s.round, !s.saved && !asleep && s.roundSupply > 0n);

  // Arrow keys walk around the ring; the ring is one stop in the tab order, after the button.
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (step === 0) return;
    const all = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[data-face]'));
    const i = all.indexOf(document.activeElement as HTMLElement);
    if (i < 0 || all.length === 0) return;
    all[(i + step + all.length) % all.length]!.focus();
    e.preventDefault();
  };

  let faces: ReactNode = null;
  let coins: ReactNode = null;
  let tipEl: ReactNode = null;
  if (layout) {
    const { seat, slots } = layout;
    const placed: Array<{ id: string; at: Point; label: string }> = [];
    const els: ReactNode[] = [];
    let first = true;
    // Rendered in a fixed order, so a face that changes place glides instead of being re-inserted.
    const ringIndex = new Map(ring.map((id, i) => [id, i]));
    order.forEach((id) => {
      const p = byId.get(id);
      if (!p) return;
      const isIt = id === s.it;
      const idx = ringIndex.get(id) ?? -1;
      const slot = !isIt && idx >= 0 && idx < layout.shown ? slots[idx]! : null;
      if (!slot && !isIt) return;
      const at = isIt ? seat : slot!;
      const label = [p.name ? shortAccount(p.name, layout.compact ? NAME_MAX_COMPACT : NAME_MAX) : 'A holder', isIt ? 'It' : p.note].filter(Boolean).join(' · ');
      placed.push({ id, at, label });
      els.push(
        <Face key={id} id={id} at={at} r={isIt ? layout.seatR : layout.faceR} gaze={isIt ? STRAIGHT : gazes[idx]!} out={isIt ? STRAIGHT : gazes[idx]!} index={isIt ? 0 : idx} sweep={isIt ? 0 : (sweeps[idx] ?? 0)} it={isIt} label={label} tab={first} onTip={onTip} />,
      );
      first = false;
    });
    const youAt = youAreIt ? seat : layout.you;
    const youLabel = youAreIt ? 'You · It' : 'You';
    placed.push({ id: 'you', at: youAt, label: youLabel });
    els.push(
      <Face key="you" id="you" at={youAt} r={youAreIt ? layout.seatR : layout.youR} gaze={youAreIt ? STRAIGHT : layout.dock ? away(layout.you, layout.center) : AT_THE_CLOCK} out={youAreIt ? STRAIGHT : DOWN} index={ring.length} sweep={layout.shown} it={youAreIt} you label={youLabel} tab={first} onTip={onTip} />,
    );
    faces = els;

    if (flash?.kind === 'collapsed' && s.it !== null) {
      const payers = placed.filter((f) => f.id !== s.it && !(f.id === 'you' && (youAreIt || !snap.account || flash.balanceBefore === null)));
      coins = payers.map((f, i) => (
        <span
          key={`${flash.id}-${f.id}`}
          className="coin"
          style={
            {
              '--x0': `${f.at.x.toFixed(1)}px`,
              '--y0': `${f.at.y.toFixed(1)}px`,
              '--x1': `${seat.x.toFixed(1)}px`,
              '--y1': `${seat.y.toFixed(1)}px`,
              animationDelay: `${i * 30}ms`,
            } as CSSProperties
          }
        />
      ));
    }

    const tipped = tip ? placed.find((f) => f.id === tip) : null;
    if (tipped) {
      const rad = tipped.id === 'you' && !youAreIt ? layout.youR : layout.faceR;
      // It sits under the numerals: its name goes below it, not over the time.
      const below = tipped.at.y - rad < 44 || tipped.id === s.it || (tipped.id === 'you' && youAreIt);
      tipEl = (
        <span
          className={cls('tip', below && 'tip--below')}
          style={{ left: Math.min(box.w - 70, Math.max(70, tipped.at.x)), top: below ? tipped.at.y + rad + 8 : tipped.at.y - rad - 8 }}
        >
          {tipped.label}
        </span>
      );
    }
  }

  // One short line under the clock, never wider than the space between the faces beside it:
  // the name is cut to what fits (the whole name is in its title and in the tooltip).
  // On a phone the name stands without its ".testnet", at one length; elsewhere it is the usual shortening.
  const lineW = layout?.lineW ?? 320;
  // Where the faces leave too little room for the long form, the short form is used, and where
  // even that is tight the line is set a size smaller: the name is cut once, never clipped again.
  const narrow = !!layout?.compact || !!layout?.dock;
  const perChar = s.saved ? (narrow ? 9.6 : 11) : 9;
  const words = s.saved ? 9 : 6;
  const shortName = narrow || (words + NAME_MAX) * perChar > lineW;
  const lineTight = shortName && (words + NAME_MAX_LINE_COMPACT) * perChar > lineW;
  const lineName = shortName ? { max: NAME_MAX_LINE_COMPACT, keepSuffix: false } : { max: NAME_MAX, keepSuffix: true };
  let line: ReactNode;
  const savedByYou = s.saved && s.hero !== null && s.hero === me;
  if (s.roundSupply === 0n) line = 'no tokens yet';
  else if (savedByYou) line = null;
  else if (s.saved && s.hero) {
    line = (
      <>
        saved by <Who id={s.hero} me={me} {...lineName} />
      </>
    );
  } else if (asleep) line = 'asleep';
  else if (s.it) {
    line = (
      <>
        <Who id={s.it} me={me} {...lineName} /> {youAreIt ? 'are' : 'is'} It
      </>
    );
  } else line = 'nobody is It';

  return (
    <section
      ref={ref}
      className={cls(
        'stage',
        s.saved && 'stage--saved',
        asleep && 'stage--asleep',
        flash?.kind === 'collapsed' && 'stage--paid',
        watching && 'stage--watch',
        arriving && 'stage--arriving',
        short && 'stage--side',
        layout?.compact && 'stage--compact',
      )}
      aria-label="The game"
      aria-busy={game.stale || undefined}
      style={
        {
          ...(layout?.dock ? { '--dock-x': `${layout.dock.x}px`, '--dock-y': `${layout.dock.y}px`, '--dock-w': `${layout.dock.w}px` } : {}),
          // The sweep fits in 400 ms however many faces there are.
          '--step': `${Math.min(20, Math.floor(400 / Math.max(1, layout?.shown ?? 1)))}ms`,
          '--n': layout?.shown ?? 0,
        } as CSSProperties
      }
    >
      <h1 className="stage__pitch" ref={pitchRef}>
        Somebody has to do it. If nobody does, everybody pays the last person who did.
      </h1>
      <Act game={game} snap={snap} chain={chain} flash={flash} scale={scale} onUseDemo={onUseDemo} />
      {layout && (
        <>
          <Clock game={game} snap={snap} layout={layout} box={box} flash={flash} asleep={asleep} scale={scale} arriving={arriving} />
          {s.it === null && (
            <span className="seat" aria-hidden="true" style={{ '--r': `${layout.seatR}px`, transform: `translate(${layout.seat.x}px, ${layout.seat.y}px)` } as CSSProperties} />
          )}
          <div className="faces" role="group" aria-label="Holders" onKeyDown={onKey}>
            {faces}
          </div>
          {layout.more && (
            <span className="more" style={{ transform: `translate(${layout.more.x}px, ${layout.more.y}px)` }} title={`${layout.extra} more`}>
              +{layout.extra}
            </span>
          )}
          <div className="coins" aria-hidden="true">
            {coins}
          </div>
          <div
            className="stage__under"
            style={{ top: layout.center.y + layout.clockR + (layout.dock ? 4 : layout.compact ? 8 : 12), left: layout.center.x - box.w / 2, right: box.w / 2 - layout.center.x, '--line-w': `${Math.round(lineW)}px` } as CSSProperties}
          >
            {savedByYou ? (
              <span className="stamp" key={s.round}>
                You did it
              </span>
            ) : (
              <span className={cls('stage__line', s.saved && 'stage__line--saved', lineTight && 'stage__line--tight')} id="round-line">
                {line}
              </span>
            )}
          </div>
          {tipEl}
        </>
      )}
    </section>
  );
}

/**
 * The stage before there is a game to show: the ring as empty circles and an
 * idle clock. Also the frame for "could not reach the network", with whatever
 * is passed in sitting where the button goes.
 */
export function StageShell({ busy, line, children }: { busy?: boolean; line?: string; children?: ReactNode }) {
  const [ref, box] = useBox();
  const layout = useMemo(() => (box.w > 0 && box.h > 0 ? sceneLayout(box, 12) : null), [box]);
  return (
    <section ref={ref} className="stage stage--shell" aria-busy={busy || undefined} aria-label={busy ? 'Loading the game' : undefined}>
      <h1 className="stage__pitch">Somebody has to do it. If nobody does, everybody pays the last person who did.</h1>
      {children && <div className="dock">{children}</div>}
      {layout && (
        <>
          <svg className="ring" width={box.w} height={box.h} viewBox={`0 0 ${box.w} ${box.h}`} aria-hidden="true" focusable="false">
            <circle className="ring__hair" cx={layout.center.x} cy={layout.center.y} r={layout.clockR - (layout.compact ? 5 : 6)} strokeWidth={2} />
          </svg>
          <div aria-hidden="true">
            {[...layout.slots, layout.you].map((p, i) => (
              <span
                key={i}
                className="face face--ghost"
                style={{ '--r': `${i === layout.slots.length ? layout.youR : layout.faceR}px`, '--i': i, translate: `${p.x.toFixed(1)}px ${p.y.toFixed(1)}px` } as CSSProperties}
              />
            ))}
          </div>
          {line && (
            <div className="stage__under" style={{ top: layout.center.y + layout.clockR + (layout.compact ? 8 : 12) }}>
              <span className="stage__line">{line}</span>
            </div>
          )}
        </>
      )}
    </section>
  );
}

/* ----------------------------------------------------- figures (below the stage) */

interface Fig {
  key: string;
  label: string;
  value: ReactNode;
  tone?: 'cut' | 'up';
  title: string;
}

/** What each ending of this round does to one balance, and what It stands to collect. */
export function Figures({ snap, flash }: { snap: GameSnapshot; flash: RoundClose | null }) {
  const live = useSharedLive();
  const { state: s, config, account, itAccount, accountId: me } = snap;
  const hasTokens = !!account && account.balance > 0n;
  const balance = hasTokens ? account!.balance : config.claimAmount;
  const isIt = hasTokens && !!account?.isIt;
  const cutPct = formatPpm(config.cutPpm);
  const o = outcomesFor(balance, live.cost, config.cutPpm);
  const open = !s.saved && s.roundSupply > 0n;
  const charged = open && s.armed;
  // A change of balance rolls to its new value in 400 ms, with the +/− chip fading in beside it.
  const shownBalance = useTweened(balance, 400);
  const collected = useTweened(itAccount?.collected ?? 0n);
  const paid = flash?.kind === 'collapsed';
  // Nothing held, nothing to show: the figures are dashes until there is a balance.
  const of = 'your balance';

  // What the round that just closed did to this balance: a cut, or a payment to It.
  const delta = paid && flash.balanceBefore !== null && flash.balanceAfter !== null ? flash.balanceAfter - flash.balanceBefore : 0n;

  const withBalance: Fig[] = [
    {
      key: 'keep',
      label: 'keep',
      value: (
        <>
          {hasTokens ? <Digits text={amount(shownBalance)} /> : '—'}
          {delta !== 0n && (
            <span className={cls('figs__delta', delta > 0n && 'figs__delta--up')} key={flash!.id}>
              {delta > 0n ? '+' : '−'}
              {amount(delta > 0n ? delta : -delta)}
            </span>
          )}
        </>
      ),
      title: `Someone else does it: ${of} stays as it is`,
    },
    isIt
      ? {
          key: 'none',
          label: 'collect',
          value: charged ? <Digits text={amount(balance + itCollects(s.totalSupply, balance, config.cutPpm))} /> : '—',
          tone: 'up',
          title: 'Nobody does it: everyone pays you',
        }
      : {
          key: 'none',
          label: `pay ${cutPct}`,
          value: charged && hasTokens ? <Digits text={amount(o.ifCollapsed)} /> : '—',
          tone: 'cut',
          title: `Nobody does it: ${of} after the ${cutPct} cut`,
        },
    {
      key: 'do',
      label: 'burn now',
      value: open && hasTokens && o.ifYouDoIt !== null ? <Digits text={amount(o.ifYouDoIt)} /> : '—',
      title: `You do it now: ${of} after burning the cost`,
    },
  ];
  // With nothing held yet (signed out, or before a claim) the row leads with the number the whole
  // game turns on: what it costs to volunteer right now, from the same tick as the button's.
  const figs: Fig[] = hasTokens
    ? withBalance
    : [
        {
          key: 'cost',
          label: 'cost now',
          value: open ? <Digits text={amount(live.cost)} /> : '—',
          title: 'What volunteering costs right now; it falls until the round ends',
        },
      ];
  if (s.it && s.it !== me) {
    const gain = itAccount ? itCollects(s.totalSupply, itAccount.balance, config.cutPpm) : 0n;
    figs.push(
      paid
        ? { key: 'it', label: 'Paid to It', value: <Digits text={amount(collected)} />, tone: 'up', title: `${shortAccount(s.it)} has collected this much as It` }
        : {
            key: 'it',
            label: 'It collects',
            value: charged ? <Digits text={`+${amount(gain)}`} /> : '—',
            title: `What ${shortAccount(s.it)} collects if nobody does it`,
          },
    );
  }

  return (
    <dl className="figs" aria-label={hasTokens ? `What each ending of this round does to ${of}` : 'What volunteering costs right now, and what It collects if nobody does'}>
      {figs.map((f) => (
        <div key={f.key} className={cls('figs__item', f.tone && `figs__item--${f.tone}`)} title={f.title}>
          <dt>{f.label}</dt>
          <dd>{f.value}</dd>
        </div>
      ))}
    </dl>
  );
}
