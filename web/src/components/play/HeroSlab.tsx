import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { outcomeOfRound } from '../../hooks/useGame';
import type { Game, GameSnapshot, RoundClose } from '../../hooks/useGame';
import { useLive } from '../../hooks/useLive';
import type { ChainUi } from '../../hooks/useSession';
import type { Live } from '../../hooks/useLive';
import { itCollects, maxCostFor, outcomesFor } from '../../lib/cost';
import { formatCountdown, formatPpm, formatToken, shortAccount, spokenCountdown } from '../../lib/format';
import { Digits, Who, cls } from '../ui';
import { GuestStart, TxLink } from './Chain';

function amount(v: bigint): string {
  return formatToken(v, { maxFrac: 2, fixed: true });
}

/** The save entry for the round on screen, if it has been saved. */
function currentSave(snap: GameSnapshot) {
  for (let i = snap.history.length - 1; i >= 0; i--) {
    const e = snap.history[i]!;
    if (e.kind === 'saved' && e.round === snap.state.round) return e;
    if (e.kind === 'saved' && e.round < snap.state.round) break;
  }
  return null;
}

function name(id: string, me: string | null): string {
  return me !== null && id === me ? 'you' : shortAccount(id);
}

/** One line for screen readers, refreshed sparingly. */
function spokenStatus(snap: GameSnapshot, live: Live): string {
  const s = snap.state;
  const left = spokenCountdown(live.msLeft);
  if (s.saved && s.hero) return `Round ${s.round} is saved by ${name(s.hero, snap.accountId)}. ${left} until the next round.`;
  if (s.roundSupply === 0n) return `Round ${s.round}. Nothing to save yet. ${left} left.`;
  return `Round ${s.round}. ${left} left. Nobody has stepped up. The cost is ${formatToken(live.cost, { maxFrac: 2 })} NOTIT.`;
}

function Ticker({ snap, flash }: { snap: GameSnapshot; flash: RoundClose | null }) {
  const me = snap.accountId;
  const cutPct = formatPpm(snap.config.cutPpm);
  // While a round has just closed, show it loudly; otherwise show the last round quietly.
  const lastRound = snap.state.round - 1;
  const last = flash ?? (lastRound >= 1 ? { round: lastRound, ...outcomeOfRound(snap.history, lastRound) } : null);
  if (!last) {
    return (
      <p className="slab__ticker">
        <span className="slab__stamp">New game</span>
      </p>
    );
  }
  let text: ReactNode;
  let stamp: string;
  if (last.kind === 'saved') {
    text = (
      <>
        #{last.round} <b>{last.hero ? name(last.hero, me) : 'someone'}</b> did it · {formatCountdown(last.msLeft)} left
      </>
    );
    stamp = 'Saved';
  } else if (last.kind === 'collapsed') {
    text = (
      <>
        #{last.round} nobody · everyone paid <b>{last.it ? name(last.it, me) : 'It'}</b>
      </>
    );
    stamp = `−${cutPct}`;
  } else {
    text = <>#{last.round} nobody</>;
    stamp = 'No charge';
  }
  return (
    <p className={cls('slab__ticker', `slab__ticker--${last.kind}`, flash && 'slab__ticker--live')} key={flash?.id ?? 0}>
      <span className="slab__stamp">{stamp}</span>
      <span>{text}</span>
    </p>
  );
}

/**
 * The falling line: the cost rate from round open to the deadline, with a dot
 * where the round is now and the live cost written on it.
 */
