import React from 'react';
import {useCurrentFrame, useVideoConfig} from 'remotion';
import {Key, pop, remap, speedOf, track} from '../anim';
import type {Clip} from '../footage';
import type {Cam} from '../stage';
import {clampCam, Plate, Win} from './Plate';
import {SpeedBadge} from './Tag';

export interface ShotCtx {
  frame: number;
  cam: Cam;
  win: Win;
  /** A point of the app (CSS px) → where it is on screen now. */
  s: (p: {x: number; y: number}) => {x: number; y: number};
}

export const FULLKEY: Key[] = [{f: 0, v: [0, 0, 1920, 1080]}];

/**
 * One shot of footage: a clip, a time map (shot frame → clip frame), a keyframed camera [x, y, z] in the
 * app's CSS px and a keyframed window [x, y, w, h] on screen. Overlays get a function that follows the camera.
 * While the time map runs faster than real time, the speed badge is shown.
 */
export const Shot: React.FC<{
  clip: Clip;
  time: readonly (readonly [number, number])[];
  cam: readonly Key[];
  win?: readonly Key[];
  /** Where the speed badge sits, from the top of the frame. */
  badgeTop?: number;
  children?: (ctx: ShotCtx) => React.ReactNode;
}> = ({clip, time, cam: camKeys, win: winKeys = FULLKEY, badgeTop, children}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const at = (f: number) => {
    const [wx, wy, ww, wh] = track(f, winKeys) as [number, number, number, number];
    const win = {x: wx, y: wy, w: ww, h: wh};
    const [x, y, z] = track(f, camKeys) as [number, number, number];
    return {win, cam: clampCam({x, y, z}, win, clip)};
  };
  const now = at(frame);
  const prev = at(frame - 1);
  const next = at(frame + 1);
  const differs = (a: typeof now, b: typeof now) => a.cam.x !== b.cam.x || a.cam.y !== b.cam.y || a.cam.z !== b.cam.z || a.win.w !== b.win.w || a.win.x !== b.win.x || a.win.h !== b.win.h || a.win.y !== b.win.y;
  const moving = differs(now, prev) || differs(now, next);
  const src = remap(frame, time);
  // The badge: on from the first fast frame to the last.
  let first = -1;
  let last = -1;
  const lastKey = time[time.length - 1]![0];
  for (let f = time[0]![0]; f <= lastKey; f++) {
    if (speedOf(f, time) > 1.25) {
      if (first < 0) first = f;
      last = f;
    }
  }
  const show = first < 0 ? 0 : pop(frame, first, fps, false) * (1 - pop(frame, last + 1, fps, false));
  // One steady figure for the whole fast stretch: its average speed.
  const avg = first < 0 ? 1 : (remap(last + 1, time) - remap(first, time)) / (last + 1 - first);
  const s = (p: {x: number; y: number}) => ({x: now.win.x + now.win.w / 2 + (p.x - now.cam.x) * now.cam.z, y: now.win.y + now.win.h / 2 + (p.y - now.cam.y) * now.cam.z});
  return (
    <>
      <Plate clip={clip} src={src} cam={now.cam} win={now.win} moving={moving} />
      {children?.({frame, cam: now.cam, win: now.win, s})}
      <SpeedBadge speed={avg} show={show} top={badgeTop} />
    </>
  );
};
