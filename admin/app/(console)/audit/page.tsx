import Link from "next/link";
import { requireAdminPage } from "@/lib/guard";
import { fmtDate } from "@/lib/format";

export const metadata = { title: "Audit log" };

const PAGE_SIZE = 50;

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ action?: string; target?: string; page?: string }>;
}) {
  const ctx = await requireAdminPage("admin");
  const sp = await searchParams;
  const action = sp.action?.trim() ?? "";
  const target = sp.target?.trim() ?? "";
  const page = Math.max(0, parseInt(sp.page ?? "0", 10) || 0);

  let query = ctx.service
    .from("admin_audit_log")
    .select("id, admin_id, action, target_type, target_id, detail, ip, created_at")
    .order("created_at", { ascending: false })
    .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
  if (action) query = query.ilike("action", `${action}%`);
  if (target) query = query.eq("target_id", target);

  const { data: rows, error } = await query;

  // admin_id → display name
  const adminIds = [...new Set((rows ?? []).map((r) => r.admin_id))];
  const admins = adminIds.length
    ? (await ctx.service.from("profiles").select("id, name").in("id", adminIds)).data ?? []
    : [];
  const nameOf = new Map(admins.map((a) => [a.id, a.name]));

  const baseParams = new URLSearchParams();
  if (action) baseParams.set("action", action);
  if (target) baseParams.set("target", target);

  return (
    <div>
      <h1 className="mb-4 text-2xl font-semibold">Audit log</h1>

      <form method="GET" className="mb-6 flex max-w-2xl gap-2">
        <input
          name="action"
          defaultValue={action}
          placeholder="Action prefix (e.g. user.suspend)"
          className="flex-1 rounded-lg border border-[var(--line)] bg-white px-3 py-2 text-sm"
        />
        <input
          name="target"
          defaultValue={target}
          placeholder="Target id (user uuid)"
          className="flex-1 rounded-lg border border-[var(--line)] bg-white px-3 py-2 text-sm"
        />
        <button type="submit" className="rounded-lg bg-[var(--brand)] px-4 py-2 text-sm font-semibold text-white">
          Filter
        </button>
      </form>

      {error && <p className="text-sm text-[var(--danger)]">Failed to load: {error.message}</p>}

      <div className="overflow-x-auto rounded-xl border border-[var(--line)] bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--line)] text-left text-xs uppercase tracking-wide text-[var(--muted)]">
              <th className="px-4 py-3">When</th>
              <th className="px-4 py-3">Admin</th>
              <th className="px-4 py-3">Action</th>
              <th className="px-4 py-3">Target</th>
              <th className="px-4 py-3">IP</th>
              <th className="px-4 py-3">Detail</th>
            </tr>
          </thead>
          <tbody>
            {(rows ?? []).map((r) => (
              <tr key={r.id} className="border-b border-[var(--line)] align-top last:border-0">
                <td className="whitespace-nowrap px-4 py-2">{fmtDate(r.created_at)}</td>
                <td className="px-4 py-2">{nameOf.get(r.admin_id) ?? r.admin_id.slice(0, 8)}</td>
                <td className="px-4 py-2 font-mono text-xs">{r.action}</td>
                <td className="px-4 py-2">
                  {r.target_type === "user" && r.target_id ? (
                    <Link href={`/users/${r.target_id}`} className="font-mono text-xs text-[var(--brand)] hover:underline">
                      {r.target_id.slice(0, 8)}…
                    </Link>
                  ) : (
                    <span className="font-mono text-xs">{r.target_id ?? "—"}</span>
                  )}
                </td>
                <td className="px-4 py-2 font-mono text-xs">{r.ip ?? "—"}</td>
                <td className="px-4 py-2">
                  {r.detail && Object.keys(r.detail).length > 0 ? (
                    <details>
                      <summary className="cursor-pointer text-xs text-[var(--muted)]">view</summary>
                      <pre className="mt-1 max-w-md overflow-x-auto rounded bg-[var(--surface)] p-2 text-xs">
                        {JSON.stringify(r.detail, null, 2)}
                      </pre>
                    </details>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
            {(rows ?? []).length === 0 && !error && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-sm text-[var(--muted)]">
                  No entries.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex gap-3 text-sm">
        {page > 0 && (
          <Link
            href={`/audit?${new URLSearchParams({ ...Object.fromEntries(baseParams), page: String(page - 1) })}`}
            className="text-[var(--brand)] hover:underline"
          >
            ← Newer
          </Link>
        )}
        {(rows ?? []).length === PAGE_SIZE && (
          <Link
            href={`/audit?${new URLSearchParams({ ...Object.fromEntries(baseParams), page: String(page + 1) })}`}
            className="text-[var(--brand)] hover:underline"
          >
            Older →
          </Link>
        )}
      </div>
    </div>
  );
}
