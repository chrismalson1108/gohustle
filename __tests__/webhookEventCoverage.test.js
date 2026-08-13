// ─────────────────────────────────────────────────────────────────────────────
// Every event stripe-webhook handles must be an event Stripe is told to send.
//
// The failure this exists for shipped on 2026-08-12 and was found by hand a day later:
// stripe-webhook gained five correct `payout.*` cases, `stripe_payouts` was created,
// PaymentsScreen grew a Bank deposits section — and the Connect endpoint was subscribed
// to `account.updated` only. The feature was live, correct, and receiving nothing. It
// could not error, because nothing was being delivered to fail. An empty Bank deposits
// section reads to an earner as "no deposits yet", not as "we are not listening".
//
// reconcile-stripe now asserts the subscription against Stripe on every sweep, using two
// constant lists. Constants drift. So this closes the loop from the other side:
//
//   handler `case` labels  ⟷  reconcile-stripe's REQUIRED_* lists  ⟷  Stripe (the control)
//
// Add a case without adding it to the list and this fails. Put an event in the list that
// nothing handles and this fails too — a control demanding a subscription for an event
// nobody reads is the same lie in the other direction.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const FN = path.join(__dirname, '..', 'supabase', 'functions');
const handler = fs.readFileSync(path.join(FN, 'stripe-webhook', 'index.ts'), 'utf8');
const control = fs.readFileSync(path.join(FN, 'reconcile-stripe', 'index.ts'), 'utf8');

const handled = [...handler.matchAll(/case '([a-z_]+\.[a-z_.]+)':/g)].map((m) => m[1]);

function listFrom(name) {
  const block = control.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`));
  if (!block) return null;
  return [...block[1].matchAll(/"([a-z_]+\.[a-z_.]+)"/g)].map((m) => m[1]);
}
const required = {
  account: listFrom('REQUIRED_ACCOUNT_EVENTS'),
  connect: listFrom('REQUIRED_CONNECT_EVENTS'),
};

describe('webhook event coverage', () => {
  it('parsed both sides', () => {
    expect(handled.length).toBeGreaterThan(5);
    expect(required.account).not.toBeNull();
    expect(required.connect).not.toBeNull();
  });

  it('every handled event is one the control requires a subscription for', () => {
    const all = new Set([...(required.account ?? []), ...(required.connect ?? [])]);
    const unwatched = [...new Set(handled)].filter((e) => !all.has(e));
    // Name them: "coverage drifted" is useless, the event name is actionable.
    expect(unwatched).toEqual([]);
  });

  it('the control requires no event that nothing handles', () => {
    const h = new Set(handled);
    const phantom = [...(required.account ?? []), ...(required.connect ?? [])].filter((e) => !h.has(e));
    expect(phantom).toEqual([]);
  });

  it('routes connected-account events to the CONNECT destination', () => {
    // account.updated and payout.* only arrive on the connected-account destination.
    // Listing them under the account destination would make the control assert the
    // wrong endpoint and pass while the real one is empty — the original bug, re-armed.
    const connectOnly = handled.filter((e) => e.startsWith('payout.') || e === 'account.updated');
    const misfiled = connectOnly.filter((e) => (required.account ?? []).includes(e));
    expect(misfiled).toEqual([]);
    for (const e of connectOnly) expect(required.connect).toContain(e);
  });
});
