const fs = require('fs');
const path = require('path');

// Tips were the one uncapped, fee-free, card-funded transfer channel in the product.
// stripe-tip bounds a SINGLE call to 50¢–$1000, but its idempotency key is
// `tip_${bookingId}_${tipCents}` — so varying the amount mints a fresh PaymentIntent
// and nothing bounded the cumulative total. Tips also carry NO application_fee_amount
// (unlike stripe-create-payment-intent's 10%), so 100% routes to the earner's
// connected balance, which pays out daily with no delay_days. Because these are
// destination charges, a later chargeback claws back from the PLATFORM balance.
//
// The caps therefore have to hold in two places, and this pins both:
//   1. stripe-tip must check BEFORE creating the PaymentIntent — the trigger fires at
//      claim_and_credit_tip time, which is after the card is charged, so a
//      trigger-only design strands the poster's money in the connected account.
//   2. trg_guard_tip_caps must NOT exempt service_role — tip_ledger is written only by
//      claim_and_credit_tip (SECURITY DEFINER, invoked with the service key), so the
//      usual `if auth.role() = 'service_role' then return new` idiom used by the
//      client-facing guards would make this trigger a no-op.
const ROOT = path.join(__dirname, '..');
const EDGE = path.join(ROOT, 'supabase', 'functions', 'stripe-tip', 'index.ts');
const MIGRATION = path.join(ROOT, 'supabase', 'migrations', '20260804000000_tip_caps.sql');

const edge = fs.readFileSync(EDGE, 'utf8');
const sql = fs.readFileSync(MIGRATION, 'utf8');

