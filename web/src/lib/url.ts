/** The choices that live in the address, so a reload or a shared link keeps them. */

export function queryGet(key: string): string | null {
  return new URLSearchParams(window.location.search).get(key);
}

/** Writes one choice into the address without adding a history entry. `null` removes it. */
export function querySet(key: string, value: string | null): void {
  const url = new URL(window.location.href);
  if (url.searchParams.get(key) === value) return;
  if (value === null) url.searchParams.delete(key);
  else url.searchParams.set(key, value);
  window.history.replaceState(null, '', url.pathname + url.search + url.hash);
}
