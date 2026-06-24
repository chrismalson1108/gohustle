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