function CostCurve({
  progress,
  maxPpm,
  minPpm,
  saved,
  now,
}: {
  progress: number;
  maxPpm: number;
  minPpm: number;
  saved: boolean;
  /** The live cost to show on the dot; null when there is nothing to pay. */
  now: string | null;
}) {
  const p = Math.min(1, Math.max(0, progress));
  const at = { left: `${p * 100}%`, top: `${5 + p * 90}%` };
  return (
    <div className={cls('curve', saved && 'curve--saved')} aria-hidden="true">
      <span className="curve__end curve__end--hi">{formatPpm(maxPpm)} at the start</span>
      <div className="curve__plot">
        <svg viewBox="0 0 100 40" preserveAspectRatio="none">
          <polygon className="curve__spent" points={`0,2 ${p * 100},${2 + p * 36} ${p * 100},40 0,40`} />
          <line className="curve__line" x1="0" y1="2" x2="100" y2="38" vectorEffect="non-scaling-stroke" />
        </svg>
        <span className="curve__dot" style={at} />
        {now !== null && (
          <span className={cls('curve__now', p > 0.72 && 'curve__now--left')} style={at}>
            {now}
          </span>
        )}
      </div>
      <span className="curve__end curve__end--lo">{formatPpm(minPpm)} at 0:00</span>
    </div>
  );
}

// Three ways of not looking at the button.
const LOOKS = ['l', 'u', 'r', 'r', 'l', 'u', 'l', 'r', 'u', 'r', 'l', 'l', 'u', 'r', 'u', 'l'] as const;

/**
 * The crowd: one small face per holder, every one of them looking away.
 * Whoever is It is the dark one, looking straight at you. Decoration only.
 */
function Heads({ count, hasIt, round }: { count: number; hasIt: boolean; round: number }) {
  const n = Math.max(0, Math.min(24, count));
  return (
    // Keyed by round so the glance-away plays once each time a round opens.
    <div className="heads" aria-hidden="true" key={round}>
      {Array.from({ length: n }, (_, i) => {
        const it = hasIt && i === 0;
        return (
          <span key={i} className={cls('head', it ? 'head--it' : `head--${LOOKS[i % LOOKS.length]}`)} style={{ animationDelay: `${(i % 8) * 40}ms` }}>
            <i />
            <i />
          </span>
        );
      })}
    </div>
  );
}

interface OutcomeTile {
  key: string;
  tone: 'plain' | 'cut' | 'do' | 'it';
  label: string;
  value: string;
}

