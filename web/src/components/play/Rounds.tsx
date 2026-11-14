import { useMemo, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { HistoryEntry } from '../../client/types';
import type { GameSnapshot } from '../../hooks/useGame';
import { formatCountdown, formatInt, formatToken, shortAccount } from '../../lib/format';
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
  const { state: s, accountId: me } = snap;
  const cells = useMemo(() => lastRounds(snap.history, s.round, STRIP), [snap.history, s.round]);
  const [picked, setPicked] = useState<number | null>(null);
  const saved = cells.filter((c) => c.kind === 'saved').length;
  const collapsed = cells.filter((c) => c.kind === 'collapsed').length;
  const asleep = cells.filter((c) => c.kind === 'dormant').length;
  const active = picked !== null ? cells.find((c) => c.round === picked) ?? null : null;
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

  // A picked round reads like a line of the log. Nothing is shown until one is picked;
  // how to pick is said to assistive technology in the group's label, not on screen.
  let caption = '';
  if (active?.kind === 'saved') {
    caption = `#${formatInt(active.round)} saved by ${active.hero === me ? 'you' : shortAccount(active.hero)} · ${formatCountdown(active.msLeft)} left · burned ${amount(active.cost)}`;
  } else if (active?.kind === 'collapsed') {
    caption = `#${formatInt(active.round)} unsaved · paid to ${active.it === me ? 'you' : shortAccount(active.it)}`;
  } else if (active) {
    caption = `#${formatInt(active.round)} unsaved · asleep`;
  }

  return (
    <Card
      labelId="strip-title"
      className="strip"
      title={`Round ${formatInt(s.round)}`}
      aside={
        <ul className="legend" aria-label="Legend">
          <li>
            <span className="legend__swatch legend__swatch--saved" aria-hidden="true" /> Saved <b>{saved}</b>
          </li>
          <li>
            <span className="legend__swatch legend__swatch--collapsed" aria-hidden="true" /> Unsaved <b>{collapsed}</b>
          </li>
          {asleep > 0 && (
            <li>
              <span className="legend__swatch legend__swatch--asleep" aria-hidden="true" /> Asleep <b>{asleep}</b>
            </li>
          )}
        </ul>
      }
    >
      <div
        className="strip__cells"
        role="group"
        tabIndex={0}
        title="Point at a round for details"
        aria-label={`Last ${cells.length} rounds, oldest first: ${saved} saved, ${collapsed} unsaved and paid to It, ${asleep} unsaved while asleep. Use the left and right arrow keys to step through rounds.`}
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
export function HeroWall({ snap }: { snap: GameSnapshot }) {
  const { heroes, accountId: me } = snap;
  const rows = useMemo(
    () =>
      [...heroes]
        .sort((a, b) => b.saves - a.saves || (a.burned > b.burned ? -1 : a.burned < b.burned ? 1 : 0))
        .slice(0, 8),
    [heroes],
  );

  return (
    <Card labelId="wall-title" className="wall" title="Who volunteered">
      {rows.length === 0 ? (
        <p className="empty">Nobody yet.</p>
      ) : (
        <div className="tablewrap" tabIndex={0} role="region" aria-label="Table of who volunteered">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">
                  <span className="sr-only">Hero</span>
                </th>
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
