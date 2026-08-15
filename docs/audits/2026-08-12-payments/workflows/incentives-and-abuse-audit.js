export const meta = {
  name: 'gohustlr-incentives-and-abuse-audit',
  description: 'Adversarial read-only audit of promotions, referrals, fee credits, discounts, tiers, kill switches, controls, admin money authority, and fraud economics',
  phases: [
    { title: 'Find', detail: '10 dimension finders across incentives, controls, admin authority, abuse economics', model: 'opus' },
    { title: 'Verify', detail: 'adversarial refutation per dimension', model: 'opus' },
    { title: 'Exploit', detail: 'concrete abuse construction with cost/yield economics', model: 'opus' },
    { title: 'Synthesize', detail: 'ranked report + fix order', model: 'opus' },
  ],
}

const ROOT = '/Users/chrismalson/Documents/gohustle'

const RULES = `
YOU ARE AUDITING THE GoHustlr REPO AT ${ROOT}. READ-ONLY. THIS IS ABSOLUTE.

HARD CONSTRAINTS (a previous audit round violated these: it disabled a live security
control through the admin console for hours, ran DELETE/TRUNCATE probes against the
production audit log, inserted an admin role, and forged user claims):
  * NEVER run: supabase CLI (db push/reset/psql/functions deploy), psql, stripe CLI,
    curl/fetch/wget against ANY http endpoint, vercel, or anything that could reach the
    production Supabase project nfioebqsgmmzhbksxozc, the Stripe account, or the admin
    console at gohustlr-admin.
  * NEVER invoke an edge function, forge a JWT, mint an admin role, or impersonate anyone.
  * NEVER edit, create, or delete a file in the repo. You may run \`npm test\` (pure-logic
    jest, no network) and read-only shell (ls, grep, rg, wc, git log, git show, sed -n).
  * This is STATIC ANALYSIS plus reasoning. Your evidence is code, SQL, and tests.

CRITICAL DOMAIN FACT — MIGRATION LAST-WRITER WINS:
  supabase/migrations/ applies in filename (timestamp) order and these functions are
  redefined with \`create or replace\` repeatedly. THE LIVE BEHAVIOUR IS THE LAST
  DEFINITION IN TIMESTAMP ORDER, not the one whose header comment reads most current.
  Establish it before claiming anything:
    grep -rn "function public\\.<name>" supabase/migrations/ | sort
  A finding resting on a superseded definition is a FALSE POSITIVE. But a later
  redefinition that silently DROPPED a guard, clamp, unique index, \`for update\`, or
  \`revoke execute\` from an earlier one is a REAL, HIGH-VALUE finding.

INCENTIVE SYSTEM MODEL (verify all of it; the docs may be wrong):
  promotions (campaign) -> promo_codes (redeemable strings) -> promo_grants (a user's
  claim, benefit SNAPSHOTTED on the grant) -> promo_redemptions (which grant paid for
  which booking). promotions.kind is 'fee_override' | 'bonus' | 'poster_discount'.
  Benefits are applied at booking INSERT inside pin_booking_amount, in order:
  loyalty tier (tier_fee_bps) -> promo (consume_promo_grant) -> fee credit
  (consume_fee_credit) -> poster discount (consume_poster_discount). Tier and promo are
  LOWEST-BPS-WINS, never additive. Credit and discount are both funded out of the SAME
  pot: the headroom between the platform fee and the Stripe processing floor
  (ceil(amount*0.029) + 30 + 25), because the platform must never pay processing out of
  pocket.
  Referral bonuses live in bonus_ledger and VEST ON OUTCOME: created when the REFERRED
  person's gig reaches 'verified', payable only after a ~7-day window with no refund and
  no open dispute (vest_bonuses(), run at the top of every control sweep). They are
  delivered as a FEE CREDIT, not cash \u2014 app_flags.bonus_cash_payout_enabled is OFF.
  THE PLATFORM FEE COMES OUT OF THE EARNER'S PAYOUT, so a fee discount is a SUPPLY-side
  incentive and does nothing for posters; a poster discount comes out of the platform's
  own share on top.
  Loss is meant to be bounded by promotions.budget_cents + max_redemptions, enforced in
  consume_promo_grant where THE INCREMENT IS THE CHECK (one conditional UPDATE), never
  read-then-decide. Stacking is meant to die at two unique indexes: one grant per user
  per promotion, one redemption per booking.
  Controls: ctl_*() functions in Postgres + control_findings + run_all_controls(),
  scheduled by pg_cron (hourly sweep at :05, daily digest 13:05 UTC). Alert dispatch
  config lives in app_flags, not a GUC \u2014 because a GUC sat misconfigured and silently
  dead from 2026-07-10 to 2026-08-06 with zero alerts firing.
  Admin roles are RANKED: support < {trust, finance} < admin (trust and finance are
  PEERS, neither outranks the other). MFA/AAL2 is re-verified on EVERY request from the
  JWT claim. Money movement requires the 'admin' tier plus a 300s MFA step-up.

WHAT COUNTS AS A FINDING (descending value):
  1. A benefit can be granted, stacked, replayed, or farmed beyond its budget \u2014 i.e.
     the platform's loss is NOT bounded by budget_cents / max_redemptions.
  2. A benefit is CHARGED to a campaign but never DELIVERED to the user, or DELIVERED but
     never charged, or a grant use is burned for nothing.
  3. A benefit survives its own end conditions (ends_at, status='paused',
     promotions_enabled=false, revoked_at, expires_at) or re-prices ALREADY-AGREED work.
  4. Referral farming that is profitable: work out the ACTUAL cost to the farmer (real
     fees paid on both sides, real work performed) versus the yield. Show the arithmetic.
     "Farming is possible" is worthless without the economics.
  5. An authorization gap: a role doing something its tier should not, the nav hiding
     what the guard permits, MFA step-up bypassable, an admin action with no audit row.
  6. A kill switch that does not kill, or fails in the wrong direction (fail-open where
     it should fail-closed, or fail-closed where it strands legitimate money).
  7. A control that cannot fire, silently reports success while blind, or does not cover
     a money invariant that IS breakable. A disabled/errored/stale control is as bad as a
     violation, because you are no longer being told the truth.
  8. An oracle: an endpoint whose error/timing distinguishes "exists" from "not yours".

WHAT IS NOT A FINDING:
  * Style, naming, comment density, abstract coverage wishes.
  * "Stripe is in test mode" \u2014 known and intentional.
  * A residual the code's own comments already name as deliberate, UNLESS you found a NEW
    consequence the comment does not mention.
  * Speculation with no concrete path. Every finding needs: inputs/state -> what goes
    wrong -> who loses what.

Be adversarial and concrete. Three proven findings beat ten suspected ones.
`

