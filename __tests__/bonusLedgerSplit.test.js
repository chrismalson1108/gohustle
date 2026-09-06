// ─────────────────────────────────────────────────────────────────────────────
// A split referral credit must not collide with the row it was split from.
//
// bonus_ledger carries a UNIQUE partial index — bonus_ledger_dedupe on
// (user_id, reason, source_booking_id) where source_booking_id is not null — and
// accrue_referral_bonus stamps every real referral bonus with a source_booking_id. So
// the accrual key is already taken by the parent row.
//
// Both functions that SPLIT a credit write two rows out of one:
//
//   consume_fee_credit      shrinks the payable parent, inserts the applied fragment
//   return_unused_fee_credit shrinks the applied parent, inserts the payable remainder
//
// If both rows end up carrying the same source_booking_id, the INSERT raises
// unique_violation — and every caller swallows it (pin_booking_amount zeroes the credit
// in an `exception when others`, stripe-capture-payment logs and continues, record_refund
// warns deliberately so a bookkeeping failure cannot roll back a refund). The credit is
// then never applied, or never returned, and only a warning in the postgres log says so.
//
// That is not hypothetical. The original consume_fee_credit (20260806080000) inserted the
// fragment with a literal `null`; the 20260814150000 rewrite — which reproduced the whole
// body to add the kill-switch check — changed that one value to `r2.source_booking_id`,
// and return_unused_fee_credit was written against the broken shape. It survived two
// self-asserting migrations because BOTH probes staged their ledger row without a
// source_booking_id, and the partial index does not cover NULLs.
//
// So the rule this test enforces is the one thing a probe can miss: in the split branch,
// the two rows must not share the key. Either the inserted fragment does not carry the
// parent's source_booking_id, or the parent gives it up in the same branch. Fixed by
// 20260906011000; this fails against either pre-fix body.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'supabase', 'migrations');
const FILES = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();

// The LAST migration that defines a function is the live definition — an earlier one
// says nothing about what production runs.
function liveDefinition(fnName) {
  const head = `create or replace function public.${fnName}(`;
  let found = null;
  for (const f of FILES) {
    const sql = fs.readFileSync(path.join(DIR, f), 'utf8');
    const at = sql.lastIndexOf(head);
    if (at === -1) continue;
    // Body runs from the opening $$ to the closing $$; of that definition.
    const open = sql.indexOf('$$', at);
    const close = sql.indexOf('$$;', open + 2);
    if (open === -1 || close === -1) continue;
    found = { file: f, body: sql.slice(open + 2, close) };
  }
  return found;
}

// The statement starting at `from`, up to its terminating semicolon. Neither statement
// we look at contains a semicolon of its own.
function statementAt(body, from) {
  const end = body.indexOf(';', from);
  return body.slice(from, end + 1);
}

describe('bonus_ledger split rows cannot collide with bonus_ledger_dedupe', () => {
  it('still has the unique index that makes this a rule and not a preference', () => {
    const promotions = fs.readFileSync(
      path.join(DIR, '20260806070000_promotions.sql'),
      'utf8',
    );
    // Whitespace-insensitive: the index is what makes a duplicated key fatal.
    const flat = promotions.replace(/\s+/g, ' ');
    expect(flat).toContain(
      'create unique index if not exists bonus_ledger_dedupe on public.bonus_ledger '
        + '(user_id, reason, source_booking_id) where source_booking_id is not null',
    );
  });

  it('every real referral bonus occupies that key', () => {
    const accrual = fs.readFileSync(
      path.join(DIR, '20260806250000_referral_once_per_person.sql'),
      'utf8',
    );
    // accrue_referral_bonus inserts with source_booking_id = new.id, so the parent row a
    // split divides always has a non-null key. This is why the NULL-staged probes in
    // 20260814150000 and 20260813130000 could not reproduce the collision.
    expect(accrual.replace(/\s+/g, ' ')).toContain(
      "'pending', new.id, new.earner_id, now() + interval '7 days'",
    );
  });

  for (const fn of ['consume_fee_credit', 'return_unused_fee_credit']) {
    describe(fn, () => {
      const live = liveDefinition(fn);

      it('has a live definition to check', () => {
        expect(live).not.toBeNull();
      });

      it('splits into two rows that do not share (user_id, reason, source_booking_id)', () => {
        const { body, file } = live;

        // The split is the only place either function inserts, so there is no ambiguity
        // about which statement the rule below is talking about.
        const inserts = body.split('insert into public.bonus_ledger').length - 1;
        expect(`${fn}: ${inserts} bonus_ledger insert(s)`).toBe(`${fn}: 1 bonus_ledger insert(s)`);

        const insertAt = body.indexOf('insert into public.bonus_ledger');
        const insertStmt = statementAt(body, insertAt);

        // The parent row of the split: the UPDATE immediately before the insert.
        const updateAt = body.lastIndexOf('update public.bonus_ledger', insertAt);
        expect(updateAt).toBeGreaterThan(-1);
        const updateStmt = statementAt(body, updateAt);

        // The fragment carries the parent's accrual key…
        const fragmentCopiesKey = /\b[a-z_]\w*\.source_booking_id\b/.test(insertStmt);
        // …only if the parent gives it up in the same breath.
        const parentReleasesKey = /source_booking_id\s*=\s*null/i.test(updateStmt);

        const explanation = [
          `${fn} (${file}) splits one bonus_ledger row into two and both would carry the`,
          "same source_booking_id, which bonus_ledger_dedupe rejects. The INSERT raises",
          'unique_violation and every caller swallows it, so the credit is silently never',
          'applied (or never returned). Either insert the fragment with a literal null, or',
          'clear source_booking_id on the parent in the same branch — whichever leaves the',
          'PAYABLE side holding the key, because that is the state vest_bonuses can claw back.',
        ].join(' ');

        expect(fragmentCopiesKey && !parentReleasesKey ? explanation : 'ok').toBe('ok');
      });

      it('leaves the accrual key on the payable side of the split', () => {
        const { body, file } = live;
        const insertAt = body.indexOf('insert into public.bonus_ledger');
        const insertStmt = statementAt(body, insertAt);
        const insertsPayable = /'payable'/.test(insertStmt);
        const fragmentCopiesKey = /\b[a-z_]\w*\.source_booking_id\b/.test(insertStmt);

        // The inserted row is payable  ⇒ it must keep the key (return_unused).
        // The inserted row is applied  ⇒ it must not (consume).
        const why = insertsPayable
          ? `${fn} (${file}) mints the PAYABLE remainder and drops its source_booking_id — `
            + 'vest_bonuses reaches a bonus for clawback through that column and only ever '
            + 'touches pending/payable rows, so the remainder would be beyond clawback forever.'
          : `${fn} (${file}) mints the APPLIED fragment carrying source_booking_id. Nothing `
            + 'reads that column on an applied row, and carrying it is what collides with the '
            + 'payable parent on bonus_ledger_dedupe.';

        expect(fragmentCopiesKey === insertsPayable ? 'ok' : why).toBe('ok');
      });
    });
  }
});
