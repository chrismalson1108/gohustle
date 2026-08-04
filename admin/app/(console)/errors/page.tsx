import Link from "next/link";
import { requireAdminPage } from "@/lib/guard";
import { fmtDate } from "@/lib/format";

export const metadata = { title: "Client errors" };

const PAGE_SIZE = 50;

// Read side of the client-error sink (20260726130000). captureError() in both clients
// POSTs here through the log-client-error edge function, so a production crash is
// visible to the team without waiting for a tester to report it — which was the whole
// gap: SENTRY_DSN is null, so before this the 15 captureError call sites and the root
// ErrorBoundary all dead-ended in an in-memory buffer that died with the process.
export default async function ClientErrorsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; fatal?: string; dev?: string; page?: string }>;
}) {
  const ctx = await requireAdminPage("support");
  const sp = await searchParams;
  const q = sp.q?.trim() ?? "";
  const fatalOnly = sp.fatal === "1";
  // PRODUCTION-ONLY BY DEFAULT. Every row this page first showed came from a local
  // Metro session (127.0.0.1:8081, dev=true) — the founder's own machine. Once real
  // testers arrive, dev noise at equal weight is how a genuine crash goes unnoticed.
  // Opt in to see dev rows; never the other way round.
  const showDev = sp.dev === "1";
  const page = Math.max(0, parseInt(sp.page ?? "0", 10) || 0);

  let query = ctx.service
    .from("client_errors")
    .select("id, user_id, platform, app_version, message, context, fatal, dev, created_at", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
  if (q) query = query.ilike("message", `%${q}%`);
  if (fatalOnly) query = query.eq("fatal", true);
  if (!showDev) query = query.eq("dev", false);

  const { data: rows, error, count } = await query;

  // How much is being hidden, so "queue is clear" is never a lie of omission.
  const { count: devCount } = await ctx.service
    .from("client_errors")
    .select("id", { count: "exact", head: true })
    .eq("dev", true);

  const userIds = [...new Set((rows ?? []).map((r) => r.user_id).filter(Boolean))] as string[];
  const users = userIds.length
    ? (await ctx.service.from("profiles").select("id, name").in("id", userIds)).data ?? []
    : [];
  const nameOf = new Map(users.map((u) => [u.id, u.name]));

  const baseParams = new URLSearchParams();
  if (q) baseParams.set("q", q);
  if (fatalOnly) baseParams.set("fatal", "1");
  if (showDev) baseParams.set("dev", "1");
  const pageHref = (p: number) => {
    const s = new URLSearchParams(baseParams);
    s.set("page", String(p));
    return `/errors?${s.toString()}`;
  };

  return (
    <div>
      <h1 className="text-xl font-semibold text-[var(--ink)]">Client errors</h1>
      <p className="mt-1 text-sm text-[var(--muted)]">
        Errors reported by the mobile and web clients. Newest first.{" "}
        {showDev
          ? "Showing development builds too."
          : `Production builds only${devCount ? ` — ${devCount} dev-build error${devCount === 1 ? "" : "s"} hidden` : ""}.`}
        {typeof count === "number" ? ` ${count} total.` : ""}
      </p>

      <form className="mt-4 flex flex-wrap items-center gap-2" action="/errors">
        <input
          name="q"
          defaultValue={q}
          placeholder="Search message…"
          className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-sm"
        />
        <label className="flex items-center gap-1.5 text-sm text-[var(--muted)]">
          <input type="checkbox" name="fatal" value="1" defaultChecked={fatalOnly} />
          Fatal only
        </label>
        <label className="flex items-center gap-1.5 text-sm text-[var(--muted)]">
          <input type="checkbox" name="dev" value="1" defaultChecked={showDev} />
          Include dev builds
        </label>
        <button type="submit" className="rounded-lg bg-[var(--brand)] px-3 py-1.5 text-sm font-medium text-white">
          Filter
        </button>
      </form>

      {error ? (
        <p className="mt-6 text-sm text-red-600">Could not load errors: {error.message}</p>
      ) : !rows?.length ? (
        <p className="mt-6 text-sm text-[var(--muted)]">No errors recorded. That is the good outcome.</p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-[var(--muted)]">
                <th className="py-1 pr-4">When</th>
                <th className="py-1 pr-4">Platform</th>
                <th className="py-1 pr-4">User</th>
                <th className="py-1 pr-4">Message</th>
                <th className="py-1">Context</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-[var(--line)] align-top">
                  <td className="whitespace-nowrap py-2 pr-4 text-[var(--muted)]">{fmtDate(r.created_at)}</td>
                  <td className="py-2 pr-4">
                    {r.platform ?? "—"}
                    {r.app_version ? ` · ${r.app_version}` : ""}
                    {r.fatal ? (
                      <span className="ml-1 rounded bg-red-100 px-1.5 py-0.5 text-xs font-medium text-red-700">
                        fatal
                      </span>
                    ) : null}
                  </td>
                  <td className="py-2 pr-4">
                    {r.user_id ? (
                      <Link href={`/users/${r.user_id}`} className="text-[var(--brand)] hover:underline">
                        {nameOf.get(r.user_id) ?? r.user_id.slice(0, 8)}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </td>
                  {/* message and context are CLIENT-SUPPLIED. Rendered as text by JSX
                      escaping — never dangerouslySetInnerHTML — so a crafted error
                      message cannot inject markup into an admin's browser, which is
                      the highest-value target in the system (it holds the service
                      role key). */}
                  <td className="py-2 pr-4 font-mono text-xs">{r.message}</td>
                  <td className="py-2 font-mono text-xs text-[var(--muted)]">
                    {r.context ? JSON.stringify(r.context) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-4 flex gap-3 text-sm">
        {page > 0 && (
          <Link href={pageHref(page - 1)} className="text-[var(--brand)] hover:underline">
            ← Newer
          </Link>
        )}
        {rows?.length === PAGE_SIZE && (
          <Link href={pageHref(page + 1)} className="text-[var(--brand)] hover:underline">
            Older →
          </Link>
        )}
      </div>
    </div>
  );
}
