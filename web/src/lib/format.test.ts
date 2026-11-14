import { describe, expect, it } from 'vitest';
import {
  formatCompact,
  formatCountdown,
  formatPpm,
  formatShare,
  formatTimeLeft,
  formatToken,
  shortAccount,
  spokenCountdown,
} from './format';

const U = 10n ** 18n;

describe('formatToken', () => {
  it('groups thousands and drops empty fractions', () => {
    expect(formatToken(1_000n * U)).toBe('1,000');
    expect(formatToken(1_234_567n * U)).toBe('1,234,567');
    expect(formatToken(0n)).toBe('0');
  });

  it('truncates instead of rounding up', () => {
    expect(formatToken(12n * U + (U * 3456n) / 10_000n)).toBe('12.34');
    expect(formatToken(U - U / 1000n)).toBe('0.999');
    expect(formatToken(999n * U + (U * 999n) / 1000n)).toBe('999.99');
    expect(formatToken(12n * U + (U * 349n) / 1000n + (U * 9n) / 10_000n)).toBe('12.34');
  });

  it('does not let integer-division dust look like a missing cent', () => {
    // A 1,000 claim after the index has moved: 999.999999999999999998.
    expect(formatToken(1_000n * U - 2n, { maxFrac: 2, fixed: true })).toBe('1,000.00');
    expect(formatToken(U - 1n)).toBe('1');
    expect(formatToken(849n * U + U - 5n, { maxFrac: 2, fixed: true })).toBe('850.00');
    // A millionth of a token short is real, and stays visible as truncation.
    expect(formatToken(1_000n * U - U / 1_000_000n, { maxFrac: 2, fixed: true })).toBe('999.99');
  });

  it('picks precision by size', () => {
    expect(formatToken(15_230n * U + U / 2n)).toBe('15,230');
    expect(formatToken(7n * U + U / 2n)).toBe('7.5');
    expect(formatToken((U * 42n) / 100_000n)).toBe('0.0004');
  });

  it('never shows a non-zero amount as zero', () => {
    expect(formatToken(1n)).toBe('<0.0001');
    expect(formatToken(1n, { maxFrac: 0 })).toBe('<1');
  });

  it('keeps trailing zeros when fixed', () => {
    expect(formatToken(1_000n * U, { maxFrac: 2, fixed: true })).toBe('1,000.00');
    expect(formatToken(985n * U + U / 10n, { maxFrac: 2, fixed: true })).toBe('985.10');
  });

  it('handles negatives and other decimals', () => {
    expect(formatToken(-(15n * U) / 10n)).toBe('-1.5');
    expect(formatToken(1_500_000n, { decimals: 6 })).toBe('1.5');
  });

  it('survives values far beyond Number precision', () => {
    expect(formatToken(123_456_789_012_345_678_901_234n * U)).toBe('123,456,789,012,345,678,901,234');
  });
});

describe('formatCompact', () => {
  it('abbreviates large amounts', () => {
    expect(formatCompact(15_230n * U)).toBe('15.2K');
    expect(formatCompact(1_000_000n * U)).toBe('1M');
    expect(formatCompact(1_250_000_000n * U)).toBe('1.2B');
    expect(formatCompact(250_000n * U)).toBe('250K');
  });
  it('leaves small amounts alone', () => {
    expect(formatCompact(999n * U)).toBe('999');
    expect(formatCompact(12n * U + U / 4n)).toBe('12.25');
  });
});

describe('countdown', () => {
  it('formats m:ss, floored', () => {
    expect(formatCountdown(0)).toBe('0:00');
    expect(formatCountdown(999)).toBe('0:00');
    expect(formatCountdown(41_000)).toBe('0:41');
    expect(formatCountdown(41_999)).toBe('0:41');
    expect(formatCountdown(180_000)).toBe('3:00');
    expect(formatCountdown(3_599_000)).toBe('59:59');
    expect(formatCountdown(3_600_000)).toBe('1:00:00');
  });
  it('treats negative time as zero', () => {
    expect(formatCountdown(-5_000)).toBe('0:00');
  });
  it('speaks plainly', () => {
    expect(spokenCountdown(65_000)).toBe('1 minute 5 seconds');
    expect(spokenCountdown(120_000)).toBe('2 minutes');
    expect(spokenCountdown(1_000)).toBe('1 second');
    expect(spokenCountdown(0)).toBe('0 seconds');
  });
  it('shows tenths for close calls', () => {
    expect(formatTimeLeft(420)).toBe('0.4 s');
    expect(formatTimeLeft(9_999)).toBe('9.9 s');
    expect(formatTimeLeft(41_000)).toBe('0:41');
  });
});

describe('percentages', () => {
  it('formats ppm', () => {
    expect(formatPpm(20_000)).toBe('2%');
    expect(formatPpm(500)).toBe('0.05%');
    expect(formatPpm(13_725n)).toBe('1.37%');
    expect(formatPpm(150_000)).toBe('15%');
    expect(formatPpm(0)).toBe('0%');
  });
  it('formats a share of supply', () => {
    expect(formatShare(2n, 100n)).toBe('2.00%');
    expect(formatShare(1n, 3n)).toBe('33.33%');
    expect(formatShare(5n, 0n)).toBe('0%');
  });
});

describe('shortAccount', () => {
  it('keeps two similar accounts apart at every length, down to the narrowest place', () => {
    const bots = ['notit-undertaker-p460.testnet', 'notit-freerider-p461.testnet', 'notit-freerider-p462.testnet', 'notit-sniper-p463.testnet'];
    const guests = ['guest-e2ff2ca8.testnet', 'guest-0df6d80f.testnet', 'guest-c32cda3f.testnet'];
    for (const max of [20, 16, 12, 9, 7, 5]) {
      for (const group of [bots, guests]) {
        const short = group.map((id) => shortAccount(id, max));
        expect(new Set(short).size, `${max}: ${short.join(' ')}`).toBe(group.length);
        for (const sName of short) expect(sName.length).toBeLessThanOrEqual(Math.max(max, 5));
      }
    }
  });

  it('keeps short ids', () => {
    expect(shortAccount('alice.testnet')).toBe('alice.testnet');
  });
  it('shortens long ids and keeps the suffix', () => {
    const s = shortAccount('a-very-long-account-name-indeed.testnet');
    expect(s.length).toBeLessThanOrEqual(20);
    expect(s.endsWith('.testnet')).toBe(true);
    expect(s).toContain('…');
  });
});
