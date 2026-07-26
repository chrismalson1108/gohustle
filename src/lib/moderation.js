import { supabase } from './supabase';

// Context-aware text moderation (Claude, via the moderate-text edge function).
// Layers on top of the keyword filter (findProhibited) to catch harassment,
// threats, grooming, scams, and banned intent phrased in clean words. Returns
// { allowed, reason }. Fails OPEN on any error/timeout so posting and chat never
// hang; the keyword filter + DB trigger remain the hard backstop.
// Detect "you hit your own quota" as distinct from "the service is down".
// supabase-js surfaces a non-2xx as a FunctionsHttpError with the Response on
// .context; the edge function also returns { error: 'rate_limited' } in the body.
// Checked defensively because the shape differs across supabase-js versions.
function isRateLimited(error, data) {
  if (data && data.error === 'rate_limited') return true;
  if (!error) return false;
  const status = error?.context?.status ?? error?.status;
  if (status === 429) return true;
  return /rate.?limit|too many requests/i.test(String(error?.message ?? error ?? ''));
}

export async function moderateText(text, surface = 'text', bookingId = null) {
  if (!text || !String(text).trim()) return { allowed: true };
  try {
    const invoke = supabase.functions.invoke('moderate-text', { body: { text, surface, bookingId } });
    const timeout = new Promise((resolve) => setTimeout(() => resolve({ data: null, error: 'timeout' }), 6000));
    const { data, error } = await Promise.race([invoke, timeout]);
    // Fail OPEN on provider outage/timeout (the original design: a moderation
    // outage must never wedge posting or chat), but fail CLOSED on 429.
    //
    // Those two are not the same failure. A 429 is SELF-INFLICTED — the caller
    // exhausted their own per-user quota in moderation_rate — so treating it as
    // "allowed" turned the rate limiter into a self-service kill switch for this
    // whole layer: burn your quota with junk calls, then post the thing the
    // keyword list can't catch (harassment, grooming, scam intent phrased in clean
    // words), which is precisely what this layer exists to catch. Rate limiting a
    // safety control must not disable it.
    if (isRateLimited(error, data)) {
      return { allowed: false, reason: 'rate_limited', rateLimited: true };
    }
    if (error || !data) return { allowed: true }; // fail open
    return { allowed: data.allowed !== false, reason: data.reason };
  } catch (_) {
    return { allowed: true };
  }
}

// Fire-and-forget: record a client-detected keyword block in the admin Moderation
// queue (so keyword blocks are visible too, not just Claude/image blocks). Never
// throws — it must not break or slow the submit flow.
export function logModerationBlock(term, surface = 'text', snippet = '', bookingId = null) {
  try {
    supabase.functions.invoke('log-moderation', { body: { term, surface, snippet, bookingId } }).catch(() => {});
  } catch (_) { /* ignore */ }
}

export const REPORT_REASONS = [
  'Inappropriate content',
  'Scam or fraud',
  'Harassment or abuse',
  'No-show / did not complete',
  'Other',
];

export async function submitReport({ reporterId, reportedUserId = null, jobId = null, bookingId = null, reason, details = null }) {
  const { error } = await supabase.from('reports').insert({
    reporter_id: reporterId,
    reported_user_id: reportedUserId,
    job_id: jobId,
    booking_id: bookingId,
    reason,
    details,
  });
  if (error) throw error;
}

export async function blockUserDb(blockerId, blockedId) {
  const { error } = await supabase
    .from('blocks')
    .upsert({ blocker_id: blockerId, blocked_id: blockedId }, { onConflict: 'blocker_id,blocked_id' });
  if (error) throw error;
}

export async function unblockUserDb(blockerId, blockedId) {
  const { error } = await supabase.from('blocks').delete().eq('blocker_id', blockerId).eq('blocked_id', blockedId);
  if (error) throw error;
}

export async function fetchBlockedIds(userId) {
  const { data } = await supabase.from('blocks').select('blocked_id').eq('blocker_id', userId);
  return new Set((data || []).map(r => r.blocked_id));
}