describe('tip caps — edge function pre-check', () => {
  test('stripe-tip asks for the remaining headroom', () => {
    expect(edge).toContain("rpc('tip_headroom_cents'");
  });

  test('the cap is checked BEFORE the card is charged', () => {
    const capCheck = edge.indexOf("rpc('tip_headroom_cents'");
    const charge = edge.indexOf('stripe.paymentIntents.create');
    expect(capCheck).toBeGreaterThan(-1);
    expect(charge).toBeGreaterThan(-1);
    // If this ever inverts, an over-cap tip charges the poster and is then rejected
    // by the trigger, leaving money in the earner's balance with no ledger row.
    expect(capCheck).toBeLessThan(charge);
  });

  test('a failed cap lookup refuses the tip rather than charging blind', () => {
    const seg = edge.slice(edge.indexOf("rpc('tip_headroom_cents'"), edge.indexOf('stripe.paymentIntents.create'));
    expect(seg).toMatch(/if \(capErr\)/);
    expect(seg).toMatch(/return json\(/);
  });

  test('a tip charged but not credited is reported as fatal, not swallowed', () => {
    const seg = edge.slice(edge.indexOf("claim_and_credit_tip"));
    expect(seg).toContain('logServerError');
    expect(seg).toMatch(/fatal: true/);
  });
});

describe('tip caps — database backstop', () => {
  test('the trigger fires BEFORE INSERT on tip_ledger', () => {
    expect(sql).toMatch(/create trigger trg_guard_tip_caps\s+before insert on public\.tip_ledger/);
  });

  test('the guard does NOT exempt service_role', () => {
    const fn = sql.slice(sql.indexOf('function public.guard_tip_caps()'), sql.indexOf('revoke execute on function public.guard_tip_caps()'));
    // tip_ledger's only writer IS the service role; exempting it disables the cap.
    expect(fn).not.toMatch(/service_role/);
  });

  test('all three caps are enforced', () => {
    expect(sql).toContain('tip_cap_count');
    expect(sql).toContain('tip_cap_booking');
    expect(sql).toContain('tip_cap_velocity');
  });

  test('the per-booking cap is relative to what the booking actually CAPTURED', () => {
    const fn = sql.slice(sql.indexOf('function public.guard_tip_caps()'));
    // amount_cents is the original authorization and is never rewritten, so using it
    // would let a partially-captured $400 hold justify tips against the full $400.
    expect(fn).toMatch(/earner_amount_cents[\s\S]{0,60}fee_cents/);
    expect(fn).toMatch(/status = 'captured'/);
  });

  test('headroom helper is not reachable by clients', () => {
    // Exposing it to `authenticated` turns it into a probe for other people's tip
    // history via a guessed booking id.
    expect(sql).toMatch(/revoke execute on function public\.tip_headroom_cents\(uuid\) from public, anon, authenticated/);
    expect(sql).toMatch(/grant execute on function public\.tip_headroom_cents\(uuid\) to service_role/);
  });

  test('an idempotent replay is exempt from the caps', () => {
    // claim_and_credit_tip does `insert ... on conflict (payment_intent_id) do
    // nothing`, and a BEFORE INSERT row trigger fires BEFORE conflict arbitration.
    // Without this exemption the guard re-counts the already-stored row on a retry,
    // rejects the tip's own replay, and aborts the credit transaction — stranding a
    // charged tip uncredited, which is the exact failure the caps exist to prevent.
    const fn = sql.slice(sql.indexOf('function public.guard_tip_caps()'), sql.indexOf('revoke execute on function public.guard_tip_caps()'));
    const exemption = fn.indexOf('where payment_intent_id = new.payment_intent_id');
    expect(exemption).toBeGreaterThan(-1);
    // ...and it must come BEFORE any cap is evaluated, or it does nothing.
    for (const cap of ['tip_cap_count', 'tip_cap_booking', 'tip_cap_velocity']) {
      expect(exemption).toBeLessThan(fn.indexOf(cap));
    }
  });

  test('the caps are serialised, so concurrent tips cannot all read an empty ledger', () => {
    // Every cap is a read-then-decide. Under READ COMMITTED an uncommitted
    // tip_ledger row is invisible, and stripe-tip's idempotency key includes the
    // amount — so varying it by a cent yields N non-colliding PaymentIntents whose
    // triggers would each see an empty ledger and each pass. Six parallel $1000
    // tips would clear a $200 cap. Advisory locks are the serialisation point; the
    // bookings row-lock inside claim_and_credit_tip is taken AFTER this trigger has
    // already decided, so it cannot substitute.
    const fn = sql.slice(sql.indexOf('function public.guard_tip_caps()'), sql.indexOf('revoke execute on function public.guard_tip_caps()'));
    expect(fn).toMatch(/pg_advisory_xact_lock/);

    // Locks must be taken BEFORE the first cap read, or they serialise nothing.
    const firstLock = fn.indexOf('pg_advisory_xact_lock');
    expect(firstLock).toBeLessThan(fn.indexOf('into v_existing_cents'));
    expect(firstLock).toBeLessThan(fn.indexOf('into v_captured_cents'));

    // Poster lock before booking lock, always — two concurrent tips grabbing them in
    // opposite orders is a deadlock.
    const posterLock = fn.indexOf('gohustlr.tip.poster:');
    const bookingLock = fn.indexOf('gohustlr.tip.booking:');
    expect(posterLock).toBeGreaterThan(-1);
    expect(bookingLock).toBeGreaterThan(posterLock);

    // ...and the replay exemption must still come first, so a retry never blocks on
    // a lock it doesn't need.
    expect(fn.indexOf('where payment_intent_id = new.payment_intent_id')).toBeLessThan(firstLock);
  });

  test('the guard and the headroom helper agree on the limits', () => {
    // They are two copies of the same arithmetic; a drift means the pre-check passes
    // something the trigger then rejects, i.e. exactly the charged-but-uncredited case.
    const guard = sql.slice(sql.indexOf('function public.guard_tip_caps()'), sql.indexOf('function public.tip_headroom_cents'));
    const helper = sql.slice(sql.indexOf('function public.tip_headroom_cents'));
    for (const literal of ['20000', '50000', '>= 3']) {
      expect(guard).toContain(literal);
      expect(helper).toContain(literal);
    }
  });
});
