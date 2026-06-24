import { supabase } from './supabase';

// Owner-RLS class_schedule CRUD. days = int[] of 0=Sun..6=Sat. Errors surfaced.
export async function listClasses(userId) {
  const { data, error } = await supabase
    .from('class_schedule')
    .select('id, title, days, start_time, end_time, location')
    .eq('user_id', userId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  return data || [];
}

export async function addClass(userId, c) {
  const { error } = await supabase.from('class_schedule').insert({ user_id: userId, ...c });
  if (error) throw new Error(error.message);
}

export async function deleteClass(id) {
  const { error } = await supabase.from('class_schedule').delete().eq('id', id);
  if (error) throw new Error(error.message);
}
