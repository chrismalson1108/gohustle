import Link from "next/link";
import { requireAdminPage } from "@/lib/guard";
import { signOutAction } from "../auth-actions";
import Nav from "./Nav";

// Shell guard — every page inside re-checks with requireAdminPage itself
// (defense in depth); this layout gate is for the nav chrome.
//
// Layout is a thin top bar (identity + sign out) over a grouped sidebar. The nav used
// to be 15 links in a single row, which had visibly run out of room — it was crowding
// the sign-out control, and every destination carried equal weight, so a routine list
// page looked exactly as important as the audit log. See Nav.tsx for the grouping.
export default async function ConsoleLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const ctx = await requireAdminPage("support");

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-[var(--line)] bg-white">
        <div className="flex items-center gap-4 px-4 py-2.5 md:px-6">
          <Link href="/" className="text-sm font-bold text-[var(--brand)]">
            GoHustlr Admin
          </Link>
          <div className="ml-auto flex items-center gap-3 text-sm">
            <span className="rounded-full bg-[var(--surface)] px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
              {ctx.role}
            </span>
            <span className="hidden text-[var(--muted)] sm:inline">{ctx.user.email}</span>
            <form action={signOutAction}>
              <button
                type="submit"
                className="whitespace-nowrap text-[var(--muted)] underline hover:text-[var(--ink)]"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>

      <div className="md:flex">
        <Nav role={ctx.role} />
        <main className="min-w-0 flex-1 px-4 py-6 md:px-8 md:py-8">
          <div className="mx-auto max-w-6xl">{children}</div>
        </main>
      </div>
    </div>
  );
}
