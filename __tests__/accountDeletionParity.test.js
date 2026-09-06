const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// There are TWO account-deletion paths and they must not diverge.
//
// supabase/functions/delete-account/index.ts is the self-service one; admin/lib/
// deleteUser.ts is the console's, and its header says it is a port of the first and
// to "keep the two in sync". They were not in sync, and the direction mattered:
//
//   profiles_id_fkey references auth.users ON DELETE CASCADE, and the cascade runs
//   profiles → jobs → bookings → payments. The step-0 gate blocks only confirmed and
//   completed bookings, so what a delete took was precisely the VERIFIED, PAID work —
//   the COUNTERPARTY's booking and payment rows. That is an earner's Transactions
//   statement and their 1099 evidence, deleted because a poster was removed.
//
// 20260813150000 proved it on a staged row (booking and payment 1 → 0) and the edge
// function was rewritten to tombstone the profile and permanently ban the auth row
// instead. The console kept calling auth.admin.deleteUser for three more weeks.
//
// So: neither path may delete the auth user, both must tombstone, and both must
// neutralise the auth row the same way.
// ─────────────────────────────────────────────────────────────────────────────
const ROOT = path.join(__dirname, '..');
const EDGE = path.join(ROOT, 'supabase', 'functions', 'delete-account', 'index.ts');
const ADMIN = path.join(ROOT, 'admin', 'lib', 'deleteUser.ts');

// Comments quote the very call being removed, so strip them before asserting.
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const PATHS = [
  ['supabase/functions/delete-account/index.ts', EDGE],
  ['admin/lib/deleteUser.ts', ADMIN],
];

describe('neither deletion path may cascade away the counterparty’s records', () => {
  it.each(PATHS)('%s never calls auth.admin.deleteUser', (_name, file) => {
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    // The single call that runs the profiles → jobs → bookings → payments cascade.
    expect(code).not.toMatch(/auth\.admin\.deleteUser\s*\(/);
  });

  it.each(PATHS)('%s tombstones the profile instead', (_name, file) => {
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    expect(code).toMatch(/rpc\(\s*['"]tombstone_profile['"]/);
  });

  it.each(PATHS)('%s fails closed when the tombstone does not take', (_name, file) => {
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    // Proceeding on a failed scrub is how an account ends up half-deleted with its
    // identifiers intact — and, before the rewrite, with the cascade already run.
    const at = code.search(/rpc\(\s*['"]tombstone_profile['"]/);
    const after = code.slice(at, at + 700);
    expect(after).toMatch(/tombErr/);
    expect(after).toMatch(/return|throw/);
  });

  it.each(PATHS)('%s neutralises and permanently bans the auth row', (_name, file) => {
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    expect(code).toMatch(/auth\.admin\.updateUserById\s*\(/);
    expect(code).toMatch(/deleted-\$\{[a-zA-Z.]+\}@removed\.invalid/);
    expect(code).toMatch(/ban_duration:\s*['"]876000h['"]/);
    // And every live session is revoked, or the ban only bites at the next refresh.
    expect(code).toMatch(/auth\.admin\.signOut\(/);
  });

  it('the two paths order it the same way: tombstone before touching auth', () => {
    for (const [, file] of PATHS) {
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      const tomb = code.search(/rpc\(\s*['"]tombstone_profile['"]/);
      const auth = code.search(/auth\.admin\.updateUserById\s*\(/);
      expect(tomb).toBeGreaterThan(-1);
      expect(auth).toBeGreaterThan(tomb);
    }
  });

  it('the RPC the code calls is the one the schema defines', () => {
    // A rename in SQL with no caller update would leave both paths failing closed —
    // safe, but nobody could delete an account and the reason would be a 404 on an RPC.
    const sql = fs
      .readdirSync(path.join(ROOT, 'supabase', 'migrations'))
      .filter((f) => f.endsWith('.sql'))
      .map((f) => fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', f), 'utf8'))
      .join('\n');
    expect(sql).toMatch(/create or replace function public\.tombstone_profile\(/);
    expect(sql).toMatch(/grant execute on function public\.tombstone_profile\(uuid\) to service_role/);
  });
});
