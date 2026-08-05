import { requireAdminPage } from "@/lib/guard";
import { auditRead } from "@/lib/audit";
import { fmtDate } from "@/lib/format";
import { Section, Pill } from "@/lib/ui";
import FlagToggle from "./FlagToggle";

export const metadata = { title: "Kill switches" };

// Before this page, the entire runtime configuration of the product was a single
// '*' row in beta_allowlist, edited by hand in the Supabase SQL editor. There was no
// way to pause payments during a Stripe incident, pause posting during a spam wave,
// or switch off the Hustlr AI assistant — which can post gigs and book work on a
// user's behalf, the widest blast radius in the product.
//
// Each flag defaults to ENABLED for an unknown key (see public.app_flag), so a flag
// that has never been created behaves exactly like the code did before it existed.
export default async function FlagsPage() {
  const ctx = await requireAdminPage("support");
  await auditRead(ctx, "flags.view", "flags");

  const { data: flags, error } = await ctx.service
    .from("app_flags")
    .select("key, enabled, note, updated_by, updated_at")
    .order("key");

  const adminIds = [...new Set((flags ?? []).map((f) => f.updated_by).filter(Boolean))] as string[];
  const admins = adminIds.length
    ? (await ctx.service.from("profiles").select("id, name").in("id", adminIds)).data ?? []
    : [];
  const nameOf = new Map(admins.map((a) => [a.id, a.name]));

  const off = (flags ?? []).filter((f) => !f.enabled);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Kill switches</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Pause a feature platform-wide without a deploy. Changes take effect on the next request —
          there is no cache in front of these.
        </p>
      </div>

      {error && <p className="text-sm text-[var(--danger)]">Failed to load: {error.message}</p>}

      {off.length > 0 && (
        <div className="rounded-xl border border-[var(--danger)] bg-red-50 px-4 py-3 text-sm">
          <strong>{off.length} feature{off.length === 1 ? " is" : "s are"} currently paused:</strong>{" "}
          {off.map((f) => f.key).join(", ")}. Users hitting these get a &ldquo;temporarily
          unavailable&rdquo; message.
        </div>
      )}

      <Section title={`Flags (${flags?.length ?? 0})`}>
        {(flags ?? []).length === 0 ? (
          <p className="text-sm text-[var(--muted)]">
            No flags seeded. Run the 20260804010000_phase1_admin_ops migration.
          </p>
        ) : (
          <ul className="divide-y divide-[var(--line)]">
            {(flags ?? []).map((f) => (
              <li key={f.key} className="flex flex-wrap items-start justify-between gap-4 py-3 first:pt-0 last:pb-0">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm font-medium">{f.key}</span>
                    {f.enabled ? <Pill tone="green">on</Pill> : <Pill tone="red">paused</Pill>}
                  </div>
                  {f.note && <p className="mt-1 text-sm text-[var(--muted)]">{f.note}</p>}
                  <p className="mt-1 text-xs text-[var(--muted)]">
                    {f.updated_by
                      ? `Last changed by ${nameOf.get(f.updated_by) ?? f.updated_by.slice(0, 8)} · ${fmtDate(f.updated_at)}`
                      : `Never changed · seeded ${fmtDate(f.updated_at)}`}
                  </p>
                </div>
                <FlagToggle flagKey={f.key} enabled={f.enabled} isAdmin={ctx.role === "admin"} />
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Where each flag is enforced">
        <ul className="space-y-1 text-sm text-[var(--muted)]">
          <li><code className="font-mono text-xs">signups_enabled</code> — <code className="font-mono text-xs">handle_new_user</code> trigger; refuses the auth insert outright.</li>
          <li><code className="font-mono text-xs">posting_enabled</code> — <code className="font-mono text-xs">guard_posting_flag</code> trigger on <code className="font-mono text-xs">jobs</code>. Existing gigs stay bookable.</li>
          <li><code className="font-mono text-xs">payments_enabled</code> — <code className="font-mono text-xs">stripe-create-payment-intent</code>. Blocks NEW escrow holds only; bookings already confirmed still capture, so nobody mid-gig is stranded.</li>
          <li><code className="font-mono text-xs">tips_enabled</code> — <code className="font-mono text-xs">stripe-tip</code>.</li>
          <li><code className="font-mono text-xs">assistant_enabled</code> — <code className="font-mono text-xs">assistant</code>. The rest of the app is unaffected.</li>
        </ul>
      </Section>
    </div>
  );
}
