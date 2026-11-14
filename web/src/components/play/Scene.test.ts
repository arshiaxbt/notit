import { describe, expect, it } from 'vitest';
import { ManualClock } from '../../client/clock';
import { DEMO_ACCOUNT, MockClient } from '../../client/MockClient';
import { STRATEGIES, DEFAULT_CROWD } from '../../client/bots';
import { fetchSnapshot } from '../../hooks/useGame';
import type { GameSnapshot } from '../../hooks/useGame';
import { isAsleep, peopleFor } from './Scene';

const START = 1_800_000_000n * 1_000_000_000n;

async function demo(opts: ConstructorParameters<typeof MockClient>[0] = {}) {
  const clock = new ManualClock(START);
  const mock = new MockClient({ clock, seed: 3, ...opts });
  const config = await mock.getConfig();
  const snap = () => fetchSnapshot(mock, config);
  return { clock, mock, config, snap };
}

describe('who stands on the ring', () => {
  it('Demo: every simulated holder, without you, each with a balance share', async () => {
    const { mock, snap } = await demo();
    const s = await snap();
    const people = peopleFor(s, mock.crowd());
    expect(people).toHaveLength(mock.crowd().length);
    expect(people.some((p) => p.id === DEMO_ACCOUNT)).toBe(false);
    expect(people.every((p) => p.name !== null && /%$/.test(p.note))).toBe(true);
    // It is one of them, so its face can move to the middle seat.
    expect(s.state.it === null || s.state.it === DEMO_ACCOUNT || people.some((p) => p.id === s.state.it)).toBe(true);
  });

  it('on chain: the accounts it can name, then plain faces up to the number of claims, never more than 24', async () => {
    const { snap } = await demo();
    const s = await snap();
    const named = s.heroes.filter((h) => h.accountId !== s.accountId).length;
    const people = peopleFor(s, null);
    expect(people.length).toBe(Math.max(named, Math.min(s.state.claimsMade, 24)));
    expect(people.filter((p) => p.name !== null)).toHaveLength(Math.min(named, 24));
    expect(people.filter((p) => p.name === null).every((p) => p.id.startsWith('anon-'))).toBe(true);

    const crowded: GameSnapshot = { ...s, state: { ...s.state, claimsMade: 500 } };
    expect(peopleFor(crowded, null)).toHaveLength(24);

    // Your own claim is your own face, not one more on the ring.
    const mine: GameSnapshot = { ...s, account: { ...s.account!, claimed: true }, state: { ...s.state, claimsMade: named + 3 } };
    expect(peopleFor(mine, null)).toHaveLength(named + 2);
  });

  it('keeps It on the ring list even when the hero list has not caught up', async () => {
    const { snap } = await demo();
    const s = await snap();
    const stranger: GameSnapshot = { ...s, state: { ...s.state, it: 'late.testnet' }, heroes: s.heroes.filter((h) => h.accountId !== 'late.testnet') };
    expect(peopleFor(stranger, null)[0]!.id).toBe('late.testnet');
  });
});

describe('asleep', () => {
  it('is false while rounds are being charged and true after the run of unsaved rounds hits its limit', async () => {
    const quiet = DEFAULT_CROWD.map((b) => ({ ...b, strategy: STRATEGIES.freeRider }));
    const { clock, mock, config, snap } = await demo({ crowd: quiet });
    await mock.claim();
    let s = await snap();
    expect(isAsleep(s)).toBe(false);
    const done = await mock.volunteer({ round: s.state.round, maxCost: s.state.costNow * 2n + 1n });
    expect(done.ok).toBe(true);
    s = await snap();
    expect(s.state.it).toBe(DEMO_ACCOUNT);
    expect(isAsleep(s)).toBe(false); // saved round
    for (let i = 0; i < config.maxCollapseRun; i++) {
      clock.advanceNs(config.roundNs);
      s = await snap();
      expect(isAsleep(s)).toBe(false);
    }
    clock.advanceNs(config.roundNs);
    s = await snap();
    expect(s.state.collapseRun).toBe(config.maxCollapseRun);
    expect(s.state.armed).toBe(false);
    expect(isAsleep(s)).toBe(true);
  });
});
