// ─────────────────────────────────────────────────────────────────────────────
// No single console action may leave the console with nobody who can open it.
//
// requireAdmin refuses any admin_users row whose status is not 'active', so anything that
// moves the last admin out of active-and-admin is a total lockout — recoverable only with
// direct Supabase credentials, which 20260804030000_admin_team_lifecycle.sql itself calls
// "exactly the wrong dependency".
//
// TWO real holes, found by the 2026-08-12 audit and reproduced against current code:
//
//  1. addTeamMember was an UPSERT that always wrote status:'pending'. Re-adding someone
//     already active — to fix a role, or a typo in a note — demoted them on the spot. With
//     one admin in production that is the lockout, reachable by an ordinary correction
//     rather than by anything that looks dangerous.
//  2. setTeamRole guarded only `role === "support"`. finance and trust are PEERS of each
//     other, not of admin (roleSatisfies), so demoting the last admin to either stranded
//     the console just as completely while passing the guard.
//
// The sibling actions already had these guards. Add was the one path with neither, which
// is the pattern worth asserting: the dangerous-looking actions get protected and the
// mundane one does not.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'admin', 'app', '(console)', 'team', 'actions.ts'),
  'utf8',
);
const codeOnly = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const code = codeOnly(src);
const fn = (name) => {
  const i = code.indexOf(`export async function ${name}`);
  if (i === -1) return '';
  const next = code.indexOf('export async function ', i + 10);
  return code.slice(i, next === -1 ? code.length : next);
};

describe('no team action can strand the console', () => {
  it('parsed the actions', () => {
    for (const n of ['addTeamMember', 'setTeamStatus', 'setTeamRole']) {
      expect(`${n}: ${fn(n).length > 100}`).toBe(`${n}: true`);
    }
  });

  it('adding an existing member never downgrades their status', () => {
    const add = fn('addTeamMember');
    // The upsert was the bug: it always wrote pending.
    expect(add).not.toMatch(/upsert\(/);
    // An existing row must be UPDATEd without touching status.
    expect(add).toMatch(/\.update\(\{ role, note: note \|\| null \}\)/);
    const update = add.slice(add.indexOf('.update({ role'), add.indexOf('.update({ role') + 200);
    expect(update).not.toMatch(/status/);
  });

  it('a new member is still created PENDING', () => {
    // The enrollment window is why: a row that granted access on creation would let
    // whoever wins the password race enrol their own authenticator.
    const add = fn('addTeamMember');
    expect(add).toMatch(/\.insert\(/);
    expect(add.slice(add.indexOf('.insert('))).toMatch(/status:\s*["']pending["']/);
  });

  it('every mutating team action refuses to target the caller', () => {
    for (const n of ['addTeamMember', 'setTeamStatus', 'setTeamRole']) {
      expect(`${n}: ${/userId === (c|ctx)\.user\.id/.test(fn(n))}`).toBe(`${n}: true`);
    }
  });

  it('demotion away from admin checks for the last admin, not just support', () => {
    const role = fn('setTeamRole');
    expect(role).toMatch(/role !== ["']admin["']/);
    // The old form let finance and trust through — they are peers of each other, not of
    // admin, so either one strands the console.
    expect(role).not.toMatch(/if \(role === ["']support["']\) await assertNotLastAdmin/);
    expect(role).toMatch(/assertNotLastAdmin/);
  });

  it('disabling a member still checks for the last admin', () => {
    expect(fn('setTeamStatus')).toMatch(/assertNotLastAdmin/);
  });
});
