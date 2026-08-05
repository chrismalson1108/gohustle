import Link from "next/link";
import { requireAdminPage } from "@/lib/guard";
import { fmtDate } from "@/lib/format";
import { Pill, statusTone } from "@/lib/ui";

export const metadata = { title: "Jobs" };

const STATUSES = ["", "open", "booked", "completed", "cancelled"];

export default async function JobsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; cat?: string }>;
}) {
  const ctx = await requireAdminPage("support");
  const sp = await searchParams;
  const search = sp.q?.trim() ?? "";
  const status = sp.status ?? "";
  const cat = sp.cat?.trim() ?? "";

  let q = ctx.service
    .from("jobs")
    .select("id, title, category, category_slug, pay, pay_type, location, status, poster_id, created_at")
    .order("created_at", { ascending: false })
    .limit(60);
  if (search) q = q.ilike("title", `%${search}%`);
  if (status) q = q.eq("status", status);
  // Filter on the SLUG, never the label. The label is display text — it can differ in
  // casing between two gigs in the same category, and a gig booked before a merge keeps
  // the label it was booked under while its slug follows the merge.
  if (cat) q = q.eq("category_slug", cat);

  // The options come from the taxonomy table because the taxonomy is now dynamic: users
  // mint categories by posting, so a hardcoded list would be missing exactly the
  // user-invented category a moderator opened this page to triage. Reserved and merged
  // rows are excluded — nothing is filed under either.
  const [jobsRes, catsRes] = await Promise.all([
    q,
    ctx.service
      .from("categories")
      .select("slug, label, status")
      .in("status", ["canonical", "community"])
      .order("usage_count", { ascending: false })
      .order("label"),
  ]);
  const jobs = jobsRes.data ?? [];
  const cats = catsRes.data ?? [];
  // A slug arriving from a link (or a merge that happened since) may not be in the
  // selectable list; keep it as an option so the active filter is still visible.
  const selectedKnown = cats.some((c) => c.slug === cat);

  const posterIds = [...new Set(jobs.map((j) => j.poster_id))];
  const posters = posterIds.length
    ? (await ctx.service.from("profiles").select("id, name, username").in("id", posterIds)).data ?? []
    : [];
  const posterOf = new Map(posters.map((p) => [p.id, p.username ? `@${p.username}` : p.name]));

  function chipHref(nextStatus: string) {
    const params = new URLSearchParams();
    if (nextStatus) params.set("status", nextStatus);
    if (search) params.set("q", search);
    if (cat) params.set("cat", cat);
    const qs = params.toString();
    return qs ? `/jobs?${qs}` : "/jobs";
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Jobs</h1>
        <Link href="/categories" className="text-sm text-[var(--brand)] hover:underline">
          Manage categories →
        </Link>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <form method="GET" className="flex min-w-0 flex-1 flex-wrap gap-2">
          <input
            name="q"
            defaultValue={search}
            placeholder="Search gig title…"
            className="min-w-0 flex-1 rounded-lg border border-[var(--line)] bg-white px-3 py-2 text-sm"
          />
          <select
            name="cat"
            defaultValue={cat}
            className="min-w-0 max-w-56 rounded-lg border border-[var(--line)] bg-white px-3 py-2 text-sm"
          >
            <option value="">All categories</option>
            {!selectedKnown && cat && <option value={cat}>{cat}</option>}
            {cats.map((c) => (
              <option key={c.slug} value={c.slug}>
                {c.label}
                {c.status === "community" ? " (new)" : ""}
              </option>
            ))}
          </select>
          {status && <input type="hidden" name="status" value={status} />}
          <button className="rounded-lg bg-[var(--brand)] px-4 py-2 text-sm font-semibold text-white">Search</button>
        </form>
        <div className="flex gap-1 text-xs">
          {STATUSES.map((s) => (
            <Link
              key={s || "all"}
              href={chipHref(s)}
              className={`rounded px-2 py-1.5 ${status === s ? "bg-[var(--brand)] text-white" : "border border-[var(--line)]"}`}
            >
              {s || "all"}
            </Link>
          ))}
        </div>
      </div>

      {(jobsRes.error || catsRes.error) && (
        <p className="text-sm text-[var(--danger)]">{jobsRes.error?.message ?? catsRes.error?.message}</p>
      )}

      <div className="overflow-x-auto rounded-xl border border-[var(--line)] bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--line)] text-left text-xs uppercase tracking-wide text-[var(--muted)]">
              <th className="px-4 py-3">Title</th>
              <th className="px-4 py-3">Category</th>
              <th className="px-4 py-3">Pay</th>
              <th className="px-4 py-3">Location</th>
              <th className="px-4 py-3">Poster</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Posted</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id} className="border-b border-[var(--line)] last:border-0 hover:bg-[var(--surface)]">
                <td className="px-4 py-3">
                  <Link href={`/jobs/${j.id}`} className="font-medium text-[var(--brand)] hover:underline">
                    {j.title}
                  </Link>
                </td>
                <td className="px-4 py-3">
                  {j.category_slug ? (
                    <Link href={chipHrefForCategory(j.category_slug, status, search)} className="hover:underline">
                      {j.category || j.category_slug}
                    </Link>
                  ) : (
                    // category_slug is null when the value normalized away or hit a
                    // reserved control word; the gig is real but unfilterable.
                    <span className="text-[var(--muted)]">{j.category || "—"}</span>
                  )}
                </td>
                <td className="px-4 py-3">${Number(j.pay)}{j.pay_type === "hourly" ? "/hr" : ""}</td>
                <td className="px-4 py-3">{j.location}</td>
                <td className="px-4 py-3">
                  <Link href={`/users/${j.poster_id}`} className="text-[var(--brand)] hover:underline">
                    {posterOf.get(j.poster_id) ?? j.poster_id.slice(0, 8)}
                  </Link>
                </td>
                <td className="px-4 py-3"><Pill tone={statusTone(j.status)}>{j.status}</Pill></td>
                <td className="px-4 py-3">{fmtDate(j.created_at)}</td>
              </tr>
            ))}
            {jobs.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-6 text-center text-sm text-[var(--muted)]">No gigs match.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function chipHrefForCategory(slug: string, status: string, search: string) {
  const params = new URLSearchParams({ cat: slug });
  if (status) params.set("status", status);
  if (search) params.set("q", search);
  return `/jobs?${params.toString()}`;
}