const FINDING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['dimension', 'findings', 'coverage_notes'],
  properties: {
    dimension: { type: 'string' },
    coverage_notes: { type: 'string', description: 'What you read, what you verified as SOUND, what you could not determine statically.' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'severity', 'file', 'line', 'summary', 'trigger', 'money_impact', 'evidence'],
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          file: { type: 'string' },
          line: { type: 'number' },
          summary: { type: 'string' },
          trigger: { type: 'string' },
          money_impact: { type: 'string', description: 'Who gains/loses what, with arithmetic where it is an economics question.' },
          evidence: { type: 'string', description: 'Quoted code/SQL with file:line.' },
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
          reasoning: { type: 'string' },
          corrected_severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'none'] },
          correction: { type: 'string' },
        },
      },
    },
  },
}

const DIMENSIONS = [
  {
    key: 'redeem',
    title: 'redeem_promo_code: brute force, oracles, rate limiting',
    prompt: `Audit the CODE REDEMPTION entry point \u2014 the only part of the incentive system an
unauthenticated-ish attacker drives directly. Read the FINAL definitions of
redeem_promo_code and everything touching promo_codes / promo_grants /
promo_redeem_attempts (start at supabase/migrations/20260806070000_promotions.sql, then
20260806170000_editable_incentives.sql, 20260806220000_benefit_lifecycle.sql,
20260806250000_referral_once_per_person.sql \u2014 and check for later ones yourself).

Attack it on: (a) the design claim is that it takes ONLY a string and returns ONLY
true/false because distinct errors would be an existence oracle. Verify that end to end \u2014
including SQL exceptions, unique-violation errors, NULL returns, and TIMING (does a valid
code do measurably more work than an invalid one? does an already-redeemed code differ from
a non-existent one?). Trace what the CLIENT does with each outcome too; an oracle restored
in the UI is still an oracle. (b) the rate limit is keyed on promo_redeem_attempts and the
design claim is that ATTEMPTS are recorded, not successes \u2014 because a brute-force sweep
that only ever fails would otherwise never register. Verify the attempt row is written on
EVERY path including early returns and exceptions, and that a failed transaction cannot roll
the attempt row back while the attacker keeps their try. (c) what is the limit keyed on \u2014
user, IP, code? What does an attacker with N fresh accounts achieve, and how expensive is a
fresh account (check the signup path: email confirmation, ID verification gating)? (d) code
entropy: how are promo_codes minted, what is the alphabet and length, are they sequential or
guessable, and is there a case/whitespace normalisation that shrinks the space? (e) can one
person hold grants from the same promotion twice via race, case variance, or a second code
belonging to the same campaign? Name the unique index that stops it, or its absence.`,
  },
  {
    key: 'budget',
    title: 'consume_promo_grant: budget bounding and stacking',
    prompt: `Audit BUDGET ENFORCEMENT \u2014 the property that bounds the platform's total loss.
Establish the FINAL definition of consume_promo_grant (redefined in at least
20260806070000, 20260806170000, 20260806220000 \u2014 verify the real list) and read every
version in order, diffing them.

Attack it on: (a) the core claim: "the increment IS the check" \u2014 a single
\`UPDATE ... SET spent = spent + hit WHERE spent + hit <= budget AND used < max\`, never
read-then-decide. Verify that in the FINAL body. If any version reads then decides, or does
the check in a separate statement, construct the concurrent interleaving that oversubscribes
the budget and quantify the overspend with N concurrent bookings. (b) the two unique indexes
(one grant per user per promotion, one redemption per booking) \u2014 confirm they EXIST in the
final schema, are UNIQUE not just indexed, and cover the columns claimed. Check whether a
partial index predicate (e.g. \`where released_at is null\`) leaves a gap that a
release-then-reclaim cycle walks through. (c) ordering: consume_promo_grant runs inside
pin_booking_amount's BEGIN/EXCEPTION block. If it charges the campaign and then a LATER
benefit block raises, or the booking INSERT itself fails after the trigger ran, is the charge
rolled back? Reason carefully about plpgsql exception-block savepoint scope and about a
BEFORE INSERT trigger whose statement later aborts. (d) an EXHAUSTED budget must still let
the booking SUCCEED at the standing rate \u2014 verify, and check the reverse: can budget
exhaustion strand a booking or produce a NULL bps that degrades to a FREE gig rather than the
standing rate? (e) selection order \`order by ... desc nulls last\` when a user holds multiple
grants \u2014 can a user steer which campaign pays?`,
  },
  {
    key: 'referral',
    title: 'Referral bonuses: vesting, clawback, and farming economics',
    prompt: `Audit REFERRAL BONUSES. Read supabase/migrations/20260806080000_referral_bonus.sql,
20260806250000_referral_once_per_person.sql, 20260806260000_release_fee_credits.sql,
20260806220000_benefit_lifecycle.sql and the FINAL definitions of vest_bonuses,
consume_fee_credit, and anything writing bonus_ledger. Also read the referral surfaces in
src/ and the profiles.referral_code column and migration_referrals.sql.

Attack it on: (a) VESTING. The bonus is created when the REFERRED person's gig reaches
'verified' and becomes payable after ~7 days with no refund and no open dispute. Verify
vest_bonuses actually checks both, that the window is measured from the right timestamp, and
that a refund or chargeback landing AFTER vesting claws the bonus back \u2014 or find that it
does not. What happens if the booking is refunded on day 8? (b) vest_bonuses runs "at the top
of every control sweep" (pg_cron hourly). What if the sweep is not running, errors, or the
cron job does not exist in the final migration state? Verify the schedule is actually created
and would survive. A bonus system whose vesting depends on a cron that silently stopped is a
finding. (c) FARMING ECONOMICS \u2014 do the arithmetic, do not hand-wave. Two colluding accounts:
A refers B, B does a gig for A (or vice versa). Compute the REAL cost: the platform fee
actually paid on the booking (remember the processing floor ceil(amt*0.029)+30+25 makes even
a 0% gig cost ~3.2%), the card processing the farmer bears as the poster, the time, and the
ID-verification / signup friction. Against that, the yield: bonus size, whether it is a fee
credit (usable only against a FUTURE fee, capped by that gig's headroom) or cash. State the
net per cycle and whether it is profitable at any gig size. Find the gig size that MAXIMISES
farmer yield. (d) once-per-person: verify the constraint in 20260806250000 is on the right
identity (user id? email? device?) and cannot be defeated by deleting and re-creating an
account \u2014 read supabase/functions/delete-account/index.ts and admin/lib/deleteUser.ts and
check what a deleted user's referral state leaves behind. (e) bonus_cash_payout_enabled is
OFF \u2014 verify EVERY path that could pay a bonus as cash honours it, including any admin
console path, and that turning it on would not immediately expose an unbounded rail.`,
  },
  {
    key: 'credits',
    title: 'Fee credits: delivery, release, and never-lost/never-duplicated',
    prompt: `Audit FEE CREDITS end to end \u2014 the delivery mechanism for referral bonuses. Read
the FINAL definitions of consume_fee_credit, platform_fee_after_credit,
poster_discount_headroom, settle_booking_benefits, and the release path in
supabase/migrations/20260806260000_release_fee_credits.sql and
20260806220000_benefit_lifecycle.sql.

Attack it on: (a) The design says consume_fee_credit spends ONLY the headroom between the fee
and the processing floor, splitting the remainder BACK onto the ledger, so the platform never
pays Stripe's processing to honour a credit. Verify the split arithmetic in cents across a
matrix of amounts and bps \u2014 especially where the fee is ALREADY at the floor (headroom 0),
where the credit exceeds the fee entirely, and at bps 0. Can any input make the credit
exceed the headroom, produce a negative fee, or lose the remainder instead of returning it?
(b) LIFECYCLE. A credit is consumed at booking INSERT. What happens to it when the booking is
then declined, cancelled, the hold lapses, the payment fails, the booking is refunded, or the
poster never accepts at all? Trace each terminal state and determine whether the credit is
RELEASED back to the ledger exactly once, lost forever, or released MORE than once (which
would let one bonus be spent repeatedly). Name the trigger/function that performs each
release and confirm it fires on every terminal path, not just the common one. (c) Is there
any sequence where the same bonus_ledger row funds TWO bookings? Consider: book, credit
consumed, cancel (released), re-book \u2014 while the first booking's payment row still carries
fee_credit_cents. And: two concurrent bookings by the same earner. (d) settle_booking_benefits
after a PARTIAL capture \u2014 does it return the right amount to both the campaign budget and
the bonus ledger, and can it run twice? (e) Does the earner ever SEE the credit applied, and
does what they see match what the pin actually stored?`,
  },
  {
    key: 'discounts',
    title: 'Poster discounts, kind confusion, and idempotence',
    prompt: `Audit POSTER DISCOUNTS \u2014 the platform-funded, demand-side benefit. Read
supabase/migrations/20260806110000_poster_discounts.sql,
20260806240000_poster_discount_idempotence.sql,
20260806320000_discount_headroom_after_credit.sql,
20260806340000_discount_kind_confusion.sql in that order, diff the successive definitions of
consume_poster_discount, and establish the FINAL one.

Attack it on: (a) KIND CONFUSION. 20260806340000 exists because a promotion of one kind was
being consumed by the wrong consumer. Verify the FINAL state: does EVERY consumer
(consume_promo_grant, consume_fee_credit, consume_poster_discount) filter on
promotions.kind, and is the filter exhaustive and mutually exclusive? Can a single grant be
consumed by TWO different consumers on the same booking \u2014 charged once but delivered twice,
or charged twice for one delivery? Check the promo_redemptions unique index on booking_id
against that: if only ONE redemption row per booking is possible, what happens when a user
holds both a fee_override grant and a poster_discount grant and books once? Does one
silently lose, and is the loser CHARGED anyway? (b) IDEMPOTENCE. 20260806240000 moved to
insert-before-charge with an early return on an existing redemption and a scoped rollback.
Verify the final body: the early return reads \`released_at is null\` but the conflict-recovery
read does NOT \u2014 work out whether a RELEASED redemption on the same booking makes the
function return a stale reserved_cents while charging nothing, or charge again. (c) The pin's
belt-and-braces clamp \`least(consumed, headroom - fee_credit_cents)\` is documented as
"should never bind". Find any input where it DOES bind in the final code, since that is by
the author's own reasoning a drift indicator. (d) The discount reduces what the POSTER is
charged while the earner's side is untouched, so it comes out of platform fee. Verify
platformFee = feeAfterCredit - discount can never go negative at Stripe, across the whole
benefit matrix, and that authorizedCents >= 50 (Stripe minimum) is preserved. (e) Who is the
discount granted to \u2014 confirm consume_poster_discount is called with the POSTER's id and not
the earner's, in the final pin.`,
  },
  {
    key: 'tiers',
    title: 'Loyalty fee tiers: tier_fee_bps',
    prompt: `Audit LOYALTY TIERS. Read supabase/migrations/20260806120000_fee_tiers.sql and any
later migration touching tier_fee_bps or the tier tables, plus every client surface that
displays a tier.

Attack it on: (a) What drives a user's tier \u2014 which columns/tables, and can the user write
any of them directly (check RLS and grants on those tables/columns)? Jobs-done counts,
earnings totals, ratings and XP are the usual inputs; CLAUDE.md says "Jobs Done" is derived
from bookings rather than a counter, but VERIFY what tier_fee_bps actually reads. If it reads
a profiles column the user can UPDATE, that is a critical self-promotion to a lower fee.
(b) Tiers are "standing policy, no budget, no expiry" and lowest-bps-wins against the promo
\u2014 so unlike a campaign there is NO budget bounding them. Compute the worst case: what is the
lowest bps a tier can grant, what does the processing floor recover, and what is the
platform's margin at that rung on a typical and on a large gig? Is any rung actually
loss-making once the floor is accounted for? (c) The tier lookup sits in a BEGIN/EXCEPTION
block in pin_booking_amount that swallows failures with a warning \u2014 what does a failing tier
lookup cost the user (silently charged full fee with no disclosure)? Is that visible anywhere?
(d) Can the tier CHANGE between what the client displayed at quote time and what the pin
stamps at INSERT, and is the difference disclosed? (e) Is there any admin path to set a
user's tier arbitrarily, and is it audited and tier-gated?`,
  },
  {
    key: 'flags',
    title: 'Kill switches and app_flags',
    prompt: `Audit the KILL SWITCHES. Find every app_flags key in the repo
(\`rg -n "app_flags|app_flag\\(" --glob '!node_modules'\`) and every consumer of each. Known
keys include payments_enabled, tips_enabled, promotions_enabled, bonus_cash_payout_enabled,
plus the alert-dispatch config keys.

Attack it on: (a) For EACH flag: enumerate every consumer, and determine whether the flag is
actually checked on EVERY path that the flag claims to control. A flag named
payments_enabled that only gates ONE of four money entry points is a false sense of safety \u2014
name any path that bypasses it. Specifically check whether capture, claim, tip and admin
refund each respect the relevant flag, and whether that is the RIGHT design (the code argues
in-flight bookings should still capture so nobody mid-gig is stranded \u2014 assess whether the
actual gating matches that stated intent). (b) FAIL DIRECTION. stripe-create-payment-intent
and stripe-tip fail OPEN on a flag-check error, deliberately and with logging. Assess whether
fail-open is right for each individual flag \u2014 in particular promotions_enabled: if that check
errors, does the system hand out benefits it believes are switched off, and is THAT bounded?
(c) WHO CAN FLIP THEM: RLS and grants on app_flags, the admin console /flags page, the role
tier required, whether an audit row is written, and whether a flag flip can re-price agreed
work. (d) The alert-dispatch config lives in app_flags precisely because a GUC sat dead from
2026-07-10 to 2026-08-06 with zero alerts firing. Verify the CURRENT config is asserted on
somewhere \u2014 is there a control that fails when dispatch is misconfigured, or could the same
silent-death recur with a different key? Check that the assertion covers a MISSING key, not
just a wrong value.`,
  },
  {
    key: 'controls',
    title: 'The controls engine: can it actually tell you the truth?',
    prompt: `Audit the CONTROLS ENGINE, whose whole job is to notice when the other findings
happen. Read supabase/migrations/20260806030000_schedule_controls.sql,
20260806040000_control_library.sql, 20260806270000_resolve_only_examined.sql,
20260806280000_watch_disabled_controls.sql, 20260806350000_controls_always_on.sql,
20260806160000_dispatch_monitoring.sql, 20260806330000_dispatch_timeouts.sql,
20260806020000_alert_config_in_app_flags.sql, supabase/functions/controls-alert/index.ts,
and the FINAL definitions of run_all_controls, run_control and every ctl_* function.

Attack it on: (a) run_control validates fn_name against \`^ctl_[a-z0-9_]+$\` AND pg_proc,
because a stored executable body would hand anyone with console write access arbitrary
SECURITY DEFINER execution. Verify BOTH checks exist in the final version and that the regex
cannot be escaped (schema qualification, quoting, unicode, a function named ctl_ that is not
a control). Check what privileges run_control executes with and whether registering a new
control is itself privileged. (b) COVERAGE: list every ctl_* control and map it to the money
invariant it protects. Then list the money invariants from the system model that have NO
control. A breakable invariant with no detecting control is a high-severity finding \u2014 name
each one. (c) TRUTHFULNESS: a control that errors or goes stale must be reported as loudly as
a violation, and a DISABLED control must be caught by ctl_control_disabled (added after an
audit agent disabled one and nothing noticed for hours). Verify a control that (i) errors,
(ii) has not run, (iii) is disabled, and (iv) was deleted from the registry entirely, is each
detected. Case (iv) especially: does anything notice a control that simply no longer exists?
(d) Findings are unique on (control_key, entity_id) where resolved_at is null, and anything a
control stops returning AUTO-RESOLVES. 20260806270000 exists because auto-resolve was
resolving findings the control never examined. Verify the final logic cannot auto-resolve a
finding merely because a control errored, timed out, or returned an empty set for an
unrelated reason. (e) The pg_cron schedules: verify both jobs are actually created in the
final migration state, that a failure in vesting cannot abort the whole sweep, and that
paging happens only on NEWLY-needing-a-human but cannot suppress a still-open critical
forever.`,
  },
  {
    key: 'admin',
    title: 'Admin console money authority: roles, MFA, audit',
    prompt: `Audit ADMIN MONEY AUTHORITY. Read admin/lib/guard.ts (roleSatisfies and the whole
tier model), supabase/functions/_shared/adminAuth.ts, supabase/functions/admin-payment-action/index.ts,
supabase/migrations/20260806090000_admin_roles.sql, 20260806100000_admin_mfa_control_fix.sql,
the admin console pages that touch money (/payments, /promotions, /pricing, /controls,
/flags, /disputes), and admin/lib/deleteUser.ts.

Attack it on: (a) THE GUARD IS THE ENFORCEMENT, the nav only hides. For every server action
and API route in admin/ that reads or writes money, promotions, pricing, flags, or roles:
confirm it calls the guard with the CORRECT tier. List any route with a missing, weaker, or
mis-ordered check. Remember trust and finance are PEERS \u2014 find any comparison that
accidentally makes one outrank the other, or any \`>=\` on an enum ordering that lets support
satisfy trust. (b) MFA/AAL2 is re-verified on EVERY request from the JWT claim, and
admin-payment-action additionally demands a 300s step-up. Verify the AAL2 claim cannot be
stale, replayed, or absent-but-defaulted-true, and that the step-up age is computed from a
claim the admin cannot control. Check every OTHER money-moving admin path for the same
step-up (or its justified absence). (c) The console writes its admin_audit_log row BEFORE
calling the edge function, so an action that reaches Stripe is always already on the record.
Verify that for every money action, and find any that writes the row after, or not at all,
or that can reach Stripe on a path that skips the console entirely. Check the audit row
captures enough to reconstruct WHAT was done. (d) Login throttle: 5 failures per account /
15 min, 20 per IP \u2014 verify it exists in the final state, cannot be reset by the attacker,
and that ctl_admin_login_bruteforce still exists and is enabled-by-default. (e) Role
assignment: who can grant a role, is it audited, can a support-tier admin escalate
themselves, and can an admin remove the last admin? (f) deleteUser.ts mid-flight: what
happens to open holds, unvested bonuses, active grants, and outstanding earnings when a user
is deleted?`,
  },
  {
    key: 'abuse',
    title: 'End-to-end fraud economics and value-transfer rails',
    prompt: `This dimension is ECONOMIC, not line-by-line. Model GoHustlr as an adversary would
and price every rail. Think like someone trying to move value, launder money, or extract more
than they put in \u2014 then compute whether it PAYS. Every claim needs arithmetic in cents.

Model the actors and rails, reading whatever code you need to price them accurately:
  (a) SELF-DEALING: one person, two accounts. Post a gig, book it from the alt, accept,
  verify, withdraw. Price it exactly: platform fee (with the processing floor), Stripe's own
  cut, the payout timing, ID verification friction, and what the poster's card is charged
  versus what the earner's bank receives. Then the same cycle with EVERY benefit stacked
  (best tier + promo + fee credit + poster discount) \u2014 what is the minimum possible total
  cost of moving $1,000 through the platform, and can any combination make it FREE or
  PROFITABLE? Do the same for the TIP rail, which carries no application fee at all.
  (b) STOLEN CARD: poster funds a gig with a stolen card, earner (the same person) is paid
  out, chargeback lands later. Trace exactly who bears the loss given destination charges,
  reverse_transfer, refund_application_fee, and payout timing \u2014 and how long the attacker
  has between payout and chargeback. Identify what, if anything, currently limits exposure
  (velocity limits, payout delays, ID verification, the disputes gate) and quantify the gap.
  (c) COLLUSION AT SCALE: N accounts farming referrals and promotions together. Compute
  yield per account-hour and the total loss bounded (or not) by budget_cents.
  (d) THE OPPOSITE DIRECTION: where can an HONEST user lose money or work unpaid? Enumerate
  every path where a worker performs a gig and cannot get paid \u2014 the hold-lapse
  architectural gap, EARNER_PAYOUTS_DISABLED after work, a poster who ghosts on a booking
  with no slot, a booking with no payment row. For each, state whether a self-service or
  support path exists, and whether the user is TOLD.
  (e) For every rail above, name the control (ctl_*) or limit that bounds it, or state that
  none does. Rank the rails by expected loss at 1,000 users.`,
  },
]

