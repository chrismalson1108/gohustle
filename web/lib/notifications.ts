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
// The keys are send-push's KNOWN_TABS and must stay complete: an alert whose
// data.tab is missing here resolves to href null, so tapping it marks the row read,
// navigates nowhere and leaves a dead button. ProfileTab was the missing one — it
// carries the DB-written "Two-factor authentication was turned off … change your
// password now" alert, the Stripe payout landed/failed alerts, and every admin
// notice from the console. Mobile hit the same omission and fixed it there;
// __tests__/parity.test.js now pins both clients to KNOWN_TABS.
const TAB_ROUTE: Record<string, string> = {
  EarnTab: "/my-jobs",
  GigsTab: "/hiring",
  MessagesTab: "/messages",
  HomeTab: "/browse",
  ProfileTab: "/profile",
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

// FAILS CLOSED, exactly as the mobile copy does. Returning the defaults when the
// read errored made "your read failed" indistinguishable from "you have no row
// yet"; the page rendered them as the user's live settings and the next toggle
// wrote the whole eight-column row back over their saved opt-outs.
export async function getNotificationPrefs(): Promise<NotifPrefs> {
  const { data: auth, error: authError } = await supabase.auth.getUser();
  if (authError) throw authError;
  const user = auth?.user;
  if (!user) return { ...DEFAULT_NOTIF_PREFS };
  const { data, error } = await supabase
    .from("notification_preferences")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return { ...DEFAULT_NOTIF_PREFS };
  const merged = { ...DEFAULT_NOTIF_PREFS };
  for (const k of PREF_KEYS) if (typeof data[k] === "boolean") merged[k] = data[k];
  return merged;
}

// Write ONE preference. Single-key on purpose: a whole-object upsert carries the
// seven columns the user did not touch, so anything wrong with the in-memory copy
// is written over the stored row.
export async function saveNotificationPref(key: keyof NotifPrefs, value: boolean): Promise<void> {
  if (!PREF_KEYS.includes(key)) throw new Error(`Unknown notification preference: ${String(key)}`);
  if (typeof value !== "boolean") throw new Error("Notification preference must be a boolean");
  const { data: auth, error: authError } = await supabase.auth.getUser();
  if (authError) throw authError;
  const user = auth?.user;
  // Not a silent no-op: the switch has already moved optimistically.
  if (!user) throw new Error("Not signed in");

  const patch: Record<string, unknown> = { [key]: value, updated_at: new Date().toISOString() };
  const { data: updated, error } = await supabase
    .from("notification_preferences")
    .update(patch)
    .eq("user_id", user.id)
    .select("user_id");
  if (error) throw error;
  if (updated && updated.length > 0) return;

  // No row yet — create one from the defaults with this single change applied.
  const { error: insertError } = await supabase
    .from("notification_preferences")
    .insert({ user_id: user.id, ...DEFAULT_NOTIF_PREFS, ...patch });
  if (!insertError) return;
  // A row appeared between the UPDATE and the INSERT: patch it, never replace it.
  if (insertError.code !== "23505") throw insertError;
  const { error: retryError } = await supabase
    .from("notification_preferences")
    .update(patch)
    .eq("user_id", user.id);
  if (retryError) throw retryError;
}
