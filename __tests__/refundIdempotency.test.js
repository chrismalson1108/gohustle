// ─────────────────────────────────────────────────────────────────────────────
// A replayed Stripe refund must be a ledger no-op, and the in-flight marker must not
// outlive the action it marks.
//
// admin-payment-action builds Stripe's idempotency key from a value it read BEFORE the
// call (`refund_${pi}_${alreadyRefunded + refundCents}`). InterventionPanel clears the
// form only on success, so after its 20s timeout the operator's retry sends
// byte-identical FormData — same key. Stripe REPLAYS: it hands back the original Refund
// object and moves no money. Nothing inspected refund.id to notice, so record_refund
// ran twice: refunded_cents doubled and debit_earnings debited the earner twice for one
// refund. ctl_earnings_total_drift reconstructs the expected clawback FROM
// refunded_cents, so the doubled figures agree with each other and it stays green.
//
// stripe-tip solved this one function over — tip_ledger + a UNIQUE payment_intent_id,
// where the INSERT conflict IS the check. Refunds now have the same shape, keyed on
// Stripe's refund.id.
//
// Separately: `refund_source` was stamped 'admin' before the Stripe call and cleared by
// nothing, anywhere. It says "a remediation is in flight, do not file a disputes row" —
// a statement about one action, in a flag that was permanent. So a later EXTERNAL
// refund on the same payment also filed no row, and the /disputes queue,
// ctl_external_reversal_not_ledgered and dispute_open_beyond_sla never learned of it.
//
// This asserts the shape of both fixes. The arithmetic is proved where it can actually
// run — the rolled-back probe in 20260814010000, which stages a refund, replays it, and
// requires refunded_cents and earnings to be unmoved by the replay while a genuine
// second refund still records.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MIG = path.join(ROOT, 'supabase', 'migrations');
const FN = path.join(ROOT, 'supabase', 'functions');

const admin = fs.readFileSync(path.join(FN, 'admin-payment-action', 'index.ts'), 'utf8');
const webhook = fs.readFileSync(path.join(FN, 'stripe-webhook', 'index.ts'), 'utf8');

// The live definition is the last migration to define it — same rule Postgres applies.
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
  const last = files[files.length - 1];
  return { file: last, sql: fs.readFileSync(path.join(MIG, last), 'utf8') };
}

const recordRefund = latestDefining('record_refund');

describe('the refund ledger makes a Stripe replay a no-op', () => {
  it('there is a refund_ledger keyed UNIQUE on the external id', () => {
    const created = fs
      .readdirSync(MIG)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => fs.readFileSync(path.join(MIG, f), 'utf8'))
      .find((s) => /create table if not exists public\.refund_ledger/i.test(s));
    expect(created).toBeDefined();
    // UNIQUE is the whole mechanism — without it the insert is just a log line.
    expect(created).toMatch(/external_id\s+text not null unique/i);
    // Same posture as tip_ledger: RLS on, no policies, service-role only.
    expect(created).toMatch(/alter table public\.refund_ledger enable row level security/i);
  });

  it('record_refund claims the reversal by INSERT … ON CONFLICT, not read-then-decide', () => {
    expect(recordRefund.sql).toMatch(/insert into public\.refund_ledger/i);
    expect(recordRefund.sql).toMatch(/on conflict \(external_id\) do nothing/i);
    // A conflict must return early, before the refunded_cents increment and the debit.
    const body = recordRefund.sql;
    const conflictAt = body.search(/on conflict \(external_id\) do nothing/i);
    const incrementAt = body.search(/set refunded_cents\s*=\s*v_new/i);
    const debitAt = body.search(/perform public\.debit_earnings/i);
    expect(conflictAt).toBeGreaterThan(-1);
    expect(conflictAt).toBeLessThan(incrementAt);
    expect(conflictAt).toBeLessThan(debitAt);
    expect(body).toMatch(/if not found then[\s\S]{0,400}?return v_already;/i);
  });

  it('claims AFTER the over-refund cap, so a refused refund leaves no ledger row', () => {
    // Otherwise a corrected retry looks like a replay and is silently swallowed.
    const capAt = recordRefund.sql.search(/v_already \+ p_cents > v_captured/);
    const claimAt = recordRefund.sql.search(/insert into public\.refund_ledger/i);
    expect(capAt).toBeGreaterThan(-1);
    expect(capAt).toBeLessThan(claimAt);
  });

  it('dropped the old arity first so 5-arg calls are not ambiguous', () => {
    // Postgres raises "function is not unique" rather than picking the exact match.
    expect(recordRefund.sql).toMatch(
      /drop function if exists public\.record_refund\(uuid, integer, text, uuid, boolean\)/i,
    );
  });

  it('the probe proves a replay changes nothing and a real second refund still lands', () => {
    expect(recordRefund.sql).toMatch(/REPLAY DOUBLE-COUNTED/);
    expect(recordRefund.sql).toMatch(/REPLAY DEBITED AGAIN/);
    expect(recordRefund.sql).toMatch(/OVER-CORRECTED/);
    // Seeded balance: debit_earnings floors at 0, so a zero-balance probe passes
    // vacuously — the trap the chargeback probe hit on 2026-08-13.
    expect(recordRefund.sql).toMatch(/earnings_total = e0 \+ 500/);
    // And it must CHECK the seed landed. A tombstoned profile's guard silently refuses
    // the write, and the probe then failed as "not discriminating" — a true statement
    // about the wrong cause, which cost two push attempts to work out.
    expect(recordRefund.sql).toMatch(/could not seed a balance/);
    expect(recordRefund.sql).toMatch(/deleted_at is null/);
    // debit_earnings returns false outright unless the capture was credited, so the
    // staged payment must say so or no debit happens at all.
    expect(recordRefund.sql).toMatch(/earnings_credited/);
  });
});

