import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import type { ForwardLookingResult, MixedCrowdResult, WhoPaysResult } from '@notit/engine';
import { XYChart } from '../components/charts/XYChart';
import type { Tick } from '../components/charts/XYChart';
import { Card, cls } from '../components/ui';
import { formatInt, formatToken } from '../lib/format';
import { queryGet, querySet } from '../lib/url';
import { PRESETS, SWEEP, classicFailure, equilibriumFailure } from './jobs';
import type { BystanderPreset, BystanderRow, PathResult } from './jobs';
import { runInBackground } from './runner';

type Experiment = 'bystander' | 'whoPays' | 'mixed' | 'forward';

const EXPERIMENTS: Array<{ id: Experiment; label: string; sub: string }> = [
  { id: 'bystander', label: 'Bystander effect', sub: 'Bigger crowd, fewer volunteers' },
  { id: 'whoPays', label: 'Who pays', sub: 'Whales and small holders' },
  { id: 'mixed', label: 'Mixed crowd', sub: 'The idle get taxed' },
  { id: 'forward', label: 'Forward-looking', sub: 'The seat is an auction' },
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
    <div className="field" title={help}>
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
    <div className="field" title={help}>
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
    </div>
  );
}

function Status({ running, progress, error }: { running: boolean; progress?: number; error: string | null }) {
  return (
    <div className="controls__status" role="status" aria-live="polite">
      {error ? (
        `Failed: ${error}`
      ) : running ? (
        <>
          Simulating…
          {progress !== undefined && (
            <div className="progress" aria-hidden="true">
              <span style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
          )}
        </>
      ) : (
        'Done'
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
const EQUILIBRIUM_POINTS = Array.from({ length: N_MAX - N_MIN + 1 }, (_, i) => ({ x: i + N_MIN, y: equilibriumFailure(i + N_MIN) }));
const CLASSIC_POINTS = Array.from({ length: N_MAX - N_MIN + 1 }, (_, i) => ({ x: i + N_MIN, y: classicFailure(i + N_MIN) }));

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
  const roundTicks: Tick[] = useMemo(() => {
    const r = path?.rounds ?? trials;
    return [1, r / 4, r / 2, (3 * r) / 4, r].map((v) => ({ v: Math.max(1, Math.round(v)), label: formatInt(Math.max(1, Math.round(v))) }));
  }, [path, trials]);

  // One sentence: the number for the chosen crowd, next to what the equilibrium says.
  const reading: ReactNode = !picked ? (
    <p>Simulating…</p>
  ) : (
    <p>
      With <b>{n}</b> holders nobody volunteered in <b>{pct(picked.simulated)}</b> of {formatInt(picked.trials)} rounds; the equilibrium says{' '}
      {pct(picked.equilibrium)}.
    </p>
  );

  return (
    <div className="lab__grid">
      <Card labelId="by-controls" title="Crowd" className="controls">
        <Slider
          id="by-n"
          label="Crowd size"
          value={pos}
          display={`${n}`}
          valueText={`${n} holders`}
          min={0}
          max={SLIDER_STEPS}
          onChange={setPos}
          help="Holders who could volunteer, 2 to 300. One more account is already It and sits still."
        />
        <Select<number>
          id="by-trials"
          label="Rounds"
          value={trials}
          options={[200, 500, 1000, 2000].map((v) => ({ value: v, label: `${formatInt(v)} rounds` }))}
          onChange={setTrials}
          help="More rounds, less noise, a little more waiting."
        />
        <Select<BystanderPreset>
          id="by-preset"
          label="Behaviour"
          value={preset}
          options={(Object.keys(PRESETS) as BystanderPreset[]).map((k) => ({ value: k, label: PRESETS[k].label }))}
          onChange={setPreset}
          help={PRESETS[preset].blurb}
        />
        <button type="button" className="btn btn--ghost" onClick={() => setSeed((s) => s + 97)}>
          Reshuffle
        </button>
        <Status running={running} progress={progress} error={error} />
      </Card>

      <div className="lab__results">
        <div className="reading">{reading}</div>

        <Card labelId="by-chart" title="Unsaved rounds, by crowd size">
          <XYChart
            ariaLabel={`Share of unsaved rounds against crowd size: simulated, the equilibrium where only the first volunteer pays, and the textbook case where every volunteer pays. At ${n} holders: simulated ${picked ? pct(picked.simulated) : 'pending'}, equilibrium ${pct(equilibriumFailure(n))}, if every volunteer paid ${pct(classicFailure(n))}.`}
            series={[
              { id: 'equilibrium', label: 'Equilibrium (first volunteer pays)', kind: 'line', points: EQUILIBRIUM_POINTS },
              { id: 'classic', label: 'If every volunteer paid', kind: 'line', dashed: true, points: CLASSIC_POINTS },
              { id: 'sim', label: `Simulated: ${PRESETS[preset].label}`, kind: 'dots', points: rows.map((r) => ({ x: r.n, y: r.simulated })) },
            ]}
            xDomain={[N_MIN, N_MAX]}
            yDomain={[0, 1]}
            xLog
            xTicks={N_TICKS}
            yTicks={PCT_TICKS}
            xLabel="Crowd size (holders, log scale)"
            yLabel="Unsaved rounds"
            pickX={n}
            pickLabel={`${n} holders`}
            snapXs={snapXs}
            busy={running && rows.length === 0}
            tip={(x) => {
              const r = rows.find((row) => row.n === x);
              if (!r) return null;
              return {
                title: `${r.n} holders`,
                rows: [
                  ['simulated', pct(r.simulated)],
                  ['equilibrium', pct(r.equilibrium)],
                  ['if every volunteer paid', pct(r.classic)],
                ],
              };
            }}
          />
          <p className="lab__why">Only the first volunteer pays, so holders volunteer more readily than in the textbook dilemma.</p>
        </Card>

        <Card
          labelId="by-path"
          title={`Supply over ${formatInt(path?.rounds ?? trials)} rounds in a row, ${path?.n ?? n} holders`}
          aside={
            <ul className="legend">
              <li>
                <span className="legend__swatch legend__swatch--collapsed" aria-hidden="true" /> Unsaved, paid to It
              </li>
              <li>
                <span className="legend__swatch" style={{ height: 6, background: 'var(--muted)' }} aria-hidden="true" /> Unsaved,
                asleep
              </li>
            </ul>
          }
        >
          {path ? (
            <>
              <XYChart
                ariaLabel={`Total supply over ${path.rounds} consecutive rounds with ${path.n} holders: from ${tokens(path.supplyStart)} to ${tokens(path.supplyEnd)} NOTIT.`}
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
                        p.outcome === 'saved' ? '· saved' : p.outcome === 'collapsed' ? '· unsaved, paid to It' : '· unsaved, asleep',
                        p.outcome === 'saved' ? 'Saved' : 'Unsaved',
                      ],
                    ],
                  };
                }}
              />
              <ul className="figures" style={{ marginTop: 'var(--space-3)' }}>
                <Figure label="Saved" value={formatInt(path.saved)} />
                <Figure label="Unsaved, paid to It" value={formatInt(path.collapsed)} />
                <Figure label="Unsaved, asleep" value={formatInt(path.dormant)} />
                <Figure label="Burned" value={tokens(path.totalBurned)} />
              </ul>
            </>
          ) : (
            <p className="empty">Simulating…</p>
          )}
        </Card>

        <details className="numbers">
