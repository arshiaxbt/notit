/**
 * A small hand-rolled SVG chart: lines, dots and an area on one x/y plane,
 * with a crosshair that snaps to the nearest data position and a tooltip that
 * reads out every series there. Works with the mouse, touch and the keyboard
 * (focus the chart, then use the left and right arrow keys).
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent, CSSProperties } from 'react';
import { cls } from '../ui';

export interface ChartSeries {
  id: string;
  label: string;
  kind: 'line' | 'dots' | 'area';
  dashed?: boolean;
  points: Array<{ x: number; y: number }>;
}

export interface Tick {
  v: number;
  label: string;
}

export interface TipContent {
  title: string;
  rows: Array<[label: string, value: string]>;
}

interface Props {
  ariaLabel: string;
  series: ChartSeries[];
  xDomain: [number, number];
  yDomain: [number, number];
  xLog?: boolean;
  xTicks: Tick[];
  yTicks: Tick[];
  xLabel: string;
  yLabel: string;
  height?: number;
  /** A marked x position (the value picked with a control). */
  pickX?: number;
  pickLabel?: string;
  /** Small ticks on the baseline, e.g. rounds nobody saved. */
  rugs?: Array<{ x: number; tone: 'cut' | 'idle' }>;
  /** x positions the crosshair snaps to. */
  snapXs: number[];
  tip(x: number): TipContent | null;
  /** Dim the plot while new data is on its way. */
  busy?: boolean;
}

const M = { top: 36, right: 16, bottom: 40, left: 50 };