/** What each ending of this round does to one balance: three labels, three numbers. */
function Outcomes({ snap, live }: { snap: GameSnapshot; live: Live }) {
  const { state: s, config, account } = snap;
  const hasTokens = !!account && account.balance > 0n;
  const balance = hasTokens ? account!.balance : config.claimAmount;
  const isIt = hasTokens && !!account?.isIt;
  const cutPct = formatPpm(config.cutPpm);
  const o = outcomesFor(balance, live.cost, config.cutPpm);
  const heading = hasTokens ? 'Your balance after' : `${formatToken(balance)} NOTIT after`;
  const spoken = hasTokens ? 'What each ending of this round does to your balance' : `What each ending of this round would do to ${formatToken(balance)} NOTIT`;
  const youDoIt = o.ifYouDoIt === null ? '—' : amount(o.ifYouDoIt);

  const tiles: OutcomeTile[] = [];
  if (s.roundSupply === 0n) {
    // Nothing to save: no figures.
  } else if (s.saved) {
    tiles.push({ key: 'saved', tone: 'plain', label: 'Saved · nobody pays', value: amount(o.keep) });
  } else if (!s.armed) {
    tiles.push({ key: 'none', tone: 'plain', label: 'Nobody does · no charge', value: amount(o.keep) });
    tiles.push({ key: 'do', tone: 'do', label: 'You do it', value: youDoIt });
  } else if (isIt) {
    const gain = itCollects(s.totalSupply, balance, config.cutPpm);
    tiles.push({ key: 'none', tone: 'it', label: 'Nobody does · you collect', value: amount(balance + gain) });
    tiles.push({ key: 'other', tone: 'plain', label: 'Someone else does', value: amount(o.keep) });
    tiles.push({ key: 'do', tone: 'do', label: 'You do it', value: youDoIt });
  } else {
    tiles.push({ key: 'other', tone: 'plain', label: 'Someone else does', value: amount(o.keep) });
    tiles.push({ key: 'none', tone: 'cut', label: `Nobody does · −${cutPct}`, value: amount(o.ifCollapsed) });
    tiles.push({ key: 'do', tone: 'do', label: 'You do it', value: youDoIt });
  }
  if (tiles.length === 0) return null;

  return (
    <div className="outcomes" role="group" aria-label={spoken}>
      <h3 className="outcomes__title">{heading}</h3>
      <ul className="outcomes__list">
        {tiles.map((t) => (
          <li key={t.key} className={cls('outcome', `outcome--${t.tone}`)}>
            <span className="outcome__label">{t.label}</span>
            <span className="outcome__value">{t.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

interface CtaState {
  label: string;
  sub: string | null;
  hint: string | null;
  disabled: boolean;
  action: 'claim' | 'volunteer' | null;
}

function ctaFor(snap: GameSnapshot, live: Live, pending: Game['pending']): CtaState {
  const { state: s, config, account, accountId: me } = snap;
  const hasTokens = !!account && account.balance > 0n;

  if (!me || !account) return { label: 'Sign in to play', sub: null, hint: null, disabled: true, action: null };
  if (!hasTokens) {
    if (!account.claimed && s.claimOpen) {
      return {
        label: pending === 'claim' ? 'Claiming…' : `Claim ${formatToken(config.claimAmount)} NOTIT`,
        sub: null,
        hint: null,
        disabled: pending !== null,
        action: 'claim',
      };
    }
    return { label: "I'll do it", sub: null, hint: 'No NOTIT left.', disabled: true, action: null };
  }
  if (s.saved) return { label: s.hero === me ? 'You did it' : 'Saved this round', sub: null, hint: null, disabled: true, action: null };
  if (s.roundSupply === 0n) return { label: 'Nothing to save yet', sub: null, hint: null, disabled: true, action: null };
  if (account.balance < live.cost) {
    // When does the falling cost reach this balance?
    const needPpm = Number((account.balance * 1_000_000n) / s.roundSupply);
    let hint = 'Costs more than you hold.';
    if (needPpm >= config.minCostPpm + 1) {
      const span = config.maxCostPpm - config.minCostPpm;
      const at = span > 0 ? (config.maxCostPpm - needPpm) / span : 0;
      const roundMs = Number(config.roundNs / 1_000_000n);
      hint = `Within reach at ${formatCountdown((1 - at) * roundMs)} left.`;
    }
    return { label: "I'll do it", sub: null, hint, disabled: true, action: null };
  }
  return {
    label: pending === 'volunteer' ? 'Doing it…' : "I'll do it",
    sub: `burn ${amount(live.cost)} · ${account.isIt ? 'already It' : 'become It'}`,
    hint: null,
    disabled: pending !== null,
    action: 'volunteer',
  };
}

interface Props {
  game: Game;
  snap: GameSnapshot;
  /** Set in Testnet mode. */
  chain: ChainUi | null;
  flash: RoundClose | null;
  /** How many faces to draw in the crowd. */
  heads: number;
}

export function HeroSlab({ game, snap, chain, flash, heads }: Props) {
  const live = useLive(game);
  const { state: s, config, accountId: me } = snap;
  const save = s.saved ? currentSave(snap) : null;
  const cta = ctaFor(snap, live, game.pending);
  const countdownText = formatCountdown(live.msLeft);
  const nothingToSave = s.roundSupply === 0n;

  // Screen readers: one polite sentence when the round or its state changes,
  // and otherwise at most every ten seconds.
  const [spoken, setSpoken] = useState('');
  const latest = useRef({ snap, live });
  latest.current = { snap, live };
  useEffect(() => {
    const say = () => setSpoken(spokenStatus(latest.current.snap, latest.current.live));
    say();
    const t = window.setInterval(say, 10_000);
    return () => window.clearInterval(t);
  }, [s.round, s.saved]);

  // One state line. The hot seat says who is It and the outcomes say what is at stake.
  let stateLine: ReactNode;
  if (s.roundSupply === 0n) {
    stateLine = 'No tokens in play yet.';
  } else if (s.saved && s.hero) {
    stateLine = (
      <>
        Saved by <Who id={s.hero} me={me} />.
      </>
    );
  } else if (s.it && !s.armed && s.collapseRun >= config.maxCollapseRun) {
    stateLine = 'The game is asleep.';
  } else {
    stateLine = 'Nobody has stepped up.';
  }

  // Testnet with nobody signed in (or a guest sign-up under way): show the sign-in block.
  const guestStatus = chain?.state.guest.status;
  const signUp = chain !== null && (!me || guestStatus === 'running' || guestStatus === 'error');

  const onCta = () => {
    if (cta.action === 'claim') void game.claim();
    else if (cta.action === 'volunteer') void game.volunteer({ round: s.round, maxCost: maxCostFor(live.cost) });
  };

  return (
    <section
      className={cls('slab', s.saved && 'slab--saved', flash && `slab--flash-${flash.kind}`)}
      aria-labelledby="round-heading"
    >
      <Ticker snap={snap} flash={flash} />

      <div className="slab__body">
        <div className="slab__clock">
          <h2 id="round-heading" className="slab__round">
            Round <span>{s.round.toLocaleString('en-US')}</span>
          </h2>
          <div
            className={cls(
              'countdown',
              countdownText.length >= 7 ? 'countdown--xlong' : countdownText.length >= 5 && 'countdown--long',
              !s.saved && live.progress > 0.85 && s.roundSupply > 0n && 'countdown--late',
            )}
            aria-hidden="true"
          >
            <Digits text={countdownText} />
          </div>
          <p className="sr-only" role="status" aria-live="polite">
            {spoken}
          </p>
          <p className="slab__state">{stateLine}</p>
        </div>

        <div className="slab__act">
          <div className="cost">
            <span className="cost__label">{s.saved ? 'Burned' : 'Cost now'}</span>
            {s.saved ? (
              <span className="cost__value cost__value--done">{save ? <Digits text={amount(save.cost)} /> : '—'} <small>NOTIT</small></span>
            ) : nothingToSave ? (
              <span className="cost__value">—</span>
            ) : (
              <span className="cost__value">
                <Digits text={amount(live.cost)} /> <small>NOTIT</small>
              </span>
            )}
          </div>

          {signUp && chain ? (
            <GuestStart chain={chain} claimAmount={config.claimAmount} />
          ) : (
            <>
              <button type="button" className={cls('cta', s.saved && s.hero === me && 'cta--stamp')} disabled={cta.disabled} onClick={onCta}>
                <span className="cta__label">{cta.label}</span>
                {cta.sub && <span className="cta__sub">{cta.sub}</span>}
              </button>
              {game.notice ? (
                <p className={cls('cta__hint', game.notice.gentle ? 'cta__hint--note' : 'cta__hint--warn')} role="alert">
                  {game.notice.text}{' '}
                  <button type="button" className="linkbtn" onClick={game.dismissNotice}>
                    OK
                  </button>
                </p>
              ) : (
                cta.hint && <p className="cta__hint">{cta.hint}</p>
              )}
              {chain && !game.pending && game.lastTx && (
                <TxLink
                  chain={chain}
                  hash={game.lastTx.hash}
                  label={game.lastTx.ok ? (game.lastTx.action === 'claim' ? 'Claimed' : 'Confirmed') : 'Refused'}
                />
              )}
              {chain && !game.pending && !game.lastTx && chain.state.guest.claimTx && (
                <TxLink chain={chain} hash={chain.state.guest.claimTx} label="Claimed" />
              )}
            </>
          )}
        </div>

        <Heads count={heads} hasIt={s.it !== null} round={s.round} />
        <CostCurve
          progress={live.progress}
          maxPpm={config.maxCostPpm}
          minPpm={config.minCostPpm}
          saved={s.saved}
          now={s.saved || nothingToSave ? null : amount(live.cost)}
        />
      </div>

      <Outcomes snap={snap} live={live} />
    </section>
  );
}
