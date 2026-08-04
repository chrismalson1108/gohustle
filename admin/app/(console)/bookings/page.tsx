import Link from "next/link";
import { requireAdminPage } from "@/lib/guard";
import { auditRead } from "@/lib/audit";
import { fmtCents, fmtDate } from "@/lib/format";
import { Section, Pill, statusTone } from "@/lib/ui";

export const metadata = { title: "Bookings" };

const PAGE_SIZE = 50;

const FILTERS = [
  { key: "attention", label: "Needs attention" },
  { key: "expiring", label: "Hold expiring" },
  { key: "one_sided", label: "One-sided" },
  { key: "active", label: "Active" },
  { key: "all", label: "All" },
] as const;

// There was no booking list at all — /bookings/[id] was reachable only by following a
// link from a report, a payment row, or a user page. So the questions that matter most
// operationally ("which bookings are stuck?", "whose escrow is about to lapse?") had
// no answer anywhere in the console.
//
// "Needs attention" is the default because it is the only view that is a work queue
// rather than a list.
export default async function BookingsPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string; page?: string }>;
}) {
  const ctx = await requireAdminPage("support");
  const sp = await searchParams;
  const filter = FILTERS.some((f) => f.key === sp.filter) ? sp.filter! : "attention";
  const page = Math.max(0, parseInt(sp.page ?? "0", 10) || 0);
  await auditRead(ctx, "bookings.list", "bookings", undefined, { filter, page });

  // A Stripe authorization dies at ~7 days. Anything held 5+ days is inside the
  // window where a worker who has already done the job is about to go unpaid.
  const expiryCutoff = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();

  // Bookings with an at-risk hold, resolved first so the other filters can flag them.
  const { data: expiringPays } = await ctx.service
    .from("payments")
    .select("booking_id, amount_cents, created_at")
    .eq("status", "authorized")
    .lte("created_at", expiryCutoff)
    .order("created_at", { ascending: true })
    .limit(200);
  const expiringIds = (expiringPays ?? []).map((p) => p.booking_id).filter(Boolean) as string[];
  const expiringBy = new Map((expiringPays ?? []).map((p) => [p.booking_id, p]));

  let query = ctx.service
    .from("bookings")
    .select("id, job_id, earner_id, status, earner_done, poster_done, started_at, created_at, slot_label", {
      count: "exact",
    })
    .order("created_at", { ascending: false })
    .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);

  // The predicate goes in the QUERY, not in JavaScript afterwards. Filtering the
  // 50 rows a page already returned meant the stuck bookings — old by definition,
  // and the list is newest-first — were never in the page-0 window, so the default
  // queue rendered "nothing needs attention" while the dashboard tile counted
  // dozens. That is a false negative in the one view built to catch them.
  const ONE_SIDED = "and(earner_done.is.true,poster_done.not.is.true),and(poster_done.is.true,earner_done.not.is.true)";
  const noMatch = ["00000000-0000-0000-0000-000000000000"];

  if (filter === "expiring") {
    // No at-risk holds is a real answer, not an empty filter — pin an impossible id
    // so the query returns nothing rather than everything.
    query = query.in("id", expiringIds.length ? expiringIds : noMatch);
  } else if (filter === "one_sided") {
    query = query.in("status", ["confirmed", "completed"]).or(ONE_SIDED);
  } else if (filter === "active") {
    query = query.in("status", ["pending", "confirmed", "completed"]);
  } else if (filter === "attention") {
    // One-sided OR an expiring hold. Both branches are expressed server-side so the
    // count and the pager describe the real result set.
    query = query
      .in("status", ["pending", "confirmed", "completed"])
      .or(
        `or(${ONE_SIDED}),id.in.(${(expiringIds.length ? expiringIds : noMatch).join(",")})`,
      );
  }

  const { data: rowsRaw, error, count } = await query;
  const rows = rowsRaw ?? [];

  const oneSided = (b: { earner_done: boolean | null; poster_done: boolean | null }) =>
    Boolean(b.earner_done) !== Boolean(b.poster_done);

  const jobIds = [...new Set(rows.map((b) => b.job_id).filter(Boolean))] as string[];
  const earnerIds = [...new Set(rows.map((b) => b.earner_id).filter(Boolean))] as string[];
  const [jobsRes, earnersRes] = await Promise.all([
    jobIds.length
      ? ctx.service.from("jobs").select("id, title, poster_id").in("id", jobIds)
      : Promise.resolve({ data: [] as { id: string; title: string; poster_id: string }[] }),
    earnerIds.length
      ? ctx.service.from("profiles").select("id, name, username").in("id", earnerIds)
      : Promise.resolve({ data: [] as { id: string; name: string; username: string | null }[] }),
  ]);
  const jobById = new Map((jobsRes.data ?? []).map((j) => [j.id, j]));
  const earnerById = new Map((earnersRes.data ?? []).map((p) => [p.id, p]));

  const pageHref = (p: number) => {
    const s = new URLSearchParams();
    s.set("filter", filter);
    if (p > 0) s.set("page", String(p));
    return `/bookings?${s.toString()}`;
  };

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold">Bookings</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Mutual completion means a booking where only one side pressed done sits forever with
          nobody at fault — while the escrow authorization expires at about 7 days.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <Link
            key={f.key}
            href={`/bookings?filter=${f.key}`}
            className={`rounded-lg px-3 py-1.5 text-sm ${
              filter === f.key ? "bg-[var(--brand)] text-white" : "border border-[var(--line)]"
            }`}
          >
            {f.label}
          </Link>
        ))}
        {expiringIds.length > 0 && (
          <span className="ml-auto text-sm font-medium text-[var(--danger)]">
            {expiringIds.length} hold{expiringIds.length === 1 ? "" : "s"} near expiry
          </span>
        )}
      </div>

      {error && <p className="text-sm text-[var(--danger)]">Failed to load: {error.message}</p>}

      <Section title={`${count ?? rows.length} booking${(count ?? rows.length) === 1 ? "" : "s"}`}>
        {(count ?? 0) > rows.length && (
          <p className="mb-3 text-xs text-[var(--muted)]">
            {count} match this filter in total — page through for the rest.
          </p>
        )}
        {rows.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">Nothing here — nothing needs attention. 🎉</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-[var(--muted)]">
                  <th className="py-1 pr-4">Gig</th>
                  <th className="py-1 pr-4">Earner</th>
                  <th className="py-1 pr-4">Status</th>
                  <th className="py-1 pr-4">Done</th>
                  <th className="py-1 pr-4">Flags</th>
                  <th className="py-1">Booked</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((b) => {
                  const job = jobById.get(b.job_id);
                  const earner = earnerById.get(b.earner_id);
                  const hold = expiringBy.get(b.id);
                  return (
                    <tr key={b.id} className="border-t border-[var(--line)]">
                      <td className="py-2 pr-4">
                        <Link href={`/bookings/${b.id}`} className="text-[var(--brand)] hover:underline">
                          {job?.title ?? b.id.slice(0, 8)}
                        </Link>
                      </td>
                      <td className="py-2 pr-4">
                        {earner ? (
                          <Link href={`/users/${b.earner_id}`} className="text-[var(--brand)] hover:underline">
                            {earner.username ? `@${earner.username}` : earner.name}
                          </Link>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="py-2 pr-4"><Pill tone={statusTone(b.status)}>{b.status}</Pill></td>
                      <td className="py-2 pr-4 text-xs">
                        {b.earner_done ? "earner" : "—"} / {b.poster_done ? "poster" : "—"}
                      </td>
                      <td className="py-2 pr-4">
                        <span className="flex flex-wrap gap-1">
                          {oneSided(b) && <Pill tone="amber">one-sided</Pill>}
                          {hold && <Pill tone="red">hold {fmtCents(hold.amount_cents)} expiring</Pill>}
                          {b.started_at && <Pill tone="green">started</Pill>}
                        </span>
                      </td>
                      <td className="py-2 text-xs text-[var(--muted)]">{fmtDate(b.created_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {(page > 0 || (count ?? 0) > (page + 1) * PAGE_SIZE) && (
        <div className="flex gap-3 text-sm">
          {page > 0 && (
            <Link href={pageHref(page - 1)} className="text-[var(--brand)] hover:underline">← Newer</Link>
          )}
          {(count ?? 0) > (page + 1) * PAGE_SIZE && (
            <Link href={pageHref(page + 1)} className="text-[var(--brand)] hover:underline">Older →</Link>
          )}
        </div>
      )}
    </div>
  );
}
