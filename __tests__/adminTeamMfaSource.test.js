// ─────────────────────────────────────────────────────────────────────────────
// The Team page must ask auth.mfa_factors whether someone has an authenticator.
//
// admin_users.mfa_enrolled_at is written by exactly one caller — admin_record_mfa_enrollment,
// from app/mfa/page.tsx's verify(). The console and the mobile app share one Supabase auth
// project, so a factor enrolled in the APP is the same auth.mfa_factors row the console will
// challenge against, and nothing writes the cache for it. On 2026-08-17 an invited admin was
// sent straight to the 6-digit prompt while /team said "no authenticator enrolled yet".
//
// That field is not decoration. TeamControls.tsx picks the Activate confirmation copy off it,
// and pending→active is THE control that closes the trust-on-first-use window: /mfa enrolls a
// factor for whoever knows the password, so a human confirming when the factor appeared is the
// check. Reading a lagging cache makes that dialog assert the opposite of the truth and drop
// the confirmation instruction in the one place it exists to be given.
//
// The arithmetic — that it discriminates in both directions, and that an unverified factor is
// not an authenticator — is proved where it can actually run: the rolled-back probe in
// 20260817000000. This asserts the shape, so a later rewrite cannot quietly go back to the
// cache the way ctl_admin_without_mfa's own fix note warned about and then left the console
// display behind.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MIG = path.join(ROOT, 'supabase', 'migrations');

// Comments quote the OLD behaviour verbatim — this file's own header names the cache column.
// Matching against prose is how an assertion ends up testing its own explanation.
const stripSql = (s) => s.replace(/^\s*--.*$/gm, '');
const stripTs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function latestDefining(fnName) {
  const files = fs
    .readdirSync(MIG)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter((f) =>
      new RegExp(`create or replace function public\\.${fnName}\\b`, 'i').test(
        fs.readFileSync(path.join(MIG, f), 'utf8'),
      ),
    );
  expect(files.length).toBeGreaterThan(0);
  const last = files[files.length - 1];
  return { file: last, sql: stripSql(fs.readFileSync(path.join(MIG, last), 'utf8')) };
}

const allMigrations = fs
  .readdirSync(MIG)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => fs.readFileSync(path.join(MIG, f), 'utf8'))
  .join('\n');

const teamList = latestDefining('admin_team_list');
// The function body only — the probe below it stages rows against both sources on purpose.
const body = teamList.sql.slice(
  teamList.sql.indexOf('create or replace function public.admin_team_list'),
  teamList.sql.indexOf('revoke execute on function public.admin_team_list'),
);