export function XYChart({
  ariaLabel,
  series,
  xDomain,
  yDomain,
  xLog,
  xTicks,
  yTicks,
  xLabel,
  yLabel,
  height = 270,
  pickX,
  pickLabel,
  rugs,
  snapXs,
  tip,
  busy,
}: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [active, setActive] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const measure = () => setWidth(Math.max(260, Math.round(el.clientWidth)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // A different set of positions invalidates the highlighted one.
  useEffect(() => setActive(null), [snapXs.length]);

  const h = width < 420 ? Math.min(height, 230) : height;
  const plotW = width - M.left - M.right;
  const plotH = h - M.top - M.bottom;
  const tx = (v: number) => (xLog ? Math.log(v) : v);
  const [x0, x1] = [tx(xDomain[0]), tx(xDomain[1])];
  const px = (v: number) => M.left + ((tx(v) - x0) / (x1 - x0 || 1)) * plotW;
  const py = (v: number) => M.top + plotH - ((v - yDomain[0]) / (yDomain[1] - yDomain[0] || 1)) * plotH;
  const clampY = (v: number) => Math.min(yDomain[1], Math.max(yDomain[0], v));

  const pathOf = (pts: Array<{ x: number; y: number }>) =>
    pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${px(p.x).toFixed(1)},${py(clampY(p.y)).toFixed(1)}`).join('');

  const nearest = (clientX: number): number | null => {
    const el = wrap.current;
    if (!el || snapXs.length === 0) return null;
    const x = clientX - el.getBoundingClientRect().left;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < snapXs.length; i++) {
      const d = Math.abs(px(snapXs[i]!) - x);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  };

  const onMove = (e: PointerEvent<SVGSVGElement>) => setActive(nearest(e.clientX));
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (snapXs.length === 0) return;
    if (e.key === 'ArrowRight') setActive((a) => Math.min(snapXs.length - 1, (a ?? -1) + 1));
    else if (e.key === 'ArrowLeft') setActive((a) => Math.max(0, (a ?? snapXs.length) - 1));
    else if (e.key === 'Home') setActive(0);
    else if (e.key === 'End') setActive(snapXs.length - 1);
    else if (e.key === 'Escape') setActive(null);
    else return;
    e.preventDefault();
  };

  const activeX = active !== null && active < snapXs.length ? snapXs[active]! : null;
  const content = activeX !== null ? tip(activeX) : null;
  // The tooltip sits beside the crosshair, on whichever side has more room.
  const tipOnLeft = activeX !== null && px(activeX) > width / 2;
  const inDomain = (v: number) => v >= xDomain[0] && v <= xDomain[1];

  return (
    <div className="chart" ref={wrap}>
      {series.length > 1 && (
        <ul className="legend chart__legend">
          {series.map((s) => (
            <li key={s.id}>
              <span className={cls('legend__swatch', s.kind === 'dots' ? 'legend__swatch--dot' : 'legend__swatch--line', s.dashed && 'legend__swatch--dashed')} aria-hidden="true" />
              {s.label}
            </li>
          ))}
        </ul>
      )}
      <div className="chart__plot">
      <svg
        viewBox={`0 0 ${width} ${h}`}
        width={width}
        height={h}
        role="img"
        aria-label={`${ariaLabel} Use the left and right arrow keys to read values.`}
        tabIndex={0}
        onPointerMove={onMove}
        onPointerDown={onMove}
        onPointerLeave={() => setActive(null)}
        onBlur={() => setActive(null)}
        onKeyDown={onKey}
        style={{ opacity: busy ? 0.55 : 1 }}
      >
        <text className="chart__axis-label" x={0} y={12}>
          {yLabel}
        </text>
        {yTicks.map((t) => (
          <g key={`y${t.v}`}>
            <line className="chart__grid" x1={M.left} x2={width - M.right} y1={py(t.v)} y2={py(t.v)} />
            <text className="chart__tick" x={M.left - 8} y={py(t.v) + 4} textAnchor="end">
              {t.label}
            </text>
          </g>
        ))}
        {xTicks.filter((t) => inDomain(t.v)).map((t) => (
          <g key={`x${t.v}`}>
            <line className="chart__axis" x1={px(t.v)} x2={px(t.v)} y1={M.top + plotH} y2={M.top + plotH + 5} />
            <text className="chart__tick" x={px(t.v)} y={M.top + plotH + 19} textAnchor="middle">
              {t.label}
            </text>
          </g>
        ))}
        <line className="chart__axis" x1={M.left} x2={width - M.right} y1={M.top + plotH} y2={M.top + plotH} />
        <text className="chart__axis-label" x={M.left + plotW / 2} y={h - 3} textAnchor="middle">
          {xLabel}
        </text>

        {series
          .filter((s) => s.kind === 'area' && s.points.length > 1)
          .map((s) => (
            <path
              key={`a${s.id}`}
              className="chart__area"
              d={`${pathOf(s.points)}L${px(s.points[s.points.length - 1]!.x).toFixed(1)},${py(yDomain[0])}L${px(s.points[0]!.x).toFixed(1)},${py(yDomain[0])}Z`}
            />
          ))}

        {rugs?.map((r, i) => (
          <line
            key={`r${i}`}
            className="chart__mark"
            style={r.tone === 'idle' ? { stroke: 'var(--muted)', opacity: 0.6 } : undefined}
            x1={px(r.x)}
            x2={px(r.x)}
            y1={M.top + plotH - 1}
            y2={M.top + plotH - (r.tone === 'idle' ? 6 : 11)}
          />
        ))}

        {pickX !== undefined && inDomain(pickX) && (
          // Positioned with a transform, so the marker glides when the chosen value moves.
          <g className="chart__pick" style={{ transform: `translateX(${px(pickX).toFixed(1)}px)` }}>
            <line className="chart__cross" x1={0} x2={0} y1={M.top} y2={M.top + plotH} />
            {pickLabel && (
              <text
                className="chart__note"
                x={Math.min(width - M.right, Math.max(M.left, px(pickX))) - px(pickX)}
                y={M.top - 7}
                textAnchor={px(pickX) > width - 70 ? 'end' : px(pickX) < M.left + 50 ? 'start' : 'middle'}
              >
                {pickLabel}
              </text>
            )}
          </g>
        )}

        {series
          .filter((s) => s.kind !== 'dots' && s.points.length > 1)
          .map((s) => (
            // A solid curve draws on from the left when the chart first appears (pathLength makes its length 1).
            <path key={`l${s.id}`} className={cls('chart__line', s.dashed ? 'chart__line--dashed' : 'chart__line--draw')} pathLength={s.dashed ? undefined : 1} d={pathOf(s.points)} />
          ))}
        {series
          .filter((s) => s.kind === 'dots')
          .map((s) =>
            s.points.map((p, k) => (
              <circle
                key={`d${s.id}-${p.x}`}
                className={cls('chart__dot', (p.x === pickX || p.x === activeX) && 'chart__dot--picked')}
                style={{ '--k': k } as CSSProperties}
                cx={px(p.x)}
                cy={py(clampY(p.y))}
                r={p.x === pickX || p.x === activeX ? 6.5 : 4.5}
              />
            )),
          )}

        {activeX !== null && (
          <line className="chart__cross" style={{ strokeDasharray: 'none' }} x1={px(activeX)} x2={px(activeX)} y1={M.top} y2={M.top + plotH} />
        )}
        {/* A transparent sheet so the whole plot, not just the marks, is the hit target. */}
        <rect x={M.left} y={M.top} width={Math.max(0, plotW)} height={Math.max(0, plotH)} fill="transparent" />
      </svg>
      {content && activeX !== null && (
        <div
          className="chart__tip"
          style={{
            left: px(activeX),
            top: M.top + 6,
            transform: tipOnLeft ? 'translateX(calc(-100% - 10px))' : 'translateX(10px)',
          }}
          role="status"
        >
          <b>{content.title}</b>
          {content.rows.map(([label, value], i) => (
            <span key={i} style={{ display: 'block' }}>
              <strong>{value}</strong> {label}
            </span>
          ))}
        </div>
      )}
      </div>
    </div>
  );
}