describe('every record_refund caller supplies an idempotency key', () => {
  const calls = [...admin.matchAll(/rpc\('record_refund',\s*\{([\s\S]*?)\}\)/g)].map((m) => m[1]);

  it('found both console reversal paths', () => {
    expect(calls.length).toBe(2); // refund + record_reversal
  });

  it('none of them can record the same reversal twice', () => {
    const missing = calls.filter((c) => !/p_external_id:/.test(c));
    expect(missing).toEqual([]);
  });

  it('the refund path keys on Stripe refund.id, not on the local running total', () => {
    const refundCall = calls.find((c) => /p_debit_earner:\s*true/.test(c));
    expect(refundCall).toBeDefined();
    // `refund_${pi}_${alreadyRefunded + refundCents}` is precisely the key that a
    // replay reproduces — it must not be reused as the ledger key.
    expect(refundCall).toMatch(/p_external_id:\s*refund\.id/);
  });

  it('the manual chargeback key excludes the reason text', () => {
    // Keying on free text lets a retyped word bypass the guard, which is the failure.
    const cbCall = calls.find((c) => /p_debit_earner:\s*false/.test(c));
    expect(cbCall).toBeDefined();
    expect(cbCall).toMatch(/p_external_id:\s*`chargeback_\$\{pay\.payment_intent_id\}_\$\{cents\}`/);
    expect(cbCall).not.toMatch(/p_external_id:[^,]*reason/);
  });
});

describe('the in-flight refund marker does not outlive the refund', () => {
  it('record_refund clears refund_source when it ledgers the refund', () => {
    expect(recordRefund.sql).toMatch(/refund_source\s*=\s*null/i);
  });

  it('the webhook exemption also self-clears via the cumulative refunded total', () => {
    // Covers the ordering the marker cannot: webhook arriving after record_refund
    // committed and cleared the flag.
    expect(webhook).toContain('alreadyLedgered');
    expect(webhook).toMatch(/refunded_cents \?\? 0\)\s*>=\s*stripeRefundedCents/);
    expect(webhook).toContain('charge.amount_refunded');
  });

  it('still exempts refunds only — never a chargeback', () => {
    // A chargeback is a cardholder going to their bank; no admin can initiate one, so
    // no admin-remediation exemption can apply to it.
    expect(webhook).toMatch(/if \(kind === 'refund'\) \{/);
  });
});
