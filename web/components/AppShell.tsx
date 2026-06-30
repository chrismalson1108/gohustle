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
  { href: "/hiring", label: "Hiring", icon: Megaphone, badge: "poster" },
  { href: "/messages", label: "Messages", icon: MessageCircle, badge: "unread" },
  { href: "/notifications", label: "Alerts", icon: Bell, badge: "alerts" },
  { href: "/profile", label: "Profile", icon: UserCircle2, badge: null },
] as const;

function Badge({ count }: { count: number }) {
  if (!count) return null;
  return (
    <span className="ml-auto inline-flex min-w-5 items-center justify-center rounded-full bg-urgent px-1.5 text-[11px] font-black text-white">
      {count}
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
    <div className="mx-auto flex min-h-screen w-full max-w-7xl">
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r border-line bg-white px-4 py-6 md:flex">
        <Link href="/browse" className="mb-8 px-2">
          <Logo mark height={38} />
        </Link>
        <nav className="flex flex-1 flex-col gap-1">
          {NAV.map((item) => {
            const active = isActive(item.href);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={classNames(
                  "flex items-center gap-3 rounded-2xl px-3 py-2.5 text-[15px] font-bold transition",
                  active ? "bg-primary-light text-primary" : "text-ink-soft hover:bg-primary-light/50",
                )}
              >
                <Icon className="size-5" />
                {item.label}
                <Badge count={badgeFor(item.badge)} />
              </Link>
            );
          })}
        </nav>
      </aside>

      {/* Main content — leave room for the fixed mobile tab bar + the iOS home indicator. */}
      <main className="min-w-0 flex-1 pb-[calc(4.5rem+env(safe-area-inset-bottom))] md:pb-0">{children}</main>

      {/* Mobile bottom tab bar — padded to clear the iOS home indicator. */}
      <nav className="fixed inset-x-0 bottom-0 z-40 flex border-t border-line bg-white pb-[env(safe-area-inset-bottom)] md:hidden">
        {NAV.map((item) => {
          const active = isActive(item.href);
          const Icon = item.icon;
          const count = badgeFor(item.badge);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={classNames(
                "relative flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] font-bold",
                active ? "text-primary" : "text-ink-muted",
              )}
            >
              <Icon className="size-5" />
              {item.label}
              {count > 0 && (
                <span className="absolute right-1/2 top-1 translate-x-3 rounded-full bg-urgent px-1 text-[9px] font-black text-white">
                  {count}
                </span>
              )}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
