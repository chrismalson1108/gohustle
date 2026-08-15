export const meta = {
  name: 'gohustlr-payments-core-audit',
  description: 'Adversarial read-only audit of every GoHustlr Stripe money path, fee math, and money-table RLS',
  phases: [
    { title: 'Find', detail: '12 dimension finders across edge functions, SQL money RPCs, clients, RLS', model: 'opus' },
    { title: 'Verify', detail: 'adversarial refutation of each dimension\u2019s findings', model: 'opus' },
    { title: 'Exploit', detail: 'concrete attack/failure construction for confirmed high-severity findings', model: 'opus' },
    { title: 'Synthesize', detail: 'dedup, rank, completeness critique', model: 'opus' },
  ],
}

const ROOT = '/Users/chrismalson/Documents/gohustle'

const RULES = `
YOU ARE AUDITING THE GoHustlr REPO AT ${ROOT}. READ-ONLY. THIS IS ABSOLUTE.

HARD CONSTRAINTS (a previous audit round violated these and disabled a live security
control for hours, and ran DELETE probes against production):
  * NEVER run: supabase CLI (db push/db reset/psql/functions deploy), psql, stripe CLI,
    curl/fetch/wget against ANY http endpoint, vercel, or any command that could touch
    the production Supabase project nfioebqsgmmzhbksxozc or the Stripe account.
  * NEVER invoke an edge function, NEVER forge a JWT, NEVER impersonate a user.
  * NEVER edit, create, or delete any file in the repo. Do not run \`npm test -u\`, do not
    write scratch files into the repo. You may run \`npm test\` (pure-logic jest, no
    network) and read-only shell (ls, grep, rg, wc, git log, git show, sed -n for reading).
  * This is STATIC ANALYSIS plus reasoning. Your evidence is code, SQL, and tests.

CRITICAL DOMAIN FACT — MIGRATION LAST-WRITER WINS:
  supabase/migrations/ files are applied in filename (timestamp) order and money
  functions are redefined with \`create or replace\` MANY times. For example
  public.pin_booking_amount is redefined in NINE migrations. THE LIVE BEHAVIOUR IS THE
  LAST DEFINITION IN TIMESTAMP ORDER, NOT the one whose comment sounds most current.
  Before you claim anything about a SQL function, establish its FINAL definition:
    grep -rln "function public\\.<name>" supabase/migrations/ | sort | tail -1
  A finding based on a superseded definition is a FALSE POSITIVE and will be rejected.
  Conversely: a later redefinition that silently DROPPED a guard, clamp, pin, or
  \`revoke execute\` present in an earlier one is a REAL and HIGH-VALUE finding. Diff
  successive definitions of the same function and look specifically for dropped logic.

SYSTEM MODEL (verify, do not assume):
  Stripe Connect DESTINATION CHARGES with MANUAL CAPTURE = escrow.
  Poster accepts -> stripe-create-payment-intent authorizes (hold) -> work happens ->
  poster verifies -> stripe-capture-payment captures (Stripe transfers to the earner's
  connected account minus application_fee_amount). earner-claim-payment is the earner's
  self-service settlement when the poster ghosts. stripe-tip is an off-session 100%
  pass-through to the earner. admin-payment-action is the only console money path
  (release_hold / refund / record_reversal).
  THE PLATFORM FEE COMES OUT OF THE EARNER'S PAYOUT, not added to the poster's charge.
  Three values are PINNED IMMUTABLY at booking INSERT by pin_booking_amount:
  amount_cents_quoted, fee_bps_quoted, fee_credit_cents (+ poster_discount_cents), and
  payments inherits fee_bps via pin_payment_fee_bps. Idempotency of capture DEPENDS on
  deriving from those immutable values.
  Money is in INTEGER CENTS and rates in BASIS POINTS everywhere. Stripe is currently in
  SANDBOX/TEST mode; a finding is still real if it would bite on the live-key cutover.

WHAT COUNTS AS A FINDING (in descending value):
  1. Money can be created, destroyed, double-paid, double-credited, stolen, or drained.
  2. A party is charged or paid an amount they never agreed to, or is left unpaid for
     work performed, or a hold is orphaned/lapsed leaving a worker unpaid.
  3. A ledger desync: Stripe and the DB disagree and nothing reconciles it.
  4. An authorization/IDOR gap on a money endpoint or a money table (RLS/grants).
  5. Idempotency/replay/concurrency defects: retries, Stripe at-least-once webhook
     redelivery, out-of-order events, two concurrent calls, partial failure mid-flow.
  6. Arithmetic: integer overflow, rounding disagreement between SQL and JS, sign
     errors, negative application_fee_amount, floor/cap interactions, off-by-one cents.
  7. A disclosed number that differs from the charged number (using the CURRENT rate
     where the booking's PINNED rate is correct, or vice versa) \u2014 a disclosure bug.
  8. A guard that fails OPEN where it should fail CLOSED.

WHAT IS NOT A FINDING (do not report these; they waste the review):
  * Style, naming, comment density, test coverage as an abstract wish.
  * "Stripe is in test mode" \u2014 known and intentional.
  * Anything the code's own comments identify as a DELIBERATE, documented residual
    (e.g. the hold-ages-from-accept-time architectural gap in earner-claim-payment)
    UNLESS you have found a NEW consequence of it that the comment does not name.
  * Speculation with no concrete failing path. Every finding needs a specific trigger:
    inputs/state -> what actually goes wrong -> who loses money.

Be adversarial and concrete. Prefer three findings you can prove over ten you suspect.
`

