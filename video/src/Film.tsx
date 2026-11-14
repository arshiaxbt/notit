import React from 'react';
import {AbsoluteFill, Sequence, useCurrentFrame} from 'remotion';
import {ci, E} from './anim';
import './fonts';
import {ColdOpen, COLD_OPEN_FRAMES} from './scenes/ColdOpen';
import {EndCard, END_CARD_FRAMES} from './scenes/EndCard';
import {Real, REAL_FRAMES} from './scenes/Real';
import {Why, WHY_FRAMES} from './scenes/Why';
import {C} from './tokens';

/** The end card opens through an iris over the last frames of the lab. */
const IRIS = 14;
const END_AT = COLD_OPEN_FRAMES + REAL_FRAMES + WHY_FRAMES - IRIS;
export const FILM_FRAMES = END_AT + END_CARD_FRAMES;

const Iris: React.FC<{children: React.ReactNode}> = ({children}) => {
  const frame = useCurrentFrame();
  const r = ci(frame, [0, IRIS], [0, 1140], E.inOut);
  return <AbsoluteFill style={{clipPath: frame >= IRIS ? undefined : `circle(${r.toFixed(1)}px at 960px 540px)`}}>{children}</AbsoluteFill>;
};

export const Film: React.FC = () => {
  return (
    <AbsoluteFill style={{backgroundColor: C.ink}}>
      <Sequence name="Cold open" durationInFrames={COLD_OPEN_FRAMES}>
        <ColdOpen />
      </Sequence>
      <Sequence name="The real thing" from={COLD_OPEN_FRAMES} durationInFrames={REAL_FRAMES}>
        <Real />
      </Sequence>
      <Sequence name="Why it holds" from={COLD_OPEN_FRAMES + REAL_FRAMES} durationInFrames={WHY_FRAMES}>
        <Why />
      </Sequence>
      <Sequence name="End card" from={END_AT} durationInFrames={END_CARD_FRAMES}>
        <Iris>
          <EndCard />
        </Iris>
      </Sequence>
    </AbsoluteFill>
  );
};
