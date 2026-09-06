const fs = require('fs');
const path = require('path');

// The console's GDPR/CCPA data-access export (admin/app/(console)/users/[id]/export/
// route.ts) is a hand-maintained list of tables. Its header promised "everything the
// platform holds about a user", and because every table is fetched best-effort — a
// missing table or column is recorded, not fatal — a table simply ABSENT from the list
// produces no error and no marker in the download. An incomplete export is therefore
// indistinguishable from a complete one, by anyone, including the person who asked for
// their data.
//
// It had drifted. notification_preferences, gig_shares, promo_grants/redemptions/codes/
// redeem_attempts, bonus_ledger, client_errors, moderation_flags, stripe_payouts and
// assistant_pending_actions all name a user directly and none were exported; `bookings`
// was filtered on earner_id alone, so a user who HIRES got their jobs but not one
// booking on them, and `payments` — the record of what they were actually charged —
// appeared nowhere at all.
//
// delete-account's bucket list drifted the same way twice and stopped drifting when
// __tests__/storagePolicies.test.js started asserting it against the schema. This is
// that guard for the export: every table in supabase/ with a direct profiles/auth FK
// must be exported, derived from another exported table, or excused HERE with a reason.
const ROOT = path.join(__dirname, '..');
const LEGACY_DIR = path.join(ROOT, 'supabase');
const MIG_DIR = path.join(ROOT, 'supabase', 'migrations');
const ROUTE = path.join(ROOT, 'admin', 'app', '(console)', 'users', '[id]', 'export', 'route.ts');

function sqlFiles() {
  return [LEGACY_DIR, MIG_DIR]
    .filter((d) => fs.existsSync(d))
    .flatMap((d) =>
      fs
        .readdirSync(d)
        .filter((f) => f.endsWith('.sql'))
        .map((f) => path.join(d, f)),
    );
}

// Every `create table … (` body in the schema, and the uuid columns in it that point at
// a person (public.profiles or auth.users). Columns bolted on later by ALTER TABLE are
// not read: this guard is about TABLE coverage, which is the axis that drifted.
function userLinkedTables() {
  const linked = new Map(); // table -> Set(columns)
  for (const file of sqlFiles()) {
    const sql = fs.readFileSync(file, 'utf8').replace(/--[^\n]*/g, '');
    const re = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-z0-9_]+)\s*\(/gi;
    let m;
    while ((m = re.exec(sql))) {
      const name = m[1];
      // Walk to the matching close paren so nested type/check parens do not end the body early.
      let i = re.lastIndex - 1;
      let depth = 0;
      const start = i;
      for (; i < sql.length; i++) {
        if (sql[i] === '(') depth++;
        else if (sql[i] === ')') {
          depth--;
          if (depth === 0) break;
        }
      }
      const body = sql.slice(start + 1, i);
      const cols = [
        ...body.matchAll(
          /([a-z0-9_]+)\s+uuid[^,]*?references\s+(?:public\.)?(?:profiles|auth\.users)\s*\(/gi,
        ),
      ].map((x) => x[1]);
      if (!cols.length) continue;
      if (!linked.has(name)) linked.set(name, new Set());
      cols.forEach((c) => linked.get(name).add(c));
    }
  }
  return linked;
}

const routeSrc = fs.readFileSync(ROUTE, 'utf8');

