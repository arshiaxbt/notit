import {STAGE} from './poi';
import {H, W} from './tokens';

export interface Cam {
  /** Centre of the view, in CSS px of the app's 1280×720 viewport. */
  x: number;
  y: number;
  /** Screen px per CSS px. 1.5 shows the whole viewport in a 1920-wide window. */
  z: number;
}

/** The view that fills the frame with the yellow stage alone: the first frame of the plate after the cold open. */
export const stageCam = (): Cam => {
  const h = STAGE.bottom - STAGE.top;
  return {x: 640, y: (STAGE.top + STAGE.bottom) / 2, z: H / h};
};

export const toScreen = (p: {x: number; y: number}, cam: Cam, win = {x: 0, y: 0, w: W, h: H}): {x: number; y: number} => ({
  x: win.x + win.w / 2 + (p.x - cam.x) * cam.z,
  y: win.y + win.h / 2 + (p.y - cam.y) * cam.z,
});
