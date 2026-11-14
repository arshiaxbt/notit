import React from 'react';
import {useCurrentFrame, useVideoConfig} from 'remotion';
import {ci, pop} from '../anim';
import {nums} from '../tokens';

/**
 * A big condensed numeral. The value is printed as given (it comes from timeline.json) and lands whole, on a
 * spring: no count-up, so no in-between figure that never existed and no half-drawn glyph is ever on screen.
 */
export const Numeral: React.FC<{text: string; at: number; size?: number; color?: string}> = ({text, at, size = 220, color}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const t = pop(frame, at, fps);
  return (
    <div
      style={{
        color,
        whiteSpace: 'nowrap',
        transformOrigin: '0% 60%',
        transform: `scale(${(0.72 + 0.28 * t).toFixed(4)})`,
        opacity: ci(frame, [at, at + 2], [0, 1]),
        ...nums(size),
        lineHeight: 0.95,
      }}
    >
      {text}
    </div>
  );
};
