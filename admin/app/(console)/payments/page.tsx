import Link from "next/link";
import { requireAdminPage } from "@/lib/guard";
import { fmtCents, fmtDate } from "@/lib/format";
import { Section, Pill, statusTone } from "@/lib/ui";
import { STRIPE_DASHBOARD_BASE as STRIPE_BASE } from "@/lib/config";
import { auditRead } from "@/lib/audit";

export const metadata = { title: "Payments & disputes" };

export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const ctx = await requireAdminPage("support");
  const statusFilter = (await searchParams).status ?? "";
  await auditRead(ctx, "payments.view", "payments", undefined, statusFilter ? { status: statusFilter } : undefined);

  let payQ = ctx.service
    .from("payments")
    .select("id, booking_id, payment_intent_id, amount_cents, fee_cents, earner_amount_cents, status, captured_at, created_at")
    .order("created_at", { ascending: false })
    .limit(60);
  if (statusFilter) payQ = payQ.eq("status", statusFilter);

  const [disputesRes, paymentsRes] = await Promise.all([
    ctx.service
      .from("disputes")
      .select("id, booking_id, raised_by, reason, pct_paid, created_at")
      .order("created_at", { ascending: false })
      .limit(50),
    payQ,
  ]);

  // Enrich disputes + payments with booking → job → parties context.
  const bookingIds = [
    ...new Set([
      ...(disputesRes.data ?? []).map((d) => d.booking_id),
      ...(paymentsRes.data ?? []).map((p) => p.booking_id),
    ].filter(Boolean) as string[]),
  ];
  const bookings = bookingIds.length
    ? (await ctx.service.from("bookings").select("id, job_id, earner_id, status").in("id", bookingIds)).data ?? []
    : [];
  const bookingById = new Map(bookings.map((b) => [b.id, b]));
  const jobIds = [...new Set(bookings.map((b) => b.job_id).filter(Boolean) as string[])];
  const jobs = jobIds.length
    ? (await ctx.service.from("jobs").select("id, title, poster_id").in("id", jobIds)).data ?? []
    : [];
  const jobById = new Map(jobs.map((j) => [j.id, j]));

  const STATUSES = ["", "authorized", "captured", "cancelled", "failed"];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Payments &amp; disputes</h1>

      <Section title={`Disputes (${disputesRes.data?.length ?? 0})`}>
        {(disputesRes.data ?? []).length === 0 ? (
          <p className="text-sm text-[var(--muted)]">No disputes.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-[var(--muted)]">
                  <th className="py-1 pr-4">Gig</th>
                  <th className="py-1 pr-4">Raised by</th>
                  <th className="py-1 pr-4">Reason</th>
                  <th className="py-1 pr-4">Pay %</th>
                  <th className="py-1 pr-4">When</th>
                  <th className="py-1">Booking</th>
                </tr>
              </thead>
              <tbody>
                {(disputesRes.data ?? []).map((d) => {
                  const b = bookingById.get(d.booking_id);
                  const job = b ? jobById.get(b.job_id) : null;
                  return (
                    <tr key={d.id} className="border-t border-[var(--line)]">
                      <td className="py-2 pr-4">{job?.title ?? "—"}</td>
                      <td className="py-2 pr-4">
                        <Link href={`/users/${d.raised_by}`} className="text-[var(--brand)] hover:underline">
                          {d.raised_by.slice(0, 8)}
                        </Link>
                      </td>
                      <td className="py-2 pr-4">{d.reason ?? "—"}</td>
                      <td className="py-2 pr-4">{d.pct_paid != null ? `${Number(d.pct_paid)}%` : "—"}</td>
                      <td className="py-2 pr-4">{fmtDate(d.created_at)}</td>
                      <td className="py-2">
                        <Link href={`/bookings/${d.booking_id}`} className="font-mono text-xs text-[var(--brand)] hover:underline">
                          {d.booking_id.slice(0, 8)}…
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section
        title={`Payments (${paymentsRes.data?.length ?? 0})`}
        right={
          <div className="flex gap-1 text-xs">
            {STATUSES.map((s) => (
              <Link
                key={s || "all"}
                href={s ? `/payments?status=${s}` : "/payments"}
                className={`rounded px-2 py-1 ${statusFilter === s ? "bg-[var(--brand)] text-white" : "border border-[var(--line)]"}`}
              >
                {s || "all"}
              </Link>
            ))}
          </div>
        }
      >
        {paymentsRes.error && <p className="text-sm text-[var(--danger)]">{paymentsRes.error.message}</p>}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-[var(--muted)]">
                <th className="py-1 pr-4">Gig</th>
                <th className="py-1 pr-4">Status</th>
                <th className="py-1 pr-4">Charged</th>
                <th className="py-1 pr-4">Fee</th>
                <th className="py-1 pr-4">To earner</th>
                <th className="py-1 pr-4">When</th>
                <th className="py-1">Stripe</th>
              </tr>
            </thead>
            <tbody>
              {(paymentsRes.data ?? []).map((p) => {
                const b = bookingById.get(p.booking_id);
                const job = b ? jobById.get(b.job_id) : null;
                return (
                  <tr key={p.id} className="border-t border-[var(--line)]">
                    <td className="py-2 pr-4">
                      <Link href={`/bookings/${p.booking_id}`} className="text-[var(--brand)] hover:underline">
                        {job?.title ?? p.booking_id.slice(0, 8)}
                      </Link>
                    </td>
                    <td className="py-2 pr-4"><Pill tone={statusTone(p.status)}>{p.status}</Pill></td>
                    <td className="py-2 pr-4">{fmtCents(p.amount_cents)}</td>
                    <td className="py-2 pr-4">{fmtCents(p.fee_cents)}</td>
                    <td className="py-2 pr-4">{fmtCents(p.earner_amount_cents)}</td>
                    <td className="py-2 pr-4">{fmtDate(p.captured_at ?? p.created_at)}</td>
                    <td className="py-2">
                      <a
                        href={`${STRIPE_BASE}/payments/${p.payment_intent_id}`}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="text-[var(--brand)] hover:underline"
                      >
                        open ↗
                      </a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  );
}
