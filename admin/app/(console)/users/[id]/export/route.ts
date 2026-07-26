import { requireAdmin, AdminAuthError } from "@/lib/guard";
import { audit } from "@/lib/audit";

// GDPR/CCPA data-access export: dumps everything the platform holds about a user
// across all user-linked tables + auth + storage into one JSON download. Admin
// only; audited. Best-effort per table (a missing table/column is recorded, not
// fatal) so the export stays complete as the schema evolves.
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
  { t: "support_tickets", cols: ["user_id"] },
];
// `certificates` was missing here too (same omission as both delete paths).
const BUCKETS = [
  "avatars", "job-photos", "chat-photos", "completion-photos", "receipts", "certificates",
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
  for (const { t, cols } of TABLES) {
    try {
      const filter = cols.map((c) => `${c}.eq.${id}`).join(",");
      const { data, error } = await ctx.service.from(t).select("*").or(filter);
      tables[t] = error ? { error: error.message } : data;
    } catch (e) {
      tables[t] = { error: e instanceof Error ? e.message : String(e) };
    }
  }
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
