import Link from "next/link";
import { requireAdminPage, roleSatisfies } from "@/lib/guard";
import { auditRead } from "@/lib/audit";
import { fmtDate } from "@/lib/format";
import { Section, Pill } from "@/lib/ui";
import { InviteCohort, ExportButton, DeleteEntry } from "./WaitlistControls";

export const metadata = { title: "Waitlist" };

const PAGE_SIZE = 100;

type Tab = "confirmed" | "pending" | "invited" | "unsubscribed";
const TABS: { id: Tab; label: string }[] = [
  { id: "confirmed", label: "Confirmed" },
  { id: "pending", label: "Unconfirmed" },
  { id: "invited", label: "Invited" },
  { id: "unsubscribed", label: "Unsubscribed" },
];

// Every predicate is applied in the QUERY, never in JavaScript over a fetched page.
// That is the /support lesson, and it is not a performance point: filtering a 200-row
// window in JS drops exactly the people who have been waiting longest and under-counts
// every badge at the same time.
function scope<T extends { is: (c: string, v: null) => T; not: (c: string, o: string, v: null) => T }>(q: T, tab: Tab): T {
  switch (tab) {
    case "confirmed":
      return q.not("confirmed_at", "is", null).is("unsubscribed_at", null).is("invited_at", null);
    case "pending":
      return q.is("confirmed_at", null).is("unsubscribed_at", null);
    case "invited":
      return q.not("invited_at", "is", null).is("unsubscribed_at", null);
    case "unsubscribed":
      return q.not("unsubscribed_at", "is", null);
  }
}

