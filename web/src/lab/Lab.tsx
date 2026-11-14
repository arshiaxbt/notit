import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { FAST } from '@notit/engine';
import type { MixedCrowdResult, WhoPaysResult } from '@notit/engine';
import { XYChart } from '../components/charts/XYChart';
import type { Tick } from '../components/charts/XYChart';
import { Card, cls } from '../components/ui';
import { formatInt, formatPpm, formatToken } from '../lib/format';
import { PRESETS, SWEEP, nobodyPaysFrom, theoryFailure } from './jobs';
import type { BystanderPreset, BystanderRow, PathResult } from './jobs';
import { runInBackground } from './runner';

type Experiment = 'bystander' | 'whoPays' | 'mixed';

const EXPERIMENTS: Array<{ id: Experiment; label: string; sub: string }> = [
  { id: 'bystander', label: 'Bystander effect', sub: 'Bigger crowd, fewer volunteers' },
  { id: 'whoPays', label: 'Who pays', sub: 'Whales and small holders' },
  { id: 'mixed', label: 'Mixed crowd', sub: 'The idle get taxed' },
];

function pct(x: number, digits = 1): string {
  const v = x * 100;
  if (v > 0 && v < 0.05) return '<0.1%';
  return `${v.toFixed(digits).replace(/\.0+$/, '')}%`;
}

/** A difference between two shares, in percentage points. */
function gap(d: number): string {
  const pts = Math.abs(d * 100);
  if (pts < 0.05) return '0.0 pts';
  return `${d > 0 ? '+' : '−'}${pts.toFixed(1)} pts`;
}

function tokens(v: bigint): string {
  return formatToken(v, { maxFrac: 0 });
}

function Figure({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) {
  return (
    <li className="stat">
      <span className="stat__label">{label}</span>
      <span className="stat__value">{value}</span>
      {note && <span className="stat__note">{note}</span>}
    </li>
  );
}

function Slider({
  id,
  label,
  value,
  display,
  min,
  max,
  step = 1,
  help,
  onChange,
  valueText,
}: {
  id: string;
  label: string;
  value: number;
  display: string;
  min: number;
  max: number;
  step?: number;
  help?: string;
  onChange(v: number): void;
  valueText?: string;
}) {
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        <span>{label}</span>
        <span className="field__value">{display}</span>
      </label>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-valuetext={valueText ?? display}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {help && <span className="field__help">{help}</span>}
    </div>
  );
}

function Select<T extends string | number>({
  id,
  label,
  value,
  options,
  help,
  onChange,
}: {
  id: string;
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  help?: string;
  onChange(v: T): void;
}) {
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        <span>{label}</span>
      </label>
      <select
        id={id}
        value={String(value)}
        onChange={(e) => {
          const picked = options.find((o) => String(o.value) === e.target.value);
          if (picked) onChange(picked.value);
        }}
      >
        {options.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
      {help && <span className="field__help">{help}</span>}
    </div>
  );
}

function Status({ running, progress, error }: { running: boolean; progress?: number; error: string | null }) {
  return (
    <div className="controls__status" role="status" aria-live="polite">
      {error ? (
        `Something went wrong: ${error}`
      ) : running ? (
        <>
          Simulating in the background…
          {progress !== undefined && (
            <div className="progress" aria-hidden="true">
              <span style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
          )}
        </>
      ) : (
        'Done. Runs the real rules engine, in your browser.'
      )}
    </div>
  );
}

/* ------------------------------------------------------------ A. bystander */

// The crowd-size slider is logarithmic: most of the action is below 100.
const N_MIN = 2;
const N_MAX = 300;
const SLIDER_STEPS = 200;
function nFromSlider(t: number): number {
  return Math.round(N_MIN * Math.pow(N_MAX / N_MIN, t / SLIDER_STEPS));
}
function sliderFromN(n: number): number {
  return Math.round((Math.log(n / N_MIN) / Math.log(N_MAX / N_MIN)) * SLIDER_STEPS);
}

