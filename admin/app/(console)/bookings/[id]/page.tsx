import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdminPage } from "@/lib/guard";
import { fmtCents, fmtDate } from "@/lib/format";
import { Section, Pill, statusTone } from "@/lib/ui";
import { STRIPE_DASHBOARD_BASE as STRIPE_BASE } from "@/lib/config";
import { auditRead } from "@/lib/audit";
import { signChatImage } from "@/lib/media";

export const metadata = { title: "Booking detail" };

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
    ctx.service
      .from("messages")
      .select("id, sender_id, text, image_url, created_at")
      .eq("booking_id", id)
      .order("created_at", { ascending: true })
      .limit(200),
  ]);

  const posterId = jobRes.data?.poster_id;
  const poster = posterId
    ? (await ctx.service.from("profiles").select("id, name, username").eq("id", posterId).maybeSingle()).data
    : null;

  const name = (p: { name: string; username: string | null } | null | undefined, fallback: string) =>
    p ? (p.username ? `@${p.username}` : p.name) : fallback;
  const pay = paymentRes.data;

  // Sign any chat images (private bucket) so an admin can review flagged DM content.
  const messages = await Promise.all(
    (messagesRes.data ?? []).map(async (m) => ({
      ...m,
      signedImage: m.image_url ? await signChatImage(ctx.service, m.image_url, m.sender_id) : null,
    })),
  );
  const completionPhotos: string[] = booking.completion_photos ?? [];

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
          <div><dt className="text-[var(--muted)]">Tip</dt><dd>{booking.tip_amount ? `$${booking.tip_amount}` : "—"}</dd></div>
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
            <div><dt className="text-[var(--muted)]">Charged</dt><dd>{fmtCents(pay.amount_cents)}</dd></div>
            <div><dt className="text-[var(--muted)]">Fee</dt><dd>{fmtCents(pay.fee_cents)}</dd></div>
            <div><dt className="text-[var(--muted)]">To earner</dt><dd>{fmtCents(pay.earner_amount_cents)}</dd></div>
            <div><dt className="text-[var(--muted)]">Captured</dt><dd>{fmtDate(pay.captured_at)}</dd></div>
            <div className="col-span-3"><dt className="text-[var(--muted)]">PaymentIntent</dt><dd className="font-mono text-xs">{pay.payment_intent_id}</dd></div>
          </dl>
        )}
      </Section>

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

      <Section title={`Conversation (${messages.length})`}>
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
