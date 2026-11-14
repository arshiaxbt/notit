import React from 'react';
import {Freeze, OffthreadVideo, staticFile} from 'remotion';
import type {Clip} from '../footage';
import {STANDIN} from '../footage';
import type {Cam} from '../stage';
import {C, FONT} from '../tokens';

export interface Win {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The plates come out of the decode about three levels (1.2 %) under the page's own colours (the stage reads
 * #fcd407 for #ffd60a, the paper #f1f1e8 for #f4f2ec). This gain puts them back, so a cut between a plate and
 * the motion graphics does not step.
 */
const PLATE_GAIN = 1.012;

export const FULL: Win = {x: 0, y: 0, w: 1920, h: 1080};

/** Keep the view inside the plate, so the window never shows past its edge. */
export const clampCam = (cam: Cam, win: Win, clip: Clip): Cam => {
  const cssW = clip.w / clip.dpr;
  const cssH = clip.h / clip.dpr;
  const z = Math.max(cam.z, win.w / cssW, win.h / cssH);
  const hx = win.w / (2 * z);
  const hy = win.h / (2 * z);
  return {z, x: Math.min(cssW - hx, Math.max(hx, cam.x)), y: Math.min(cssH - hy, Math.max(hy, cam.y))};
};

/**
 * Footage behind a virtual camera. `src` is the frame of the clip to show (the scene owns time, so ramps are
 * exact: the video is frozen and trimmed to that one frame). `cam` is in the app's CSS px; `win` is the
 * window on screen. At rest the plate sits on whole pixels; it moves on sub-pixels only while the camera does.
 */
export const Plate: React.FC<{clip: Clip; src: number; cam: Cam; win?: Win; moving?: boolean}> = ({clip, src, cam: rawCam, win = FULL, moving = false}) => {
  const cam = clampCam(rawCam, win, clip);
  const s = cam.z / clip.dpr;
  const left = win.w / 2 - cam.x * cam.z;
  const top = win.h / 2 - cam.y * cam.z;
  const q = (v: number) => (moving ? v.toFixed(3) : String(Math.round(v)));
  const frameInFile = clip.offset + Math.max(0, Math.min(clip.frames - 1, Math.round(src)));
  return (
    <div style={{position: 'absolute', left: Math.round(win.x), top: Math.round(win.y), width: Math.round(win.w), height: Math.round(win.h), overflow: 'hidden', backgroundColor: C.paper}}>
      <Freeze frame={0}>
        <OffthreadVideo
          src={staticFile(clip.file)}
          trimBefore={frameInFile}
          muted
          style={{position: 'absolute', left: 0, top: 0, width: clip.w, height: clip.h, maxWidth: 'none', transformOrigin: '0 0', filter: `brightness(${PLATE_GAIN})`, transform: `translate(${q(left)}px, ${q(top)}px) scale(${s.toFixed(5)})`}}
        />
      </Freeze>
      {STANDIN && (
        <div style={{position: 'absolute', right: 24, top: 24, padding: '8px 16px', background: C.cut, color: C.white, fontFamily: FONT, fontWeight: 800, fontSize: 30}}>STAND-IN FOOTAGE · not final</div>
      )}
    </div>
  );
};
