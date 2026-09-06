const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// The dead-man's switch has four parts, and any one of them going missing restores the
// original gap in full silence.
//
// Every alert this platform sends is dispatched from inside a pg_cron job. If pg_cron
// stops, controls.last_run_at simply freezes: no control runs, no finding is written,
// no email is sent, and /controls renders an amber banner nobody is standing in front
// of. That cannot be caught by a control, because a control is run BY the thing that
// stopped — so the check lives outside Postgres, in a Vercel cron on the admin project,
// and the database watches THAT end through ctl_heartbeat_absent.
//
// Four parts, each of which fails silently on its own:
//   · the RPC the outside world reads               (controls_heartbeat)
//   · the route that reads it and pages             (admin/app/api/controls-heartbeat)
//   · the cron that calls the route                 (admin/vercel.json)
//   · the proxy exclusion that lets the call land   (admin/proxy.ts)
//
// The fourth is the one worth a test on its own. proxy.ts redirects any signed-out
// request to /login, and a cron invocation carries no session cookie — so with /api
// inside the matcher, Vercel follows the 307, records a 2xx, reports the cron as
// healthy, and the heartbeat never runs once. A monitoring path that fails by looking
// successful is precisely the failure the heartbeat exists to catch.
// ─────────────────────────────────────────────────────────────────────────────
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const migrationDir = path.join(ROOT, 'supabase/migrations');
const sql = fs.readdirSync(migrationDir)
  .filter((f) => f.endsWith('.sql'))
  .map((f) => fs.readFileSync(path.join(migrationDir, f), 'utf8'))
  .join('\n');

const ROUTE = 'admin/app/api/controls-heartbeat/route.ts';

describe('the database exposes a heartbeat the outside world can read', () => {
  it('controls_heartbeat() exists', () => {
    expect(/create or replace function public\.controls_heartbeat\s*\(\s*\)/.test(sql))
      .toBe(true);
  });

  it('it is service-role only — control health is reconnaissance, not public data', () => {
    expect(sql).toContain(
      'revoke execute on function public.controls_heartbeat() from public, anon, authenticated',
    );
    expect(sql).toContain('grant  execute on function public.controls_heartbeat() to service_role');
  });

  it('it reports staleness from the registry, not from cron alone', () => {
    // A cron.job row that exists and never fires is the same outage as a missing row.
    // Reading only cron.job would call that healthy.
    const body = sql.slice(sql.indexOf('function public.controls_heartbeat'));
    expect(body.slice(0, 4000)).toMatch(/max\(last_run_at\)[\s\S]{0,120}from public\.controls/);
  });
});

describe('both halves of the mutual watch are registered controls', () => {
  // Registration is what makes them run: run_all_controls iterates the REGISTRY, so an
  // unregistered ctl_ function reports nothing forever while the board shows green.
  ['cron_not_scheduled', 'heartbeat_absent'].forEach((key) => {
    it(`ctl_${key} is defined and registered`, () => {
      expect(new RegExp(`create or replace function public\\.ctl_${key}\\s*\\(`).test(sql)).toBe(true);
      expect(new RegExp(`'ctl_${key}'\\s*\\)`).test(sql)).toBe(true);
    });
  });

  it('ctl_heartbeat_absent arms itself, so wiring the cron up is the only step', () => {
    // The grace window is seeded by the migration and REMOVED by the first successful
    // check-in. Without that, the control is either red on arrival (and gets disabled)
    // or needs a manual arming step nobody remembers.
    expect(sql).toContain("jsonb_build_object('grace_until'");
    expect(sql).toMatch(/value\s*-\s*'grace_until'/);
  });
});

describe('the external watcher exists, is scheduled, and can be reached', () => {
  const route = read(ROUTE);
  const vercel = JSON.parse(read('admin/vercel.json'));
  const proxy = read('admin/proxy.ts');

  it('admin/vercel.json schedules the heartbeat', () => {
    const crons = vercel.crons ?? [];
    expect(crons.map((c) => c.path)).toContain('/api/controls-heartbeat');
  });

  it('every scheduled cron path resolves to a route handler that exists', () => {
    // A cron pointing at a path with no handler 404s on a schedule and reports nothing.
    for (const c of vercel.crons ?? []) {
      const handler = path.join(ROOT, 'admin/app', c.path.replace(/^\//, ''), 'route.ts');
      expect(`${c.path}: ${fs.existsSync(handler) ? 'exists' : 'NO ROUTE HANDLER'}`)
        .toBe(`${c.path}: exists`);
    }
  });

  it('proxy.ts does not swallow /api — the cron carries no session cookie', () => {
    // THE discriminating assertion. Before this change the matcher was
    //   "/((?!_next/static|_next/image|favicon.ico|robots.txt).*)"
    // which matches /api/controls-heartbeat, so `!user && !isAuthRoute` redirected the
    // cron to /login. Vercel follows the redirect, sees a 200, and calls the invocation
    // a success — the heartbeat is dead and the cron log says it is fine.
    const matcher = /matcher:\s*\[([\s\S]*?)\]/.exec(proxy);
    expect(matcher).not.toBeNull();
    expect(`api excluded from the proxy matcher: ${/api\//.test(matcher[1]) ? 'yes' : 'NO — a cron invocation would be 307d to /login and silently never run'}`)
      .toBe('api excluded from the proxy matcher: yes');
  });

  it('the route authenticates itself, because the proxy no longer does', () => {
    expect(route).toContain('CRON_SECRET');
    expect(route).toContain('timingSafeEqual');
    // Fail closed: an unset secret must refuse, never wave the caller through.
    expect(route).toMatch(/if\s*\(!expected\)\s*return json\(\{\s*error:\s*"not_configured"\s*\},\s*503\)/);
  });
});

describe('the watcher does not share a transport with the thing it watches', () => {
  const route = read(ROUTE);

  it('it emails directly and never dispatches through controls-alert', () => {
    // controls-alert is invoked by the dead sweep and gated on app_flags.controls_alert,
    // which is mutable from the console. Routing the heartbeat through it would mean
    // silencing the pager also silences the check on the pager.
    //
    // Comments are stripped first: this file explains that decision in prose, and a
    // guard that matched the explanation instead of the code would be the same
    // prose-instead-of-code failure the rest of this suite exists to prevent.
    const code = route.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).toContain('https://api.resend.com/emails');
    expect(`dispatches through the sweep's own channel: ${/functions\.supabase\.co|controls-alert/.test(code) ? 'YES — it would go dark with the thing it watches' : 'no'}`)
      .toBe("dispatches through the sweep's own channel: no");
    // No read of app_flags either: whether to speak must not be a decision the console
    // can switch off.
    expect(`gated on a database flag: ${/app_flags/.test(code) ? 'YES' : 'no'}`).toBe('gated on a database flag: no');
  });

  it('a failed RPC pages rather than returning quietly', () => {
    // "I could not ask" and "the answer was bad" must both speak. Only a clean ok is
    // silent — otherwise the heartbeat goes quiet exactly when the database is least
    // able to speak for itself.
    expect(route).toMatch(/if\s*\(!hb\)\s*\{[\s\S]{0,400}await page\(/);
    expect(route).toMatch(/verdict:\s*"blind"/);
  });

  it('a missing email transport is reported, not thrown', () => {
    // A 500 here reads as "the heartbeat is broken" when the truth is "the controls are".
    expect(route).toMatch(/RESEND_API_KEY[\s\S]{0,400}return false/);
  });
});
