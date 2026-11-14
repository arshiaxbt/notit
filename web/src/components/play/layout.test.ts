import { describe, expect, it } from 'vitest';
import { SHORT_BELOW, PITCH_H_TWO_LINES, PITCH_ONE_LINE_FROM, COMPACT_BELOW, LINE_H, LINE_H_COMPACT, DOCK_H, DOCK_H_COMPACT, MAX_FACES, PITCH_H, PITCH_H_COMPACT, MAX_FACES_COMPACT, YOU_SCALE, pointsOnArc, sceneBoxFor, sceneLayout, stableOrder } from './layout';
import type { SceneLayout } from './layout';

const VIEWPORTS: Array<[number, number]> = [
  [360, 560], // shorter than any phone we aim at: the stage is at its minimum height
  [360, 640],
  [390, 844],
  [768, 1024],
  [844, 390], // a phone on its side
  [1280, 800],
];
const COUNTS = [0, 1, 2, 3, 6, 9, 10, 12, 17, 24, 60];

function circles(l: SceneLayout) {
  const out = l.slots.map((p) => ({ ...p, r: l.faceR, what: 'face' }));
  if (l.more) out.push({ ...l.more, r: l.faceR, what: 'more' });
  out.push({ ...l.you, r: l.youR, what: 'you' });
  return out;
}

