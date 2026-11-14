import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { prefersReducedMotion } from '../hooks/useReducedMotion';
import { NAME_MAX, NAME_MAX_COMPACT, shortAccount } from '../lib/format';

export function cls(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/**
 * Text whose digits sit in equal-width cells, so a number that changes many
 * times a second does not make the layout jitter. Screen readers get the
 * plain text once instead of one cell at a time.
 */
export function Digits({ text, className }: { text: string; className?: string }) {
  return (
    <span className={cls('digits', className)}>
      <span aria-hidden="true">
        {[...text].map((ch, i) => (
          <span key={i} className={ch >= '0' && ch <= '9' ? 'digits__d' : 'digits__p'}>
            {ch}
          </span>
        ))}
      </span>
      <span className="sr-only">{text}</span>
    </span>
  );
}

/** Eases a bigint towards its latest value so balance changes are visible. */
export function useTweened(value: bigint, ms = 900): bigint {
  const [shown, setShown] = useState(value);
  const shownRef = useRef(value);
  const first = useRef(true);

  useEffect(() => {
    if (first.current || prefersReducedMotion() || shownRef.current === value) {
      first.current = false;
      shownRef.current = value;
      setShown(value);
      return;
    }
    const from = shownRef.current;
    const delta = value - from;
    const t0 = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / ms);
      const eased = 1 - Math.pow(1 - p, 3);
      const next = p >= 1 ? value : from + (delta * BigInt(Math.round(eased * 10_000))) / 10_000n;
      shownRef.current = next;
      setShown(next);
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, ms]);

  return shown;
}

/** An account name: "you" for the viewer, shortened otherwise. */
/** The one length names are cut to at this width: shorter on a phone. */
export function useNameMax(): number {
  const query = '(max-width: 619px)';
  const read = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches ? NAME_MAX_COMPACT : NAME_MAX);
  const [max, setMax] = useState(read);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMax(read());
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return max;
}

export function Who({ id, me, max }: { id: string; me: string | null; max?: number }) {
  const usual = useNameMax();
  if (me !== null && id === me) return <span className="who who--me">you</span>;
  return (
    <span className="who" title={id}>
      {shortAccount(id, Math.min(usual, max ?? usual))}
    </span>
  );
}

export function Card({
  title,
  aside,
  className,
  children,
  labelId,
}: {
  title: ReactNode;
  aside?: ReactNode;
  className?: string;
  children: ReactNode;
  labelId: string;
}) {
  return (
    <section className={cls('card', className)} aria-labelledby={labelId}>
      <header className="card__head">
        <h2 id={labelId} className="card__title">
          {title}
        </h2>
        {aside && <div className="card__aside">{aside}</div>}
      </header>
      {children}
    </section>
  );
}

/** Shows `value` for `ms` after it changes (by key), then null. Used for round-close flashes. */
export function useFlash<T extends { id: number }>(value: T | null, ms: number): T | null {
  const [visible, setVisible] = useState<T | null>(null);
  useEffect(() => {
    if (!value) return;
    setVisible(value);
    const t = window.setTimeout(() => setVisible((v) => (v && v.id === value.id ? null : v)), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return visible;
}
