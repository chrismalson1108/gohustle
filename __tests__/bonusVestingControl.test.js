// ─────────────────────────────────────────────────────────────────────────────
// ctl_bonus_vesting_stalled must not diagnose a deliberate hold as a broken sweep.
//
// vest_bonuses() leaves a referral bonus `pending` past its vests_at for two reasons,
// and they want opposite responses:
//
//   · the sweep did not run, or errored — fix the sweep;
//   · the source gig is under an open dispute, which vest_bonuses refuses to pay
//     through on purpose (20260814150000) — resolve the dispute.
//
// The control knew only the first. Its predicate was `state = 'pending' and vests_at <
// now() - interval '2 days'`, its detail carried no dispute fields, and its registry
// `why` told the operator the sweep was broken for EVERY row. A referral whose gig is in
// a dispute therefore opened a medium/money finding pointing at the one thing that was
// working; the operator checked pg_cron, found it healthy, and the finding re-opened on
// the next sweep. On the realistic timeline — a partial capture at verification files
// the dispute and mints the bonus in the same moment — that is roughly five days before
// ctl_dispute_open_beyond_sla names the real cause at day 14.
//
// This asserts the control tells the truth, and asserts it against the hold it is
// describing: if vest_bonuses ever stops holding on disputes, the cause the control
// reports becomes fiction and this fails rather than going quietly stale.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const MIG = path.join(__dirname, '..', 'supabase', 'migrations');
const files = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();

// The LAST `create or replace` wins — that is what production runs. Naming a migration
// by hand is how pricing.test.js spent a month checking a body that had been replaced.
function latestDefinition(fn) {
  let found = null;
  for (const f of files) {
    const sql = fs.readFileSync(path.join(MIG, f), 'utf8');
    const re = new RegExp(`create or replace function public\\.${fn}\\s*\\(`, 'gi');
    let m;
    while ((m = re.exec(sql)) !== null) {
      const end = sql.indexOf(`revoke execute on function public.${fn}`, m.index);
      found = { file: f, body: sql.slice(m.index, end === -1 ? sql.length : end) };
    }
  }
  return found;
}

// The last registry tuple for a control key, i.e. the text /controls renders today.
function latestRegistryRow(key) {
  let found = null;
  for (const f of files) {
    const sql = fs.readFileSync(path.join(MIG, f), 'utf8');
    let at = -1;
    // eslint-disable-next-line no-cond-assign
    while ((at = sql.indexOf(`('${key}',`, at + 1)) !== -1) {
      const stop = sql.indexOf(';', at);
      found = { file: f, tuple: sql.slice(at, stop === -1 ? sql.length : stop) };
    }
  }
  return found;
}

const control = latestDefinition('ctl_bonus_vesting_stalled');
const vest = latestDefinition('vest_bonuses');
const registry = latestRegistryRow('bonus_vesting_stalled');

describe('the dispute hold this control has to describe still exists', () => {
  it('finds the live vest_bonuses', () => {
    expect(vest && vest.file).toBeTruthy();
  });

  it('vest_bonuses still refuses to vest a bonus whose source gig is disputed', () => {
    // If this stops being true, `held_by_dispute` is a cause the control invents and the
    // 2-day predicate is once again the whole story. Fail here rather than leave the
    // control describing a mechanism that was removed.
    const holds = /not exists\s*\([\s\S]{0,400}?public\.disputes[\s\S]{0,300}?investigating/i.test(vest.body);
    expect(`vest_bonuses (${vest.file}): ${holds ? 'holds on open disputes' : 'NO DISPUTE HOLD — the control now reports a cause that cannot happen'}`)
      .toBe(`vest_bonuses (${vest.file}): holds on open disputes`);
  });
});

describe('ctl_bonus_vesting_stalled separates the two causes', () => {
  it('finds the live control', () => {
    expect(control && control.file).toBeTruthy();
  });

  it('looks at disputes at all', () => {
    // The whole defect in one assertion: the original body never mentioned them.
    expect(`${control.file}: ${/public\.disputes/i.test(control.body) ? 'joins disputes' : 'NEVER LOOKS AT DISPUTES — every finding is diagnosed as a broken sweep'}`)
      .toBe(`${control.file}: joins disputes`);
  });

  it('reports which of the two causes it is, per row', () => {
    // A row the operator cannot triage without opening psql is not a finding, it is a
    // notification. The detail has to say which remedy applies.
    expect(control.body).toMatch(/'cause'\s*,/);
    expect(control.body).toMatch(/held_by_dispute/);
    expect(control.body).toMatch(/sweep_not_vesting/);
  });

  it('names the dispute rather than merely knowing one exists', () => {
    // "There is a dispute somewhere" costs the operator the same lookup the finding was
    // supposed to save. The id is what makes 'resolve the dispute' actionable.
    ['dispute_id', 'dispute_status', 'dispute_age_days'].forEach((k) => {
      expect(`${k}: ${control.body.includes(`'${k}'`) ? 'named' : 'MISSING from detail'}`).toBe(`${k}: named`);
    });
  });

  it('still fires on an unheld overdue bonus', () => {
    // The fix must not become an exclusion. A bonus nobody is holding is the original
    // finding and the one that means someone is not being paid.
    expect(control.body).toMatch(/b\.state\s*=\s*'pending'/);
    expect(control.body).toMatch(/b\.vests_at\s*<\s*now\(\)\s*-\s*interval\s*'2 days'/);
    // A LEFT join, so the unheld row survives it.
    expect(control.body).toMatch(/left join lateral/i);
  });

  it('cannot return one bonus twice when a booking carries two open disputes', () => {
    // run_control merges duplicates now (20260906045000), but a merged finding is a
    // fallback: two open disputes on one gig must still be ONE bonus finding.
    expect(control.body).toMatch(/left join lateral[\s\S]*?limit 1/i);
  });
});

describe('the registry text agrees with the detail', () => {
  it('finds the live registry row', () => {
    expect(registry && registry.file).toBeTruthy();
  });

  it('no longer asserts the broken sweep as the only cause', () => {
    // This is the sentence the operator actually reads on /controls. It said "A bonus
    // sitting pending well past vests_at means the sweep is not running or is erroring"
    // — for every row, including the ones where the sweep is fine.
    const asserts = /means the sweep is not running or is erroring/i.test(registry.tuple);
    expect(`${registry.file}: ${asserts ? 'STILL BLAMES THE SWEEP FOR EVERY ROW' : 'does not blame the sweep unconditionally'}`)
      .toBe(`${registry.file}: does not blame the sweep unconditionally`);
  });

  it('tells the operator about the dispute cause and its remedy', () => {
    expect(registry.tuple).toMatch(/held_by_dispute/);
    expect(registry.tuple).toMatch(/dispute/i);
  });

  it('is still registered as an in-database control the sweep runs', () => {
    // run_all_controls iterates the registry; an unregistered check never runs.
    expect(registry.tuple).toMatch(/'ctl_bonus_vesting_stalled'/);
    expect(registry.tuple).not.toMatch(/external:/);
  });
});
