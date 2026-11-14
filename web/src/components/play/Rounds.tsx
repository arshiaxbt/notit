import { useMemo, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { CrowdMember, HistoryEntry } from '../../client/types';
import type { GameSnapshot } from '../../hooks/useGame';
import { formatCountdown, formatInt, formatPpm, formatToken } from '../../lib/format';
import { Card, Who, cls } from '../ui';

function amount(v: bigint): string {
  return formatToken(v, { maxFrac: 2, fixed: true });
}

type Cell =
  | { round: number; kind: 'saved'; hero: string; cost: bigint; msLeft: number }
  | { round: number; kind: 'collapsed'; it: string }
  | { round: number; kind: 'dormant' };

const STRIP = 40;

/** Expands history entries into one cell per round for the last `count` closed rounds. */
export function lastRounds(history: HistoryEntry[], currentRound: number, count: number): Cell[] {
  const byRound = new Map<number, Cell>();
  for (const e of history) {
    if (e.kind === 'saved') byRound.set(e.round, { round: e.round, kind: 'saved', hero: e.hero, cost: e.cost, msLeft: e.msLeft });
    else for (let r = e.firstRound; r <= e.lastRound; r++) byRound.set(r, { round: r, kind: 'collapsed', it: e.it });
  }
  const cells: Cell[] = [];
  for (let r = Math.max(1, currentRound - count); r < currentRound; r++) {
    cells.push(byRound.get(r) ?? { round: r, kind: 'dormant' });
  }
  return cells;
}

export function RoundStrip({ snap }: { snap: GameSnapshot }) {
  const { state: s, config, accountId: me } = snap;
  const cells = useMemo(() => lastRounds(snap.history, s.round, STRIP), [snap.history, s.round]);
  const [picked, setPicked] = useState<number | null>(null);
  const saved = cells.filter((c) => c.kind === 'saved').length;
  const collapsed = cells.filter((c) => c.kind === 'collapsed').length;
  const active = picked !== null ? cells.find((c) => c.round === picked) ?? null : null;
  const cutPct = formatPpm(config.cutPpm);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (cells.length === 0) return;
    const first = cells[0]!.round;
    const lastR = cells[cells.length - 1]!.round;
    if (e.key === 'ArrowLeft') setPicked((p) => Math.max(first, (p ?? lastR + 1) - 1));
    else if (e.key === 'ArrowRight') setPicked((p) => Math.min(lastR, (p ?? first - 1) + 1));
    else if (e.key === 'Escape') setPicked(null);
    else return;
    e.preventDefault();
  };

  let caption: string;
  if (!active) {
    caption = cells.length === 0 ? 'No rounds have closed yet.' : 'Point at a round, or use the arrow keys, for details.';
  } else if (active.kind === 'saved') {
    const who = active.hero === me ? 'you' : active.hero;
    caption = `Round ${formatInt(active.round)}: saved by ${who} with ${formatCountdown(active.msLeft)} left, burning ${amount(active.cost)} NOTIT.`;
  } else if (active.kind === 'collapsed') {
    const who = active.it === me ? 'you' : active.it;
    caption = `Round ${formatInt(active.round)}: nobody did it. Everyone paid ${cutPct} to ${who}.`;
  } else {
    caption = `Round ${formatInt(active.round)}: unsaved, nothing charged.`;
  }

  return (
    <Card
      labelId="strip-title"
      className="strip"
      title={`Last ${cells.length || STRIP} rounds`}
      aside={
        <ul className="legend" aria-label="Legend">
          <li>
            <span className="legend__swatch legend__swatch--saved" aria-hidden="true" /> Saved <b>{saved}</b>
          </li>
          <li>
            <span className="legend__swatch legend__swatch--collapsed" aria-hidden="true" /> Unsaved, everyone paid It <b>{collapsed}</b>
          </li>
        </ul>
      }
    >
      <div
        className="strip__cells"
        role="group"
        tabIndex={0}
        aria-label={`Last ${cells.length} rounds, oldest first: ${saved} saved, ${collapsed} unsaved and charged. Use the left and right arrow keys to step through rounds.`}
        onKeyDown={onKey}
        onMouseLeave={() => setPicked(null)}
        onBlur={() => setPicked(null)}
      >
        {cells.map((c) => (
          <span
            key={c.round}
            className={cls('strip__cell', `strip__cell--${c.kind}`, picked === c.round && 'is-picked')}
            onMouseEnter={() => setPicked(c.round)}
            onClick={() => setPicked(c.round)}
          />
        ))}
        <span className={cls('strip__cell', 'strip__cell--live', s.saved && 'strip__cell--live-saved')} title={`Round ${s.round}, in play`} />
      </div>
      <p className="strip__caption" aria-live="polite">
        {caption}
      </p>
    </Card>
  );
}

