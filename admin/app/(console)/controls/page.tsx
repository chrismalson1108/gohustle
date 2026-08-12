import { requireAdminPage } from "@/lib/guard";
import { fmtDate } from "@/lib/format";
import { RunSweepButton, CloseFinding, ToggleControl } from "./ControlControls";

export const metadata = { title: "Controls" };

// Read side of the control framework (20260806010000). Controls are scheduled SQL
// invariant checks run by pg_cron; each returns one row per violation, and violations
// become findings here.
//
// The ordering of this page is deliberate and is the whole design: CONTROL HEALTH
// comes before FINDINGS. A control that is erroring or has stopped running is worse
// news than any single violation, because it means the absence of findings no longer
// means anything. Safety alerting sat dead for a month on this exact failure — the
// trigger existed, the function was deployed, and nothing anywhere said "this has
// never once fired."
const SEV_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const SEV_CLASS: Record<string, string> = {
  critical: "bg-red-100 text-red-800",
  high: "bg-amber-100 text-amber-900",
  medium: "bg-indigo-100 text-indigo-800",
  low: "bg-gray-100 text-gray-700",
};

export default async function ControlsPage({
  searchParams,
}: {
  searchParams: Promise<{ sev?: string; resolved?: string }>;
}) {
  const ctx = await requireAdminPage("support");
  const sp = await searchParams;
  const sev = sp.sev ?? "";
  const showResolved = sp.resolved === "1";

  const { data: controls } = await ctx.service
    .from("controls")
    .select("key, title, severity, domain, why, enabled, last_run_at, last_run_ms, last_violations, last_error")
    .order("key");

  let fq = ctx.service
    .from("control_findings")
    .select("id, control_key, entity_id, severity, detail, first_seen_at, last_seen_at, resolved_at, note")
    .order("last_seen_at", { ascending: false })
    .limit(200);
  fq = showResolved ? fq.not("resolved_at", "is", null) : fq.is("resolved_at", null);
  if (sev) fq = fq.eq("severity", sev);
  const { data: findings, error } = await fq;

  const all = controls ?? [];
  const enabled = all.filter((c) => c.enabled);
  const errored = enabled.filter((c) => c.last_error);
  const stale = enabled.filter(
    (c) => !c.last_run_at || Date.parse(c.last_run_at) < Date.now() - 6 * 3600_000,
  );
  const titleOf = (k: string) => all.find((c) => c.key === k)?.title ?? k;

  const rows = (findings ?? []).slice().sort(
    (a, b) => (SEV_RANK[a.severity] ?? 9) - (SEV_RANK[b.severity] ?? 9),
  );

  return (
    <div>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-[var(--ink)]">Controls</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Scheduled invariant checks. They run hourly in the database, not here — so
            they keep running when nobody is looking.
          </p>
        </div>
        <RunSweepButton />
      </div>

      {/* Detection health first. If this section is unhappy, nothing below is trustworthy. */}
      {all.length === 0 ? (
        <p className="mt-6 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <strong>No controls are registered.</strong> The framework is installed but
          nothing is being checked, so an empty findings list below means nothing.
        </p>
      ) : errored.length || stale.length ? (
        <div className="mt-6 space-y-2">
          {errored.length > 0 && (
            <div className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900">
              <strong>
                {errored.length} control{errored.length === 1 ? "" : "s"} erroring — detection is degraded.
              </strong>
              <ul className="mt-1 list-disc pl-5">
                {errored.map((c) => (
                  <li key={c.key}>
                    <span className="font-mono text-xs">{c.key}</span>: {c.last_error}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {stale.length > 0 && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <strong>
                {stale.length} control{stale.length === 1 ? "" : "s"} have not run in 6 hours.
              </strong>{" "}
              The sweep may not be scheduled: {stale.map((c) => c.key).join(", ")}
            </div>
          )}
        </div>
      ) : (
        <p className="mt-6 rounded-lg border border-green-300 bg-green-50 px-4 py-2 text-sm text-green-900">
          All {enabled.length} enabled control{enabled.length === 1 ? "" : "s"} ran recently with no errors.
        </p>
      )}

      {/* Findings */}
      <div className="mt-8 flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold text-[var(--ink)]">
          {showResolved ? "Resolved findings" : "Open findings"}
        </h2>
        <div className="ml-auto flex gap-1.5 text-xs">
          {["", "critical", "high", "medium", "low"].map((s) => (
            <a
              key={s || "all"}
              href={`/controls?${new URLSearchParams({ ...(s ? { sev: s } : {}), ...(showResolved ? { resolved: "1" } : {}) }).toString()}`}
              className={`rounded-full px-2.5 py-1 ${sev === s ? "bg-[var(--brand)] text-white" : "bg-[var(--surface)] text-[var(--muted)]"}`}
            >
              {s || "all"}
            </a>
          ))}
          <a
            href={`/controls?${new URLSearchParams({ ...(sev ? { sev } : {}), ...(showResolved ? {} : { resolved: "1" }) }).toString()}`}
            className="rounded-full bg-[var(--surface)] px-2.5 py-1 text-[var(--muted)]"
          >
            {showResolved ? "show open" : "show resolved"}
          </a>
        </div>
      </div>

      {error ? (
        <p className="mt-4 text-sm text-red-600">Could not load findings: {error.message}</p>
      ) : rows.length === 0 ? (
        <p className="mt-4 text-sm text-[var(--muted)]">
          {showResolved
            ? "Nothing resolved yet."
            : all.length === 0
              ? "Nothing is being checked yet."
              : "No open findings. That is the good outcome."}
        </p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b-2 border-[var(--ink)] text-left">
                <th className="px-3 py-2">Sev</th>
                <th className="px-3 py-2">Control</th>
                <th className="px-3 py-2">Entity</th>
                <th className="px-3 py-2">Detail</th>
                <th className="px-3 py-2">First seen</th>
                {!showResolved && <th className="px-3 py-2">Close</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((f) => (
                <tr key={f.id} className="border-b border-[var(--line)] align-top">
                  <td className="px-3 py-2">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${SEV_CLASS[f.severity] ?? ""}`}>
                      {f.severity}
                    </span>
                  </td>
                  <td className="px-3 py-2">{titleOf(f.control_key)}</td>
                  <td className="px-3 py-2 font-mono text-xs text-[var(--muted)]">{f.entity_id || "—"}</td>
                  <td className="px-3 py-2 font-mono text-xs text-[var(--muted)]">
                    {JSON.stringify(f.detail)}
                  </td>
                  <td className="px-3 py-2 text-xs text-[var(--muted)]">{fmtDate(f.first_seen_at)}</td>
                  {!showResolved && (
                    <td className="px-3 py-2">
                      <CloseFinding findingId={f.id} />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-[var(--muted)]">
            Closing a finding does not fix it. If the condition still holds, the next
            sweep re-opens it.
          </p>
        </div>
      )}

      {/* Registry */}
      <h2 className="mt-10 text-base font-semibold text-[var(--ink)]">Registered controls</h2>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b-2 border-[var(--ink)] text-left">
              <th className="px-3 py-2">Control</th>
              <th className="px-3 py-2">Domain</th>
              <th className="px-3 py-2">Sev</th>
              <th className="px-3 py-2">Last run</th>
              <th className="px-3 py-2">Violations</th>
              {ctx.role === "admin" && <th className="px-3 py-2">Enabled</th>}
            </tr>
          </thead>
          <tbody>
            {all.map((c) => (
              <tr key={c.key} className="border-b border-[var(--line)] align-top">
                <td className="px-3 py-2">
                  <div className="font-medium">{c.title}</div>
                  <div className="font-mono text-xs text-[var(--muted)]">{c.key}</div>
                  {c.why && <div className="mt-0.5 max-w-xl text-xs text-[var(--muted)]">{c.why}</div>}
                </td>
                <td className="px-3 py-2 text-xs text-[var(--muted)]">{c.domain}</td>
                <td className="px-3 py-2 text-xs">{c.severity}</td>
                <td className="px-3 py-2 text-xs text-[var(--muted)]">
                  {c.last_run_at ? fmtDate(c.last_run_at) : "never"}
                  {typeof c.last_run_ms === "number" ? ` · ${c.last_run_ms}ms` : ""}
                </td>
                <td className="px-3 py-2 text-xs">
                  {c.last_error ? (
                    <span className="text-red-700">errored</span>
                  ) : (
                    (c.last_violations ?? 0)
                  )}
                </td>
                {ctx.role === "admin" && (
                  <td className="px-3 py-2">
                    <ToggleControl controlKey={c.key} enabled={c.enabled} />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
