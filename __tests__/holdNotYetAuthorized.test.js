// ─────────────────────────────────────────────────────────────────────────────
// "escrow is held" must mean a hold was OBSERVED, never that an intent was created.
//
// stripe-create-payment-intent minted a manual-capture PaymentIntent with no payment
// method and no confirm — Stripe state `requires_payment_method`, holding nothing — and
// immediately upserted `status: 'authorized', authorized_at: now()`. Its own heal branch
// a hundred lines above refuses that exact write for that exact Stripe state, and spells
// out the consequence: it "would tell expire_stale_pending_bookings and
// ctl_escrow_hold_lapsed_uncancelled that escrow exists when it does not".
//
// A poster who opens "Accept & pay" and swipes the sheet away leaves that row behind.
// Both clients treat a dismissal as "not a real error" and cancel nothing, and Stripe
// fires no webhook on abandonment — so the booking never expired (the 14-day sweep skips
// anything with a live hold), the slot stayed taken so no other earner could book it, the
// earner sat in Awaiting forever, and at eight days a CRITICAL control announced that a
// hold had LAPSED on a hold that was never placed.
//
// The fix is a pre-authorization state. Every consumer already spells "money is held" as
// `status = 'authorized'`, so 'pending' is correct everywhere by construction — but ONLY
// if the promotion to 'authorized' is tied to an observed requires_capture, and only if
// the two paths that can observe it both exist. accept-booking is the normal one. The
// recovery re-hold has no accept step at all (the booking is no longer 'pending', so
// accept-booking refuses it), which is why payment_intent.amount_capturable_updated had
// to be handled — and why it has to be subscribed, or the promotion silently never
// happens and settlement is refused against money that is genuinely held.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FN = path.join(ROOT, 'supabase', 'functions');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

const create = read(FN, 'stripe-create-payment-intent', 'index.ts');
const accept = read(FN, 'accept-booking', 'index.ts');
const webhook = read(FN, 'stripe-webhook', 'index.ts');
// The capture path is TWO files since 2026-09-09: a poster's reduction became a
// proposal, so the actual Stripe capture moved to _shared/settleEscrow.ts where
// stripe-capture-payment and settle-disputes both call it. Reading only one of them
// would leave every assertion below passing against a file the money no longer
// flows through. Concatenated, so the guards keep their meaning wherever it lives.
const capture = read(FN, '_shared', 'settleEscrow.ts')
  + '\n' + read(FN, 'stripe-capture-payment', 'index.ts');
const claim = read(FN, 'earner-claim-payment', 'index.ts');
// The ledger arithmetic and its wording moved to shared/ledger.js on 2026-09-05, when
// the website gained a Transactions page and a second hand-written copy of money maths
// was the alternative. src/lib/payments.js is now a re-export, so read the definition
// where it lives — and assert the mobile module still points at it, or this guard would
// pass against a shared copy the app had stopped using.
const ledger = read(ROOT, 'shared', 'ledger.js');
const mobileLedger = read(ROOT, 'src', 'lib', 'payments.js');
const migration = read(
  ROOT, 'supabase', 'migrations',
  '20260906013100_a_hold_that_was_never_placed_read_as_live_escrow.sql',
);

// The payments upsert that follows paymentIntents.create — the write under test.
const createUpsert = create.slice(
  create.indexOf('const { error: payErr } = await supabase.from(\'payments\').upsert({'),
  create.indexOf('if (payErr) {'),
);

describe('creating a PaymentIntent does not claim escrow', () => {
  test('found the create-path upsert', () => {
    expect(createUpsert.length).toBeGreaterThan(100);
    // It really is downstream of the create, not some other write.
    expect(create.indexOf('stripe.paymentIntents.create(')).toBeLessThan(
      create.indexOf('const { error: payErr } = await supabase.from(\'payments\').upsert({'),
    );
  });

  test("it writes 'pending', not 'authorized'", () => {
    expect(createUpsert).toMatch(/status: 'pending',/);
    // The regression, verbatim.
    expect(createUpsert).not.toMatch(/status: 'authorized'/);
  });

  test('a row it just wrote is still re-holdable', () => {
    // Otherwise the poster who abandoned the sheet can never accept again: the status
    // gate would call their own unconfirmed intent "a settled payment".
    expect(create).toMatch(
      /!\['pending', 'authorized', 'failed', 'cancelled'\]\.includes\(existingPay\.status\)/,
    );
    expect(create).toMatch(/const isRecovery = \['pending', 'cancelled', 'failed'\]/);
  });

  test('the heal branch still refuses to promote anything but requires_capture', () => {
    // The rule the create path was breaking. It must survive the fix.
    expect(create).toMatch(
      /existingPI\.status === 'requires_capture' && existingPay\.status !== 'authorized'/,
    );
  });
});

