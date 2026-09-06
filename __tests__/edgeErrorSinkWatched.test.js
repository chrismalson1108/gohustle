// Drift guard for the edge error sink.
//
// THE FINDING THIS ENCODES. _shared/logError.ts exists because a failed escrow capture
// used to `console.error(...)` and stop there, so "the poster pressed pay and it silently
// didn't work" was invisible until someone complained. It routes every money edge
// function's failures into public.client_errors — and for two months nothing read that
// table on a schedule. Its only consumers were the /errors console page and a dashboard
// tile, i.e. things that run when a human opens them. That is exactly the shape
// 20260806010000 rejected when it put the control engine in Postgres rather than in a
// Next.js route: "a check that runs in a Next.js route only runs when a human opens a
// page." The sink was a report wearing a monitor's job.
//
// Every assertion below fails on the code as it stood before 20260906051000: there was no
// ctl_ function reading client_errors and no registry row naming one, so the first test
// alone is the discriminator. The rest guard the properties that would let the control
// exist and still not work.
//
// TWO DOMAIN FACTS ENCODED HERE, both borrowed from alertingWatched.test.js because they
// have bitten this repo before:
//   1. migrations apply in FILENAME order and ctl_ functions are redefined with
//      `create or replace`, so live behaviour is the LAST definition on disk.
//   2. comments are stripped before anything is asserted — four guards in this repo have
//      been satisfied by the prose explaining them, and this file's own migration header
//      names every string these tests look for.
const fs = require('fs');
const path = require('path');

const MIG_DIR = path.join(__dirname, '..', 'supabase', 'migrations');
const FILES = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort();

const stripComments = (sql) => sql.replace(/--[^\n]*/g, '');

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

const allSql = FILES.map((f) => fs.readFileSync(path.join(MIG_DIR, f), 'utf8')).join('\n');
const codeSql = stripComments(allSql);

// The registry tuple for one control key, from the LAST migration that carries it —
// registry rows are upserted with `on conflict do update`, so a later file wins the same
// way a later `create or replace` wins for a function body.
function lastRegistryRow(key) {
  const re = new RegExp(`\\(\\s*'${key}',([\\s\\S]{0,4000}?)'ctl_${key}'\\)`);
  let hit = null;
  for (const f of FILES) {
    const m = stripComments(fs.readFileSync(path.join(MIG_DIR, f), 'utf8')).match(re);
    if (m) hit = m[1];
  }
  return hit;
}

// Every ctl_ function on disk, and the body of its last definition. The general guard
// below needs the whole set, not just the new one.
const CTL_FNS = [...new Set([...allSql.matchAll(/create or replace function public\.(ctl_[a-z0-9_]+)\s*\(/g)]
  .map((m) => m[1]))];

const FN_DIR = path.join(__dirname, '..', 'supabase', 'functions');

describe('something on a schedule reads the edge error sink', () => {
  test('the sink has callers worth watching — money functions log into it', () => {
    // The premise. If logServerError ever loses its callers the control below is
    // watching an empty table and this test says so rather than passing vacuously.
    const callers = fs.readdirSync(FN_DIR)
      .filter((d) => fs.existsSync(path.join(FN_DIR, d, 'index.ts')))
      .filter((d) => fs.readFileSync(path.join(FN_DIR, d, 'index.ts'), 'utf8').includes('logServerError('));
    expect(callers.length).toBeGreaterThan(0);

    // The four that cannot fail quietly: each is a step a person is standing in front of
    // waiting for money to move.
    for (const fn of ['stripe-capture-payment', 'stripe-create-payment-intent',
      'accept-booking', 'earner-claim-payment']) {
      expect({ fn, logsToSink: callers.includes(fn) }).toEqual({ fn, logsToSink: true });
    }

    // And the sink writes where the control looks. If logError.ts ever retags its rows,
    // the control's platform filter silently matches nothing.
    const sink = fs.readFileSync(path.join(FN_DIR, '_shared', 'logError.ts'), 'utf8');
    expect(sink).toMatch(/from\('client_errors'\)/);
    expect(sink).toMatch(/platform:\s*'edge'/);
    expect(sink).toMatch(/app_version:\s*fn/);
  });

  test('a REGISTERED control reads client_errors', () => {
    // The finding itself. Before 20260906051000 this set was empty: the table had a
    // console page and a dashboard tile and no scheduled reader at all. Asserting on the
    // registered set rather than on one name lets a future rewrite rename or replace the
    // control without reopening the hole silently.
    const registered = new Set(
      [...codeSql.matchAll(/'(ctl_[a-z0-9_]+)'\s*\)/g)].map((m) => m[1]),
    );
    const watchers = CTL_FNS
      .filter((fn) => registered.has(fn))
      .filter((fn) => lastDefinition(fn).body.includes('client_errors'));
    expect({ watchers }).toEqual({ watchers: ['ctl_edge_errors_burst'] });
  });

  test('it is registered at a severity that actually pages', () => {
    // controls-alert's page mode emails only for NEW critical/high findings
    // (controls-alert/index.ts filters `['critical','high'].includes(f.severity)`), so a
    // control filed at medium shows on /controls and wakes nobody — which is the same
    // "visible only to a reader" failure this fix exists to end.
    //
    // Matched inside the LAST migration that carries the row (registry rows are upserted
    // with `on conflict do update`, so a later file wins) and bounded to the row's own
    // tuple. An unbounded [\s\S]*? across every migration on disk would swallow another
    // control's 'high' and pass whatever this one is filed as.
    const row = lastRegistryRow('edge_errors_burst');
    expect(row).not.toBeNull();
    expect(row).toMatch(/'high'/);
    expect(row).toMatch(/'money'/);
  });
});

