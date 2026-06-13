import { supabase } from './supabase';

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
