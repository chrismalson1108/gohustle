// Report / block helpers. Port of src/lib/moderation.js.
import { supabase } from "./supabaseClient";

// Context-aware text moderation (Claude, via the moderate-text edge function).
// Layers on top of the keyword filter (findProhibited) to catch harassment,
// threats, grooming, scams, and banned intent phrased in clean words. Fails OPEN
// on any error/timeout so posting/chat never hang; keyword filter + DB trigger
// remain the hard backstop.
export async function moderateText(
  text: string,
  surface = "text",
): Promise<{ allowed: boolean; reason?: string }> {
  if (!text || !text.trim()) return { allowed: true };
  try {
    const invoke = supabase.functions.invoke("moderate-text", { body: { text, surface } });
    const timeout = new Promise<{ data: null; error: string }>((res) =>
      setTimeout(() => res({ data: null, error: "timeout" }), 6000),
    );
    const { data, error } = (await Promise.race([invoke, timeout])) as {
      data: { allowed?: boolean; reason?: string } | null;
      error: unknown;
    };
    if (error || !data) return { allowed: true };
    return { allowed: data.allowed !== false, reason: data.reason };
  } catch {
    return { allowed: true };
  }
}

// Fire-and-forget: record a client-detected keyword block in the admin Moderation
// queue (so keyword blocks are visible too, not just Claude/image blocks). Never
// throws — it must not break or slow the submit flow.
export function logModerationBlock(term: string, surface = "text", snippet = ""): void {
  try {
    void supabase.functions.invoke("log-moderation", { body: { term, surface, snippet } }).catch(() => {});
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
