"use client";

import { useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Search, Briefcase, Megaphone, MessageCircle, UserCircle2, Bell } from "lucide-react";
import { useJobs } from "@/lib/jobs";
import { useUnreadNotifications } from "@/lib/notifications";
import { classNames } from "@/lib/format";
import Logo from "./Logo";

const NAV = [
  { href: "/browse", label: "Browse", icon: Search, badge: null },
  { href: "/my-jobs", label: "My Jobs", icon: Briefcase, badge: "earn" },
  { href: "/hiring", label: "Hire", icon: Megaphone, badge: "poster" },
  { href: "/messages", label: "Messages", icon: MessageCircle, badge: "unread" },
  { href: "/notifications", label: "Alerts", icon: Bell, badge: "alerts" },
  { href: "/profile", label: "You", icon: UserCircle2, badge: null },
] as const;

function Badge({ count }: { count: number }) {
  if (!count) return null;
  return (
    <span className="ml-auto inline-flex min-w-5 items-center justify-center rounded-full bg-urgent px-1.5 text-[11px] font-bold text-white">
      {count > 99 ? "99+" : count}
    </span>
  );
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { earnBadgeCount, profileBadgeCount, unreadMessages, refreshUnread } = useJobs();
  const { count: alertCount, refresh: refreshAlerts } = useUnreadNotifications();

  // Re-sync the alert + message counts on every navigation. The realtime channels
  // can miss updates (e.g. after clearing alerts), which left the badge stale; this
  // guarantees the badges are fresh whenever the user moves between pages.
  useEffect(() => {
    refreshAlerts();
    refreshUnread();
  }, [pathname, refreshAlerts, refreshUnread]);

  const badgeFor = (kind: string | null) =>
    kind === "earn"
      ? earnBadgeCount
      : kind === "poster"
        ? profileBadgeCount
        : kind === "unread"
          ? unreadMessages
          : kind === "alerts"
            ? alertCount
            : 0;

  const isActive = (href: string) => pathname === href || pathname.startsWith(href + "/");

  return (
    // No app-wide max-width: the shell spans the full viewport at every size, so
    // the page fills a wide monitor instead of sitting as a fixed island in a sea
    // of cream. Each page bounds its own content measure (see PageHeader WIDTHS).
    <div className="flex min-h-dvh w-full">
      {/* ── Desktop sidebar ────────────────────────────────────────────────
          Three widths, so it stays proportional rather than being a fixed 256px
          slab that dominates a narrow window and looks lost on a wide one:
            md  icon-only rail (76px) — tablet, replaces the bottom tab bar
            lg  labeled (240px)
            2xl labeled (256px)
          Below md it is replaced by the bottom tab bar. */}
      <aside className="sticky top-0 hidden h-dvh shrink-0 flex-col border-r border-line bg-white md:flex md:w-[76px] lg:w-60 lg:px-4 2xl:w-64">
        <Link
          href="/browse"
          className="mb-6 mt-6 flex items-center justify-center lg:mb-8 lg:justify-start lg:px-2"
          aria-label="Hustlr home"
        >
          <Logo mark height={34} />
        </Link>
        <nav className="flex flex-1 flex-col gap-1 px-2 lg:px-0">
          {NAV.map((item) => {
            const active = isActive(item.href);
            const Icon = item.icon;
            const count = badgeFor(item.badge);
            return (
              <Link
                key={item.href}
                href={item.href}
                title={item.label}
                aria-current={active ? "page" : undefined}
                className={classNames(
                  "relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-[15px] font-semibold transition",
                  "justify-center lg:justify-start",
                  active ? "bg-primary-light text-primary" : "text-ink-soft hover:bg-canvas",
                )}
              >
                <Icon className="size-5 shrink-0" />
                {/* Icon-only rail between md and lg — label is hidden, not removed,
                    so the accessible name and title tooltip survive. */}
                <span className="hidden lg:inline">{item.label}</span>
                <span className="hidden lg:contents">
                  <Badge count={count} />
                </span>
                {count > 0 && (
                  <span className="absolute right-1.5 top-1.5 size-2 rounded-full bg-urgent lg:hidden" />
                )}
              </Link>
            );
          })}
        </nav>
      </aside>

      {/* Main content — min-w-0 so wide children (tables, card grids, chat) shrink
          inside the flex row instead of forcing the page to scroll sideways.
          Bottom padding clears the fixed mobile tab bar + the iOS home indicator.

          `@container` makes this element the query container for everything
          inside it, so page grids can size against the space they ACTUALLY have
          rather than the viewport. A viewport-based `lg:grid-cols-3` is always
          off by one sidebar width — at 1024px the content box is only 784px. */}
      <main className="@container min-w-0 flex-1 pb-[calc(4.5rem+env(safe-area-inset-bottom))] md:pb-0">
        {children}
      </main>

      {/* ── Mobile bottom tab bar ──────────────────────────────────────────── */}
      <nav className="fixed inset-x-0 bottom-0 z-40 flex border-t border-line bg-white pb-[env(safe-area-inset-bottom)] md:hidden">
        {NAV.map((item) => {
          const active = isActive(item.href);
          const Icon = item.icon;
          const count = badgeFor(item.badge);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={classNames(
                "relative flex min-w-0 flex-1 flex-col items-center gap-0.5 py-2 text-[10px] font-semibold",
                active ? "text-primary" : "text-ink-muted",
              )}
            >
              <Icon className="size-5 shrink-0" />
              {/* Truncate rather than wrap: six labels on a 320px screen have
                  ~53px each, and a wrapped label pushes the bar taller. */}
              <span className="w-full truncate px-0.5 text-center">{item.label}</span>
              {count > 0 && (
                <span className="absolute right-1/2 top-1 translate-x-3 rounded-full bg-urgent px-1 text-[9px] font-bold text-white">
                  {count > 9 ? "9+" : count}
                </span>
              )}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
