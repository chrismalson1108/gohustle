const fs = require('fs');
const path = require('path');

// `profiles` is column-locked: 20260624221000_profile_column_lockdown.sql revokes the
// table-wide grant and re-grants SELECT on an explicit column list, so private columns
// (date_of_birth, email, stripe ids, suspension state, earnings internals) are not
// readable via /rest/v1/profiles at all. Owners read their own full row through the
// SECURITY DEFINER my_profile() RPC instead.
//
// The sharp edge: naming ONE ungranted column in a select makes PostgREST reject the
// ENTIRE query with 42501 — it does not silently omit the column. Both Settings screens
// selected `date_of_birth`, so the whole profile load failed, the form rendered blank,
// and Save (which writes every field unconditionally) then overwrote the stored profile
// with empty strings — silent data loss on a routine user action.
//
// The tempting fix is to grant the missing column, but that is exactly wrong here:
// profiles_select_all is USING(true), and column grants are table-wide, not row-scoped,
// so granting date_of_birth would expose every user's DOB to every signed-in user on a
// platform that includes minors. The correct direction is to keep the column ungranted
// and read it via my_profile().
//
// So this test enforces the invariant rather than the instance: every column any client
// selects from `profiles` must appear in the final granted column list. A new private
// column selected by a client fails here instead of silently wiping user profiles.
//
// SCOPE: src/ and web/ only — the clients that hit PostgREST as `authenticated` and are
// therefore subject to column grants. supabase/functions/ is deliberately NOT scanned:
// those run with the service role, which bypasses column privileges entirely, so
// selecting a private column there is legitimate (stripe-connect-onboard reads
// date_of_birth this way to prefill Stripe Connect). The one shape that would slip
// through is an edge function using an ANON-key client scoped to the caller's JWT —
// checked by hand and none of them selects a private profiles column today (the
// assistant, the only such function, goes through the my_profile() RPC).
const ROOT = path.join(__dirname, '..');
const LEGACY_DIR = path.join(ROOT, 'supabase');
const MIG_DIR = path.join(ROOT, 'supabase', 'migrations');

function migrationsInApplyOrder() {
  const legacy = fs.readdirSync(LEGACY_DIR).filter((f) => /^migration_.*\.sql$/.test(f)).sort()
    .map((f) => path.join(LEGACY_DIR, f));
  const tracked = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort()
    .map((f) => path.join(MIG_DIR, f));
  return [...legacy, ...tracked];
}

const stripComments = (sql) => sql.replace(/--[^\n]*/g, '');

// Replay `grant select (cols) on public.profiles` across every migration. Grants are
// additive in Postgres, so the union across files is the final readable set.
function grantedProfileColumns() {
  const granted = new Set();
  for (const file of migrationsInApplyOrder()) {
    const sql = stripComments(fs.readFileSync(file, 'utf8'));
    const re = /grant\s+select\s*\(([^)]*)\)\s*on\s+public\.profiles\s+to\s+([a-z_,\s]+)/gi;
    let m;
    while ((m = re.exec(sql)) !== null) {
      const roles = m[2].toLowerCase();
      if (!/authenticated/.test(roles)) continue; // only what signed-in clients can read
      for (const col of m[1].split(',')) {
        const c = col.trim().toLowerCase();
        if (c) granted.add(c);
      }
    }
  }
  return granted;
}

// Find `.from('profiles').select('a, b, c')` in client source. Handles both quote
// styles, backticks, and selects split across lines.
function clientProfileSelects() {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue;
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/\.(js|jsx|ts|tsx)$/.test(entry.name)) files.push(p);
    }
  };
  walk(path.join(ROOT, 'src'));
  walk(path.join(ROOT, 'web'));

  const out = [];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    // .from("profiles") ... .select("...") — allow whitespace/newlines between.
    const re = /\.from\(\s*["'`]profiles["'`]\s*\)[\s\S]{0,200}?\.select\(\s*["'`]([^"'`]*)["'`]/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const raw = m[1];
      if (raw.includes('*')) continue; // star selects are governed by the grant itself
      const cols = raw
        .split(',')
        .map((c) => c.trim().toLowerCase())
        // strip PostgREST embeds/aliases: "job:jobs!fk(...)", "alias:col"
        .map((c) => (c.includes('(') ? '' : c))
        .map((c) => (c.includes(':') ? c.split(':').pop().trim() : c))
        .filter(Boolean);
      out.push({ file: path.relative(ROOT, file), cols, raw });
    }
  }
  return out;
}

describe('profiles column grants vs client selects', () => {
  const granted = grantedProfileColumns();
  const selects = clientProfileSelects();

  test('the grant replay and the source scan both found something (guards the parser)', () => {
    expect(granted.size).toBeGreaterThan(10);
    expect(granted.has('name')).toBe(true);
    expect(selects.length).toBeGreaterThan(0);
  });

  test('date_of_birth stays UNGRANTED (granting it would leak every user DOB)', () => {
    // profiles_select_all is USING(true) and column grants are not row-scoped, so a
    // grant here is a cross-user PII leak, not a fix. Read it via my_profile().
    expect(granted.has('date_of_birth')).toBe(false);
  });

  test('no client selects a profiles column that is not granted', () => {
    const violations = [];
    for (const s of selects) {
      for (const col of s.cols) {
        if (!granted.has(col)) violations.push(`${s.file}: "${col}" (in select "${s.raw.slice(0, 90)}")`);
      }
    }
    // Any entry here means PostgREST rejects that whole query with 42501 at runtime.
    expect(violations).toEqual([]);
  });
});
