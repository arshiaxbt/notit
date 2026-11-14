import React from 'react';
import {C, LINE} from '../tokens';

export interface FaceProps {
  x: number;
  y: number;
  /** Outer radius, stroke included. */
  r: number;
  /** Vector the pupils are pushed along; (0, 0) looks straight out at the viewer. */
  gx?: number;
  gy?: number;
  /** It: ink, with yellow eyes on you. */
  it?: boolean;
  scale?: number;
  /** 0 open … 1 closed. */
  blink?: number;
  /** Eyes widen (It, when it is paid). */
  wide?: number;
  line?: number;
  opacity?: number;
}

/**
 * A face as the app draws it (scene.css `.face`): a white disc, one ink stroke, two pupils of 0.15 r
 * set 0.25 r either side of the middle and pushed 0.3 r along the gaze.
 */
export const Face: React.FC<FaceProps> = ({x, y, r, gx = 0, gy = 0, it = false, scale = 1, blink = 0, wide = 0, line = LINE, opacity = 1}) => {
  if (scale <= 0.001) return null;
  const pr = r * 0.15 * (1 + 0.35 * wide);
  const px = gx * 0.3 * r;
  const py = (gy * 0.3 - 0.04) * r;
  return (
    <g transform={`translate(${x.toFixed(2)} ${y.toFixed(2)}) scale(${scale.toFixed(4)})`} opacity={opacity}>
      <circle r={r - line / 2} fill={it ? C.ink : C.white} stroke={C.ink} strokeWidth={line} />
      <ellipse cx={px - 0.25 * r} cy={py} rx={pr} ry={pr * (1 - 0.88 * blink)} fill={it ? C.accent : C.ink} />
      <ellipse cx={px + 0.25 * r} cy={py} rx={pr} ry={pr * (1 - 0.88 * blink)} fill={it ? C.accent : C.ink} />
    </g>
  );
};
