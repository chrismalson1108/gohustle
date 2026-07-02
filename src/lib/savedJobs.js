import { supabase } from './supabase';

// Saved / bookmarked gigs (saved_jobs table — shared with web).
export async function fetchSavedJobIds(userId) {
  const { data } = await supabase.from('saved_jobs').select('job_id').eq('user_id', userId);
  return new Set((data || []).map(r => r.job_id));
}

export async function addSavedJob(userId, jobId) {
  const { error } = await supabase
    .from('saved_jobs')
    .upsert({ user_id: userId, job_id: jobId }, { onConflict: 'user_id,job_id' });
  if (error) throw error;
}

export async function removeSavedJob(userId, jobId) {
  const { error } = await supabase
    .from('saved_jobs').delete().eq('user_id', userId).eq('job_id', jobId);
  if (error) throw error;
}