phase('Find')

const perDimension = await pipeline(
  DIMENSIONS,
  (d) => agent(
    `${RULES}\n\n=== YOUR DIMENSION: ${d.title} ===\n\n${d.prompt}\n\n` +
    `Report ONLY what you can prove from the code. Set dimension to "${d.key}".`,
    { label: `find:${d.key}`, phase: 'Find', model: 'opus', effort: 'high', schema: FINDING_SCHEMA },
  ),
  (res, d) => {
    if (!res || !res.findings || res.findings.length === 0) {
      return { dimension: d.key, verdicts: [], raw: res }
    }
    return agent(
      `${RULES}\n\n=== YOU ARE THE SKEPTIC ===\n\n` +
      `Another auditor examined "${d.title}" and produced the findings below. YOUR JOB IS TO ` +
      `REFUTE THEM. Assume each is wrong until the code forces you to agree. Default to ` +
      `REFUTED when you cannot prove the failure actually occurs.\n\n` +
      `For each: re-read the cited file and its surroundings; establish the FINAL definition of ` +
      `every SQL function involved (last migration in timestamp order wins \u2014 a finding resting ` +
      `on a superseded body is REFUTED); check whether another layer already prevents it (a ` +
      `unique index, a guard trigger, an RLS policy, a DB constraint count \u2014 a client-side ` +
      `check does NOT); check whether a test in __tests__/ already pins the correct behaviour. ` +
      `Where the finding is an ECONOMICS claim, re-do the arithmetic yourself in cents and ` +
      `REFUTE it if the attack is not actually profitable \u2014 including the Stripe processing ` +
      `floor, which makes many "free" abuses cost ~3.2%.\n\n` +
      `Downgrade overstated severity. If directionally right but mechanically wrong, mark ` +
      `CONFIRMED and give the accurate mechanism in "correction". Reserve UNCERTAIN for what ` +
      `genuinely needs runtime observation you are forbidden from performing \u2014 say what would ` +
      `settle it.\n\nFINDINGS TO REFUTE:\n${JSON.stringify(res.findings, null, 2)}`,
      { label: `verify:${d.key}`, phase: 'Verify', model: 'opus', effort: 'high', schema: VERDICT_SCHEMA },
    ).then((v) => ({ dimension: d.key, verdicts: v?.verdicts ?? [], raw: res }))
  },
)

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
  log(`exploit stage covers ${severe.length} critical/high findings; ${alive.length - severe.length} medium/low go straight to synthesis`)
}

