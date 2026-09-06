import Link from "next/link";
import { requireAdminPage } from "@/lib/guard";
import { fmtDate } from "@/lib/format";
import { Pill, statusTone } from "@/lib/ui";

export const metadata = { title: "Support" };

const PRIORITY_TONE = { urgent: "red", high: "amber", normal: "gray", low: "gray" } as const;

const PAGE_SIZE = 50;

// The tabs are what an agent picks up in the morning, so "needs reply" leads: it is
// the only one that answers "what have we not responded to". Sorting by recency alone
// buries the ticket that has been waiting longest underneath the one someone just
// wrote in, which is exactly backwards for a queue.
const TABS = ["needs reply", "open", "pending", "closed", "all"] as const;

export default async function SupportPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; page?: string }>;
}) {
  const ctx = await requireAdminPage("support");
  const sp = await searchParams;
  const status = sp.status ?? "needs reply";
  const page = Math.max(0, parseInt(sp.page ?? "0", 10) || 0);
  const needsReplyTab = status === "needs reply";

  // "Waiting on us" = the last message is from the CUSTOMER.
  //
  // This was derived from agent_read_at < last_message_at, which was wrong in a way
  // that only ever hid work: rendering this ticket's page stamps agent_read_at, so
  // opening a ticket and closing it again dropped it out of the queue without anyone
  // having answered it. Reading is not replying.
  const waitingOnUs = (t: { last_author: string | null }) => t.last_author === "user";
  // Kept as a separate, weaker signal — worth surfacing, but it never decides the queue.
  const neverOpened = (t: { agent_read_at: string | null }) => !t.agent_read_at;

  // THE PREDICATE GOES IN THE QUERY. This asked for the 200 most recent open+pending
  // tickets and then applied `waitingOnUs` to that array in JavaScript — so the rows
  // the limit cut were the OLDEST, which on a longest-waiting-first queue are exactly
  // the ones it exists to surface. Past 200 open tickets the tab could read "Nothing
  // waiting on us" while sixty people waited, and the badge counted the same truncated
  // array. It is the same false negative /bookings fixed, for the same reason.
  //
  // The ORDER is server-side too, and has to be, or the pager is incoherent: sorting
  // only the rows this page happened to fetch puts a ticket on page 0 or page 3
  // depending on what the window caught. `priority_rank` (20260906015300) exists
  // because PostgREST can only order by a column and `priority` is text — ordering on
  // that directly sorts alphabetically: high, low, normal, urgent.
  let q = ctx.service
    .from("support_tickets")
    .select(
      "id, email, name, subject, category, status, priority, assigned_to, archived_at, last_message_at, agent_read_at, last_author, booking_id",
      { count: "exact" },
    )
    .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);

  if (needsReplyTab) {
    // Urgent before routine, then whoever has been waiting longest.
    q = q
      .in("status", ["open", "pending"])
      .eq("last_author", "user")
      .order("priority_rank", { ascending: true })
      .order("last_message_at", { ascending: true });
  } else {
    if (status !== "all") q = q.eq("status", status);
    q = q.order("last_message_at", { ascending: false });
  }
  const { data: raw, error, count } = await q;
  const tickets = raw ?? [];

  // The badge gets its OWN exact count rather than a length taken from whatever this
  // page fetched — otherwise every other tab reports a number about its own rows and
  // the needs-reply tab reports at most its page size.
  const { count: needsReplyCount } = await ctx.service
    .from("support_tickets")
    .select("id", { count: "exact", head: true })
    .in("status", ["open", "pending"])
    .eq("last_author", "user");
  const needsReply = needsReplyCount ?? 0;

  const pageHref = (p: number) => {
    const s = new URLSearchParams();
    s.set("status", status);
    if (p > 0) s.set("page", String(p));
    return `/support?${s.toString()}`;
  };

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
          {(count ?? 0) > tickets.length ? (
            <span className="ml-2 text-sm font-normal text-[var(--muted)]">
              {count} in this tab, showing {tickets.length}
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

      {/* Without this the oldest tickets are unreachable: the list is one page of a set
          that can be far larger, and the tab that matters is ordered so the longest
          waiting come FIRST — so its tail is the recent, less urgent end. */}
      {(page > 0 || (count ?? 0) > (page + 1) * PAGE_SIZE) && (
        <div className="flex gap-3 text-sm">
          {page > 0 && (
            <Link href={pageHref(page - 1)} className="text-[var(--brand)] hover:underline">
              &larr; {needsReplyTab ? "More urgent" : "Newer"}
            </Link>
          )}
          {(count ?? 0) > (page + 1) * PAGE_SIZE && (
            <Link href={pageHref(page + 1)} className="text-[var(--brand)] hover:underline">
              {needsReplyTab ? "Less urgent" : "Older"} &rarr;
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
