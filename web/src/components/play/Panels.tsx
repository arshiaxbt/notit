import type { ReactNode } from 'react';
import type { Mode } from '../Header';
import type { GameSnapshot, RoundClose } from '../../hooks/useGame';
import { itCollects } from '../../lib/cost';
import { formatCompact, formatInt, formatPpm, formatShare, formatTimeLeft, formatToken } from '../../lib/format';
import { Amount, Card, Who, cls } from '../ui';

function amount(v: bigint): string {
  return formatToken(v, { maxFrac: 2, fixed: true });
}

/** Round in which `id` last volunteered, from the history window. */
function becameItIn(snap: GameSnapshot, id: string): number | null {
  for (let i = snap.history.length - 1; i >= 0; i--) {
    const e = snap.history[i]!;
    if (e.kind === 'saved') return e.hero === id ? e.round : null;
  }
  return null;
}

/** Who is It, what they have collected, and how many unsaved rounds have been charged. */
export function Throne({ snap, flash }: { snap: GameSnapshot; flash: RoundClose | null }) {
  const { state: s, config, accountId: me, itAccount } = snap;
  const max = config.maxCollapseRun;
  const run = Math.min(s.collapseRun, max);
  const cutPct = formatPpm(config.cutPpm);
  const since = s.it ? becameItIn(snap, s.it) : null;
  const gain = s.it && itAccount ? itCollects(s.totalSupply, itAccount.balance, config.cutPpm) : 0n;
  const paidNow = flash?.kind === 'collapsed';

  let note: ReactNode;
  if (!s.it) note = 'The first person to volunteer becomes It. Until then nothing is charged.';
  else if (s.saved)
    note = `Safe this round. ${s.it === me ? 'You collect' : 'Collects'} ${cutPct} of every other balance if the next round ends unsaved.`;
  else if (run >= max) note = `The game is asleep: ${max} rounds were charged in a row, so nothing more is charged until someone volunteers.`;
  else
    note = (
      <>
        If this round ends unsaved: {s.it === me ? 'you collect' : 'collects'} about <b>{amount(gain)} NOTIT</b>, {cutPct} of
        everyone else.
      </>
    );

  return (
    <Card
      labelId="throne-title"
      className={cls('throne', paidNow && 'throne--paid', s.it !== null && s.it === me && 'throne--me')}
      title="Who is It"
      aside={<span className="throne__badge">It</span>}
    >
      {s.it ? (
        <>
          <p className="throne__who">
            <Who id={s.it} me={me} />
            <span className="throne__verb">{s.it === me ? ' are It' : ' is It'}</span>
          </p>
          <p className="throne__since">
            {since !== null ? `The last one who did it, in round ${formatInt(since)}.` : 'The last one who did it.'}
          </p>
          <dl className="kv">
            <div>
              <dt>Collected so far</dt>
              <dd>
                <Amount key={s.it} value={itAccount?.collected ?? 0n} /> <small>NOTIT</small>
              </dd>
            </div>
            <div>
              <dt>Burned to get here</dt>
              <dd>
                {amount(itAccount?.burned ?? 0n)} <small>NOTIT</small>
              </dd>
            </div>
          </dl>
        </>
      ) : (
        <p className="throne__who throne__who--empty">Nobody is It yet</p>
      )}
      <p className="throne__note">{note}</p>
      {run > 0 && (
        <div className="run" role="img" aria-label={`Unsaved rounds charged in a row: ${run} of ${max}`}>
          <span className="run__label">
            Unsaved in a row: charged <b>{run}</b> of {max}
          </span>
          <span className="run__pips" aria-hidden="true">
            {Array.from({ length: max }, (_, i) => (
              <span key={i} className={cls('run__pip', i < run && 'run__pip--on')} />
            ))}
          </span>
        </div>
      )}
    </Card>
  );
}

/** The viewer's own account. */
export function You({ snap, flash, mode }: { snap: GameSnapshot; flash: RoundClose | null; mode: Mode }) {
  const { account, accountId, state: s, config } = snap;
  const balance = account?.balance ?? 0n;
  const delta =
    flash && flash.balanceBefore !== null && flash.balanceAfter !== null ? flash.balanceAfter - flash.balanceBefore : 0n;
  const net = (account?.collected ?? 0n) - (account?.burned ?? 0n);
  // No row of zeros before there is anything to count.
  const played = !!account && (account.claimed || account.balance > 0n || account.saves > 0);

  return (
    <Card
      labelId="you-title"
      className="you"
      title="You"
      aside={accountId ? <span className="chip">{mode === 'demo' ? 'demo account' : accountId}</span> : null}
    >
      {!accountId || !account ? (
        <p className="you__empty">
          Not signed in. Watching needs no account. To play, use “Play as guest” or connect a wallet.
        </p>
      ) : (
        <>
          <p className="you__balance">
            <Amount value={balance} />
            <small>NOTIT</small>
            {delta !== 0n && (
              <span className={cls('delta', delta < 0n ? 'delta--down' : 'delta--up')} key={flash?.id}>
                {delta > 0n ? '+' : '−'}
                {amount(delta < 0n ? -delta : delta)}
              </span>
            )}
          </p>
          <p className="you__share">
            {balance > 0n
              ? `${formatShare(balance, s.totalSupply)} of the supply${account.isIt ? ' · you are It' : ''}`
              : account.claimed
                ? 'Nothing left.'
                : `Nothing yet. Claim ${formatToken(config.claimAmount)} NOTIT to play.`}
          </p>
          {played && (
            <dl className="kv kv--3">
              <div>
                <dt>Saves</dt>
                <dd>{formatInt(account.saves)}</dd>
              </div>
              <div>
                <dt>You burned</dt>
                <dd>{amount(account.burned)}</dd>
              </div>
              <div>
                <dt>You collected</dt>
                <dd>{amount(account.collected)}</dd>
              </div>
            </dl>
          )}
          {(account.saves > 0 || account.collected > 0n) && (
            <p className="you__net">
              Volunteering has {net >= 0n ? 'made' : 'cost'} you {amount(net < 0n ? -net : net)} NOTIT so far.
            </p>
          )}
        </>
      )}
    </Card>
  );
}

function Stat({ label, value, unit, note }: { label: string; value: ReactNode; unit?: string; note?: ReactNode }) {
  return (
    <li className="stat">
      <span className="stat__label">{label}</span>
      <span className="stat__value">
        {value}
        {unit && <small> {unit}</small>}
      </span>
      {note && <span className="stat__note">{note}</span>}
    </li>
  );
}

export function Stats({ snap }: { snap: GameSnapshot }) {
  const st = snap.state.stats;
  return (
    <section aria-label="Game statistics">
      <ul className="stats">
        <Stat
          label="Survival streak"
          value={formatInt(st.currentStreak)}
          unit={st.currentStreak === 1 ? 'round' : 'rounds'}
          note={`Longest: ${formatInt(st.longestStreak)}`}
        />
        <Stat
          label="Closest call"
          value={st.closestCallMs === null ? '—' : formatTimeLeft(st.closestCallMs)}
          note="least time left at a save"
        />
        <Stat label="Burned by volunteers" value={formatCompact(st.totalBurned)} unit="NOTIT" note={`${formatInt(st.roundsSaved)} saves`} />
        <Stat
          label="Paid to It"
          value={formatCompact(st.totalPaid)}
          unit="NOTIT"
          note={`${formatInt(st.roundsCollapsed)} unsaved rounds charged`}
        />
      </ul>
    </section>
  );
}
