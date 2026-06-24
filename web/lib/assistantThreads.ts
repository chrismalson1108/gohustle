import { supabase } from "./supabaseClient";

// Past Hustlr AI conversations. The assistant_threads / assistant_messages tables
// are owner-RLS, so the client reads them directly (no edge function needed).

export interface ThreadRow {
  id: string;
  title: string | null;
  updated_at: string;
  created_at: string;
}

export interface ThreadMessage {
  role: "user" | "assistant";
  content: string;
  created_at: string;
}

export async function listThreads(): Promise<ThreadRow[]> {
  const { data } = await supabase
    .from("assistant_threads")
    .select("id, title, updated_at, created_at")
    .order("updated_at", { ascending: false })
    .limit(50);
  return (data as ThreadRow[]) ?? [];
}

export async function loadThread(threadId: string): Promise<ThreadMessage[]> {
  const { data } = await supabase
    .from("assistant_messages")
    .select("role, content, created_at")
    .eq("thread_id", threadId)
    .order("created_at", { ascending: true });
  return (data as ThreadMessage[]) ?? [];
}

export async function deleteThread(threadId: string): Promise<void> {
  // FK on assistant_messages cascades, so the messages go with it.
  await supabase.from("assistant_threads").delete().eq("id", threadId);
}
