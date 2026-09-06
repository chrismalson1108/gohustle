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

// ─────────────────────────────────────────────────────────────────────────────
// The other half of that exemption: what may raise an emergency at all.
//
// The limiter exemption is safe only because of the premise written beside it — "an
// emergency raised from an active gig". raise_gig_emergency did not enforce it: its
// only gate was "are you one of the two parties", in ANY booking status, and there was
// no dedupe. bookings_insert_own is a unilateral client write and the RPC is granted to
// `authenticated`, so a plain account could apply to gigs and then loop a limiter-exempt
// call that pages the on-call, fills the moderation queue and blocks the counterparty's
// account deletion every time.
//
// Asserted against the NEWEST definition in the directory rather than one file, because
// the failure mode is a later migration reproducing the function and dropping a clause —
// which is exactly how the source-pin exemption above was reopened once already.
// ─────────────────────────────────────────────────────────────────────────────
const MIG_DIR = path.join(__dirname, '..', 'supabase', 'migrations');
const SOS_DECL = /create or replace function public\.raise_gig_emergency[\s\S]*?\$\$;/g;

function newestSosDefinition() {
  const files = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort();
  let latest = null;
  for (const f of files) {
    const sql = fs.readFileSync(path.join(MIG_DIR, f), 'utf8');
    const hits = sql.match(SOS_DECL);
    if (hits) latest = { file: f, body: hits[hits.length - 1] };
  }
  return latest;
}

describe('raise_gig_emergency: what may page the safety team', () => {
  const sos = newestSosDefinition();

  test('the function exists somewhere in the migrations', () => {
    expect(sos).not.toBeNull();
  });

  test('refuses a booking the counterparty never accepted', () => {
    // The same status set job_locations_party_read and gig_shares_insert_own use. A
    // 'pending' booking is one person's application, and it costs the attacker nothing.
    expect(sos.body).toMatch(
      /status\s+not in \(\s*'confirmed',\s*'completed',\s*'verified'\s*\)/,
    );
    // And it must actually refuse, not merely notice.
    expect(sos.body).toMatch(/raise exception[\s\S]{0,400}check_violation/);
  });

  test('selects the booking status at all', () => {
    // A status predicate is unreachable if the row never carried the column.
    expect(sos.body).toMatch(/bk\.status/);
  });

  test('a repeat press returns the OPEN emergency instead of paging again', () => {
    // One open alarm per person per gig: the dedupe read, scoped to this reporter and
    // this booking, restricted to unresolved emergencies.
    expect(sos.body).toMatch(/from public\.reports/);
    expect(sos.body).toMatch(/r\.source = 'emergency'/);
    expect(sos.body).toMatch(/r\.resolved_at is null/);
    expect(sos.body).toMatch(/r\.reporter_id = uid/);
    // Returning early is what makes it one page rather than N.
    expect(sos.body).toMatch(/if rid is not null then[\s\S]*?return rid;/);
  });

  test('the dedupe is serialised, so two simultaneous presses cannot both insert', () => {
    expect(sos.body).toMatch(/pg_advisory_xact_lock/);
  });

  test('a genuine first SOS is still unthrottled and still marked emergency', () => {
    // The exemption GUC and the source tag are the whole reason this path exists; a fix
    // that dropped either would silently turn every SOS into an ordinary report.
    expect(sos.body).toMatch(/set_config\('app\.emergency', 'on', true\)/);
    expect(sos.body).toMatch(/insert into public\.reports[\s\S]*?'emergency'\)/);
  });
});
