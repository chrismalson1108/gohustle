// Report / block helpers. Port of src/lib/moderation.js.
import { supabase } from "./supabaseClient";

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
