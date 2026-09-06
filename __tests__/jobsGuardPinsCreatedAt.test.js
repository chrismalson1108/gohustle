const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// jobs.created_at is a feed-ordering key, and it was owner-writable for six weeks
// because a comment pointed at the wrong table.
//
// 20260726100000 clamped created_at on INSERT only, justifying the gap with
// "20260722020000 pins it against edits on UPDATE". That migration pins
// PROFILES.created_at. Nothing pinned jobs.created_at, UPDATE on public.jobs is
// granted table-wide to `authenticated`, and jobs_update_own is USING-only — so one
// PATCH to a far-future date put a listing first in the web feed, the assistant's gig
// search and the mobile browse query, permanently, and bypassed the 24h bump cooldown
// by never touching bumped_at at all.
//
// guard_jobs_write has been re-created five times. Every rewrite reproduces the
// previous body by hand, which is exactly how a one-line pin gets dropped — the same
// way the support guard lost its reopen exemption twice. So assert it instead of
// trusting the comment: the newest definition must carry the pin, and it must carry it
// ABOVE the `not has_active` early return, or an unbooked gig (the one an attacker
// would use) never reaches it.
// ─────────────────────────────────────────────────────────────────────────────
const DIR = path.join(__dirname, '..', 'supabase', 'migrations');

function newestDefining(fnName) {
  const hits = fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) =>
      new RegExp(`create or replace function public\\.${fnName}\\b`, 'i').test(
        fs.readFileSync(path.join(DIR, f), 'utf8'),
      ),
    )
    .sort();
  if (!hits.length) return null;
  const file = hits[hits.length - 1];
  const sql = fs.readFileSync(path.join(DIR, file), 'utf8');
  const start = sql.toLowerCase().indexOf(`create or replace function public.${fnName}`);
  // The body ends at the `$$;` that closes it — a file may define more than one function.
  const end = sql.indexOf('$$;', sql.indexOf('as $$', start));
  return { file, body: sql.slice(start, end === -1 ? undefined : end) };
}

describe('jobs guard pins created_at', () => {
  it('guard_jobs_write is defined somewhere', () => {
    expect(newestDefining('guard_jobs_write')).not.toBeNull();
  });

  it('the newest guard_jobs_write pins created_at', () => {
    const { file, body } = newestDefining('guard_jobs_write');
    const pinned = /new\.created_at\s*:=\s*old\.created_at/.test(body);
    expect(`${file}: ${pinned}`).toBe(`${file}: true`);
  });

  it('pins created_at BEFORE the no-live-booking early return', () => {
    // The early return is the path a gig with no confirmed booking takes — which is
    // every gig an attacker would forge. A pin below it protects only booked gigs.
    const { file, body } = newestDefining('guard_jobs_write');
    const pinAt = body.search(/new\.created_at\s*:=\s*old\.created_at/);
    const earlyReturnAt = body.search(/if\s+not\s+has_active\s+then/i);
    expect(pinAt).toBeGreaterThan(-1);
    expect(earlyReturnAt).toBeGreaterThan(-1);
    expect(`${file}: pin@${pinAt} < earlyReturn@${earlyReturnAt} = ${pinAt < earlyReturnAt}`)
      .toBe(`${file}: pin@${pinAt} < earlyReturn@${earlyReturnAt} = true`);
  });

  it('still pins bumped_at behind the 24h cooldown', () => {
    // The other half of the same control. created_at was only worth forging because
    // this one existed; losing it makes the pin pointless in the other direction.
    const { body } = newestDefining('guard_jobs_write');
    expect(body).toMatch(/new\.bumped_at\s*:=\s*old\.bumped_at/);
    expect(body).toMatch(/interval\s*'24 hours'/);
  });

  it('still pins the price columns while a booking is live', () => {
    // Guarding against a rewrite that fixes created_at and drops something else.
    const { body } = newestDefining('guard_jobs_write');
    ['pay', 'pay_type', 'estimated_hours'].forEach((col) => {
      expect(body).toMatch(new RegExp(`new\\.${col}\\s*:=\\s*old\\.${col}`));
    });
  });

  it('the live bump guard no longer cites a profiles guard as covering jobs on UPDATE', () => {
    // The false claim that caused this lives in pg_proc, so the newest definition of
    // the function has to be the one that stops repeating it. (20260726100000 still
    // contains the original wording; an applied migration is never edited.)
    const { file, body } = newestDefining('guard_jobs_bump_not_future');
    const stillClaims = /20260722020000 pins it[\s\S]{0,40}against edits on UPDATE/.test(body);
    expect(`${file}: ${stillClaims}`).toBe(`${file}: false`);
  });

  it('20260722020000 pins profiles.created_at, not jobs.created_at', () => {
    // The fact the wrong comment got wrong, asserted so the record cannot drift back.
    const sql = fs.readFileSync(
      path.join(DIR, '20260722020000_pin_created_at_agefloor.sql'),
      'utf8',
    );
    expect(sql).toMatch(/create or replace function public\.guard_profiles_write/i);
    expect(sql).not.toMatch(/create or replace function public\.guard_jobs_write/i);
  });
});
