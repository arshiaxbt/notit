import {Easing, interpolate, spring} from 'remotion';

export const E = {
  /** Lands softly: for things arriving. */
  out: Easing.bezier(0.16, 1, 0.3, 1),
  /** Camera moves. */
  inOut: Easing.bezier(0.65, 0, 0.35, 1),
  /** Leaves quickly. */
  in: Easing.bezier(0.6, 0, 0.9, 0.3),
  /** A whip: slow start, hard land. */
  whip: Easing.bezier(0.8, 0, 0.1, 1),
  linear: (t: number) => t,
};

/** Clamped interpolate. */
export const ci = (f: number, input: readonly number[], output: readonly number[], easing?: (t: number) => number): number =>
  interpolate(f, input, output, {extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing});

/** A spring with very little overshoot, 0 → 1 starting at `start`. */
export const pop = (frame: number, start: number, fps: number, overshoot = true): number =>
  spring({frame: frame - start, fps, config: overshoot ? {damping: 15, stiffness: 190, mass: 0.7} : {damping: 200, stiffness: 170, mass: 0.7}});

export interface Key {
  f: number;
  v: readonly number[];
  /** Easing of the move that arrives at this key. */
  e?: (t: number) => number;
}

/** A keyframed vector: holds before the first key and after the last. */
export const track = (frame: number, keys: readonly Key[]): number[] => {
  const first = keys[0]!;
  if (frame <= first.f) return [...first.v];
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1]!;
    const b = keys[i]!;
    if (frame <= b.f) {
      const t = (b.e ?? E.inOut)((frame - a.f) / Math.max(1, b.f - a.f));
      return a.v.map((x, k) => x + (b.v[k]! - x) * t);
    }
  }
  return [...keys[keys.length - 1]!.v];
};

/**
 * Time remap: composition frame → source frame, through points [frame, source].
 * Between two points the source time follows a cubic with slope 1 (real time) at both ends,
 * so a fast stretch eases in and out of real time instead of jumping.
 * A segment whose slope is already 1 stays exactly real time.
 */
export const remap = (frame: number, pts: readonly (readonly [number, number])[]): number => {
  const first = pts[0]!;
  if (frame <= first[0]) return first[1] + (frame - first[0]);
  for (let i = 1; i < pts.length; i++) {
    const [f0, s0] = pts[i - 1]!;
    const [f1, s1] = pts[i]!;
    if (frame <= f1) {
      const d = f1 - f0;
      const t = (frame - f0) / d;
      if (Math.abs(s1 - s0 - d) < 0.5) return s0 + (frame - f0);
      const h00 = 2 * t ** 3 - 3 * t ** 2 + 1;
      const h10 = t ** 3 - 2 * t ** 2 + t;
      const h01 = -2 * t ** 3 + 3 * t ** 2;
      const h11 = t ** 3 - t ** 2;
      return h00 * s0 + h10 * d + h01 * s1 + h11 * d;
    }
  }
  const last = pts[pts.length - 1]!;
  return last[1] + (frame - last[0]);
};

/** Instantaneous speed of a remap, in source frames per frame. */
export const speedOf = (frame: number, pts: readonly (readonly [number, number])[]): number => remap(frame + 0.5, pts) - remap(frame - 0.5, pts);
