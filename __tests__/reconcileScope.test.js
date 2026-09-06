// ─────────────────────────────────────────────────────────────────────────────
// "Payments touched in the last N days" has to actually mean touched.
//
// reconcile-stripe's header promised that; the query filtered `.gte("created_at", …)`.
// On public.payments created_at is the timestamp of the FIRST hold ever placed — the row
// is upserted on booking_id and a recovery re-hold deliberately moves authorized_at and
// leaves created_at alone — and the table has no updated_at column at all. So the window
// was "accepted recently", while every event this control exists to catch (a Dashboard
// refund, a chargeback 30-90 days later, an admin refund whose ledger write failed)
// happens long after acceptance.
//
// That gap is load-bearing for one failure in particular: when an admin refund succeeds
// at Stripe and record_refund then fails, stripe-webhook skips filing anything (the
// refund_source='admin' in-flight marker is still fresh) and answers 200, so Stripe never
// retries and ctl_external_reversal_not_ledgered has no disputes row to read. Nothing but
// this reconciler can notice — and it was not looking.
//
// Two halves to the fix, and this file pins both, because either alone still has a blind
// spot: our own timestamps cannot see a Dashboard refund (it writes none of our columns),
// and a Stripe-side listing alone would not re-examine a row we mangled ourselves.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MIG = path.join(ROOT, 'supabase', 'migrations');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

function code(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

const reconcile = code(read('supabase', 'functions', 'reconcile-stripe', 'index.ts'));

const migrations = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();
const defining = migrations.filter((f) =>
  /create or replace function public\.payments_touched_since\b/i.test(
    fs.readFileSync(path.join(MIG, f), 'utf8'),
  ),
);
const touchedSql = defining.length
  ? fs.readFileSync(path.join(MIG, defining[defining.length - 1]), 'utf8')
  : '';

describe('the scope is what the row was last TOUCHED, not when it was created', () => {
  test('a migration defines payments_touched_since', () => {
    expect(defining.length).toBeGreaterThan(0);
  });

  test('it scopes and orders on the greatest of every timestamp the row carries', () => {
    // authorized_at is the one a recovery re-hold moves; refunded_at and cancelled_at
    // are the ones a reversal moves. Missing any of them re-opens the hole.
    for (const col of ['created_at', 'authorized_at', 'captured_at', 'refunded_at', 'cancelled_at']) {
      expect(touchedSql).toMatch(new RegExp(`\\b${col}\\b`));
    }
    expect(touchedSql).toMatch(/greatest\(/i);
    // Ordering is half the fix: an old-but-just-refunded row sorted behind 200 fresh
    // authorizations is dropped by the caller's limit exactly as before.
    expect(touchedSql).toMatch(/order by\s+(?:\w+\.)?touched_at desc/i);
  });

  test('it is service-role only — it returns every payment on the platform', () => {
    expect(touchedSql).toMatch(
      /revoke execute on function public\.payments_touched_since[\s\S]*?from public, anon, authenticated/i,
    );
    expect(touchedSql).toMatch(/grant execute on function public\.payments_touched_since[\s\S]*?to service_role/i);
  });

  test('the migration proves the old scope could not see the row', () => {
    // The probe stages a payment created 20 days ago and refunded ten minutes ago, and
    // asserts the created_at predicate returns 0 for it. Without that half the probe
    // would only show the new function works, not that it discriminates.
    expect(touchedSql).toMatch(/created_at >= now\(\) - interval '14 days'/);
    expect(touchedSql).toMatch(/FIX FAILED/);
    expect(touchedSql).toMatch(/probe complete — rolling back/);
  });

  test('reconcile-stripe asks for the touched scope, not a created_at filter', () => {
    expect(reconcile).toMatch(/rpc\("payments_touched_since"/);
    // The old form, gone. This is the assertion that fails on the pre-fix file.
    expect(reconcile).not.toMatch(/\.gte\("created_at"/);
  });
});

describe('a reversal that touched none of our columns is still examined', () => {
  test('the run lists Stripe refunds and disputes created in the same window', () => {
    expect(reconcile).toMatch(/stripe\.refunds\.list\(\{\s*created:\s*\{\s*gte:\s*sinceUnix/);
    expect(reconcile).toMatch(/stripe\.disputes\.list\(\{\s*created:\s*\{\s*gte:\s*sinceUnix/);
  });

  test('the payments those reversals name are pulled in by id, regardless of age', () => {
    expect(reconcile).toMatch(/reversalPis/);
    expect(reconcile).toMatch(/pullIn\(/);
    expect(reconcile).toMatch(/"payment_intent_id"/);
  });

  test('payments already carrying an open finding are re-examined so one can clear', () => {
    const block = reconcile.slice(reconcile.indexOf('control_findings'));
    expect(block.slice(0, 400)).toMatch(/eq\("control_key", CONTROL_KEY\)/);
    expect(block.slice(0, 400)).toMatch(/is\("resolved_at", null\)/);
    // "config" is this function's own non-uuid entity; an `in` filter carrying it
    // fails the whole query and would silently drop pass 3.
    expect(reconcile).toMatch(/!==\s*"config"/);
  });

  test('a scan that could not complete is reported, never smoothed over', () => {
    // last_error: null on a partial scan is the board reading green off less work than
    // it claims — the exact failure this whole function exists to prevent.
    expect(reconcile).toMatch(/const warnings: string\[\] = \[\]/);
    expect(reconcile).toMatch(/last_error: warnings\.length \? warnings\.join/);
    expect(reconcile).not.toMatch(/last_error: null,\n\s*\}\)\.eq\("key", CONTROL_KEY\)/);
  });
});
