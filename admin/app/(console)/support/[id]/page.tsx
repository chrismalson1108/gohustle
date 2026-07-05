import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdminPage } from "@/lib/guard";
import { fmtDate } from "@/lib/format";
import { Pill, statusTone } from "@/lib/ui";
import { auditRead } from "@/lib/audit";
import Composer from "./Composer";

export const metadata = { title: "Ticket" };

export default async function TicketPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAdminPage("support");
  const { id } = await params;

  const { data: ticket } = await ctx.service.from("support_tickets").select("*").eq("id", id).maybeSingle();
  if (!ticket) notFound();
  await auditRead(ctx, "support.view", "ticket", id);

  const [messagesRes, linkedUser] = await Promise.all([
    ctx.service
      .from("support_ticket_messages")
      .select("id, author, admin_id, body, created_at")
      .eq("ticket_id", id)
      .order("created_at", { ascending: true }),
    ticket.user_id
      ? ctx.service.from("profiles").select("id, name, username").eq("id", ticket.user_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div>
        <Link href="/support" className="text-sm text-[var(--brand)] hover:underline">← All tickets</Link>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">#{ticket.id} · {ticket.subject}</h1>
        <Pill tone={statusTone(ticket.status)}>{ticket.status}</Pill>
      </div>
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
      </p>

      <div className="space-y-3">
        {(messagesRes.data ?? []).map((m) => (
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
            <p className="whitespace-pre-wrap">{m.body}</p>
          </div>
        ))}
      </div>

      <Composer ticketId={String(ticket.id)} currentStatus={ticket.status} />
    </div>
  );
}
