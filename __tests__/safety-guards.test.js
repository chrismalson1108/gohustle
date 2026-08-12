const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// The SOS exemption, pinned.
//
// The emergency exemption in guard_report_rate_limit must key on the app.emergency
// GUC, never on new.source. Postgres fires same-timing triggers in alphabetical name
// order, and guard_report_rate_limit originally ran BEFORE guard_reports_write — so
// `new.source` still held whatever the client sent. Any authenticated user could set
// source='emergency' and skip the 10/hour limit; the later trigger then rewrote the
// column to 'user', so the stored row looked ordinary and nothing recorded the skip.
//
// Two independent properties keep it shut, and both are asserted here because relying
// on either alone leaves the next edit one plausible assumption from reopening it.
// ─────────────────────────────────────────────────────────────────────────────
const MIG = fs.readFileSync(
  path.join(__dirname, '..', 'supabase', 'migrations',
            '20260806290000_emergency_exemption_bypass.sql'),
  'utf8',
);

const limiter = MIG.match(
  /create or replace function public\.guard_report_rate_limit[\s\S]*?\$\$;/,
)[0];

describe('report rate limiter: the emergency exemption', () => {
  test('keys on the app.emergency GUC', () => {
    expect(limiter).toMatch(/current_setting\('app\.emergency', true\)/);
  });

  test('never exempts on the client-supplied source column', () => {
    // The bug, exactly: `if new.source = 'emergency' then return new; end if;`
    expect(limiter).not.toMatch(/if\s+new\.source\s*=\s*'emergency'/);
    // Nor any other early return gated on new.source.
    expect(limiter).not.toMatch(/new\.source\s*=\s*'emergency'\s*then\s*return/);
  });

  test('the limiter is renamed to run AFTER the trigger that pins source', () => {
    // Defence in depth: with trg_z_ the pinning guard fires first, so new.source is
    // truthful for any future reader even though the check no longer depends on it.
    expect(MIG).toMatch(/create trigger trg_z_guard_report_rate_limit/);
    expect(MIG).toMatch(/drop trigger if exists trg_guard_report_rate_limit on public\.reports/);
  });

  test('the limit itself and the service_role exemption are unchanged', () => {
    expect(limiter).toMatch(/report_limit_per_hour constant int := 10/);
    expect(limiter).toMatch(/auth\.role\(\), ''\) = 'service_role'/);
    // Automated reports still do not count toward a human's quota.
    expect(limiter).toMatch(/coalesce\(r\.source, 'user'\) <> 'auto'/);
  });
});
