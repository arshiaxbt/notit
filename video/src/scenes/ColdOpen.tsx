import React from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig} from 'remotion';
import {ci, E, pop} from '../anim';
import {ClockRing} from '../components/ClockRing';
import {Coin} from '../components/Coin';
import {Face} from '../components/Face';
import {Kinetic} from '../components/Kinetic';
import {STAGE} from '../poi';
import {C, H, K, W, words} from '../tokens';
import {stageCam, toScreen} from '../stage';

export const COLD_OPEN_FRAMES = 164;

/** Beats, in frames. */
const T = {
  lookAway: 27,
  text1Out: 50,
  text2: 54,
  text2Out: 120,
  it: 122,
  coins: 126,
  ring: 136,
  glide: 138,
  burn: 146,
};

/**
 * 0–5.5 s, pure motion graphics on flat yellow. Faces pop onto a ring looking at you; the first sentence lands
 * and every face looks away. The second sentence; then what it means: every face pays the one in the middle.
 * The clock ring draws on round It, the faces glide into the formation of the real app, the fuse burns,
 * and the film cuts on the fuse to the plate.
 */
export const ColdOpen: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const cam = stageCam();
  const all = [...STAGE.faces, STAGE.you];
  const n = all.length;
  const centre = {x: W / 2, y: H / 2};

  // Formation A: one wide ellipse round the type. Formation B: where the app draws them on the plate.
  const A = all.map((_, i) => {
    // Order the wide ring by the angle each face has in the app, so nobody crosses the frame in the glide.
    const b = all[i]!;
    const ang = Math.atan2(b.x - STAGE.center.x, -(b.y - STAGE.center.y));
    return {ang, i};
  });
  const order = [...A].sort((p, q) => p.ang - q.ang).map((a) => a.i);
  const slotOf = new Map(order.map((idx, k) => [idx, k]));
  const glide = pop(frame, T.glide, fps, false);
  const seatS = toScreen(STAGE.seat, cam);
  const clockS = toScreen(STAGE.center, cam);
  const itAt = {x: centre.x + (seatS.x - centre.x) * glide, y: centre.y + (seatS.y - centre.y) * glide};
  const itR = 86 + (STAGE.seat.r * cam.z - 86) * glide;
  const itIn = pop(frame, T.it, fps);

  const faces = all.map((b, i) => {
    const k = slotOf.get(i)!;
    const t = -Math.PI + ((k + 0.5) / n) * 2 * Math.PI;
    const a = {x: centre.x + 800 * Math.sin(t), y: centre.y - 418 * Math.cos(t)};
    const bS = toScreen(b, cam);
    const isYou = i === n - 1;
    const rB = (isYou ? STAGE.you.r : STAGE.faceR) * cam.z;
    const x0 = a.x + (bS.x - a.x) * glide;
    const y0 = a.y + (bS.y - a.y) * glide;
    const r = 60 + (rB - 60) * glide;
    // Away from the middle of the frame.
    const dx = x0 - centre.x;
    const dy = y0 - centre.y;
    const d = Math.hypot(dx, dy) || 1;
    const ux = dx / d;
    const uy = dy / d;
    const enter = pop(frame, -16 + k * 1.2, fps);
    const away = pop(frame, T.lookAway + (k % 3) * 0.6, fps);
    // One face steals a glance at the middle, then thinks better of it.
    const glance = k === 4 ? ci(frame, [78, 82, 96, 99], [0, 1, 1, 0], E.inOut) : 0;
    const g = away * (1 - 1.9 * glance);
    // The flinch: a short recoil outward as everyone looks away, and again as the coin leaves.
    const flinch = ci(frame, [T.lookAway, T.lookAway + 3, T.lookAway + 12], [0, 1, 0], E.out) * 12 + ci(frame, [T.coins + k * 0.5, T.coins + k * 0.5 + 3, T.coins + k * 0.5 + 12], [0, 1, 0], E.out) * 10;
    // On the plate "you" look up at the clock; everyone else away from it.
    const youGaze = isYou ? glide : 0;
    return {
      x: x0 + ux * flinch,
      y: y0 + uy * flinch,
      r,
      gx: ux * g * (1 - youGaze),
      gy: uy * g * (1 - youGaze) - youGaze,
      scale: enter,
      k,
    };
  });

  const ringDraw = ci(frame, [T.ring, T.ring + 12], [0, 1], E.inOut);
  const burn = ci(frame, [T.burn, COLD_OPEN_FRAMES], [0, STAGE.p0], E.in);

  return (
    <AbsoluteFill style={{backgroundColor: C.accent}}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{position: 'absolute', inset: 0}}>
        {frame >= T.ring && <ClockRing cx={clockS.x} cy={clockS.y} r={STAGE.clockR * cam.z} p={burn} stroke={12 * cam.z} hair={2 * cam.z} tipR={7 * cam.z} draw={ringDraw} tip={frame >= T.burn} />}
        {faces.map((f, i) => (
          <Face key={i} x={f.x} y={f.y} r={f.r} gx={f.gx} gy={f.gy} scale={f.scale} line={3 * K + (3 * cam.z - 3 * K) * glide} />
        ))}
        {faces.map((f, i) => (
          <Coin key={i} frame={frame} start={T.coins + f.k * 0.5} dur={14} from={f} to={itAt} r={5 * cam.z} />
        ))}
        {frame >= T.it && <Face x={itAt.x} y={itAt.y} r={itR} it scale={itIn} wide={ci(frame, [T.coins + 10, T.coins + 16, T.coins + 30], [0, 1, 0])} line={3 * K} />}
      </svg>
      <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', color: C.ink}}>
        {frame < T.text2 + 4 && (
          <Kinetic
            out={T.text1Out}
            lines={[
              {text: 'Somebody has', at: 2, step: 4, style: words(196)},
              {text: 'to do it.', at: 10, step: 4, style: words(196)},
            ]}
            gap={6}
          />
        )}
      </AbsoluteFill>
      <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', color: C.ink}}>
        {frame >= T.text2 && frame < T.text2Out + 14 && (
          <Kinetic
            out={T.text2Out}
            lines={[
              {text: 'If nobody does,', at: T.text2, step: 3, style: words(116)},
              {text: 'everybody pays the', at: T.text2 + 11, step: 3, style: words(116)},
              {text: 'last person who did.', at: T.text2 + 19, step: 3, style: words(116)},
            ]}
            gap={10}
          />
        )}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