<summary>Numbers</summary>
          <div className="tablewrap" tabIndex={0} role="region" aria-label="Numbers">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Holders</th>
                  <th scope="col" className="num col-wide">
                    One volunteers
                  </th>
                  <th scope="col" className="num">
                    Equilibrium
                  </th>
                  <th scope="col" className="num">
                    Simulated
                  </th>
                  <th scope="col" className="num col-wide">
                    Gap
                  </th>
                  <th scope="col" className="num th-wrap">
                    If every volunteer paid
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.n} className={cls(r.n === n && 'is-picked')}>
                    <th scope="row">{r.n}</th>
                    <td className="num col-wide">{pct(r.p)}</td>
                    <td className="num">{pct(r.equilibrium)}</td>
                    <td className="num">{pct(r.simulated)}</td>
                    <td className="num col-wide">{gap(r.simulated - r.equilibrium)}</td>
                    <td className="num">{pct(r.classic)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- B. who pays */

function strategyName(kind: string): string {
  if (kind === 'rationalTimer') return 'Weigh this round only';
  if (kind === 'throneAware') return 'Also want to be It';
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

  return (
    <div className="lab__grid">
      <Card labelId="wp-controls" title="Crowd" className="controls">
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
          label="Rounds"
          value={rounds}
          options={[200, 500, 1000].map((v) => ({ value: v, label: `${formatInt(v)} rounds` }))}
          onChange={setRounds}
        />
        <button type="button" className="btn btn--ghost" onClick={() => setSeed((s) => s + 13)}>
          New balances
        </button>
        <Status running={running} error={error} />
      </Card>

      <div className="lab__results" style={{ opacity: running && result ? 0.6 : 1 }}>
        {!result || !myopic ? (
          <p className="empty">Simulating…</p>
        ) : (
          <>
            <div className="reading">
              <p>
                The {result.top} biggest holders held <b>{pct(result.topSupplyShareStart)}</b> of the supply and paid{' '}
                <b>{pct(myopic.topBurnShare)}</b> of everything burned.
              </p>
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

            <details className="numbers">
<summary>Numbers</summary>
              <div className="tablewrap" tabIndex={0} role="region" aria-label="Numbers">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">How holders decide</th>
                      <th scope="col" className="num">
                        Saved
                      </th>
                      <th scope="col" className="num">
                        Unsaved
                      </th>
                      <th scope="col" className="num">
                        Asleep
                      </th>
                      <th scope="col" className="num col-wide">
                        Burned
                      </th>
                      <th scope="col" className="num col-wide">
                        Paid to It
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.runs.map((r) => (
                      <tr key={r.strategy}>
                        <th scope="row">
                          {strategyName(r.strategy)}
                          <span className="table__sub">someone is It</span>
                        </th>
                        <td className="num">{pct(r.savedShare)}</td>
                        <td className="num">{pct(r.collapsedShare)}</td>
                        <td className="num">{pct(r.dormantShare)}</td>
                        <td className="num col-wide">{tokens(r.totalBurned)}</td>
                        <td className="num col-wide">{tokens(r.totalPaid)}</td>
                      </tr>
                    ))}
                    {result.coldStart.map((r) => (
                      <tr key={`cold-${r.strategy}`}>
                        <th scope="row">
                          {strategyName(r.strategy)}
                          <span className="table__sub">nobody is It yet</span>
                        </th>
                        <td className="num">{pct(r.savedShare)}</td>
                        <td className="num">—</td>
                        <td className="num">{pct(r.dormantShare)}</td>
                        <td className="num col-wide">—</td>
                        <td className="num col-wide">—</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
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

  return (
    <div className="lab__grid">
      <Card labelId="mx-controls" title="Mix" className="controls">
        <Slider id="mx-alt" label="Altruists" value={altruists} display={`${altruists}`} min={0} max={20} onChange={setAltruists} help="Volunteer in 30% of rounds, at any price." />
        <Slider id="mx-snp" label="Snipers" value={snipers} display={`${snipers}`} min={0} max={20} onChange={setSnipers} help="Always try in the final block." />
        <Slider
          id="mx-miss"
          label="Snipers landing late"
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
          label="Rounds"
          value={rounds}
          options={[500, 1000, 2000].map((v) => ({ value: v, label: `${formatInt(v)} rounds` }))}
          onChange={setRounds}
        />
        <button type="button" className="btn btn--ghost" onClick={() => setSeed((s) => s + 31)}>
          Reshuffle
        </button>
        <Status running={running} error={total === 0 ? 'no holders' : error} />
      </Card>

      <div className="lab__results" style={{ opacity: running && result ? 0.6 : 1 }}>
        {total === 0 ? (
          <p className="empty">Add at least one holder.</p>
        ) : !result ? (
          <p className="empty">Simulating…</p>
        ) : (
          <>
            <div className="reading">
              {riders && riders.count > 0 ? (
                <p>
                  Free riders never paid, and their share of all tokens went from <b>{pct(riders.shareStart)}</b> to{' '}
                  <b>{pct(riders.shareEnd)}</b>.
                </p>
              ) : winner ? (
                <p>
                  {groupName(winner.strategy)} ended with <b>{pct(winner.shareEnd)}</b> of all tokens.
                </p>
              ) : null}
            </div>

            <ul className="figures">
              <Figure label="Unsaved" value={pct(result.failureRate)} />
              <Figure label="Longest streak" value={formatInt(result.longestStreak)} />
              <Figure label="Burned" value={tokens(result.totalBurned)} />
              <Figure label="Paid to It" value={tokens(result.totalPaid)} />
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

            <details className="numbers">
<summary>Numbers</summary>
              <div className="tablewrap" tabIndex={0} role="region" aria-label="Numbers">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Group</th>
                      <th scope="col" className="num">
                        Saves
                      </th>
                      <th scope="col" className="num col-wide">
                        Burned
                      </th>
                      <th scope="col" className="num">
                        Paid to It
                      </th>
                      <th scope="col" className="num col-wide">
                        Late tries
                      </th>
                      <th scope="col" className="num">
                        Share
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
                        <td className="num col-wide">{tokens(g.burned)}</td>
                        <td className="num">{tokens(g.collected)}</td>
                        <td className="num col-wide">{formatInt(g.missed)}</td>
                        <td className="num">
                          {pct(g.shareStart)} → {pct(g.shareEnd)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------ D. forward-looking */

function Forward() {
  const { result, running, error } = useJob<ForwardLookingResult>(() => runInBackground({ kind: 'forwardLooking' }), []);
  return (
    <div className="lab__grid lab__grid--single">
      <div className="lab__results" style={{ opacity: running && result ? 0.6 : 1 }}>
        {!result ? (
          <p className="empty">{error ?? 'Simulating…'}</p>
        ) : (
          <>
            <div className="reading">
              <p>
                If holders value being It, rounds go unsaved at most <b>{(result.bound * 100).toFixed(1)}%</b> of the time.
              </p>
            </div>
            <div className="tablewrap" tabIndex={0} role="region" aria-label="Forward-looking holders, by crowd size">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Holders</th>
                    <th scope="col" className="num">
                      Share each
                    </th>
                    <th scope="col" className="num">
                      Unsaved
                    </th>
                    <th scope="col" className="num">
                      Bound
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {result.runs.map((r) => (
                    <tr key={r.holders} className={cls(!r.withinBound && 'is-over')} title={r.withinBound ? undefined : 'Scripted strategy, 20-round memory'}>
                      <th scope="row">
                        {formatInt(r.holders)}
                        {!r.withinBound && <span className="table__sub">above the bound: scripted strategy, 20-round memory</span>}
                      </th>
                      <td className="num">{pct(r.holderShare)}</td>
                      <td className="num">{pct(r.unsavedRate)}</td>
                      <td className="num">{(result.bound * 100).toFixed(1)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="controls__status" role="status" aria-live="polite">
              Done
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------- page */

export function Lab() {
  // The experiment on show is part of the address (`?lab=`), so a reload or a shared link keeps it.
  const [exp, setExpState] = useState<Experiment>(() => {
    const asked = queryGet('lab');
    return EXPERIMENTS.some((x) => x.id === asked) ? (asked as Experiment) : 'bystander';
  });
  const setExp = (next: Experiment) => {
    setExpState(next);
    querySet('lab', next === 'bystander' ? null : next);
  };
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
        {exp === 'forward' && <Forward />}
      </div>
    </div>
  );
}
