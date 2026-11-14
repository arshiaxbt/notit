import React from 'react';
import {C, HAIR, K} from '../tokens';

export interface ClockRingProps {
  cx: number;
  cy: number;
  /** Outer radius. */
  r: number;
  /** Share of the round already burnt, 0 … 1. */
  p: number;
  /** Width of the unburnt ink ring (12 px in the app). */
  stroke?: number;
  hair?: number;
  /** 0 … 1: how much of the ring has been drawn on, clockwise from twelve. */
  draw?: number;
  /** Nobody did it: the ring goes red. */
  red?: boolean;
  tip?: boolean;
  tipR?: number;
}

/**
 * The clock as the app draws it (Scene.tsx `Clock`): a hairline circle, over it the ink ring that is left,
 * burning away clockwise from twelve, and one red dot at the tip.
 */
export const ClockRing: React.FC<ClockRingProps> = ({cx, cy, r, p, stroke = 12 * K, hair = HAIR, draw = 1, red = false, tip = true, tipR = 7 * K}) => {
  const rr = r - stroke / 2;
  const c = 2 * Math.PI * rr;
  const col = red ? C.cut : C.ink;
  const a = p * 2 * Math.PI;
  const shown = Math.max(0, Math.min(1, draw));
  // The ink that is left runs from p to 1; while drawing on, from p to p + (1 - p) * draw.
  const len = c * (1 - p) * shown;
  return (
    <g>
      <circle cx={cx} cy={cy} r={rr} fill="none" stroke={col} strokeWidth={hair} strokeDasharray={`${(c * shown).toFixed(2)} ${c.toFixed(2)}`} transform={`rotate(-90 ${cx} ${cy})`} />
      {len > 0.5 && (
        <circle
          cx={cx}
          cy={cy}
          r={rr}
          fill="none"
          stroke={col}
          strokeWidth={stroke}
          strokeDasharray={`${len.toFixed(2)} ${c.toFixed(2)}`}
          strokeDashoffset={(-c * p).toFixed(2)}
          transform={`rotate(-90 ${cx} ${cy})`}
        />
      )}
      {tip && shown >= 1 && <circle cx={cx + rr * Math.sin(a)} cy={cy - rr * Math.cos(a)} r={tipR} fill={C.cut} />}
    </g>
  );
};
