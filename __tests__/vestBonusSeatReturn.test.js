// ─────────────────────────────────────────────────────────────────────────────
// Voiding N bonuses returns N campaign seats, not one.
//
// vest_bonuses voids every pending (and, since 20260814150000, every payable) bonus whose
// source booking was reversed, aggregates them per promotion, and hands the campaign back
// what it was charged. The money side was aggregated — `sum(amount_cents)` — but the seat
// side was the literal 1:
//
//     set spent_cents      = greatest(0, p.spent_cents - bp.cents),
//         redemptions_used = greatest(0, p.redemptions_used - 1)
//
// The UPDATE ... FROM joins one aggregate row per promotion, so that 1 is applied once
// however many rows the statement voided, while accrue_referral_bonus charges one use per
// minted bonus. Two reversals inside one hourly sweep therefore return both amounts of
// budget and one seat, and the campaign carries a phantom redemption for the rest of its
// life. max_redemptions is a hard ceiling checked inside the same increment that charges
// the campaign, so the campaign eventually refuses a genuine referral it has the money
// for — silently, because accrue_referral_bonus withdraws the row and returns.
//
// This is a static guard because the defect is invisible at runtime: the function keeps
// returning, both counters keep moving, and only the ratio between them is wrong. The
// invariant asserted here is the one that broke — the two counters a void returns must be
// aggregated the same way, because they were charged the same way.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const MIG = path.join(__dirname, '..', 'supabase', 'migrations');
const files = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();

// The LAST definition wins — that is the one the database is running.
function latestDefinition(fn) {
  let body = null;
  let file = null;
  for (const f of files) {
    const sql = fs.readFileSync(path.join(MIG, f), 'utf8');
    const re = new RegExp(`create or replace function public\\.${fn}\\s*\\(`, 'gi');
    let m;
    while ((m = re.exec(sql)) !== null) {
      const revoke = sql.indexOf(`revoke execute on function public.${fn}`, m.index);
      body = sql.slice(m.index, revoke === -1 ? sql.length : revoke);
      file = f;
    }
  }
  return { body, file };
}

// Strip line comments so a `-- ... - 1 ...` narrative in the header can never satisfy or
// trip an assertion about the code.
function code(body) {
  return body
    .split('\n')
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n');
}

describe('vest_bonuses returns one campaign seat per voided bonus', () => {
  const { body, file } = latestDefinition('vest_bonuses');

  it('is defined at all', () => {
    expect(typeof body).toBe('string');
    expect(body.length).toBeGreaterThan(400);
    expect(file).toBeTruthy();
  });

  const sql = code(body || '');

  // Every place the function gives a use back to a campaign.
  const decrements = [...sql.matchAll(/redemptions_used\s*=\s*greatest\s*\(\s*0\s*,([^)]*)\)/gi)]
    .map((m) => m[1].trim());

  it('gives a seat back in both void passes — pending and already-vested', () => {
    // Two passes void bonuses (state='pending' and state='payable'); each must return
    // budget AND seats. If this count changes, the assertions below are looking at the
    // wrong statements and need rewriting rather than relaxing.
    expect(decrements).toHaveLength(2);
  });

  it('never decrements redemptions_used by a literal 1', () => {
    // THE DEFECT. `- 1` against a per-promotion aggregate returns one seat for N voids.
    const constant = decrements.filter((d) => /-\s*1\s*$/.test(d));
    expect(constant).toEqual([]);
  });

  it('decrements it by a counted aggregate instead', () => {
    for (const d of decrements) {
      // e.g. `p.redemptions_used - bp.uses` — a value carried out of the CTE, not a literal.
      expect(d).toMatch(/redemptions_used\s*-\s*[a-z_]+\.[a-z_]+/i);
    }
  });

  it('counts the voided rows in the same CTE that sums their cents', () => {
    // The money and the seats must come from the same aggregate over the same rows, or
    // they can disagree again in the other direction.
    const cteAggregates = [...sql.matchAll(/select\s+promotion_id\s*,([\s\S]*?)from\s+voided/gi)]
      .map((m) => m[1]);
    expect(cteAggregates).toHaveLength(2);
    for (const agg of cteAggregates) {
      expect(agg).toMatch(/sum\s*\(\s*amount_cents\s*\)/i);
      expect(agg).toMatch(/count\s*\(\s*\*\s*\)/i);
    }
  });

  it('still returns the budget as a sum, not a constant', () => {
    const spent = [...sql.matchAll(/spent_cents\s*=\s*greatest\s*\(\s*0\s*,([^)]*)\)/gi)]
      .map((m) => m[1].trim());
    expect(spent).toHaveLength(2);
    for (const s of spent) expect(s).toMatch(/spent_cents\s*-\s*[a-z_]+\.[a-z_]+/i);
  });

  it('still voids both the pending and the already-vested bonuses', () => {
    // The seat fix must not narrow what the passes reach; that was 20260814150000's fix.
    expect(sql).toMatch(/b\.state\s*=\s*'pending'/);
    expect(sql).toMatch(/b\.state\s*=\s*'payable'/);
  });
});
