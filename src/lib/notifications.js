import { supabase } from './supabase';

const COLS = 'id, type, title, body, job_id, read, archived, data, created_at';

export async function listNotifications(archived = false) {
  const { data } = await supabase
    .from('notifications')
    .select(COLS)
    .eq('archived', archived)
    .order('created_at', { ascending: false })
    .limit(50);
  return data || [];
}

export async function markRead(id) {
  await supabase.from('notifications').update({ read: true }).eq('id', id);
}

export async function markAllRead() {
  await supabase.from('notifications').update({ read: true }).eq('read', false).eq('archived', false);
}

export async function setArchived(id, archived) {
  await supabase.from('notifications').update({ archived }).eq('id', id);
}

export async function getUnreadCount() {
  const { count } = await supabase
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .eq('read', false)
    .eq('archived', false);
  return count || 0;
}

// Where tapping an alert should go: a gig deep-link, else a tab.
const TABS = { EarnTab: 1, GigsTab: 1, MessagesTab: 1, HomeTab: 1 };
export function notificationRoute(n) {
  if (n.job_id) return { tab: 'HomeTab', screen: 'JobDetail', params: { jobId: n.job_id } };
  const tab = n?.data?.tab;
  if (tab && TABS[tab]) return { tab };
  return null;
}

// ─── Per-user notification preferences ───────────────────────────────────────
// Mirrors the notification_preferences table (per-category x per-channel). These
// defaults are the source of truth when a user has no row yet, and MUST match the
// column defaults in supabase/migrations/20260713000000_notification_preferences.sql.
// Default email posture is "high-value only": bookings + payments email, messages
// + marketing don't (users can opt in).
export const DEFAULT_NOTIF_PREFS = {
  bookings_push: true,  bookings_email: true,
  messages_push: true,  messages_email: false,
  payments_push: true,  payments_email: true,
  marketing_push: true, marketing_email: false,
};

const PREF_KEYS = Object.keys(DEFAULT_NOTIF_PREFS);

// User-facing categories, in display order. `key` is the column prefix.
export const NOTIF_CATEGORIES = [
  { key: 'bookings', label: 'Bookings',        hint: 'Requests, accepts, completion & changes' },
  { key: 'messages', label: 'Messages',        hint: 'New chat messages' },
  { key: 'payments', label: 'Payments & tips', hint: 'Payouts, tips & adjustments' },
  { key: 'marketing', label: 'News & tips',    hint: 'Product updates and promos' },
];

// Load the signed-in user's preferences, merged over the defaults so the UI
// always has a complete object even before a row exists.
export async function getNotificationPrefs() {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { ...DEFAULT_NOTIF_PREFS };
    const { data } = await supabase
      .from('notification_preferences')
      .select('*')
      .eq('user_id', user.id)
      .maybeSingle();
    if (!data) return { ...DEFAULT_NOTIF_PREFS };
    const merged = { ...DEFAULT_NOTIF_PREFS };
    for (const k of PREF_KEYS) if (typeof data[k] === 'boolean') merged[k] = data[k];
    return merged;
  } catch {
    return { ...DEFAULT_NOTIF_PREFS };
  }
}

// Upsert the full preferences row (owner RLS). Pass the complete prefs object.
export async function saveNotificationPrefs(prefs) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;
  const row = { user_id: user.id, updated_at: new Date().toISOString() };
  for (const k of PREF_KEYS) if (typeof prefs[k] === 'boolean') row[k] = prefs[k];
  const { error } = await supabase
    .from('notification_preferences')
    .upsert(row, { onConflict: 'user_id' });
  if (error) throw error;
}
