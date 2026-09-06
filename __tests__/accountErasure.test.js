// ─────────────────────────────────────────────────────────────────────────────
// What an erasure has to take with it, when the account row itself is KEPT.
//
// Since 20260813150000 deleting an account tombstones the profile instead of deleting
// it, because profiles_id_fkey cascades to jobs → bookings → payments — the
// counterparty's financial records. That is the right call and it has a cost: every
// `on delete cascade` hanging off profiles STOPS FIRING. Anything that used to be
// cleaned up by the cascade now has to be deleted by name, and nothing fails when it
// is not — the row simply stays, holding someone's personal data.
//
// This file is the list of the ones found so far. Each is asserted against the LIVE
// definition (the last migration to define the function), the same rule Postgres
// applies, so a later legitimate redefinition that drops one fails here rather than
// quietly retaining PII.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MIG = path.join(ROOT, 'supabase', 'migrations');

const files = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();
const allMigrations = files.map((f) => fs.readFileSync(path.join(MIG, f), 'utf8')).join('\n');

function latestDefining(fnName) {
  const hits = files.filter((f) =>
    new RegExp(`create or replace function public\\.${fnName}\\b`, 'i').test(
      fs.readFileSync(path.join(MIG, f), 'utf8'),
    ),
  );
  expect(hits.length).toBeGreaterThan(0);
  return fs.readFileSync(path.join(MIG, hits[hits.length - 1]), 'utf8');
}

describe('the tombstone takes the school email with it', () => {
  // student_email_verifications.user_id is `references profiles(id) on delete cascade`
  // and that cascade is the table's only cleanup. Tombstoning means it never fires, so
  // a consumed row — the person's real .edu address — outlived the erasure. Worse, it
  // is the whole one-inbox-one-account rule: uniq_consumed_student_email is unique on
  // (email) where consumed, so the surviving row makes it impossible for the same
  // person to verify that inbox on a new account, at the database, forever.
  const tombstone = latestDefining('tombstone_profile');

  it('deletes the row the FK cascade can no longer reach', () => {
    expect(tombstone).toMatch(
      /delete from public\.student_email_verifications where user_id = p_user/i,
    );
  });

  it('and does it as part of the scrub, so every caller inherits it', () => {
    // Not in delete-account: the scrub is the RPC, and a second caller (an admin path,
    // a future console action) must not have to remember this.
    const del = tombstone.search(/delete from public\.student_email_verifications/i);
    const upd = tombstone.search(/update public\.profiles/i);
    expect(del).toBeGreaterThan(-1);
    expect(upd).toBeGreaterThan(-1);
    expect(del).toBeLessThan(upd);
  });

  it('clears the rows already stranded under accounts erased before the fix', () => {
    // The change above only reaches erasures from here on; anyone who deleted their
    // account earlier is still holding both halves of the defect.
    expect(allMigrations).toMatch(
      /delete from public\.student_email_verifications s[\s\S]{0,200}p\.deleted_at is not null/i,
    );
  });

  it('and the control reports it if a later change drops the delete', () => {
    const ctl = latestDefining('ctl_tombstone_leaks_pii');
    expect(ctl).toMatch(/has_school_email/);
    // It must be in the WHERE too — a detail field nothing filters on reports nothing.
    const where = ctl.slice(ctl.search(/where p\.deleted_at is not null/i));
    expect(where).toMatch(/student_email_verifications/i);
  });
});
