// Drift guard for the alerting channel itself.
//
// Same job as pricing.test.js and categories.test.js: read the SQL off disk rather than
// trust a comment. What is guarded here is not arithmetic but the one property the
// control framework cannot check about itself — that turning alerting off is visible and
// bounded.
//
// TWO DOMAIN FACTS THIS TEST ENCODES.
//
// 1. supabase/migrations applies in filename order and these functions are redefined with
//    `create or replace` repeatedly, so live behaviour is the LAST definition in that
//    order, not the one whose header reads most current. controls_sweep_and_page has seven
//    definitions on disk. Every assertion below resolves the last one first.
//
// 2. Comments are stripped before anything is asserted. Four guards in this repo have
//    been satisfied by the prose explaining them, and this file would be the fifth in
//    both directions at once: the scope test below asserts payments_enabled does NOT
//    appear in the auto-expiry functions, and those functions carry a comment saying
//    exactly why it must not.
const fs = require('fs');
const path = require('path');

const MIG_DIR = path.join(__dirname, '..', 'supabase', 'migrations');
const FILES = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort();

// Line comments only. Block comments are not used in these migrations, and no string
// literal in any body resolved here contains `--` (the prose uses em dashes), so this
// cannot eat code.
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

const allSql = FILES.map((f) => fs.readFileSync(path.join(MIG_DIR, f), 'utf8')).join('\n');

// The three functions that decide whether an alert leaves the database. Each reads a
// flag and returns before net.http_post.
const DISPATCHERS = ['controls_sweep_and_page', 'controls_digest', 'notify_safety_report'];

describe('the alerting channel is itself watched', () => {
  test('a control reads app_flags and reports a channel that cannot dispatch', () => {
    const ctl = lastDefinition('ctl_alert_not_dispatching');
    expect(ctl).not.toBeNull();
    expect(ctl.body).toMatch(/public\.app_flags/);
    // Four distinct ways to the same silence. Covering only the switch would leave a
    // blanked url or a blanked secret undetected, and either is one SQL edit away.
    for (const cause of ['no_app_flags_row', 'switched_off', 'blank_url', 'blank_secret']) {
      expect({ cause, covered: ctl.body.includes(`'${cause}'`) }).toEqual({ cause, covered: true });
    }
  });

  test('the control is registered, so run_all_controls will actually execute it', () => {
    // run_all_controls iterates the REGISTRY, not the schema: an unregistered ctl_*
    // function is dead code that looks like coverage. Wrapped in a boolean so a failure
    // prints the claim rather than every migration on disk.
    const registered = /'alert_not_dispatching'[\s\S]{0,4000}'ctl_alert_not_dispatching'\)/.test(allSql);
    expect({ registered }).toEqual({ registered: true });
  });

  test('every flag a dispatcher gates on is covered by the control', () => {
    // The guard that survives a fourth channel being added. A new dispatcher keyed on a
    // new app_flags row would otherwise be silenceable with nothing watching it, which is
    // the whole finding, reopened.
    const gated = new Set();
    for (const fn of DISPATCHERS) {
      const def = lastDefinition(fn);
      expect({ fn, found: def !== null }).toEqual({ fn, found: true });
      for (const m of def.body.matchAll(/from public\.app_flags where key = '([a-z_]+)'/g)) {
        gated.add(m[1]);
      }
    }
    expect([...gated].sort()).toEqual(['controls_alert', 'safety_alert']);

    const ctl = lastDefinition('ctl_alert_not_dispatching');
    for (const key of gated) {
      expect({ key, watched: ctl.body.includes(`'${key}'`) }).toEqual({ key, watched: true });
    }
  });

  test('the control resolves config the way the dispatcher does, GUC fallback included', () => {
    // notify_safety_report still falls back to app.safety_alert_url / _secret. A control
    // that read only app_flags would report a working safety pager as dark on any project
    // that sets them — and a control that cries wolf is a control somebody deletes.
    const ctl = lastDefinition('ctl_alert_not_dispatching');
    const gucs = new Set();
    for (const fn of DISPATCHERS) {
      for (const m of lastDefinition(fn).body.matchAll(/current_setting\('(app\.[a-z_]+)'/g)) {
        gucs.add(m[1]);
      }
    }
    expect(gucs.size).toBeGreaterThan(0);
    for (const guc of gucs) {
      expect({ guc, honoured: ctl.body.includes(guc) }).toEqual({ guc, honoured: true });
    }
  });

  test('it does not fall back to the blind spot it was written to cover', () => {
    // net._http_response records only dispatches that were ATTEMPTED. That is precisely
    // what ctl_alert_dispatch_failing already reads, and precisely why a channel that is
    // switched off produces nothing. If this control ever starts reading it, the hole is
    // open again with a control's name on it.
    const ctl = lastDefinition('ctl_alert_not_dispatching');
    expect(ctl.body).not.toMatch(/_http_response/);
  });
});

describe('turning alerting off is bounded, and bounded only there', () => {
  test('auto-expiry covers the alerting flags and NOTHING that moves money', () => {
    // The controls-table auto-expiry (20260806350000) is safe because re-enabling a
    // control only resumes looking. A kill switch that un-kills itself 24 hours into a
    // Stripe incident is the wrong-direction failure, so this asserts the scope guard on
    // both halves — the stamp and the sweeper.
    const trg = lastDefinition('trg_alert_flag_disable_expires');
    const reen = lastDefinition('reenable_expired_alert_flags');
    expect(trg).not.toBeNull();
    expect(reen).not.toBeNull();
    expect(trg.body).toMatch(/new\.key not in \('safety_alert', 'controls_alert'\)/);
    expect(reen.body).toMatch(/key in \('safety_alert', 'controls_alert'\)/);

    for (const forbidden of ['payments_enabled', 'posting_enabled', 'signups_enabled',
      'tips_enabled', 'assistant_enabled', 'promotions_enabled', 'bonus_cash_payout_enabled']) {
      expect({ forbidden, inTrigger: trg.body.includes(forbidden) })
        .toEqual({ forbidden, inTrigger: false });
      expect({ forbidden, inSweeper: reen.body.includes(forbidden) })
        .toEqual({ forbidden, inSweeper: false });
    }
  });

  test('a lapsed mute is lifted before the sweep reads the flag', () => {
    // The ordering chain, across two functions. run_all_controls lifts it; the sweep runs
    // run_all_controls and only then reads `enabled` to decide whether to page. Break
    // either link and the fix lands an hour late — or, for the daily digest, a day late.
    const runner = lastDefinition('run_all_controls');
    expect(runner.body).toMatch(/reenable_expired_alert_flags/);

    const sweep = lastDefinition('controls_sweep_and_page');
    const runsControls = sweep.body.indexOf('run_all_controls');
    const readsFlag = sweep.body.search(/from public\.app_flags where key = 'controls_alert'/);
    expect(runsControls).toBeGreaterThan(-1);
    expect(readsFlag).toBeGreaterThan(runsControls);
  });

  test('the expiry column exists on app_flags, not only on controls', () => {
    // Cheap, and it catches the half-applied version of this change: a re-enable function
    // that queries a column no migration ever added fails closed, silently, forever.
    expect(allSql).toMatch(/alter table public\.app_flags[\s\S]{0,200}disabled_until/);
  });
});