const FINDING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['dimension', 'findings', 'coverage_notes'],
  properties: {
    dimension: { type: 'string' },
    coverage_notes: {
      type: 'string',
      description: 'What you read, what you verified as SOUND (briefly), and anything you could not determine statically.',
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'severity', 'file', 'line', 'summary', 'trigger', 'money_impact', 'evidence'],
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          file: { type: 'string', description: 'repo-relative path' },
          line: { type: 'number' },
          summary: { type: 'string' },
          trigger: { type: 'string', description: 'Concrete inputs/state/sequence that produces the failure.' },
          money_impact: { type: 'string', description: 'Who loses or gains what, and how much.' },
          evidence: { type: 'string', description: 'Quoted code/SQL lines that prove it, with file:line.' },
          fix_sketch: { type: 'string' },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'status', 'reasoning', 'corrected_severity'],
        properties: {
          title: { type: 'string' },
          status: { type: 'string', enum: ['CONFIRMED', 'REFUTED', 'UNCERTAIN'] },
          reasoning: { type: 'string', description: 'Why it survives or dies. Cite the code that decides it.' },
          corrected_severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'none'] },
          correction: { type: 'string', description: 'If the finding is partly right, the accurate version.' },
        },
      },
    },
  },
}

const DIMENSIONS = [
  {
    key: 'authorize',
    title: 'Escrow authorization: stripe-create-payment-intent + accept-booking',
    prompt: `Audit the ESCROW AUTHORIZATION path.
Read in full: supabase/functions/stripe-create-payment-intent/index.ts,
supabase/functions/accept-booking/index.ts, and the JobsContext call sites for both.
Then read the FINAL definitions of pin_booking_amount and pin_payment_fee_bps.

Attack it on: (a) can a poster or earner cause a hold at an amount the other party never
agreed to (re-pricing between apply and accept, counter_offer manipulation, hourly
estimated_hours, editing jobs.pay while a booking is pending)? (b) the reconcile-vs-recreate
branch and the idempotency key \`pi_create_\${bookingId}_\${authorizedCents}_\${feeCents}_\${replacingPi}\`
\u2014 can any sequence orphan a live hold, replay a cancelled PaymentIntent, or open TWO
authorizations on one booking? Walk crash windows: between paymentIntents.create and the
payments upsert; between cancel and upsert; concurrent double-accept. (c) the recovery
re-hold path on a completed booking \u2014 what does it enable? (d) the earner-onboarded
self-heal (stripe.accounts.retrieve) \u2014 trust and failure modes. (e) safeBps and the
pinnedCents null-handling. (f) does accept-booking actually prove a live hold exists before
confirming, and can the booking be confirmed without one? (g) MIN_JOB_PAY and the amount
bounds \u2014 anything that slips past them.`,
  },
  {
    key: 'capture',
    title: 'Settlement: stripe-capture-payment (full + partial/dispute)',
    prompt: `Audit CAPTURE. Read supabase/functions/stripe-capture-payment/index.ts in full,
plus the FINAL definitions of platform_fee_after_credit, platform_fee_cents,
credit_earnings and settle_booking_benefits.

Attack it on: (a) the partial-capture (dispute) branch \u2014 re-derive the arithmetic yourself
in cents for concrete cases and check it against the full-capture branch and against what
Stripe is actually told (amount_to_capture, application_fee_amount). Does
\`fee = min(captureCents, round(fullFee * pct))\` ever exceed the captured amount, go
negative, or under/over-collect once fee_credit_cents and poster_discount_cents are in play?
(b) gigAmountCents = amount_cents + discountCents \u2014 is reconstructing the pre-discount gig
amount this way correct in EVERY case, including a recovery re-hold and a booking with both
a credit and a discount? (c) idempotency under retry: the row is UPDATEd before capture;
enumerate every partial-failure point (update ok/capture fails, capture ok/update fails,
capture ok then process dies before credit_earnings, webhook races the function) and say
what state results and whether a retry corrects it. (d) can the poster capture twice, or
capture after an earner claim, or capture a booking with an open dispute? (e) the pct floor
of 0.5 and the 'completed' vs 'verified' status gate. (f) the dispute-photos path-prefix
filter. (g) does the promo settle-back (settle_booking_benefits) ever release more than was
reserved, or run twice?`,
  },
  {
    key: 'claim',
    title: 'Earner self-settlement: earner-claim-payment',
    prompt: `Audit EARNER-CLAIM-PAYMENT (supabase/functions/earner-claim-payment/index.ts), the
one money path an EARNER can initiate. Read it in full plus shared/lifecycle.js and
__tests__/earnerClaim.test.js.

Attack it on: (a) the ghosting gate \u2014 every input it trusts. It derives schedule from the
poster-owned job_slots row via booking.slot_id. Can an earner control slot_id, or the slot's
starts_at, or swap slots after booking? Check the RLS/guard triggers on bookings.slot_id and
job_slots. A prior audit found an escrow-drain via forged bookings.starts_at; look for the
same class through a different column. (b) the SECOND anchor
\`scheduledTimePassed && holdNearlyExpired\` \u2014 holdPlacedAt reads payments.created_at, but
stripe-create-payment-intent writes a fresh authorized_at on a RECOVERY re-hold and leaves
created_at at the FIRST hold. Work out exactly what that means for a re-held booking: does
the claim unlock immediately/incorrectly, and is the belt-and-suspenders created_at + GRACE
check consistent with it? (c) the dispute/report fail-closed count queries \u2014 can an earner
suppress or evade them (self-filed reports, source='auto' exclusion, resolved_at semantics)?
(d) settling from Stripe's amount_received and preferring the charge's application_fee_amount
\u2014 races against a concurrent poster PARTIAL capture. Walk the interleaving in detail and
determine whether the earner can ever be credited more than was captured. (e) the final
bookings UPDATE to 'verified' \u2014 what does it bypass (reviews, ratings, poster consent,
guard triggers)?`,
  },
  {
    key: 'webhook',
    title: 'stripe-webhook: replay, ordering, and state clobbering',
    prompt: `Audit supabase/functions/stripe-webhook/index.ts in full.

Stripe delivers AT LEAST ONCE, retries for ~3 days, and does NOT guarantee ordering.
Attack it on: (a) dual-secret signature verification \u2014 is it sound, and can an unsigned or
wrong-secret event get through? Is there any replay protection beyond the signature (an
attacker who captures one valid signed body can resend it \u2014 what does each handler do when
replayed)? (b) payment_intent.succeeded calls credit_earnings but does NOT reconcile
earner_amount_cents to pi.amount_received. admin-payment-action's own header says a
Dashboard capture "credits the earner the full pre-computed split without reading
amount_received". Determine whether that over-credit is STILL live in this handler and under
which real sequences it fires (Stripe Dashboard partial capture, a capture racing the
edge function's pre-write, an out-of-order redelivery after a partial). Quantify the loss.
(c) every status transition guard: can a late/redelivered event move a settled row backwards
(captured -> failed/cancelled), or resurrect a booking? Check each .eq/.in precondition.
(d) account.updated demotion \u2014 what breaks for in-flight bookings when onboarded flips
false, and can a connected account's own event demote the WRONG row? (e) charge.refunded and
charge.dispute.created \u2014 the recordReversal idempotency key is \`ilike '%externalId%'\` on the
reason text; is that sound? Can a user-supplied dispute reason collide with it? (f) missing
events that matter for money: transfer.reversed, payout.failed, charge.dispute.closed,
payment_intent.amount_capturable_updated, review.opened. Which absences cause a real
desync? (g) the handler returns 500 on error \u2014 what does Stripe do next and is every write
before that point safe to re-run?`,
  },
  {
    key: 'tips',
    title: 'stripe-tip: the fee-free money-movement rail',
    prompt: `Audit supabase/functions/stripe-tip/index.ts plus the FINAL definitions of
tip_headroom_cents, claim_and_credit_tip, and trg_guard_tip_caps
(supabase/migrations/20260804000000_tip_caps.sql and anything later), and
__tests__/tipCaps.test.js.

Tips carry NO application_fee_amount \u2014 100% lands in the earner's connected balance and
pays out. That makes this a fee-free rail; treat it as the money-laundering / value-transfer
surface it is. Attack it on: (a) the idempotency key \`tip_\${bookingId}_\${tipCents}\`. A
poster legitimately tipping the SAME amount twice on the same booking replays the cached
PaymentIntent \u2014 trace exactly what the poster is charged, what the earner is credited, and
what the API returns. Is a genuine second tip silently swallowed while reporting success?
Conversely can varying the amount by one cent be used to escape any cap? (b) the cap
pre-check is a separate RPC call from the charge and the trigger fires only after the card is
charged \u2014 walk two concurrent tips and determine the exact outcome, including the
"charged but not credited" branch. (c) can a poster tip a booking whose escrow was never
captured, was refunded, or was cancelled? Can they tip after a chargeback? (d) the default
payment method selection and off_session confirm \u2014 SCA/authentication_required handling and
whether any money can move without the poster's live consent. (e) self-dealing: post a gig,
book from an alt, verify, then tip \u2014 what is the actual cost of moving $X through the
platform this way, and do the caps bound it?`,
  },
  {
    key: 'refunds',
    title: 'Hold release, refunds, chargebacks, reconciliation',
    prompt: `Audit the REVERSAL paths: supabase/functions/stripe-cancel-payment/index.ts,
supabase/functions/admin-payment-action/index.ts, supabase/functions/reconcile-stripe/index.ts,
the FINAL definition of record_refund
(start at supabase/migrations/20260804020000_refund_ledger_fixes.sql), and
admin/lib/deleteUser.ts's CANCELLABLE_STATUSES.

Attack it on: (a) stripe-cancel-payment is callable by EITHER party with a plain user token
and never writes to bookings. Enumerate every state where a party can void a hold that
should survive, or where voiding leaves the booking looking funded. Confirm whether
CANCELLABLE_STATUSES actually closes the documented "accept then void the hold" hole, and
whether the same hole exists via any OTHER route (declineBooking, cancelBooking,
account deletion, admin release_hold). (b) refund arithmetic: capturedCents is reconstructed
as earner_amount_cents + fee_cents. Is that ALWAYS what the poster actually paid, given
partial captures, poster discounts, tips, and prior refunds? Can over-refund or
under-refund be forced? (c) the refund idempotency key
\`refund_\${pi}_\${alreadyRefunded + refundCents}\` \u2014 construct a sequence of concurrent or
retried refunds that produces a wrong total or a replayed refund. (d) record_refund debits
profiles earnings \u2014 can it drive earnings negative, or debit an earner who was never
credited? (e) reverse_transfer + refund_application_fee on a connected account that has
already paid out or has insufficient balance \u2014 what happens to our ledger then? (f) the
refund_source marker written BEFORE the Stripe call \u2014 a crash between the marker and the
call, and whether the marker can be left stale and mislabel a later genuine chargeback.
(g) does reconcile-stripe correct any of the desyncs the other functions can create, and can
it itself write a wrong number?`,
  },
  {
    key: 'connect',
    title: 'Connect onboarding, payout destination, and card-on-file endpoints',
    prompt: `Audit the ACCOUNT-CONTROL endpoints, where the real prize is redirecting someone
else's payout or touching their card: supabase/functions/stripe-connect-onboard/index.ts,
stripe-connect-status/index.ts, stripe-connect-return/index.ts,
stripe-payout-login-link/index.ts, stripe-create-setup-intent/index.ts,
stripe-payment-method-status/index.ts, stripe-detach-payment-method/index.ts,
stripe-create-identity-session/index.ts, and supabase/functions/_shared/connectStatus.ts.

Attack it on: (a) for EACH endpoint: does it derive the user identity from the verified JWT
only, or does any request-body field (userId, accountId, customerId, origin, returnUrl)
influence which Stripe object is read or written? A body-supplied account/customer id on any
of these is a critical finding. (b) can a user bind an EXISTING stripe_accounts /
stripe_customers row to a different user, or create a second row, or take over an account_id
another user owns? Check the DB constraints and RLS on stripe_accounts and stripe_customers,
not just the function code. (c) the \`origin\` parameter used to build return/refresh URLs \u2014
open-redirect and token-leak potential in the onboarding link. (d) stripe-payout-login-link
mints a Stripe Express dashboard login link: prove it can only ever be minted for the
caller's own account. (e) detach-payment-method: can it detach another poster's card, and
what happens to in-flight escrow holds and off-session tips when the card is detached?
(f) the onboarded flag lifecycle across connectStatus.ts, the webhook, and the self-heal in
stripe-create-payment-intent \u2014 can it be made to read true for an account that cannot
receive funds, or false for one that can?`,
  },
  {
    key: 'sqlmoney',
    title: 'SQL money core: arithmetic, concurrency, idempotence',
    prompt: `Audit the SQL that IS the money. Establish the FINAL definition of each of these
(remember: last migration in timestamp order wins) and read it in full:
platform_fee_cents, platform_fee_after_credit, poster_discount_headroom, credit_earnings,
record_refund, claim_and_credit_tip, tip_headroom_cents, fee_bps_at, settle_booking_benefits.

Attack it on: (a) ARITHMETIC. Re-derive each function by hand in integer cents across a
matrix: amounts {50, 999, 1000, 1005, 2000, 10000, 100000, 1000000}, bps {0, 500, 1000,
2148, 3000}, credits {0, partial, larger-than-fee}, discounts {0, partial, larger-than-
headroom}. Look for: int4 overflow (20260806140000 fixed ONE such overflow with a ::bigint
cast \u2014 hunt the SAME defect in every OTHER money function, especially
platform_fee_after_credit, poster_discount_headroom and anything multiplying cents by bps),
truncation-vs-half-up disagreements, negative results, results exceeding the amount, and any
case where earner_net + platform_fee != charge. (b) CONCURRENCY. For each function that
mutates: is the increment ALSO the check (single conditional UPDATE), or is it
read-then-decide? Identify every read-modify-write and every missing FOR UPDATE / unique
index, and construct the interleaving that double-spends. credit_earnings and
claim_and_credit_tip claim a boolean flag \u2014 verify the claim is atomic and that a rolled-back
transaction cannot strand it. (c) SECURITY DEFINER + search_path on every one, and the
\`revoke execute ... from public, anon, authenticated\` \u2014 list any money function that is
EXECUTABLE by anon or authenticated and say what a direct RPC call to it from a client
achieves. Cross-check against supabase/migrations/20260702000000_revoke_definer_function_execute.sql
and 20260726080000_revoke_anon_execute_definer_fns.sql, and check whether any LATER migration
recreated a function and thereby restored default PUBLIC EXECUTE.`,
  },
  {
    key: 'pindrift',
    title: 'pin_booking_amount final-state + migration last-writer drift',
    prompt: `This dimension is a DIFF AUDIT, and it is the highest-yield one. Money functions
here are redefined by \`create or replace\` across many migrations, and only the last
definition in timestamp order is live. A later rewrite that silently dropped a guard from an
earlier one is invisible to every other kind of review.

For EACH of these functions, extract EVERY definition in timestamp order and diff them
against each other, then report anything the FINAL version lost:
  pin_booking_amount (9 migrations: 20260806000000, 070000, 080000, 110000, 120000, 220000,
    240000, 290000, 320000, 340000 \u2014 verify the real list yourself)
  consume_promo_grant, consume_fee_credit, consume_poster_discount, settle_booking_benefits,
  platform_fee_cents, credit_earnings, claim_and_credit_tip, guard_bookings_write,
  guard_jobs_write.
Use: grep -rn "function public\\.<name>" supabase/migrations/ | sort

Specifically hunt for, in the FINAL version of each: a dropped column pin in the UPDATE
branch (the July audit's critical bug was an escrow drain via a forged bookings.starts_at
that a guard rewrite had stopped pinning \u2014 check that starts_at and EVERY other
money-relevant column is still pinned in the final guard_bookings_write); a dropped
\`revoke execute\`; a dropped clamp or floor; a dropped \`for update\`; a dropped
\`security definer\`/\`set search_path\`; an exception handler that swallows a partial charge;
a changed argument signature that leaves an OLD overload still callable with the old
credit-blind behaviour (20260806320000 explicitly dropped a 4-arg overload \u2014 check every
other signature change did the same).
Also check pin_booking_amount's INSERT branch end to end: the per-benefit BEGIN/EXCEPTION
blocks, whether a benefit can be CHARGED but not DELIVERED (or delivered but not charged),
and whether the tier/promo/credit/discount ordering can produce a fee below the processing
floor or a negative application_fee_amount at Stripe.`,
  },
  {
    key: 'rls',
    title: 'RLS, grants, and guard triggers on money tables',
    prompt: `Audit ROW-LEVEL SECURITY, GRANTS and GUARD TRIGGERS on every money-bearing table.
Tables: payments, bookings, jobs, job_slots, promotions, promo_codes, promo_grants,
promo_redemptions, promo_redeem_attempts, bonus_ledger, tip_ledger, platform_rates,
stripe_accounts, stripe_customers, disputes, refunds/refund ledger, income_entries, expenses,
profiles (earnings_total, xp, rating, verified, referral_code).

Method: for each table, find the FINAL state of its RLS policies and grants across ALL
migrations (later migrations override; a \`create policy\` in a late file or a
\`grant\` that was never revoked is what matters). Build the effective picture, then answer
for the \`authenticated\` and \`anon\` roles:
  (a) Can a client SELECT rows belonging to another user \u2014 specifically: another user's
      payments, promo grants, bonus ledger, stripe account/customer ids, or earnings?
  (b) Can a client UPDATE or INSERT any column that money is derived from? Enumerate the
      writable columns on bookings and jobs and check each against the guard triggers.
      Money-relevant columns to check by name: amount_cents_quoted, fee_bps_quoted,
      fee_credit_cents, poster_discount_cents, counter_offer, slot_id, starts_at,
      started_at, earner_done, poster_done, status, tip_amount, completed_at, and on jobs:
      pay, pay_type, estimated_hours.
  (c) Which guard trigger enforces each of those, what is its FINAL definition, and does the
      trigger NAME still exist (a \`create or replace function\` does not recreate a dropped
      trigger, and a renamed trigger can leave the old one detached)? List any guard function
      that exists but has NO trigger attached in the final state.
  (d) Are the trigger names' \`trg_y_\`/\`trg_z_\` ordering prefixes actually doing what the
      code assumes \u2014 i.e. does a guard run BEFORE or AFTER the pin, and can that ordering be
      exploited?
  (e) profiles.earnings_total and the XP/level system: can a client write their own earnings?`,
  },
  {
    key: 'client',
    title: 'Mobile + web clients: disclosure accuracy and money-triggering UX',
    prompt: `Audit the CLIENT side of money. Read src/context/JobsContext.js (the money
functions: bookJob, acceptBooking, declineBooking, cancelBooking, markJobComplete,
verifyAndRate, ratePoster, and the readiness helpers), src/lib/stripeClient.js,
shared/pricing.js, src/components/CompletionModal.js, src/screens/PayoutSetupScreen.js,
src/screens/EarnScreen.js, src/screens/GigsScreen.js, src/screens/JobDetailScreen.js,
and the equivalent web/ money surfaces plus web/lib/config.ts.

Attack it on: (a) DISCLOSURE. CLAUDE.md states the rule: a QUOTE for new work uses
getFeeBps() (the current rate); anything showing an EXISTING booking must use that booking's
feeBpsQuoted. Grep every call site of platformFeeCents / earnerNetCents / feeLabel /
effectiveFeeLabel / bookingNetDollars / SERVICE_FEE_PCT and classify each as quote-context
or existing-booking-context, then flag every site using the wrong rate. Also flag any place
that prints a percentage where the PROCESSING FLOOR actually set the fee (effectiveFeeLabel
returns null exactly for that case \u2014 check callers handle null rather than rendering
"null%" or falling back to the nominal rate). Also check the fee is described as coming out
of the EARNER's side, never added to the poster's charge.
(b) DOUBLE-SUBMIT. For each button that moves money (accept, verify & rate, tip, claim,
cancel), is it disabled/guarded during the in-flight request, and what happens on a network
timeout + user retry, or a backgrounded app? Does any path write to Supabase directly
BEFORE the edge function confirms, leaving the UI claiming a state the money does not
support?
(c) ORDER OF OPERATIONS. In verifyAndRate and markJobComplete, is the booking row advanced
before or after capture succeeds, and what does a failed capture leave behind?
(d) ERROR HANDLING: are the server's typed codes (HOLD_EXPIRED, EARNER_NO_PAYOUT,
EARNER_PAYOUTS_DISABLED, BELOW_MIN_PAY, PAYMENTS_PAUSED, DISPUTE_OPEN, card_requires_
authentication, tip_cap_*) each surfaced to the user with an action, or swallowed into a
generic toast that leaves them stuck?
(e) Does any client compute a fee/amount and SEND it to the server anywhere?`,
  },
  {
    key: 'invariant',
    title: 'End-to-end money conservation across the whole lifecycle',
    prompt: `This dimension is a WHOLE-SYSTEM CONSERVATION AUDIT. Ignore per-function
correctness; ask instead whether the books balance across the full lifecycle, and find the
sequences where they cannot.

State the invariant precisely in cents, then test it:
  poster_charged == earner_received + platform_kept   (for every settled booking)
  and after reversals: poster_net_charged == earner_net_received + platform_net_kept
where the platform also funds fee_credit_cents (referral bonuses) and poster_discount_cents
out of its own share, and must never pay Stripe's processing out of pocket
(the ceil(amount*0.029)+30+25 floor).

Enumerate the FULL state space and find the sequences that break it. Cover at minimum:
  * full capture; partial capture at each pct; earner claim; earner claim racing a partial
    capture; capture after a lapsed-and-re-held hold.
  * a booking carrying a fee credit AND a poster discount AND a promo fee_override AND a
    loyalty tier simultaneously \u2014 does the combination stay above the processing floor and
    still reconcile? Which benefit wins, and is the campaign charged what was delivered?
  * tips layered on any of the above.
  * admin refund (full and partial) after each of the above; a chargeback after payout;
    record_reversal; a refund on a booking whose earner already withdrew.
  * account deletion (admin/lib/deleteUser.ts) mid-flight.
  * settle_booking_benefits releasing the reserve after a partial capture.
For each break: the exact sequence, the cents that appear or vanish, and who bears it.
Also identify which of the ctl_* controls in supabase/migrations/20260806040000_control_library.sql
and later would DETECT each break, and name the breaks that NO control would catch \u2014 a
money defect with no detecting control is itself a high-severity finding.`,
  },
]

