import Link from "next/link";
import { requireAdminPage } from "@/lib/guard";
import { fmtDate } from "@/lib/format";
import { Section, Pill } from "@/lib/ui";
import ResolveControls from "./ResolveControls";

export const metadata = { title: "Moderation" };

export default async function ModerationPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  const ctx = await requireAdminPage("support");
  const showResolved = (await searchParams).filter === "resolved";

  let q = ctx.service
    .from("reports")
    .select("id, reporter_id, reported_user_id, job_id, booking_id, reason, details, created_at, resolved_at, resolution")
    .order("created_at", { ascending: false })
    .limit(100);
  q = showResolved ? q.not("resolved_at", "is", null) : q.is("resolved_at", null);
  const { data: reports, error } = await q;

  // Resolve names/titles referenced by the reports in bulk.
  const userIds = [
    ...new Set(
      (reports ?? []).flatMap((r) => [r.reporter_id, r.reported_user_id].filter(Boolean) as string[]),
    ),
  ];
  const jobIds = [...new Set((reports ?? []).map((r) => r.job_id).filter(Boolean) as string[])];

  const [profilesRes, jobsRes, recentBlocks] = await Promise.all([
    userIds.length
      ? ctx.service.from("profiles").select("id, name, username").in("id", userIds)
      : Promise.resolve({ data: [] as { id: string; name: string; username: string | null }[] }),
    jobIds.length
      ? ctx.service.from("jobs").select("id, title").in("id", jobIds)
      : Promise.resolve({ data: [] as { id: string; title: string }[] }),
    ctx.service
      .from("blocks")
      .select("blocker_id, blocked_id, created_at")
      .order("created_at", { ascending: false })
      .limit(15),
  ]);

  const nameOf = new Map((profilesRes.data ?? []).map((p) => [p.id, p.username ? `@${p.username}` : p.name]));
  const titleOf = new Map((jobsRes.data ?? []).map((j) => [j.id, j.title]));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Moderation</h1>
        <div className="flex gap-2 text-sm">
          <Link
            href="/moderation"
            className={`rounded-lg px-3 py-1.5 ${!showResolved ? "bg-[var(--brand)] text-white" : "border border-[var(--line)]"}`}
          >
            Open
          </Link>
          <Link
            href="/moderation?filter=resolved"
            className={`rounded-lg px-3 py-1.5 ${showResolved ? "bg-[var(--brand)] text-white" : "border border-[var(--line)]"}`}
          >
            Resolved
          </Link>
        </div>
      </div>

      {error && <p className="text-sm text-[var(--danger)]">Failed to load: {error.message}</p>}

      <Section title={`${showResolved ? "Resolved" : "Open"} reports (${reports?.length ?? 0})`}>
        {(reports ?? []).length === 0 ? (
          <p className="text-sm text-[var(--muted)]">Nothing here — {showResolved ? "no resolved reports" : "queue is clear"}. 🎉</p>
        ) : (
          <ul className="space-y-3">
            {(reports ?? []).map((r) => (
              <li key={r.id} className="rounded-lg border border-[var(--line)] p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{r.reason}</span>
                      {r.resolved_at ? <Pill tone="green">resolved</Pill> : <Pill tone="red">open</Pill>}
                    </div>
                    {r.details && <p className="mt-1 text-sm text-[var(--muted)]">{r.details}</p>}
                    <p className="mt-1 text-xs text-[var(--muted)]">
                      {r.reported_user_id ? (
                        <>
                          against{" "}
                          <Link href={`/users/${r.reported_user_id}`} className="text-[var(--brand)] hover:underline">
                            {nameOf.get(r.reported_user_id) ?? r.reported_user_id.slice(0, 8)}
                          </Link>{" "}
                        </>
                      ) : null}
                      by{" "}
                      <Link href={`/users/${r.reporter_id}`} className="text-[var(--brand)] hover:underline">
                        {nameOf.get(r.reporter_id) ?? r.reporter_id.slice(0, 8)}
                      </Link>
                      {r.job_id ? ` · gig: ${titleOf.get(r.job_id) ?? r.job_id.slice(0, 8)}` : ""}
                      {" · "}
                      {fmtDate(r.created_at)}
                      {r.resolution ? ` · “${r.resolution}”` : ""}
                    </p>
                  </div>
                  <ResolveControls reportId={String(r.id)} resolved={Boolean(r.resolved_at)} isAdmin={ctx.role === "admin"} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={`Recent blocks (${recentBlocks.data?.length ?? 0})`}>
        {(recentBlocks.data ?? []).length === 0 ? (
          <p className="text-sm text-[var(--muted)]">No blocks.</p>
        ) : (
          <ul className="text-sm">
            {(recentBlocks.data ?? []).map((b, i) => (
              <li key={i} className="flex items-center justify-between border-t border-[var(--line)] py-2 first:border-0">
                <span>
                  <Link href={`/users/${b.blocker_id}`} className="text-[var(--brand)] hover:underline">
                    {b.blocker_id.slice(0, 8)}
                  </Link>{" "}
                  blocked{" "}
                  <Link href={`/users/${b.blocked_id}`} className="text-[var(--brand)] hover:underline">
                    {b.blocked_id.slice(0, 8)}
                  </Link>
                </span>
                <span className="text-xs text-[var(--muted)]">{fmtDate(b.created_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
