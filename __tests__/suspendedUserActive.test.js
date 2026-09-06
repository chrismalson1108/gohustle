// ─────────────────────────────────────────────────────────────────────────────
// Suspension is three one-line clauses, and now something asserts the outcome.
//
// Suspending an account is the safety kill switch. Every channel it closes is
// party-scoped, so the people a suspended account can still reach are its existing
// booking counterparties — "the person who most likely just reported them"
// (20260730150000). The whole enforcement is:
//
//   messages   messages_insert              and not private.is_suspended(auth.uid())
//   bookings   guard_booking_not_suspended  (both parties, before insert)
//   reviews    reviews_insert_auth          and not private.is_suspended(auth.uid())
//
// CLAUDE.md records the concrete regression path for the first of those: re-running the
// legacy migration_fix_lifecycle.sql recreates messages_insert with only the block
// check, and "neither failure errors; the policy just gets weaker". Until
// 20260906084000 nothing watched the result —
//     grep -rn 'is_suspended' supabase/migrations/*.sql | grep -i ctl_
// returned nothing at all, which is why every test in the first block below fails on the
// code before that migration.
//
// This file is the assertion that the canary keeps the right shape. The second block is
// the other half: if the three mechanisms it watches stop existing, the canary is
// watching a ghost and can never sing.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const MIGRATIONS = path.join(__dirname, '..', 'supabase', 'migrations');
const files = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
const sql = files.map((f) => fs.readFileSync(path.join(MIGRATIONS, f), 'utf8')).join('\n');

// The LAST definition wins in a `create or replace` chain — read the newest file that
// defines the function, not the first.
function lastBodyOf(fnName) {
  let body = null;
  for (const f of files) {
    const src = fs.readFileSync(path.join(MIGRATIONS, f), 'utf8');
    const re = new RegExp(`create or replace function public\\.${fnName}\\s*\\(`, 'g');
    let m;
    while ((m = re.exec(src)) !== null) {
      const rest = src.slice(m.index);
      const open = rest.indexOf('as $$');
      const close = rest.indexOf('$$;', open);
      if (open !== -1 && close !== -1) body = rest.slice(open + 5, close);
    }
  }
  return body;
}

// Same idea for a policy: the newest `create policy "<name>"` anywhere in migrations/.
function lastPolicy(name) {
  let found = null;
  for (const f of files) {
    const src = fs.readFileSync(path.join(MIGRATIONS, f), 'utf8');
    const re = new RegExp(`create policy "${name}"[\\s\\S]*?;\\n`, 'g');
    let m;
    while ((m = re.exec(src)) !== null) found = { file: f, text: m[0] };
  }
  return found;
}

