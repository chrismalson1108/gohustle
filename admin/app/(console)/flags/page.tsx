import { requireAdminPage } from "@/lib/guard";
import { auditRead } from "@/lib/audit";
import { fmtDate } from "@/lib/format";
import { Section, Pill } from "@/lib/ui";
import FlagToggle from "./FlagToggle";
import StripeModeControl from "./StripeModeControl";
import { FLAG_GUIDE, guideFor, KIND_LABEL, type FlagKind } from "./guide";

export const metadata = { title: "Kill switches" };

// Before this page, the entire runtime configuration of the product was a single
// '*' row in beta_allowlist, edited by hand in the Supabase SQL editor. There was no
// way to pause payments during a Stripe incident, pause posting during a spam wave,
// or switch off the Hustlr AI assistant — which can post gigs and book work on a
// user's behalf, the widest blast radius in the product.
//
// Each flag defaults to ENABLED for an unknown key (see public.app_flag), so a flag
// that has never been created behaves exactly like the code did before it existed.
//
// app_flags now holds three DIFFERENT kinds of row and this page used to render them
// identically — see guide.ts for why that mattered, and for the per-key copy every
// section below reads. The short version: pressing "Turn off" on safety_alert took
// nothing away from any user, it stopped a human being paged when a safety report
// landed, and the console said the opposite.
export default async function FlagsPage() {
  const ctx = await requireAdminPage("support");
  await auditRead(ctx, "flags.view", "flags");

  const { data: flags, error } = await ctx.service
    .from("app_flags")
    // disabled_until / disabled_reason are the whole point of an alert-channel mute
    // being bounded (20260814100000) and the page never showed either; `value` is what
    // a config row actually carries.
    .select("key, enabled, value, note, disabled_until, disabled_reason, updated_by, updated_at")
    .order("key");

  const adminIds = [...new Set((flags ?? []).map((f) => f.updated_by).filter(Boolean))] as string[];
  const admins = adminIds.length
    ? (await ctx.service.from("profiles").select("id, name").in("id", adminIds)).data ?? []
    : [];
  const nameOf = new Map(admins.map((a) => [a.id, a.name]));

  type Row = NonNullable<typeof flags>[number];
  const rows: Row[] = flags ?? [];
  const byKind = (k: FlagKind) => rows.filter((f) => guideFor(f.key).kind === k);

  // A row seeded OFF on purpose is not an incident. bonus_cash_payout_enabled has been
  // off since it was created and the old banner reported it as a paused feature every
  // single day, which is how a banner stops being read.
  const paused = byKind("kill_switch").filter((f) => !f.enabled && !guideFor(f.key).offByDefault);
  const dark = byKind("alert_channel").filter((f) => !f.enabled);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Kill switches</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Pause a feature platform-wide without a deploy. Changes take effect on the next request —
          there is no cache in front of these. Not every row here is a feature switch: read the
          section a row is in before you flip it.
        </p>
      </div>

      {error && <p className="text-sm text-[var(--danger)]">Failed to load: {error.message}</p>}

      {paused.length > 0 && (
        <div className="rounded-xl border border-[var(--danger)] bg-red-50 px-4 py-3 text-sm">
          <strong>{paused.length} feature{paused.length === 1 ? " is" : "s are"} currently paused:</strong>{" "}
          {paused.map((f) => f.key).join(", ")}. Users hitting these get a &ldquo;temporarily
          unavailable&rdquo; message. These do <strong>not</strong> come back on a timer.
        </div>
      )}

      {dark.length > 0 && (
        <div className="rounded-xl border border-[var(--danger)] bg-red-50 px-4 py-3 text-sm">
          <strong>Paging is OFF for {dark.map((f) => f.key).join(", ")}.</strong> Users notice
          nothing and the board stays green — you are simply not being told. Restores automatically
          {dark[0]?.disabled_until ? ` at ${fmtDate(dark[0].disabled_until)}` : " within 24 hours"}.
        </div>
      )}

      {(["kill_switch", "alert_channel", "config"] as FlagKind[]).map((kind) => {
        const group = byKind(kind);
        if (group.length === 0) return null;
        return (
          <Section key={kind} title={`${KIND_LABEL[kind]} (${group.length})`}>
            {kind === "alert_channel" && (
              <p className="mb-3 text-sm text-[var(--muted)]">
                These change nothing for users. Turning one off stops a human being told —
                the failure mode that left a safety trigger dead for four weeks in July. A mute
                is bounded: it expires by itself after 24 hours, and it needs a written reason.
              </p>
            )}
            {kind === "config" && (
              <p className="mb-3 text-sm text-[var(--muted)]">
                These rows carry their payload in <code className="font-mono text-xs">value</code>.
                Their <code className="font-mono text-xs">enabled</code> bit is read by nothing, so
                there is deliberately no on/off button here — a switch that controls nothing is
                worse than no switch at all.
              </p>
            )}
            <ul className="divide-y divide-[var(--line)]">
              {group.map((f) => {
                const g = guideFor(f.key);
                const value = (f.value ?? {}) as Record<string, unknown>;
                const payload = g.valueKey ? value[g.valueKey] : undefined;
                return (
                  <li
                    key={f.key}
                    className="flex flex-wrap items-start justify-between gap-4 py-3 first:pt-0 last:pb-0"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm font-medium">{f.key}</span>
                        {kind === "config" ? (
                          <Pill tone="gray">
                            {g.valueKey}: {payload === undefined || payload === null ? "unset" : String(payload)}
                          </Pill>
                        ) : f.enabled ? (
                          <Pill tone="green">{kind === "alert_channel" ? "paging" : "on"}</Pill>
                        ) : (
                          <Pill tone="red">{kind === "alert_channel" ? "muted" : "paused"}</Pill>
                        )}
                        {g.offByDefault && f.enabled === false && (
                          <Pill tone="gray">off by design</Pill>
                        )}
                      </div>
                      {f.note && <p className="mt-1 text-sm text-[var(--muted)]">{f.note}</p>}
                      {!f.enabled && kind !== "config" && (
                        <p className="mt-1 text-sm text-[var(--danger)]">{g.offMeans}</p>
                      )}
                      {!f.enabled && f.disabled_reason && (
                        <p className="mt-1 text-xs text-[var(--muted)]">
                          Reason given: {f.disabled_reason}
                        </p>
                      )}
                      {!f.enabled && f.disabled_until && (
                        <p className="mt-1 text-xs text-[var(--muted)]">
                          Switches itself back on at {fmtDate(f.disabled_until)}.
                        </p>
                      )}
                      {g.valueEditedBy && (
                        <p className="mt-1 text-xs text-[var(--muted)]">
                          Changed by {g.valueEditedBy}
                        </p>
                      )}
                      <p className="mt-1 text-xs text-[var(--muted)]">
                        {f.updated_by
                          ? `Last changed by ${nameOf.get(f.updated_by) ?? f.updated_by.slice(0, 8)} · ${fmtDate(f.updated_at)}`
                          : `Never changed · seeded ${fmtDate(f.updated_at)}`}
                      </p>
                    </div>
                    {kind === "config" ? (
                      f.key === "stripe_mode" ? (
                        <StripeModeControl
                          mode={typeof payload === "string" ? payload : "test"}
                          isAdmin={ctx.role === "admin"}
                        />
                      ) : (
                        <span className="text-xs text-[var(--muted)]">not a switch</span>
                      )
                    ) : (
                      <FlagToggle flagKey={f.key} enabled={f.enabled} isAdmin={ctx.role === "admin"} />
                    )}
                  </li>
                );
              })}
            </ul>
          </Section>
        );
      })}

      {/*
        Rendered FROM guide.ts rather than hand-written, which is the fix for the second
        half of this defect: the list named five keys and app_flags held ten, so the three
        rows whose effect is least obvious were the three the console never explained.
        __tests__/flagsConsoleDescribesEveryKey.test.js fails if a seeded key has no entry.
      */}
      <Section title="Where each flag is enforced">
        <ul className="space-y-1 text-sm text-[var(--muted)]">
          {Object.entries(FLAG_GUIDE).map(([key, g]) => (
            <li key={key}>
              <code className="font-mono text-xs">{key}</code> — {g.enforcedAt}
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
