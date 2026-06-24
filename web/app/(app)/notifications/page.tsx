"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Bell, Briefcase, MessageCircle, CheckCheck, X, ArchiveRestore } from "lucide-react";
import {
  listNotifications,
  markRead,
  markAllRead,
  setArchived,
  notificationHref,
  type NotificationRow,
} from "@/lib/notifications";
import { supabase } from "@/lib/supabaseClient";
import PageHeader, { PageContainer, EmptyState } from "@/components/PageHeader";
import { classNames } from "@/lib/format";

function relTime(iso: string): string {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

function iconFor(type: string) {
  if (type === "saved_search") return <Briefcase className="size-5" />;
  if (type === "message") return <MessageCircle className="size-5" />;
  return <Bell className="size-5" />;
}

export default function NotificationsPage() {
  const router = useRouter();
  const [tab, setTab] = useState<"inbox" | "archived">("inbox");
  const [items, setItems] = useState<NotificationRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setItems(await listNotifications(tab === "archived"));
    setLoading(false);
  }, [tab]);

  useEffect(() => {
    setLoading(true);
    load();
    const ch = supabase
      .channel("notifications-page")
      .on("postgres_changes", { event: "*", schema: "public", table: "notifications" }, () => load())
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [load]);

  const open = (n: NotificationRow) => {
    if (!n.read) {
      markRead(n.id);
      setItems((xs) => xs.map((x) => (x.id === n.id ? { ...x, read: true } : x)));
    }
    const href = notificationHref(n);
    if (href) router.push(href);
  };

  const archive = async (n: NotificationRow, archived: boolean) => {
    await setArchived(n.id, archived);
    setItems((xs) => xs.filter((x) => x.id !== n.id)); // leaves the current tab
  };

  const allRead = async () => {
    await markAllRead();
    setItems((xs) => xs.map((x) => ({ ...x, read: true })));
  };

  const hasUnread = items.some((i) => !i.read);

  return (
    <div>
      <PageHeader
        title="Alerts"
        subtitle="Gig matches and updates"
        right={
          tab === "inbox" && hasUnread ? (
            <button onClick={allRead} className="flex items-center gap-1 rounded-full bg-white/15 px-3 py-1.5 text-xs font-bold text-white hover:bg-white/25">
              <CheckCheck className="size-3.5" /> Mark all read
            </button>
          ) : undefined
        }
      />
      <PageContainer>
        {/* Inbox / Archived segmented control */}
        <div className="mb-4 flex gap-1 rounded-2xl bg-line/60 p-1">
          {(["inbox", "archived"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={classNames(
                "flex-1 rounded-xl py-2 text-sm font-bold capitalize transition",
                tab === t ? "bg-white text-primary shadow-sm" : "text-ink-soft",
              )}
            >
              {t}
            </button>
          ))}
        </div>

        {loading ? null : items.length === 0 ? (
          <EmptyState
            icon={<Bell className="size-10" />}
            title={tab === "inbox" ? "No alerts yet" : "Nothing archived"}
            body={
              tab === "inbox"
                ? "Booking updates, messages, and gig matches show up here. Ask Hustlr AI to watch for gigs (e.g. “tell me when photography gigs come up”)."
                : "Alerts you archive will be kept here."
            }
          />
        ) : (
          <div className="space-y-2">
            {items.map((n) => {
              const href = notificationHref(n);
              return (
                <div
                  key={n.id}
                  className={classNames(
                    "flex items-start gap-3 rounded-2xl p-3.5 shadow-[var(--shadow-card)] ring-1 transition",
                    n.read || tab === "archived" ? "bg-white ring-line/70" : "bg-primary-light/40 ring-primary/30",
                  )}
                >
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary-light text-primary">
                    {iconFor(n.type)}
                  </div>
                  <button onClick={() => open(n)} disabled={!href && n.read} className="min-w-0 flex-1 text-left">
                    <p className="font-bold text-ink">{n.title}</p>
                    {n.body && <p className="truncate text-sm text-ink-soft">{n.body}</p>}
                    <p className="mt-0.5 text-[11px] text-ink-muted">{relTime(n.created_at)}</p>
                  </button>
                  <button
                    onClick={() => archive(n, tab === "inbox")}
                    aria-label={tab === "inbox" ? "Archive" : "Move to inbox"}
                    title={tab === "inbox" ? "Archive" : "Move to inbox"}
                    className="shrink-0 rounded-full p-1.5 text-ink-muted hover:bg-line/60 hover:text-ink"
                  >
                    {tab === "inbox" ? <X className="size-4" /> : <ArchiveRestore className="size-4" />}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </PageContainer>
    </div>
  );
}
