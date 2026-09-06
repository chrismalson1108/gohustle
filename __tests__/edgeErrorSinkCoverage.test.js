// Every money edge function's TERMINAL catch must reach the error sink.
//
// THE FINDING THIS ENCODES (money-edge-escrow#4). CLAUDE.md states the convention:
// "Edge failures go to logServerError (_shared/logError.ts), not console.error", because
// Supabase's own function logs are not searchable next to the rest of the console and
// nobody tails them. stripe-cancel-payment — the function that RELEASES A CARD HOLD —
// did not import logError.ts at all: its terminal catch was `console.error` plus a
// generic 500, and the `payments` update after the Stripe cancel was unchecked.
//
// That mattered more there than almost anywhere else, because BOTH clients call it
// best-effort and swallow whatever it returns (src/context/JobsContext.js:
// declineBooking ignores the throw outright, cancelBooking retries once and ignores).
// So a hold release that failed — the intent already void via Stripe's 7-day expiry, a
// race with the webhook, a transport blip — left the payments row reading 'authorized'
// on a dead booking with the reason recorded NOWHERE. Detection existed
// (ctl_money_exposed_on_dead_booking six hours later, reconcile-stripe's
// hold_dead_at_stripe on the sweep); cause attribution did not, and an operator holding
// a finding that says "hold_never_released" with no cause has to guess.
//
// stripe-tip's terminal catch had the same shape and is fixed in the same change: it
// logged fatal failures INSIDE the body (the charged-but-not-credited branch) and then
// let every other throw out through a bare console.error.
//
// DISCRIMINATION: on the code as it stood, `terminalCatchLogs` was
// { 'stripe-cancel-payment': false, 'stripe-tip': false, ...rest true } and the second
// test fails on the pair. The rest guard the properties that would let the import exist
// and still tell an operator nothing.
const fs = require('fs');
const path = require('path');

const FN_DIR = path.join(__dirname, '..', 'supabase', 'functions');
const read = (fn) => fs.readFileSync(path.join(FN_DIR, fn, 'index.ts'), 'utf8');

// Every function that can move, hold or release a person's money. A new one belongs
// here — the list is short precisely so adding to it is a decision.
const MONEY_FNS = [
  'stripe-create-payment-intent',
  'accept-booking',
  'stripe-capture-payment',
  'stripe-cancel-payment',
  'earner-claim-payment',
  'stripe-tip',
  'admin-payment-action',
];

// The LAST `catch` in the file is the Deno.serve handler's own — the one that turns an
// unhandled throw into the 500 the caller sees. Anything logged in an inner catch is
// beside the point: this is the arm that runs when nothing else did.
function terminalCatchBody(src) {
  const re = /\}\s*catch\s*\(([^)]*)\)\s*\{/g;
  let m;
  let last = null;
  while ((m = re.exec(src))) last = m;
  if (!last) return null;
  return src.slice(last.index);
}

describe('the money functions cannot fail silently', () => {
  test('every one of them imports the sink', () => {
    const importing = Object.fromEntries(
      MONEY_FNS.map((fn) => [
        fn,
        /import\s*\{[^}]*logServerError[^}]*\}\s*from\s*'\.\.\/_shared\/logError\.ts'/.test(read(fn)),
      ]),
    );
    expect(importing).toEqual(Object.fromEntries(MONEY_FNS.map((fn) => [fn, true])));
  });

  test('every terminal catch writes to it', () => {
    // The finding itself, as one table so a failure names the function.
    const terminalCatchLogs = Object.fromEntries(
      MONEY_FNS.map((fn) => [fn, (terminalCatchBody(read(fn)) || '').includes('logServerError(')]),
    );
    expect(terminalCatchLogs).toEqual(Object.fromEntries(MONEY_FNS.map((fn) => [fn, true])));
  });

  test('the terminal catch still answers the caller — the sink never replaces the response', () => {
    // logServerError is best-effort and awaited; a catch that logged and then fell out
    // of the handler would hang the client instead of failing it.
    for (const fn of MONEY_FNS) {
      const tail = terminalCatchBody(read(fn)) || '';
      expect({ fn, responds: /return json\(/.test(tail) }).toEqual({ fn, responds: true });
    }
  });
});

describe('stripe-cancel-payment says WHICH hold failed, and why', () => {
  const src = read('stripe-cancel-payment');
  const tail = terminalCatchBody(src);

  test('the terminal catch carries the booking and the intent', () => {
    // A sink row that says only "it threw" cannot be joined to the poster whose money is
    // still held. Both ids are read from `let` bindings outside the try, because every
    // id in this function is declared INSIDE it and is out of scope in the catch.
    expect(src).toMatch(/let errBookingId/);
    expect(src).toMatch(/let errIntentId/);
    expect(tail).toMatch(/booking_id:\s*errBookingId/);
    expect(tail).toMatch(/payment_intent_id:\s*errIntentId/);
    // Stripe's own code is the difference between "already void" and "the key is dead".
    expect(tail).toMatch(/stripe_error_code/);
    // Money that should have been released and was not is fatal, not informational.
    expect(tail).toMatch(/fatal:\s*true/);
  });

  test('an already-void intent is reconciled instead of thrown', () => {
    // Stripe answers payment_intent_unexpected_state for an intent it already voided
    // (the 7-day authorization expiry, delete-account, a concurrent release). Throwing
    // there left our row on 'authorized' forever, because nothing retries: both clients
    // swallow this function's errors.
    expect(src).toMatch(/payment_intent_unexpected_state/);
    expect(src).toMatch(/alreadyVoid/);
  });

  test('...but not when the intent SUCCEEDED — that is the same error code', () => {
    // admin-payment-action learned this the expensive way: swallowing the code blindly
    // stamped 'cancelled' on a captured intent and told the operator the poster was
    // never charged. Probe the intent before concluding.
    expect(src).toMatch(/paymentIntents\.retrieve\(/);
    expect(src).toMatch(/pi\.status === 'succeeded'/);
    expect(src).toMatch(/amount_received/);
    // And it must refuse rather than write 'cancelled' over a real capture.
    expect(src).toMatch(/already captured/i);
  });

  test('the ledger write after a successful release is checked', () => {
    // The half the finding names second: the hold is gone at Stripe but the row still
    // reads 'authorized', and the result of the update was discarded. That is the exact
    // state ctl_money_exposed_on_dead_booking reports six hours later as
    // 'hold_never_released' with no cause attached.
    expect(src).toMatch(/const \{ error: updErr \} = await supabase\.from\('payments'\)/);
    expect(src).toMatch(/ledger_desync/);
  });
});
