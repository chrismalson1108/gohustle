const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// The hourly sweep must claim service_role, or its housekeeping cannot write.
//
// controls_sweep_and_page is called by pg_cron (20260806030000:108), which sets no
// request.jwt.claims at all — so auth.role() and auth.uid() are both NULL inside it.
// expire_stale_pending_bookings is a plain `update public.bookings set status =
// 'cancelled'`, and guard_bookings_write exempts ONLY service_role before ending in
// `raise exception 'not authorized to modify this booking'`. So the first qualifying
// booking aborts the whole UPDATE — every hour, and invisibly, because the sweep wraps
// that call in `exception when others then raise warning`.
//
// This is a drift guard rather than a one-off fix, because the sweep body is COPIED
// forward: 20260813060000, 20260814070000 and this fix each re-declared the whole
// function to add one call. A future copy that starts from the wrong version silently
// drops the claim and restores the outage, with the exception block hiding it again.
//
// Asserting on the source is the only place this can be checked here — the suite is
// pure-logic Jest with no database — and it is also the right place: the expiry was
// correct all along and only ever had a caller that could not use it.
// ─────────────────────────────────────────────────────────────────────────────
const DIR = path.join(__dirname, '..', 'supabase', 'migrations');

function newestDefining(fnName) {
  const hits = fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) =>
      new RegExp(`create or replace function public\\.${fnName}\\b`, 'i').test(
        fs.readFileSync(path.join(DIR, f), 'utf8'),
      ),
    )
    .sort();
  if (!hits.length) return null;
  const file = hits[hits.length - 1];
  const sql = fs.readFileSync(path.join(DIR, file), 'utf8');
  const start = sql.toLowerCase().indexOf(`create or replace function public.${fnName}`);
  // Function bodies here are dollar-quoted; the body ends at the terminator of the tag
  // that opened it. Anything after that is a different statement and must not count.
  const tag = (sql.slice(start).match(/\bas\s+(\$[a-z_]*\$)/i) || [])[1];
  const bodyStart = tag ? sql.indexOf(tag, start) + tag.length : start;
  const bodyEnd = tag ? sql.indexOf(tag, bodyStart) : sql.length;
  return { file, body: sql.slice(bodyStart, bodyEnd === -1 ? sql.length : bodyEnd) };
}

describe('the hourly sweep can actually write', () => {
  it('the sweep is defined somewhere', () => {
    expect(newestDefining('controls_sweep_and_page')).not.toBeNull();
  });

  it('the newest sweep claims service_role for its own transaction', () => {
    const { file, body } = newestDefining('controls_sweep_and_page');
    const claims = /set_config\(\s*'request\.jwt\.claims'\s*,\s*'\{"role"\s*:\s*"service_role"\}'\s*,\s*true\s*\)/.test(
      body,
    );
    // Named in the failure so the next reader gets the remedy, not a boolean.
    expect(`${file}: ${claims ? 'claims service_role' : "NO CLAIM — pg_cron has no JWT, so guard_bookings_write raises and the expiry silently cancels nothing"}`)
      .toBe(`${file}: claims service_role`);
  });

  it('it claims BEFORE the guarded housekeeping it authorizes', () => {
    // A claim set after the writes is the same outage with a line of reassurance above it.
    const { file, body } = newestDefining('controls_sweep_and_page');
    const claimAt = body.search(/set_config\(\s*'request\.jwt\.claims'/);
    const guarded = ['expire_stale_pending_bookings', 'expire_dead_listings', 'vest_bonuses']
      .map((fn) => ({ fn, at: body.indexOf(fn) }))
      .filter((x) => x.at !== -1);
    expect(guarded.length).toBeGreaterThan(0);
    const late = guarded.filter((x) => claimAt === -1 || claimAt > x.at).map((x) => x.fn);
    expect(`${file}: ${late.join(', ') || 'none'}`).toBe(`${file}: none`);
  });

  it('the swallowed failure has a control that asserts the outcome instead', () => {
    // The sweep will keep swallowing errors — that is deliberate, the controls are the
    // load-bearing half and housekeeping must not take them down. What must not happen
    // again is that the swallowing is the ONLY record.
    const all = fs
      .readdirSync(DIR)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => fs.readFileSync(path.join(DIR, f), 'utf8'))
      .join('\n');
    expect(all).toMatch(/create or replace function public\.ctl_expiry_sweep_not_clearing\b/);
    expect(all).toMatch(/'expiry_sweep_not_clearing'/);
  });
});
