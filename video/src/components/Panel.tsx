import React from 'react';
import {useCurrentFrame, useVideoConfig} from 'remotion';
import {ci, E, pop} from '../anim';
import {C, LINE, nums, words} from '../tokens';

/** A line of type on the ink panel that rises in at `at` and leaves at `out`. */
export const Rise: React.FC<{at: number; out?: number; children: React.ReactNode; style?: React.CSSProperties}> = ({at, out, children, style}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const t = pop(frame, at, fps, false);
  const leave = out === undefined ? 0 : ci(frame, [out, out + 6], [0, 1], E.in);
  if (frame < at) return null;
  return (
    <div style={{overflow: 'hidden', padding: '0.1em 0 0.16em', margin: '-0.1em 0 -0.16em'}}>
      <div style={{transform: `translateY(${((1 - t) * 105 - leave * 115).toFixed(2)}%)`, ...style}}>{children}</div>
    </div>
  );
};

/** The ink column beside a plate: type set large, one idea. */
export const PanelColumn: React.FC<{left: number; width?: number; children: React.ReactNode; top?: number; gap?: number; justify?: 'center' | 'flex-start'}> = ({left, width = 620, children, gap = 26, justify = 'center', top = 0}) => (
  <div style={{position: 'absolute', left, top, width, height: 1080 - top, display: 'flex', flexDirection: 'column', justifyContent: justify, gap, color: C.white}}>{children}</div>
);

/** A transaction hash, a round number: small facts in an outlined chip. */
export const Chip: React.FC<{children: React.ReactNode; color?: string}> = ({children, color = C.white}) => (
  <span style={{display: 'inline-block', padding: '8px 20px 12px', border: `${LINE - 1}px solid ${color}`, borderRadius: 18, color, ...nums(38, 700), letterSpacing: '0.01em'}}>{children}</span>
);

export const label = (size = 50): React.CSSProperties => ({...words(size, 800), lineHeight: 1.08});
