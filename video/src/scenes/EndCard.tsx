import React from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig} from 'remotion';
import {ci, E, pop} from '../anim';
import {Face} from '../components/Face';
import {Kinetic} from '../components/Kinetic';
import {C, FONT, H, LINE, W, words} from '../tokens';

export const END_CARD_FRAMES = 190;

const RING = {x: 500, y: 540, r: 330, n: 12, faceR: 48};

/**
 * The ring again: everyone looking away, It in the middle looking at you. Wordmark, where to find it,
 * and what it is not (mainnet, money). Everything has landed by frame 100; the rest is a clean hold.
 */
export const EndCard: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const rise = (at: number) => ({
    opacity: ci(frame, [at, at + 6], [0, 1]),
    transform: `translateY(${((1 - pop(frame, at, fps, false)) * 26).toFixed(2)}px)`,
  });
  const box = pop(frame, 22, fps);
  return (
    <AbsoluteFill style={{backgroundColor: C.accent, color: C.ink, fontFamily: FONT}}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{position: 'absolute', inset: 0}}>
        {Array.from({length: RING.n}, (_, i) => {
          const t = ((i + 0.5) / RING.n) * 2 * Math.PI;
          const ux = Math.sin(t);
          const uy = -Math.cos(t);
          // Faces arrive looking at It, then, as It looks up, away.
          const away = pop(frame, 30 + (i % 4) * 0.7, fps) * 2 - 1;
          // One of them checks whether It is still looking. It is.
          const glance = i === 9 ? ci(frame, [92, 96, 112, 115], [0, 1, 1, 0], E.inOut) : 0;
          const g = away * (1 - 1.9 * glance);
          const flinch = ci(frame, [30, 33, 42], [0, 1, 0], E.out) * 10;
          return <Face key={i} x={RING.x + ux * (RING.r + flinch)} y={RING.y + uy * (RING.r + flinch)} r={RING.faceR} gx={ux * g} gy={uy * g} scale={pop(frame, 2 + i * 1.2, fps)} />;
        })}
        <Face x={RING.x} y={RING.y} r={104} it scale={pop(frame, 16, fps)} blink={ci(frame, [24, 27, 30], [1, 1, 0]) + ci(frame, [120, 123, 126], [0, 1, 0])} />
      </svg>
      <div style={{position: 'absolute', left: 990, top: 272, width: 800}}>
        <div style={{display: 'flex', alignItems: 'center', gap: 34, ...words(210)}}>
          <Kinetic lines={[{text: 'Not', at: 14, style: words(210)}]} align="left" />
          <span
            style={{
              display: 'inline-block',
              padding: '0px 34px 14px',
              background: C.white,
              border: `${LINE * 2}px solid ${C.ink}`,
              borderRadius: 40,
              transform: `rotate(${(-5 * box).toFixed(2)}deg) scale(${box.toFixed(4)})`,
            }}
          >
            It
          </span>
        </div>
        <div style={{marginTop: 56, ...words(47, 700), letterSpacing: '-0.01em', ...rise(34)}}>$NOTIT · built at NEAR HACKATHON</div>
        <div style={{marginTop: 40, display: 'inline-block', padding: '20px 34px 24px', background: C.ink, color: C.accent, borderRadius: 18, ...words(54, 800), letterSpacing: '-0.01em', ...rise(42)}}>
          arshiaxbt.github.io/notit
        </div>
        <div style={{marginTop: 40, ...words(38, 600), letterSpacing: '-0.005em', ...rise(50)}}>testnet · test tokens · no value</div>
      </div>
      <div style={{position: 'absolute', right: 130, bottom: 110, ...words(30, 600), letterSpacing: 0, ...rise(60)}}>made by @0xarshia</div>
    </AbsoluteFill>
  );
};
