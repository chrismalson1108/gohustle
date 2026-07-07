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
  { t: "reports", cols: ["reporter_id", "reported_user_id"] },
  { t: "blocks", cols: ["blocker_id", "blocked_id"] },
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
const BUCKETS = ["avatars", "job-photos", "chat-photos", "completion-photos", "receipts"];

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
