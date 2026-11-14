import React from 'react';
import {useCurrentFrame, useVideoConfig} from 'remotion';
import {ci, E, pop} from '../anim';

export interface LineSpec {
  text: string;
  /** Frame the first word of this line starts to rise. */
  at: number;
  /** Frames between words. */
  step?: number;
  style?: React.CSSProperties;
}

/**
 * Kinetic type: each word rises out of its own mask on a spring, and the block leaves upward through the same masks.
 * Words are laid out by the browser, so line widths are the font's own.
 */
export const Kinetic: React.FC<{
  lines: readonly LineSpec[];
  /** Frame the block starts to leave; omit to stay. */
  out?: number;
  outStep?: number;
  style?: React.CSSProperties;
  align?: 'center' | 'left' | 'right';
  gap?: number;
}> = ({lines, out, outStep = 2, style, align = 'center', gap = 0}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  return (
    <div style={{display: 'flex', flexDirection: 'column', alignItems: align === 'center' ? 'center' : align === 'left' ? 'flex-start' : 'flex-end', gap, ...style}}>
      {lines.map((line, li) => {
        const wordsOf = line.text.split(' ');
        return (
          <div key={li} style={{display: 'flex', whiteSpace: 'pre', ...line.style}}>
            {wordsOf.map((w, wi) => {
              const start = line.at + wi * (line.step ?? 3);
              const rise = pop(frame, start, fps);
              const leave = out === undefined ? 0 : ci(frame, [out + li * outStep, out + li * outStep + 7], [0, 1], E.in);
              const y = (1 - rise) * 108 - leave * 112;
              return (
                <span key={wi} style={{display: 'inline-block', overflow: 'hidden', padding: '0.12em 0.02em 0.18em', margin: '-0.12em -0.02em -0.18em'}}>
                  <span style={{display: 'inline-block', transform: `translateY(${y.toFixed(2)}%)`, opacity: frame < start ? 0 : 1}}>
                    {w}
                    {wi < wordsOf.length - 1 ? ' ' : ''}
                  </span>
                </span>
              );
            })}
          </div>
        );
      })}
    </div>
  );
};
