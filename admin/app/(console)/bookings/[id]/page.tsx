import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdminPage } from "@/lib/guard";
import { fmtCents, fmtDate, fmtDollars } from "@/lib/format";
import { Section, Pill, statusTone } from "@/lib/ui";
import { STRIPE_DASHBOARD_BASE as STRIPE_BASE } from "@/lib/config";
import { auditRead } from "@/lib/audit";
import { signChatImage, signCompletionPhoto } from "@/lib/media";
import InterventionPanel from "./InterventionPanel";

export const metadata = { title: "Booking detail" };

const MESSAGE_LIMIT = 200;

export default async function BookingDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAdminPage("support");
  const { id } = await params;

  const { data: booking } = await ctx.service.from("bookings").select("*").eq("id", id).maybeSingle();
  if (!booking) notFound();

  const [jobRes, earnerRes, paymentRes, disputeRes, messagesRes] = await Promise.all([
    ctx.service.from("jobs").select("id, title, poster_id, status").eq("id", booking.job_id).maybeSingle(),
    ctx.service.from("profiles").select("id, name, username").eq("id", booking.earner_id).maybeSingle(),
    ctx.service.from("payments").select("*").eq("booking_id", id).maybeSingle(),
    ctx.service.from("disputes").select("id, reason, pct_paid, raised_by, created_at").eq("booking_id", id),
    // NEWEST 200, reversed below for chronological display. Ordering ascending
    // with a limit returned the OLDEST 200 — so on a thread longer than that, the
    // page silently hid the recent messages, which are the ones a moderation
    // report is actually about, and gave no sign it had truncated anything.
    ctx.service
      .from("messages")
      .select("id, sender_id, text, image_url, created_at")
      .eq("booking_id", id)
      .order("created_at", { ascending: false })
      // +1 so a thread of EXACTLY MESSAGE_LIMIT isn't reported as truncated —
      // telling an admin the record is incomplete when they are looking at all of it
      // invites an escalation for an export that doesn't exist.
      .limit(MESSAGE_LIMIT + 1),
  ]);

  const posterId = jobRes.data?.poster_id;
  const poster = posterId
    ? (await ctx.service.from("profiles").select("id, name, username").eq("id", posterId).maybeSingle()).data
    : null;

  const name = (p: { name: string; username: string | null } | null | undefined, fallback: string) =>
    p ? (p.username ? `@${p.username}` : p.name) : fallback;
  const pay = paymentRes.data;

  // Sign any chat images (private bucket) so an admin can review flagged DM content.
  const fetched = messagesRes.data ?? [];
  const truncated = fetched.length > MESSAGE_LIMIT;
  const messageRows = fetched.slice(0, MESSAGE_LIMIT).reverse(); // back to chronological
  const messages = await Promise.all(
    messageRows.map(async (m) => ({
      ...m,
      signedImage: m.image_url ? await signChatImage(ctx.service, m.image_url, m.sender_id) : null,
    })),
  );
  // completion-photos is a PRIVATE bucket — mint short-lived signed URLs (service
  // role) so an admin can review proof-of-work evidence for a dispute. Failed signs
  // are dropped so no broken thumbnail renders.
  const completionPhotos = (
    await Promise.all(((booking.completion_photos as string[]) ?? []).map((v) => signCompletionPhoto(ctx.service, v)))
  ).filter(Boolean) as string[];
  const beforePhotos = (
    await Promise.all(((booking.before_photos as string[]) ?? []).map((v) => signCompletionPhoto(ctx.service, v)))
  ).filter(Boolean) as string[];

  // Viewing a booking exposes both parties' identity, escrow amounts, and chat —
  // record the access (T&S / compliance).
  await auditRead(ctx, "booking.view", "booking", id);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">Booking</h1>
        <Pill tone={statusTone(booking.status)}>{booking.status}</Pill>
        <span className="font-mono text-xs text-[var(--muted)]">{booking.id}</span>
      </div>

      <Section title="Overview">
        <dl className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm md:grid-cols-4">
          <div className="col-span-2">
            <dt className="text-[var(--muted)]">Gig</dt>
            <dd>
              {jobRes.data ? (
                <Link href={`/jobs/${jobRes.data.id}`} className="text-[var(--brand)] hover:underline">{jobRes.data.title}</Link>
              ) : "—"}
            </dd>
          </div>
          <div>
            <dt className="text-[var(--muted)]">Earner</dt>
            <dd><Link href={`/users/${booking.earner_id}`} className="text-[var(--brand)] hover:underline">{name(earnerRes.data, booking.earner_id.slice(0, 8))}</Link></dd>
          </div>
          <div>
            <dt className="text-[var(--muted)]">Poster</dt>
            <dd>{posterId ? <Link href={`/users/${posterId}`} className="text-[var(--brand)] hover:underline">{name(poster, posterId.slice(0, 8))}</Link> : "—"}</dd>
          </div>
          <div><dt className="text-[var(--muted)]">Slot</dt><dd>{booking.slot_label ?? "—"}</dd></div>
          <div><dt className="text-[var(--muted)]">Booked</dt><dd>{fmtDate(booking.created_at)}</dd></div>
          <div><dt className="text-[var(--muted)]">Earner done</dt><dd>{booking.earner_done ? "yes" : "no"}</dd></div>
          <div><dt className="text-[var(--muted)]">Poster done</dt><dd>{booking.poster_done ? "yes" : "no"}</dd></div>
          <div><dt className="text-[var(--muted)]">Tip</dt><dd>{fmtDollars(booking.tip_amount)}</dd></div>
          <div><dt className="text-[var(--muted)]">Amendment</dt><dd>{booking.amendment_status ?? "none"}</dd></div>
          <div><dt className="text-[var(--muted)]">Messages</dt><dd>{messages.length}</dd></div>
          {booking.counter_offer && <div><dt className="text-[var(--muted)]">Counter-offer</dt><dd>${Number(booking.counter_offer)}</dd></div>}
        </dl>
      </Section>

      <Section
        title="Payment (escrow)"
        right={pay ? (
          <a href={`${STRIPE_BASE}/payments/${pay.payment_intent_id}`} target="_blank" rel="noreferrer noopener" className="text-xs text-[var(--brand)] hover:underline">
            Open in Stripe ↗
          </a>
        ) : undefined}
      >
        {!pay ? (
          <p className="text-sm text-[var(--muted)]">No payment record for this booking.</p>
        ) : (
          <dl className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm md:grid-cols-4">
            <div><dt className="text-[var(--muted)]">Status</dt><dd><Pill tone={statusTone(pay.status)}>{pay.status}</Pill></dd></div>
            {/* "Charged" was wrong here for the same reason it was wrong on
                /payments (fixed there, see payments/page.tsx). amount_cents is the
                ORIGINAL AUTHORIZATION and is deliberately never rewritten —
                stripe-capture-payment keeps it as the audit record and documents
                the captured total as earner_amount_cents + fee_cents. After a
                partial capture (pct as low as 0.5) the poster pays as little as
                half of it, so labelling it "Charged" overstated collection by up
                to 2x — on the one page an admin opens BECAUSE there is a dispute,
                where the three numbers visibly failed to add up. */}
            <div><dt className="text-[var(--muted)]">Authorized</dt><dd>{fmtCents(pay.amount_cents)}</dd></div>
            <div>
              <dt className="text-[var(--muted)]">Captured</dt>
              <dd>{pay.status === "captured" ? fmtCents((pay.earner_amount_cents ?? 0) + (pay.fee_cents ?? 0)) : "—"}</dd>
            </div>
            <div><dt className="text-[var(--muted)]">Fee</dt><dd>{fmtCents(pay.fee_cents)}</dd></div>
            <div><dt className="text-[var(--muted)]">To earner</dt><dd>{fmtCents(pay.earner_amount_cents)}</dd></div>
            {/* Renamed: a field labelled "Captured" holding a DATE sat directly
                beside money fields, reading as a fourth amount. */}
            <div><dt className="text-[var(--muted)]">Captured at</dt><dd>{fmtDate(pay.captured_at)}</dd></div>
            {pay.refunded_cents > 0 && (
              <div>
                <dt className="text-[var(--muted)]">Refunded</dt>
                <dd className="text-[var(--danger)]">{fmtCents(pay.refunded_cents)}</dd>
              </div>
            )}
            <div className="col-span-3"><dt className="text-[var(--muted)]">PaymentIntent</dt><dd className="font-mono text-xs">{pay.payment_intent_id}</dd></div>
          </dl>
        )}
      </Section>

      <Section title="Intervene">
        <p className="mb-3 text-xs text-[var(--muted)]">
          These override the normal flow. Every one is recorded in the audit log against your
          account, with the reason you give.
        </p>
        <InterventionPanel
          bookingId={booking.id}
          status={booking.status}
          startedAt={booking.started_at ?? null}
          paymentStatus={pay?.status ?? null}
          refundableCents={
            pay && pay.status === "captured"
              ? Math.max(0, (pay.earner_amount_cents ?? 0) + (pay.fee_cents ?? 0) - (pay.refunded_cents ?? 0))
              : 0
          }
          isAdmin={ctx.role === "admin"}
        />
      </Section>

      {beforePhotos.length > 0 && (
        <Section title={`Before photos (${beforePhotos.length})`}>
          <div className="flex flex-wrap gap-3">
            {beforePhotos.map((url, i) => (
              <a key={i} href={url} target="_blank" rel="noreferrer noopener">
                <img src={url} alt={`before ${i + 1}`} className="h-40 w-40 rounded-lg border border-[var(--line)] object-cover" />
              </a>
            ))}
          </div>
        </Section>
      )}

      {completionPhotos.length > 0 && (
        <Section title={`Completion photos (${completionPhotos.length})`}>
          <div className="flex flex-wrap gap-3">
            {completionPhotos.map((url, i) => (
              <a key={i} href={url} target="_blank" rel="noreferrer noopener">
                <img src={url} alt={`completion ${i + 1}`} className="h-40 w-40 rounded-lg border border-[var(--line)] object-cover" />
              </a>
            ))}
          </div>
        </Section>
      )}

      <Section title={`Conversation (${truncated ? `latest ${messages.length}` : messages.length})`}>
        {/* Say so when the thread is cut off. A silently capped list reads as the
            whole conversation, which is the wrong impression to give someone
            deciding whether to ban an account. */}
        {truncated && (
          <p className="mb-3 rounded-lg bg-[var(--surface)] px-3 py-2 text-xs text-[var(--muted)]">
            Showing the most recent {MESSAGE_LIMIT} messages — this thread is longer.
          </p>
        )}
        {messages.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">No messages.</p>
        ) : (
          <div className="space-y-2">
            {messages.map((m) => {
              const fromEarner = m.sender_id === booking.earner_id;
              return (
                <div
                  key={m.id}
                  className={`max-w-[80%] rounded-xl border p-3 text-sm ${
                    fromEarner ? "mr-auto border-[var(--line)] bg-white" : "ml-auto border-indigo-200 bg-indigo-50"
                  }`}
                >
                  <div className="mb-1 flex items-center justify-between gap-4 text-xs text-[var(--muted)]">
                    <span className="font-medium">{fromEarner ? name(earnerRes.data, "earner") : name(poster, "poster")}</span>
                    <span>{fmtDate(m.created_at)}</span>
                  </div>
                  {m.text && <p className="whitespace-pre-wrap">{m.text}</p>}
                  {m.signedImage && (
                    <a href={m.signedImage} target="_blank" rel="noreferrer noopener">
                      <img src={m.signedImage} alt="chat attachment" className="mt-2 max-h-64 rounded-lg border border-[var(--line)]" />
                    </a>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Section>

      {(disputeRes.data ?? []).length > 0 && (
        <Section title={`Disputes (${disputeRes.data!.length})`}>
          <ul className="text-sm">
            {disputeRes.data!.map((d) => (
              <li key={d.id} className="border-t border-[var(--line)] py-2 first:border-0">
                <span className="font-medium">{d.reason ?? "dispute"}</span>
                {d.pct_paid != null ? <span className="text-[var(--muted)]"> · pay {Number(d.pct_paid)}%</span> : null}
                <span className="text-[var(--muted)]"> · {fmtDate(d.created_at)}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}
