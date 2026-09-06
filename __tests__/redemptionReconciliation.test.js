// ─────────────────────────────────────────────────────────────────────────────
// A campaign counter is only reconciled against the ledger its OWN kind writes.
//
// ctl_redemption_double_charge compared promotions.redemptions_used against
// promo_redemptions for every campaign, and promo_redemptions is written by exactly two
// paths — consume_promo_grant (fee_override) and consume_poster_discount
// (poster_discount). A BONUS campaign is charged by accrue_referral_bonus, which records
// the bonus in bonus_ledger and increments redemptions_used, and never writes a
// promo_redemptions row. So the first referral bonus a campaign ever minted put it at
// 1 <> 0 and opened a CRITICAL 'money' finding that could never auto-resolve.
//
// The cost is not only the page. control_findings is unique on (control_key, entity_id)
// where resolved_at is null, so the standing false positive OCCUPIES the row a genuine
// double charge on that campaign would have opened — the detector is blinded on exactly
// the campaigns whose ledger it cannot read.
//
// This is a static guard because the failure is a missing JOIN, and a missing join is
// invisible: the control keeps running, keeps returning rows, and keeps looking healthy.
// The invariant it asserts is the one that broke — every ledger a campaign can be charged
// against must appear in the control that reconciles the charges.
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

describe('the redemption reconciliation reads the ledger each campaign kind writes', () => {
  const { body } = latestDefinition('ctl_redemption_double_charge');

  it('the control is defined at all', () => {
    expect(typeof body).toBe('string');
    expect(body.length).toBeGreaterThan(200);
  });

  it('reconciles bonus campaigns against bonus_ledger, not promo_redemptions', () => {
    // Without this, every bonus campaign that pays out is a permanent CRITICAL.
    expect(body).toMatch(/public\.bonus_ledger/);
  });

  it('keeps the promo_redemptions arm that catches the original defect', () => {
    expect(body).toMatch(/public\.promo_redemptions/);
  });

  it('scopes each arm by kind, so neither ledger is compared against the wrong campaigns', () => {
    // Both directions must be expressed: the promo_redemptions arm must exclude bonus,
    // and the bonus_ledger arm must be limited to it. A body that joins both tables with
    // no kind predicate reconciles every campaign against both and is worse than before.
    expect(body).toMatch(/kind\s*<>\s*'bonus'/);
    expect(body).toMatch(/kind\s*=\s*'bonus'/);
  });

  it('counts bonus MINTING rows only, so a split credit is not a second charge', () => {
    // consume_fee_credit splits a partly-usable credit into a second bonus_ledger row
    // carrying a NULL source_booking_id. That is bookkeeping on a bonus already charged
    // for; counting it would recreate the same false positive from the other side.
    expect(body).toMatch(/source_booking_id is not null/);
    // And a voided bonus has had its budget and seat returned, so it is not a live charge.
    expect(body).toMatch(/state\s*<>\s*'void'/);
  });
});

describe('every path that charges a campaign writes a ledger the control reads', () => {
  // The generalisation of the bug: someone adds a third way to increment
  // redemptions_used, records it somewhere new, and the reconciliation silently starts
  // reporting that campaign forever. Enumerate the ledgers the charging paths write and
  // require each to appear in the control.
  const all = files.map((f) => fs.readFileSync(path.join(MIG, f), 'utf8')).join('\n');
  const { body } = latestDefinition('ctl_redemption_double_charge');

  it('finds the charging paths', () => {
    expect(all).toMatch(/set redemptions_used = redemptions_used \+ 1/);
  });

  for (const ledger of ['promo_redemptions', 'bonus_ledger']) {
    it(`${ledger} — a campaign can be charged against it, so the control must read it`, () => {
      expect(all).toMatch(new RegExp(`insert into public\\.${ledger}`));
      expect(body).toMatch(new RegExp(`public\\.${ledger}`));
    });
  }
});
