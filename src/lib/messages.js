import { supabase } from './supabase';

// Latest message per booking id.
// PERF: this used to be a single `.in(bookingIds)` query with no limit, which
// downloaded the ENTIRE message history of EVERY conversation just to keep the
// newest row of each — hundreds of rows per booking on every Messages open and
// every unread refresh. PostgREST has no "distinct on"/per-group limit, so we
// instead ask for exactly one row per conversation (limit 1, newest first) and
// run those tiny queries in bounded-concurrency batches. Return shape is
// unchanged: { [bookingId]: newestMessageRow }.
const LAST_MSG_CONCURRENCY = 8;

export async function fetchLastMessages(bookingIds) {
  if (!bookingIds?.length) return {};
  const map = {};
  for (let i = 0; i < bookingIds.length; i += LAST_MSG_CONCURRENCY) {
    const batch = bookingIds.slice(i, i + LAST_MSG_CONCURRENCY);
    const results = await Promise.all(batch.map(id =>
      supabase
        .from('messages')
        .select('booking_id, sender_id, text, image_url, created_at')
        .eq('booking_id', id)
        .order('created_at', { ascending: false })
        .limit(1)
    ));
    results.forEach(({ data }) => {
      const m = data?.[0];
      if (m) map[m.booking_id] = m;
    });
  }
  return map;
}

// Per-conversation state (last_read_at, archived) keyed by booking id.
export async function fetchConversationState(userId, bookingIds) {
  if (!bookingIds?.length) return {};
  const { data } = await supabase
    .from('conversation_state')
    .select('booking_id, last_read_at, archived')
    .eq('user_id', userId)
    .in('booking_id', bookingIds);
  const map = {};
  (data || []).forEach(s => { map[s.booking_id] = s; });
  return map;
}

export async function markConversationRead(userId, bookingId) {
  await supabase.from('conversation_state')
    .upsert({ user_id: userId, booking_id: bookingId, last_read_at: new Date().toISOString() }, { onConflict: 'user_id,booking_id' });
}

export async function setConversationArchived(userId, bookingId, archived) {
  await supabase.from('conversation_state')
    .upsert({ user_id: userId, booking_id: bookingId, archived }, { onConflict: 'user_id,booking_id' });
}

// Unread = newest message is from the other person and newer than my last read.
export function isUnread(lastMsg, state, myId) {
  if (!lastMsg || lastMsg.sender_id === myId) return false;
  if (!state?.last_read_at) return true;
  return new Date(lastMsg.created_at).getTime() > new Date(state.last_read_at).getTime();
}

export function previewText(m) {
  if (!m) return '';
  if (m.image_url && !m.text) return '📷 Photo';
  return m.text || '';
}

// Hub filter (H2): hide a conversation whose other party I've blocked. The server
// also stops blocked users from messaging/booking (see the block_enforcement
// migration); this is the UI half so my inbox doesn't keep showing them.
export function notBlocked(convo, blockedIds) {
  if (!blockedIds || !convo?.other?.id) return true;
  return !blockedIds.has(convo.other.id);
}
