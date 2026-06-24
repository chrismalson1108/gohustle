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
  archived: boolean;
  data: Record<string, unknown> | null;
  created_at: string;
}

const COLS = "id, type, title, body, job_id, read, archived, data, created_at";

export async function listNotifications(archived = false): Promise<NotificationRow[]> {
  const { data } = await supabase
    .from("notifications")
    .select(COLS)
    .eq("archived", archived)
    .order("created_at", { ascending: false })
    .limit(50);
  return (data as NotificationRow[]) ?? [];
}

export async function markRead(id: string): Promise<void> {
  await supabase.from("notifications").update({ read: true }).eq("id", id);
}

export async function markAllRead(): Promise<void> {
  await supabase.from("notifications").update({ read: true }).eq("read", false).eq("archived", false);
}

export async function setArchived(id: string, archived: boolean): Promise<void> {
  await supabase.from("notifications").update({ archived }).eq("id", id);
}

// Archive everything already read in the inbox (the "clear handled alerts" action).
export async function archiveAllRead(): Promise<void> {
  await supabase.from("notifications").update({ archived: true }).eq("read", true).eq("archived", false);
}

// Where an alert should take you when tapped (gig deep-link, else a tab).
const TAB_ROUTE: Record<string, string> = {
  EarnTab: "/my-jobs",
  GigsTab: "/hiring",
  MessagesTab: "/messages",
  HomeTab: "/browse",
};
export function notificationHref(n: NotificationRow): string | null {
  if (n.job_id) return `/jobs/${n.job_id}`;
  const tab = (n.data?.tab as string) || "";
  return TAB_ROUTE[tab] ?? null;
}

// Live unread count (non-archived) for the nav badge.
export function useUnreadNotifications() {
  const [count, setCount] = useState(0);

  const refresh = useCallback(async () => {
    const { count: c } = await supabase
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("read", false)
      .eq("archived", false);
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
