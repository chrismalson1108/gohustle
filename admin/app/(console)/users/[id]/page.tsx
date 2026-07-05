import { notFound } from "next/navigation";
import Link from "next/link";
import { requireAdminPage } from "@/lib/guard";
import { audit } from "@/lib/audit";
import { fmtCents, fmtDate } from "@/lib/format";
import ActionsPanel from "./ActionsPanel";
import NoteForm from "./NoteForm";

export const metadata = { title: "User detail" };

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-[var(--line)] bg-white p-5">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--muted)]">{title}</h2>
      {children}
    </section>
  );
}

function Pill({ tone, children }: { tone: "red" | "green" | "gray" | "amber"; children: React.ReactNode }) {
  const tones = {
    red: "bg-red-100 text-red-700",
    green: "bg-emerald-100 text-emerald-700",
    gray: "bg-gray-100 text-gray-600",
    amber: "bg-amber-100 text-amber-700",
  } as const;
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${tones[tone]}`}>{children}</span>;
}

export default async function UserDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAdminPage("support");
  const { id } = await params;

  const { data: profile } = await ctx.service.from("profiles").select("*").eq("id", id).maybeSingle();
  if (!profile) notFound();

  const [
    authUserRes,
    legalRes,
    earnerBookingsRes,
    postedJobsRes,
    reportsByRes,
    reportsAgainstRes,
    reviewsRes,
    notesRes,
    loginHistoryRes,
  ] = await Promise.all([
    ctx.service.auth.admin.getUserById(id),
    ctx.service
      .from("legal_acceptances")
      .select("slug, version, accepted_at")
      .eq("user_id", id)
      .order("accepted_at", { ascending: false })
      .limit(20),
    ctx.service
      .from("bookings")
      .select("id, status, created_at, slot_label, tip_amount, earner_done, poster_done, jobs(id, title)")
      .eq("earner_id", id)
      .order("created_at", { ascending: false })
      .limit(20),
    ctx.service
      .from("jobs")
      .select("id, title, status, created_at, pay")
      .eq("poster_id", id)
      .order("created_at", { ascending: false })
      .limit(20),
    ctx.service
      .from("reports")
      .select("id, reported_user_id, reason, details, created_at")
      .eq("reporter_id", id)
      .order("created_at", { ascending: false })
      .limit(10),
    ctx.service
      .from("reports")
      .select("id, reporter_id, reason, details, created_at")
      .eq("reported_user_id", id)
      .order("created_at", { ascending: false })
      .limit(10),
    ctx.service
      .from("reviews")
      .select("rating, text, role, created_at")
      .eq("reviewed_user_id", id)
      .order("created_at", { ascending: false })
      .limit(10),
    ctx.service
      .from("admin_user_notes")
      .select("id, admin_id, note, created_at")
      .eq("user_id", id)
      .order("created_at", { ascending: false })
      .limit(50),
    ctx.service.rpc("admin_user_login_history", { target: id, lim: 10 }),
  ]);

  const authUser = authUserRes.data?.user ?? null;
  const providers = (authUser?.identities ?? []).map((i) => i.provider);
  const loginHistory = (loginHistoryRes.data ?? []) as { created_at: string; ip: string | null; action: string | null }[];

  // Payment status for the earner-side bookings.
  const bookingIds = (earnerBookingsRes.data ?? []).map((b) => b.id);
  const payments = bookingIds.length
    ? (
        await ctx.service
          .from("payments")
          .select("booking_id, status, amount_cents")
          .in("booking_id", bookingIds)
      ).data ?? []
    : [];
  const payByBooking = new Map(payments.map((p) => [p.booking_id, p]));

  // Names of admins who wrote notes (admin_id → profiles.name).
  const noteAdminIds = [...new Set((notesRes.data ?? []).map((n) => n.admin_id))];
  const noteAdmins = noteAdminIds.length
    ? (await ctx.service.from("profiles").select("id, name").in("id", noteAdminIds)).data ?? []
    : [];
  const adminName = new Map(noteAdmins.map((a) => [a.id, a.name]));

  // Sensitive read — leave a trace.
  await audit(ctx, "user.view", "user", id);

  const suspended = Boolean(profile.suspended_at);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">{profile.name}</h1>
        {profile.username && <span className="text-[var(--muted)]">@{profile.username}</span>}
        {suspended && <Pill tone="red">Suspended</Pill>}
        {profile.verified && <Pill tone="green">Verified</Pill>}
        {profile.student_verified && <Pill tone="green">Student</Pill>}
        {authUser?.email_confirmed_at == null && <Pill tone="amber">Email unconfirmed</Pill>}
      </div>

      <Section title="Account">
        <dl className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm md:grid-cols-4">
          <div>
            <dt className="text-[var(--muted)]">Email</dt>
            <dd>{authUser?.email ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-[var(--muted)]">User ID</dt>
            <dd className="break-all font-mono text-xs">{profile.id}</dd>
          </div>
          <div>
            <dt className="text-[var(--muted)]">Joined</dt>
            <dd>{fmtDate(profile.created_at)}</dd>
          </div>
          <div>
            <dt className="text-[var(--muted)]">Last sign-in</dt>
            <dd>{fmtDate(authUser?.last_sign_in_at)}</dd>
          </div>
          <div>
            <dt className="text-[var(--muted)]">City</dt>
            <dd>{profile.city ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-[var(--muted)]">Worker rating</dt>
            <dd>
              {Number(profile.rating).toFixed(1)} ({profile.review_count})
            </dd>
          </div>
          <div>
            <dt className="text-[var(--muted)]">Client rating</dt>
            <dd>
              {profile.poster_rating != null ? Number(profile.poster_rating).toFixed(1) : "—"} (
              {profile.poster_review_count ?? 0})
            </dd>
          </div>
          <div>
            <dt className="text-[var(--muted)]">ID verification</dt>
            <dd>{profile.id_verification_status ?? "none"}</dd>
          </div>
          {suspended && (
            <div className="col-span-2">
              <dt className="text-[var(--muted)]">Suspended</dt>
              <dd>
                {fmtDate(profile.suspended_at)}
                {profile.suspension_reason ? ` — ${profile.suspension_reason}` : ""}
              </dd>
            </div>
          )}
        </dl>
      </Section>

      <Section title="Sign-in">
        <dl className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm md:grid-cols-4">
          <div>
            <dt className="text-[var(--muted)]">Providers</dt>
            <dd>{providers.length ? providers.join(", ") : "email"}</dd>
          </div>
          <div>
            <dt className="text-[var(--muted)]">Last sign-in</dt>
            <dd>{fmtDate(authUser?.last_sign_in_at)}</dd>
          </div>
          <div>
            <dt className="text-[var(--muted)]">Email confirmed</dt>
            <dd>{authUser?.email_confirmed_at ? fmtDate(authUser.email_confirmed_at) : "no"}</dd>
          </div>
        </dl>
        {loginHistory.length > 0 ? (
          <ul className="mt-3 text-sm">
            {loginHistory.map((h, i) => (
              <li key={i} className="flex justify-between border-t border-[var(--line)] py-1.5">
                <span>{h.action ?? "login"}</span>
                <span className="text-[var(--muted)]">
                  {h.ip ?? "—"} · {fmtDate(h.created_at)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-xs text-[var(--muted)]">
            No per-login IP history is recorded (Supabase Auth isn&apos;t logging auth events on this project, and the app
            doesn&apos;t track user IPs by design).
          </p>
        )}
      </Section>

      <Section title="Actions">
        <ActionsPanel
          userId={profile.id}
          email={authUser?.email ?? null}
          suspended={suspended}
          verified={Boolean(profile.verified)}
          isAdmin={ctx.role === "admin"}
        />
      </Section>

      <Section title={`Bookings as worker (${earnerBookingsRes.data?.length ?? 0})`}>
        {(earnerBookingsRes.data ?? []).length === 0 ? (
          <p className="text-sm text-[var(--muted)]">None.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-[var(--muted)]">
                <th className="py-1 pr-4">Job</th>
                <th className="py-1 pr-4">Status</th>
                <th className="py-1 pr-4">Payment</th>
                <th className="py-1 pr-4">Tip</th>
                <th className="py-1">Booked</th>
              </tr>
            </thead>
            <tbody>
              {(earnerBookingsRes.data ?? []).map((b) => {
                const pay = payByBooking.get(b.id);
                const job = Array.isArray(b.jobs) ? b.jobs[0] : b.jobs;
                return (
                  <tr key={b.id} className="border-t border-[var(--line)]">
                    <td className="py-2 pr-4">{job?.title ?? "—"}</td>
                    <td className="py-2 pr-4">{b.status}</td>
                    <td className="py-2 pr-4">
                      {pay ? `${pay.status} · ${fmtCents(pay.amount_cents)}` : "—"}
                    </td>
                    <td className="py-2 pr-4">{b.tip_amount ? `$${b.tip_amount}` : "—"}</td>
                    <td className="py-2">{fmtDate(b.created_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Section>

      <Section title={`Gigs posted (${postedJobsRes.data?.length ?? 0})`}>
        {(postedJobsRes.data ?? []).length === 0 ? (
          <p className="text-sm text-[var(--muted)]">None.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {(postedJobsRes.data ?? []).map((j) => (
              <li key={j.id} className="flex justify-between border-t border-[var(--line)] py-2 first:border-0">
                <span>{j.title}</span>
                <span className="text-[var(--muted)]">
                  {j.status} · {fmtDate(j.created_at)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <div className="grid gap-6 md:grid-cols-2">
        <Section title={`Reports against (${reportsAgainstRes.data?.length ?? 0})`}>
          {(reportsAgainstRes.data ?? []).length === 0 ? (
            <p className="text-sm text-[var(--muted)]">None.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {(reportsAgainstRes.data ?? []).map((r) => (
                <li key={r.id} className="border-t border-[var(--line)] py-2 first:border-0">
                  <span className="font-medium">{r.reason}</span>
                  {r.details && <p className="text-[var(--muted)]">{r.details}</p>}
                  <p className="text-xs text-[var(--muted)]">
                    {fmtDate(r.created_at)} · by{" "}
                    <Link href={`/users/${r.reporter_id}`} className="text-[var(--brand)] hover:underline">
                      {r.reporter_id.slice(0, 8)}…
                    </Link>
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title={`Reports filed (${reportsByRes.data?.length ?? 0})`}>
          {(reportsByRes.data ?? []).length === 0 ? (
            <p className="text-sm text-[var(--muted)]">None.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {(reportsByRes.data ?? []).map((r) => (
                <li key={r.id} className="border-t border-[var(--line)] py-2 first:border-0">
                  <span className="font-medium">{r.reason}</span>
                  {r.details && <p className="text-[var(--muted)]">{r.details}</p>}
                  <p className="text-xs text-[var(--muted)]">
                    {fmtDate(r.created_at)}
                    {r.reported_user_id && (
                      <>
                        {" "}
                        · against{" "}
                        <Link
                          href={`/users/${r.reported_user_id}`}
                          className="text-[var(--brand)] hover:underline"
                        >
                          {r.reported_user_id.slice(0, 8)}…
                        </Link>
                      </>
                    )}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      <Section title={`Reviews received (${reviewsRes.data?.length ?? 0})`}>
        {(reviewsRes.data ?? []).length === 0 ? (
          <p className="text-sm text-[var(--muted)]">None.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {(reviewsRes.data ?? []).map((rv, i) => (
              <li key={i} className="border-t border-[var(--line)] py-2 first:border-0">
                <span className="font-medium">{Number(rv.rating).toFixed(1)}★</span>{" "}
                <span className="text-xs uppercase text-[var(--muted)]">as {rv.role}</span>
                <p className="text-[var(--muted)]">{rv.text}</p>
                <p className="text-xs text-[var(--muted)]">{fmtDate(rv.created_at)}</p>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={`Legal acceptances (${legalRes.data?.length ?? 0})`}>
        {(legalRes.data ?? []).length === 0 ? (
          <p className="text-sm text-[var(--muted)]">None recorded.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {(legalRes.data ?? []).map((l, i) => (
              <li key={i} className="flex justify-between border-t border-[var(--line)] py-1.5 first:border-0">
                <span>
                  {l.slug} <span className="text-[var(--muted)]">v{l.version}</span>
                </span>
                <span className="text-[var(--muted)]">{fmtDate(l.accepted_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={`Internal notes (${notesRes.data?.length ?? 0})`}>
        {(notesRes.data ?? []).length === 0 ? (
          <p className="text-sm text-[var(--muted)]">No notes yet.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {(notesRes.data ?? []).map((n) => (
              <li key={n.id} className="border-t border-[var(--line)] py-2 first:border-0">
                <p>{n.note}</p>
                <p className="text-xs text-[var(--muted)]">
                  {adminName.get(n.admin_id) ?? n.admin_id.slice(0, 8)} · {fmtDate(n.created_at)}
                </p>
              </li>
            ))}
          </ul>
        )}
        {ctx.role === "admin" && <NoteForm userId={profile.id} />}
      </Section>
    </div>
  );
}
