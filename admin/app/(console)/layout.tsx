import Link from "next/link";
import { requireAdminPage } from "@/lib/guard";
import { signOutAction } from "../auth-actions";

// Shell guard — every page inside re-checks with requireAdminPage itself
// (defense in depth); this layout gate is for the nav chrome.
export default async function ConsoleLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const ctx = await requireAdminPage("support");

  return (
    <div className="min-h-screen">
      <header className="border-b border-[var(--line)] bg-white">
        <div className="mx-auto flex max-w-7xl items-center gap-5 px-6 py-3">
          <Link href="/" className="text-sm font-bold text-[var(--brand)]">
            GoHustlr Admin
          </Link>
          <nav className="flex items-center gap-4 text-sm">
            <Link href="/" className="hover:text-[var(--brand)]">Dashboard</Link>
            <Link href="/users" className="hover:text-[var(--brand)]">Users</Link>
            <Link href="/moderation" className="hover:text-[var(--brand)]">Moderation</Link>
            <Link href="/payments" className="hover:text-[var(--brand)]">Payments</Link>
            <Link href="/jobs" className="hover:text-[var(--brand)]">Jobs</Link>
            <Link href="/support" className="hover:text-[var(--brand)]">Support</Link>
            {ctx.role === "admin" && (
              <Link href="/audit" className="hover:text-[var(--brand)]">Audit</Link>
            )}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm">
            <span className="rounded-full bg-[var(--surface)] px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
              {ctx.role}
            </span>
            <span className="text-[var(--muted)]">{ctx.user.email}</span>
            <form action={signOutAction}>
              <button type="submit" className="text-[var(--muted)] underline hover:text-[var(--ink)]">
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-6 py-8">{children}</main>
    </div>
  );
}
