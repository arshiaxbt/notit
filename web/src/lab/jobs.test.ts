import { describe, expect, it } from 'vitest';
import { bystanderRow, classicFailure, equilibriumFailure, runJob } from './jobs';

describe('the Lab against the equilibrium of the deployed rule', () => {
  it('only the first volunteer pays, so rounds go unsaved less often than in the textbook dilemma', () => {
    // About 20% at 30 holders, where the textbook formula (every volunteer pays) says about 40%.
    expect(equilibriumFailure(30)).toBeGreaterThan(0.15);
    expect(equilibriumFailure(30)).toBeLessThan(0.25);
    expect(classicFailure(30)).toBeGreaterThan(0.35);
    expect(classicFailure(30)).toBeLessThan(0.45);
    for (const n of [3, 8, 20, 45, 60]) expect(equilibriumFailure(n)).toBeLessThan(classicFailure(n));
    // More holders who could act, less chance anyone does.
    expect(equilibriumFailure(60)).toBeGreaterThan(equilibriumFailure(20));
    // Past the point where even the cheapest save costs more than an unsaved round, nobody volunteers.
    expect(equilibriumFailure(200)).toBe(1);
    expect(classicFailure(200)).toBe(1);
  });

  it('a simulated row carries the equilibrium it is compared with and the textbook figure', () => {
    const row = bystanderRow(30, 400, 'equilibrium', 11);
    expect(row.n).toBe(30);
    expect(row.equilibrium).toBeCloseTo(equilibriumFailure(30), 2);
    expect(row.classic).toBeCloseTo(classicFailure(30), 2);
    expect(row.p).toBeGreaterThan(0);
    expect(row.p).toBeLessThan(1);
    // The simulation plays that equilibrium: it lands near it, far from the textbook figure.
    expect(Math.abs(row.simulated - row.equilibrium)).toBeLessThan(0.08);
    expect(Math.abs(row.simulated - row.classic)).toBeGreaterThan(0.1);
    // Other behaviours are compared with the same two figures.
    const snipers = bystanderRow(30, 200, 'snipers', 11);
    expect(snipers.equilibrium).toBeCloseTo(row.equilibrium, 6);
    expect(snipers.classic).toBeCloseTo(row.classic, 6);
  });

  it('forward-looking holders: a bound of about 1.3%, and the scripted 200-holder run above it', () => {
    const r = runJob({ kind: 'forwardLooking' });
    expect(r.bound).toBeCloseTo(0.0132, 3);
    expect(r.runs.map((x) => x.holders)).toEqual([20, 50, 100, 200]);
    for (const run of r.runs) {
      expect(run.holderShare).toBeCloseTo(1 / run.holders, 9);
      expect(run.withinBound).toBe(run.unsavedRate <= r.bound);
    }
    expect(r.runs.find((x) => x.holders === 200)!.withinBound).toBe(false);
    expect(r.runs.find((x) => x.holders === 20)!.withinBound).toBe(true);
  });
});
