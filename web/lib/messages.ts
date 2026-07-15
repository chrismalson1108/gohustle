// Messaging helpers. Port of src/lib/messages.js.
import { supabase } from "./supabaseClient";

export interface LastMessage {
  booking_id: string;
  sender_id: string;
  text: string | null;
  image_url: string | null;
  created_at: string;
}

export interface ConversationState {
  booking_id: string;
  last_read_at: string | null;
  archived: boolean;
}

export async function fetchLastMessages(
  bookingIds: string[],
): Promise<Record<string, LastMessage>> {
  if (!bookingIds?.length) return {};
  const { data } = await supabase
    .from("messages")
    .select("booking_id, sender_id, text, image_url, created_at")
    .in("booking_id", bookingIds)
    .order("created_at", { ascending: false });
  const map: Record<string, LastMessage> = {};
  (data || []).forEach((m) => {
    if (!map[m.booking_id]) map[m.booking_id] = m as LastMessage;
  });
  return map;
}

export async function fetchConversationState(
  userId: string,
  bookingIds: string[],
): Promise<Record<string, ConversationState>> {
  if (!bookingIds?.length) return {};
  const { data } = await supabase
    .from("conversation_state")
    .select("booking_id, last_read_at, archived")
    .eq("user_id", userId)
    .in("booking_id", bookingIds);
  const map: Record<string, ConversationState> = {};
  (data || []).forEach((s) => {
    map[s.booking_id] = s as ConversationState;
  });
  return map;
}

export async function markConversationRead(userId: string, bookingId: string): Promise<void> {
  await supabase
    .from("conversation_state")
    .upsert(
      { user_id: userId, booking_id: bookingId, last_read_at: new Date().toISOString() },
      { onConflict: "user_id,booking_id" },
    );
}

export async function setConversationArchived(
  userId: string,
  bookingId: string,
  archived: boolean,
): Promise<void> {
  await supabase
    .from("conversation_state")
    .upsert({ user_id: userId, booking_id: bookingId, archived }, { onConflict: "user_id,booking_id" });
}

export function isUnread(
  lastMsg: LastMessage | undefined,
  state: ConversationState | undefined,
  myId: string,
): boolean {
  if (!lastMsg || lastMsg.sender_id === myId) return false;
  if (!state?.last_read_at) return true;
  return new Date(lastMsg.created_at).getTime() > new Date(state.last_read_at).getTime();
}

// Hub filter (H2): hide a conversation whose other party I've blocked. The server
// also stops blocked users from messaging/booking (see the block_enforcement
// migration); this is the UI half so my inbox doesn't keep showing them.
export function notBlocked(convo: { otherId?: string | null }, blockedIds?: Set<string>): boolean {
  if (!blockedIds || !convo?.otherId) return true;
  return !blockedIds.has(convo.otherId);
}

export function previewText(m?: LastMessage | null): string {
  if (!m) return "";
  if (m.image_url && !m.text) return "📷 Photo";
  return m.text || "";
}
