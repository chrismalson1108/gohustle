// Creates a Stripe PaymentIntent (manual capture = escrow) when a poster accepts a booking.
// Charged to poster immediately on card auth; captured to earner after job verification.
import Stripe from 'npm:stripe@15';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { logServerError, errMessage } from '../_shared/logError.ts';
import { one } from '../_shared/pgrest.ts';

// Number(null) is 0 and Number.isFinite(0) is true, so a bare
// `Number.isFinite(Number(x)) ? Number(x) : FALLBACK` resolves a NULL rate to 0 bps —
// a free gig — rather than to the fallback. These columns are NOT NULL DEFAULT 1000
// today so it cannot fire, but the pattern must not survive to the next nullable
// column. Test for null/undefined first, and require a positive rate.
function safeBps(v: unknown, fallback = 1000): number {
  if (v === null || v === undefined) return fallback;
  const n = Number(v);
  // >= 0, NOT > 0. A pinned ZERO is legitimate and common — it is exactly what a
  // "first 2 gigs free" promotion and a 0% loyalty rung store. The previous `n > 0`
  // mapped it to the 1000 fallback, so the flagship presets would have charged the
  // full fee. That is the same class of bug as Number(null)===0, which this helper was
  // written to fix: a guard that cannot tell "absent" from "legitimately zero".
  // Negative is still nonsense and still falls back.
  return Number.isFinite(n) && n >= 0 && n <= 3000 ? Math.trunc(n) : fallback;
}


