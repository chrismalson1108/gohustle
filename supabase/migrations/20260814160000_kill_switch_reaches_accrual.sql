-- ─────────────────────────────────────────────────────────────────────────────
-- The kill switch reaches the MINTING path too.
--
-- This belongs with 20260814150000 and is a separate file for a mechanical reason worth
-- recording: that migration had ALREADY been applied when I wrote this half, and appending
-- to an applied file is a silent no-op — supabase_migrations.schema_migrations is keyed on
-- the leading timestamp, so the version is already recorded and the new text never runs.
-- The push reports "Remote database is up to date" and everything looks fine.
--
-- Same failure mode migrationHygiene.test.js exists for, from the other direction.
--
-- Doing only consume_fee_credit would leave promotions_enabled half-connected: spending
-- stops and accrual carries on, so flipping it during an incident still grows the
-- liability while whoever flipped it believes the bleeding stopped.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── And the kill switch reaches the MINTING path ────────────────────────────
-- Doing only consume_fee_credit would leave the switch half-connected: spending stops and
-- accrual carries on, so flipping it during an incident still grows the liability. The
-- flag is read at the top, before the referral lookup, so a suspended platform does no
-- work and writes nothing.
--
-- Patched from the live definition rather than retyped: the body carries a deliberate
-- INSERT-FIRST ordering against two unique indexes, and copying that by hand to add three
-- lines is how it gets subtly wrong.
do $patch$
declare src text; patched text; needle text; repl text;
begin
  select pg_get_functiondef(p.oid) into src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'accrue_referral_bonus';
  if src is null then raise exception 'accrue_referral_bonus not found'; end if;
  if position('promotions_enabled' in src) > 0 then
    raise notice 'accrue_referral_bonus already reads the flag; nothing to patch';
    return;
  end if;

  needle := 'if new.status <> ''verified'' or coalesce(old.status, '''') = ''verified'' then';
  repl := '-- The incident lever, read before any work. See 20260814150000.' || chr(10)
       || '  if not coalesce((select enabled from public.app_flags where key = ''promotions_enabled''), true) then' || chr(10)
       || '    return new;' || chr(10)
       || '  end if;' || chr(10) || '  ' || needle;

  patched := replace(src, needle, repl);
  if patched = src then
    raise exception 'accrue_referral_bonus does not open in the expected shape — refusing to patch blind';
  end if;
  execute patched;
  raise notice 'accrue_referral_bonus now reads promotions_enabled';
end $patch$;

do $verify$
declare src text;
begin
  select pg_get_functiondef(p.oid) into src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'accrue_referral_bonus';
  if position('promotions_enabled' in src) = 0 then
    raise exception 'FIX FAILED: the minting path still ignores the kill switch';
  end if;
  raise notice 'both incentive paths — spending and minting — now honour promotions_enabled';
end $verify$;
