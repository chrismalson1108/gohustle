const fs = require('fs');
const path = require('path');

// H4/H5 are pure DB privilege changes (no JS seam), but they are security-critical
// and easy to silently revert. These guards fail loudly if the tracked migrations
// that (a) backfill the lockdown-prereq DDL and (b) revoke the anon read path are
// removed or gutted — so a regression can't ship green.
const ROOT = path.join(__dirname, '..');
const MIG = path.join(ROOT, 'supabase', 'migrations');

function read(name) {
  return fs.readFileSync(path.join(MIG, name), 'utf8');
}

describe('H4/H5 anon-read revoke stays in the tracked migrations', () => {
  test('anon SELECT is revoked on profiles and jobs', () => {
    const sql = read('20260710020000_revoke_anon_public_read.sql').toLowerCase().replace(/\s+/g, ' ');
    expect(sql).toContain('revoke select on public.profiles from anon');
    expect(sql).toContain('revoke select on public.jobs from anon');
  });

  test('prereq DDL exists and is ordered BEFORE the column lockdown', () => {
    const ddl = read('20260624220500_profile_missing_columns_ddl.sql').toLowerCase();
    expect(ddl).toContain('add column if not exists skill_rates');
    expect(ddl).toContain('add column if not exists stripe_identity_session_id');
    // 20260624220500 < 20260624221000 (the lockdown) — filename timestamp ordering.
    expect('20260624220500' < '20260624221000').toBe(true);
    expect(fs.existsSync(path.join(MIG, '20260624221000_profile_column_lockdown.sql'))).toBe(true);
  });
});
