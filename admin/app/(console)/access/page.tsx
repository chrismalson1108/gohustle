import { requireAdminPage } from "@/lib/guard";
import { auditRead } from "@/lib/audit";
import { fmtDate } from "@/lib/format";
import { Section } from "@/lib/ui";
import { InviteForm, RevokeButton, OpenBetaControl } from "./AccessControls";

export const metadata = { title: "Beta access" };

const PAGE_SIZE = 100;

// beta_allowlist is the REAL signup gate — handle_new_user raises
// `signup_not_allowlisted` and rolls back the auth.users insert, so this is a true
// server-side control, not a client check. Until this page it was operable only by
// hand-writing SQL in the Supabase editor, which meant inviting a tester and
// re-closing the beta both required database credentials.
export default async function AccessPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const ctx = await requireAdminPage("support");
  const q = (await searchParams).q?.trim().toLowerCase() ?? "";
  await auditRead(ctx, "access.view", "beta_allowlist", undefined, q ? { q } : undefined);

  let query = ctx.service
    .from("beta_allowlist")
    .select("email, note, added_at", { count: "exact" })
    .neq("email", "*")
    .order("added_at", { ascending: false })
    .limit(PAGE_SIZE);
  if (q) query = query.ilike("email", `%${q}%`);

  const [listRes, openRes] = await Promise.all([
    query,
    ctx.service.from("beta_allowlist").select("email").eq("email", "*").maybeSingle(),
  ]);

  const isOpen = Boolean(openRes.data);
  const rows = listRes.data ?? [];
  const total = listRes.count ?? 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Beta access</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Who is allowed to create an account. Enforced in the database — a signup from an
          address that isn&apos;t allowed is refused server-side, not hidden in the UI.
        </p>
      </div>

      <Section title="Signup mode">
        <OpenBetaControl open={isOpen} isAdmin={ctx.role === "admin"} />
      </Section>

      <Section title="Invite testers">
        {isOpen && (
          <p className="mb-3 rounded-lg bg-[var(--surface)] px-3 py-2 text-xs text-[var(--muted)]">
            Signups are open to everyone right now, so the list below has no effect. It is
            still worth maintaining — closing the beta makes it live again immediately.
          </p>
        )}
        <InviteForm isAdmin={ctx.role === "admin"} />
      </Section>

      <Section
        title={`Invited (${total})`}
        right={
          <form method="GET" className="flex gap-2">
            <input
              type="search"
              name="q"
              defaultValue={q}
              placeholder="Search email…"
              className="rounded-lg border border-[var(--line)] px-3 py-1 text-xs"
            />
            <button type="submit" className="rounded-lg border border-[var(--line)] px-2.5 py-1 text-xs">
              Search
            </button>
          </form>
        }
      >
        {listRes.error && <p className="text-sm text-[var(--danger)]">Failed to load: {listRes.error.message}</p>}
        {rows.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">
            {q ? `No invited address matches “${q}”.` : "Nobody invited yet."}
          </p>
        ) : (
          <>
            <ul className="divide-y divide-[var(--line)]">
              {rows.map((r) => (
                <li key={r.email} className="flex flex-wrap items-center justify-between gap-3 py-2 first:pt-0">
                  <div className="min-w-0">
                    <span className="font-mono text-sm">{r.email}</span>
                    {r.note && <span className="ml-2 text-xs text-[var(--muted)]">{r.note}</span>}
                  </div>
                  <span className="flex items-center gap-3 text-xs text-[var(--muted)]">
                    {fmtDate(r.added_at)}
                    <RevokeButton email={r.email} isAdmin={ctx.role === "admin"} />
                  </span>
                </li>
              ))}
            </ul>
            {total > rows.length && (
              <p className="mt-3 text-xs text-[var(--muted)]">
                Showing the {rows.length} most recent of {total}. Use search to find a specific address.
              </p>
            )}
          </>
        )}
      </Section>
    </div>
  );
}
