import { requireAdminPage } from "@/lib/guard";
import { fmtDate } from "@/lib/format";
import { SetRate, TierToggle, GrantDirect } from "./PricingControls";

export const metadata = { title: "Pricing" };

// The standing take rate had no UI at all — it was a table only reachable by hand-
// written SQL, which is not something you want to be doing to the number that decides
// your revenue. This is that control, plus the two things adjacent to it: the standing
// loyalty ladder, and issuing a promotion to named people without a public code.
export default async function PricingPage() {
  const ctx = await requireAdminPage("admin");

  const { data: rates } = await ctx.service
    .from("platform_rates")
    .select("id, fee_bps, effective_from, note, created_at")
    .order("effective_from", { ascending: false })
    .limit(20);

  const { data: current } = await ctx.service.rpc("fee_bps_at");
  const { data: tiers } = await ctx.service
    .from("fee_tiers").select("id, name, min_completed, fee_bps, enabled, note").order("min_completed");
  const { data: promos } = await ctx.service
    .from("promotions").select("id, name").in("status", ["active", "draft"]).order("created_at", { ascending: false });

  const now = Date.now();
  const pending = (rates ?? []).filter((r) => Date.parse(r.effective_from) > now);
  const cur = Number(current ?? 1000);

  return (
    <div>
      <h1 className="text-xl font-semibold text-[var(--ink)]">Pricing</h1>
      <p className="mt-1 text-sm text-[var(--muted)]">
        The standing platform fee, the loyalty ladder, and direct grants. Every booking
        freezes its rate when it&rsquo;s made — changing anything here only affects
        bookings made afterwards.
      </p>

      <div className="mt-5 rounded-xl border border-[var(--line)] bg-white p-4">
        <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Standard fee</div>
        <div className="mt-1 text-3xl font-semibold">{cur / 100}%</div>
        <p className="mt-1 text-xs text-[var(--muted)]">
          Taken from the earner&rsquo;s payout. A $100 gig at this rate pays the earner{" "}
          <strong>${((10000 - Math.max(Math.trunc((10000 * cur + 5000) / 10000), Math.ceil(10000 * 0.029) + 55)) / 100).toFixed(2)}</strong>.
        </p>
        {pending.length > 0 && (
          <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
            <strong>Scheduled change:</strong> {pending[pending.length - 1].fee_bps / 100}% from{" "}
            {fmtDate(pending[pending.length - 1].effective_from)}.
          </p>
        )}
        <SetRate current={cur} />
      </div>

      <h2 className="mt-8 text-base font-semibold text-[var(--ink)]">Loyalty ladder</h2>
      <p className="mt-1 text-sm text-[var(--muted)]">
        Standing policy, not a campaign: no budget, no end date. Counts <strong>verified</strong>{" "}
        gigs only — anything a user can inflate themselves would be a tier they could
        self-assign. A booking takes the lowest of standard, tier and promotion; benefits
        never stack.
      </p>
      <table className="mt-3 w-full border-collapse text-sm">
        <thead>
          <tr className="border-b-2 border-[var(--ink)] text-left">
            <th className="px-3 py-2">Tier</th>
            <th className="px-3 py-2">After</th>
            <th className="px-3 py-2">Fee</th>
            <th className="px-3 py-2">Live</th>
          </tr>
        </thead>
        <tbody>
          {(tiers ?? []).map((t) => (
            <tr key={t.id} className="border-b border-[var(--line)] align-top">
              <td className="px-3 py-2">
                <div className="font-medium">{t.name}</div>
                {t.note && <div className="text-xs text-[var(--muted)]">{t.note}</div>}
              </td>
              <td className="px-3 py-2 text-xs">{t.min_completed} verified gigs</td>
              <td className="px-3 py-2 text-xs">{t.fee_bps / 100}%</td>
              <td className="px-3 py-2"><TierToggle id={t.id} enabled={t.enabled} /></td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 className="mt-8 text-base font-semibold text-[var(--ink)]">Grant to specific people</h2>
      <p className="mt-1 text-sm text-[var(--muted)]">
        For win-back and VIP offers. No public code — an offer aimed at lapsed users that
        leaks to active ones is margin given away for behaviour you already had.
      </p>
      <GrantDirect promos={promos ?? []} />

      <h2 className="mt-8 text-base font-semibold text-[var(--ink)]">Rate history</h2>
      <table className="mt-3 w-full border-collapse text-sm">
        <thead>
          <tr className="border-b-2 border-[var(--ink)] text-left">
            <th className="px-3 py-2">Rate</th>
            <th className="px-3 py-2">Effective from</th>
            <th className="px-3 py-2">Why</th>
          </tr>
        </thead>
        <tbody>
          {(rates ?? []).map((r) => (
            <tr key={r.id} className="border-b border-[var(--line)]">
              <td className="px-3 py-2 font-medium">{r.fee_bps / 100}%</td>
              <td className="px-3 py-2 text-xs text-[var(--muted)]">
                {fmtDate(r.effective_from)}
                {Date.parse(r.effective_from) > now && <span className="ml-1 text-amber-700">scheduled</span>}
              </td>
              <td className="px-3 py-2 text-xs text-[var(--muted)]">{r.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-[var(--muted)]">
        Append-only. Rates are never edited or deleted, so &ldquo;what did we charge on
        the 3rd?&rdquo; always has an answer.
      </p>
    </div>
  );
}
