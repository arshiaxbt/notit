import { useEffect, useRef, useState } from 'react';

/**
 * Re-renders the calling component about `fps` times a second while the tab
 * is visible, and returns a value computed on each tick. Use it in small leaf
 * components so only the moving numbers re-render.
 */
export function useTicker<T>(compute: () => T, fps = 12): T {
  const computeRef = useRef(compute);
  computeRef.current = compute;
  const [, setTick] = useState(0);

  useEffect(() => {
    let raf = 0;
    let last = 0;
    const minGap = 1000 / fps;
    const loop = (t: number) => {
      if (t - last >= minGap) {
        last = t;
        setTick((n) => (n + 1) % 1_000_000);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [fps]);

  return computeRef.current();
}
