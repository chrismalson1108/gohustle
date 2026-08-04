import Link from "next/link";
import { requireAdminPage } from "@/lib/guard";
import { auditRead } from "@/lib/audit";
import { fmtCents, fmtDate } from "@/lib/format";
import { Section, Pill } from "@/lib/ui";
import DisputeControls from "./DisputeControls";

export const metadata = { title: "Disputes" };

// public.disputes had six columns and no lifecycle, so a row was terminal. That was
// not merely a missing feature: a dispute is inserted by stripe-capture-payment
// AFTER a partial capture has already executed (the earner has been paid 50–90% with
// no appeal channel), and earner-claim-payment refuses to settle a booking carrying
// any open dispute — so an unresolvable dispute withheld a worker's pay permanently,
// by construction. Closing one here is what reopens that path.
export default async function DisputesPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  const ctx = await requireAdminPage("support");
  const showClosed = (await searchParams).filter === "closed";
  await auditRead(ctx, "disputes.view", "disputes", undefined, { closed: showClosed });

  let q = ctx.service
    .from("disputes")
    .select("id, booking_id, raised_by, reason, pct_paid, status, resolution_note, resolved_at, created_at", {
      count: "exact",
    })
    .order("created_at", { ascending: false })
    .limit(100);
  q = showClosed ? q.not("resolved_at", "is", null) : q.is("resolved_at", null);
  const { data: disputes, error, count } = await q;

  const bookingIds = [...new Set((disputes ?? []).map((d) => d.booking_id).filter(Boolean))] as string[];
  const userIds = [...new Set((disputes ?? []).map((d) => d.raised_by).filter(Boolean))] as string[];

  const [bookingsRes, profilesRes, paymentsRes] = await Promise.all([
    bookingIds.length
      ? ctx.service.from("bookings").select("id, job_id, earner_id, status").in("id", bookingIds)
      : Promise.resolve({ data: [] as { id: string; job_id: string; earner_id: string; status: string }[] }),
    userIds.length
      ? ctx.service.from("profiles").select("id, name, username").in("id", userIds)
      : Promise.resolve({ data: [] as { id: string; name: string; username: string | null }[] }),
    bookingIds.length
      ? ctx.service
          .from("payments")
          .select("booking_id, status, amount_cents, fee_cents, earner_amount_cents, refunded_cents")
          .in("booking_id", bookingIds)
      : Promise.resolve({ data: [] as Record<string, number | string>[] }),
  ]);

  const bookingById = new Map((bookingsRes.data ?? []).map((b) => [b.id, b]));
  const nameOf = new Map((profilesRes.data ?? []).map((p) => [p.id, p.username ? `@${p.username}` : p.name]));
  const payBy = new Map((paymentsRes.data ?? []).map((p) => [p.booking_id as string, p]));

  const jobIds = [...new Set((bookingsRes.data ?? []).map((b) => b.job_id).filter(Boolean))] as string[];
  const jobs = jobIds.length
    ? (await ctx.service.from("jobs").select("id, title").in("id", jobIds)).data ?? []
    : [];
  const titleOf = new Map(jobs.map((j) => [j.id, j.title]));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Disputes</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">
            An open dispute blocks the earner from claiming payment on that booking. Closing it
            unblocks them.
          </p>
        </div>
        <div className="flex gap-2 text-sm">
          <Link
            href="/disputes"
            className={`rounded-lg px-3 py-1.5 ${!showClosed ? "bg-[var(--brand)] text-white" : "border border-[var(--line)]"}`}
          >
            Open
          </Link>
          <Link
            href="/disputes?filter=closed"
            className={`rounded-lg px-3 py-1.5 ${showClosed ? "bg-[var(--brand)] text-white" : "border border-[var(--line)]"}`}
          >
            Closed
          </Link>
        </div>
      </div>

      {error && <p className="text-sm text-[var(--danger)]">Failed to load: {error.message}</p>}

      <Section title={`${showClosed ? "Closed" : "Open"} disputes (${count ?? 0})`}>
        {(disputes ?? []).length === 0 ? (
          <p className="text-sm text-[var(--muted)]">
            {showClosed ? "Nothing closed yet." : "No open disputes. 🎉"}
          </p>
        ) : (
          <ul className="space-y-3">
            {(disputes ?? []).map((d) => {
              const b = bookingById.get(d.booking_id);
              const pay = payBy.get(d.booking_id) as
                | { status: string; fee_cents: number; earner_amount_cents: number; refunded_cents: number }
                | undefined;
              const captured = pay ? (pay.earner_amount_cents ?? 0) + (pay.fee_cents ?? 0) : null;
              return (
                <li key={d.id} className="rounded-lg border border-[var(--line)] p-4">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">
                          {b ? titleOf.get(b.job_id) ?? "Untitled gig" : "Unknown gig"}
                        </span>
                        <Pill tone={d.resolved_at ? "green" : d.status === "investigating" ? "amber" : "red"}>
                          {d.status ?? "open"}
                        </Pill>
                        {d.pct_paid != null && <Pill tone="amber">{Number(d.pct_paid)}% paid</Pill>}
                      </div>

                      {d.reason && <p className="mt-1 text-sm">{d.reason}</p>}

                      <p className="mt-1 text-xs text-[var(--muted)]">
                        raised by{" "}
                        <Link href={`/users/${d.raised_by}`} className="text-[var(--brand)] hover:underline">
                          {nameOf.get(d.raised_by) ?? d.raised_by.slice(0, 8)}
                        </Link>
                        {" · "}
                        <Link href={`/bookings/${d.booking_id}`} className="text-[var(--brand)] hover:underline">
                          open booking
                        </Link>
                        {captured != null && ` · collected ${fmtCents(captured)}`}
                        {pay?.refunded_cents ? ` · refunded ${fmtCents(pay.refunded_cents)}` : ""}
                        {" · "}
                        {fmtDate(d.created_at)}
                      </p>

                      {d.resolution_note && (
                        <p className="mt-2 rounded bg-[var(--surface)] px-2 py-1 text-xs text-[var(--muted)]">
                          {d.resolution_note}
                        </p>
                      )}
                    </div>

                    <DisputeControls
                      disputeId={String(d.id)}
                      status={d.status ?? "open"}
                      isAdmin={ctx.role === "admin"}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Section>
    </div>
  );
}