phase('Find')

const perDimension = await pipeline(
  DIMENSIONS,

  // Stage 1 — find.
  (d) => agent(
    `${RULES}\n\n=== YOUR DIMENSION: ${d.title} ===\n\n${d.prompt}\n\n` +
    `Report ONLY findings you can prove from the code. Set dimension to "${d.key}".`,
    { label: `find:${d.key}`, phase: 'Find', model: 'opus', effort: 'high', schema: FINDING_SCHEMA },
  ),

  // Stage 2 — adversarial verification of that dimension's findings, as soon as it lands.
  (res, d) => {
    if (!res || !res.findings || res.findings.length === 0) {
      return { dimension: d.key, verdicts: [], raw: res }
    }
    return agent(
      `${RULES}\n\n=== YOU ARE THE SKEPTIC ===\n\n` +
      `Another auditor examined "${d.title}" in the GoHustlr repo and produced the findings ` +
      `below. YOUR JOB IS TO REFUTE THEM. Assume each is wrong until the code forces you to ` +
      `agree. Default to REFUTED when you cannot prove the failure actually occurs.\n\n` +
      `For each finding, independently: re-read the cited file AND the surrounding code, ` +
      `establish the FINAL definition of any SQL function involved (last migration wins \u2014 a ` +
      `finding resting on a superseded definition is REFUTED), check whether some OTHER layer ` +
      `already prevents the failure (a guard trigger, an RLS policy, a unique index, a ` +
      `client-side gate does NOT count, a DB constraint does), and check whether an existing ` +
      `test in __tests__/ already pins the correct behaviour. Then decide.\n\n` +
      `Downgrade severity where the impact is overstated. If a finding is directionally right ` +
      `but the mechanism is wrong, mark it CONFIRMED and put the accurate mechanism in ` +
      `"correction". Reserve UNCERTAIN for findings whose resolution genuinely requires ` +
      `runtime observation you are forbidden from performing \u2014 say exactly what would settle it.\n\n` +
      `FINDINGS TO REFUTE:\n${JSON.stringify(res.findings, null, 2)}`,
      { label: `verify:${d.key}`, phase: 'Verify', model: 'opus', effort: 'high', schema: VERDICT_SCHEMA },
    ).then((v) => ({ dimension: d.key, verdicts: v?.verdicts ?? [], raw: res }))
  },
)

