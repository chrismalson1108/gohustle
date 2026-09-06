// ─────────────────────────────────────────────────────────────────────────────
// A control that names one entity twice must FILE, not ERROR.
//
// run_control upserts every row a control returns:
//     insert into public.control_findings (control_key, entity_id, severity, detail)
//     select ... from v
//     on conflict (control_key, entity_id) where resolved_at is null do update ...
//
// Postgres forbids an INSERT ... ON CONFLICT DO UPDATE from touching the same target
// row twice in one statement — 'ON CONFLICT DO UPDATE command cannot affect row a
// second time', SQLSTATE 21000. So if a control returns two rows sharing an entity_id,
// the whole control aborts: run_all_controls catches it, stamps controls.last_error,
// and reports `errored`. NO findings are written for that control at all — not the
// colliding pair, not the other twenty entities it also found. The board shows a
// cryptic Postgres message where the queue should be.
//
// That was reachable from four registered controls on realistic data. The worst is
// ctl_stripe_id_mode_mismatch, which used a bare `user_id::text` for BOTH its
// connected-account arm and its customer arm: on a platform where every user can earn
// AND post, one person with a Connect account and a saved card pre-cutover is one
// entity returned twice. The control is a deliberate no-op until app_flags.stripe_mode
// flips to live, which means the collision would first appear at the go-live cutover —
// the one moment the check exists for.
//
// Two halves, both asserted here:
//   1. run_control DE-DUPLICATES before the upsert, so no control — including ones not
//      yet written — can error this way again.
//   2. The four controls that could fan out give each row its own id, so their findings
//      arrive as separate, actionable entities instead of one merged row.
//
// 20260814100000 already documented the hazard in a comment and hand-authored one
// control around it. A comment is not a check: three other controls carrying the same
// shape were written before and after it.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const MIG = path.join(__dirname, '..', 'supabase', 'migrations');
const files = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();

// The LAST definition of a function wins — that is what production runs.
function latestDefinition(fnPattern) {
  let found = null;
  for (const f of files) {
    const sql = fs.readFileSync(path.join(MIG, f), 'utf8');
    const re = new RegExp(`create or replace function public\\.${fnPattern}\\s*\\(`, 'gi');
    let m;
    while ((m = re.exec(sql)) !== null) {
      const revoke = sql.indexOf(`revoke execute on function public.${fnPattern}`, m.index);
      found = { file: f, body: sql.slice(m.index, revoke === -1 ? sql.length : revoke) };
    }
  }
  return found;
}

describe('run_control cannot be aborted by a control that names one entity twice', () => {
  const runControl = latestDefinition('run_control');

  it('finds run_control', () => {
    expect(runControl && runControl.file).toBeTruthy();
  });

  it('de-duplicates the control output before the ON CONFLICT upsert', () => {
    // The upsert must read from a source that has been collapsed to one row per
    // entity_id. Without this, two rows sharing an id raise 21000 and the control is
    // recorded as errored rather than filing anything.
    const body = runControl.body;
    const grouped = /group by\s+[a-z_]+\.entity_id/i.test(body);
    expect(
      `run_control (${runControl.file}): ${grouped ? 'de-duplicates' : 'NO GROUP BY — two rows for one entity abort the control with SQLSTATE 21000'}`,
    ).toBe(`run_control (${runControl.file}): de-duplicates`);
  });

  it('still feeds the upsert and the auto-resolve pass from the same de-duplicated set', () => {
    // The de-duplication is worthless if the auto-resolve arm reads the raw rows: the
    // two halves would then disagree about what was seen this run.
    const body = runControl.body;
    expect(body).toMatch(/insert into public\.control_findings[\s\S]*?from v\b/i);
    expect(body).toMatch(/array_agg\(entity_id\)[\s\S]*?from v\b/i);
  });

  it('keeps every merged row rather than dropping the duplicates', () => {
    // `distinct on` would silently discard the second arm's detail — for the id-mode
    // control that is a stale customer id nobody is told about. Merging keeps it.
    expect(runControl.body).toMatch(/jsonb_agg/i);
  });
});

describe('the controls that can fan out give each row its own entity id', () => {
  // Each of these was measured against its own target population, not guessed:
  // one user with both a Connect account and a Stripe customer; one table on which
  // anon AND authenticated hold TRUNCATE; one rung mispriced above two lower rungs;
  // one referrer over-bonused on two referred people.
  const cases = [
    {
      fn: 'ctl_stripe_id_mode_mismatch',
      // Two arms over two different tables keyed on the same user. Without a namespace
      // they are the same entity_id.
      needs: [/'acct:'\s*\|\|/i, /'cus:'\s*\|\|/i],
      why: 'the connected-account and customer arms must live in different id namespaces',
    },
    {
      fn: 'ctl_client_holds_truncate',
      // Cross joined against anon AND authenticated with relname as the entity.
      needs: [/group by\s+c\.relname/i],
      why: 'a table held by both client roles must be ONE row with both roles in detail',
    },
    {
      fn: 'ctl_fee_tier_ladder_inverted',
      // One rung joined against every lower rung it beats.
      needs: [/group by\s+t2\.id/i],
      why: 'a rung that beats two lower rungs must be one row naming both',
    },
    {
      fn: 'ctl_referral_bonus_repeat',
      // Grouped per (referrer, referred) while the entity is the referrer.
      needs: [/group by\s+p\.user_id/i],
      why: 'a referrer over-bonused on two people must be one row naming both pairs',
    },
  ];

  cases.forEach(({ fn, needs, why }) => {
    it(`${fn} returns one row per entity`, () => {
      const def = latestDefinition(fn);
      expect(`${fn}: ${def ? 'found' : 'MISSING'}`).toBe(`${fn}: found`);
      const missing = needs.filter((re) => !re.test(def.body)).map((re) => String(re));
      expect(`${fn} (${def.file}): ${missing.length ? `fans out — ${why}; missing ${missing.join(', ')}` : 'one row per entity'}`)
        .toBe(`${fn} (${def.file}): one row per entity`);
    });
  });
});
