import { supabase } from './supabase';

// Latest message per booking id (one query, grouped client-side).
export async function fetchLastMessages(bookingIds) {
  if (!bookingIds?.length) return {};
  const { data } = await supabase
    .from('messages')
    .select('booking_id, sender_id, text, image_url, created_at')
    .in('booking_id', bookingIds)
    .order('created_at', { ascending: false });
  const map = {};
  (data || []).forEach(m => { if (!map[m.booking_id]) map[m.booking_id] = m; }); // first = newest
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
