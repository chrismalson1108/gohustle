-- ─────────────────────────────────────────────────────────────────────────────
-- The student verification code's 5-attempt cap was a read-then-write counter, so
-- concurrent guesses were nearly free.
--
-- student-verify-confirm read the newest unconsumed row, tested `row.attempts >= 5`
-- against the value it had just read, compared the hash, and only on a mismatch wrote
-- `attempts: row.attempts + 1` in a SEPARATE statement — an absolute value computed from
-- a stale read, with no predicate. N requests fired together all read attempts = 0, were
-- all evaluated as guesses, and all wrote 1. Twenty guesses cost one attempt. Nothing
-- else limited the endpoint.
--
-- The code space is 900,000 and the prize is not small: on a hit the attacker's profile
-- is set student_verified with `school` derived from the VICTIM's domain — the trust
-- signal a poster weighs when deciding who to let into their home — and the consumed row
-- then blocks the real owner of that inbox from ever verifying it.
--
-- This is the same defect class CLAUDE.md already records for mfa_recovery_attempts, and
-- the rule adopted there is the fix: COUNT FIRST, atomically.
--
-- ── THE SHAPE ───────────────────────────────────────────────────────────────
-- claim_student_verification() makes the attempt the gate:
--
--   update … set attempts = attempts + 1 where id = … and attempts < 5 returning attempts
--
-- One statement. Under READ COMMITTED a concurrent updater blocks on the row lock and
-- then RE-EVALUATES the predicate against the committed version, so the sixth guess in a
-- burst of a thousand finds attempts = 5 and updates nothing. A correct guess costs an
-- attempt too, which is the point — the counter can no longer be dodged by winning a
-- race.
--
-- The hash comparison moved into the same function so the increment, the comparison, the
-- one-inbox-one-account check and the consume are one call rather than four statements a
-- caller could interleave.
--
-- ── WHY THE SECOND LIMIT IS PER INBOX, NOT PER USER ─────────────────────────
-- Per-user is the obvious ceiling and it does not bind the attack. The row is bound to
-- the ATTACKER's uid and the hash is salted with it, so an attacker with fifty accounts
-- gets fifty independent budgets against the same victim inbox — and student-verify-start
-- inserts its row BEFORE counting, so even rate-limited requests leave live, confirmable
-- codes behind. What actually bounds the grind is a ceiling on attempts against one
-- ADDRESS across all accounts, which is the same lever start already applies to sends.
--
-- 15 in 15 minutes: three full 5-attempt budgets, well past mistyping and far short of
-- the tens of thousands the arithmetic needs.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.claim_student_verification(
  p_user uuid,
  p_email text,
  p_code_hash text
)
returns table (status text, domain text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_expires timestamptz;
  v_hash text;
  v_domain text;
  v_attempts int;
  v_recent int;
begin
  if p_user is null or p_email is null or p_code_hash is null then
    return query select 'no_pending'::text, null::text;
    return;
  end if;

  select s.id, s.expires_at, s.code_hash, s.domain
    into v_id, v_expires, v_hash, v_domain
    from public.student_email_verifications s
   where s.user_id = p_user
     and s.email = p_email
     and s.consumed = false
   order by s.created_at desc
   limit 1;

  if v_id is null then
    return query select 'no_pending'::text, null::text;
    return;
  end if;

  if v_expires < now() then
    return query select 'expired'::text, null::text;
    return;
  end if;

  -- Per-INBOX ceiling, across every account. Per-user does not bind an attacker who can
  -- register more accounts, and each account gets its own code for the same victim.
  select coalesce(sum(s.attempts), 0) into v_recent
    from public.student_email_verifications s
   where s.email = p_email
     and s.created_at > now() - interval '15 minutes';
  if v_recent >= 15 then
    return query select 'too_many_attempts'::text, null::text;
    return;
  end if;

  -- THE GATE. The increment IS the check: one statement, and a concurrent caller
  -- re-evaluates `attempts < 5` after taking the row lock, so a burst cannot all pass a
  -- read taken before any of them wrote.
  update public.student_email_verifications
     set attempts = attempts + 1
   where id = v_id
     and attempts < 5
  returning attempts into v_attempts;

  if v_attempts is null then
    return query select 'too_many_attempts'::text, null::text;
    return;
  end if;

  -- Compared AFTER the attempt is spent. A correct guess costs one too; anything else
  -- leaves a free channel for whoever wins the race.
  if v_hash is distinct from p_code_hash then
    return query select 'invalid_code'::text, null::text;
    return;
  end if;

  -- One .edu inbox verifies one account. Tombstoned owners are excluded: an erased
  -- account must not hold an inbox hostage (20260906025100 deletes those rows, and this
  -- is the belt to that pair of braces).
  if exists (
    select 1
      from public.student_email_verifications s
      join public.profiles pr on pr.id = s.user_id
     where s.email = p_email
       and s.consumed
       and s.user_id <> p_user
       and pr.deleted_at is null
  ) then
    return query select 'email_in_use'::text, null::text;
    return;
  end if;

  begin
    update public.student_email_verifications set consumed = true where id = v_id;
  exception when unique_violation then
    -- uniq_consumed_student_email got there first: another account holds this inbox.
    return query select 'email_in_use'::text, null::text;
    return;
  end;

  return query select 'ok'::text, v_domain;
end;
$$;

revoke execute on function public.claim_student_verification(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.claim_student_verification(uuid, text, text) to service_role;


-- ── The control: a grind in progress was invisible ──────────────────────────
-- The cap now bounds each attacker, and nothing said one was there. The badge is a
-- safety signal, so somebody working an inbox is worth a human look.
--
-- entity_id is a HASH of the address, not the address. The victim is not a user of this
-- platform and their school email does not need a second permanent home in
-- control_findings; the domain and the account ids doing the guessing are in the detail,
-- which is what an operator acts on.
create or replace function public.ctl_student_verify_bruteforce()
returns table (entity_id text, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select md5(lower(s.email)),
         jsonb_build_object(
           'kind', 'student_verify_bruteforce',
           'domain', max(s.domain),
           'attempts_24h', sum(s.attempts),
           'codes_issued', count(*),
           'accounts', array_agg(distinct s.user_id),
           'last_code_at', max(s.created_at),
           'note', 'someone is working through the 6-digit codes for one school inbox. '
                   'Each code is capped at 5 attempts and each inbox at 15 per 15 '
                   'minutes, so reaching this volume means deliberate grinding rather '
                   'than mistyping — and a hit grants the Verified Student badge for a '
                   'school the account does not attend, while locking the real owner of '
                   'the address out of verifying it.',
           'remedy', 'Look at the accounts listed. A single account trying one inbox it '
                     'does not own, or several accounts trying the same one, is abuse: '
                     'suspend them and leave the rows so the cap keeps applying.')
    from public.student_email_verifications s
   where s.created_at > now() - interval '24 hours'
   group by lower(s.email)
  having sum(s.attempts) >= 20
      or count(distinct s.user_id) >= 3
$$;

revoke execute on function public.ctl_student_verify_bruteforce() from public, anon, authenticated;

insert into public.controls (key, title, severity, domain, why, fn_name) values
  ('student_verify_bruteforce',
   'Someone is grinding the codes for one school inbox',
   'medium', 'integrity',
   'The Verified Student badge is a trust signal posters weigh before letting someone '
   'into their home, and it is gated by a 6-digit code mailed to an address the '
   'requester need not own. The per-code and per-inbox caps bound the guessing; nothing '
   'said it was happening. A hit both fakes a school and locks the address''s real owner '
   'out of ever verifying it.',
   'ctl_student_verify_bruteforce')
on conflict (key) do update set title = excluded.title, why = excluded.why,
  severity = excluded.severity, domain = excluded.domain, fn_name = excluded.fn_name;


-- ── Prove it discriminates, on a staged row, rolled back ────────────────────
do $$
declare
  uid uuid; probe_email text; vid uuid;
  st text; dom text; n int;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  select id into uid from public.profiles where deleted_at is null limit 1;
  if uid is null then raise exception 'no live profile to stage against'; end if;
  probe_email := 'probe-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12) || '@probe.edu';

  insert into public.student_email_verifications
    (user_id, email, domain, code_hash, expires_at, consumed)
  values (uid, probe_email, 'probe.edu', 'right-hash', now() + interval '15 minutes', false)
  returning id into vid;

  -- ── THE OLD SHAPE, on this very row ───────────────────────────────────────
  -- Two requests that both read attempts = 0 and both write `read + 1`. That is exactly
  -- what the edge function did, and it is why a burst was nearly free.
  update public.student_email_verifications set attempts = 0 + 1 where id = vid;
  update public.student_email_verifications set attempts = 0 + 1 where id = vid;
  select attempts into n from public.student_email_verifications where id = vid;
  if n <> 1 then
    raise exception 'expected the stale-read shape to leave attempts at 1 after two guesses, got %', n;
  end if;
  raise notice 'the old shape charged 1 attempt for 2 guesses — with N concurrent guesses it charged 1 for N';

  -- ── THE NEW SHAPE, same row ───────────────────────────────────────────────
  update public.student_email_verifications set attempts = 0 where id = vid;
  select status into st from public.claim_student_verification(uid, probe_email, 'wrong-hash');
  if st <> 'invalid_code' then raise exception 'a wrong code returned %', st; end if;
  select status into st from public.claim_student_verification(uid, probe_email, 'wrong-hash');
  if st <> 'invalid_code' then raise exception 'a wrong code returned %', st; end if;
  select attempts into n from public.student_email_verifications where id = vid;
  if n <> 2 then
    raise exception 'FIX FAILED: two guesses cost % attempt(s); the counter is still dodgeable', n;
  end if;
  raise notice 'every guess now costs an attempt — 2 guesses, 2 attempts';

  -- The cap holds, and it holds against a CORRECT code too: the attempt is spent before
  -- the comparison, so winning the race no longer buys a free check.
  update public.student_email_verifications set attempts = 5 where id = vid;
  select status into st from public.claim_student_verification(uid, probe_email, 'right-hash');
  if st <> 'too_many_attempts' then
    raise exception 'an exhausted row still evaluated a code (%)', st;
  end if;
  raise notice 'an exhausted code is refused even when the guess is right';

  -- Within the cap, the right code still works and returns the domain the badge is
  -- derived from.
  update public.student_email_verifications set attempts = 0 where id = vid;
  select status, domain into st, dom from public.claim_student_verification(uid, probe_email, 'right-hash');
  if st <> 'ok' then raise exception 'the correct code returned % — verification is broken', st; end if;
  if dom <> 'probe.edu' then raise exception 'the verified domain came back as %', dom; end if;
  if not exists (select 1 from public.student_email_verifications where id = vid and consumed) then
    raise exception 'a successful verification did not consume the code';
  end if;
  raise notice 'a correct code still verifies, is consumed, and reports the domain';

  -- Replay of a consumed code finds nothing pending, rather than verifying twice.
  select status into st from public.claim_student_verification(uid, probe_email, 'right-hash');
  if st <> 'no_pending' then raise exception 'a consumed code replayed as %', st; end if;
  raise notice 'a consumed code cannot be replayed';

  -- ── The per-inbox ceiling, across accounts ────────────────────────────────
  insert into public.student_email_verifications
    (user_id, email, domain, code_hash, expires_at, consumed, attempts)
  values (uid, probe_email, 'probe.edu', 'other-hash', now() + interval '15 minutes', false, 0);
  update public.student_email_verifications set attempts = 15 where id = vid;
  select status into st from public.claim_student_verification(uid, probe_email, 'other-hash');
  if st <> 'too_many_attempts' then
    raise exception 'a fresh code kept its own budget after 15 attempts on that inbox (%)', st;
  end if;
  raise notice 'a new code does not reset the inbox budget, so more accounts do not buy more guesses';

  -- ── The control sees the grind ────────────────────────────────────────────
  update public.student_email_verifications set attempts = 20 where id = vid;
  select count(*) into n from public.ctl_student_verify_bruteforce()
   where entity_id = md5(lower(probe_email));
  if n <> 1 then
    raise exception 'ctl_student_verify_bruteforce reported % rows for an inbox with 15+ attempts', n;
  end if;
  update public.student_email_verifications set attempts = 1 where email = probe_email;
  select count(*) into n from public.ctl_student_verify_bruteforce()
   where entity_id = md5(lower(probe_email));
  if n <> 0 then
    raise exception 'the control fires on ordinary mistyping — that would be permanent noise';
  end if;
  raise notice 'the control reports a grind and stays quiet on a couple of typos';

  if not exists (select 1 from public.controls
                  where key = 'student_verify_bruteforce' and enabled and not external) then
    raise exception 'not registered — run_all_controls would never call it';
  end if;

  raise exception 'probe complete — rolling back';
exception when others then
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'student-code brute-force probe passed; every staged row rolled back';
  else
    raise;
  end if;
end $$;
