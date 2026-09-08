/**
 * An `.upsert()` without `ignoreDuplicates` needs an UPDATE grant the table may not have.
 *
 * supabase-js turns `.upsert(row, { onConflict })` into `INSERT … ON CONFLICT DO UPDATE`,
 * which Postgres refuses unless the role holds UPDATE **as well as** INSERT.
 * `20260812040000_grant_rls_parity.sql` swept UPDATE off a list of tables using "is there
 * a policy backing this command" as its rule — correct for the policy layer, and blind to
 * the fact that three client call sites were sending DO UPDATE at those exact tables.
 *
 * The result was invisible for a month:
 *   - `referrals`  — refused 42501 on every signup since 2026-08-12. supabase-js RESOLVES
 *                    on error rather than throwing, so `recordReferral`'s try/catch caught
 *                    nothing and the discarded `error` was never read. Referral
 *                    attribution and every `bonus_ledger` vest were silently inert.
 *   - `blocks`     — you could not block anybody, on either client.
 *   - `favorites`  — you could not save a person.
 *
 * All three measured against production 2026-09-08 as the `authenticated` role, rolled
 * back: the shipped call shape returns `42501 permission denied`, the same row with
 * `ON CONFLICT DO NOTHING` is accepted.
 *
 * DO NOTHING is also the RIGHT semantics for all three. Re-running onboarding with a
 * different referral code must not rewrite who referred you; re-blocking somebody must
 * not rewrite the block. The revoke stays; the call shape was what was wrong.
 *
 * This test is the class guard. It resolves the revoked tables from the migrations on
 * disk — never a hand-typed list, for the same reason `pricing.test.js` parses the fee
 * migration rather than retyping its constants.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|jsx|ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

/**
 * Replay every grant/revoke touching UPDATE for `authenticated`, in migration order, and
 * report the tables that end up WITHOUT it. Replayed rather than pattern-matched because a
 * later migration is allowed to grant one back — `gig_shares` and `support_tickets` both do.
 */
function tablesWithoutUpdateGrant() {
  const files = [
    ...fs.readdirSync(path.join(ROOT, 'supabase'))
      .filter((f) => f.endsWith('.sql'))
      .map((f) => path.join('supabase', f))
      .sort(),
    ...fs.readdirSync(path.join(ROOT, 'supabase/migrations'))
      .filter((f) => f.endsWith('.sql'))
      .map((f) => path.join('supabase/migrations', f))
      .sort(),
  ];
  const revoked = new Set();
  for (const rel of files) {
    const sql = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const stmt of sql.split(';')) {
      const s = stmt.replace(/--[^\n]*/g, '').trim();
      // Column-scoped grants (`grant update (col) on …`) do not restore table-wide UPDATE.
      const m = /^(grant|revoke)\s+([A-Za-z][A-Za-z,\s]*?)\s+on\s+(?:table\s+)?(?:public\.)?([a-z_][a-z0-9_]*)\s+(?:to|from)\s+([^;]+)$/i.exec(s);
      if (!m) continue;
      const [, verb, privs, table, roles] = m;
      if (!/\bauthenticated\b/i.test(roles)) continue;
      if (!/\bupdate\b/i.test(privs) && !/\ball\b/i.test(privs)) continue;
      if (verb.toLowerCase() === 'revoke') revoked.add(table);
      else revoked.delete(table);
    }
  }
  return revoked;
}

// Client code only. Edge functions and admin server actions hold service_role, which keeps
// every privilege — the constraint is on what a signed-in USER's token can do.
const CLIENT_FILES = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'web/lib')), ...walk(path.join(ROOT, 'web/app'))]
  .filter((f) => !/node_modules/.test(f));

describe('an .upsert() at a table with no UPDATE grant must pass ignoreDuplicates', () => {
  const revoked = tablesWithoutUpdateGrant();

  it('finds the revoked tables in the migrations (guards the parser itself)', () => {
    // If this parser silently matched nothing, every assertion below would pass vacuously.
    expect(revoked.size).toBeGreaterThan(5);
    expect(revoked.has('referrals')).toBe(true);
    expect(revoked.has('blocks')).toBe(true);
    expect(revoked.has('favorites')).toBe(true);
    // …and a table that keeps UPDATE must NOT be listed, or the rule is "everything".
    expect(revoked.has('gig_shares')).toBe(false);
    expect(revoked.has('support_tickets')).toBe(false);
  });

  it('every client upsert at such a table sends ON CONFLICT DO NOTHING', () => {
    const offenders = [];
    for (const file of CLIENT_FILES) {
      const src = fs.readFileSync(file, 'utf8');
      // `.from("t")` … `.upsert( … )` — the call may wrap across lines.
      const re = /\.from\(\s*["'`]([a-z_][a-z0-9_]*)["'`]\s*\)([\s\S]{0,400}?)\.upsert\(([\s\S]{0,400}?)\)\s*[;\n]/g;
      let m;
      while ((m = re.exec(src))) {
        const [, table, between, args] = m;
        if (/\.from\(/.test(between)) continue; // a different chain got spliced in
        if (!revoked.has(table)) continue;
        if (/ignoreDuplicates\s*:\s*true/.test(args)) continue;
        offenders.push(
          `${path.relative(ROOT, file)} upserts \`${table}\`, whose UPDATE grant is revoked ` +
          `from authenticated, without ignoreDuplicates — PostgREST sends ON CONFLICT DO ` +
          `UPDATE and Postgres answers 42501.`,
        );
      }
    }
    expect(offenders).toEqual([]);
  });
});
