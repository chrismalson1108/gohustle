import { requireAdminPage } from "@/lib/guard";
import { fmtDate } from "@/lib/format";
import { CreatePromotion, StatusButtons, MintCodes, EditPromotion, RevokeGrant } from "./PromoControls";

export const metadata = { title: "Promotions" };

// Campaigns spend real margin, so this page is admin-only and leads with SPEND, not
// with configuration. The number that matters when you open it is "how much has this
// cost me", which is why budget burn-down is the widest column.
const money = (c: number) => `$${(c / 100).toFixed(2)}`;

const STATUS_CLASS: Record<string, string> = {
  active: "bg-green-100 text-green-800",
  draft: "bg-gray-100 text-gray-700",
  paused: "bg-amber-100 text-amber-900",
  ended: "bg-gray-100 text-gray-500",
};

export default async function PromotionsPage() {
  const ctx = await requireAdminPage("admin");

  const { data: promos, error } = await ctx.service
    .from("promotions")
    .select("id, name, kind, status, fee_bps, bonus_cents, poster_discount_cents, uses_allowed, max_redemptions, redemptions_used, budget_cents, spent_cents, starts_at, ends_at, created_at")
    .order("created_at", { ascending: false });

  const { data: codes } = await ctx.service
    .from("promo_codes")
    .select("promotion_id, code, max_redemptions, redemptions_used");

  const { data: flag } = await ctx.service
    .from("app_flags").select("enabled").eq("key", "promotions_enabled").maybeSingle();

  const { data: bonuses } = await ctx.service
    .from("bonus_ledger").select("state, amount_cents");

  // ── Rows, not just totals ─────────────────────────────────────────────────
  // Grants were invisible: revokeGrant existed with zero callers, so a promotion could be
  // issued to a named person and never taken back. And bonus_ledger was three aggregate
  // tiles — no owner, no state per row, no action — which matters more now that it is the
  // mechanism behind the partial-capture fee-credit return.
  const { data: grants } = await ctx.service
    .from("promo_grants")
    .select("id, promotion_id, user_id, fee_bps, uses_allowed, uses_used, expires_at, revoked_at, revoked_reason, created_at")
    .order("created_at", { ascending: false })
    .limit(50);

  const { data: bonusRows } = await ctx.service
    .from("bonus_ledger")
    .select("id, user_id, amount_cents, delivery, state, reason, applied_booking_id, applied_at, created_at")
    .order("created_at", { ascending: false })
    .limit(50);

  const peopleIds = [...new Set([
    ...(grants ?? []).map((g) => g.user_id),
    ...(bonusRows ?? []).map((b) => b.user_id),
  ].filter(Boolean) as string[])];
  const people = peopleIds.length
    ? (await ctx.service.from("profiles").select("id, name, username").in("id", peopleIds)).data ?? []
    : [];
  const personById = new Map(people.map((p) => [p.id, p]));
  const who = (id: string | null) => {
    if (!id) return "—";
    const p = personById.get(id);
    return p?.name ?? p?.username ?? id.slice(0, 8);
  };
  const promoName = (id: string | null) =>
    (promos ?? []).find((p) => p.id === id)?.name ?? "—";

  const codesFor = (id: string) => (codes ?? []).filter((c) => c.promotion_id === id);
  const bonusBy = (state: string) =>
    (bonuses ?? []).filter((b) => b.state === state).reduce((s, b) => s + (b.amount_cents ?? 0), 0);

  return (
    <div>
      <h1 className="text-xl font-semibold text-[var(--ink)]">Promotions</h1>
      <p className="mt-1 text-sm text-[var(--muted)]">
        Reduced-fee campaigns and referral bonuses. Every one carries a budget ceiling
        enforced in the database — once it&rsquo;s spent the campaign stops, whether or
        not anyone is watching.
      </p>

      {flag && flag.enabled === false && (
        <p className="mt-4 rounded-lg border border-red-300 bg-red-50 px-4 py-2 text-sm text-red-900">
          <strong>All promotions are switched off</strong> at the{" "}
          <code>promotions_enabled</code> flag. No code redeems and no grant applies to a
          new booking. Bookings already pinned are unaffected.
        </p>
      )}

      <div className="mt-4 flex flex-wrap gap-3 text-sm">
        <div className="rounded-xl border border-[var(--line)] bg-white px-4 py-2">
          <div className="text-xs text-[var(--muted)]">Bonus owed (payable)</div>
          <div className="text-lg font-semibold">{money(bonusBy("payable"))}</div>
        </div>
        <div className="rounded-xl border border-[var(--line)] bg-white px-4 py-2">
          <div className="text-xs text-[var(--muted)]">Bonus accruing (pending)</div>
          <div className="text-lg font-semibold">{money(bonusBy("pending"))}</div>
        </div>
        <div className="rounded-xl border border-[var(--line)] bg-white px-4 py-2">
          <div className="text-xs text-[var(--muted)]">Bonus already applied</div>
          <div className="text-lg font-semibold">{money(bonusBy("applied"))}</div>
        </div>
      </div>

      <CreatePromotion />

      {error ? (
        <p className="mt-6 text-sm text-red-600">Could not load promotions: {error.message}</p>
      ) : !promos?.length ? (
        <p className="mt-6 text-sm text-[var(--muted)]">No promotions yet.</p>
      ) : (
        <div className="mt-6 overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b-2 border-[var(--ink)] text-left">
                <th className="px-3 py-2">Campaign</th>
                <th className="px-3 py-2">Benefit</th>
                <th className="px-3 py-2">Budget spent</th>
                <th className="px-3 py-2">Uses</th>
                <th className="px-3 py-2">Runs until</th>
                <th className="px-3 py-2">Codes</th>
                <th className="px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {promos.map((p) => {
                const pct = p.budget_cents ? Math.min(100, (p.spent_cents / p.budget_cents) * 100) : 0;
                const expired = p.ends_at ? Date.parse(p.ends_at) < Date.now() : false;
                const cs = codesFor(p.id);
                return (
                  <tr key={p.id} className="border-b border-[var(--line)] align-top">
                    <td className="px-3 py-2">
                      <div className="font-medium">{p.name}</div>
                      <div className="text-xs text-[var(--muted)]">{p.kind.replace("_", " ")}</div>
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {p.kind === "fee_override"
                        ? `${(p.fee_bps ?? 0) / 100}% fee · ${p.uses_allowed} gig(s) · students`
                        : p.kind === "poster_discount"
                          ? `${money(p.poster_discount_cents ?? 0)} off · posters`
                          : `${money(p.bonus_cents ?? 0)} per referral · students`}
                    </td>
                    <td className="px-3 py-2">
                      <div className="text-xs">
                        {money(p.spent_cents)} / {money(p.budget_cents)}
                      </div>
                      <div className="mt-1 h-1.5 w-32 rounded-full bg-[var(--surface)]">
                        <div
                          className={`h-1.5 rounded-full ${pct >= 100 ? "bg-red-500" : "bg-[var(--brand)]"}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {p.redemptions_used} / {p.max_redemptions}
                    </td>
                    <td className="px-3 py-2 text-xs text-[var(--muted)]">
                      {p.ends_at ? fmtDate(p.ends_at) : "no end date"}
                      {expired && p.status === "active" && (
                        <div className="text-[var(--muted)]">expired — no longer matching</div>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <div className="mb-1 font-mono text-[11px] text-[var(--muted)]">
                        {cs.slice(0, 3).map((c) => (
                          <div key={c.code}>
                            {c.code} <span className="opacity-60">{c.redemptions_used}/{c.max_redemptions}</span>
                          </div>
                        ))}
                        {cs.length > 3 && <div className="opacity-60">+{cs.length - 3} more</div>}
                        {cs.length === 0 && <div className="opacity-60">none</div>}
                      </div>
                      <MintCodes id={p.id} />
                    </td>
                    <td className="px-3 py-2">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${STATUS_CLASS[p.status] ?? ""}`}>
                        {p.status}
                      </span>
                      <div className="mt-1">
                        <StatusButtons id={p.id} status={p.status} />
                      </div>
                      <div className="mt-1">
                        <EditPromotion promo={p} />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="mt-3 text-xs text-[var(--muted)]">
            Ending or pausing a campaign never re-prices work already agreed — the rate
            was frozen onto each booking when it was made.
          </p>
        </div>
      )}

      {/* ── Grants ───────────────────────────────────────────────────────────
          Pausing a campaign stops NEW claims and does nothing about someone already
          holding a grant. This is the per-person lever, and until now it did not exist
          in the UI at all — revokeGrant was written, correct, and had zero callers. */}
      <h2 className="mt-8 text-lg font-semibold text-[var(--ink)]">Grants ({(grants ?? []).length})</h2>
      <p className="mt-1 text-xs text-[var(--muted)]">
        A grant is one person&apos;s claim on a campaign, with the benefit snapshotted at claim
        time. Revoking stops future uses; bookings already made with it keep the rate they were
        given.
      </p>
      {(grants ?? []).length === 0 ? (
        <p className="mt-3 text-sm text-[var(--muted)]">No grants issued.</p>
      ) : (
        <div className="mt-3 overflow-x-auto rounded-lg border border-[var(--line)]">
          <table className="w-full text-sm">
            <thead className="bg-[var(--surface)] text-left text-xs text-[var(--muted)]">
              <tr>
                <th className="px-3 py-2">Person</th>
                <th className="px-3 py-2">Campaign</th>
                <th className="px-3 py-2">Benefit</th>
                <th className="px-3 py-2">Uses</th>
                <th className="px-3 py-2">Expires</th>
                <th className="px-3 py-2 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {(grants ?? []).map((g) => (
                <tr key={g.id} className="border-t border-[var(--line)]">
                  <td className="px-3 py-2">{who(g.user_id)}</td>
                  <td className="px-3 py-2">{promoName(g.promotion_id)}</td>
                  <td className="px-3 py-2">
                    {g.fee_bps != null ? `${(g.fee_bps / 100).toFixed(2)}% fee` : "—"}
                  </td>
                  <td className="px-3 py-2">
                    {g.uses_used ?? 0}/{g.uses_allowed ?? "∞"}
                  </td>
                  <td className="px-3 py-2">{g.expires_at ? fmtDate(g.expires_at) : "—"}</td>
                  <td className="px-3 py-2 text-right">
                    {g.revoked_at ? (
                      <span className="text-xs text-[var(--muted)]" title={g.revoked_reason ?? ""}>
                        revoked {fmtDate(g.revoked_at)}
                      </span>
                    ) : (
                      <RevokeGrant grantId={g.id} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Referral ledger ──────────────────────────────────────────────────
          Was three aggregate tiles with no owner and no row. It is now also the mechanism
          behind the partial-capture fee-credit return, so an unexpected 'payable' row
          appearing after a capture is meaningful and needs to be visible. */}
      <h2 className="mt-8 text-lg font-semibold text-[var(--ink)]">Referral ledger ({(bonusRows ?? []).length})</h2>
      <p className="mt-1 text-xs text-[var(--muted)]">
        Bonuses vest on outcome and are delivered as a fee credit. A partial capture returns
        the portion the smaller fee could not absorb, so a row can go back to
        <span className="font-semibold"> payable</span> after being applied.
      </p>
      {(bonusRows ?? []).length === 0 ? (
        <p className="mt-3 text-sm text-[var(--muted)]">No bonuses accrued.</p>
      ) : (
        <div className="mt-3 overflow-x-auto rounded-lg border border-[var(--line)]">
          <table className="w-full text-sm">
            <thead className="bg-[var(--surface)] text-left text-xs text-[var(--muted)]">
              <tr>
                <th className="px-3 py-2">Earner</th>
                <th className="px-3 py-2">Amount</th>
                <th className="px-3 py-2">State</th>
                <th className="px-3 py-2">Delivery</th>
                <th className="px-3 py-2">Applied to</th>
                <th className="px-3 py-2">Reason</th>
              </tr>
            </thead>
            <tbody>
              {(bonusRows ?? []).map((b) => (
                <tr key={b.id} className="border-t border-[var(--line)]">
                  <td className="px-3 py-2">{who(b.user_id)}</td>
                  <td className="px-3 py-2">{money(b.amount_cents ?? 0)}</td>
                  <td className="px-3 py-2">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${STATUS_CLASS[b.state === "applied" ? "ended" : b.state === "payable" ? "active" : "draft"] ?? ""}`}>
                      {b.state}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-[var(--muted)]">{b.delivery}</td>
                  <td className="px-3 py-2 text-[var(--muted)]">
                    {b.applied_booking_id ? b.applied_booking_id.slice(0, 8) : "—"}
                  </td>
                  <td className="px-3 py-2 text-[var(--muted)]">{b.reason ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
