-- Corrective: 20260702000000 tried to re-grant service_role EXECUTE on the tip-credit
-- RPC but used a wrong signature guess (claim_and_credit_tip(uuid,integer)/(uuid,bigint)),
-- so the grant silently no-op'd (undefined_function, swallowed). review7
-- (20260624240000:159) had revoked the function FROM PUBLIC, which strips the grant
-- service_role held via PUBLIC membership — so the stripe-tip edge function (service
-- role) could hit "permission denied for function claim_and_credit_tip": the poster's
-- card is charged but the earner's tip is never credited (500).
--
-- Grant EXECUTE to service_role on the REAL signature. Idempotent — harmless if the
-- grant is already present (e.g. via a project-level default-privilege grant).
do $$
begin
  grant execute on function public.claim_and_credit_tip(text, uuid, uuid, integer) to service_role;
exception when undefined_function then
  raise notice 'claim_and_credit_tip(text,uuid,uuid,integer) not found — skipping';
end $$;

-- Belt-and-suspenders: ensure the earnings-credit RPC (already fixed in
-- 20260702000000, signature matched) is definitively executable by service_role too.
do $$
begin
  grant execute on function public.credit_earnings(uuid) to service_role;
exception when undefined_function then
  raise notice 'credit_earnings(uuid) not found — skipping';
end $$;