// Barrier is CORRECT here: the exploit stage and the synthesis both need the whole set at
// once (dedup across dimensions, and only survivors earn an exploit agent).
const alive = []
for (const r of perDimension.filter(Boolean)) {
  const byTitle = new Map((r.verdicts ?? []).map((v) => [v.title, v]))
  for (const f of (r.raw?.findings ?? [])) {
    const v = byTitle.get(f.title)
    if (!v || v.status === 'REFUTED') continue
    alive.push({ ...f, dimension: r.dimension, status: v.status, severity: v.corrected_severity !== 'none' ? v.corrected_severity : f.severity, verifier_note: v.correction || v.reasoning })
  }
}
log(`${alive.length} findings survived refutation across ${perDimension.filter(Boolean).length} dimensions`)

phase('Exploit')

const severe = alive.filter((f) => f.severity === 'critical' || f.severity === 'high').slice(0, 12)
if (alive.length > severe.length) {
  log(`exploit stage covers the ${severe.length} critical/high findings; ${alive.length - severe.length} medium/low go straight to synthesis`)
}

const exploits = await parallel(severe.map((f, i) => () => agent(
  `${RULES}\n\n=== BUILD THE CONCRETE FAILURE ===\n\n` +
  `A finding survived adversarial review. Construct the precise, step-by-step sequence that ` +
  `realises it, IN CENTS, and prove it against the code. Then write the fix.\n\n` +
  `FINDING (${i + 1}): ${JSON.stringify(f, null, 2)}\n\n` +
  `Produce: (1) an ordered reproduction \u2014 actor, endpoint/SQL, exact values, at each step, ` +
  `including who holds which role and what the DB and Stripe each believe after every step; ` +
  `(2) the exact cents that are created, destroyed or misdirected, and who bears the loss; ` +
  `(3) preconditions a real attacker or an unlucky user would need, and whether they are ` +
  `attainable through the shipped clients alone or require a patched client / direct API call; ` +
  `(4) whether the SANDBOX-vs-live-key distinction changes anything; (5) the minimal fix, as a ` +
  `unified diff or a new migration body, plus the regression test that would have caught it ` +
  `(name the file in __tests__/ and sketch the assertions \u2014 note that tests here are ` +
  `pure-logic and several PARSE THE MIGRATION SQL OFF DISK to prevent JS/SQL drift, e.g. ` +
  `__tests__/pricing.test.js and __tests__/categories.test.js \u2014 follow that pattern); ` +
  `(6) if reproduction turns out NOT to be possible, say so plainly and explain what the ` +
  `verifier and finder both missed. Do not manufacture a repro to justify the finding.`,
  { label: `exploit:${f.dimension}:${i + 1}`, phase: 'Exploit', model: 'opus', effort: 'high' },
)))

