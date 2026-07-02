// localStorage cache with a timestamp TTL. Browser-only; no-ops during SSR.
// Mirrors the AsyncStorage API used by the mobile app (src/lib/cache.js).
const DEFAULT_TTL = 5 * 60 * 1000; // 5 minutes

function hasStorage(): boolean {
  return typeof window !== "undefined" && !!window.localStorage;
}

export async function cacheSet(key: string, data: unknown): Promise<void> {
  if (!hasStorage()) return;
  try {
    if (data === null) {
      window.localStorage.removeItem(`cache:${key}`);
      return;
    }
    window.localStorage.setItem(`cache:${key}`, JSON.stringify({ data, ts: Date.now() }));
  } catch {
    /* quota / serialization — ignore */
  }
}

export async function cacheGet<T = unknown>(key: string, maxAge = DEFAULT_TTL): Promise<T | null> {
  if (!hasStorage()) return null;
  try {
    const raw = window.localStorage.getItem(`cache:${key}`);
    if (!raw) return null;
    const { data, ts } = JSON.parse(raw);
    if (Date.now() - ts > maxAge) return null;
    return data as T;
  } catch {
    return null;
  }
}

export async function cacheRemove(key: string): Promise<void> {
  if (!hasStorage()) return;
  try {
    window.localStorage.removeItem(`cache:${key}`);
  } catch {
    /* ignore */
  }
}

// Drop every cache entry (profiles, jobs, bookings…). Called on sign-out so a
// shared computer never shows the previous user's cached data.
export function cacheClearAll(): void {
  if (!hasStorage()) return;
  try {
    const doomed: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith("cache:")) doomed.push(k);
    }
    doomed.forEach((k) => window.localStorage.removeItem(k));
  } catch {
    /* ignore */
  }
}
