import React from 'react';
import {C, K} from '../tokens';
import {ci, E} from '../anim';

export interface CoinProps {
  frame: number;
  /** Frame the coin leaves its face. */
  start: number;
  dur?: number;
  from: {x: number; y: number};
  to: {x: number; y: number};
  r?: number;
}

/** A coin as the app draws it (`.coin`): a small white disc with a thin ink stroke, paid straight down the radius. */
export const Coin: React.FC<CoinProps> = ({frame, start, dur = 16, from, to, r = 5 * K}) => {
  if (frame < start || frame > start + dur) return null;
  const t = ci(frame, [start, start + dur], [0, 1], E.in);
  return <circle cx={from.x + (to.x - from.x) * t} cy={from.y + (to.y - from.y) * t} r={r - K} fill={C.white} stroke={C.ink} strokeWidth={2 * K} />;
};
