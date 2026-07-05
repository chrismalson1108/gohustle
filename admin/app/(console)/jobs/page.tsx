import Link from "next/link";
import { requireAdminPage } from "@/lib/guard";
import { fmtDate } from "@/lib/format";
import { Pill, statusTone } from "@/lib/ui";

export const metadata = { title: "Jobs" };

export default async function JobsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string }>;
}) {
  const ctx = await requireAdminPage("support");
  const sp = await searchParams;
  const search = sp.q?.trim() ?? "";
  const status = sp.status ?? "";

  let q = ctx.service
    .from("jobs")
    .select("id, title, category, pay, pay_type, location, status, poster_id, created_at")
    .order("created_at", { ascending: false })
    .limit(60);
  if (search) q = q.ilike("title", `%${search}%`);
  if (status) q = q.eq("status", status);
  const { data: jobs, error } = await q;

  const posterIds = [...new Set((jobs ?? []).map((j) => j.poster_id))];
  const posters = posterIds.length
    ? (await ctx.service.from("profiles").select("id, name, username").in("id", posterIds)).data ?? []
    : [];
  const posterOf = new Map(posters.map((p) => [p.id, p.username ? `@${p.username}` : p.name]));

  const STATUSES = ["", "open", "booked", "completed", "cancelled"];

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-semibold">Jobs</h1>

      <div className="flex flex-wrap items-center gap-3">
        <form method="GET" className="flex flex-1 gap-2">
          <input
            name="q"
            defaultValue={search}
            placeholder="Search gig title…"
            className="flex-1 rounded-lg border border-[var(--line)] bg-white px-3 py-2 text-sm"
          />
          {status && <input type="hidden" name="status" value={status} />}
          <button className="rounded-lg bg-[var(--brand)] px-4 py-2 text-sm font-semibold text-white">Search</button>
        </form>
        <div className="flex gap-1 text-xs">
          {STATUSES.map((s) => (
            <Link
              key={s || "all"}
              href={s ? `/jobs?status=${s}` : "/jobs"}
              className={`rounded px-2 py-1.5 ${status === s ? "bg-[var(--brand)] text-white" : "border border-[var(--line)]"}`}
            >
              {s || "all"}
            </Link>
          ))}
        </div>
      </div>

      {error && <p className="text-sm text-[var(--danger)]">{error.message}</p>}

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
            {(jobs ?? []).map((j) => (
              <tr key={j.id} className="border-b border-[var(--line)] last:border-0 hover:bg-[var(--surface)]">
                <td className="px-4 py-3">
                  <Link href={`/jobs/${j.id}`} className="font-medium text-[var(--brand)] hover:underline">
                    {j.title}
                  </Link>
                </td>
                <td className="px-4 py-3">{j.category}</td>
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
            {(jobs ?? []).length === 0 && (
              <tr><td colSpan={7} className="px-4 py-6 text-center text-sm text-[var(--muted)]">No gigs match.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