describe('ring layout', () => {
  for (const [vw, vh] of VIEWPORTS) {
    const box = sceneBoxFor(vw, vh);
    for (const count of COUNTS) {
      it(`${count} holders at ${vw}×${vh}: no overlaps, nothing outside the box`, () => {
        // A short, wide stage drops the sentence and the line and uses a smaller button (see Scene).
        const short = box.w >= COMPACT_BELOW && box.h < SHORT_BELOW;
        const room = short ? { pitchH: 6, dockH: 62, lineH: 4 } : {};
        const l = sceneLayout(box, count, room);
        const all = circles(l);
        // Faces never overlap each other or your own face.
        for (let i = 0; i < all.length; i++) {
          for (let k = i + 1; k < all.length; k++) {
            const d = Math.hypot(all[i]!.x - all[k]!.x, all[i]!.y - all[k]!.y);
            expect(d, `${all[i]!.what} ${i} vs ${all[k]!.what} ${k}`).toBeGreaterThanOrEqual(all[i]!.r + all[k]!.r);
          }
        }
        // Everything stays inside the scene, under the sentence at the top.
        const pitch = short ? 6 : box.w < COMPACT_BELOW ? PITCH_H_COMPACT : box.w < PITCH_ONE_LINE_FROM ? PITCH_H_TWO_LINES : PITCH_H;
        for (const c of all) {
          expect(c.x - c.r).toBeGreaterThanOrEqual(0);
          expect(c.x + c.r).toBeLessThanOrEqual(box.w);
          expect(c.y - c.r).toBeGreaterThanOrEqual(pitch);
          expect(c.y + c.r).toBeLessThanOrEqual(box.h);
        }
        expect(l.center.y - l.clockR).toBeGreaterThanOrEqual(pitch);
        // The line under the clock clears your face.
        expect(l.center.y + l.clockR + (short ? 4 : box.w < COMPACT_BELOW ? LINE_H_COMPACT : LINE_H)).toBeLessThanOrEqual(l.you.y - l.youR + 0.001);
        // The line fits between the faces at its height, and is wide enough for a short name.
        const lineH = short ? 4 : box.w < COMPACT_BELOW ? LINE_H_COMPACT : LINE_H;
        const lineY = l.center.y + l.clockR + lineH / 2;
        for (const p of l.slots) {
          if (Math.abs(p.y - lineY) < l.faceR + lineH / 2) expect(Math.abs(p.x - l.center.x) - l.faceR).toBeGreaterThanOrEqual(l.lineW / 2);
        }
        // On anything as tall as a small phone the clock keeps a readable size and the line a name.
        if (vh >= 640 && !short) {
          expect(l.lineW).toBeGreaterThanOrEqual(120);
          expect(l.clockR).toBeGreaterThanOrEqual(64);
        }
        expect(l.clockR).toBeGreaterThanOrEqual(36);
        // The clock ring sits inside the ring of faces, and the middle seat inside the clock.
        for (const p of l.slots) {
          expect(Math.hypot(p.x - l.center.x, p.y - l.center.y)).toBeGreaterThanOrEqual(l.clockR + l.faceR);
        }
        expect(Math.hypot(l.seat.x - l.center.x, l.seat.y - l.center.y) + l.seatR).toBeLessThan(l.clockR);
        expect(l.seatR).toBeLessThanOrEqual(l.faceR);
        expect(l.faceR).toBeGreaterThanOrEqual(10);
        // Your face is 1.6 times the others and sits above the space kept for the button.
        expect(l.youR).toBeCloseTo(l.faceR * YOU_SCALE, 5);
        expect(l.you.y + l.youR).toBeLessThanOrEqual(box.h - (short ? 62 : box.w < COMPACT_BELOW ? DOCK_H_COMPACT : DOCK_H));
      });
    }
  }

  it('gives every holder a face up to the cap, then a "+N" face', () => {
    const wide = sceneLayout(sceneBoxFor(1280, 800), 17);
    expect(wide.compact).toBe(false);
    expect(wide.shown).toBe(17);
    expect(wide.extra).toBe(0);
    expect(wide.more).toBeNull();
    expect(sceneLayout(sceneBoxFor(1280, 800), 60).shown).toBe(MAX_FACES);

    const phone = sceneLayout(sceneBoxFor(390, 844), 17);
    expect(phone.compact).toBe(true);
    expect(phone.shown).toBe(MAX_FACES_COMPACT);
    expect(phone.extra).toBe(5);
    expect(phone.more).not.toBeNull();
  });

  it("keeps six o'clock free for your own face", () => {
    for (const [vw, vh] of VIEWPORTS) {
      const l = sceneLayout(sceneBoxFor(vw, vh), 24);
      expect(l.you.x).toBeCloseTo(l.center.x, 5);
      expect(l.you.y).toBeGreaterThan(l.center.y + l.clockR);
      // The nearest faces leave more room beside you than they leave each other.
      const beside = Math.min(...l.slots.map((p) => Math.hypot(p.x - l.you.x, p.y - l.you.y) - l.faceR - l.youR));
      expect(beside).toBeGreaterThan(8);
    }
    // A wide oval on a desktop, a tall one on a phone.
    const wide = sceneLayout(sceneBoxFor(1280, 800), 24);
    expect(wide.rx).toBeGreaterThan(wide.ry);
    const phone = sceneLayout(sceneBoxFor(390, 844), 12);
    expect(phone.ry).toBeGreaterThan(phone.rx);
  });

  it('draws a handful of faces on a tighter ring, with the clock still about 40% of it', () => {
    const box = sceneBoxFor(1280, 800);
    const full = sceneLayout(box, 16);
    const few = sceneLayout(box, 6);
    expect(few.rx).toBeLessThan(full.rx * 0.8);
    expect(few.ry).toBeLessThan(full.ry);
    expect(few.faceR).toBeGreaterThanOrEqual(full.faceR - 2);
    // Your face does not move: the button stays right under it.
    expect(few.you.y + few.youR).toBeCloseTo(box.h - DOCK_H - 8, 5);
    for (const l of [full, few]) {
      const share = (2 * l.clockR) / (l.rx + l.ry);
      expect(share).toBeGreaterThan(0.3);
      expect(share).toBeLessThan(0.5);
    }
    const phone = sceneLayout(sceneBoxFor(390, 844), 5);
    expect(phone.ry).toBeLessThan(sceneLayout(sceneBoxFor(390, 844), 12).ry);
  });

  it('keeps people in their places when the crowd changes', () => {
    expect(stableOrder([], ['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
    // b leaves, d arrives: d takes b's place, a and c stay put.
    expect(stableOrder(['a', 'b', 'c'], ['c', 'a', 'd'])).toEqual(['a', 'd', 'c']);
    // Nobody arrives: the gap closes.
    expect(stableOrder(['a', 'b', 'c'], ['a', 'c'])).toEqual(['a', 'c']);
    expect(stableOrder(['a'], ['a', 'x', 'y'])).toEqual(['a', 'x', 'y']);
  });

  it('is stable: the same input gives the same positions', () => {
    const box = sceneBoxFor(1280, 800);
    expect(sceneLayout(box, 17)).toEqual(sceneLayout(box, 17));
  });

  it('spaces points evenly by arc length', () => {
    const pts = pointsOnArc({ x: 0, y: 0 }, 200, 100, 0, 2 * Math.PI, 8, true);
    expect(pts).toHaveLength(8);
    expect(pts[0]!.x).toBeCloseTo(0, 5);
    expect(pts[0]!.y).toBeCloseTo(-100, 5);
    const gaps = pts.map((p, i) => Math.hypot(p.x - pts[(i + 1) % 8]!.x, p.y - pts[(i + 1) % 8]!.y));
    // Chords differ on an ellipse, but none is wildly longer than another.
    expect(Math.max(...gaps) / Math.min(...gaps)).toBeLessThan(1.4);
    // An open arc is symmetric and a single point sits in its middle.
    const one = pointsOnArc({ x: 0, y: 0 }, 200, 100, Math.PI + 0.3, 3 * Math.PI - 0.3, 1, false);
    expect(one[0]!.x).toBeCloseTo(0, 0);
    expect(one[0]!.y).toBeCloseTo(-100, 0);
  });
});