describe('the control can actually see a burst, and stops seeing one that ended', () => {
  const ctl = () => lastDefinition('ctl_edge_errors_burst');

  test('it is scoped to edge rows and excludes local dev noise', () => {
    const body = ctl().body;
    expect(body).toMatch(/public\.client_errors/);
    expect(body).toMatch(/platform\s*=\s*'edge'/);
    // 20260804010000 added `dev` precisely so a Metro crash on this laptop is not filed
    // as a production incident. A control that pages on one is a control someone mutes.
    expect(body).toMatch(/dev\s*=\s*false/);
  });

  test('its window is rolling, and at least as long as the gap between sweeps', () => {
    // Two failures in one assertion, both real:
    //   * no window at all → the finding never auto-resolves, because run_control only
    //     resolves what a control STOPS returning. A burst from July would page forever.
    //   * a window shorter than the sweep interval → a burst can start and end entirely
    //     between two sweeps and nothing ever sees it.
    const body = ctl().body;
    const win = body.match(/now\(\)\s*-\s*interval\s*'(\d+)\s*minutes'/);
    expect(win).not.toBeNull();

    // pg_cron: '5 * * * *' — hourly at :05.
    const sched = allSql.match(/cron\.schedule\('controls_sweep',\s*'([^']+)'/);
    expect(sched).not.toBeNull();
    expect(sched[1]).toMatch(/^\d+ \* \* \* \*$/); // hourly; if it stops being, retune below
    expect(Number(win[1])).toBeGreaterThanOrEqual(60);
  });

  test('it emits one row per function, so run_control can record the findings', () => {
    // control_findings is unique on (control_key, entity_id) where resolved_at is null,
    // and run_control's upsert aborts the WHOLE control with a cardinality violation if a
    // single run returns two rows sharing an entity_id. The control is then recorded as
    // ERRORED — a more confusing failure than the one it exists to report. Grouping by
    // the function name is what guarantees the shape.
    const body = ctl().body;
    expect(body).toMatch(/app_version/);
    expect(body).toMatch(/group by/i);
    // And it must not be a naked select of raw rows: one finding per error row would put
    // the entity_id on something that is not the function.
    expect(body).toMatch(/having/i);
  });

  test('it names why it tripped, so the digest is actionable at 2am', () => {
    // Slugs rather than sentences, the same choice ctl_alert_not_dispatching makes: they
    // are greppable and they survive rewording on a finding that persists across runs.
    const body = ctl().body;
    for (const slug of ['fatal_burst', 'volume_burst']) {
      expect({ slug, named: body.includes(`'${slug}'`) }).toEqual({ slug, named: true });
    }
    // The fatal arm is the one that catches a rotated key on the first sweep. If the
    // `fatal` column stops being read, the control degrades to pure volume and a money
    // function failing three times an hour on every call goes unreported.
    expect(body).toMatch(/filter\s*\(\s*where fatal\s*\)/i);
  });

  test('it does not fall back to the thing that already only runs for a reader', () => {
    // admin_dashboard_metrics' errors_fatal_7d tile counts the same rows and renders when
    // a human opens the console — that is the blind spot, not the fix. If this control
    // ever starts calling it, the hole is open again with a control's name on it.
    expect(ctl().body).not.toMatch(/admin_dashboard_metrics/);
  });
});
