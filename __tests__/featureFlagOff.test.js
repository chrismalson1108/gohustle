// A paused kill switch must cost a line in the digest.
//
// The registry watched a disabled CONTROL (ctl_control_disabled, 20260806280000) and a
// muted ALERT channel (ctl_alert_not_dispatching, 20260814100000), and watched neither
// half of a paused FEATURE. payments_enabled=false was visible on exactly one surface —
// a red pill on /flags — so a pause taken during an incident could outlive the incident
// by days while /controls, the hourly page and the daily digest all read clean.
//
// This guard encodes three properties of the fix that prose cannot hold:
//
//   1. A control exists, is registered, and reads app_flags. Without the registry row the
//      function never runs (run_all_controls iterates the REGISTRY) and the board still
//      shows green — which is the failure one level up from the one being fixed.
//
//   2. It watches by DEFAULT. The tempting implementation is a list of the six switches
//      that exist today, which reproduces the same bug one flag later: switch number
//      seven would be unwatched, silently, exactly as these six were. So no kill-switch
//      key may appear in the control's body at all — the only key literals allowed are
//      the two alert channels, which have their own control.
//
//   3. It never repairs. A timer that resumes taking money 24 hours into a Stripe
//      incident is the wrong-direction failure, and 20260814100000 deliberately kept the
//      product switches out of the alert flags' auto-expiry for exactly that reason. This
//      control reports and nothing else.
//
// Comments are stripped before anything is asserted — the migration's own prose names
// every flag it must not filter on, so an uncleaned read would pass on the explanation.
const fs = require('fs');
const path = require('path');

const MIG_DIR = path.join(__dirname, '..', 'supabase', 'migrations');
const FILES = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort();

const stripComments = (sql) => sql.replace(/--[^\n]*/g, '');

// Migrations apply in filename order and bodies are replaced with `create or replace`,
// so live behaviour is the LAST definition, not the first.
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
  return { file, header: stripComments(rest.slice(0, start)), body: stripComments(rest.slice(start, end)) };
}

const allSql = FILES.map((f) => fs.readFileSync(path.join(MIG_DIR, f), 'utf8')).join('\n');
const allCode = stripComments(allSql);

// Every kill switch this repo has ever seeded, discovered rather than listed — a list
// here would go stale in the same way the control must not.
const SWITCH_KEYS = [...new Set(
  [...allCode.matchAll(/'([a-z][a-z0-9_]*_enabled)'/g)].map((m) => m[1]),
)].sort();

describe('a paused feature is watched', () => {
  test('the switches are discoverable at all', () => {
    // If this ever finds nothing the rest of the file is asserting about an empty set.
    expect(SWITCH_KEYS).toEqual(expect.arrayContaining([
      'payments_enabled', 'posting_enabled', 'signups_enabled',
      'tips_enabled', 'assistant_enabled', 'promotions_enabled',
    ]));
  });

  test('a control reads app_flags and reports a switch that is off', () => {
    const ctl = lastDefinition('ctl_feature_flag_off');
    expect(ctl && ctl.file).toBeTruthy();
    expect(ctl.body).toMatch(/public\.app_flags/);
    // The gate itself. `not <alias>.enabled` is the whole condition being guarded.
    expect(ctl.body).toMatch(/not\s+[a-z]+\.enabled/);
    // The shape run_control demands: one row per entity, (entity_id, detail).
    expect(ctl.header).toMatch(/returns\s+table\s*\(\s*entity_id\s+text\s*,\s*detail\s+jsonb\s*\)/i);
  });

  test('it is registered, so the sweep actually runs it', () => {
    // run_all_controls iterates the registry. An unregistered ctl_ function is a check
    // nobody runs, reported as a healthy board.
    const rows = [...allCode.matchAll(/insert into public\.controls\s*\(([^)]*)\)\s*values([\s\S]*?);\s*\n/g)];
    const registered = rows.some((r) => r[2].includes("'feature_flag_off'") && r[2].includes("'ctl_feature_flag_off'"));
    expect({ key: 'feature_flag_off', registered }).toEqual({ key: 'feature_flag_off', registered: true });
  });

  test('no kill switch is named in the check — the seventh one is watched too', () => {
    const ctl = lastDefinition('ctl_feature_flag_off');
    const named = SWITCH_KEYS.filter((k) => ctl.body.includes(`'${k}'`));
    expect({
      named,
      why: 'a control that lists the switches it knows about leaves the next one unwatched',
    }).toEqual({
      named: [],
      why: 'a control that lists the switches it knows about leaves the next one unwatched',
    });
  });

  test('the only excusals are the two alert channels, which have their own control', () => {
    const ctl = lastDefinition('ctl_feature_flag_off');
    // Only flag-shaped literals count. The detail payload is full of jsonb_build_object
    // keys ('remedy', 'hours_off', …) and none of those is an exclusion.
    const keys = [...new Set([...ctl.body.matchAll(/'([a-z][a-z0-9_]{3,})'/g)].map((m) => m[1]))]
      .filter((k) => /_(alert|enabled)$/.test(k));
    expect(keys.sort()).toEqual(['controls_alert', 'safety_alert']);
  });

  test('a switch meant to sit off is excused by its own row, not by its name', () => {
    const ctl = lastDefinition('ctl_feature_flag_off');
    // The marker mechanism, and the one flag that carries it today. Without the marker
    // bonus_cash_payout_enabled — seeded OFF on purpose in 20260806070000 — would be a
    // permanent finding from the first sweep, and a control that is red on arrival is a
    // control somebody disables.
    expect(ctl.body).toMatch(/off_is_normal/);
    expect(allCode).toMatch(/off_is_normal[\s\S]{0,600}bonus_cash_payout_enabled|bonus_cash_payout_enabled[\s\S]{0,600}off_is_normal/);
  });

  test('it reports and never repairs — nothing re-enables a switch on a timer', () => {
    const ctl = lastDefinition('ctl_feature_flag_off');
    // STABLE is the enforcement — Postgres refuses a data-modifying statement inside one.
    expect(ctl.header).toMatch(/\bstable\b/i);
    // Belt and braces, with string literals removed first: the detail payload spells out
    // the `update public.app_flags …` an operator runs BY HAND to excuse a switch, and a
    // naive read would trip over the remedy text rather than over any executed statement.
    const executable = ctl.body.replace(/'(?:[^']|'')*'/g, "''");
    expect(executable).not.toMatch(/\b(update|insert|delete)\b/i);

    // And the auto-expiry that lifts a muted pager stays scoped away from the product
    // switches. Re-enabling a pager resumes telling you things; re-enabling payments
    // resumes taking money.
    const sweeper = lastDefinition('reenable_expired_alert_flags');
    expect(sweeper).not.toBeNull();
    for (const k of SWITCH_KEYS) {
      expect({ key: k, lifted: sweeper.body.includes(`'${k}'`) }).toEqual({ key: k, lifted: false });
    }
  });
});
