import React from 'react';
import {useCurrentFrame} from 'remotion';
import {ci} from '../anim';
import {C, LINE, words} from '../tokens';

/** The small constant label that says what the footage is. */
export const Tag: React.FC<{children: React.ReactNode; at?: number; left?: boolean}> = ({children, at = 0, left = false}) => {
  const frame = useCurrentFrame();
  return (
    <div
      style={{
        position: 'absolute',
        [left ? 'left' : 'right']: 36,
        bottom: 32,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '9px 18px 12px 14px',
        background: C.ink,
        border: `${LINE - 1.5}px solid ${C.ink}`,
        color: C.white,
        opacity: ci(frame, [at, at + 8], [0, 1]),
        ...words(27, 700),
        letterSpacing: '0.01em',
      }}
    >
      <span style={{width: 14, height: 14, borderRadius: 7, background: C.accent, display: 'inline-block', marginTop: 3}} />
      {children}
    </div>
  );
};

/** Shown while the footage is ramped: the speed, and three chevrons that march at that speed. */
export const SpeedBadge: React.FC<{speed: number; show: number; top?: number}> = ({speed, show, top = 172}) => {
  const frame = useCurrentFrame();
  if (show <= 0.01) return null;
  const label = speed >= 3 ? `×${Math.round(speed)}` : `×${(Math.round(speed * 2) / 2).toFixed(1).replace(/\.0$/, '')}`;
  return (
    <div
      style={{
        position: 'absolute',
        right: 48,
        top,
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        padding: '10px 24px 14px 20px',
        background: C.ink,
        color: C.accent,
        transform: `translateY(${((1 - show) * -(top + 110)).toFixed(1)}px)`,
        ...words(64, 800),
        fontStretch: '75%',
      }}
    >
      <svg width={74} height={44} viewBox="0 0 74 44" style={{marginTop: 6}}>
        {[0, 1, 2].map((i) => (
          <path key={i} d={`M ${4 + i * 24} 4 L ${22 + i * 24} 22 L ${4 + i * 24} 40`} fill="none" stroke={C.accent} strokeWidth={7} opacity={(Math.floor(frame / 3) + 3 - i) % 3 === 0 ? 1 : 0.35} />
        ))}
      </svg>
      <span style={{minWidth: 96, textAlign: 'right', fontVariantNumeric: 'tabular-nums'}}>{label}</span>
    </div>
  );
};
