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
// Must stay in sync with KNOWN_TABS in supabase/functions/send-push/index.ts.
// ProfileTab was missing, so an admin notice targeting it routed correctly as a
// PUSH but was silently unroutable when tapped in the in-app inbox.
const TABS = { EarnTab: 1, GigsTab: 1, MessagesTab: 1, HomeTab: 1, ProfileTab: 1 };
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
//
// This FAILS CLOSED, and that is the whole point. It used to discard the
// PostgREST error (`const { data } = ...`) and return DEFAULT_NOTIF_PREFS from
// both the `!data` branch and the outer catch, so "your read failed" and "you
// have no row yet" were the same answer. The settings screen rendered those
// defaults as the user's live settings, and the next toggle wrote the whole
// eight-column row back — silently reverting every opt-out the user had saved.
// A caller that cannot tell a failed read from an empty one must not be allowed
// to write, so an error is raised rather than answered with defaults.
export async function getNotificationPrefs() {
  const { data: auth, error: authError } = await supabase.auth.getUser();
  if (authError) throw authError;
  const user = auth?.user;
  if (!user) return { ...DEFAULT_NOTIF_PREFS };
  const { data, error } = await supabase
    .from('notification_preferences')
    .select('*')
    .eq('user_id', user.id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return { ...DEFAULT_NOTIF_PREFS };
  const merged = { ...DEFAULT_NOTIF_PREFS };
  for (const k of PREF_KEYS) if (typeof data[k] === 'boolean') merged[k] = data[k];
  return merged;
}

// Write ONE preference (owner RLS). Deliberately single-key: the previous
// whole-object upsert carried the seven columns the user did not touch, so
// anything wrong with the in-memory copy was written over the stored row. An
// UPDATE of one column cannot do that no matter what the screen is showing.
// The insert is the fallback for a user who has no row yet, and only then does
// the full default set get written.
export async function saveNotificationPref(key, value) {
  if (!PREF_KEYS.includes(key)) throw new Error(`Unknown notification preference: ${key}`);
  if (typeof value !== 'boolean') throw new Error('Notification preference must be a boolean');
  const { data: auth, error: authError } = await supabase.auth.getUser();
  if (authError) throw authError;
  const user = auth?.user;
  // Not a silent no-op: the screen has already moved the switch optimistically,
  // so a write that cannot happen has to come back as a failure.
  if (!user) throw new Error('Not signed in');

  const patch = { [key]: value, updated_at: new Date().toISOString() };
  const { data: updated, error } = await supabase
    .from('notification_preferences')
    .update(patch)
    .eq('user_id', user.id)
    .select('user_id');
  if (error) throw error;
  if (updated && updated.length > 0) return;

  // No row yet — create one from the defaults with this single change applied.
  const { error: insertError } = await supabase
    .from('notification_preferences')
    .insert({ user_id: user.id, ...DEFAULT_NOTIF_PREFS, ...patch });
  if (!insertError) return;
  // A row appeared between the UPDATE and the INSERT (another device, or the
  // send-push path): patch that row rather than replacing it.
  if (insertError.code !== '23505') throw insertError;
  const { error: retryError } = await supabase
    .from('notification_preferences')
    .update(patch)
    .eq('user_id', user.id);
  if (retryError) throw retryError;
}