describe('admin_team_list reads the authoritative factor table', () => {
  it('joins auth.mfa_factors', () => {
    expect(body).toMatch(/auth\.mfa_factors/);
  });

  it('counts only VERIFIED factors', () => {
    // /mfa unenrolls unverified factors on sight, so one is not an authenticator anybody
    // holds — reporting it as enrolment would vouch for a half-finished setup.
    expect(body).toMatch(/status\s*=\s*'verified'/);
  });

  it('does not return the admin_users cache as the enrolment answer', () => {
    // The exact regression: `a.mfa_enrolled_at` in the select list.
    expect(body).not.toMatch(/select[\s\S]*?\ba\.mfa_enrolled_at\b[\s\S]*?from\s+public\.admin_users/);
  });

  it('surfaces the NEWEST factor, not the oldest', () => {
    // The dialog asks "did a factor appear that wasn't yours?". min() would surface an older
    // vouched-for factor and hide the one nobody has confirmed.
    expect(body).toMatch(/max\(\s*mf\.created_at\s*\)/);
    expect(body).not.toMatch(/min\(\s*mf\.created_at\s*\)/);
  });

  it('keeps members with no factor in the list', () => {
    // An inner join here would silently drop every not-yet-enrolled member from /team —
    // including the pending rows the page exists to act on.
    expect(body).toMatch(/left join lateral/i);
  });

  it('the probe proves both directions on the same staged row', () => {
    // Searched across the CORPUS, not against the latest defining migration. Each
    // migration carries the probe for its OWN change, and admin_team_list is redefined
    // whenever the team page needs another field — 20260817010000 did so within the
    // hour, which made the first version of this test fail for a property that
    // migration was never about. Same lesson refundIdempotency.test.js records after
    // the same mistake on record_refund.
    expect(allMigrations).toMatch(/FIX FAILED: a verified factor exists and the page still reports none/);
    expect(allMigrations).toMatch(/FIX FAILED: a removed authenticator still reports enrolled/);
    // And the staging must be checked, or a probe that never wrote the cache passes vacuously.
    expect(allMigrations).toMatch(/staging wrong: the cache was written/);
    expect(allMigrations).toMatch(/staging wrong: the stale cache did not take/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// One date could not answer the question the Activate dialog asks.
//
// A pending admin's row read "authenticator enrolled Aug 17, 6:02 PM" three days after
// he was added, and nothing on screen could say whether that was a SECOND factor beside
// an older one or the only one there had ever been. Those render identically under a
// single max() and mean opposite things:
//
//   one factor, dated when they were invited → they enrolled and forgot where
//   one factor, dated long after             → something happened that day
//   TWO factors                              → somebody enrolled beside them
// ─────────────────────────────────────────────────────────────────────────────
describe('the row itemises every factor, not just the newest date', () => {
  it('the function returns a count and a list', () => {
    expect(body).toMatch(/mfa_factor_count\s+integer/);
    expect(body).toMatch(/mfa_factors\s+jsonb/);
    expect(body).toMatch(/jsonb_agg\(/);
  });

  it('the list is oldest-first, so the original stays identifiable', () => {
    expect(body).toMatch(/order by mf\.created_at/);
  });

  it('empty is an ARRAY, not null', () => {
    // The page maps over it unguarded; a null would crash the whole Team page for
    // anyone who has not enrolled — which is every pending member.
    expect(body).toMatch(/coalesce\(f\.list, '\[\]'::jsonb\)/);
    expect(body).toMatch(/coalesce\(f\.n, 0\)/);
  });

  it('the headline still points at the newest factor', () => {
    expect(body).toMatch(/max\(\s*mf\.created_at\s*\)/);
  });

  it('the probe proves two factors read as two, not as a moved date', () => {
    expect(allMigrations).toMatch(/FIX FAILED: two factors reported as/);
    expect(allMigrations).toMatch(/factors are not oldest-first/);
    expect(allMigrations).toMatch(/the headline moved off the newest factor/);
    // An abandoned half-enrolment must not read as somebody enrolling beside them.
    expect(allMigrations).toMatch(/an unverified factor was counted/);
  });
});

describe('a lost authenticator can be reset from the console', () => {
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const actions = strip(
    fs.readFileSync(path.join(ROOT, 'admin', 'app', '(console)', 'team', 'actions.ts'), 'utf8'),
  );
  const controls = strip(
    fs.readFileSync(path.join(ROOT, 'admin', 'app', '(console)', 'team', 'TeamControls.tsx'), 'utf8'),
  );

  it('the action exists and goes through the audited admin-tier runner', () => {
    // `run` is what applies requireFreshAdmin("admin") and writes the audit row BEFORE
    // the mutation. Calling deleteFactor outside it would be an unlogged factor removal.
    expect(actions).toMatch(/export async function resetAuthenticator/);
    expect(actions).toMatch(/return run\("team\.reset_mfa"/);
  });

  it('it removes EVERY factor, including unverified ones', () => {
    // A leftover unverified row keeps the per-user friendly-name uniqueness occupied,
    // so the next enrol fails on a name collision instead of showing a QR — the reset
    // would appear to work and leave them just as stuck.
    //
    // Bounded to THIS function. An open-ended slice ran into confirmAuthenticators,
    // which filters to verified on purpose, and the negative assertion below started
    // failing on a function it was never about.
    const from = actions.indexOf('export async function resetAuthenticator');
    const nextExport = actions.indexOf('export async function', from + 1);
    const fn = actions.slice(from, nextExport === -1 ? undefined : nextExport);
    expect(fn).toMatch(/user\?\.user\?\.factors \?\? \[\]/);
    expect(fn).toMatch(/for \(const f of factors\)/);
    expect(fn).toMatch(/mfa\.deleteFactor\(\{ id: f\.id, userId \}\)/);
    expect(fn).not.toMatch(/status === ['"]verified['"]/);
  });

  it('it clears the admin_users cache it invalidates', () => {
    const fn = actions.slice(actions.indexOf('export async function resetAuthenticator'));
    expect(fn).toMatch(/mfa_enrolled_at: null, mfa_factor_id: null/);
  });

  it('the console exposes it, and only when there is something to reset', () => {
    expect(controls).toMatch(/resetAuthenticator/);
    expect(controls).toMatch(/mfaFactorCount > 0 &&/);
  });

  it('resetting someone ELSE drops them back to pending', () => {
    // A factorless account is one where /mfa enrols a fresh authenticator for whoever
    // presents the password — the exact hole `pending` exists to cover for new members.
    // A reset puts an ACTIVE member straight back into it.
    const fn = actions.slice(actions.indexOf('export async function resetAuthenticator'));
    expect(fn).toMatch(/if \(userId !== ctx\.user\.id\)/);
    expect(fn).toMatch(/target\?\.status === "active"/);
    expect(fn).toMatch(/update\(\{ status: "pending" \}\)/);
  });

  it('but NEVER on yourself — that would strand the console', () => {
    // A self-reset is somebody at the keyboard about to re-enrol. Demoting them leaves
    // nobody able to activate anyone, which is the failure this surface exists to avoid.
    const fn = actions.slice(actions.indexOf('export async function resetAuthenticator'));
    const demote = fn.slice(fn.indexOf('if (userId !== ctx.user.id)'));
    expect(demote).toMatch(/update\(\{ status: "pending" \}\)/);
    // The guard must WRAP the demotion, not sit beside it.
    expect(demote.indexOf('update({ status: "pending" })')).toBeGreaterThan(0);
  });

  it('a failed demotion is reported, not swallowed', () => {
    // The factors are already gone by then, so failing the action would leave them
    // removed with the demotion silently skipped — the worst of both.
    const fn = actions.slice(actions.indexOf('export async function resetAuthenticator'));
    expect(fn).toMatch(/could NOT set them back to pending/);
  });

  it('the row refreshes so the display cannot contradict the message beside it', () => {
    expect(controls).toMatch(/if \(r\?\.ok\) router\.refresh\(\)/);
  });

  it('Activate warns specifically when more than one factor exists', () => {
    // The generic "confirm the time" copy is wrong here: with two factors, confirming
    // the newest one still leaves the other unaccounted for.
    expect(controls).toMatch(/mfaFactorCount > 1/);
    expect(controls).toMatch(/mfaFactorCount === 0/);
  });
});

describe('the Activate dialog still consumes it', () => {
  const controls = stripTs(
    fs.readFileSync(path.join(ROOT, 'admin', 'app', '(console)', 'team', 'TeamControls.tsx'), 'utf8'),
  );
  const page = stripTs(
    fs.readFileSync(path.join(ROOT, 'admin', 'app', '(console)', 'team', 'page.tsx'), 'utf8'),
  );

  it('page.tsx passes the field through to the row controls', () => {
    expect(page).toMatch(/mfaEnrolledAt=\{m\.mfa_enrolled_at\}/);
  });

  it('Activate branches on it and asks for an out-of-band confirmation when set', () => {
    // Fixing the data source is only half the control — if the confirmation prompt were
    // dropped, a correct timestamp would be shown to nobody.
    // The timestamp must still reach the copy — it is the thing being confirmed.
    expect(controls).toMatch(/new Date\(mfaEnrolledAt\)\.toLocaleString\(\)/);
    expect(controls).toMatch(/Confirm that time with them directly/);
    expect(controls).toMatch(/have NOT enrolled an authenticator yet/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// requireAdmin throws "forbidden" for FOUR different situations — no membership row, a
// pending row, a disabled row, and an active row whose role is too low — and /denied
// answered all four with "This account doesn't have access to this tool."
//
// That is true of exactly one of them. On 2026-08-17 a newly invited admin enrolled his
// authenticator, passed the code prompt, landed here and read it as "wrong account". He
// had done everything right and was one click from being switched on; his next message
// was "I have other emails if I need to set it up through another one" — a second
// account, a second factor, and a second thing for someone to confirm.
//
// The gate does not move. Only what it says to someone standing one approval away.
// ─────────────────────────────────────────────────────────────────────────────
describe('/denied distinguishes the four ways requireAdmin says no', () => {
  const fs3 = require('fs');
  const path3 = require('path');
  const R3 = path3.join(__dirname, '..');
  const clean = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const denied = clean(fs3.readFileSync(path3.join(R3, 'admin', 'app', 'denied', 'page.tsx'), 'utf8'));
  const guard = clean(fs3.readFileSync(path3.join(R3, 'admin', 'lib', 'guard.ts'), 'utf8'));

  it('all four situations are branched', () => {
    for (const k of ['pending', 'disabled', 'role', 'none']) {
      expect(denied).toMatch(new RegExp(`\\b${k}\\b`));
    }
  });

  it('a pending member is told to do nothing, not that they are unauthorized', () => {
    expect(denied).toMatch(/Waiting on approval/);
    // The specific thing that nearly happened: he offered to sign up with another email.
    expect(denied).toMatch(/different email/);
  });

  it('the generic string survives for the case with genuinely no row', () => {
    // Someone who lands here by guessing must still learn nothing.
    expect(denied).toMatch(/This account doesn&apos;t have access to this tool\.|This account doesn't have access to this tool\./);
    expect(denied).toMatch(/if \(!row\) return "none"/);
  });

  it('a lookup failure degrades to the generic copy, never a 500', () => {
    expect(denied).toMatch(/\} catch \{[\s\S]{0,300}?return "none";/);
  });

  it('the GUARD itself is unchanged — this is copy, not access', () => {
    // If softening the message ever softened the check, the trust-on-first-use window
    // that pending exists to close would be open again.
    expect(guard).toMatch(/if \(row\.status !== "active"\) throw new AdminAuthError\("forbidden"\)/);
    expect(guard).toMatch(/if \(!roleSatisfies\(role, minRole\)\) throw new AdminAuthError\("forbidden"\)/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The confirmation that guards the console was never recorded, and nothing noticed when
// it was owed. Both halves bit on 2026-08-17: an invited admin enrolled and sat at a
// denial screen until he texted the founder, and Activate — the click that IS the
// confirmation — left no trace to compare a later factor against.
//
// Deliberately NOT a "more than one factor" alert: the app enrols as 'GoHustlr' and the
// console as 'GoHustlr Admin', so two is a legitimate permanent steady state and the
// finding could never be closed. That is the permanent-false-positive shape this repo has
// now fixed three times. The signal is "unreviewed", which is closable.
// ─────────────────────────────────────────────────────────────────────────────
describe('a console factor is confirmed, not assumed', () => {
  const fs4 = require('fs');
  const path4 = require('path');
  const R4 = path4.join(__dirname, '..');
  const clean = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const acts = clean(fs4.readFileSync(path4.join(R4, 'admin', 'app', '(console)', 'team', 'actions.ts'), 'utf8'));
  const ctrls = clean(fs4.readFileSync(path4.join(R4, 'admin', 'app', '(console)', 'team', 'TeamControls.tsx'), 'utf8'));
  const pg = clean(fs4.readFileSync(path4.join(R4, 'admin', 'app', '(console)', 'team', 'page.tsx'), 'utf8'));

  it('both controls exist AND are registered', () => {
    // run_all_controls iterates the REGISTRY, so an unregistered ctl_ function never
    // runs while the board stays green.
    for (const key of ['admin_pending_enrolled', 'admin_unconfirmed_factor']) {
      expect(allMigrations).toMatch(new RegExp(`create or replace function public\\.ctl_${key}\\b`));
      expect(allMigrations).toMatch(new RegExp(`\\('${key}',`));
      expect(allMigrations).toMatch(new RegExp(`'ctl_${key}'`));
    }
  });

  it('a never-vouched-for account is unconfirmed, not assumed good', () => {
    // Failing open on a NULL stamp would make the control silent on exactly the accounts
    // it knows least about.
    expect(allMigrations).toMatch(/a\.factors_confirmed_at is null or f\.newest > a\.factors_confirmed_at/);
  });

  it('the pending control waits, so a same-day activation never pages', () => {
    expect(allMigrations).toMatch(/f\.enrolled_at < now\(\) - interval '12 hours'/);
    expect(allMigrations).toMatch(/fired one hour in — this would page on every normal invite/);
  });

  it('the probe proves the finding is CLOSABLE, not permanent noise', () => {
    expect(allMigrations).toMatch(/still open after confirmation — this control could never be closed/);
    expect(allMigrations).toMatch(/a factor appearing AFTER the confirmation re-opens it/);
    expect(allMigrations).toMatch(/an unverified factor was treated as an authenticator/);
  });

  it('Activate stamps the confirmation, because Activate IS the confirmation', () => {
    expect(acts).toMatch(/factors_confirmed_at: status === "active" \? new Date\(\)\.toISOString\(\) : null/);
  });

  it('a reset clears it — the factors it vouched for are gone', () => {
    const fn = acts.slice(acts.indexOf('export async function resetAuthenticator'));
    expect(fn).toMatch(/factors_confirmed_at: null/);
  });

  it('confirming audits WHAT was vouched for, not merely that someone clicked', () => {
    const fn = acts.slice(acts.indexOf('export async function confirmAuthenticators'));
    expect(fn).toMatch(/return run\("team\.confirm_factors"/);
    expect(fn).toMatch(/confirmed: factors/);
    expect(fn).toMatch(/f\.status === "verified"/);
  });

  it('the row renders the same state the control sees', () => {
    // A finding about something the operator's own screen does not show sends them
    // looking for what they cannot find.
    expect(pg).toMatch(/function needsConfirm\(m: Member\): boolean/);
    expect(pg).toMatch(/factors_confirmed_at: string \| null/);
    expect(pg).toMatch(/if \(!m\.factors_confirmed_at\) return true/);
    expect(ctrls).toMatch(/needsConfirm && \(/);
    expect(ctrls).toMatch(/confirmAuthenticators/);
  });
});
