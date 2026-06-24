import { supabase } from "./supabaseClient";

// Owner-RLS class_schedule table. days = int[] of 0=Sun..6=Sat.
export interface ClassRow {
  id: string;
  title: string;
  days: number[];
  start_time: string;
  end_time: string;
  location: string | null;
}

export async function listClasses(userId: string): Promise<ClassRow[]> {
  const { data, error } = await supabase
    .from("class_schedule")
    .select("id, title, days, start_time, end_time, location")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data as ClassRow[]) ?? [];
}

export async function addClass(
  userId: string,
  c: { title: string; days: number[]; start_time: string; end_time: string; location?: string | null },
): Promise<void> {
  const { error } = await supabase.from("class_schedule").insert({ user_id: userId, ...c });
  if (error) throw new Error(error.message);
}

export async function deleteClass(id: string): Promise<void> {
  const { error } = await supabase.from("class_schedule").delete().eq("id", id);
  if (error) throw new Error(error.message);
}