const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  // Hoisted so the terminal catch can identify the failure. The service client,
  // `user` and `bookingId` are all declared inside the try below and are therefore
  // out of scope there; without these the error row names only the function.
  let errBookingId: string | null = null;
  let errUserId: string | null = null;

  try {
    const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, { apiVersion: '2024-04-10' });
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // Auth
    const token = req.headers.get('Authorization')?.replace('Bearer ', '') ?? '';
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    errUserId = user?.id ?? null;
    if (authErr || !user) {
      return json({ error: 'Unauthorized' }, 401);
    }

    const { bookingId } = await req.json();

    // Kill switch. Placing a new escrow hold is the one thing to stop first during a
    // Stripe incident — in-flight bookings still capture, so nobody mid-gig is stranded.
    // Fails OPEN by design — a broken flag check must not stop a legitimate payment
    // — but it is logged, because a silent fail-open means /flags shows the feature
    // paused while it is still running.
    const { data: payFlag, error: payFlagErr } = await supabase.rpc('app_flag', { p_key: 'payments_enabled' });
    if (payFlagErr) console.error('stripe-create-payment-intent: app_flag check failed — proceeding (fail-open):', payFlagErr);
    if (payFlag === false) {
      return json({ error: 'PAYMENTS_PAUSED', message: 'Payments are briefly paused. Please try again shortly.' }, 503);
    }
    errBookingId = typeof bookingId === 'string' ? bookingId : null;
    if (!bookingId) return json({ error: 'bookingId required' }, 400);

    // Fetch booking + job + earner
    const { data: booking, error: bErr } = await supabase
      .from('bookings')
      .select(`
        id, job_id, earner_id, counter_offer, status, amount_cents_quoted, fee_bps_quoted,
        fee_credit_cents, poster_discount_cents,
        job:jobs!bookings_job_id_fkey(id, title, pay, pay_type, estimated_hours, poster_id),
        earner:profiles!bookings_earner_id_fkey(id, name)
      `)
      .eq('id', bookingId)
      .single();

    if (bErr || !booking) return json({ error: 'Booking not found' }, 404);
    if (one(booking.job)?.poster_id !== user.id) return json({ error: 'Forbidden' }, 403);

    // Payment state on this booking, if any — drives both the status gate and the
    // reconcile-vs-recreate logic further down.
    const { data: existingPay } = await supabase
      .from('payments').select('status, amount_cents, payment_intent_id').eq('booking_id', bookingId).maybeSingle();
    // A settled payment (captured/refunded/…) can never be re-held; only an
    // outstanding, failed, or lapsed(cancelled) hold is re-holdable.
    if (existingPay && !['authorized', 'failed', 'cancelled'].includes(existingPay.status)) {
      return json({ error: 'This booking already has a settled payment.' }, 409);
    }
    // Holds are placed while accepting (pending/confirmed). Also permit a RECOVERY
    // re-hold on a COMPLETED booking whose prior hold lapsed (cancelled/failed) —
    // otherwise finished work whose ~7-day authorization expired could never be paid.
    const isRecovery = ['cancelled', 'failed'].includes(existingPay?.status ?? '');
    const canHold = ['pending', 'confirmed'].includes(booking.status)
      || (booking.status === 'completed' && isRecovery);
    if (!canHold) {
      return json({ error: 'This booking can no longer take a payment hold.' }, 409);
    }

    // Earner must have a Connect account
    const { data: earnerAcct } = await supabase
      .from('stripe_accounts')
      .select('account_id, onboarded')
      .eq('user_id', booking.earner_id)
      .single();

    // Self-heal: the cached onboarded flag is normally set by the account.updated
    // webhook, but for connected accounts that needs a Connect-scoped webhook and may
    // never fire — leaving onboarded stuck at false. If it's false, verify LIVE before
    // blocking the booking (and sync the cache so later reads are correct).
    let earnerOnboarded = !!earnerAcct?.onboarded;
    if (!earnerOnboarded && earnerAcct?.account_id) {
      try {
        const acc = await stripe.accounts.retrieve(earnerAcct.account_id);
        earnerOnboarded = !!(acc.details_submitted && acc.charges_enabled && acc.payouts_enabled);
        if (earnerOnboarded) {
          await supabase.from('stripe_accounts').update({ onboarded: true }).eq('account_id', earnerAcct.account_id);
        }
      } catch (_) { /* fall through to the not-onboarded response */ }
    }
    if (!earnerOnboarded) {
      return json({ error: 'EARNER_NO_PAYOUT', message: "The earner hasn't set up their payout account yet." }, 400);
    }

    // TS cannot connect earnerOnboarded back to earnerAcct — they are separate
    // variables — and it is right not to. The early return above already makes a null
    // account unreachable here, so this narrows rather than changes behaviour; but if
    // that return is ever refactored, this fails as a clean 400 instead of a TypeError
    // thrown midway through building a PaymentIntent.
    const destinationAcct = earnerAcct?.account_id;
    if (!destinationAcct) {
      return json({ error: 'EARNER_NO_PAYOUT', message: "The earner hasn't set up their payout account yet." }, 400);
    }

    // Amount — use counter_offer if set, else listed pay; multiply for hourly.
    // This is the LIVE recomputation. It is still needed for the MIN_JOB_PAY rate
    // check below and as the fallback for bookings created before 20260806000000,
    // but it is NOT what gets charged when a pin exists — see the next block.
    const rate = booking.counter_offer ? Number(booking.counter_offer) : Number(one(booking.job)?.pay);
    const hours = one(booking.job)?.pay_type === 'hourly' ? Number(one(booking.job)?.estimated_hours) : 1;
    const liveAmountCents = Math.round(rate * hours * 100);

    // AUTHORIZE THE AGREED AMOUNT, NOT THE CURRENT ONE.
    //
    // bookings.amount_cents_quoted is stamped by trg_z_pin_booking_amount at INSERT
    // (20260806000000). Charging the live recomputation instead let a poster re-price
    // an application after the fact: 'pending' is absent from guard_jobs_write's
    // has_active list, so while a booking is pending the poster may still edit
    // jobs.pay — drop a $200 gig to $10, accept, and the earner is bound to terms
    // they never agreed to and are never re-asked about.
    //
    // Null pin = a booking that predates the migration; fall back so in-flight work
    // keeps settling exactly as before.
    // NULL MUST BE HANDLED EXPLICITLY. Number(null) is 0 and Number.isFinite(0) is
    // true, so the obvious `Number.isFinite(Number(x)) ? Number(x) : null` yields 0 for
    // a null pin — and `0 ?? live` is 0, because nullish-coalescing does not fall
    // through on zero. Every booking created before 20260806000000 has a null pin (all
    // 19 in production), so this made them all fail the amountCents >= 50 bound below
    // and become permanently unacceptable: the poster clicks accept and gets "Invalid
    // booking amount" forever.
    //
    // This is the same Number(null) === 0 trap that made a null RATE resolve to 0 bps
    // in shared/pricing.js. Test for null/undefined first, always.
    const rawPin = booking.amount_cents_quoted;
    const pinnedCents =
      rawPin === null || rawPin === undefined
        ? null
        : Number.isFinite(Number(rawPin)) && Number(rawPin) > 0
          ? Number(rawPin)
          : null;
    const amountCents = pinnedCents ?? liveAmountCents;

    // A divergence means the job was edited between application and accept. The pin
    // wins (that is the point), but it is worth seeing: a large or frequent gap is
    // either a poster probing this path or a product bug in the amendment flow.
    // Non-fatal — never block a legitimate accept to file a log line.
    if (pinnedCents !== null && pinnedCents !== liveAmountCents) {
      await logServerError(
        'stripe-create-payment-intent',
        `booking amount diverged from pin: agreed ${pinnedCents}c, job now implies ${liveAmountCents}c — charging the agreed amount`,
        { booking_id: bookingId, job_id: booking.job_id, pinned_cents: pinnedCents, live_cents: liveAmountCents },
        { userId: user.id },
      ).catch(() => {});
    }
    // Sanity-bound the amount — counter_offer is earner-controlled, so reject a
    // non-positive or absurd value (cap $10,000) before it reaches Stripe.
    if (!Number.isFinite(amountCents) || amountCents < 50 || amountCents > 1_000_000) {
      return json({ error: 'Invalid booking amount' }, 400);
    }
    // Enforce the platform pay floor on the RATE (not the total): a $10 floor must
    // hold for a 1-hour hourly gig too. Both clients validate this, but both are
    // user-controlled — counter_offer especially, since the EARNER sets it. This is
    // the only check a patched client can't skip, so it's the one that counts.
    // Keep MIN_JOB_PAY in sync with shared/constants.js.
    const MIN_JOB_PAY = 10;
    if (!Number.isFinite(rate) || rate < MIN_JOB_PAY) {
      return json({
        error: 'BELOW_MIN_PAY',
        message: `Gigs must pay at least $${MIN_JOB_PAY}.`,
      }, 400);
    }
    // Fee comes from the RATE PINNED ON THE BOOKING, not a literal and not the live
    // rate. bookings.fee_bps_quoted was stamped at INSERT (20260806050000), so a rate
    // change between application and accept cannot re-price an agreed deal.
    //
    // The arithmetic itself is done by public.platform_fee_cents rather than
    // reimplemented here, so there is exactly ONE definition of the fee in the system.
    // It rounds half up (matching the Math.round this replaces), floors at Stripe's
    // own cost + margin so a 0% promotion can never settle at a loss, and caps at the
    // amount. Duplicating that in TypeScript is how the seven-copies problem started.
    const feeBps = safeBps(booking.fee_bps_quoted);

    // THE BENEFITS ARE APPLIED HERE, OR THEY ARE NOT APPLIED AT ALL.
    //
    // pin_booking_amount consumes a fee credit and a poster discount at booking INSERT
    // — burning the bonus ledger row and debiting the campaign budget — but nothing
    // downstream read them, so the benefit was destroyed and the poster was still
    // charged full price. Every promotion, credit and discount built today was
    // cosmetic. These two lines are what make them real.
    const creditCents = Math.max(0, Math.trunc(Number(booking.fee_credit_cents) || 0));
    const discountCents = Math.max(0, Math.trunc(Number(booking.poster_discount_cents) || 0));

    // Fee AFTER the earner's credit, floored at processing cost by the SQL.
    const { data: feeCalc, error: feeErr } = await supabase
      .rpc('platform_fee_after_credit', {
        p_amount_cents: amountCents, p_fee_bps: feeBps, p_credit_cents: creditCents,
      });
    if (feeErr || !Number.isFinite(Number(feeCalc))) {
      // FAIL CLOSED. Never fall through to a zero or guessed fee — that is a silent
      // revenue outage. Refuse the hold and surface it.
      await logServerError('stripe-create-payment-intent',
        `fee computation failed (bps=${feeBps}, amount=${amountCents}, credit=${creditCents}): ${feeErr?.message ?? 'non-numeric'}`,
        { booking_id: bookingId }, { fatal: true, userId: user.id });
      return json({ error: 'Could not price this booking. Please try again.' }, 503);
    }
    // feeAfterCredit is what comes out of the EARNER's side. The poster discount comes
    // out of OUR side on top of that.
    //
    //   poster is charged   amount - discount
    //   earner receives     amount - feeAfterCredit      (unchanged by the discount)
    //   platform keeps      feeAfterCredit - discount
    //   and charge == earner + platform, exactly.
    //
    // pin_booking_amount already clamped discount to the headroom left above the
    // processing floor after the credit, so platformFee can never go negative — which
    // Stripe cannot represent.
    const feeAfterCredit = Number(feeCalc);
    // ONE name for the ONE quantity: what Stripe actually holds, what
    // payments.amount_cents stores, what the re-hold reconciler compares, and what the
    // idempotency key is built from. This was previously spelled out at four call sites
    // and two of them were missed when the poster discount landed, which is what let a
    // live hold be cancelled and a dead PaymentIntent be replayed. Keep it single.
    const authorizedCents = Math.max(50, amountCents - discountCents);
    const platformFeeCents = Math.max(0, feeAfterCredit - discountCents);
    const earnerAmountCents = amountCents - feeAfterCredit;

    // The invariant, asserted rather than assumed. If these ever disagree we would be
    // moving money that does not reconcile, so refuse instead.
    if (authorizedCents !== earnerAmountCents + platformFeeCents) {
      await logServerError('stripe-create-payment-intent',
        `split does not reconcile: charge=${authorizedCents} earner=${earnerAmountCents} fee=${platformFeeCents} ` +
        `(amount=${amountCents} bps=${feeBps} credit=${creditCents} discount=${discountCents})`,
        { booking_id: bookingId }, { fatal: true, userId: user.id });
      return json({ error: 'Could not price this booking. Please try again.' }, 503);
    }
    const feeCents = platformFeeCents;

    // Get/create Stripe Customer for poster (enables saved cards)
    let customerId: string;
    const { data: existingCust } = await supabase
      .from('stripe_customers')
      .select('customer_id')
      .eq('user_id', user.id)
      .single();

    if (existingCust) {
      customerId = existingCust.customer_id;
    } else {
      const { data: profile } = await supabase
        .from('profiles').select('name').eq('id', user.id).single();
      const customer = await stripe.customers.create({
        email: user.email,
        name: profile?.name,
        metadata: { supabase_uid: user.id },
      });
      customerId = customer.id;
      await supabase.from('stripe_customers').insert({ user_id: user.id, customer_id: customerId });
    }

    // Ephemeral key lets the mobile SDK manage saved cards
    const ephemeralKey = await stripe.ephemeralKeys.create(
      { customer: customerId },
      { apiVersion: '2024-06-20' },
    );

    // Reconcile with any existing hold BEFORE creating a new PaymentIntent. If a real
    // live hold (or a not-yet-confirmed PI) at the SAME amount already exists, return
    // IT instead of creating a second PI. Creating a new one would orphan the genuine
    // requires_capture hold — it then expires and refunds the poster while the payments
    // row points at an empty PI, i.e. an escrow-bypass on an already-confirmed booking
    // (the 24h idempotency key only masks this within its window). Only re-create when
    // the amount actually changed (re-priced booking) or the old hold is truly gone.
    // The PaymentIntent this call is replacing, if any. Feeds the idempotency key so a
    // cancel-and-recreate can never replay the hold it just killed.
    //
    // Read from the ROW, not from the branch below, and regardless of the row's status.
    // If the process dies between paymentIntents.create and the payments upsert, the row
    // still names the OLD intent — so a retry rebuilds the identical key and REPLAYS the
    // intent that was already created, instead of minting a second, orphaned hold. That
    // crash window is the whole reason a deterministic key exists.
    const replacingPi = existingPay?.payment_intent_id ?? 'new';
    if (existingPay?.payment_intent_id && existingPay.status === 'authorized') {
      let existingPI: Stripe.PaymentIntent | null = null;
      try { existingPI = await stripe.paymentIntents.retrieve(existingPay.payment_intent_id); }
      catch (_) { /* not retrievable — fall through and create a fresh one */ }
      const liveStatuses = ['requires_capture', 'requires_confirmation', 'requires_payment_method', 'requires_action', 'processing'];
      if (existingPI && liveStatuses.includes(existingPI.status)) {
        // COMPARE WHAT IS STORED. payments.amount_cents holds authorizedCents (the
        // DISCOUNTED total that Stripe is actually holding), so comparing it against
        // the pre-discount gig amount made these permanently unequal for any booking
        // with a poster discount — every second call fell through to the "re-priced"
        // branch and cancelled a perfectly live hold. No `?? 0`: authorizedCents is
        // always >= 50, so a NULL can never legitimately match and the coalesce would
        // only hide a malformed row.
        if (existingPay.amount_cents === authorizedCents) {
          // Same amount, still live → hand back the existing client secret (idempotent).
          let savedCardExisting: { id: string; brand: string | null; last4: string | null } | null = null;
          try {
            const pms = await stripe.paymentMethods.list({ customer: customerId, type: 'card', limit: 1 });
            const pm = pms.data[0];
            if (pm) savedCardExisting = { id: pm.id, brand: pm.card?.brand ?? null, last4: pm.card?.last4 ?? null };
          } catch (_) { /* no saved card */ }
          return json({
            clientSecret: existingPI.client_secret,
            customerId,
            ephemeralKey: ephemeralKey.secret,
            amountCents,
            earnerAmountCents,
            feeCents,
            savedCard: savedCardExisting,
          });
        }
        // Amount changed (re-priced) → cancel the stale hold before creating the new one.
        try {
          await stripe.paymentIntents.cancel(existingPay.payment_intent_id);
          // Mark the row dead IMMEDIATELY. Between the cancel and the upsert below it
          // still claimed status:'authorized' against a cancelled PaymentIntent, and
          // that is exactly what accept-booking and the escrow-age controls read. A
          // crash in that window left a booking looking funded when nothing was held.
          await supabase.from('payments')
            .update({ status: 'cancelled' })
            .eq('booking_id', bookingId)
            .eq('payment_intent_id', existingPay.payment_intent_id);
        } catch (_) { /* already captured / cancelled / expired — ignore */ }
      }
    }

    // PaymentIntent with manual capture (funds held, not charged until capture).
    //
    // THE IDEMPOTENCY KEY CARRIES THE FULL ECONOMIC PAYLOAD *AND* THE HOLD IT REPLACES.
    // It used to be `${bookingId}_${amountCents}`, which never changed across a
    // cancel-and-recreate — so Stripe replayed the cached creation response and handed
    // back the PaymentIntent that had just been cancelled, which the row then recorded
    // as 'authorized'. The poster could never complete acceptance for 24h.
    //
    // Keying on authorizedCents alone is NOT sufficient: return a discount and re-apply
    // it and the value comes back to one already used, replaying that dead PI again.
    // Including the prior PI id guarantees a distinct key after every cancel, while a
    // genuine transport retry (same prior hold, same money) still replays and cannot
    // open a second orphaned authorization — which is the property the key exists for.
    //
    // feeCents is in the key because application_fee_amount is a CREATE parameter:
    // reusing a key with different parameters makes Stripe reject the call outright,
    // which would surface as an opaque 500 and an equally permanent failure to accept.
    const pi = await stripe.paymentIntents.create({
      // The poster is charged the DISCOUNTED total, not the gig price.
      amount: authorizedCents,
      currency: 'usd',
      customer: customerId,
      capture_method: 'manual',
      application_fee_amount: feeCents,
      transfer_data: { destination: destinationAcct },
      description: `GoHustlr: ${one(booking.job)?.title}`,
      metadata: {
        booking_id: bookingId,
        job_id: booking.job_id,
        earner_id: booking.earner_id,
        poster_id: user.id,
      },
    }, { idempotencyKey: `pi_create_${bookingId}_${authorizedCents}_${feeCents}_${replacingPi}` });

    // Record in payments table (upsert in case of retry).
    //
    // The result is CHECKED. It used to be discarded, which was latent only because
    // the payload happened to be stable: if this write ever fails, Stripe is holding
    // a real authorization on the poster's card and no payments row exists to settle
    // it. stripe-capture-payment and earner-claim-payment both look the booking up by
    // that row, so both 404; the hold then lapses on Stripe's ~7-day timer and the
    // earner has worked for nothing. Nothing logged it. Adding any column to this
    // payload — the pricing work adds fee_bps — makes a deploy-order slip do exactly
    // that, so the hold is now cancelled and the failure surfaced instead.
    const { error: payErr } = await supabase.from('payments').upsert({
      booking_id: bookingId,
      payment_intent_id: pi.id,
      // amount_cents is the ORIGINAL AUTHORIZATION — with a poster discount that is
      // the discounted total, because that is what Stripe is holding.
      amount_cents: authorizedCents,
      fee_cents: feeCents,
      earner_amount_cents: earnerAmountCents,
      status: 'authorized',
      // When THIS hold was placed. created_at keeps recording the first one, which
      // other controls and the payments list read — so a recovery re-hold updates this
      // and leaves that history intact. Without it the escrow-age controls date a
      // fresh hold to the lapsed one and fire CRITICAL the moment it is created.
      authorized_at: new Date().toISOString(),
    }, { onConflict: 'booking_id' });

    if (payErr) {
      await stripe.paymentIntents.cancel(pi.id).catch(() => {});
      await logServerError(
        'stripe-create-payment-intent',
        `payments row write failed after authorizing — hold cancelled: ${payErr.message}`,
        { booking_id: bookingId, payment_intent_id: pi.id, amount_cents: amountCents },
        { fatal: true, userId: user.id },
      );
      return json({ error: 'Something went wrong placing the hold. Please try again.' }, 500);
    }

    // The poster's saved card (if any) so the web client can offer one-tap accept
    // with the card on file instead of re-collecting it. (Mobile uses the ephemeral
    // key + PaymentSheet, which already surfaces saved cards.)
    let savedCard: { id: string; brand: string | null; last4: string | null } | null = null;
    try {
      const pms = await stripe.paymentMethods.list({ customer: customerId, type: 'card', limit: 1 });
      const pm = pms.data[0];
      if (pm) savedCard = { id: pm.id, brand: pm.card?.brand ?? null, last4: pm.card?.last4 ?? null };
    } catch (_) { /* no saved card — client falls back to card entry */ }

    return json({
      clientSecret: pi.client_secret,
      customerId,
      ephemeralKey: ephemeralKey.secret,
      amountCents,
      earnerAmountCents,
      feeCents,
      savedCard,
    });
  } catch (err: any) {
    console.error('stripe-create-payment-intent:', err);
    // Land it where an operator will actually see it (/errors in the admin
    // console). This used to stop at console.error, so a money-path failure
    // was invisible unless someone was tailing Supabase function logs.
    await logServerError('stripe-create-payment-intent', `Could not place the escrow hold — booking cannot be confirmed: ${errMessage(err)}`,
      { booking_id: errBookingId }, { fatal: true, userId: errUserId });
    return json({ error: 'Something went wrong. Please try again.' }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
