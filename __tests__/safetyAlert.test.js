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

// ─────────────────────────────────────────────────────────────────────────────
// An SOS or an overdue check-in pages a human who then has to find the worker.
// jobs.location is MASKED at write and the exact street label lives in job_locations
// behind RLS — so the alert email said "Plano, TX", the critical control finding said
// "Plano, TX", and the console page the runbook sends the on-call to showed no location
// at all. All three run as service_role and could always have read the address.
// ─────────────────────────────────────────────────────────────────────────────
describe('the surfaces that page a human can say WHERE the worker is', () => {
  // The LAST definition wins — the control has been redefined twice, and pinning this
  // to one filename would quietly stop checking the body that actually runs.
  const migDir = path.join(ROOT, 'supabase', 'migrations');
  const controlBody = (() => {
    let body = null;
    for (const f of fs.readdirSync(migDir).filter((x) => x.endsWith('.sql')).sort()) {
      const sql = fs.readFileSync(path.join(migDir, f), 'utf8');
      const i = sql.indexOf('create or replace function public.ctl_safety_checkin_overdue');
      if (i === -1) continue;
      const end = sql.indexOf('revoke execute on function public.ctl_safety_checkin_overdue', i);
      body = sql.slice(i, end === -1 ? sql.length : end);
    }
    return body;
  })();

  test('the overdue-checkin control emits the exact address', () => {
    expect(controlBody).toBeTruthy();
    expect(controlBody).toContain('job_locations');
    expect(controlBody).toContain('exact_location');
    // LEFT join: a remote or city-only gig has no job_locations row, and an inner join
    // would drop those bookings out of a safety control entirely.
    expect(controlBody).toMatch(/left join public\.job_locations/i);
    // And it still carries the masked label the parties saw.
    expect(controlBody).toContain("'location', j.location");
  });

  test('the alert email carries the address and the booking state', () => {
    const alert = read('supabase/functions/safety-alert/index.ts');
    expect(alert).toContain('job_locations');
    expect(alert).toContain('exact_location');
    // Booking context: is this happening now? (RUNBOOK_SAFETY §1 step 2.)
    expect(alert).toMatch(/started_at/);
    // An SOS is not a routine report; the subject has to say so on a phone at 11pm.
    expect(alert).toMatch(/source === 'emergency'/);
    expect(alert).toMatch(/EMERGENCY/);
  });

  test('the console booking page reads the exact address and logs the access', () => {
    const page = read('admin/app/(console)/bookings/[id]/page.tsx');
    expect(page).toContain('job_locations');
    expect(page).toContain('exact_location');
    // A deliberate PII disclosure has to be RECORDED. Two shapes satisfy that and the
    // merge kept the second: a dedicated audit action, or booking.view carrying whether
    // the address was actually shown. What is not acceptable is an unrecorded read, or a
    // flag hard-coded true — hence the tie to the variable the render is gated on.
    expect(page).toMatch(/booking\.exact_location|exact_address_shown/);
    expect(page).toMatch(/auditRead\([^)]*booking\.view[^)]*exact_address_shown: exactLocation != null|auditRead\(ctx, "booking\.exact_location"/s);
    // and staff below `trust` must not reach it at all.
    expect(page).toMatch(/roleSatisfies\(ctx\.role, "trust"\)/);
  });

  test('the moderation queue distinguishes an emergency from a routine report', () => {
    const mod = read('admin/app/(console)/moderation/page.tsx');
    expect(mod).toMatch(/source === "emergency"/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

// A pager that cannot page must SAY SO in its status code.
//
// safety-alert used to answer 200 {ok:true,emailed:false} when RESEND_API_KEY was
// unset, on the stated reasoning that a non-2xx would "wedge the trigger". It cannot:
// notify_safety_report dispatches through pg_net, which is asynchronous and wraps the
// post in `exception when others then raise warning`, so the response status never
// reaches the insert. The only thing that reads it is ctl_alert_dispatch_failing,
// which scans net._http_response for a NON-2xx — so the 200 made a config state in
// which no safety report is ever emailed look exactly like a quiet week. That is the
// 2026-07-10 shape: four weeks of a dead safety channel above a green board.
// ─────────────────────────────────────────────────────────────────────────────
describe('a dark email transport answers non-2xx so a control can see it', () => {
  const safety = read('supabase/functions/safety-alert/index.ts');
  const controls = read('supabase/functions/controls-alert/index.ts');
  // The `if (!RESEND_API_KEY) { … }` block — the branch taken when there is no transport.
  const noTransportBlock = (src) => {
    const start = src.indexOf('if (!RESEND_API_KEY) {');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('\n    }', start);
    expect(end).toBeGreaterThan(start);
    return src.slice(start, end);
  };

  test('safety-alert returns 503 email_not_configured, never ok:true', () => {
    const block = noTransportBlock(safety);
    expect(block).toContain("'email_not_configured'");
    expect(block).toMatch(/,\s*503\s*\)/);
    expect(block).not.toMatch(/ok:\s*true/);
  });

  test('controls-alert reports a dark digest channel the same way', () => {
    const block = noTransportBlock(controls);
    expect(block).toContain("'email_not_configured'");
    expect(block).toMatch(/,\s*503\s*\)/);
    expect(block).not.toMatch(/ok:\s*true/);
  });

  test('controls-alert still answers 200 when there was simply nothing to send', () => {
    // The channel is healthy in that case; only a BROKEN channel may answer 503, or
    // the sweep would open a finding every hour on a quiet platform.
    expect(controls).toContain("json({ ok: true, emailed: false, reason: 'nothing_new' })");
  });

  test('the control that reads this status still looks for non-2xx', () => {
    const ctl = read('supabase/migrations/20260806160000_dispatch_monitoring.sql');
    expect(ctl).toContain('net._http_response');
    expect(ctl).toMatch(/status_code\s*<\s*200\s*or\s*r\.status_code\s*>=\s*300/);
  });
});