const N_TICKS: Tick[] = [2, 5, 10, 20, 50, 100, 300].map((v) => ({ v, label: String(v) }));
const PCT_TICKS: Tick[] = [0, 0.25, 0.5, 0.75, 1].map((v) => ({ v, label: `${v * 100}%` }));
const THEORY_POINTS = Array.from({ length: N_MAX - N_MIN + 1 }, (_, i) => ({ x: i + N_MIN, y: theoryFailure(i + N_MIN) }));

/** Round tick values covering [min, max] with about four steps. */
function niceTicks(min: number, max: number): number[] {
  if (!(max > min)) {
    const pad = Math.max(1, Math.abs(min) * 0.01);
    min -= pad;
    max += pad;
  }
  const raw = (max - min) / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = ([1, 2, 2.5, 5, 10].find((m) => raw <= m * mag) ?? 10) * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 1000) / 1000);
  return ticks;
}

function Bystander() {
  // The slider position is the state, and the crowd size follows from it. (Deriving the
  // position from the size instead would trap the arrow keys wherever one step of the
  // slider rounds to the same size.)
  const [pos, setPos] = useState(() => sliderFromN(20));
  const n = nFromSlider(pos);
  const [trials, setTrials] = useState(500);
  const [preset, setPreset] = useState<BystanderPreset>('equilibrium');
  const [seed, setSeed] = useState(1001);
  const [rows, setRows] = useState<BystanderRow[]>([]);
  const [path, setPath] = useState<PathResult | null>(null);
  const [running, setRunning] = useState(true);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const cache = useRef(new Map<string, BystanderRow>());

  useEffect(() => {
    let cancelled = false;
    const key = `${preset}|${trials}|${seed}`;
    const ns = [...new Set([...SWEEP, n])].sort((a, b) => a - b);
    const have = () => ns.filter((x) => cache.current.has(`${key}|${x}`)).map((x) => cache.current.get(`${key}|${x}`)!);
    // The chosen crowd size first, so its number appears quickly.
    const missing = ns.filter((x) => !cache.current.has(`${key}|${x}`)).sort((a, b) => (a === n ? -1 : b === n ? 1 : a - b));
    setRows(have());
    setRunning(true);
    setError(null);
    setProgress((ns.length - missing.length) / (ns.length + 1));

    const timer = window.setTimeout(async () => {
      try {
        let done = ns.length - missing.length;
        for (const x of missing) {
          if (cancelled) return;
          const row = await runInBackground({ kind: 'row', n: x, trials, preset, seed });
          cache.current.set(`${key}|${x}`, row);
          done += 1;
          if (cancelled) return;
          setRows(have());
          setProgress(done / (ns.length + 1));
        }
        const p = await runInBackground({ kind: 'path', n, rounds: trials, preset, seed });
        if (cancelled) return;
        setPath(p);
        setProgress(1);
        setRunning(false);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setRunning(false);
        }
      }
    }, 160);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [n, trials, preset, seed]);

  const picked = rows.find((r) => r.n === n) ?? null;
  const limit = nobodyPaysFrom();
  const snapXs = useMemo(() => rows.map((r) => r.n), [rows]);
  const pathReady = path !== null && path.n === n;
  const supplyTicks = useMemo(() => {
    if (!path || path.points.length === 0) return [0, 1];
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of path.points) {
      if (p.supply < lo) lo = p.supply;
      if (p.supply > hi) hi = p.supply;
    }
    return niceTicks(lo, hi);
  }, [path]);
  const firstDormant = path?.points.find((p) => p.outcome === 'dormant')?.round ?? null;
  const roundTicks: Tick[] = useMemo(() => {
    const r = path?.rounds ?? trials;
    return [1, r / 4, r / 2, (3 * r) / 4, r].map((v) => ({ v: Math.max(1, Math.round(v)), label: formatInt(Math.max(1, Math.round(v))) }));
  }, [path, trials]);

  let reading: ReactNode;
  if (!picked) {
    reading = <p>Running the first rounds…</p>;
  } else if (preset === 'equilibrium') {
    reading = (
      <>
        <p>
          With <b>{n} people</b> who could do it, nobody did in <b>{pct(picked.simulated)}</b> of {formatInt(picked.trials)}{' '}
          rounds. The theory says {pct(picked.theory)}.
        </p>
        <p>
          Each extra person is one more who might step up, but everyone knows that, and leans on the others a little
          more. The cost is also a share of the whole supply, so it grows against each person’s own stake. From about{' '}
          {limit} players, the cheapest possible save costs more than a collapse would take from any one of them, and
          nobody volunteers at all.
        </p>
      </>
    );
  } else if (preset === 'snipers') {
    reading = (
      <>
        <p>
          With <b>{n} snipers</b>, nobody saved the round in <b>{pct(picked.simulated)}</b> of {formatInt(picked.trials)}{' '}
          rounds.
        </p>
        <p>
          Here everyone always tries, so a round only fails when every single try lands late. More people makes that less
          likely: the opposite of the theory curve, which assumes people hold back because others might act.
        </p>
      </>
    );
  } else if (preset === 'altruists') {
    reading = (
      <>
        <p>
          With <b>{n} occasional altruists</b>, nobody stepped up in <b>{pct(picked.simulated)}</b> of{' '}
          {formatInt(picked.trials)} rounds.
        </p>
        <p>
          If people act on habit instead of weighing the others, a bigger crowd is simply safer. The dots fall where the
          theory line rises. The bystander effect needs people who reason about each other.
        </p>
      </>
    );
  } else {
    reading = (
      <>
        <p>
          With <b>{n} {preset === 'throne' ? 'throne-aware players' : 'rule followers'}</b>, nobody saved the round in{' '}
          <b>{pct(picked.simulated)}</b> of {formatInt(picked.trials)} rounds.
        </p>
        <p>
          These players do not gamble on each other. The first one for whom the falling cost is worth it pays, every
          time, so there is no gradual bystander effect: only a cliff where the crowd is so large that the cost is never
          worth it to anyone
          {preset === 'throne' ? ', and it comes later because being It has value too.' : ` (about ${limit} players).`}
        </p>
      </>
    );
  }

  return (
    <div className="lab__grid">
      <Card labelId="by-controls" title="Set up the crowd" className="controls">
        <Slider
          id="by-n"
          label="Crowd size"
          value={pos}
          display={`${n}`}
          valueText={`${n} players`}
          min={0}
          max={SLIDER_STEPS}
          onChange={setPos}
          help="Players who could volunteer, 2 to 300. One more account is already It and sits still."
        />
        <Select<number>
          id="by-trials"
          label="Rounds to simulate"
          value={trials}
          options={[200, 500, 1000, 2000].map((v) => ({ value: v, label: `${formatInt(v)} rounds per crowd size` }))}
          onChange={setTrials}
          help="More rounds, less noise, a little more waiting."
        />
        <Select<BystanderPreset>
          id="by-preset"
          label="How the crowd behaves"
          value={preset}
          options={(Object.keys(PRESETS) as BystanderPreset[]).map((k) => ({ value: k, label: PRESETS[k].label }))}
          onChange={setPreset}
          help={PRESETS[preset].blurb}
        />
        <button type="button" className="btn btn--ghost" onClick={() => setSeed((s) => s + 97)}>
          Shuffle the dice
        </button>
        <Status running={running} progress={progress} error={error} />
      </Card>

      <div className="lab__results">
        <div className="reading">
          <h3>What this shows</h3>
          {reading}
        </div>

        <Card labelId="by-chart" title="Rounds nobody saved, by crowd size">
          <XYChart
            ariaLabel={`Share of rounds nobody saved against crowd size, simulated and theory. At ${n} players: simulated ${picked ? pct(picked.simulated) : 'pending'}, theory ${pct(theoryFailure(n))}.`}
            series={[
              { id: 'theory', label: 'Theory (volunteer’s dilemma)', kind: 'line', points: THEORY_POINTS },
              { id: 'sim', label: `Simulated, ${PRESETS[preset].label.toLowerCase()}`, kind: 'dots', points: rows.map((r) => ({ x: r.n, y: r.simulated })) },
            ]}
            xDomain={[N_MIN, N_MAX]}
            yDomain={[0, 1]}
            xLog
            xTicks={N_TICKS}
            yTicks={PCT_TICKS}
            xLabel="Crowd size (players, log scale)"
            yLabel="Rounds nobody saved"
            pickX={n}
            pickLabel={`${n} players`}
            snapXs={snapXs}
            busy={running && rows.length === 0}
            tip={(x) => {
              const r = rows.find((row) => row.n === x);
              if (!r) return null;
              return {
                title: `${r.n} players`,
                rows: [
                  ['simulated', pct(r.simulated)],
                  ['theory', pct(r.theory)],
                ],
              };
            }}
          />
        </Card>

        <Card
          labelId="by-path"
          title={`Supply over ${formatInt(path?.rounds ?? trials)} rounds in a row, ${path?.n ?? n} players`}
          aside={
            <ul className="legend">
              <li>
                <span className="legend__swatch legend__swatch--collapsed" aria-hidden="true" /> Unsaved, paid to It
              </li>
              <li>
                <span className="legend__swatch" style={{ height: 6, background: 'var(--muted)' }} aria-hidden="true" /> Unsaved,
                dormant
              </li>
            </ul>
          }
        >
          {path ? (
            <>
              <XYChart
                ariaLabel={`Total supply over ${path.rounds} consecutive rounds with ${path.n} players: from ${tokens(path.supplyStart)} to ${tokens(path.supplyEnd)} NOTIT.`}
                series={[{ id: 'supply', label: 'Supply', kind: 'line', points: path.points.map((p) => ({ x: p.round, y: p.supply })) }]}
                xDomain={[1, Math.max(2, path.rounds)]}
                yDomain={[supplyTicks[0]!, supplyTicks[supplyTicks.length - 1]!]}
                xTicks={roundTicks}
                yTicks={supplyTicks.map((v) => ({ v, label: formatInt(v) }))}
                xLabel="Round"
                yLabel="Total supply, NOTIT"
                rugs={path.points.filter((p) => p.outcome !== 'saved').map((p) => ({ x: p.round, tone: p.outcome === 'collapsed' ? 'cut' : 'idle' }))}
                snapXs={path.points.map((p) => p.round)}
                busy={!pathReady}
                tip={(x) => {
                  const p = path.points[x - 1];
                  if (!p) return null;
                  return {
                    title: `Round ${formatInt(p.round)}`,
                    rows: [
                      ['NOTIT supply', formatInt(p.supply)],
                      [
                        p.outcome === 'saved' ? '· someone did it' : p.outcome === 'collapsed' ? '· everyone paid It' : '· nothing charged',
                        p.outcome === 'saved' ? 'Saved' : 'Unsaved',
                      ],
                    ],
                  };
                }}
              />
              <ul className="figures" style={{ marginTop: 'var(--space-3)' }}>
                <Figure label="Saved" value={formatInt(path.saved)} note={pct(path.saved / Math.max(1, path.rounds))} />
                <Figure label="Unsaved, paid to It" value={formatInt(path.collapsed)} note={`${tokens(path.totalPaid)} NOTIT moved to It`} />
                <Figure label="Unsaved, dormant" value={formatInt(path.dormant)} note="nothing charged" />
                <Figure label="Burned by volunteers" value={tokens(path.totalBurned)} note={`supply ${tokens(path.supplyStart)} → ${tokens(path.supplyEnd)}`} />
              </ul>
              <p className="field__help" style={{ marginTop: 'var(--space-3)' }}>
                One game played straight through with the same crowd. A save burns tokens, so the supply steps down. An
                unsaved round moves tokens to It and leaves the supply as it was. The vertical axis is zoomed in to show
                the steps.
                {firstDormant !== null && path.dormant > path.rounds * 0.2
                  ? ` From round ${formatInt(firstDormant)} this crowd let the game go dormant: after 8 charged rounds in a row nothing more is at stake, and players who only weigh the cut never wake it.`
                  : ''}
              </p>
            </>
          ) : (
            <p className="empty">Simulating…</p>
          )}
        </Card>

        <Card labelId="by-table" title="Rounds nobody saved: the numbers" aside={<span className="card__note">{formatInt(trials)} rounds per row</span>}>
          <div className="tablewrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Players</th>
                  <th scope="col" className="num">
                    One acts
                  </th>
                  <th scope="col" className="num">
                    Theory
                  </th>
                  <th scope="col" className="num">
                    Simulated
                  </th>
                  <th scope="col" className="num">
                    Gap
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.n} className={cls(r.n === n && 'is-picked')}>
                    <th scope="row">{r.n}</th>
                    <td className="num">{pct(r.p)}</td>
                    <td className="num">{pct(r.theory)}</td>
                    <td className="num">{pct(r.simulated)}</td>
                    <td className="num">{gap(r.simulated - r.theory)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="field__help" style={{ marginTop: 'var(--space-2)' }}>
            “One acts” is the chance that any single player volunteers. It and “Theory” are the equilibrium values for
            players who weigh the cost against the {formatPpm(FAST.cutPpm)} cut and ignore the value of becoming It.
          </p>
        </Card>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- B. who pays */

function strategyName(kind: string): string {
  if (kind === 'rationalTimer') return 'Myopic holders';
  if (kind === 'throneAware') return 'Throne-aware holders';
  return kind;
}

function ShareBars({ rows }: { rows: Array<{ label: string; value: number; note?: string }> }) {
  return (
    <div className="bars">
      {rows.map((r) => (
        <div key={r.label} className="bars__row">
          <div className="bars__label">
            <span>{r.label}</span>
            <span>
              {pct(r.value)}
              {r.note ? ` · ${r.note}` : ''}
            </span>
          </div>
          <div className="bars__track" role="img" aria-label={`${r.label}: ${pct(r.value)}`}>
            <span className="bars__fill" style={{ width: `${Math.min(100, Math.max(0, r.value * 100))}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function useJob<T>(run: () => Promise<T>, deps: unknown[], enabled = true): { result: T | null; running: boolean; error: string | null } {
  const [result, setResult] = useState<T | null>(null);
  const [running, setRunning] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) {
      setRunning(false);
      return;
    }
    let cancelled = false;
    setRunning(true);
    setError(null);
    const timer = window.setTimeout(() => {
      run().then(
        (r) => {
          if (cancelled) return;
          setResult(r);
          setRunning(false);
        },
        (e: unknown) => {
          if (cancelled) return;
          setError(e instanceof Error ? e.message : String(e));
          setRunning(false);
        },
      );
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { result, running, error };
}

function WhoPays() {
  const [holders, setHolders] = useState(50);
  const [rounds, setRounds] = useState(500);
  const [seed, setSeed] = useState(2002);
  const { result, running, error } = useJob<WhoPaysResult>(
    () => runInBackground({ kind: 'whoPays', holders, rounds, seed }),
    [holders, rounds, seed],
  );

  const myopic = result?.runs.find((r) => r.strategy === 'rationalTimer') ?? result?.runs[0] ?? null;
  const aware = result?.runs.find((r) => r.strategy === 'throneAware') ?? null;
  const coldMyopic = result?.coldStart.find((r) => r.strategy === 'rationalTimer') ?? null;
  const coldAware = result?.coldStart.find((r) => r.strategy === 'throneAware') ?? null;
  const same = !!myopic && !!aware && myopic.totalBurned === aware.totalBurned && myopic.savedShare === aware.savedShare;

  return (
    <div className="lab__grid">
      <Card labelId="wp-controls" title="Set up the holders" className="controls">
        <Slider
          id="wp-holders"
          label="Holders"
          value={holders}
          display={`${holders}`}
          valueText={`${holders} holders`}
          min={10}
          max={200}
          step={5}
          onChange={setHolders}
          help="Balances are very unequal, like most tokens: a few whales, many small holders."
        />
        <Select<number>
          id="wp-rounds"
          label="Rounds to simulate"
          value={rounds}
          options={[200, 500, 1000].map((v) => ({ value: v, label: `${formatInt(v)} rounds` }))}
          onChange={setRounds}
        />
        <button type="button" className="btn btn--ghost" onClick={() => setSeed((s) => s + 13)}>
          Deal new balances
        </button>
        <Status running={running} error={error} />
      </Card>

      <div className="lab__results" style={{ opacity: running && result ? 0.6 : 1 }}>
        {!result || !myopic ? (
          <p className="empty">Simulating…</p>
        ) : (
          <>
            <div className="reading">
              <h3>What this shows</h3>
              <p>
                The {result.top} biggest holders started with <b>{pct(result.topSupplyShareStart)}</b> of the supply and paid{' '}
                <b>{pct(myopic.topBurnShare)}</b> of everything burned. A collapse would take the most from a whale, so the
                falling cost becomes worth paying for them first, and they end up doing it. After {formatInt(result.rounds)}{' '}
                rounds their share is {pct(myopic.topSupplyShareEnd)}.
              </p>
              {coldMyopic && coldAware && (
                <p>
                  Starting cold, with nobody It: holders who only weigh the cut saved {pct(coldMyopic.savedShare)} of rounds
                  {coldMyopic.firstSavedRound === null ? ', because nothing is charged until someone goes first' : ''}.
                  Holders who also value being It saved {pct(coldAware.savedShare)}
                  {coldAware.firstSavedRound !== null ? `, starting in round ${coldAware.firstSavedRound}` : ''}. The throne
                  is what gets the game going.
                </p>
              )}
            </div>

            <Card labelId="wp-bars" title={`The ${result.top} biggest holders`} aside={<span className="card__note">{strategyName(myopic.strategy)}</span>}>
              <ShareBars
                rows={[
                  { label: 'Share of the supply at the start', value: result.topSupplyShareStart },
                  { label: 'Share of everything burned', value: myopic.topBurnShare },
                  { label: 'Share of all saves', value: myopic.topSaveShare },
                  { label: 'Share of the supply at the end', value: myopic.topSupplyShareEnd },
                ]}
              />
            </Card>

            <Card labelId="wp-table" title="Two kinds of holder, same balances">
              <div className="tablewrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Everyone plays</th>
                      <th scope="col" className="num">
                        Saved
                      </th>
                      <th scope="col" className="num">
                        Paid It
                      </th>
                      <th scope="col" className="num">
                        Dormant
                      </th>
                      <th scope="col" className="num">
                        Burned
                      </th>
                      <th scope="col" className="num">
                        Moved to It
                      </th>
                      <th scope="col" className="num">
                        Inequality
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.runs.map((r) => (
                      <tr key={r.strategy}>
                        <th scope="row">
                          {strategyName(r.strategy)}
                          <span className="table__sub">armed start</span>
                        </th>
                        <td className="num">{pct(r.savedShare)}</td>
                        <td className="num">{pct(r.collapsedShare)}</td>
                        <td className="num">{pct(r.dormantShare)}</td>
                        <td className="num">{tokens(r.totalBurned)}</td>
                        <td className="num">{tokens(r.totalPaid)}</td>
                        <td className="num">
                          {result.giniStart.toFixed(2)} → {r.giniEnd.toFixed(2)}
                        </td>
                      </tr>
                    ))}
                    {result.coldStart.map((r) => (
                      <tr key={`cold-${r.strategy}`}>
                        <th scope="row">
                          {strategyName(r.strategy)}
                          <span className="table__sub">cold start, nobody is It</span>
                        </th>
                        <td className="num">{pct(r.savedShare)}</td>
                        <td className="num">—</td>
                        <td className="num">{pct(r.dormantShare)}</td>
                        <td className="num">—</td>
                        <td className="num">—</td>
                        <td className="num">—</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="field__help" style={{ marginTop: 'var(--space-2)' }}>
                {same
                  ? 'Once the game is armed, both kinds behave the same in this run: someone always finds the cost worth paying before the deadline. '
                  : ''}
                Inequality is the Gini coefficient of balances: 0 is perfectly equal, 1 is one holder with everything. Supply
                at the start: {tokens(result.supplyStart)} NOTIT across {result.holders} holders.
              </p>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------- C. mixed crowd */

function groupName(kind: string): string {
  if (kind === 'altruist') return 'Altruists';
  if (kind === 'sniper') return 'Snipers';
  if (kind === 'freeRider') return 'Free riders';
  return kind;
}

function Mixed() {
  const [altruists, setAltruists] = useState(4);
  const [snipers, setSnipers] = useState(6);
  const [freeRiders, setFreeRiders] = useState(30);
  const [missPct, setMissPct] = useState(20);
  const [rounds, setRounds] = useState(1000);
  const [seed, setSeed] = useState(3003);
  const total = altruists + snipers + freeRiders;
  const { result, running, error } = useJob<MixedCrowdResult>(
    () => runInBackground({ kind: 'mixedCrowd', altruists, snipers, freeRiders, missRate: missPct / 100, rounds, seed }),
    [altruists, snipers, freeRiders, missPct, rounds, seed],
    total > 0,
  );

  const riders = result?.groups.find((g) => g.strategy === 'freeRider') ?? null;
  const winner = result ? [...result.groups].sort((a, b) => b.shareEnd - a.shareEnd)[0] ?? null : null;
  const doers = result ? [...result.groups].sort((a, b) => b.saves - a.saves)[0] ?? null : null;

  return (
    <div className="lab__grid">
      <Card labelId="mx-controls" title="Mix the crowd" className="controls">
        <Slider id="mx-alt" label="Altruists" value={altruists} display={`${altruists}`} min={0} max={20} onChange={setAltruists} help="Step up in 30% of rounds, at any price." />
        <Slider id="mx-snp" label="Snipers" value={snipers} display={`${snipers}`} min={0} max={20} onChange={setSnipers} help="Always try in the final block." />
        <Slider
          id="mx-miss"
          label="Sniper tries that land late"
          value={missPct}
          display={`${missPct}%`}
          min={0}
          max={50}
          step={5}
          onChange={setMissPct}
        />
        <Slider id="mx-free" label="Free riders" value={freeRiders} display={`${freeRiders}`} min={0} max={100} step={2} onChange={setFreeRiders} help="Never pay." />
        <Select<number>
          id="mx-rounds"
          label="Rounds to simulate"
          value={rounds}
          options={[500, 1000, 2000].map((v) => ({ value: v, label: `${formatInt(v)} rounds` }))}
          onChange={setRounds}
        />
        <button type="button" className="btn btn--ghost" onClick={() => setSeed((s) => s + 31)}>
          Shuffle the dice
        </button>
        <Status running={running} error={total === 0 ? 'add at least one holder' : error} />
      </Card>

      <div className="lab__results" style={{ opacity: running && result ? 0.6 : 1 }}>
        {total === 0 ? (
          <p className="empty">Add at least one holder to run the simulation.</p>
        ) : !result ? (
          <p className="empty">Simulating…</p>
        ) : (
          <>
            <div className="reading">
              <h3>What this shows</h3>
              {riders && riders.count > 0 ? (
                <p>
                  The free riders never paid, and it cost them: their share of all tokens went from{' '}
                  <b>{pct(riders.shareStart)}</b> to <b>{pct(riders.shareEnd)}</b>. Every unsaved round took{' '}
                  {formatPpm(FAST.cutPpm)} from each of them and handed it to whoever was It.
                </p>
              ) : (
                <p>With no free riders, the cut only moves tokens between the people who do the work.</p>
              )}
              {doers && winner && result.saved > 0 ? (
                <p>
                  {groupName(doers.strategy)} made {formatInt(doers.saves)} of {formatInt(result.saved)} saves
                  {doers.strategy === winner.strategy
                    ? ` and ended with ${pct(winner.shareEnd)} of everything`
                    : `, and ${groupName(winner.strategy).toLowerCase()} ended with ${pct(winner.shareEnd)} of everything`}
                  . Nobody saved {pct(result.failureRate)} of rounds. Sitting still is not neutral here: the idle pay the
                  ones who act.
                </p>
              ) : (
                <p>Nobody ever volunteered, so nobody became It and nothing was ever charged. The game never started.</p>
              )}
            </div>

            <ul className="figures">
              <Figure label="Rounds nobody saved" value={pct(result.failureRate)} note={`${formatInt(result.collapsed)} paid It, ${formatInt(result.dormant)} dormant`} />
              <Figure label="Longest streak of saves" value={formatInt(result.longestStreak)} note="rounds in a row" />
              <Figure label="Burned by volunteers" value={tokens(result.totalBurned)} note={`supply ${tokens(result.supplyStart)} → ${tokens(result.supplyEnd)}`} />
              <Figure label="Moved to It" value={tokens(result.totalPaid)} note="taken from everyone else" />
            </ul>

            <Card
              labelId="mx-bars"
              title="Share of all tokens, start and end"
              aside={
                <ul className="legend">
                  <li>
                    <span className="legend__swatch" style={{ background: 'var(--ink)' }} aria-hidden="true" /> Start
                  </li>
                  <li>
                    <span className="legend__swatch legend__swatch--saved" aria-hidden="true" /> End
                  </li>
                </ul>
              }
            >
              <div className="bars">
                {result.groups.map((g) => (
                  <div key={g.strategy} className="bars__row">
                    <div className="bars__label">
                      <span>
                        {groupName(g.strategy)} ({g.count})
                      </span>
                      <span>
                        {pct(g.shareStart)} → {pct(g.shareEnd)}
                      </span>
                    </div>
                    <div className="bars__pair" role="img" aria-label={`${groupName(g.strategy)}: ${pct(g.shareStart)} of tokens at the start, ${pct(g.shareEnd)} at the end`}>
                      <div className="bars__track">
                        <span className="bars__fill bars__fill--ink" style={{ width: `${g.shareStart * 100}%` }} />
                      </div>
                      <div className="bars__track">
                        <span className="bars__fill" style={{ width: `${g.shareEnd * 100}%` }} />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </Card>

            <Card labelId="mx-table" title="The numbers" aside={<span className="card__note">{formatInt(result.rounds)} rounds, {result.holders} holders</span>}>
              <div className="tablewrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Group</th>
                      <th scope="col" className="num">
                        Saves
                      </th>
                      <th scope="col" className="num">
                        Burned
                      </th>
                      <th scope="col" className="num">
                        Gained as It
                      </th>
                      <th scope="col" className="num">
                        Late tries
                      </th>
                      <th scope="col" className="num">
                        Share, start → end
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.groups.map((g) => (
                      <tr key={g.strategy}>
                        <th scope="row">
                          {groupName(g.strategy)}
                          <span className="table__sub">{g.count} holders</span>
                        </th>
                        <td className="num">{formatInt(g.saves)}</td>
                        <td className="num">{tokens(g.burned)}</td>
                        <td className="num">{tokens(g.collected)}</td>
                        <td className="num">{formatInt(g.missed)}</td>
                        <td className="num">
                          {pct(g.shareStart)} → {pct(g.shareEnd)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------- page */

export function Lab() {
  const [exp, setExp] = useState<Experiment>('bystander');
  const refs = useRef<Partial<Record<Experiment, HTMLButtonElement | null>>>({});

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = EXPERIMENTS.findIndex((x) => x.id === exp);
    let next: Experiment | null = null;
    if (e.key === 'ArrowRight') next = EXPERIMENTS[(i + 1) % EXPERIMENTS.length]!.id;
    else if (e.key === 'ArrowLeft') next = EXPERIMENTS[(i + EXPERIMENTS.length - 1) % EXPERIMENTS.length]!.id;
    if (next) {
      e.preventDefault();
      setExp(next);
      refs.current[next]?.focus();
    }
  };

  return (
    <div className="page">
      <header className="page__head">
        <h1 className="page__title">
          Does anyone <span className="pitch__hl">actually do it?</span>
        </h1>
        <p className="page__lead">
          Three experiments on the same rules engine the game uses, run in your browser. Move a control and the crowd
          plays again.
        </p>
      </header>

      <div className="subtabs" role="tablist" aria-label="Experiments" onKeyDown={onKey}>
        {EXPERIMENTS.map((x) => (
          <button
            key={x.id}
            ref={(el) => {
              refs.current[x.id] = el;
            }}
            type="button"
            role="tab"
            id={`exp-${x.id}`}
            className="subtabs__tab"
            aria-selected={exp === x.id}
            aria-controls="exp-panel"
            tabIndex={exp === x.id ? 0 : -1}
            onClick={() => setExp(x.id)}
          >
            {x.label}
            <small>{x.sub}</small>
          </button>
        ))}
      </div>

      <div role="tabpanel" id="exp-panel" aria-labelledby={`exp-${exp}`}>
        {exp === 'bystander' && <Bystander />}
        {exp === 'whoPays' && <WhoPays />}
        {exp === 'mixed' && <Mixed />}
      </div>
    </div>
  );
}