phase('Synthesize')

const synthesis = await agent(
  `${RULES}\n\n=== SYNTHESIS ===\n\n` +
  `You are writing the payments audit report for the founder of GoHustlr, who will act on it ` +
  `directly. Below are all findings that survived adversarial refutation, plus detailed ` +
  `exploit analyses for the severe ones.\n\n` +
  `Produce a single report in markdown:\n` +
  `1. VERDICT \u2014 in three sentences: is the money layer safe to take to live keys, and what ` +
  `   is the single worst thing found?\n` +
  `2. FINDINGS, ranked by expected loss (severity x reachability), deduplicated across ` +
  `   dimensions \u2014 the same root cause reported by three dimensions is ONE finding. For each: ` +
  `   title, severity, file:line, the mechanism in plain English, the money impact, and the fix.\n` +
  `3. FIX ORDER \u2014 a numbered plan, noting which fixes are a migration (needs ` +
  `   \`supabase db push --linked\`), which are an edge-function redeploy, which are a client ` +
  `   release, and which are config only. Call out any ordering hazard between them ` +
  `   (migrations must land before app builds that read new columns).\n` +
  `4. TEST GAPS \u2014 the regression tests that should exist and do not, following the existing ` +
  `   pure-logic + migration-parsing conventions in __tests__/.\n` +
  `5. WHAT IS SOUND \u2014 briefly, the money invariants you confirmed are genuinely well ` +
  `   defended, so the founder knows what NOT to churn.\n` +
  `6. RESIDUAL RISK / OPEN QUESTIONS \u2014 anything only runtime observation could settle, and ` +
  `   exactly what to run (in a branch database or Stripe test mode) to settle it.\n\n` +
  `Be honest about confidence. If the money layer is in good shape, say so \u2014 do not inflate ` +
  `findings to look thorough. A short, true report beats a long, padded one.\n\n` +
  `SURVIVING FINDINGS:\n${JSON.stringify(alive, null, 2)}\n\n` +
  `EXPLOIT ANALYSES:\n${exploits.filter(Boolean).join('\n\n---\n\n')}`,
  { label: 'synthesis', phase: 'Synthesize', model: 'opus', effort: 'high' },
)

return {
  dimensions_run: perDimension.filter(Boolean).length,
  surviving_findings: alive.length,
  severe_count: severe.length,
  findings: alive,
  report: synthesis,
}
