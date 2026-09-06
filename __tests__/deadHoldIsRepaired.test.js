// ─────────────────────────────────────────────────────────────────────────────
// A hold Stripe says does not exist must be CORRECTED, not just reported.
//
// Found on live production data, 2026-09-06, not by reading code: the board carried
// one open CRITICAL from `stripe_reconciliation` — a $150 payment row six days old
// saying `authorized` while Stripe said `requires_payment_method`. A poster had
// opened the pay sheet and closed it. 20260906013100 stopped NEW rows being stamped
// that way; this row predated it, and reconcile-stripe only ever pushed a
// `hold_dead_at_stripe` problem into a finding and moved on.
//
// Reporting alone is not enough here, because the wrong status is load-bearing:
//   · expire_stale_pending_bookings treats `authorized` as live escrow and skips the
//     booking, so it never expires and the slot never returns to the market — the
//     earner waits on an application no one can accept.
//   · ctl_stranded_pending_booking looks for payments.status = 'pending', so the new
//     control cannot see this row either.
//   · ctl_escrow_hold_lapsed_uncancelled then opens a SECOND, misleading CRITICAL at
//     eight days saying a hold lapsed, when no hold was ever placed.
//
// Stripe is the authority on whether money is held, and this is the one direction
// that is safe to write from it: a claim Stripe has already contradicted is
// withdrawn. Never the reverse — nothing here may invent a hold, move money, or
// touch a captured row.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'supabase/functions/reconcile-stripe/index.ts'),
  'utf8',
);
// Comment-stripped: this branch explains itself at length, and a guard satisfied by
// its own prose is not a guard.
const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

// The dead-hold branch, from its condition to the finding push that closes it.
const branch = (() => {
  const i = code.indexOf('p.status === "authorized" && (pi.status === "canceled"');
  expect(i).toBeGreaterThan(-1);
  return code.slice(i, i + 1800);
})();

describe('reconcile-stripe repairs a hold Stripe says is not there', () => {
  it('writes the correction rather than only filing a finding', () => {
    expect(branch).toMatch(/\.from\("payments"\)/);
    expect(branch).toMatch(/\.update\(\{\s*status:\s*corrected\s*\}\)/);
  });

  it('maps each Stripe terminal state to the status that means what it means', () => {
    // requires_payment_method = the intent exists and nothing is held, which is
    // exactly what 20260906013100 defined 'pending' to mean. canceled is terminal.
    expect(branch).toMatch(/pi\.status === "canceled" \? "cancelled" : "pending"/);
  });

  it('re-asserts the status it read, so a concurrent capture wins', () => {
    // Without this the sweep could overwrite a capture that landed between the
    // Stripe read and this write, turning a real payment back into a non-hold.
    expect(branch).toMatch(/\.eq\("status",\s*"authorized"\)/);
  });

  it('never writes any other status from this branch', () => {
    // The whole safety argument is that this only ever WITHDRAWS a claim. A branch
    // that could write 'captured' or 'authorized' would be inventing money.
    const writes = [...branch.matchAll(/status:\s*"([a-z]+)"/g)].map((m) => m[1]);
    expect(writes.filter((w) => w !== 'cancelled' && w !== 'pending')).toEqual([]);
    expect(branch).not.toMatch(/amount|earner_amount_cents|fee_cents|refunded_cents/);
  });

  it('still records the finding, and says whether the repair worked', () => {
    // An operator should know a poster's payment silently failed to arm. The
    // repaired flag is also what lets the finding auto-resolve on the next sweep.
    expect(branch).toMatch(/kind:\s*"hold_dead_at_stripe"/);
    expect(branch).toMatch(/repaired:\s*true/);
    expect(branch).toMatch(/repaired:\s*false/);
    expect(branch).toMatch(/corrected_to:\s*corrected/);
  });

  it('a failed correction reaches /errors rather than the function log', () => {
    // CLAUDE.md: edge failures go to logServerError → client_errors → the console.
    expect(branch).toMatch(/logServerError\("reconcile-stripe"/);
    expect(code).toMatch(/import \{ logServerError \} from "\.\.\/_shared\/logError\.ts"/);
  });

  it('the statuses it writes are ones the schema admits', () => {
    // 20260906013100 widened the CHECK to include 'pending'; without that migration
    // this repair would raise 23514 on every dead hold.
    const mig = fs.readFileSync(
      path.join(__dirname, '..', 'supabase/migrations/20260906013100_a_hold_that_was_never_placed_read_as_live_escrow.sql'),
      'utf8',
    );
    expect(mig).toMatch(/check \(status in \('pending', 'authorized', 'captured', 'cancelled', 'failed'\)\)/);
  });
});
