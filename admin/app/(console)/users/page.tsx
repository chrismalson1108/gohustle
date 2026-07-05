import Link from "next/link";
import { requireAdminPage } from "@/lib/guard";
import { fmtDate } from "@/lib/format";

export const metadata = { title: "Users" };

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
}

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const ctx = await requireAdminPage("support");
  const q = (await searchParams).q?.trim() ?? "";

  let results: FoundUser[] | null = null;
  let searchError: string | null = null;
  if (q) {
    const { data, error } = await ctx.service.rpc("admin_find_users", { q });
    if (error) searchError = error.message;
    else results = data as FoundUser[];
  }

  return (
    <div>
      <h1 className="mb-4 text-2xl font-semibold">Users</h1>
      <form method="GET" className="mb-6 flex max-w-xl gap-2">
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="Search email, username, name, or user id…"
          className="flex-1 rounded-lg border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--brand)]"
          autoFocus
        />
        <button
          type="submit"
          className="rounded-lg bg-[var(--brand)] px-4 py-2 text-sm font-semibold text-white"
        >
          Search
        </button>
      </form>

      {searchError && <p className="text-sm text-[var(--danger)]">Search failed: {searchError}</p>}

      {results && results.length === 0 && (
        <p className="text-sm text-[var(--muted)]">No users match “{q}”.</p>
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
    </div>
  );
}