describe('a suspended account writing is watched by a control, not only by prose', () => {
  const body = lastBodyOf('ctl_suspended_user_active');

  it('defines ctl_suspended_user_active', () => {
    expect(`defined: ${body !== null}`).toBe('defined: true');
  });

  it('registers it, or run_all_controls never calls it', () => {
    // run_all_controls iterates the REGISTRY, not the schema: an unregistered check
    // reports nothing forever while /controls still shows green.
    expect(sql).toMatch(/\(\s*'suspended_user_active',[\s\S]*?'ctl_suspended_user_active'\)/);
  });

  it('registers it as a high-severity security control', () => {
    // The sweep pages on severity and the digest sorts by it. Contact with the person
    // who filed the report is not a lifecycle nit.
    const row = sql.match(/\(\s*'suspended_user_active',[\s\S]*?'ctl_suspended_user_active'\)/)[0];
    expect(row).toMatch(/'high',\s*'security'/);
  });

  it('covers all three writes suspension actually closes', () => {
    // Messages was closed in 20260730150000, bookings in 20260726070000, reviews in
    // 20260906055000. A canary over one of the three leaves the other two silent.
    const kinds = [...body.matchAll(/'kind',\s*'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(kinds).toEqual(['booking', 'message', 'review']);
  });

  it('reads each arm from the table whose guard it is watching', () => {
    expect(body).toMatch(/from public\.messages m/);
    expect(body).toMatch(/from public\.bookings b/);
    expect(body).toMatch(/from public\.reviews r/);
  });

  it('has no jobs arm, because there is no jobs guard to lose', () => {
    // jobs_select_all HIDES a suspended poster's listings, but jobs_insert_auth checks
    // only poster_id = auth.uid() and no trigger on jobs tests is_suspended. A jobs arm
    // would report rows the schema currently permits — a standing false-positive
    // population, which is how a control gets muted and then deleted.
    // jobs appears only as a LEFT JOIN, to name the counterparty and the poster — never
    // as the table an arm is selected FROM.
    expect(`drives an arm off jobs: ${/from public\.jobs/.test(body)}`)
      .toBe('drives an arm off jobs: false');
    expect(body).not.toMatch(/'kind',\s*'job'/);
  });

  it('judges each row against its author\'s suspended_at, not against now()', () => {
    // The three checks are write-time predicates over profiles.suspended_at. Comparing
    // to now() instead would make the control a report on currently-suspended accounts
    // rather than on writes that should have been refused.
    expect(body).toMatch(/p\.suspended_at is not null/);
    expect(body).toMatch(/m\.created_at > s\.cutoff/);
    expect(body).toMatch(/r\.created_at > s\.cutoff/);
    expect(body).toMatch(/b\.created_at > s[ep]\.cutoff/);
  });

  it('keeps the grace window at seconds, not at the ~1h token life', () => {
    // THE POINT OF THIS FILE. The grace exists for the console clock that stamps
    // suspended_at (admin/app/(console)/users/[id]/actions.ts uses new Date()) and for
    // commit ordering. Excusing the in-flight token instead would blind the canary for
    // exactly the hour the suspension exists to cover — and that hour is when the
    // suspended account still holds a valid JWT.
    const graces = [...body.matchAll(/interval\s+'(\d+)\s*(second|minute|hour)s?'/g)]
      .map((m) => Number(m[1]) * { second: 1, minute: 60, hour: 3600 }[m[2]]);
    expect(`grace windows found: ${graces.length}`).not.toBe('grace windows found: 0');
    expect(`widest grace: ${Math.max(...graces)}s`)
      .toBe(`widest grace: ${Math.min(Math.max(...graces), 300)}s`);
  });

  it('namespaces every entity id, so two arms can never collide', () => {
    // run_control upserts the whole output in one statement; before 20260906045000 a
    // repeated entity_id aborted the control outright, and it still merges rather than
    // filing them separately. Three tables mean three namespaces.
    expect(body).toMatch(/'msg:'\s*\|\|/);
    expect(body).toMatch(/'booking:'\s*\|\|/);
    expect(body).toMatch(/'review:'\s*\|\|/);
  });

  it('folds both booking parties into one row rather than one row per side', () => {
    // guard_booking_not_suspended checks the earner AND the poster. A row per suspended
    // side would name the same booking twice when both are suspended.
    expect(body).toMatch(/'parties'/);
    expect(`unions the two sides: ${/union all[\s\S]*'kind',\s*'booking'[\s\S]*union all[\s\S]*'kind',\s*'booking'/.test(body)}`)
      .toBe('unions the two sides: false');
  });

  it('does not copy the message or review content into control_findings', () => {
    // A finding about harassment should not reproduce the harassment in a second table
    // in order to report it. The row id is enough to read it where it already is.
    expect(`quotes the message body: ${/'(text|body|message_text)',\s*m\.text/.test(body)}`)
      .toBe('quotes the message body: false');
    expect(`quotes the review body: ${/'(text|body|review_text)',\s*r\.text/.test(body)}`)
      .toBe('quotes the review body: false');
  });

  it('names who was reached, which is the point of the messages arm', () => {
    expect(body).toMatch(/'reached_user'/);
  });

  it('proves itself in the migration rather than asserting a formula', () => {
    // House rule: a fix ships with a rolled-back probe that stages the broken row and
    // shows the check discriminates. Here that means the same three rows being silent
    // before the suspension and reported after it, plus the live proof that the policy
    // still refuses the write today — so the control's empty population is by
    // construction and not by luck.
    const file = fs.readFileSync(
      path.join(MIGRATIONS, '20260906084000_no_canary_for_a_suspended_account_still_writing.sql'),
      'utf8',
    );
    expect(file).toMatch(/reports history written BEFORE the suspension/);
    expect(file).toMatch(/FIX FAILED: a message sent after suspension/);
    expect(file).toMatch(/when insufficient_privilege then/);
    expect(file).toMatch(/probe complete — rolling back/);
  });
});

describe('the three guards the canary watches still exist', () => {
  // If any of these stops being true, the control is watching a mechanism that no longer
  // exists — a canary that can never sing. This is also the drift check CLAUDE.md's
  // warning about migration_fix_lifecycle.sql has never had.
  it('messages_insert still refuses a suspended sender', () => {
    const p = lastPolicy('messages_insert');
    expect(`messages_insert found: ${Boolean(p)}`).toBe('messages_insert found: true');
    expect(`${p.file}: ${/not private\.is_suspended\(auth\.uid\(\)\)/.test(p.text) ? 'checks suspension' : 'NO SUSPENSION CLAUSE — a suspended account can message the person who reported it'}`)
      .toBe(`${p.file}: checks suspension`);
  });

  it('reviews_insert_auth still refuses a suspended reviewer', () => {
    const p = lastPolicy('reviews_insert_auth');
    expect(`reviews_insert_auth found: ${Boolean(p)}`).toBe('reviews_insert_auth found: true');
    expect(`${p.file}: ${/not private\.is_suspended\(auth\.uid\(\)\)/.test(p.text) ? 'checks suspension' : 'NO SUSPENSION CLAUSE — a permanent public review can be published after suspension'}`)
      .toBe(`${p.file}: checks suspension`);
  });

  it('guard_booking_not_suspended still checks both parties, and a trigger still calls it', () => {
    const guard = lastBodyOf('guard_booking_not_suspended');
    expect(`guard found: ${guard !== null}`).toBe('guard found: true');
    expect(guard).toMatch(/private\.is_suspended\(new\.earner_id\)/);
    expect(guard).toMatch(/private\.is_suspended\(poster\)/);
    expect(sql).toMatch(
      /create trigger trg_guard_booking_not_suspended\s+before insert on public\.bookings[\s\S]{0,120}guard_booking_not_suspended/,
    );
  });

  it('private.is_suspended still reads profiles.suspended_at', () => {
    // The helper lives in the non-exposed `private` schema, so lastBodyOf (which reads
    // public.*) cannot find it.
    let body = null;
    for (const f of files) {
      const src = fs.readFileSync(path.join(MIGRATIONS, f), 'utf8');
      const m = /create or replace function private\.is_suspended\([\s\S]*?\$\$([\s\S]*?)\$\$/.exec(src);
      if (m) body = m[1];
    }
    expect(`is_suspended found: ${body !== null}`).toBe('is_suspended found: true');
    expect(body).toMatch(/suspended_at is not null/);
  });
});
