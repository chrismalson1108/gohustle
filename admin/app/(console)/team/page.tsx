import { requireAdminPage } from "@/lib/guard";
import { auditRead } from "@/lib/audit";
import { fmtDate } from "@/lib/format";
import { Section, Pill } from "@/lib/ui";
import { AddMemberForm, MemberControls } from "./TeamControls";

export const metadata = { title: "Team" };

interface Member {
  user_id: string;
  email: string | null;
  name: string | null;
  role: string;
  status: string;
  mfa_enrolled_at: string | null;
  // Every VERIFIED factor, oldest first. One date could not tell "they enrolled and
  // forgot where" from "somebody enrolled beside them" — those read identically and
  // mean opposite things. The friendly name says which surface it came from:
  // 'GoHustlr' is the app or web, 'GoHustlr Admin' is this console.
  mfa_factor_count: number;
  mfa_factors: { name: string | null; created_at: string }[];
  created_at: string;
  disabled_at: string | null;
  note: string | null;
}

function factorOrigin(name: string | null): string {
  if (name === "GoHustlr Admin") return "set up on this console";
  if (name === "GoHustlr") return "set up in the app or on the website";
  return name ? `“${name}”` : "unnamed";
}

// admin_users used to be seeded by hand in the SQL editor, and users/[id]/actions.ts
// deliberately refuses to act on a fellow admin — so onboarding a helper or revoking
// a departing teammate both required Supabase database credentials. That is the wrong
// dependency for an offboarding, and it is what made the MFA enrolment window a
// recurring exposure rather than a one-time one.
export default async function TeamPage() {
  const ctx = await requireAdminPage("admin");
  await auditRead(ctx, "team.view", "admin_users");

  const { data, error } = await ctx.service.rpc("admin_team_list");
  const members = (data ?? []) as Member[];
  const pending = members.filter((m) => m.status === "pending");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Team</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Who can reach this console. <strong>admin</strong> = full, including money and
          suspensions. <strong>support</strong> = read-only plus the ticket queue.
        </p>
      </div>

      {error && <p className="text-sm text-[var(--danger)]">Failed to load: {error.message}</p>}

      {pending.length > 0 && (
        <div className="rounded-xl border border-[var(--line)] bg-[var(--surface)] px-4 py-3 text-sm">
          <strong>{pending.length} pending {pending.length === 1 ? "member" : "members"}.</strong>{" "}
          A pending row grants nothing. Activate only after the person has enrolled their
          authenticator and you have confirmed the enrolment time with them directly — the
          sign-in page will enrol a factor for whoever knows the password, so that
          confirmation is the actual control.
        </div>
      )}

      <Section title="Add someone">
        <AddMemberForm isAdmin={ctx.role === "admin"} />
        <p className="mt-2 text-xs text-[var(--muted)]">
          They must already have a GoHustlr account — this grants console access to an
          existing account, it never creates one.
        </p>
      </Section>

      <Section title={`Members (${members.length})`}>
        {members.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">Nobody yet.</p>
        ) : (
          <ul className="divide-y divide-[var(--line)]">
            {members.map((m) => (
              <li key={m.user_id} className="flex flex-wrap items-start justify-between gap-4 py-3 first:pt-0 last:pb-0">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{m.name ?? m.email ?? m.user_id.slice(0, 8)}</span>
                    <Pill tone={m.role === "admin" ? "amber" : "gray"}>{m.role}</Pill>
                    {m.status === "active" && <Pill tone="green">active</Pill>}
                    {m.status === "pending" && <Pill tone="amber">pending</Pill>}
                    {m.status === "disabled" && <Pill tone="red">revoked</Pill>}
                  </div>
                  <p className="mt-0.5 text-sm text-[var(--muted)]">{m.email ?? "—"}</p>
                  <p className="mt-1 text-xs text-[var(--muted)]">
                    added {fmtDate(m.created_at)}
                    {" · "}
                    {m.mfa_factor_count === 0
                      ? "no authenticator enrolled yet"
                      : `${m.mfa_factor_count} authenticator${m.mfa_factor_count === 1 ? "" : "s"}`}
                    {m.disabled_at ? ` · revoked ${fmtDate(m.disabled_at)}` : ""}
                    {m.note ? ` · ${m.note}` : ""}
                  </p>
                  {/* Itemised, because the count alone still cannot say WHERE a factor
                      came from — and the pending→active decision turns on exactly that. */}
                  {m.mfa_factors.length > 0 && (
                    <ul className="mt-1 space-y-0.5 text-xs text-[var(--muted)]">
                      {m.mfa_factors.map((f, i) => (
                        <li key={`${f.created_at}-${i}`}>
                          ↳ {factorOrigin(f.name)}, {fmtDate(f.created_at)}
                        </li>
                      ))}
                    </ul>
                  )}
                  {m.mfa_factor_count > 1 && (
                    <p className="mt-1 text-xs font-semibold text-[var(--warn)]">
                      More than one authenticator on this account. Only one person should
                      hold one — confirm every entry above with them before activating,
                      and reset if any is unaccounted for.
                    </p>
                  )}
                </div>
                <MemberControls
                  userId={m.user_id}
                  email={m.email ?? m.user_id.slice(0, 8)}
                  role={m.role}
                  status={m.status}
                  mfaEnrolledAt={m.mfa_enrolled_at}
                  mfaFactorCount={m.mfa_factor_count}
                  isSelf={m.user_id === ctx.user.id}
                  isAdmin={ctx.role === "admin"}
                />
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Why access starts as pending">
        <p className="text-sm text-[var(--muted)]">
          The sign-in flow enrols a fresh TOTP factor for anyone who presents valid
          credentials on an account that has none. Access used to be granted the moment the
          membership row existed, so between adding someone and their first sign-in, whoever
          knew that password — including via reuse from the consumer app, which shares this
          auth pool — could enrol their own authenticator and walk into a service-role
          console that issues refunds. A pending row makes winning that race worthless.
        </p>
      </Section>
    </div>
  );
}
