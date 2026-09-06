// Drift guard for the one property the hourly sweep cannot check about itself:
// that its housekeeping can actually WRITE from the context pg_cron gives it.
//
// THE FAILURE THIS ENCODES. expire_stale_pending_bookings shipped on 2026-08-12 as a
// bare `update public.bookings set status = 'cancelled'` inside a SECURITY DEFINER
// function. SECURITY DEFINER changes the database role, not the request claim, and
// pg_cron runs `select public.controls_sweep_and_page()` with no request.jwt.claims at
// all — so auth.role() and auth.uid() are both NULL, guard_bookings_write matches
// neither the service_role exemption nor either party branch, and it raises. The sweep
// wraps every housekeeping step in `exception when others then raise warning`, so the
// failure never left the Postgres log, and a row-level trigger does not fire on an
// UPDATE that matches nothing — meaning the sweep looked green on every hour it had
// nothing to do and failed silently on every hour it did.
//
// That shape is invisible to every other guard in this suite: the SQL is valid, the
// function is registered, the sweep calls it, and the migration's own DO block passes
// because a migration sets a service_role claim at the top of the file. Only the
// combination is wrong, and only from a context no test can enter.
//
// SAME METHOD AS alertingWatched.test.js: migrations apply in filename order and these
// functions are redefined with `create or replace`, so live behaviour is the LAST
// definition on disk. Comments are stripped before anything is asserted — this file's
// subject is a fix whose header prose names every token it looks for, so an
// unstripped read would pass on the explanation alone.
const fs = require('fs');
const path = require('path');

const MIG_DIR = path.join(__dirname, '..', 'supabase', 'migrations');
const FILES = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort();

const stripComments = (sql) => sql.replace(/--[^\n]*/g, '');

// Which migration holds the LAST `create or replace function public.<fn>`, and what is
// inside that definition's dollar-quoted body.
function lastDefinition(fn) {
  const re = new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${fn}\\s*\\(`, 'gi');
  let file = null;
  for (const f of FILES) {
    re.lastIndex = 0;
    if (re.test(fs.readFileSync(path.join(MIG_DIR, f), 'utf8'))) file = f;
  }
  if (!file) return null;

  const sql = fs.readFileSync(path.join(MIG_DIR, file), 'utf8');
  re.lastIndex = 0;
  let at = -1;
  let m;
  while ((m = re.exec(sql))) at = m.index;
  const rest = sql.slice(at);
  const tag = rest.match(/\bas\s+(\$[a-z_]*\$)/i);
  if (!tag) return null;
  const start = rest.indexOf(tag[1]) + tag[1].length;
  const end = rest.indexOf(tag[1], start);
  return { file, body: stripComments(rest.slice(start, end)) };
}

const norm = (s) => s.replace(/\s+/g, ' ');

describe('the hourly sweep can expire a stale application from cron, which carries no JWT', () => {
  test('expire_stale_pending_bookings is still reached by the sweep', () => {
    // The fix below is worthless if nothing calls it. 20260814070000 is the file that
    // caught the sibling case — purge_assistant_pending_actions was correct for months
    // and simply had no caller.
    const sweep = lastDefinition('controls_sweep_and_page');
    expect(sweep).not.toBeNull();
    expect(sweep.body).toMatch(/expire_stale_pending_bookings/);
  });

  test('the write is authorised in a claimless context, one way or the other', () => {
    const fn = lastDefinition('expire_stale_pending_bookings');
    expect(fn).not.toBeNull();
    const body = norm(fn.body);

    // Route A — the function borrows service_role for its own UPDATE (what the fix in
    // 20260906042000 does).
    const claimsServiceRole =
      /set_config\s*\(\s*'request\.jwt\.claims'\s*,\s*'\{\s*"role"\s*:\s*"service_role"\s*\}'\s*,\s*true\s*\)/.test(body);

    // Route B — guard_bookings_write itself exempts the claimless context, the way
    // guard_jobs_delete has since 20260625020000. Equally valid; asserting only route A
    // would make this guard refuse a legitimate future fix.
    const guard = lastDefinition('guard_bookings_write');
    expect(guard).not.toBeNull();
    const guardExemptsClaimless =
      /current_setting\s*\(\s*'request\.jwt\.claims'\s*,\s*true\s*\)\s+is\s+null/.test(norm(guard.body));

    expect({
      claim: 'the stale-pending sweep can write from pg_cron',
      authorised: claimsServiceRole || guardExemptsClaimless,
    }).toEqual({ claim: 'the stale-pending sweep can write from pg_cron', authorised: true });
  });

  test('a borrowed claim is handed back before the rest of the sweep runs', () => {
    // run_all_controls runs in the same statement immediately afterwards. A leaked
    // service_role identity would change what every control sees, which is a quieter
    // version of the same class of bug.
    const fn = lastDefinition('expire_stale_pending_bookings');
    const body = norm(fn.body);
    const borrows =
      /set_config\s*\(\s*'request\.jwt\.claims'\s*,\s*'\{\s*"role"\s*:\s*"service_role"\s*\}'\s*,\s*true\s*\)/.test(body);
    if (!borrows) return; // route B: nothing was borrowed, so there is nothing to restore.

    // It must read the caller's claim first...
    expect(body).toMatch(/current_setting\s*\(\s*'request\.jwt\.claims'\s*,\s*true\s*\)/);
    // ...and the LAST write to the claim must not be the borrowed identity.
    const writes = [...body.matchAll(/set_config\s*\(\s*'request\.jwt\.claims'\s*,([^;]*?),\s*true\s*\)/g)];
    expect(writes.length).toBeGreaterThanOrEqual(2);
    expect(writes[writes.length - 1][1]).not.toMatch(/service_role/);
  });

  test('the sweep still refuses the rows a human has to see', () => {
    // A sweep that now works must not have become a sweep that tidies away money and
    // disagreements. Both exclusions are load-bearing: started_at means an earner began
    // work that was never accepted (a dispute), and an 'authorized' payment means real
    // money sits on a real card that only Stripe can release.
    const body = norm(lastDefinition('expire_stale_pending_bookings').body);
    expect(body).toMatch(/started_at is null/);
    expect(body).toMatch(/status = 'authorized'/);
  });
});
