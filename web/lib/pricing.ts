// Web pricing helpers. Display only — the server is authoritative and never trusts a
// client-computed fee.
//
// Mirror of src/lib/pricing.js. Same rule, and it is the one that matters:
//   BEFORE a booking → the CURRENT rate (fee_bps_at). A quote: what will be pinned.
//   AFTER a booking  → booking.feeBpsQuoted, the rate struck for that deal.
// Rendering today's rate on a booking pinned at a different one misstates what the
// earner is owed.
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { DEFAULT_FEE_BPS } from "@gohustlr/shared";

let cachedBps: number | null = null;
let inFlight: Promise<number> | null = null;

/**
 * The rate in force right now, for quoting. Falls back to the founding rate on any
 * failure and never returns 0 — a page that says "no fee" while a fee is charged is
 * the single error mode worth designing against here.
 */
export async function getFeeBps(): Promise<number> {
  if (cachedBps != null) return cachedBps;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const { data, error } = await supabase.rpc("fee_bps_at");
      const n = Number(data);
      cachedBps = !error && Number.isFinite(n) && n > 0 ? Math.trunc(n) : DEFAULT_FEE_BPS;
    } catch {
      cachedBps = DEFAULT_FEE_BPS;
    } finally {
      inFlight = null;
    }
    return cachedBps as number;
  })();
  return inFlight;
}

export function feeBpsSync(): number {
  return cachedBps ?? DEFAULT_FEE_BPS;
}

/** Seeded from cache so the first paint is never blank, then refreshed. */
export function useFeeBps(): number {
  const [bps, setBps] = useState<number>(feeBpsSync());
  useEffect(() => {
    let alive = true;
    getFeeBps().then((b) => {
      if (alive) setBps(b);
    });
    return () => {
      alive = false;
    };
  }, []);
  return bps;
}

/** The rate that applies to an existing booking: its pin, else the current rate. */
export function bookingFeeBps(booking: { feeBpsQuoted?: number | null } | null | undefined): number {
  const pinned = Number(booking?.feeBpsQuoted);
  return Number.isFinite(pinned) && pinned > 0 ? Math.trunc(pinned) : feeBpsSync();
}