/** Everyone who has ever volunteered: what they burned and what they collected as It. */
export function HeroWall({ snap, crowd }: { snap: GameSnapshot; crowd: CrowdMember[] | null }) {
  const { heroes, accountId: me, state: s } = snap;
  const strategyOf = useMemo(() => new Map((crowd ?? []).map((c) => [c.accountId, c.strategy])), [crowd]);
  const rows = useMemo(
    () =>
      [...heroes]
        .sort((a, b) => b.saves - a.saves || (a.burned > b.burned ? -1 : a.burned < b.burned ? 1 : 0))
        .slice(0, 8),
    [heroes],
  );

  return (
    <Card labelId="wall-title" className="wall" title="Hero wall" aside={<span className="card__note">{formatInt(heroes.length)} have done it</span>}>
      {rows.length === 0 ? (
        <p className="empty">Nobody has volunteered yet. The first name on this wall could be yours.</p>
      ) : (
        <div className="tablewrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Hero</th>
                <th scope="col" className="num">
                  Saves
                </th>
                <th scope="col" className="num">
                  Burned
                </th>
                <th scope="col" className="num">
                  Collected
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((h) => (
                <tr key={h.accountId} className={cls(h.accountId === me && 'is-me')}>
                  <th scope="row">
                    <Who id={h.accountId} me={me} />
                    {s.it === h.accountId && <span className="tag tag--it">It</span>}
                    {strategyOf.has(h.accountId) && <span className="table__sub">{strategyOf.get(h.accountId)}</span>}
                  </th>
                  <td className="num">{formatInt(h.saves)}</td>
                  <td className="num">{amount(h.burned)}</td>
                  <td className={cls('num', h.collected > h.burned && 'is-up')}>{amount(h.collected)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/** The most recent history entries, newest first. */
export function RoundLog({ snap }: { snap: GameSnapshot }) {
  const { accountId: me, config } = snap;
  const recent = useMemo(() => snap.history.slice(-7).reverse(), [snap.history]);
  return (
    <Card labelId="log-title" className="log" title="What just happened">
      {recent.length === 0 ? (
        <p className="empty">Nothing yet. The log fills as rounds close.</p>
      ) : (
        <ol className="log__list">
          {recent.map((e) =>
            e.kind === 'saved' ? (
              <li key={`s${e.round}`} className="log__item log__item--saved">
                <span className="log__round">#{formatInt(e.round)}</span>
                <span className="log__text">
                  <b>
                    <Who id={e.hero} me={me} />
                  </b>{' '}
                  did it with {formatCountdown(e.msLeft)} left
                </span>
                <span className="log__amt">burned {amount(e.cost)}</span>
              </li>
            ) : (
              <li key={`c${e.firstRound}`} className="log__item log__item--collapsed">
                <span className="log__round">
                  #{formatInt(e.firstRound)}
                  {e.count > 1 ? `–${formatInt(e.lastRound)}` : ''}
                </span>
                <span className="log__text">
                  Nobody did it{e.count > 1 ? `, ${e.count} rounds running` : ''}. Everyone paid {formatPpm(config.cutPpm)}
                  {e.count > 1 ? ' each time' : ''}
                </span>
                <span className="log__amt">
                  <b>
                    <Who id={e.it} me={me} />
                  </b>{' '}
                  collected {amount(e.paid)}
                </span>
              </li>
            ),
          )}
        </ol>
      )}
    </Card>
  );
}

/** Demo mode only: the simulated holders and the strategy each one follows. */
export function Crowd({ crowd, totalSupply }: { crowd: CrowdMember[]; totalSupply: bigint }) {
  const strategies = useMemo(() => {
    const seen = new Map<string, string>();
    for (const c of crowd) if (!seen.has(c.strategy)) seen.set(c.strategy, c.blurb);
    return [...seen.entries()];
  }, [crowd]);
  const sorted = useMemo(() => [...crowd].sort((a, b) => (a.balance > b.balance ? -1 : a.balance < b.balance ? 1 : 0)), [crowd]);
  const top = sorted[0]?.balance ?? 0n;

  return (
    <Card
      labelId="crowd-title"
      className="crowd"
      title="The crowd"
      aside={<span className="card__note">{crowd.length} simulated holders, each with one strategy</span>}
    >
      <ul className="crowd__list">
        {sorted.map((c) => (
          <li key={c.accountId} className={cls('bot', c.isIt && 'bot--it')}>
            <span className="bot__name">
              {c.accountId}
              {c.isIt && <span className="tag tag--it">It</span>}
            </span>
            <span className="bot__strategy">{c.strategy}</span>
            <span className="bot__bar" aria-hidden="true">
              <span style={{ width: `${top > 0n ? Math.max(2, Number((c.balance * 100n) / top)) : 0}%` }} />
            </span>
            <span className="bot__nums">
              {formatToken(c.balance, { maxFrac: 0 })} NOTIT
              {totalSupply > 0n ? ` · ${Number((c.balance * 1000n) / totalSupply) / 10}%` : ''} · {c.saves} {c.saves === 1 ? 'save' : 'saves'}
            </span>
          </li>
        ))}
      </ul>
      <details className="crowd__key">
        <summary>What each strategy does</summary>
        <dl>
          {strategies.map(([n, blurb]) => (
            <div key={n}>
              <dt>{n}</dt>
              <dd>{blurb}</dd>
            </div>
          ))}
        </dl>
        <p>Whoever is It sits still: It collects when the crowd fails, so paying again would only cost them.</p>
      </details>
    </Card>
  );
}