const exploits = await parallel(severe.map((f, i) => () => agent(
  `${RULES}\n\n=== BUILD THE CONCRETE ABUSE ===\n\n` +
  `A finding survived adversarial review. Construct the precise sequence that realises it and ` +
  `PRICE it, then write the fix.\n\nFINDING (${i + 1}): ${JSON.stringify(f, null, 2)}\n\n` +
  `Produce: (1) an ordered reproduction \u2014 actor(s), accounts needed, endpoint/SQL and exact ` +
  `values at each step, and what the DB, Stripe and the campaign budget each believe after ` +
  `every step; (2) THE ECONOMICS in cents \u2014 the attacker's total cost (fees actually paid, ` +
  `processing floor, real work performed, account-creation friction) versus their yield, per ` +
  `cycle and at scale, and the platform's total exposure with and without budget_cents ` +
  `bounding it; (3) preconditions \u2014 attainable through the shipped clients alone, or needing a ` +
  `patched client, a direct PostgREST/RPC call, or console access? (4) whether SANDBOX vs live ` +
  `keys changes anything; (5) the minimal fix \u2014 a unified diff or a complete new migration ` +
  `body, in the style of the existing migrations (idempotent, with a header comment stating ` +
  `what it fixes and why), plus the ctl_* control that should detect it if it recurs, plus the ` +
  `regression test (tests here are pure-logic jest and several PARSE THE MIGRATION SQL OFF ` +
  `DISK to prevent JS/SQL drift \u2014 e.g. __tests__/pricing.test.js, __tests__/categories.test.js ` +
  `\u2014 follow that pattern); (6) if it turns out NOT to be reproducible or NOT profitable, say ` +
  `so plainly and explain what both the finder and the verifier missed. Do not manufacture a ` +
  `repro to justify a finding.`,
  { label: `exploit:${f.dimension}:${i + 1}`, phase: 'Exploit', model: 'opus', effort: 'high' },
)))

