/**
 * Where everything in the ring scene goes. Pure functions of the scene's box
 * and the number of holders: one coordinate system (pixels from the scene's
 * top-left corner) shared by the faces, the clock ring and the coins.
 */

export interface Box {
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface SceneLayout {
  /** Narrow screens: a tall oval and fewer faces. */
  compact: boolean;
  /** Centre of the clock ring and of the ellipse the faces sit on. */
  center: Point;
  rx: number;
  ry: number;
  /** Outer radius of the clock ring. */
  clockR: number;
  /** Widest the line under the clock may be without touching a face. */
  lineW: number;
  /** The middle seat, where It sits. */
  seat: Point;
  seatR: number;
  /** Your face at six o'clock, 1.6 times the others. */
  you: Point;
  youR: number;
  faceR: number;
  /** One position per shown holder, in order. */
  slots: Point[];
  /** Where "+N" is written, when there are more holders than faces. */
  more: Point | null;
  /** Holders that get a face, and those folded into "+N". */
  shown: number;
  extra: number;
}

export const MAX_FACES = 24;
export const MAX_FACES_COMPACT = 12;
/** Height kept free at the bottom of the stage for the one button and the line under it. */
export const DOCK_H = 100;
export const DOCK_H_COMPACT = 112;
/** Height kept free at the top of the stage for the one sentence. */
export const PITCH_H = 46;
export const PITCH_H_COMPACT = 58;
export const PITCH_H_TWO_LINES = 68;
export const PITCH_ONE_LINE_FROM = 800;
/** Below this many faces the ring is drawn tighter, so it still reads as a ring. */
export const SPARSE_BELOW = 10;
/** Below this stage width the compact layout is used. */
export const COMPACT_BELOW = 620;
/** Your face against the others. */
export const YOU_SCALE = 1.6;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function onEllipse(c: Point, rx: number, ry: number, t: number): Point {
  // t = 0 is twelve o'clock, growing clockwise.
  return { x: c.x + rx * Math.sin(t), y: c.y - ry * Math.cos(t) };
}

/**
 * `n` points spaced evenly by arc length along the ellipse between two angles.
 * An open arc keeps half a space free at each end; a closed loop starts on `from`.
 */
export function pointsOnArc(c: Point, rx: number, ry: number, from: number, to: number, n: number, closed: boolean): Point[] {
  if (n <= 0) return [];
  const steps = 720;
  const ts: number[] = [];
  const len: number[] = [0];
  let prev = onEllipse(c, rx, ry, from);
  ts.push(from);
  for (let i = 1; i <= steps; i++) {
    const t = from + ((to - from) * i) / steps;
    const p = onEllipse(c, rx, ry, t);
    len.push(len[i - 1]! + Math.hypot(p.x - prev.x, p.y - prev.y));
    ts.push(t);
    prev = p;
  }
  const total = len[steps]!;
  const out: Point[] = [];
  let j = 0;
  for (let k = 0; k < n; k++) {
    const want = (total * (closed ? k : k + 0.5)) / n;
    while (j < steps && len[j + 1]! < want) j++;
    const span = len[j + 1]! - len[j]! || 1;
    const f = clamp((want - len[j]!) / span, 0, 1);
    out.push(onEllipse(c, rx, ry, ts[j]! + (ts[Math.min(steps, j + 1)]! - ts[j]!) * f));
  }
  return out;
}

/** Room under the clock for the one line that names It. */
export const LINE_H = 36;
export const LINE_H_COMPACT = 34;
const CLOCK_MIN = 72;
const CLOCK_SMALL = 62;

function fit(box: Box, holders: number, maxFace: number): SceneLayout {
  const compact = box.w < COMPACT_BELOW;
  const cap = compact ? MAX_FACES_COMPACT : MAX_FACES;
  const shown = Math.max(0, Math.min(holders, cap));
  const extra = Math.max(0, holders - shown);
  const n = shown + (extra > 0 ? 1 : 0);
  const sparse = n < SPARSE_BELOW;
  const pad = compact ? 10 : 20;
  const dockH = compact ? DOCK_H_COMPACT : DOCK_H;
  // The sentence takes two lines on anything narrower than a laptop.
  const pitchH = compact ? PITCH_H_COMPACT : box.w < PITCH_ONE_LINE_FROM ? PITCH_H_TWO_LINES : PITCH_H;
  const lineH = compact ? LINE_H_COMPACT : LINE_H;
  const cx = box.w / 2;

  let faceR = maxFace;
  let youR = faceR * YOU_SCALE;
  let cy = box.h / 2;
  let rx = 1;
  let ry = 1;
  let points: Point[] = [];
  // The face size depends on the spacing and the spacing on the face size: settle in a few passes.
  for (let pass = 0; pass < 5; pass++) {
    youR = faceR * YOU_SCALE;
    const top = pitchH + faceR + 4;
    // Your face is fixed just above the button; the ring hangs from it.
    const bottom = box.h - dockH - youR - 8;
    const ryFull = Math.max(60, (bottom - top) / 2);
    const rxMax = Math.max(60, box.w / 2 - pad - faceR);
    if (compact) {
      rx = rxMax;
      ry = sparse ? Math.min(ryFull, Math.max(rx, rx * (1.1 + 0.05 * n), CLOCK_MIN + lineH + youR)) : ryFull;
    } else {
      // A handful of faces on a full-size ellipse are scattered dots: pull them in.
      // ...but never so far that the clock and its line no longer fit above your face.
      ry = sparse ? Math.min(ryFull, Math.max(ryFull * (0.72 + 0.028 * n), CLOCK_MIN + lineH + youR)) : ryFull;
      rx = Math.min(rxMax, ry * (sparse ? 1.6 : 1.95));
    }
    cy = bottom - ry;
    // Six o'clock is yours: the ring opens either side of your face.
    const gap = Math.asin(Math.min(1, (youR + faceR + 14) / rx));
    points = pointsOnArc({ x: cx, y: cy }, rx, ry, Math.PI + gap, 3 * Math.PI - gap, n, false);
    let spacing = Infinity;
    for (let i = 0; i < points.length; i++) {
      for (let k = i + 1; k < points.length; k++) {
        spacing = Math.min(spacing, Math.hypot(points[i]!.x - points[k]!.x, points[i]!.y - points[k]!.y));
      }
    }
    const next = clamp(Math.floor(spacing / 2 - 4), 10, maxFace);
    if (next === faceR) break;
    faceR = next;
  }
  youR = faceR * YOU_SCALE;

  const center = { x: cx, y: cy };
  const reach = Math.min(rx, ry);
  // About 40% of the crowd, inside the ring of faces, and leaving room for the line above your face.
  const clockR = Math.max(48, Math.min(clamp(reach * 0.54, 78, 150), reach - faceR - 12, ry - youR - lineH));
  // How wide that line may be: it runs between the faces that sit at its height.
  const lineY = cy + clockR + lineH / 2;
  let lineW = box.w - 2 * pad;
  for (const p of points) {
    if (Math.abs(p.y - lineY) < faceR + lineH / 2) lineW = Math.min(lineW, 2 * (Math.abs(p.x - cx) - faceR - 4));
  }
  lineW = Math.max(60, lineW);
  const seatR = Math.min(faceR, clockR * 0.27);
  return {
    compact,
    center,
    rx,
    ry,
    clockR,
    seat: { x: cx, y: cy + clockR * 0.42 },
    seatR,
    lineW,
    you: { x: cx, y: cy + ry },
    youR,
    faceR,
    slots: points.slice(0, shown),
    more: extra > 0 ? (points[shown] ?? null) : null,
    shown,
    extra,
  };
}

/** `holders` is the number of faces on the ring: everyone but you and whoever sits in the middle. */
export function sceneLayout(box: Box, holders: number): SceneLayout {
  const compact = box.w < COMPACT_BELOW;
  const sparse = Math.min(holders, compact ? MAX_FACES_COMPACT + 1 : MAX_FACES) < SPARSE_BELOW;
  let maxFace = compact ? (sparse ? 24 : 20) : sparse ? 32 : 30;
  let layout = fit(box, holders, maxFace);
  // On a short stage the faces give way first, then the clock a little, then the faces again.
  while (layout.clockR < CLOCK_MIN && maxFace > 18) {
    maxFace -= 2;
    layout = fit(box, holders, maxFace);
  }
  while (layout.clockR < CLOCK_SMALL && maxFace > 14) {
    maxFace -= 2;
    layout = fit(box, holders, maxFace);
  }
  return layout;
}

/**
 * Keeps every holder in the place they had: someone who leaves frees a place,
 * a newcomer takes the first free one, and nobody else moves.
 */
export function stableOrder(prev: string[], ids: string[]): string[] {
  const want = new Set(ids);
  const kept = new Set<string>();
  const out: Array<string | null> = prev.map((id) => {
    if (!want.has(id) || kept.has(id)) return null;
    kept.add(id);
    return id;
  });
  const fresh = ids.filter((id) => !kept.has(id));
  for (let i = 0; i < out.length && fresh.length > 0; i++) {
    if (out[i] === null) out[i] = fresh.shift()!;
  }
  return [...out.filter((id): id is string => id !== null), ...fresh];
}

/** The stage's box for a viewport, following the same rules as the stylesheet. Used by tests. */
export function sceneBoxFor(viewportW: number, viewportH: number): Box {
  // header: 95 px on a desktop, 134 px on a phone
  if (viewportW < COMPACT_BELOW) return { w: viewportW, h: clamp(viewportH - 134, 440, 720) };
  return { w: viewportW, h: clamp(viewportH - 95 - 85, 480, 760) };
}
