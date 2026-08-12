-- ─────────────────────────────────────────────────────────────────────────────
-- Reconciliation auto-resolved findings it had never looked at.
--
-- resolve_reconciliation_findings closed every open stripe_reconciliation finding whose
-- entity was not in p_still_open. But p_still_open is built from ONE scan, and that scan
-- is bounded — 14 days and 200 rows by default. A payment that raised a discrepancy
-- three weeks ago is not in the window, so it is not scanned, so it cannot appear in
-- p_still_open, so it was resolved.
--
-- With the note 'auto-resolved: reconciles against Stripe' — a statement that was never
-- true for that row. A genuine money discrepancy could simply age out of the window and
-- be marked clean.
--
-- This is the worst class of monitoring bug. It does not fail loudly or stop working; it
-- reports success it did not verify, and the operator has no way to tell the difference.
--
-- The fix is to say what was actually examined. A finding may only be resolved if this
-- run looked at its entity and found it clean. Anything outside the window stays open
-- until a scan genuinely covers it.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.resolve_reconciliation_findings(
  p_still_open text[],
  p_examined   text[] default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare n integer;
begin
  update public.control_findings f
     set resolved_at = now(),
         note = coalesce(f.note || ' | ', '') || 'auto-resolved: reconciles against Stripe'
   where f.control_key = 'stripe_reconciliation'
     and f.resolved_at is null
     -- Only entities this run actually examined. A null p_examined preserves the old
     -- behaviour for any caller that has not been updated yet, but the shipped caller
     -- always passes it.
     and (p_examined is null or f.entity_id = any (p_examined))
     and not (f.entity_id = any (coalesce(p_still_open, '{}')));
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke execute on function public.resolve_reconciliation_findings(text[], text[])
  from public, anon, authenticated;
