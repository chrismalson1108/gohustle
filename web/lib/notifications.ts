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

// ── Per-user notification preferences ────────────────────────────────────────
// Mirrors the mobile src/lib/notifications.js and the notification_preferences
// table defaults. Default email posture is "high-value only": bookings + payments
// email; messages + marketing don't (users can opt in). All categories push.
export interface NotifPrefs {
  bookings_push: boolean;
  bookings_email: boolean;
  messages_push: boolean;
  messages_email: boolean;
  payments_push: boolean;
  payments_email: boolean;
  marketing_push: boolean;
  marketing_email: boolean;
}

export const DEFAULT_NOTIF_PREFS: NotifPrefs = {
  bookings_push: true, bookings_email: true,
  messages_push: true, messages_email: false,
  payments_push: true, payments_email: true,
  marketing_push: true, marketing_email: false,
};

const PREF_KEYS = Object.keys(DEFAULT_NOTIF_PREFS) as (keyof NotifPrefs)[];

export const NOTIF_CATEGORIES: { key: string; label: string; hint: string }[] = [
  { key: "bookings", label: "Bookings", hint: "Requests, accepts, completion & changes" },
  { key: "messages", label: "Messages", hint: "New chat messages" },
  { key: "payments", label: "Payments & tips", hint: "Payouts, tips & adjustments" },
  { key: "marketing", label: "News & tips", hint: "Product updates and promos" },
];

export async function getNotificationPrefs(): Promise<NotifPrefs> {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { ...DEFAULT_NOTIF_PREFS };
    const { data } = await supabase
      .from("notification_preferences")
      .select("*")
      .eq("user_id", user.id)
      .maybeSingle();
    if (!data) return { ...DEFAULT_NOTIF_PREFS };
    const merged = { ...DEFAULT_NOTIF_PREFS };
    for (const k of PREF_KEYS) if (typeof data[k] === "boolean") merged[k] = data[k];
    return merged;
  } catch {
    return { ...DEFAULT_NOTIF_PREFS };
  }
}

export async function saveNotificationPrefs(prefs: NotifPrefs): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;
  const row: Record<string, unknown> = { user_id: user.id, updated_at: new Date().toISOString() };
  for (const k of PREF_KEYS) row[k] = prefs[k];
  const { error } = await supabase.from("notification_preferences").upsert(row, { onConflict: "user_id" });
  if (error) throw error;
}
