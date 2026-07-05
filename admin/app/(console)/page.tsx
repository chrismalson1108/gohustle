import Link from "next/link";
import { requireAdminPage } from "@/lib/guard";
import { fmtCents, fmtDate } from "@/lib/format";
import { StatCard, Section, Pill } from "@/lib/ui";

export const metadata = { title: "Dashboard" };

interface Metrics {
  users_total: number;
  signups_today: number;
  signups_7d: number;
  signups_30d: number;
  suspended_users: number;
  jobs_open: number;
  jobs_total: number;
  bookings_pending: number;
  bookings_confirmed: number;
  bookings_completed: number;
  bookings_verified: number;
  gmv_captured_cents: number;
  fees_captured_cents: number;
  escrow_held_cents: number;
  disputes_total: number;
  disputes_7d: number;
  reports_total: number;
  reports_7d: number;
}

export default async function DashboardPage() {
  const ctx = await requireAdminPage("support");

  const { data: m, error } = await ctx.service.rpc("admin_dashboard_metrics");
  const metrics = (m ?? {}) as Metrics;

  // Recent signups + recent admin activity, in parallel.
  const [recentUsers, recentAudit] = await Promise.all([
    ctx.service
      .from("profiles")
      .select("id, name, username, created_at, verified, suspended_at")
      .order("created_at", { ascending: false })
      .limit(8),
    ctx.role === "admin"
      ? ctx.service
          .from("admin_audit_log")
          .select("id, action, target_id, created_at")
          .order("created_at", { ascending: false })
          .limit(8)
      : Promise.resolve({ data: [] as { id: number; action: string; target_id: string | null; created_at: string }[] }),
  ]);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Dashboard</h1>

      {error && <p className="text-sm text-[var(--danger)]">Metrics failed: {error.message}</p>}

      {/* Attention row — things that may need action */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard
          label="Open reports"
          value={metrics.reports_total ?? 0}
          sub={`${metrics.reports_7d ?? 0} in last 7d`}
          href="/moderation"
          tone={metrics.reports_total ? "red" : undefined}
        />
        <StatCard
          label="Disputes"
          value={metrics.disputes_total ?? 0}
          sub={`${metrics.disputes_7d ?? 0} in last 7d`}
          href="/payments"
          tone={metrics.disputes_total ? "amber" : undefined}
        />
        <StatCard
          label="Suspended"
          value={metrics.suspended_users ?? 0}
          href="/users"
          tone={metrics.suspended_users ? "amber" : undefined}
        />
        <StatCard
          label="Escrow held"
          value={fmtCents(metrics.escrow_held_cents)}
          sub="authorized, uncaptured"
          href="/payments"
        />
      </div>

      {/* Growth */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard label="Total users" value={metrics.users_total ?? 0} />
        <StatCard label="New today" value={metrics.signups_today ?? 0} />
        <StatCard label="New (7d)" value={metrics.signups_7d ?? 0} />
        <StatCard label="New (30d)" value={metrics.signups_30d ?? 0} />
      </div>

      {/* Marketplace + money */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard label="Open gigs" value={metrics.jobs_open ?? 0} sub={`${metrics.jobs_total ?? 0} total`} href="/jobs" />
        <StatCard
          label="Active bookings"
          value={(metrics.bookings_pending ?? 0) + (metrics.bookings_confirmed ?? 0) + (metrics.bookings_completed ?? 0)}
          sub={`${metrics.bookings_verified ?? 0} verified`}
          href="/jobs"
        />
        <StatCard label="GMV captured" value={fmtCents(metrics.gmv_captured_cents)} sub="all-time" />
        <StatCard label="Platform fees" value={fmtCents(metrics.fees_captured_cents)} sub="all-time" />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Newest users">
          <ul className="text-sm">
            {(recentUsers.data ?? []).map((u) => (
              <li key={u.id} className="flex items-center justify-between border-t border-[var(--line)] py-2 first:border-0">
                <Link href={`/users/${u.id}`} className="font-medium text-[var(--brand)] hover:underline">
                  {u.name ?? "—"} {u.username ? <span className="text-[var(--muted)]">@{u.username}</span> : null}
                </Link>
                <span className="flex items-center gap-2 text-xs text-[var(--muted)]">
                  {u.suspended_at ? <Pill tone="red">suspended</Pill> : u.verified ? <Pill tone="green">verified</Pill> : null}
                  {fmtDate(u.created_at)}
                </span>
              </li>
            ))}
          </ul>
        </Section>

        {ctx.role === "admin" && (
          <Section title="Recent admin activity" right={<Link href="/audit" className="text-xs text-[var(--brand)] hover:underline">Full log →</Link>}>
            <ul className="text-sm">
              {(recentAudit.data ?? []).map((a) => (
                <li key={a.id} className="flex items-center justify-between border-t border-[var(--line)] py-2 first:border-0">
                  <span className="font-mono text-xs">{a.action}</span>
                  <span className="text-xs text-[var(--muted)]">{fmtDate(a.created_at)}</span>
                </li>
              ))}
              {(recentAudit.data ?? []).length === 0 && <li className="py-2 text-[var(--muted)]">No activity yet.</li>}
            </ul>
          </Section>
        )}
      </div>
    </div>
  );
}
