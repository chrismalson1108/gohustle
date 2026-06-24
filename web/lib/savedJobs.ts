// Saved / bookmarked gigs. Resilient: degrades to empty if the saved_jobs table
// hasn't been created yet (pre-migration).
import { supabase } from "./supabaseClient";

export async function fetchSavedJobIds(userId: string): Promise<Set<string>> {
  const { data, error } = await supabase.from("saved_jobs").select("job_id").eq("user_id", userId);
  if (error) return new Set();
  return new Set((data || []).map((r) => r.job_id as string));
}

export async function addSavedJob(userId: string, jobId: string): Promise<void> {
  await supabase.from("saved_jobs").upsert({ user_id: userId, job_id: jobId }, { onConflict: "user_id,job_id" });
}

export async function removeSavedJob(userId: string, jobId: string): Promise<void> {
  await supabase.from("saved_jobs").delete().eq("user_id", userId).eq("job_id", jobId);
}
