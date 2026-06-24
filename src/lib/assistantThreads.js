import { supabase } from './supabase';

// Past Hustlr AI conversations. assistant_threads / assistant_messages are
// owner-RLS, so the client reads them directly. Errors are surfaced (thrown)
// so callers can distinguish a failure from a genuinely-empty result.

export async function listThreads() {
  const { data, error } = await supabase
    .from('assistant_threads')
    .select('id, title, updated_at, created_at')
    .order('updated_at', { ascending: false })
    .limit(50);
  if (error) throw new Error(error.message);
  return data || [];
}

export async function loadThread(threadId) {
  const { data, error } = await supabase
    .from('assistant_messages')
    .select('role, content, created_at')
    .eq('thread_id', threadId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  return data || [];
}

export async function deleteThread(threadId) {
  const { error } = await supabase.from('assistant_threads').delete().eq('id', threadId);
  if (error) throw new Error(error.message);
}
