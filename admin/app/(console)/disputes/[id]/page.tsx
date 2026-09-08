import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdminPage, roleSatisfies } from "@/lib/guard";
import { auditRead } from "@/lib/audit";
import { fmtCents, fmtDate } from "@/lib/format";
import { Section, Pill } from "@/lib/ui";
import { signCompletionPhoto } from "@/lib/media";
import OpenThreadForm from "../../support/OpenThreadForm";
import DecisionPanel from "./DecisionPanel";

export const metadata = { title: "Dispute" };

// ─────────────────────────────────────────────────────────────────────────────
// The case file. One page holding BOTH sides of a reported problem.
//
// The queue this replaces showed the accusation and nothing else: the poster's reason,
// a percentage, and two buttons that changed a label. The person being accused had no
// entry in it at all — which was accurate, because until 20260909010000 they had no way
// to say anything. A tester put it exactly right: "the worker needs to be able to defend
// their work… it should be a two party reporting once initiated so that both people are
// fairly represented."
//
// So this page is built around one question — what actually happened — and it puts the
// three sources of evidence next to each other: what the poster said and photographed,
// what the earner answered and photographed, and the completion photos the earner
// uploaded when they finished the work, BEFORE any of this started. That last one is the
// whole of the tester's door-A/door-B scenario: the answer is usually already on file.
//
// The money is stated in dollars, not percentages, because a percentage of an unstated
// number is not something a person can weigh.
// ─────────────────────────────────────────────────────────────────────────────

// Module scope, not inline: react-hooks/purity flags a bare Date.now() inside a
// component as an impure render call (see bookings/[id] for the same note).
function isPast(iso: string | null | undefined): boolean {
  return Boolean(iso) && Date.parse(iso as string) < Date.now();
}
function plus(iso: string | null | undefined, days: number): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t + days * 86_400_000).toISOString() : null;
}

function Photos({ label, urls }: { label: string; urls: string[] }) {
  if (urls.length === 0) return null;
  return (
    <div className="mt-3">
      <p className="mb-1.5 text-xs font-medium text-[var(--muted)]">{label}</p>
      <div className="flex flex-wrap gap-2">
        {urls.map((u) => (
          // Full-size in a new tab: the detail that decides a case is rarely visible
          // in a thumbnail. rel=noreferrer because the URL is a signed storage link.
          <a key={u} href={u} target="_blank" rel="noreferrer">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={u} alt="" className="size-28 rounded-lg border border-[var(--line)] object-cover" />
          </a>
        ))}
      </div>
    </div>
  );
}