// Tables reached by a direct column filter.
const listed = new Set(
  [...(routeSrc.match(/const TABLES[\s\S]*?\n\];/) ?? [''])[0].matchAll(/\{\s*t:\s*"([a-z0-9_]+)"/g)].map(
    (m) => m[1],
  ),
);
// Tables reached through another table's ids (selectIn) or handled by their own bespoke
// query (reports / blocks, which are two-sided — see REPORTER_SAFE_EXPORT in the route).
const derived = new Set([...routeSrc.matchAll(/selectIn\(\s*"([a-z0-9_]+)"/g)].map((m) => m[1]));
const bespoke = new Set([...routeSrc.matchAll(/\.from\("([a-z0-9_]+)"\)\s*\.select/g)].map((m) => m[1]));
const exported = new Set([...listed, ...derived, ...bespoke]);

// Deliberately NOT in the export, each with the reason it is not the subject's data to
// receive. Add with a reason; never to silence a failure.
const EXCUSED = {
  admin_audit_log: 'append-only log of STAFF actions; the uuid is the acting admin, and the rows name other users',
  admin_users: 'console staff roster — exists only if the subject is staff, and is not consumer data',
  admin_user_notes:
    'internal moderation/fraud notes written by staff about the user; the FK is the authoring admin. Retained under the privacy policy\u2019s fraud-prevention carve-out, same class as the reporter redaction below',
  app_flags: 'platform configuration; updated_by is the acting admin',
  control_findings: 'ops invariant findings; resolved_by is the acting admin',
  fee_tiers: 'rate-card configuration; created_by is the acting admin',
  platform_rates: 'rate-card configuration; created_by is the acting admin',
  promotions: 'campaign definitions; created_by is the acting admin. The subject\u2019s own claim is promo_grants, which IS exported',
  mfa_recovery_codes:
    'hashes of LIVE single-use credentials. Writing credential material into a downloadable file is a security regression, and the plaintext is not held anyway',
  reports: 'exported by the bespoke reports_filed_by_user / reports_about_user queries — see REPORTER_SAFE_EXPORT',
  blocks: 'exported by the bespoke blocks_created_by_user / blocks_against_user queries — blocking is silent by design',
};

describe('the GDPR export covers every user-linked table', () => {
  const linked = userLinkedTables();

  it('parsed both sides (guards the parser itself)', () => {
    expect(linked.size).toBeGreaterThan(30);
    expect(linked.has('profiles')).toBe(true);
    expect(listed.size).toBeGreaterThan(20);
    expect(derived.size).toBeGreaterThan(3);
  });

  it('every table with a direct profiles/auth FK is exported or excused with a reason', () => {
    const missing = [...linked.keys()]
      .filter((t) => !exported.has(t))
      .filter((t) => !EXCUSED[t])
      .sort();
    // Name the table — "coverage drifted" is not actionable.
    expect(missing).toEqual([]);
  });

  it('every excuse names a reason', () => {
    for (const [t, why] of Object.entries(EXCUSED)) {
      expect(typeof why).toBe('string');
      expect(why.length).toBeGreaterThan(20);
      // An excuse for a table that no longer exists is dead weight that hides the next drift.
      expect(linked.has(t)).toBe(true);
    }
  });

  it('exports no table the schema does not create', () => {
    const allTables = new Set();
    for (const file of sqlFiles()) {
      const sql = fs.readFileSync(file, 'utf8').replace(/--[^\n]*/g, '');
      for (const m of sql.matchAll(
        /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-z0-9_]+)\s*\(/gi,
      )) {
        allTables.add(m[1]);
      }
    }
    const phantom = [...exported].filter((t) => !allTables.has(t)).sort();
    expect(phantom).toEqual([]);
  });
});

// The specific regression, asserted on its own so a future edit that drops the poster
// side fails on the mechanism rather than on a coverage count.
describe('the export carries BOTH sides of a booking, and the money', () => {
  it('reaches bookings the subject posted, not only the ones they worked', () => {
    // The earner-side filter alone is what made a poster's export look empty.
    expect(routeSrc).toMatch(/\{\s*t:\s*"bookings",\s*cols:\s*\["earner_id"\]\s*\}/);
    expect(routeSrc).toMatch(/selectIn\(\s*"bookings",\s*"job_id"/);
  });

  it('exports payments for every booking on either side', () => {
    expect(routeSrc).toMatch(/selectIn\(\s*"payments",\s*"booking_id"/);
    // bookingIds must be the union, or the poster side is money-blind again.
    expect(routeSrc).toMatch(/bookingIds\s*=\s*\[\s*\.\.\.new Set\(\[\s*\.\.\.rowIds\(tables\.bookings\)/);
  });

  it('exports the user\u2019s own support replies', () => {
    expect(routeSrc).toMatch(/selectIn\(\s*"support_ticket_messages",\s*"ticket_id"/);
    // …with the agent's identity stripped, the same way reporter_id is.
    expect(routeSrc).toMatch(/admin_id:\s*m\.admin_id\s*\?\s*"\[redacted/);
  });

  it('chunks .in() lists so a heavy account is not silently truncated', () => {
    expect(routeSrc).toMatch(/i \+= 200/);
  });
});
