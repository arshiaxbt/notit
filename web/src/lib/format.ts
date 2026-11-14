/** Formatting helpers. Token amounts are bigint units with 18 decimals. */

export const DECIMALS = 18;

function group(intDigits: string): string {
  return intDigits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export interface TokenFormat {
  decimals?: number;
  /** Maximum fraction digits. Default depends on size: 0 above 10,000, 2 above 1, 4 below. */
  maxFrac?: number;
  /** Keep trailing zeros so the width does not jump while a number animates. */
  fixed?: boolean;
}

/**
 * Formats token units for people: thousands separators, truncated instead of
 * rounded, so 12.3456 shows as "12.34".
 *   1000e18 -> "1,000"   12.3456e18 -> "12.34"   0.00042e18 -> "0.0004"
 *
 * One exception: integer division on chain leaves balances a few units short
 * of a round number (a 1,000 claim can arrive as 999.999999999999999998).
 * Anything within a billionth of a token below a display step is shown as
 * that step, so dust does not look like a missing cent.
 */
export function formatToken(units: bigint, opts: TokenFormat = {}): string {
  const decimals = opts.decimals ?? DECIMALS;
  const neg = units < 0n;
  const dust = decimals > 9 ? 10n ** BigInt(decimals - 9) : 0n;
  const abs = (neg ? -units : units) + (units === 0n ? 0n : dust);
  const base = 10n ** BigInt(decimals);
  const int = abs / base;
  const maxFrac = Math.min(decimals, opts.maxFrac ?? (int >= 10_000n ? 0 : int >= 1n ? 2 : 4));
  let frac = '';
  if (maxFrac > 0) {
    frac = (abs % base).toString().padStart(decimals, '0').slice(0, maxFrac);
    if (!opts.fixed) frac = frac.replace(/0+$/, '');
  }
  const body = group(int.toString()) + (frac ? '.' + frac : '');
  const isZero = int === 0n && !/[1-9]/.test(frac);
  if (isZero && units !== 0n) return (neg ? '-' : '') + '<' + (maxFrac > 0 ? '0.' + '0'.repeat(maxFrac - 1) + '1' : '1');
  return (neg && !isZero ? '-' : '') + body;
}

/** Short form for large amounts: 15,230 -> "15.2K", 1.2e9 -> "1.2B". */
export function formatCompact(units: bigint, decimals = DECIMALS): string {
  const base = 10n ** BigInt(decimals);
  const int = units / base;
  const steps: Array<[bigint, string]> = [
    [1_000_000_000_000n, 'T'],
    [1_000_000_000n, 'B'],
    [1_000_000n, 'M'],
    [1_000n, 'K'],
  ];
  for (const [size, suffix] of steps) {
    if (int >= size) {
      const tenths = (int * 10n) / size;
      const whole = tenths / 10n;
      const dec = tenths % 10n;
      return whole >= 100n || dec === 0n ? `${whole}${suffix}` : `${whole}.${dec}${suffix}`;
    }
  }
  return formatToken(units, { decimals, maxFrac: int >= 100n ? 0 : 2 });
}

/** "m:ss" from milliseconds, floored to the second. Negative counts as zero. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = s.toString().padStart(2, '0');
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${ss}`;
  return `${m}:${ss}`;
}

/** A spoken version for screen readers: "1 minute 5 seconds". */
export function spokenCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  const parts: string[] = [];
  if (m > 0) parts.push(`${m} minute${m === 1 ? '' : 's'}`);
  if (s > 0 || m === 0) parts.push(`${s} second${s === 1 ? '' : 's'}`);
  return parts.join(' ');
}

/** For close calls: "0.4 s" under ten seconds, otherwise "m:ss". */
export function formatTimeLeft(ms: number): string {
  if (ms < 10_000) return `${(Math.max(0, Math.floor(ms / 100)) / 10).toFixed(1)} s`;
  return formatCountdown(ms);
}

/** ppm -> percent string: 20000 -> "2%", 500 -> "0.05%", 13725 -> "1.37%". */
export function formatPpm(ppm: number | bigint, maxFrac = 2): string {
  const n = Number(ppm) / 10_000;
  const s = n.toFixed(maxFrac).replace(/\.?0+$/, '');
  return `${s === '' ? '0' : s}%`;
}

/** part / whole as a percent string with fixed decimals: "1.37%". */
export function formatShare(part: bigint, whole: bigint, frac = 2): string {
  if (whole <= 0n) return '0%';
  const scale = 10n ** BigInt(frac + 2);
  const v = (part * scale) / whole;
  const int = v / 10n ** BigInt(frac);
  const dec = (v % 10n ** BigInt(frac)).toString().padStart(frac, '0');
  return frac > 0 ? `${int}.${dec}%` : `${int}%`;
}

/** Shortens long account ids in the middle: "averyveryl…gname.testnet". */
/** The one length account names are shortened to, everywhere. */
export const NAME_MAX = 20;

export function shortAccount(id: string, max = NAME_MAX): string {
  if (id.length <= max) return id;
  const dot = id.lastIndexOf('.');
  const suffix = dot > 0 && id.length - dot <= 9 ? id.slice(dot) : '';
  const stem = suffix ? id.slice(0, dot) : id;
  const keep = Math.max(4, max - suffix.length - 1);
  const head = Math.ceil(keep * 0.6);
  const tail = keep - head;
  return `${stem.slice(0, head)}…${tail > 0 ? stem.slice(-tail) : ''}${suffix}`;
}

/** Plain number with separators. */
export function formatInt(n: number): string {
  return group(Math.trunc(n).toString());
}
