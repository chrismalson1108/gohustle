import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdminPage } from "@/lib/guard";
import { fmtDate } from "@/lib/format";
import { Pill, statusTone } from "@/lib/ui";
import { auditRead } from "@/lib/audit";
import Composer from "./Composer";

export const metadata = { title: "Ticket" };

const PRIORITY_TONE = {
  urgent: "red",
  high: "amber",
  normal: "gray",
  low: "gray",
} as const;

export default async function TicketPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAdminPage("support");
  const { id } = await params;

  const { data: ticket } = await ctx.service.from("support_tickets").select("*").eq("id", id).maybeSingle();
  if (!ticket) notFound();
  await auditRead(ctx, "support.view", "ticket", id);

  const [messagesRes, linkedUser, linkedBooking, assignee] = await Promise.all([
    ctx.service
      .from("support_ticket_messages")
      // `images` was added with the two-way migration and never selected here, so
      // every photo a user attached went into a bucket nobody opened. Attaching
      // evidence you are never shown is worse than not offering it.
      .select("id, author, admin_id, body, images, created_at")
      .eq("ticket_id", id)
      .order("created_at", { ascending: true }),
    ticket.user_id
      ? ctx.service.from("profiles").select("id, name, username").eq("id", ticket.user_id).maybeSingle()
      : Promise.resolve({ data: null }),
    // The gig the user attached when they opened the ticket. Collecting that context in
    // the app is pointless unless it lands in front of the agent, and the whole reason
    // to ask for it is to save a round trip of "which gig do you mean?".
    ticket.booking_id
      ? ctx.service
          .from("bookings")
          .select("id, status, amount_cents_quoted, job:jobs!bookings_job_id_fkey(id, title)")
          .eq("id", ticket.booking_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    ticket.assigned_to
      ? ctx.service.from("profiles").select("id, name").eq("id", ticket.assigned_to).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const messages = messagesRes.data ?? [];

  // support-photos is a PRIVATE bucket, so getPublicUrl would hand back a URL that
  // 400s. Sign every attachment in the thread in one round trip.
  const paths = messages.flatMap((m) => (m.images as string[] | null) ?? []);
  const signed = new Map<string, string>();
  if (paths.length) {
    const { data: urls } = await ctx.service.storage.from("support-photos").createSignedUrls(paths, 3600);
    (urls ?? []).forEach((u) => {
      if (u.signedUrl && u.path) signed.set(u.path, u.signedUrl);
    });
  }

  // Opening the thread is what "we have seen this" means. Without it the queue
  // cannot distinguish a ticket waiting on us from one waiting on the user, which is
  // the single most useful column a support queue has.
  if (ticket.last_message_at && (!ticket.agent_read_at || ticket.agent_read_at < ticket.last_message_at)) {
    await ctx.service
      .from("support_tickets")
      .update({ agent_read_at: new Date().toISOString() })
      .eq("id", id);
  }

  const waitingOnUs = messages.length > 0 && messages[messages.length - 1].author === "user";

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div>
        <Link href="/support" className="text-sm text-[var(--brand)] hover:underline">← All tickets</Link>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">#{ticket.id} · {ticket.subject}</h1>
        <Pill tone={statusTone(ticket.status)}>{ticket.status}</Pill>
        {ticket.priority && ticket.priority !== "normal" ? (
          <Pill tone={PRIORITY_TONE[ticket.priority as keyof typeof PRIORITY_TONE] ?? "gray"}>{ticket.priority}</Pill>
        ) : null}
        {waitingOnUs ? <Pill tone="amber">needs reply</Pill> : null}
        {ticket.archived_at ? <Pill tone="gray">archived by user</Pill> : null}
      </div>

      {linkedBooking?.data ? (
        <div className="rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm">
          <span className="text-[var(--muted)]">About this gig: </span>
          <Link
            href={`/bookings/${linkedBooking.data.id}`}
            className="font-medium text-[var(--brand)] hover:underline"
          >
            {(linkedBooking.data as { job?: { title?: string } }).job?.title ?? "booking"}
          </Link>
          <span className="text-[var(--muted)]">
            {" · "}{linkedBooking.data.status}
            {typeof linkedBooking.data.amount_cents_quoted === "number"
              ? ` · $${(linkedBooking.data.amount_cents_quoted / 100).toFixed(2)}`
              : ""}
          </span>
        </div>
      ) : null}

      <p className="text-sm text-[var(--muted)]">
        {ticket.name ? `${ticket.name} · ` : ""}
        {ticket.email}
        {ticket.category ? ` · ${ticket.category}` : ""}
        {linkedUser.data ? (
          <>
            {" · "}
            <Link href={`/users/${linkedUser.data.id}`} className="text-[var(--brand)] hover:underline">
              view account
            </Link>
          </>
        ) : null}
        {assignee?.data ? ` · assigned to ${assignee.data.name ?? "an agent"}` : " · unassigned"}
      </p>

      <div className="space-y-3">
        {messages.map((m) => {
          const imgs = ((m.images as string[] | null) ?? []).map((p) => signed.get(p)).filter(Boolean) as string[];
          return (
            <div
              key={m.id}
              className={`rounded-xl border p-4 text-sm ${
                m.author === "admin"
                  ? "ml-8 border-indigo-200 bg-indigo-50"
                  : "mr-8 border-[var(--line)] bg-white"
              }`}
            >
              <div className="mb-1 flex items-center justify-between text-xs text-[var(--muted)]">
                <span className="font-medium">{m.author === "admin" ? "Support" : ticket.name || ticket.email}</span>
                <span>{fmtDate(m.created_at)}</span>
              </div>
              {m.body ? <p className="whitespace-pre-wrap">{m.body}</p> : null}
              {imgs.length ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  {imgs.map((u) => (
                    // Opens full-size in a tab — a dispute photo is usually being read
                    // for a detail (a scratch, a meter, a receipt line) that a thumbnail
                    // cannot show.
                    <a key={u} href={u} target="_blank" rel="noreferrer noopener">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={u}
                        alt="attachment"
                        className="h-28 w-28 rounded-lg border border-[var(--line)] object-cover hover:opacity-90"
                      />
                    </a>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
        {messages.length === 0 && (
          <p className="rounded-xl border border-[var(--line)] bg-white p-4 text-sm text-[var(--muted)]">
            No messages on this ticket yet.
          </p>
        )}
      </div>

      <Composer
        ticketId={String(ticket.id)}
        currentStatus={ticket.status}
        priority={ticket.priority ?? "normal"}
        assignedToMe={ticket.assigned_to === ctx.user.id}
        assigned={Boolean(ticket.assigned_to)}
        hasAppUser={Boolean(ticket.user_id)}
      />
    </div>
  );
}
