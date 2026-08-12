// Mobile pricing helpers. Display only — the server is authoritative.
//
// TWO DIFFERENT RATES, AND USING THE WRONG ONE IS A DISCLOSURE BUG:
//
//   BEFORE a booking exists  → the CURRENT rate (fee_bps_at). This is a quote: it is
//                              what will be pinned the moment the earner applies.
//   AFTER a booking exists   → booking.fee_bps_quoted, the rate actually pinned to
//                              that deal. Showing today's rate on a booking struck at
//                              a different one would misstate what the earner is
//                              owed — and after a rate change or a promotion, it
//                              would be visibly wrong on their own earnings screen.
//
// So: quote screens call getFeeBps(); anything rendering an existing booking passes
// that booking's pinned rate straight to the shared math.
import { supabase } from './supabase';
import { DEFAULT_FEE_BPS, platformFeeCents, earnerNetCents, feeLabel } from '../../shared/pricing';

export { DEFAULT_FEE_BPS, platformFeeCents, earnerNetCents, feeLabel };

// Cached because every job card and detail screen wants it, and it changes about
// never. Deliberately NOT persisted to AsyncStorage: a stale rate surviving an app
// restart is worse than one extra request per session.
let cachedBps = null;
let inFlight = null;

/**
 * The rate in force right now, for quoting. Falls back to DEFAULT_FEE_BPS on any
 * failure — offline, logged out, RPC down. Never returns 0: a display that says
 * "no fee" when a fee will be charged is the one error mode that matters here.
 */
export async function getFeeBps() {
  if (cachedBps != null) return cachedBps;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const { data, error } = await supabase.rpc('fee_bps_at');
      const n = Number(data);
      if (!error && Number.isFinite(n) && n > 0) {
        cachedBps = Math.trunc(n);
      } else {
        cachedBps = DEFAULT_FEE_BPS;
      }
    } catch {
      cachedBps = DEFAULT_FEE_BPS;
    } finally {
      inFlight = null;
    }
    return cachedBps;
  })();
  return inFlight;
}

/** Synchronous best-effort for render paths that cannot await. */
export function feeBpsSync() {
  return cachedBps ?? DEFAULT_FEE_BPS;
}

/** Drop the cache — call after an admin rate change if the app is long-lived. */
export function resetFeeBpsCache() {
  cachedBps = null;
}

/**
 * The rate that applies to an existing booking: its pin, or the current rate as a
 * fallback for rows created before 20260806050000 (all of which were 10%).
 */
export function bookingFeeBps(booking) {
  const pinned = Number(booking?.fee_bps_quoted ?? booking?.feeBpsQuoted);
  return Number.isFinite(pinned) && pinned > 0 ? Math.trunc(pinned) : feeBpsSync();
}
