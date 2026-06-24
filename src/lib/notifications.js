import { supabase } from './supabase';

export async function listNotifications() {
  const { data } = await supabase
    .from('notifications')
    .select('id, type, title, body, job_id, read, created_at')
    .order('created_at', { ascending: false })
    .limit(50);
  return data || [];
}

export async function markRead(id) {
  await supabase.from('notifications').update({ read: true }).eq('id', id);
}

export async function markAllRead() {
  await supabase.from('notifications').update({ read: true }).eq('read', false);
}

export async function getUnreadCount() {
  const { count } = await supabase
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .eq('read', false);
  return count || 0;
}
