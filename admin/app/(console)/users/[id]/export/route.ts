import { requireAdmin, AdminAuthError } from "@/lib/guard";
import { audit } from "@/lib/audit";

// GDPR/CCPA data-access export: dumps everything the platform holds about a user
// across all user-linked tables + auth + storage into one JSON download. Admin
// only; audited. Best-effort per table (a missing table/column is recorded, not
// fatal) so one renamed column cannot fail the whole download.
//
// ⚠️ "Best-effort per table" is exactly why this list cannot be trusted to stay
// complete on its own: a table that is simply ABSENT from it produces no error and
// no marker, so an incomplete export is indistinguishable from a complete one. It
// had drifted — notification_preferences, gig_shares, promo_grants, bonus_ledger,
// client_errors, moderation_flags, stripe_payouts and the whole promo family were
// missing, as was every table that hangs off a job/booking/ticket rather than
// naming the user directly (see DERIVED below). `__tests__/exportCoverage.test.js`
// now enumerates every table in supabase/ with a profiles/auth FK and fails unless
// it is exported here or excused there with a reason — the same shape as the
// delete path's bucket list, which drifted twice before it was asserted.
const TABLES: { t: string; cols: string[] }[] = [
  { t: "profiles", cols: ["id"] },
  { t: "legal_acceptances", cols: ["user_id"] },
  { t: "bookings", cols: ["earner_id"] },
  { t: "jobs", cols: ["poster_id"] },
  { t: "reviews", cols: ["reviewer_id", "reviewed_user_id"] },
  { t: "messages", cols: ["sender_id"] },
  { t: "notifications", cols: ["user_id"] },
  { t: "disputes", cols: ["raised_by"] },
  // reports and blocks are handled separately below — exporting them by a plain
  // "any column matches this user" filter hands the subject the identity of everyone
  // who reported or blocked them. See REPORTER_SAFE_EXPORT.
  { t: "expenses", cols: ["user_id"] },
  { t: "income_entries", cols: ["user_id"] },
  { t: "favorites", cols: ["user_id"] },
  { t: "saved_jobs", cols: ["user_id"] },
  { t: "saved_searches", cols: ["user_id"] },
  { t: "referrals", cols: ["referrer_id", "referred_id"] },
  { t: "push_tokens", cols: ["user_id"] },
  { t: "certifications", cols: ["user_id"] },
  { t: "class_schedule", cols: ["user_id"] },
  { t: "conversation_state", cols: ["user_id"] },
  { t: "tip_ledger", cols: ["earner_id"] },
  { t: "user_challenges", cols: ["user_id"] },
  { t: "badges", cols: ["user_id"] },
  { t: "student_email_verifications", cols: ["user_id"] },
  { t: "stripe_accounts", cols: ["user_id"] },
  { t: "stripe_customers", cols: ["user_id"] },
  { t: "assistant_threads", cols: ["user_id"] },
  { t: "assistant_messages", cols: ["user_id"] },
  { t: "assistant_pending_actions", cols: ["user_id"] },
  { t: "support_tickets", cols: ["user_id"] },
  { t: "notification_preferences", cols: ["user_id"] },
  { t: "gig_shares", cols: ["created_by"] },
  { t: "promo_grants", cols: ["user_id"] },
  { t: "promo_redemptions", cols: ["user_id"] },
  { t: "promo_redeem_attempts", cols: ["user_id"] },
  { t: "promo_codes", cols: ["bound_user_id"] },
  { t: "bonus_ledger", cols: ["user_id"] },
  { t: "stripe_payouts", cols: ["user_id"] },
  { t: "client_errors", cols: ["user_id"] },
  { t: "moderation_flags", cols: ["user_id"] },
  { t: "categories", cols: ["created_by"] },
];
// `certificates` was missing here too (same omission as both delete paths), and
// `support-photos` was missing until 2026-09-05 — so a data-access request answered
// from this route silently omitted the photographs a user had attached to their own
// support tickets, while the ticket TEXT was exported. An export that is quietly
// incomplete is worse than one that errors: nobody knows to ask again.
const BUCKETS = [
  "avatars", "job-photos", "chat-photos", "completion-photos", "receipts", "certificates",
  "support-photos",
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Defense-in-depth CSRF guard for this PII-export GET. Session cookies are
  // SameSite=Lax (so cross-site subresource loads already carry no cookie), but a
  // cross-site top-level navigation could still trigger the export + an audit row.
  // Modern browsers send Sec-Fetch-Site: a legit in-app download is 'same-origin'
  // and direct address-bar navigation is 'none' — reject only explicit cross-site.
  if (req.headers.get("sec-fetch-site") === "cross-site") {
    return new Response("Forbidden", { status: 403 });
  }
  let ctx;
  try {
    ctx = await requireAdmin("admin");
  } catch (e) {
    if (e instanceof AdminAuthError) return new Response("Forbidden", { status: 403 });
    throw e;
  }
  // id is interpolated into PostgREST .or() filter strings below — require a
  // literal UUID so nothing else can be smuggled into the filter.
  if (!UUID_RE.test(id)) return new Response("Bad request", { status: 400 });

  const out: Record<string, unknown> = { exported_at: new Date().toISOString(), user_id: id };

  // Auth record
  const { data: authData } = await ctx.service.auth.admin.getUserById(id);
  out.auth = authData?.user
    ? {
        email: authData.user.email,
        created_at: authData.user.created_at,
        last_sign_in_at: authData.user.last_sign_in_at,
        email_confirmed_at: authData.user.email_confirmed_at,
        providers: (authData.user.identities ?? []).map((i) => i.provider),
        banned_until: (authData.user as { banned_until?: string }).banned_until ?? null,
      }
    : null;

  // Tables
  const tables: Record<string, unknown> = {};

  // The waitlist, keyed on the EMAIL rather than a uuid.
  //
  // It is not in TABLES and cannot be: every entry there filters on a column holding
  // this user's id, and public.waitlist has no such column — it is a list of people who
  // are not users. exportCoverage.test.js enumerates tables by their FK to profiles, so
  // it is structurally incapable of noticing the omission either. tombstone_profile
  // DELETES this row on erasure (20260908010000), so the access side has to match it or
  // the two halves of the same right disagree.
  //
  // token_hash is withheld deliberately: it is a live confirm/unsubscribe credential,
  // the same class as an mfa_recovery_code, and a subject-access export is a file that
  // gets emailed around.
  if (authData?.user?.email) {
    const wlEmail = authData.user.email.trim().toLowerCase();
    for (const t of ["waitlist", "waitlist_attempts"] as const) {
      const { data, error } = await ctx.service
        .from(t)
        .select(
          t === "waitlist"
            ? "id, email, role_intent, in_launch_area, source, confirmed_at, unsubscribed_at, email_sent_count, last_email_sent_at, invited_at, invite_wave, consent_doc_version, created_at, updated_at"
            : "id, email, created_at",
        )
        .eq("email", wlEmail);
      tables[t] = error ? { error: error.message } : data;
    }
  }

  for (const { t, cols } of TABLES) {
    try {
      const filter = cols.map((c) => `${c}.eq.${id}`).join(",");
      const { data, error } = await ctx.service.from(t).select("*").or(filter);
      tables[t] = error ? { error: error.message } : data;
    } catch (e) {
      tables[t] = { error: e instanceof Error ? e.message : String(e) };
    }
  }

  // ── DERIVED ────────────────────────────────────────────────────────────────
  // Some of the subject's own data is held in tables that never name them: it hangs
  // off one of their jobs, bookings, payments or tickets. A "column equals this user
  // id" list cannot reach any of it, and the omission is silent.
  //
  // The worst case was `bookings`, filtered on earner_id alone: a user who HIRES
  // rather than works got their jobs exported but not one of the bookings on them —
  // and `payments`, the actual record of what they were charged, appeared nowhere in
  // the file at all. A subject-access request from a poster returned an export with
  // their entire transaction history missing and nothing saying so.
  const rowIds = (rows: unknown, key = "id"): string[] =>
    Array.isArray(rows)
      ? [...new Set(rows.map((r) => (r as Record<string, unknown>)[key]).filter(Boolean))].map(String)
      : [];

  // PostgREST puts .in() lists in the query string, so a heavy account could build a
  // URL the gateway truncates or rejects — which would read as "no rows". Chunk it.
  const selectIn = async (table: string, col: string, ids: string[]) => {
    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < ids.length; i += 200) {
      const { data, error } = await ctx.service
        .from(table)
        .select("*")
        .in(col, ids.slice(i, i + 200));
      if (error) throw new Error(error.message);
      rows.push(...((data ?? []) as Record<string, unknown>[]));
    }
    return rows;
  };

  const derive = async (name: string, run: () => Promise<unknown>) => {
    try {
      tables[name] = await run();
    } catch (e) {
      tables[name] = { error: e instanceof Error ? e.message : String(e) };
    }
    return Array.isArray(tables[name]) ? (tables[name] as Record<string, unknown>[]) : [];
  };

  const jobIds = rowIds(tables.jobs);
  const ticketIds = rowIds(tables.support_tickets);

  const posterBookings = await derive("bookings_as_poster", () =>
    selectIn("bookings", "job_id", jobIds),
  );
  const bookingIds = [...new Set([...rowIds(tables.bookings), ...rowIds(posterBookings)])];

  const payments = await derive("payments", () => selectIn("payments", "booking_id", bookingIds));
  await derive("refund_ledger", () => selectIn("refund_ledger", "payment_id", rowIds(payments)));
  await derive("safety_checkins", () => selectIn("safety_checkins", "booking_id", bookingIds));
  await derive("job_slots", () => selectIn("job_slots", "job_id", jobIds));
  await derive("job_requirements", () => selectIn("job_requirements", "job_id", jobIds));
  await derive("job_locations", () => selectIn("job_locations", "job_id", jobIds));
  // The user's own support thread, both sides. `admin_id` is the agent's identity, not
  // the subject's data — same reasoning as REPORTER_SAFE_EXPORT below. The body is kept
  // because the subject was sent it.
  await derive("support_ticket_messages", async () =>
    (await selectIn("support_ticket_messages", "ticket_id", ticketIds)).map((m) => ({
      ...m,
      admin_id: m.admin_id ? "[redacted — support agent identity]" : null,
    })),
  );

  // REPORTER_SAFE_EXPORT — reports and blocks are two-sided, and only ONE side is
  // this user's own data.
  //
  // Exporting them with a plain `reporter_id.eq.X,reported_user_id.eq.X` filter (as
  // this route previously did) returns, to the subject of the export, the identity of
  // every person who reported or blocked them. On a platform where strangers meet in
  // person that is a retaliation vector: the most likely requester of "everything you
  // hold about me" is exactly the account others have been reporting. It is also the
  // wrong reading of the law — GDPR Art. 15(4) says the right to obtain a copy "shall
  // not adversely affect the rights and freedoms of others", and the reporter's
  // identity is the reporter's data, not the subject's.
  //
  // So: rows the user AUTHORED are exported in full (their own data), and rows ABOUT
  // them are exported with the other party stripped — the subject still learns what
  // was said about them and when, which is what the access right actually covers.
  const stripReporter = (rows: Record<string, unknown>[] | null) =>
    (rows ?? []).map((r) => {
      const { reporter_id, ...rest } = r;
      void reporter_id;
      return { ...rest, reporter_id: "[redacted — another user's identity]" };
    });

  try {
    const [filedByUser, aboutUser] = await Promise.all([
      ctx.service.from("reports").select("*").eq("reporter_id", id),
      ctx.service.from("reports").select("*").eq("reported_user_id", id),
    ]);
    tables.reports_filed_by_user = filedByUser.error
      ? { error: filedByUser.error.message }
      : filedByUser.data;
    tables.reports_about_user = aboutUser.error
      ? { error: aboutUser.error.message }
      : stripReporter(aboutUser.data);
  } catch (e) {
    tables.reports = { error: e instanceof Error ? e.message : String(e) };
  }

  try {
    const [blocksMade, blocksAgainst] = await Promise.all([
      ctx.service.from("blocks").select("*").eq("blocker_id", id),
      ctx.service.from("blocks").select("blocked_id, created_at").eq("blocked_id", id),
    ]);
    tables.blocks_created_by_user = blocksMade.error
      ? { error: blocksMade.error.message }
      : blocksMade.data;
    // Who blocked this user is deliberately NOT disclosed — blocking is designed to
    // be silent (20260710030000), and naming the blocker would both break that and
    // invite retaliation. The count is kept so the export is not misleading.
    tables.blocks_against_user = blocksAgainst.error
      ? { error: blocksAgainst.error.message }
      : { count: (blocksAgainst.data ?? []).length, detail: "[redacted — blocking is silent by design]" };
  } catch (e) {
    tables.blocks = { error: e instanceof Error ? e.message : String(e) };
  }

  out.tables = tables;

  // Storage objects under <userId>/ in each bucket
  const storage: Record<string, unknown> = {};
  for (const b of BUCKETS) {
    try {
      const { data, error } = await ctx.service.storage.from(b).list(id, { limit: 1000 });
      storage[b] = error ? { error: error.message } : (data ?? []).map((f) => `${id}/${f.name}`);
    } catch (e) {
      storage[b] = { error: e instanceof Error ? e.message : String(e) };
    }
  }
  out.storage = storage;

  await audit(ctx, "user.export", "user", id);

  return new Response(JSON.stringify(out, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="gohustlr-user-${id}.json"`,
    },
  });
}
