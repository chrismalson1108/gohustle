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
  disputes_open: number;
  disputes_7d: number;
  reports_total: number;
  reports_open: number;
  reports_7d: number;
  refunded_cents: number;
  holds_expiring_48h: number;
  bookings_one_sided: number;
  errors_fatal_7d: number;
}

export default async function DashboardPage() {
  const ctx = await requireAdminPage("support");

  const { data: m, error } = await ctx.service.rpc("admin_dashboard_metrics");
  const metrics = (m ?? {}) as Metrics;

  // reports_open / disputes_open now come from the RPC with the same predicates this
  // page used to compute by hand (unresolved, and for reports non-auto-filed).
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
  const openReports = metrics.reports_open ?? 0;

  // CONTROL STATE. The 23 scheduled checks are the only thing watching the parts of
  // this platform no dashboard tile covers — a captured payment never credited, a
  // ledger that disagrees with Stripe, an alert channel that has gone dark. Their
  // findings had no route to this page at all, which meant the dashboard could show
  // an entirely green attention row while a critical money finding sat unread.
  const [{ data: controlState }, { data: topFindings }, { data: liveCampaigns }] = await Promise.all([
    ctx.service.rpc("control_status"),
    ctx.service
      .from("control_findings")
      .select("id, control_key, entity_id, severity, first_seen_at")
      .is("resolved_at", null)
      .in("severity", ["critical", "high"])
      .order("first_seen_at", { ascending: false })
      .limit(5),
    ctx.role === "admin"
      ? ctx.service
          .from("promotions")
          .select("id, name, status, spent_cents, budget_cents, ends_at")
          .eq("status", "active")
      : Promise.resolve({ data: [] as { id: string; name: string; status: string; spent_cents: number; budget_cents: number; ends_at: string | null }[] }),
  ]);

  const cs = (controlState ?? {}) as {
    open?: Record<string, number>;
    errored?: { key: string; error: string }[];
    stale?: string[];
    enabled_count?: number;
  };
  const criticalOpen = cs.open?.critical ?? 0;
  const highOpen = cs.open?.high ?? 0;
  const erroring = cs.errored ?? [];
  const stale = cs.stale ?? [];
  const detectionDegraded = erroring.length > 0 || stale.length > 0;
  const campaignSpend = (liveCampaigns ?? []).reduce((n, c) => n + (c.spent_cents ?? 0), 0);
  const campaignBudget = (liveCampaigns ?? []).reduce((n, c) => n + (c.budget_cents ?? 0), 0);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Dashboard</h1>

      {error && <p className="text-sm text-[var(--danger)]">Metrics failed: {error.message}</p>}

      {/* DETECTION HEALTH FIRST. If the checks are not running, nothing below this line
          means anything — an empty attention row is only reassuring when something is
          actually looking. This is deliberately above the metrics. */}
      {detectionDegraded && (
        <Link
          href="/controls"
          className="block rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900 hover:border-red-500"
        >
          <strong>Monitoring is degraded — the numbers below may not be trustworthy.</strong>
          {erroring.length > 0 && (
            <div className="mt-1">
              {erroring.length} control{erroring.length === 1 ? "" : "s"} erroring:{" "}
              {erroring.slice(0, 3).map((c) => c.key).join(", ")}
            </div>
          )}
          {stale.length > 0 && (
            <div className="mt-1">
              {stale.length} control{stale.length === 1 ? "" : "s"} have not run in 6h:{" "}
              {stale.slice(0, 3).join(", ")}
            </div>
          )}
        </Link>
      )}

      {criticalOpen > 0 && (
        <Link
          href="/controls?sev=critical"
          className="block rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900 hover:border-red-500"
        >
          <strong>
            {criticalOpen} critical finding{criticalOpen === 1 ? "" : "s"} open
          </strong>
          {highOpen > 0 && <> · {highOpen} high</>}
          <ul className="mt-1 list-disc pl-5">
            {(topFindings ?? []).slice(0, 4).map((f) => (
              <li key={f.id}>
                <span className="font-mono text-xs">{f.control_key}</span>
                {f.entity_id ? <span className="opacity-70"> · {f.entity_id.slice(0, 20)}</span> : null}
              </li>
            ))}
          </ul>
        </Link>
      )}

      {!detectionDegraded && criticalOpen === 0 && (
        <p className="rounded-xl border border-green-300 bg-green-50 px-4 py-2 text-sm text-green-900">
          All {cs.enabled_count ?? 0} controls ran recently with no errors and no critical findings.
        </p>
      )}

      {/* Attention row — things that may need action */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard
          label="Open reports"
          value={openReports}
          sub={`${metrics.reports_7d ?? 0} in last 7d`}
          href="/moderation"
          tone={openReports ? "red" : undefined}
        />
        <StatCard
          label="Open disputes"
          value={metrics.disputes_open ?? 0}
          sub={`${metrics.disputes_7d ?? 0} raised in 7d`}
          href="/disputes"
          tone={metrics.disputes_open ? "amber" : undefined}
        />
        {/* Every one of these is a worker who may go unpaid on completed work when the
            ~7-day Stripe authorization lapses. Red because it is time-bounded — unlike
            the other tiles, waiting makes it unfixable. */}
        <StatCard
          label="Holds expiring"
          value={metrics.holds_expiring_48h ?? 0}
          sub="authorized 5+ days"
          href="/bookings?filter=expiring"
          tone={metrics.holds_expiring_48h ? "red" : undefined}
        />
        <StatCard
          label="One-sided bookings"
          value={metrics.bookings_one_sided ?? 0}
          sub="one party pressed done"
          href="/bookings?filter=one_sided"
          tone={metrics.bookings_one_sided ? "amber" : undefined}
        />
      </div>

      {/* Growth */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard label="Total users" value={metrics.users_total ?? 0} href="/users" />
        <StatCard label="New today" value={metrics.signups_today ?? 0} />
        <StatCard label="New (7d)" value={metrics.signups_7d ?? 0} />
        <StatCard label="New (30d)" value={metrics.signups_30d ?? 0} />
      </div>

      {/* Live campaign spend — margin leaving the business right now, which nothing on
          this page used to show. Admin-only, matching /promotions. */}
      {ctx.role === "admin" && (liveCampaigns ?? []).length > 0 && (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <StatCard
            label="Live campaigns"
            value={(liveCampaigns ?? []).length}
            sub={`${fmtCents(campaignSpend)} of ${fmtCents(campaignBudget)} spent`}
            href="/promotions"
            tone={campaignBudget > 0 && campaignSpend / campaignBudget > 0.8 ? "amber" : undefined}
          />
        </div>
      )}

      {/* Second attention row — state worth seeing, but not time-critical. */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard
          label="Suspended"
          value={metrics.suspended_users ?? 0}
          href="/users?filter=suspended"
          tone={metrics.suspended_users ? "amber" : undefined}
        />
        <StatCard label="Escrow held" value={fmtCents(metrics.escrow_held_cents)} sub="authorized, uncaptured" href="/bookings" />
        <StatCard label="Refunded" value={fmtCents(metrics.refunded_cents)} sub="all-time" href="/payments" />
        {/* Production only — dev-build crashes are excluded, so this is a real signal. */}
        <StatCard
          label="Fatal errors (7d)"
          value={metrics.errors_fatal_7d ?? 0}
          sub="production builds"
          href="/errors?fatal=1"
          tone={metrics.errors_fatal_7d ? "red" : undefined}
        />
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
        <StatCard label="GMV captured" value={fmtCents(metrics.gmv_captured_cents)} sub="all-time, net of refunds" />
        <StatCard label="Platform fees" value={fmtCents(metrics.fees_captured_cents)} sub="all-time, net of refunds" />
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
