// ─────────────────────────────────────────────────────────────────────────────
// A 6-digit code is only as strong as the counter that limits guesses at it.
//
// student-verify-confirm read the newest unconsumed row, tested `row.attempts >= 5`
// against the value it had just read, compared the hash, and only on a mismatch wrote
// `attempts: row.attempts + 1` — a separate statement, writing an absolute value
// computed from a stale read, with no predicate. Requests fired together all read
// attempts = 0, were all evaluated as guesses, and all wrote 1: twenty guesses cost one
// attempt against a 900,000-space code. On a hit the attacker's profile carries the
// Verified Student badge for the VICTIM's school — the signal a poster weighs before
// letting someone into their home — and the consumed row locks the real owner of that
// address out of ever verifying it.
//
// CLAUDE.md already records this defect class on mfa_recovery_attempts and the rule
// adopted there: COUNT FIRST. This asserts the shape; the arithmetic is proved where it
// can actually run, in the rolled-back probe in 20260906025300, which charges two
// guesses two attempts on the same staged row that the old shape charged one.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MIG = path.join(ROOT, 'supabase', 'migrations');

const files = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();

function latestDefining(fnName) {
  const hits = files.filter((f) =>
    new RegExp(`create or replace function public\\.${fnName}\\b`, 'i').test(
      fs.readFileSync(path.join(MIG, f), 'utf8'),
    ),
  );
  // Empty rather than throwing: a missing definition should fail the assertions below
  // with what they were looking for, not collapse the whole suite at load time.
  if (!hits.length) return '';
  return fs.readFileSync(path.join(MIG, hits[hits.length - 1]), 'utf8');
}

const confirm = fs.readFileSync(
  path.join(ROOT, 'supabase', 'functions', 'student-verify-confirm', 'index.ts'), 'utf8',
);
// Comments quote the old code, so assertions about what the function DOES read the
// stripped source.
const code = confirm.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

describe('the attempt is spent before the code is judged', () => {
  const rpc = latestDefining('claim_student_verification');

  it('increments with a guarded UPDATE rather than writing a value it read', () => {
    // `set attempts = attempts + 1 ... where attempts < 5` is the whole mechanism: one
    // statement, and a concurrent caller re-evaluates the predicate under the row lock.
    const upd = rpc.slice(rpc.search(/update public\.student_email_verifications\s*\n\s*set attempts/i));
    const stmt = upd.slice(0, upd.indexOf(';'));
    expect(stmt).toMatch(/set attempts = attempts \+ 1/i);
    expect(stmt).toMatch(/and attempts < 5/i);
    expect(stmt).toMatch(/returning attempts/i);
    // Never the stale-read form.
    expect(rpc).not.toMatch(/set attempts = v_attempts \+ 1/i);
  });

  it('spends the attempt BEFORE comparing the hash', () => {
    // If the comparison came first, a correct guess would cost nothing and whoever won
    // the race would get a free check.
    const at = rpc.search(/and attempts < 5/i);
    const cmp = rpc.search(/v_hash is distinct from p_code_hash/i);
    expect(at).toBeGreaterThan(-1);
    expect(cmp).toBeGreaterThan(-1);
    expect(at).toBeLessThan(cmp);
  });

  it('refuses when the guarded update matched nothing', () => {
    expect(rpc).toMatch(/if v_attempts is null then[\s\S]{0,120}too_many_attempts/i);
  });

  it('caps attempts per INBOX, not only per code', () => {
    // Per-user does not bind an attacker who registers more accounts: the row is bound
    // to their own uid, so each account gets a fresh budget against the same victim.
    expect(rpc).toMatch(/sum\(s\.attempts\)/i);
    expect(rpc).toMatch(/where s\.email = p_email[\s\S]{0,200}interval '15 minutes'/i);
    expect(rpc).toMatch(/if v_recent >= 15 then[\s\S]{0,120}too_many_attempts/i);
  });

  it('is service-role only', () => {
    expect(rpc).toMatch(/revoke execute on function public\.claim_student_verification[\s\S]{0,120}from public, anon, authenticated/i);
    expect(rpc).toMatch(/grant execute on function public\.claim_student_verification[\s\S]{0,80}to service_role/i);
  });
});

describe('the edge function no longer counts for itself', () => {
  it('calls the atomic claim', () => {
    expect(code).toMatch(/rpc\('claim_student_verification'/);
  });

  it('never writes the attempt counter from JavaScript again', () => {
    // The exact line that shipped the defect.
    expect(code).not.toMatch(/attempts:\s*row\.attempts \+ 1/);
    expect(code).not.toMatch(/row\.attempts >= 5/);
    expect(code).not.toMatch(/update\(\{ attempts/);
  });

  it('fails closed when the claim itself errors', () => {
    // Every write in the old version went unchecked, so a failed increment silently
    // handed back a free guess.
    expect(code).toMatch(/if \(claimErr\)[\s\S]{0,200}return json/);
  });

  it('still answers each outcome the way the app expects', () => {
    for (const [status, http] of [
      ['expired', '400'], ['too_many_attempts', '429'], ['invalid_code', '400'],
      ['email_in_use', '409'], ['no_pending', '400'],
    ]) {
      const at = code.indexOf(`case '${status}'`);
      expect(`${status}: ${at > -1 ? 'handled' : 'MISSING'}`).toBe(`${status}: handled`);
      expect(code.slice(at, at + 260)).toContain(`}, ${http})`);
    }
  });

  it('and an unrecognised status is an error, not a verification', () => {
    // A default that fell through would grant the badge on any future status name.
    const def = code.indexOf('default:');
    expect(def).toBeGreaterThan(-1);
    expect(code.slice(def, def + 220)).toMatch(/return json\([\s\S]*?500\)/);
  });
});

describe('a grind against one inbox is visible', () => {
  const ctl = latestDefining('ctl_student_verify_bruteforce');

  it('is registered, or run_all_controls never calls it', () => {
    expect(ctl).toMatch(/insert into public\.controls[\s\S]*?'student_verify_bruteforce'/i);
  });

  it('groups by inbox and fires on volume or on many accounts', () => {
    expect(ctl).toMatch(/group by lower\(s\.email\)/i);
    expect(ctl).toMatch(/having sum\(s\.attempts\) >= 20/i);
    expect(ctl).toMatch(/count\(distinct s\.user_id\) >= 3/i);
  });

  it('does not copy the victim\'s address into control_findings', () => {
    // The entity is a hash; the domain and the accounts doing the guessing are in the
    // detail, which is what an operator acts on.
    expect(ctl).toMatch(/select md5\(lower\(s\.email\)\)/i);
  });
});
