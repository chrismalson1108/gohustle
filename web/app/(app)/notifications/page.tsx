"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Bell, Briefcase } from "lucide-react";
import { listNotifications, markRead, markAllRead, type NotificationRow } from "@/lib/notifications";
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

export default function NotificationsPage() {
  const router = useRouter();
  const [items, setItems] = useState<NotificationRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      setItems(await listNotifications());
      setLoading(false);
    };
    load();
    const ch = supabase
      .channel("notifications-page")
      .on("postgres_changes", { event: "*", schema: "public", table: "notifications" }, () => load())
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, []);

  const open = (n: NotificationRow) => {
    if (!n.read) {
      markRead(n.id);
      setItems((xs) => xs.map((x) => (x.id === n.id ? { ...x, read: true } : x)));
    }
    if (n.job_id) router.push(`/jobs/${n.job_id}`);
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
          hasUnread ? (
            <button onClick={allRead} className="rounded-full bg-white/15 px-3 py-1.5 text-xs font-bold text-white hover:bg-white/25">
              Mark all read
            </button>
          ) : undefined
        }
      />
      <PageContainer>
        {loading ? null : items.length === 0 ? (
          <EmptyState icon={<Bell className="size-10" />} title="No alerts yet" body="Ask Hustlr AI to watch for gigs (e.g. “tell me when photography gigs come up”) and matches show up here." />
        ) : (
          <div className="space-y-2">
            {items.map((n) => (
              <button
                key={n.id}
                onClick={() => open(n)}
                className={classNames(
                  "flex w-full items-start gap-3 rounded-2xl p-3.5 text-left shadow-[var(--shadow-card)] ring-1 transition",
                  n.read ? "bg-white ring-line/70" : "bg-primary-light/40 ring-primary/30",
                )}
              >
                <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary-light text-primary">
                  {n.type === "saved_search" ? <Briefcase className="size-5" /> : <Bell className="size-5" />}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="font-bold text-ink">{n.title}</p>
                  {n.body && <p className="truncate text-sm text-ink-soft">{n.body}</p>}
                  <p className="mt-0.5 text-[11px] text-ink-muted">{relTime(n.created_at)}</p>
                </div>
                {!n.read && <span className="mt-1 size-2.5 shrink-0 rounded-full bg-primary" />}
              </button>
            ))}
          </div>
        )}
      </PageContainer>
    </div>
  );
}
