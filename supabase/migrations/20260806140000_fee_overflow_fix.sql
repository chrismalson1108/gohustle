-- ─────────────────────────────────────────────────────────────────────────────
-- platform_fee_cents: widen the multiply to bigint (2026-08-06).
--
-- THE BUG. 20260806050000 computes the percentage as
--     (coalesce(p_amount_cents,0) * coalesce(p_fee_bps,1000) + 5000) / 10000
-- entirely in int4. `amount * bps` overflows at 2,147,483,647, so the function RAISES
-- 22003 whenever amount_cents * fee_bps exceeds that. Reproduced live:
--     platform_fee_cents(1000000, 2147) -> 214700
--     platform_fee_cents(1000000, 2148) -> ERROR 22003 integer out of range
--     platform_fee_cents( 720000, 3000) -> ERROR 22003
--
-- Any rate at or above 2148 bps breaks large bookings; at 3000 bps — which
-- platform_rates.fee_bps explicitly permits and the /pricing page lets an admin set —
-- every gig over about $7,158 raises, well inside guard_job_pay_floor's $10,000 ceiling.
--
-- WHY IT MATTERS DESPITE THE FAIL-CLOSED PATHS. The edge functions turn the raise into
-- a clean 503 rather than a wrong number, which is the correct behaviour and stays. But
-- a supported rate change would silently become a payment outage on high-value gigs:
-- exactly the "a revenue outage caused by the config system is strictly worse than the
-- config system not existing" failure 20260806050000's own header claims to design
-- against.
--
-- WHY THE DRIFT TEST DID NOT CATCH IT. __tests__/pricing.test.js compares the SQL to a
-- JavaScript transcription, and JavaScript has no 32-bit integer overflow — the matrix
-- even includes amount=1000000, bps=3000, the exact pair that raises in Postgres, and
-- passes. A behavioural mirror cannot detect an arithmetic-width defect, so the test
-- added alongside this pins the cast TEXTUALLY instead.
--
-- NO EXISTING FEE MOVES BY A CENT. bigint division truncates identically to int4
-- division, so the half-up rounding is byte-for-byte unchanged. The inner ::integer
-- cannot itself overflow: the divide caps at 2147483647 * 3000 / 10000 = 644,245,094,
-- and least() caps the result at p_amount_cents. Every caller —
-- platform_fee_after_credit, poster_discount_headroom, consume_promo_grant,
-- consume_fee_credit — routes through this function and inherits the fix.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.platform_fee_cents(p_amount_cents integer, p_fee_bps integer)
returns integer
language sql
immutable
as $$
  select greatest(0, least(
    coalesce(p_amount_cents, 0),
    greatest(
      -- ::bigint on the LEFT operand widens the whole product. Rounds half up, matching
      -- Math.round in the JS this replaces; see 20260806050000 for why truncation is
      -- wrong. Widening changes no result that previously computed — it only stops the
      -- ones that raised.
      ((coalesce(p_amount_cents, 0)::bigint * coalesce(p_fee_bps, 1000) + 5000) / 10000)::integer,
      ceil(coalesce(p_amount_cents, 0) * 0.029)::integer + 30 + 25
    )
  ))
$$;

comment on function public.platform_fee_cents(integer, integer) is
  'Fee in cents for an amount at a rate. Rounds half up to match Math.round in the JS '
  'mirror, floors at Stripe cost (~2.9% + 30c) + 25c margin, caps at the amount. The '
  'multiply is bigint: int4 overflowed above ~21.47%, which platform_rates permits.';
