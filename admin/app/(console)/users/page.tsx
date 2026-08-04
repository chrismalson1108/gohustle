import Link from "next/link";
import { requireAdminPage } from "@/lib/guard";
import { auditRead } from "@/lib/audit";
import { fmtDate } from "@/lib/format";

export const metadata = { title: "Users" };

const PAGE_SIZE = 50;

interface FoundUser {
  id: string;
  email: string | null;
  name: string | null;
  username: string | null;
  created_at: string;
  suspended_at: string | null;
  verified: boolean;
  rating: number;
  review_count: number;
  total?: number;
}

const FILTERS = [
  { key: "all", label: "All" },
  { key: "new", label: "New (7d)" },
  { key: "suspended", label: "Suspended" },
  { key: "verified", label: "Verified" },
  { key: "students", label: "Students" },
] as const;

// This page used to render NOTHING until you typed a search term, and the search RPC
// caps at 25 rows — so there was no way to browse the user base, no answer to "who
// signed up today", and the dashboard's Suspended tile linked here to a page that
// could not list suspended users. Search is still search; browsing is now the default.
export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; filter?: string; page?: string }>;
}) {
  const ctx = await requireAdminPage("support");
  const sp = await searchParams;
  const q = sp.q?.trim() ?? "";
  const filter = FILTERS.some((f) => f.key === sp.filter) ? sp.filter! : "all";
  const page = Math.max(0, parseInt(sp.page ?? "0", 10) || 0);

  let results: FoundUser[] | null = null;
  let listError: string | null = null;
  let total = 0;

  if (q) {
    const { data, error } = await ctx.service.rpc("admin_find_users", { q });
    if (error) listError = error.message;
    else results = data as FoundUser[];
    total = results?.length ?? 0;
    // Searching returns emails/names — record who searched for what.
    await auditRead(ctx, "user.search", "search", undefined, { q, results: total });
  } else {
    const { data, error } = await ctx.service.rpc("admin_list_users", {
      p_filter: filter,
      p_limit: PAGE_SIZE,
      p_offset: page * PAGE_SIZE,
    });
    if (error) listError = error.message;
    else results = data as FoundUser[];
    total = results?.[0]?.total ?? 0;
    // Browsing exposes the same emails a search does — same audit weight.
    await auditRead(ctx, "user.list", "search", undefined, { filter, page, results: results?.length ?? 0 });
  }

  const hasMore = !q && (page + 1) * PAGE_SIZE < total;
  const pageHref = (p: number) => {
    const s = new URLSearchParams();
    if (filter !== "all") s.set("filter", filter);
    if (p > 0) s.set("page", String(p));
    const qs = s.toString();
    return qs ? `/users?${qs}` : "/users";
  };

  return (
    <div>
      <h1 className="mb-4 text-2xl font-semibold">Users</h1>

      <form method="GET" className="mb-4 flex max-w-xl gap-2">
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="Search email, username, name, or user id…"
          className="flex-1 rounded-lg border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--brand)]"
        />
        <button
          type="submit"
          className="rounded-lg bg-[var(--brand)] px-4 py-2 text-sm font-semibold text-white"
        >
          Search
        </button>
      </form>

      {q ? (
        <p className="mb-4 text-sm text-[var(--muted)]">
          {total} result{total === 1 ? "" : "s"} for “{q}” (search shows at most 25).{" "}
          <Link href="/users" className="text-[var(--brand)] hover:underline">
            Clear
          </Link>
        </p>
      ) : (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {FILTERS.map((f) => (
            <Link
              key={f.key}
              href={f.key === "all" ? "/users" : `/users?filter=${f.key}`}
              className={`rounded-lg px-3 py-1.5 text-sm ${
                filter === f.key ? "bg-[var(--brand)] text-white" : "border border-[var(--line)]"
              }`}
            >
              {f.label}
            </Link>
          ))}
          <span className="ml-auto text-sm text-[var(--muted)]">
            {total} user{total === 1 ? "" : "s"}
          </span>
        </div>
      )}

      {listError && <p className="text-sm text-[var(--danger)]">Failed to load: {listError}</p>}

      {results && results.length === 0 && !listError && (
        <p className="text-sm text-[var(--muted)]">
          {q ? `No users match “${q}”.` : "No users match this filter."}
        </p>
      )}

      {results && results.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-[var(--line)] bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--line)] text-left text-xs uppercase tracking-wide text-[var(--muted)]">
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Username</th>
                <th className="px-4 py-3">Email</th>
                <th className="px-4 py-3">Rating</th>
                <th className="px-4 py-3">Joined</th>
                <th className="px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {results.map((u) => (
                <tr key={u.id} className="border-b border-[var(--line)] last:border-0 hover:bg-[var(--surface)]">
                  <td className="px-4 py-3">
                    <Link href={`/users/${u.id}`} className="font-medium text-[var(--brand)] hover:underline">
                      {u.name ?? "—"}
                    </Link>
                  </td>
                  <td className="px-4 py-3">{u.username ? `@${u.username}` : "—"}</td>
                  <td className="px-4 py-3">{u.email ?? "—"}</td>
                  <td className="px-4 py-3">
                    {Number(u.rating).toFixed(1)} ({u.review_count})
                  </td>
                  <td className="px-4 py-3">{fmtDate(u.created_at)}</td>
                  <td className="px-4 py-3">
                    {u.suspended_at ? (
                      <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
                        Suspended
                      </span>
                    ) : u.verified ? (
                      <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">
                        Verified
                      </span>
                    ) : (
                      <span className="text-xs text-[var(--muted)]">Active</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!q && (page > 0 || hasMore) && (
        <div className="mt-4 flex gap-3 text-sm">
          {page > 0 && (
            <Link href={pageHref(page - 1)} className="text-[var(--brand)] hover:underline">
              ← Newer
            </Link>
          )}
          {hasMore && (
            <Link href={pageHref(page + 1)} className="text-[var(--brand)] hover:underline">
              Older →
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
