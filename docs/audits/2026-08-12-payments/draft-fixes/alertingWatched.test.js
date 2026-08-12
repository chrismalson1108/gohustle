// Drift guard for the alerting channel itself.
//
// Same job as pricing.test.js and categories.test.js: read the SQL off disk rather
// than trust a comment. What is guarded here is not arithmetic but the one property
// the control framework cannot check about itself — that turning alerting off is
// visible, bounded, and detected.
//
// THE DOMAIN FACT THIS TEST ENCODES. supabase/migrations applies in filename order
// and these functions are redefined with `create or replace` repeatedly, so the live
// behaviour is the LAST definition in timestamp order, not the one whose header reads
// most current. controls_sweep_and_page has been redefined four times. A fifth
// redefinition that quietly drops the dispatch logging would restore the exact blind
// spot this migration closed, and nothing else in the repo would notice. So every
// assertion below resolves the last definition first.
const fs = require('fs');
const path = require('path');

const MIG_DIR = path.join(__dirname, '..', 'supabase', 'migrations');
const FILES = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort();

// Which migration file holds the LAST `create or replace function public.<fn>`, and
// what is inside that definition's dollar-quoted body.
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
  let at = -1, m;
  while ((m = re.exec(sql))) at = m.index;
  const rest = sql.slice(at);
  const tag = rest.match(/\bas\s+(\$[a-z_]*\$)/i);
  if (!tag) return null;
  const start = rest.indexOf(tag[1]) + tag[1].length;
  const end = rest.indexOf(tag[1], start);
  return { file, body: rest.slice(start, end) };
}

const allSql = FILES.map((f) => fs.readFileSync(path.join(MIG_DIR, f), 'utf8')).join('\n');

describe('the alerting channel is itself watched', () => {
  test('a control reads app_flags and reports a channel that cannot dispatch', () => {
    const ctl = lastDefinition('ctl_alert_not_dispatching');
    expect(ctl).not.toBeNull();
    expect(ctl.body).toMatch(/public\.app_flags/);
    // Four distinct ways to the same silence. Covering only the switch would leave a
    // blanked url or a blanked secret undetected, and both are one console edit away.
    expect(ctl.body).toMatch(/not c\.present/);   // no row at all
    expect(ctl.body).toMatch(/not c\.enabled/);   // switched off
    expect(ctl.body).toMatch(/c\.url is null/);   // blanked url
    expect(ctl.body).toMatch(/c\.secret is null/); // blanked secret
    // Both channels, or the safety pager can die alone exactly as it did in July.
    expect(ctl.body).toContain("'controls_alert'");
    expect(ctl.body).toContain("'safety_alert'");
  });

  test('the control is registered, so run_all_controls will actually execute it', () => {
    // Wrapped in a boolean so a failure prints the claim, not every migration on disk.
    const registered = /'alert_not_dispatching'[\s\S]{0,4000}'ctl_alert_not_dispatching'/.test(allSql);
    expect({ registered }).toEqual({ registered: true });
  });

  test('liveness is proven from attempts, not inferred from absent failures', () => {
    const ctl = lastDefinition('ctl_alert_not_dispatching');
    expect(ctl.body).toMatch(/public\.alert_dispatches/);
    expect(ctl.body).toMatch(/max\(d\.attempted_at\)/);
    // net._http_response cannot answer "was a dispatch attempted?" — that is the whole
    // gap. If this control ever starts reading it instead, it is blind again.
    expect(ctl.body).not.toMatch(/_http_response/);
  });

  test('reconcile-stripe is logged under a DIFFERENT channel from the pager', () => {
    // The reconcile dispatch sits BEFORE the `if not on_` return, so it keeps firing
    // while paging is off. If both were logged as 'controls_alert', those rows would
    // satisfy the liveness check and certify a dead pager as alive.
    const sweep = lastDefinition('controls_sweep_and_page');
    expect(sweep).not.toBeNull();
    expect(sweep.body).toMatch(/log_alert_dispatch\(\s*'stripe_reconcile'/);
    expect(sweep.body).toMatch(/log_alert_dispatch\(\s*'controls_alert',\s*'page'/);
    const reconcileAt = sweep.body.indexOf("'stripe_reconcile'");
    const offReturn = sweep.body.search(/if\s+not\s+on_\s+then\s+return/);
    expect(offReturn).toBeGreaterThan(reconcileAt); // the ordering the split depends on
  });

  test('every dispatcher logs its attempt — checked on the LAST definition of each', () => {
    for (const [fn, mode] of [
      ['controls_sweep_and_page', 'page'],
      ['controls_digest', 'digest'],
      ['notify_safety_report', 'report'],
    ]) {
      const def = lastDefinition(fn);
      expect(def).not.toBeNull();
      expect({ fn, logged: /log_alert_dispatch\(/.test(def.body) }).toEqual({ fn, logged: true });
      expect(def.body).toContain(`'${mode}'`);
    }
  });

  test('a lapsed mute is lifted before the sweep reads the flag', () => {
    const sweep = lastDefinition('controls_sweep_and_page');
    const reenableAt = sweep.body.indexOf('reenable_expired_alert_flags');
    const readsFlag = sweep.body.indexOf("where key = 'controls_alert'");
    expect(reenableAt).toBeGreaterThan(-1);
    expect(readsFlag).toBeGreaterThan(reenableAt); // else the fix lands an hour late
  });

  test('auto-expiry covers the alerting flags and NOTHING that moves money', () => {
    // The controls table auto-expiry (20260806350000) is safe because re-enabling a
    // control only resumes looking. A kill switch that un-kills itself 24h into a
    // Stripe incident is the wrong-direction failure — this asserts the scope guard.
    const trg = lastDefinition('trg_alert_flag_disable_expires');
    expect(trg).not.toBeNull();
    expect(trg.body).toMatch(/new\.key\s+not\s+in\s*\(\s*'safety_alert',\s*'controls_alert'\s*\)/);

    const reen = lastDefinition('reenable_expired_alert_flags');
    expect(reen.body).toMatch(/key in \('safety_alert', 'controls_alert'\)/);
    for (const forbidden of ['payments_enabled', 'posting_enabled', 'signups_enabled',
      'tips_enabled', 'assistant_enabled', 'promotions_enabled', 'bonus_cash_payout_enabled']) {
      expect(trg.body).not.toContain(forbidden);
      expect(reen.body).not.toContain(forbidden);
    }
  });
});

describe('controls whose declared truth lives in app_flags have that row seeded', () => {
  // ctl_stripe_id_mode_mismatch is registered CRITICAL, gates both arms of its union on
  // mode = 'live', and reads app_flags.stripe_mode. setFlag only ever UPDATEs an
  // existing row, so an unseeded key can never come to exist from the console: the
  // control returns zero rows forever and reports green. Any future control that reads
  // a flag as its input needs the same seed, which is what this test is really for.
  test('stripe_mode exists, or ctl_stripe_id_mode_mismatch is structurally blind', () => {
    const mismatch = lastDefinition('ctl_stripe_id_mode_mismatch');
    expect(mismatch.body).toContain("key = 'stripe_mode'");
    const seeded = /insert into public\.app_flags[\s\S]{0,400}'stripe_mode'/.test(allSql);
    expect({ seeded }).toEqual({ seeded: true });
  });
});
