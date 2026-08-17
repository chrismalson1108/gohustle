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
    const whole = fs.readFileSync(path.join(MIG, teamList.file), 'utf8');
    expect(whole).toMatch(/FIX FAILED: a verified factor exists and the page still reports none/);
    expect(whole).toMatch(/FIX FAILED: a removed authenticator still reports enrolled/);
    // And the staging must be checked, or a probe that never wrote the cache passes vacuously.
    expect(whole).toMatch(/staging wrong: the cache was written/);
    expect(whole).toMatch(/staging wrong: the stale cache did not take/);
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
    expect(controls).toMatch(/mfaEnrolledAt\s*$/m);
    expect(controls).toMatch(/Confirm that time with them directly/);
    expect(controls).toMatch(/have NOT enrolled an authenticator yet/);
  });
});
