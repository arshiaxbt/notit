import React from 'react';
import {useCurrentFrame, useVideoConfig} from 'remotion';
import {ci, E, pop} from '../anim';
import {C, LINE, words} from '../tokens';

/**
 * A caption that points: a small ink dot on the thing, one ink line, and a white label with the app's stroke
 * (the same box as the app's "You did it" stamp). The line draws out from the dot, then the label lands.
 */
export const Callout: React.FC<{
  /** The thing, on screen. */
  at: {x: number; y: number};
  /** Centre of the label, relative to the thing. */
  dx: number;
  dy: number;
  in: number;
  out: number;
  size?: number;
  children: React.ReactNode;
  dot?: boolean;
  tilt?: number;
}> = ({at, dx, dy, in: tIn, out: tOut, size = 40, children, dot = true, tilt = 0}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  if (frame < tIn || frame > tOut + 6) return null;
  const leave = ci(frame, [tOut, tOut + 6], [0, 1], E.in);
  const lineT = ci(frame, [tIn, tIn + 7], [0, 1], E.out) * (1 - leave);
  const box = pop(frame, tIn + 4, fps) * (1 - leave);
  const bx = at.x + dx;
  const by = at.y + dy;
  return (
    <div style={{position: 'absolute', inset: 0, pointerEvents: 'none'}}>
      <svg width={1920} height={1080} style={{position: 'absolute', inset: 0}}>
        <line x1={at.x} y1={at.y} x2={at.x + dx * lineT} y2={at.y + dy * lineT} stroke={C.ink} strokeWidth={LINE} />
        {dot && <circle cx={at.x} cy={at.y} r={8 * Math.min(1, lineT * 3)} fill={C.ink} />}
      </svg>
      <div
        style={{
          position: 'absolute',
          left: bx,
          top: by,
          transform: `translate(-50%, -50%) rotate(${tilt}deg) scale(${box.toFixed(4)})`,
          padding: `${size * 0.3}px ${size * 0.55}px ${size * 0.38}px`,
          background: C.white,
          border: `${LINE}px solid ${C.ink}`,
          color: C.ink,
          whiteSpace: 'nowrap',
          textAlign: 'center',
          ...words(size, 800),
          lineHeight: 1.12,
          letterSpacing: '-0.012em',
        }}
      >
        {children}
      </div>
    </div>
  );
};
