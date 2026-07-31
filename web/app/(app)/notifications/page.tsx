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
import Spinner from "@/components/ui/Spinner";
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
    if (!n.read) markRead(n.id);
    if (tab === "inbox") {
      // Auto-archive on view — handled alerts leave the inbox (still in Archived).
      setArchived(n.id, true);
      setItems((xs) => xs.filter((x) => x.id !== n.id));
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
        width="feed"
        right={
          tab === "inbox" && hasUnread ? (
            // The header is a flat cream surface now — white-on-white text was
            // invisible here. Mobile renders this as a plain primary text link.
            <button
              onClick={allRead}
              className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-full px-3 text-[13px] font-semibold text-primary transition hover:bg-primary-light/60"
            >
              <CheckCheck className="size-4 shrink-0" /> Mark all read
            </button>
          ) : undefined
        }
      />
      <PageContainer width="feed">
        {/* Inbox / Archived segmented control — the same pill control the mobile
            app uses on Messages / Hiring / My Jobs. No shadow on the active pill,
            and the weight stays 600 in both states so the label can't re-measure
            and clip when it becomes active. */}
        <div role="tablist" aria-label="Alert folders" className="mb-4 flex w-full rounded-full border border-line bg-white p-1">
          {(["inbox", "archived"] as const).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={classNames(
                "flex-1 truncate rounded-full px-2 py-2.5 text-[13px] font-semibold capitalize transition",
                tab === t ? "bg-primary text-white" : "text-ink-soft hover:text-ink",
              )}
            >
              {t}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="flex justify-center py-16">
            <Spinner className="size-8" />
          </div>
        ) : items.length === 0 ? (
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
          // Alerts arrive in bursts, so the list is a grid: one column on a
          // phone, two once the content box (not the viewport) is wide enough.
          <div className="grid grid-cols-1 gap-3 pb-8 @5xl:grid-cols-2">
            {items.map((n) => {
              const href = notificationHref(n);
              const unread = !n.read && tab === "inbox";
              return (
                // Every row is the same white card. Unread is carried by a single
                // dot on the icon bubble (mobile's marker) — tinting the whole
                // card turned a full inbox into a wall of purple.
                <div key={n.id} className="flex items-start gap-3 rounded-2xl bg-white p-4 shadow-[var(--shadow-card)]">
                  <div className="relative flex size-9 shrink-0 items-center justify-center rounded-full bg-canvas text-ink-soft">
                    {iconFor(n.type)}
                    {unread && <span className="absolute right-0 top-0 size-2.5 rounded-full bg-primary" />}
                  </div>
                  <button onClick={() => open(n)} disabled={!href && n.read} className="min-w-0 flex-1 text-left">
                    <p className={classNames("line-clamp-2 text-[15px] text-ink", unread ? "font-bold" : "font-semibold")}>
                      {n.title}
                    </p>
                    {/* Two lines, not a hard one-line truncate: on a phone the
                        second half of an alert was being cut off, and on a wide
                        row the truncation was throwing away usable width. */}
                    {n.body && <p className="mt-0.5 line-clamp-2 text-[13.5px] leading-[18px] text-ink-soft">{n.body}</p>}
                    <p className="mt-1 text-xs text-ink-muted">{relTime(n.created_at)}</p>
                  </button>
                  <button
                    onClick={() => archive(n, tab === "inbox")}
                    aria-label={tab === "inbox" ? "Archive" : "Move to inbox"}
                    title={tab === "inbox" ? "Archive" : "Move to inbox"}
                    // An explicit 44px box. Padding around a 16px glyph only
                    // reached 36px, and the negative margin pulls the layout back
                    // in — it does not enlarge the hit area.
                    className="-m-2 flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full text-ink-muted transition hover:text-ink"
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
