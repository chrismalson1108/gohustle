// Report / block helpers. Port of src/lib/moderation.js.
import { supabase } from "./supabaseClient";

// Context-aware text moderation (Claude, via the moderate-text edge function).
// Layers on top of the keyword filter (findProhibited) to catch harassment,
// threats, grooming, scams, and banned intent phrased in clean words. Fails OPEN
// on any error/timeout so posting/chat never hang; keyword filter + DB trigger
// remain the hard backstop.
// Detect "you hit your own quota" as distinct from "the service is down".
// supabase-js surfaces a non-2xx as a FunctionsHttpError with the Response on
// .context; the edge function also returns { error: 'rate_limited' } in the body.
// Checked defensively because the shape differs across supabase-js versions.
function isRateLimited(error: unknown, data: { error?: string } | null): boolean {
  if (data && data.error === "rate_limited") return true;
  if (!error) return false;
  const e = error as { context?: { status?: number }; status?: number; message?: string };
  const status = e?.context?.status ?? e?.status;
  if (status === 429) return true;
  return /rate.?limit|too many requests/i.test(String(e?.message ?? error ?? ""));
}

export async function moderateText(
  text: string,
  surface = "text",
  bookingId: string | null = null,
): Promise<{ allowed: boolean; reason?: string; rateLimited?: boolean }> {
  if (!text || !text.trim()) return { allowed: true };
  try {
    const invoke = supabase.functions.invoke("moderate-text", { body: { text, surface, bookingId } });
    const timeout = new Promise<{ data: null; error: string }>((res) =>
      setTimeout(() => res({ data: null, error: "timeout" }), 6000),
    );
    const { data, error } = (await Promise.race([invoke, timeout])) as {
      data: { allowed?: boolean; reason?: string; error?: string } | null;
      error: unknown;
    };
    // Fail OPEN on provider outage/timeout (a moderation outage must never wedge
    // posting or chat), but fail CLOSED on 429. Those are different failures: a 429
    // is SELF-INFLICTED — the caller exhausted their own per-user quota in
    // moderation_rate — so treating it as "allowed" turned the rate limiter into a
    // self-service kill switch for this entire layer. Burn the quota with junk calls,
    // then post the thing the keyword list can't catch (harassment, grooming, scam
    // intent in clean words), which is exactly what this layer exists to catch.
    // Rate limiting a safety control must not disable it. Lockstep with
    // src/lib/moderation.js.
    if (isRateLimited(error, data)) {
      return { allowed: false, reason: "rate_limited", rateLimited: true };
    }
    if (error || !data) return { allowed: true };
    return { allowed: data.allowed !== false, reason: data.reason };
  } catch {
    return { allowed: true };
  }
}

// Fire-and-forget: record a client-detected keyword block in the admin Moderation
// queue (so keyword blocks are visible too, not just Claude/image blocks). Never
// throws — it must not break or slow the submit flow.
export function logModerationBlock(term: string, surface = "text", snippet = "", bookingId: string | null = null): void {
  try {
    void supabase.functions.invoke("log-moderation", { body: { term, surface, snippet, bookingId } }).catch(() => {});
  } catch {
    /* ignore */
  }
}

export const REPORT_REASONS = [
  "Inappropriate content",
  "Scam or fraud",
  "Harassment or abuse",
  "No-show / did not complete",
  "Other",
];

export async function submitReport(args: {
  reporterId: string;
  reportedUserId?: string | null;
  jobId?: string | null;
  bookingId?: string | null;
  reason: string;
  details?: string | null;
}): Promise<void> {
  const { error } = await supabase.from("reports").insert({
    reporter_id: args.reporterId,
    reported_user_id: args.reportedUserId ?? null,
    job_id: args.jobId ?? null,
    booking_id: args.bookingId ?? null,
    reason: args.reason,
    details: args.details ?? null,
  });
  if (error) throw error;
}

export async function blockUserDb(blockerId: string, blockedId: string): Promise<void> {
  const { error } = await supabase
    .from("blocks")
    .upsert({ blocker_id: blockerId, blocked_id: blockedId }, { onConflict: "blocker_id,blocked_id" });
  if (error) throw error;
}

export async function unblockUserDb(blockerId: string, blockedId: string): Promise<void> {
  const { error } = await supabase
    .from("blocks")
    .delete()
    .eq("blocker_id", blockerId)
    .eq("blocked_id", blockedId);
  if (error) throw error;
}

export async function fetchBlockedIds(userId: string): Promise<Set<string>> {
  const { data } = await supabase.from("blocks").select("blocked_id").eq("blocker_id", userId);
  return new Set((data || []).map((r) => r.blocked_id));
}
