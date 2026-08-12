import Link from "next/link";
import { requireAdminPage } from "@/lib/guard";
import { fmtDate } from "@/lib/format";
import { Pill, statusTone } from "@/lib/ui";

export const metadata = { title: "Support" };

const PRIORITY_TONE = { urgent: "red", high: "amber", normal: "gray", low: "gray" } as const;
const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

// The tabs are what an agent picks up in the morning, so "needs reply" leads: it is
// the only one that answers "what have we not responded to". Sorting by recency alone
// buries the ticket that has been waiting longest underneath the one someone just
// wrote in, which is exactly backwards for a queue.
const TABS = ["needs reply", "open", "pending", "closed", "all"] as const;

export default async function SupportPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const ctx = await requireAdminPage("support");
  const status = (await searchParams).status ?? "needs reply";

  let q = ctx.service
    .from("support_tickets")
    .select(
      "id, email, name, subject, category, status, priority, assigned_to, archived_at, last_message_at, agent_read_at, last_author, booking_id",
    )
    .order("last_message_at", { ascending: false })
    .limit(200);
  if (status === "needs reply") q = q.in("status", ["open", "pending"]);
  else if (status !== "all") q = q.eq("status", status);
  const { data: raw, error } = await q;

  // "Waiting on us" = the last message is from the CUSTOMER.
  //
  // This was derived from agent_read_at < last_message_at, which was wrong in a way
  // that only ever hid work: rendering this ticket's page stamps agent_read_at, so
  // opening a ticket and closing it again dropped it out of the queue without anyone
  // having answered it. Reading is not replying.
  const waitingOnUs = (t: { last_author: string | null }) => t.last_author === "user";
  // Kept as a separate, weaker signal — worth surfacing, but it never decides the queue.
  const neverOpened = (t: { agent_read_at: string | null }) => !t.agent_read_at;

  let tickets = raw ?? [];
  if (status === "needs reply") tickets = tickets.filter(waitingOnUs);

  // Unanswered first; within that, urgent before routine; within that, the person
  // who has been waiting longest goes first. Done here rather than in PostgREST
  // because the ordering depends on a comparison between two columns.
  tickets = [...tickets].sort((a, b) => {
    const aw = waitingOnUs(a), bw = waitingOnUs(b);
    if (aw !== bw) return aw ? -1 : 1;
    const ap = PRIORITY_RANK[a.priority ?? "normal"] ?? 2;
    const bp = PRIORITY_RANK[b.priority ?? "normal"] ?? 2;
    if (ap !== bp) return ap - bp;
    const at = a.last_message_at ?? "", bt = b.last_message_at ?? "";
    return aw ? at.localeCompare(bt) : bt.localeCompare(at);
  });

  const needsReply = (raw ?? []).filter((t) => ["open", "pending"].includes(t.status) && waitingOnUs(t)).length;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">
          Support
          {needsReply > 0 ? (
            <span className="ml-2 rounded-full bg-red-100 px-2 py-0.5 text-sm font-semibold text-red-700">
              {needsReply} waiting
            </span>
          ) : null}
        </h1>
        <div className="flex flex-wrap gap-2 text-sm">
          {TABS.map((t) => (
            <Link
              key={t}
              href={`/support?status=${encodeURIComponent(t)}`}
              className={`rounded-lg px-3 py-1.5 capitalize ${status === t ? "bg-[var(--brand)] text-white" : "border border-[var(--line)]"}`}
            >
              {t}
            </Link>
          ))}
        </div>
      </div>

      {error && <p className="text-sm text-[var(--danger)]">{error.message}</p>}

      <div className="overflow-x-auto rounded-xl border border-[var(--line)] bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--line)] text-left text-xs uppercase tracking-wide text-[var(--muted)]">
              <th className="px-4 py-3">Subject</th>
              <th className="px-4 py-3">From</th>
              <th className="px-4 py-3">Category</th>
              <th className="px-4 py-3">Priority</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Updated</th>
            </tr>
          </thead>
          <tbody>
            {tickets.map((t) => (
              <tr key={t.id} className="border-b border-[var(--line)] last:border-0 hover:bg-[var(--surface)]">
                <td className="px-4 py-3">
                  <Link href={`/support/${t.id}`} className="font-medium text-[var(--brand)] hover:underline">
                    #{t.id} · {t.subject}
                  </Link>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs">
                    {waitingOnUs(t) ? <Pill tone="amber">needs reply</Pill> : null}
                    {neverOpened(t) ? <Pill tone="gray">unopened</Pill> : null}
                    {t.booking_id ? <span className="text-[var(--muted)]">· linked gig</span> : null}
                    {t.assigned_to ? <span className="text-[var(--muted)]">· claimed</span> : null}
                    {t.archived_at ? <span className="text-[var(--muted)]">· archived by user</span> : null}
                  </div>
                </td>
                <td className="px-4 py-3">{t.name ? `${t.name} · ` : ""}{t.email}</td>
                <td className="px-4 py-3">{t.category ?? "—"}</td>
                <td className="px-4 py-3">
                  <Pill tone={PRIORITY_TONE[(t.priority ?? "normal") as keyof typeof PRIORITY_TONE] ?? "gray"}>
                    {t.priority ?? "normal"}
                  </Pill>
                </td>
                <td className="px-4 py-3"><Pill tone={statusTone(t.status)}>{t.status}</Pill></td>
                <td className="px-4 py-3">{fmtDate(t.last_message_at)}</td>
              </tr>
            ))}
            {tickets.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-sm text-[var(--muted)]">
                  {status === "needs reply" ? "Nothing waiting on us. 🎉" : `No ${status} tickets.`}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