describe("'authorized' is only ever written on an observed requires_capture", () => {
  test('accept-booking promotes a pending row after retrieving the intent', () => {
    expect(accept).toMatch(/if \(pi\.status !== 'requires_capture'\)/);
    expect(accept).toMatch(/\.in\('status', \['pending', 'authorized', 'failed'\]\)/);
    // 'cancelled' and 'captured' must never be resurrected.
    const inList = /\.in\('status', \[([^\]]*)\]\)/.exec(accept)[1];
    expect(inList).not.toMatch(/cancelled|captured/);
  });

  test('the webhook handles amount_capturable_updated — the recovery path', () => {
    expect(webhook).toMatch(/case 'payment_intent\.amount_capturable_updated': \{/);
  });

  test('that handler checks Stripe actually holds money before promoting', () => {
    const body = webhook
      .slice(
        webhook.indexOf("case 'payment_intent.amount_capturable_updated':"),
        webhook.indexOf("case 'payment_intent.canceled':"),
      )
      // Comments here name the statuses they exclude; assert on the code.
      .replace(/^\s*\/\/.*$/gm, '');
    expect(body).toMatch(/pi\.status === 'requires_capture'/);
    expect(body).toMatch(/amount_capturable/);
    expect(body).toMatch(/status: 'authorized'/);
    // Status-predicated like every sibling: never resurrect a settled row.
    expect(body).toMatch(/\.in\('status', \['pending', 'failed'\]\)/);
    expect(body).not.toMatch(/cancelled|captured/);
    // It promotes the MONEY record only. Confirming the booking is the poster's act,
    // and accept-booking owns it.
    expect(body).not.toMatch(/from\('bookings'\)/);
  });

  test('a lapsed unconfirmed intent can still be marked cancelled', () => {
    const body = webhook.slice(
      webhook.indexOf("case 'payment_intent.canceled':"),
      webhook.indexOf("case 'charge.refunded':"),
    );
    expect(body).toMatch(/\.in\('status', \['pending', 'authorized'\]\)/);
    // Never a captured row: that money already moved.
    expect(body.replace(/^\s*\/\/.*$/gm, '')).not.toMatch(/'captured'/);
  });
});

describe("nothing settles against a hold that was never placed", () => {
  test('stripe-capture-payment refuses a pending row', () => {
    expect(capture).toMatch(/if \(payment\.status === 'pending'\) \{/);
    const at = capture.indexOf("if (payment.status === 'pending') {");
    expect(capture.slice(at, at + 400)).toMatch(/HOLD_EXPIRED/);
  });

  test('earner-claim-payment refuses a pending row', () => {
    expect(claim).toMatch(/if \(payment\.status === 'pending'\) \{/);
    const at = claim.indexOf("if (payment.status === 'pending') {");
    expect(claim.slice(at, at + 400)).toMatch(/HOLD_EXPIRED/);
  });

  test('the claim-before-capture compare-and-swap is unchanged', () => {
    // A 'pending' row must not be capturable by slipping into the claim predicate.
    expect(capture).toMatch(/\.eq\('status', 'authorized'\)\n\s*\.select\('id'\)/);
  });
});

describe('the ledger never shows a poster or earner escrow that is not there', () => {
  test('both sides have wording for a hold that was never completed', () => {
    expect(ledger).toMatch(/^\s*pending: .*earner|pending:\s*\{/m);
    const earner = ledger.slice(ledger.indexOf('earner: {'), ledger.indexOf('poster: {'));
    const poster = ledger.slice(ledger.indexOf('poster: {'), ledger.indexOf('};', ledger.indexOf('poster: {')));
    expect(earner).toMatch(/pending:\s*\{/);
    expect(poster).toMatch(/pending:\s*\{/);
    // The whole point: it must not read as money.
    const pendingEarner = /pending:\s*\{[^}]*\}/.exec(earner)[0];
    expect(pendingEarner).not.toMatch(/escrow|Held by|held securely/i);
    expect(pendingEarner).toMatch(/tone: 'muted'/);
  });

  test("only 'authorized' counts as money in flight", () => {
    expect(ledger).toMatch(/pending: row\.status === 'authorized',/);
  });

  test('the mobile module still serves this from the shared definition', () => {
    // Without this, the two assertions above could pass while src/lib/payments.js
    // carried its own drifted copy again.
    expect(mobileLedger).toMatch(/from '\.\.\/\.\.\/shared\/ledger(\.js)?'|shared\/ledger/);
    expect(mobileLedger).toMatch(/paymentState/);
  });
});

describe('the database can represent the state, and something watches it', () => {
  test('the status CHECK admits pending and nothing else new', () => {
    expect(migration).toMatch(
      /check \(status in \('pending', 'authorized', 'captured', 'cancelled', 'failed'\)\)/,
    );
  });

  test('a live booking with no escrow behind it has a registered control', () => {
    expect(migration).toMatch(/create or replace function public\.ctl_hold_never_confirmed_on_live_booking\(\)/);
    expect(migration).toMatch(/'hold_never_confirmed_on_live_booking',/);
    expect(migration).toMatch(/'ctl_hold_never_confirmed_on_live_booking'\)/);
  });

  test('that control looks at live bookings, not the ordinary abandoned sheet', () => {
    // A 'pending' row under a still-'pending' booking now self-heals through the
    // 14-day sweep. Reporting those would be noise on every abandoned pay sheet.
    expect(migration).toMatch(/b\.status in \('confirmed', 'completed', 'verified'\)/);
  });

  test('the probe proves the sweep behaviour changed, not just the label', () => {
    // It stages one 30-day application twice — once as 'authorized' (survives the
    // sweep, the bug) and once as 'pending' (expires and frees the slot, the fix).
    expect(migration).toMatch(/expire_stale_pending_bookings\(14\)/);
    expect(migration).toMatch(/FIX FAILED: a 30-day application with no hold is still not expired/);
    expect(migration).toMatch(/the slot is still taken, so nobody else can book it/);
  });
});