export default async function DisputeCasePage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAdminPage("trust");
  const { id } = await params;

  const { data: d } = await ctx.service.from("disputes").select("*").eq("id", id).maybeSingle();
  if (!d) notFound();

  const { data: booking } = await ctx.service
    .from("bookings")
    .select("id, job_id, earner_id, status, amount_cents_quoted, fee_bps_quoted, completion_photos, before_photos, started_at, created_at")
    .eq("id", d.booking_id)
    .maybeSingle();

  const [jobRes, payRes] = await Promise.all([
    booking
      ? ctx.service.from("jobs").select("id, title, poster_id").eq("id", booking.job_id).maybeSingle()
      : Promise.resolve({ data: null }),
    ctx.service
      .from("payments")
      .select("id, status, amount_cents, fee_cents, earner_amount_cents, refunded_cents, fee_bps, created_at, authorized_at, payment_intent_id")
      .eq("booking_id", d.booking_id)
      .maybeSingle(),
  ]);
  const job = jobRes.data as { id: string; title: string; poster_id: string } | null;
  const pay = payRes.data;

  const ids = [...new Set([d.raised_by, d.respondent_id, booking?.earner_id, job?.poster_id].filter(Boolean))] as string[];
  const { data: profiles } = ids.length
    ? await ctx.service.from("profiles").select("id, name, username").in("id", ids)
    : { data: [] as { id: string; name: string; username: string | null }[] };
  const nameOf = (uid: string | null | undefined) => {
    if (!uid) return "—";
    const p = (profiles ?? []).find((x) => x.id === uid);
    return p ? (p.username ? `@${p.username}` : p.name) : uid.slice(0, 8);
  };

  // completion-photos is a PRIVATE bucket; the service role mints 10-minute signed
  // URLs. Failed signs are dropped so no broken thumbnail renders.
  const sign = async (vals: unknown) =>
    (await Promise.all(((vals as string[]) ?? []).map((v) => signCompletionPhoto(ctx.service, v)))).filter(Boolean) as string[];
  const [reportPhotos, replyPhotos, donePhotos, beforePhotos] = await Promise.all([
    sign(d.photos),
    sign(d.response_photos),
    sign(booking?.completion_photos),
    sign(booking?.before_photos),
  ]);

  // Reading a dispute exposes both parties' identity, their evidence photos and the
  // escrow amount. It leaves a trace naming who read it.
  await auditRead(ctx, "dispute.view", "dispute", id, { booking_id: d.booking_id });

  // Match the ACTION, not the top tier: decideDispute and setDisputeStatus both accept
  // trust, and this page is requireAdminPage("trust").
  const canResolve = roleSatisfies(ctx.role, "trust");

  const proposed = d.proposed_pct ?? 100;
  const settled = d.pct_paid != null;
  const held = pay?.status === "authorized";
  const holdCents = pay?.amount_cents ?? booking?.amount_cents_quoted ?? null;
  // The one arithmetic on this page, and it is the arithmetic settleEscrow does:
  // captureCents = round(amount_cents * pct). The fee that comes out of it is
  // platform_fee_cents' business and is NOT recomputed here — a second copy of the fee
  // is the exact drift shared/pricing.js exists to prevent.
  const atPct = (p: number) => (holdCents == null ? null : Math.round((holdCents * p) / 100));

  const replyDue = d.settle_after as string | null;
  // ── coalesce(authorized_at, created_at), like EVERY other hold-age read ────────────
  //
  // `created_at` is the FIRST hold ever placed on this booking; stripe-create-payment-intent
  // upserts on booking_id and deliberately leaves it alone on a recovery re-hold, writing
  // authorized_at instead (20260806150000). So on any re-held booking this page — the ONLY
  // screen that shows an operator the branch-4 deadline — judged a fresh hold by a dead
  // clock and showed a date that had already passed, on the page where the date IS the
  // decision. Both server-side reads were corrected when the two-party model shipped; this
  // one was missed, and disputeTwoParty.test.js now pins it with them.
  const heldSince = pay?.authorized_at ?? pay?.created_at;
  const capDeadline = plus(heldSince, 5); // dispute_settlement_pct branch 4
  const holdExpiry = plus(heldSince, 7); // Stripe cancels an uncaptured PI here

  const stance = d.responded_at ? (d.response_stance as string) : null;
  const subject = job?.title ? `The problem reported on "${job.title}"` : "A reported problem on your gig";

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <Link href="/disputes" className="text-sm text-[var(--brand)] hover:underline">← Disputes</Link>
        <h1 className="text-2xl font-semibold">{job?.title ?? "Dispute"}</h1>
        <Pill tone={settled ? "green" : stance === "contest" ? "red" : "amber"}>
          {settled ? `settled at ${Number(d.pct_paid)}%` : stance === "contest" ? "contested" : stance === "accept" ? "accepted" : "awaiting reply"}
        </Pill>
        {d.resolution_pct != null && !settled && <Pill tone="amber">you decided {d.resolution_pct}%</Pill>}
      </div>

      {/* ── The clock. Put first, because it is the thing that expires. ────────── */}
      <Section title="Where this stands">
        <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="text-[var(--muted)]">Escrow</dt>
            <dd className="font-medium">
              {holdCents != null ? fmtCents(holdCents) : "—"}{" "}
              <span className="font-normal text-[var(--muted)]">
                {settled ? "captured" : held ? "held, not captured" : (pay?.status ?? "no payment row")}
              </span>
            </dd>
          </div>
          <div>
            <dt className="text-[var(--muted)]">Poster asked to pay</dt>
            <dd className="font-medium">
              {proposed}% {atPct(proposed) != null && <span className="font-normal text-[var(--muted)]">({fmtCents(atPct(proposed))})</span>}
            </dd>
          </div>
          <div>
            <dt className="text-[var(--muted)]">Earner replied</dt>
            <dd className="font-medium">
              {d.responded_at ? `${stance === "accept" ? "accepted" : "contested"} · ${fmtDate(d.responded_at)}` : "not yet"}
            </dd>
          </div>
          <div>
            <dt className="text-[var(--muted)]">{d.responded_at ? "Reported" : "Reply window closes"}</dt>
            <dd className={`font-medium ${!d.responded_at && isPast(replyDue) ? "text-[var(--danger)]" : ""}`}>
              {d.responded_at ? fmtDate(d.created_at) : fmtDate(replyDue)}
            </dd>
          </div>
        </dl>

        {!settled && (
          <div className="mt-4 space-y-2 rounded-lg bg-[var(--surface)] p-3 text-sm">
            {/* What happens without you. Stated from the row's own columns — the rule
                itself lives in public.dispute_settlement_pct and is not re-decided here. */}
            {d.resolution_pct != null ? (
              <p>
                Your decision of <strong>{d.resolution_pct}%</strong> is recorded. The hourly sweep captures
                it at :05 past the hour and tells both parties.
              </p>
            ) : stance === "accept" ? (
              <p>The earner accepted. This settles at <strong>{proposed}%</strong> on the next hourly sweep.</p>
            ) : stance === "contest" ? (
              <p>
                <strong>Contested — this is waiting on you.</strong> Nothing is captured while a decision is
                outstanding. If none is made, the authorization is captured{" "}
                <strong>in full</strong> around {fmtDate(capDeadline)}, because a partial capture cannot be
                topped up afterwards and a lapsed hold (about {fmtDate(holdExpiry)}) pays the earner nothing
                at all. A full capture is the only outcome this platform can still refund.
              </p>
            ) : (
              <p>
                No reply yet. If the earner says nothing by {fmtDate(replyDue)}, this settles at the proposed{" "}
                <strong>{proposed}%</strong> — silence stands.
              </p>
            )}
            {held && holdExpiry && (
              <p className={isPast(plus(heldSince, 6)) ? "text-[var(--danger)]" : "text-[var(--muted)]"}>
                Stripe cancels an uncaptured authorization around {fmtDate(holdExpiry)}. After that nobody can
                be paid for this gig.
              </p>
            )}
          </div>
        )}

        <p className="mt-3 text-xs text-[var(--muted)]">
          {booking && (
            <>
              <Link href={`/bookings/${booking.id}`} className="text-[var(--brand)] hover:underline">booking</Link>
              {" · "}
            </>
          )}
          {job && (
            <>
              <Link href={`/jobs/${job.id}`} className="text-[var(--brand)] hover:underline">gig</Link>
              {" · "}
            </>
          )}
          poster{" "}
          <Link href={`/users/${job?.poster_id ?? ""}`} className="text-[var(--brand)] hover:underline">{nameOf(job?.poster_id)}</Link>
          {" · earner "}
          <Link href={`/users/${booking?.earner_id ?? ""}`} className="text-[var(--brand)] hover:underline">{nameOf(booking?.earner_id)}</Link>
          {pay?.payment_intent_id ? ` · ${pay.payment_intent_id}` : ""}
        </p>
      </Section>

      {/* ── Both sides, side by side. ───────────────────────────────────────────── */}
      <div className="grid gap-5 lg:grid-cols-2">
        <Section title={`Reported by ${nameOf(d.raised_by)}`}>
          <p className="text-sm">{d.reason || <span className="text-[var(--muted)]">No reason given.</span>}</p>
          <Photos label="The poster's photos" urls={reportPhotos} />
          <p className="mt-3 text-xs text-[var(--muted)]">{fmtDate(d.created_at)}</p>
        </Section>

        <Section title={`Answer from ${nameOf(d.respondent_id)}`}>
          {d.responded_at ? (
            <>
              <p className="text-sm font-medium">
                {stance === "accept" ? `Accepted the ${proposed}%.` : "Disputes this."}
              </p>
              {d.response_note && <p className="mt-1 text-sm">{d.response_note}</p>}
              <Photos label="The earner's photos" urls={replyPhotos} />
              <p className="mt-3 text-xs text-[var(--muted)]">{fmtDate(d.responded_at)}</p>
            </>
          ) : (
            <p className="text-sm text-[var(--muted)]">
              Nothing yet. They were notified in-app when this was filed and have until {fmtDate(replyDue)}.
            </p>
          )}
        </Section>
      </div>

      {/* ── The work itself. Usually the answer. ────────────────────────────────── */}
      {(donePhotos.length > 0 || beforePhotos.length > 0) && (
        <Section title="What was uploaded when the work was finished">
          <p className="text-sm text-[var(--muted)]">
            Taken by the earner at completion, before any of this was reported — so they settle
            &ldquo;that is a different door&rdquo; arguments on their own.
          </p>
          <Photos label="Before" urls={beforePhotos} />
          <Photos label="Finished" urls={donePhotos} />
        </Section>
      )}

      {/* ── Decide. ─────────────────────────────────────────────────────────────── */}
      <Section title="Decide">
        <DecisionPanel
          disputeId={String(d.id)}
          status={(d.status as string) ?? "open"}
          proposedPct={proposed}
          decidedPct={d.resolution_pct as number | null}
          settledPct={d.pct_paid == null ? null : Number(d.pct_paid)}
          holdCents={holdCents}
          canResolve={canResolve}
        />
        {d.resolution_note && (
          <p className="mt-3 rounded bg-[var(--surface)] px-2 py-1 text-xs text-[var(--muted)]">
            Last note: {d.resolution_note}
          </p>
        )}
      </Section>

      {/* ── Talk to them. Two forms, because there are two people. ──────────────── */}
      <Section title="Message the parties">
        <p className="mb-4 text-sm text-[var(--muted)]">
          Each of these opens a support conversation with that person, attached to this gig, that they
          can answer from the app. Two separate threads on purpose — a dispute is not a group chat, and
          neither party should read what the other told us in confidence.
        </p>
        <div className="grid gap-6 lg:grid-cols-2">
          {job?.poster_id && (
            <div>
              <h3 className="mb-2 text-sm font-semibold">Poster · {nameOf(job.poster_id)}</h3>
              <OpenThreadForm
                userId={job.poster_id}
                bookingId={d.booking_id}
                defaultCategory="payment"
                defaultSubject={subject}
              />
            </div>
          )}
          {booking?.earner_id && (
            <div>
              <h3 className="mb-2 text-sm font-semibold">Earner · {nameOf(booking.earner_id)}</h3>
              <OpenThreadForm
                userId={booking.earner_id}
                bookingId={d.booking_id}
                defaultCategory="payment"
                defaultSubject={subject}
              />
            </div>
          )}
        </div>
      </Section>
    </div>
  );
}
