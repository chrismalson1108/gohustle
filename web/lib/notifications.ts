"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase } from "./supabaseClient";

export interface NotificationRow {
  id: string;
  type: string;
  title: string;
  body: string | null;
  job_id: string | null;
  read: boolean;
  created_at: string;
}

export async function listNotifications(): Promise<NotificationRow[]> {
  const { data } = await supabase
    .from("notifications")
    .select("id, type, title, body, job_id, read, created_at")
    .order("created_at", { ascending: false })
    .limit(50);
  return (data as NotificationRow[]) ?? [];
}

export async function markRead(id: string): Promise<void> {
  await supabase.from("notifications").update({ read: true }).eq("id", id);
}

export async function markAllRead(): Promise<void> {
  await supabase.from("notifications").update({ read: true }).eq("read", false);
}

// Live unread count for the nav badge. Refetches on mount and on any realtime
// change to the user's notifications (RLS scopes the stream to the owner). If the
// table isn't in the realtime publication the manual refresh still works.
export function useUnreadNotifications() {
  const [count, setCount] = useState(0);

  const refresh = useCallback(async () => {
    const { count: c } = await supabase
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("read", false);
    setCount(c ?? 0);
  }, []);

  useEffect(() => {
    refresh();
    const ch = supabase
      .channel("notifications-badge")
      .on("postgres_changes", { event: "*", schema: "public", table: "notifications" }, () => refresh())
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [refresh]);

  return { count, refresh };
}
