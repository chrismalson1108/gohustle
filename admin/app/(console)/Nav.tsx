"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Grouped sidebar nav.
//
// This replaced a single row of 15 links that had run out of room — the row was
// wrapping into the sign-out control, and every destination sat at equal visual
// weight, so "Audit" and "Payments" looked like the same kind of thing. With
// /pricing and /promotions still to come, a flat row was never going to hold.
//
// The grouping answers "what am I here to do?" rather than mirroring the routes:
// money questions in one place, trust-and-safety in another, and the platform's own
// health (controls, errors, flags, audit) in a third. Dashboard stays ungrouped
// because it is the landing page, not a category.
//
// Client component only so usePathname can mark the active item. Knowing where you
// are is most of what makes a console navigable; the server has no cheap way to
// tell each link whether it is current.

type Item = { href: string; label: string; minRole?: "admin" | "finance" | "trust" | "support" };
type Group = { title: string | null; items: Item[] };
type Role = "admin" | "finance" | "trust" | "support";

// Mirrors roleSatisfies() in admin/lib/guard.ts. Duplicated deliberately: the guard is
// server-only and this is a client component, and nav visibility is cosmetic — the
// guard is the actual enforcement. If they ever disagree, the guard wins and the user
// sees a 403, which is the safe direction.
const SATISFIES: Record<Role, ReadonlySet<Role>> = {
  admin: new Set<Role>(["admin"]),
  finance: new Set<Role>(["admin", "finance"]),
  trust: new Set<Role>(["admin", "trust"]),
  support: new Set<Role>(["admin", "finance", "trust", "support"]),
};

const GROUPS: Group[] = [
  { title: null, items: [{ href: "/", label: "Dashboard" }] },
  {
    title: "Marketplace",
    items: [
      { href: "/jobs", label: "Jobs" },
      { href: "/categories", label: "Categories" },
      { href: "/bookings", label: "Bookings" },
    ],
  },
  {
    title: "Money",
    items: [
      { href: "/payments", label: "Payments", minRole: "finance" },
      { href: "/disputes", label: "Disputes", minRole: "trust" },
    ],
  },
  {
    title: "Trust & safety",
    items: [
      { href: "/moderation", label: "Moderation", minRole: "trust" },
      { href: "/support", label: "Support" },
    ],
  },
  {
    title: "People",
    items: [
      { href: "/users", label: "Users" },
      { href: "/access", label: "Access" },
      { href: "/team", label: "Team", minRole: "admin" },
    ],
  },
  {
    title: "Platform",
    items: [
      { href: "/controls", label: "Controls" },
      { href: "/errors", label: "Errors" },
      { href: "/flags", label: "Flags", minRole: "admin" },
      { href: "/audit", label: "Audit", minRole: "admin" },
    ],
  },
];

function isActive(pathname: string, href: string): boolean {
  // "/" must match only itself, or it lights up on every page.
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(href + "/");
}

export default function Nav({ role }: { role: string }) {
  const pathname = usePathname() || "/";
  const groups = GROUPS.map((g) => ({
    ...g,
    // Hide what this role cannot open. A visible link that 403s is worse than an
    // absent one: it teaches people the console is broken rather than that they
    // lack access.
    items: g.items.filter((i) => !i.minRole || SATISFIES[i.minRole].has(role as Role)),
  })).filter((g) => g.items.length > 0);

  return (
    <nav
      aria-label="Console"
      className="flex gap-1 overflow-x-auto border-b border-[var(--line)] px-4 py-2 md:sticky md:top-0 md:h-[calc(100vh-3.25rem)] md:w-52 md:shrink-0 md:flex-col md:gap-0 md:overflow-y-auto md:border-b-0 md:border-r md:px-3 md:py-4"
    >
      {groups.map((g, gi) => (
        // Below md the group headings are hidden and everything becomes one
        // horizontal strip, where gap alone cannot distinguish "next item" from
        // "next group". A hairline divider carries the grouping that the headings
        // carry on desktop; it is suppressed on the first group and on md+.
        <div
          key={g.title ?? `g${gi}`}
          className={`flex shrink-0 items-center gap-1 md:mb-4 md:block md:border-l-0 md:pl-0 ${
            gi > 0 ? "ml-1 border-l border-[var(--line)] pl-2 md:ml-0" : ""
          }`}
        >
          {g.title && (
            <div className="hidden px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)] md:block">
              {g.title}
            </div>
          )}
          {g.items.map((i) => {
            const active = isActive(pathname, i.href);
            return (
              <Link
                key={i.href}
                href={i.href}
                aria-current={active ? "page" : undefined}
                className={`block shrink-0 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-sm transition-colors ${
                  active
                    ? "bg-[var(--brand)] font-medium text-white"
                    : "text-[var(--ink)] hover:bg-[var(--surface)]"
                }`}
              >
                {i.label}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