export default async function WaitlistPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; q?: string }>;
}) {
  // READ is admin: this table is a list of people who are not users, have accepted no
  // terms, and can be mailed. It is the console's highest-value export and there is no
  // support-tier task that needs it.
  const ctx = await requireAdminPage("admin");
  const sp = await searchParams;
  const tab: Tab = (TABS.find((t) => t.id === sp.tab)?.id ?? "confirmed") as Tab;
  const q = sp.q?.trim().toLowerCase() ?? "";
  await auditRead(ctx, "waitlist.view", "waitlist", undefined, { tab, ...(q ? { q } : {}) });

  const cols =
    "id, email, role_intent, in_launch_area, source, confirmed_at, unsubscribed_at, invited_at, invite_wave, email_sent_count, created_at";

  let listQ = ctx.service
    .from("waitlist")
    .select(cols, { count: "exact" })
    .order("created_at", { ascending: true })
    .range(0, PAGE_SIZE - 1);
  listQ = scope(listQ as never, tab) as never;
  // EXACT match on the normalised address, never a bare .ilike — '%' and '_' are legal
  // in an email, so a pattern built from user input silently widens the read.
  if (q) listQ = listQ.eq("email", q);

  const countQ = (t: Tab) =>
    scope(
      ctx.service.from("waitlist").select("id", { count: "exact", head: true }) as never,
      t,
    ) as unknown as Promise<{ count: number | null }>;

  // The cohort card, and the only number that says whether launch day is a marketplace
  // or 200 people opening an empty app: how the confirmed, uninvited, in-area list
  // splits between people who want to work and people who want to hire.
  const cohortQ = ctx.service
    .from("waitlist")
    .select("role_intent, in_launch_area")
    .not("confirmed_at", "is", null)
    .is("unsubscribed_at", null)
    .is("invited_at", null)
    .limit(5000);

  const [listRes, cConfirmed, cPending, cInvited, cUnsub, cohortRes, starRes] = await Promise.all([
    listQ,
    countQ("confirmed"),
    countQ("pending"),
    countQ("invited"),
    countQ("unsubscribed"),
    cohortQ,
    ctx.service.from("beta_allowlist").select("email").eq("email", "*").maybeSingle(),
  ]);

  const rows = (listRes.data ?? []) as unknown as {
    id: string;
    email: string;
    role_intent: string;
    in_launch_area: boolean | null;
    source: string | null;
    confirmed_at: string | null;
    unsubscribed_at: string | null;
    invited_at: string | null;
    invite_wave: string | null;
    email_sent_count: number;
    created_at: string;
  }[];

  const counts: Record<Tab, number> = {
    confirmed: cConfirmed.count ?? 0,
    pending: cPending.count ?? 0,
    invited: cInvited.count ?? 0,
    unsubscribed: cUnsub.count ?? 0,
  };

  const cohort = (cohortRes.data ?? []) as { role_intent: string; in_launch_area: boolean | null }[];
  const tally = (role: string, local?: boolean) =>
    cohort.filter((c) => c.role_intent === role && (local === undefined || c.in_launch_area === local)).length;

  const signupsOpen = Boolean(starRes.data);
  // Authority is computed from the tier the ACTIONS accept, not from an equality check
  // on the role — the mismatch that let trust operators read /moderation and act on
  // nothing. Every action in this file's actions.ts is requireFreshAdmin("admin").
  const canAct = roleSatisfies(ctx.role, "admin");

  // The invite list is exactly the invitable predicate, which is also the export's
  // server-side scope. Two surfaces, one definition of "who can be invited".
  const invitable = tab === "confirmed" ? rows : [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Waitlist</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          People who asked to be told when Hustlr opens. They have no account and have accepted
          no terms — the only thing we may do with this list is send the launch email they asked
          for.
        </p>
      </div>

      {signupsOpen && (
        <div className="rounded-xl border border-[var(--line)] bg-[var(--surface)] px-4 py-3 text-sm">
          <strong className="font-semibold">Signups are open to everyone right now.</strong>{" "}
          <span className="text-[var(--muted)]">
            beta_allowlist holds a <code>*</code> row, so anyone can create an account without an
            invite — inviting from here allowlists them, but grants nothing they did not already
            have. Close the beta in{" "}
            <Link href="/access" className="text-[var(--brand)] hover:underline">
              Access
            </Link>{" "}
            to make waves real.
          </span>
        </div>
      )}

      <Section title="Launch cohort — confirmed and not yet invited">
        {cohort.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">Nobody has confirmed yet.</p>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { label: "Want to work", n: tally("earn"), sub: `${tally("earn", true)} in the launch area` },
              { label: "Need help", n: tally("post"), sub: `${tally("post", true)} in the launch area` },
              { label: "Both", n: tally("both"), sub: `${tally("both", true)} in the launch area` },
              {
                label: "Ratio",
                n: tally("post") + tally("both") === 0 ? "—" : (
                  ((tally("earn") + tally("both")) / (tally("post") + tally("both"))).toFixed(1) + ":1"
                ),
                sub: "workers per poster",
              },
            ].map((c) => (
              <div key={c.label} className="rounded-lg border border-[var(--line)] p-3">
                <div className="text-2xl font-semibold">{c.n}</div>
                <div className="text-xs font-medium">{c.label}</div>
                <div className="mt-0.5 text-xs text-[var(--muted)]">{c.sub}</div>
              </div>
            ))}
          </div>
        )}
        {/* A two-sided marketplace that launches with only one side dies quietly. This
            sentence is the reason the cohort card exists at all. */}
        <p className="mt-3 text-xs text-[var(--muted)]">
          Invite in balanced waves, not signup order. A wave of 50 earners and 3 posters produces
          47 people who open an empty app once.
        </p>
      </Section>

      <Section title="Invite a wave">
        <InviteCohort
          rows={invitable.map((r) => ({
            id: r.id,
            email: r.email,
            role_intent: r.role_intent,
            in_launch_area: r.in_launch_area,
          }))}
          canInvite={canAct}
        />
        {tab !== "confirmed" && (
          <p className="mt-2 text-xs text-[var(--muted)]">
            Switch to the Confirmed tab to pick a wave — those are the people who verified their
            address and have not been invited yet.
          </p>
        )}
      </Section>

      <Section title="Export">
        <ExportButton canExport={canAct} />
        <p className="mt-2 text-xs text-[var(--muted)]">
          Opted-out addresses are excluded server-side in every scope. Anything you send from your
          mail tool needs an unsubscribe link and a postal address — CAN-SPAM applies to the
          launch email the same way it applies to the confirmation one.
        </p>
      </Section>

      <Section
        title={`${TABS.find((t) => t.id === tab)?.label} (${counts[tab]})`}
        right={
          <form method="GET" className="flex gap-2">
            <input type="hidden" name="tab" value={tab} />
            <input
              name="q"
              defaultValue={q}
              placeholder="exact email"
              className="rounded-lg border border-[var(--line)] px-3 py-1 text-sm"
            />
            <button className="rounded-lg border border-[var(--line)] px-3 py-1 text-sm">Find</button>
          </form>
        }
      >
        <div className="mb-3 flex flex-wrap gap-2 text-sm">
          {TABS.map((t) => (
            <Link
              key={t.id}
              href={`/waitlist?tab=${t.id}`}
              className={`rounded-lg px-3 py-1.5 ${
                tab === t.id ? "bg-[var(--brand)] text-white" : "border border-[var(--line)]"
              }`}
            >
              {t.label} ({counts[t.id]})
            </Link>
          ))}
        </div>

        {listRes.error && (
          <p className="text-sm text-[var(--danger)]">Failed to load: {listRes.error.message}</p>
        )}

        {rows.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">Nothing here.</p>
        ) : (
          <ul className="text-sm">
            {rows.map((r) => (
              <li
                key={r.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-[var(--line)] py-2 first:border-0"
              >
                <span className="min-w-0 flex-1 truncate font-medium">{r.email}</span>
                <Pill tone={r.role_intent === "earn" ? "blue" : r.role_intent === "post" ? "amber" : "gray"}>
                  {r.role_intent === "earn" ? "wants to work" : r.role_intent === "post" ? "needs help" : "both"}
                </Pill>
                {r.in_launch_area === true && <Pill tone="green">launch area</Pill>}
                {r.unsubscribed_at ? (
                  <Pill tone="red">unsubscribed</Pill>
                ) : r.invited_at ? (
                  <Pill tone="green">invited{r.invite_wave ? ` · ${r.invite_wave}` : ""}</Pill>
                ) : r.confirmed_at ? (
                  <Pill tone="blue">confirmed</Pill>
                ) : (
                  <Pill tone="amber">unconfirmed</Pill>
                )}
                {r.source && <span className="text-xs text-[var(--muted)]">via {r.source}</span>}
                <span className="text-xs text-[var(--muted)]">{fmtDate(r.created_at)}</span>
                <DeleteEntry id={r.id} email={r.email} canDelete={canAct} />
              </li>
            ))}
          </ul>
        )}
        {counts[tab] > rows.length && (
          <p className="mt-3 text-xs text-[var(--muted)]">
            Showing the {rows.length} oldest of {counts[tab]}. Invite from the top — that is the
            order people joined.
          </p>
        )}
      </Section>
    </div>
  );
}
