const fs = require('fs');
const path = require('path');

// H6 is a DB trigger + a Deno edge function (no Jest runtime seam), so guard the
// wiring: fail loudly if the alerting path is removed or gutted.
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('H6 safety-report alerting stays wired', () => {
  const mig = read('supabase/migrations/20260710050000_safety_report_alerting.sql').toLowerCase();
  const fn = read('supabase/functions/safety-alert/index.ts');

  test('AFTER INSERT trigger on reports dispatches via pg_net', () => {
    expect(mig).toContain('after insert on public.reports');
    expect(mig).toContain('notify_safety_report');
    expect(mig).toContain('net.http_post');
  });

  test('trigger no-ops (never blocks the insert) until configured', () => {
    // A url guard + an exception handler around the dispatch = the report is never
    // lost to an alerting failure.
    expect(mig).toMatch(/if url is null or url = ''/);
    expect(mig).toContain('exception when others then');
  });

  test('edge function emails on-call via Resend behind a shared secret', () => {
    expect(fn).toContain('SAFETY_ALERT_SECRET');
    expect(fn).toContain('x-safety-secret');
    expect(fn).toContain('api.resend.com/emails');
    expect(fn).toContain('SAFETY_ONCALL_EMAIL');
  });
});