phase('Synthesize')

const synthesis = await agent(
  `${RULES}\n\n=== SYNTHESIS ===\n\n` +
  `Write the incentives-and-abuse audit report for the founder of GoHustlr, who will act on ` +
  `it directly. Below are the findings that survived adversarial refutation plus exploit ` +
  `analyses for the severe ones.\n\nProduce a markdown report:\n` +
  `1. VERDICT \u2014 three sentences: is the incentive layer's loss actually BOUNDED, and what is ` +
  `   the single worst thing found?\n` +
  `2. FINDINGS ranked by expected loss (severity x reachability x yield), deduplicated across ` +
  `   dimensions \u2014 one root cause reported by three dimensions is ONE finding. For each: ` +
  `   title, severity, file:line, mechanism in plain English, the money/abuse impact with ` +
  `   arithmetic, and the fix.\n` +
  `3. BOUNDEDNESS TABLE \u2014 for each rail (promo, referral, fee credit, poster discount, tier, ` +
  `   tip, self-dealing, stolen card): what bounds the platform's loss today, and whether that ` +
  `   bound actually holds.\n` +
  `4. CONTROL GAPS \u2014 money invariants that are breakable with NO ctl_* control watching.\n` +
  `5. FIX ORDER \u2014 numbered, noting migration (\`supabase db push --linked\`) vs edge-function ` +
  `   redeploy vs admin console deploy (which does NOT auto-deploy: \`cd admin && npx vercel ` +
  `   --prod\`) vs client release, and any ordering hazard.\n` +
  `6. TEST GAPS \u2014 regression tests that should exist, following the existing pure-logic + ` +
  `   migration-parsing conventions.\n` +
  `7. WHAT IS SOUND \u2014 briefly, so the founder does not churn on what already works.\n` +
  `8. RESIDUAL RISK \u2014 what only runtime observation could settle, and exactly what to run in ` +
  `   a branch database or Stripe test mode to settle it.\n\n` +
  `Be honest about confidence. Do not inflate findings to look thorough.\n\n` +
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
