-- ─────────────────────────────────────────────────────────────────────────────
-- Blocking and suspension stop the messages, and stop nothing else the counterparty
-- actually reads (2026-09-06).
--
-- 20260730150000 closed messaging to a suspended sender, and its own rationale is the
-- argument for this file: messaging is party-scoped, so "the people a suspended account
-- can still reach are precisely its existing booking counterparties: the person who most
-- likely just reported them." Two other writes reach that same person and were left open.
-- private.is_suspended and private.is_blocked_pair are referenced by exactly three
-- objects in the whole schema — jobs_select_all, the two booking-INSERT guards, and
-- messages_insert. Neither of the writes below is among them.
--
--   1. REVIEWS. reviews_insert_auth (20260624220000:186, still the newest definition)
--      asks only "is the writer a party to this verified booking, in this direction?".
--      The sole trigger on the table is the keyword filter (20260707000000:102). So a
--      blocked or suspended party posts review text onto the other person's PUBLIC
--      profile — and RUNBOOK_SAFETY §2.3 records that there is no way to redact a single
--      review, so it is permanent. reviews_one_per_party_per_job (20260624203000:21)
--      caps it at one row per direction per job, so this is not flooding: it is one
--      permanent public statement, published after the platform decided these two people
--      must not reach each other.
--
--   2. THE AMENDMENT NOTE. guard_bookings_write's poster branch pins application_note,
--      counter_offer, poster_rating, poster_review and started_at, but deliberately
--      leaves the poster authoring amendment_note (20260624230000:84 pins it in the
--      EARNER branch only — "poster authors the note") and permits amendment_status to
--      move to 'pending'. That note renders to the earner as a card in My Jobs
--      (EarnScreen.js:555-561) with a push behind it ("Change proposed" —
--      JobsContext.js:1265-1266). Free text, delivered, with a notification.
--
-- ── WHY THE FIX ALSO COVERS review_text / earner_rating / payment_method ────────
-- Closing the amendment note alone would move the same act one screen over. The poster
-- branch leaves three more poster-authored columns writable, and all three render to the
-- earner in the verified block of that same screen: the star row from earner_rating, the
-- quote from review_text, and the "Paid via …" line from payment_method
-- (EarnScreen.js:637-649). review_text is the private twin of the public review this
-- migration is closing, so leaving it open would be fixing the profile and not the inbox.
-- None of the three is gated on a status change, so any of them can be PATCHed on its own
-- onto a long-settled booking.
--
-- ── WHAT IS DELIBERATELY NOT CHANGED ────────────────────────────────────────────
-- * The poster keeps every LIFECYCLE power: decline, cancel, verify, capture, release.
--   Suspension must never strand a hold on someone else's card or withhold money already
--   earned. This closes a text channel, not a settlement path.
-- * The EARNER branch is untouched. Its only free-text column, poster_review, is pinned
--   against the poster and renders solely in ManageBookingsScreen, which nothing
--   navigates to (CLAUDE.md). The earner's real channel to the poster is the reviews
--   table, and the policy half below closes that for both sides.
-- * The earner may still answer a stale amendment: amendment_status is a two-value
--   consent response carrying no attacker-controlled content, and refusing it would
--   freeze a booking on the victim's side.
--
-- ── DIRECTION OF EACH CHECK ─────────────────────────────────────────────────────
-- BLOCKS are bidirectional, matching messages_insert. A one-way rule (refuse only the
-- blocked party) would turn blocking into a race: whoever blocks first keeps their own
-- review and permanently silences the other's, which hands a harasser a reason to block
-- their victim pre-emptively. Symmetry removes the prize.
-- SUSPENSION checks only the ACTOR, matching 20260730150000 — stopping the counterparty
-- from reviewing a just-suspended account would punish the wrong person, and that review
-- is exactly the signal the community wants. Suspension's own window is short (the admin
-- action bans the user and revokes refresh sessions; its success text says an in-flight
-- token lives "up to ~1h"), but a block has no window at all: it lasts until the user
-- removes it.
--
-- Pinned, never raised. A raise would tell a blocked poster they are blocked, and the
-- block is silent by design (20260710030000 goes out of its way to keep it so). Pinning
-- is this function's own idiom for every other unauthorized write.
--
-- guard_bookings_write is generated from 20260730140000 (the LATEST definition) by
-- scripted replacement and diffed: one block added at the end of the poster branch,
-- nothing removed. reviews_insert_auth is 20260624220000's policy with two clauses added
-- and the party/role condition preserved verbatim. Existing rows are untouched — both
-- fire on write. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. A blocked or suspended party cannot publish a review ──────────────────
drop policy if exists "reviews_insert_auth" on public.reviews;
create policy "reviews_insert_auth" on public.reviews for insert with check (
  auth.uid() = reviewer_id
  and exists (
    select 1 from public.bookings b
    join public.jobs j on j.id = b.job_id
    where b.status = 'verified'
      and b.job_id = reviews.job_id
      and (
        (j.poster_id = auth.uid() and b.earner_id = reviewed_user_id and role = 'earner')   -- poster rates the earner's work
        or (b.earner_id = auth.uid() and j.poster_id = reviewed_user_id and role = 'poster') -- earner rates the poster as a client
      )
      -- The two clauses this policy never had. Both helpers are SECURITY DEFINER and
      -- live in the non-exposed `private` schema: an inline subquery would be evaluated
      -- as the querying role and defeated by blocks-RLS / the profiles column lockdown,
      -- and a public one would be an RPC oracle over who has blocked whom and who is
      -- suspended.
      and not private.is_blocked_pair(b.earner_id, j.poster_id)
      and not private.is_suspended(auth.uid())
  )
);

-- ── 2. A blocked or suspended poster cannot push text onto the earner's screen ──
create or replace function public.guard_bookings_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  poster uuid;
begin
  if coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;

  -- SECURITY: on UPDATE resolve the authorizing poster from the STORED row.
  -- coalesce(new.job_id, ...) trusted a client-supplied job_id, letting an earner
  -- point job_id at a gig they posted and be routed into the poster branch.
  select poster_id into poster from public.jobs
   where id = (case when tg_op = 'INSERT' then new.job_id else old.job_id end);

  if tg_op = 'INSERT' then
    new.status      := 'pending';
    new.earner_done := false;
    new.poster_done := false;
    new.earner_rating := null;
    -- A booking that is being created cannot already be under way, already
    -- photographed, already tipped, already rated or already amended. The UPDATE
    -- branch below pins every one of these to old.*, i.e. treats them as
    -- server-owned — but INSERT left them to whatever the client sent.
    --
    -- started_at is the one that costs money. Two separate controls refuse to
    -- release a poster's escrow hold once it is set: trg_guard_started_booking_cancel
    -- (20260629190000:33) blocks the row transition to 'cancelled', and
    -- stripe-cancel-payment returns 409 "Work has already started". So an earner
    -- who stamps it at INSERT is accepted as pending, the poster accepts and the
    -- hold is placed, and from then on the poster CANNOT cancel or release it —
    -- their card stays authorized until Stripe expires it, and the only route left
    -- is a dispute, which has no adjudication path (KNOWN_RISKS 5.2).
    new.started_at        := null;
    new.tip_amount        := 0;
    new.completion_photos := '{}';
    new.before_photos     := '{}';
    new.cancellation_fee  := null;
    new.poster_rating     := null;
    new.poster_review     := null;
    new.amendment_status  := 'none';
    new.amendment_note    := null;
    if new.earner_id = poster then
      raise exception 'You cannot book your own gig';
    end if;
    if new.slot_id is not null and not exists (
      select 1 from public.job_slots s where s.id = new.slot_id and s.job_id = new.job_id
    ) then
      raise exception 'slot does not belong to this job';
    end if;
    -- starts_at is the poster-owned scheduled time of the booked slot — derive it
    -- server-side so the earner can't forge a past date to trip the ghosting gate.
    -- No slot => no authoritative scheduled time => null (auto-settle stays closed).
    if new.slot_id is not null then
      select s.starts_at into new.starts_at from public.job_slots s where s.id = new.slot_id;
    else
      new.starts_at := null;
    end if;
    return new;
  end if;

  if auth.uid() = poster then
    new.earner_id         := old.earner_id;
    new.job_id            := old.job_id;
    new.starts_at         := old.starts_at;  -- set only on INSERT from the slot
    if new.slot_id is distinct from old.slot_id and not (
      new.slot_id is null and old.slot_id is not null
      and not exists (select 1 from public.job_slots s where s.id = old.slot_id)
    ) then
      new.slot_id := old.slot_id;
    end if;
    new.earner_done       := old.earner_done;
    new.completion_photos := old.completion_photos;
    new.before_photos     := old.before_photos;
    new.started_at        := old.started_at;
    new.application_note  := old.application_note;
    new.counter_offer     := old.counter_offer;
    new.tip_amount        := old.tip_amount;
    -- The earner authors their rating/review OF THE POSTER — the poster can't forge it.
    new.poster_rating     := old.poster_rating;
    new.poster_review     := old.poster_review;
    if not (old.status = 'confirmed' and new.status = 'cancelled') then
      new.cancellation_fee := old.cancellation_fee;
    end if;
    if new.amendment_status is distinct from old.amendment_status
       and new.amendment_status not in ('pending', 'none') then
      new.amendment_status := old.amendment_status;
    end if;
    -- SAFETY: a suspended poster, or one on either side of a block, keeps every
    -- lifecycle power in this branch and loses only the ability to REACH the earner.
    -- Every column pinned here renders in the earner's My Jobs: the amendment note as
    -- a card with a push behind it (EarnScreen.js:555-561), and the stars, the review
    -- quote and the "Paid via …" line in the verified block (EarnScreen.js:637-649).
    -- Pinned rather than raised so the block stays silent. The helpers are consulted
    -- only when one of these columns actually moves, so an ordinary accept / cancel /
    -- verify write costs nothing extra.
    if (new.amendment_status is distinct from old.amendment_status
        or new.amendment_note is distinct from old.amendment_note
        or new.review_text    is distinct from old.review_text
        or new.earner_rating  is distinct from old.earner_rating
        or new.payment_method is distinct from old.payment_method)
       and (private.is_suspended(auth.uid())
            or private.is_blocked_pair(old.earner_id, poster)) then
      new.amendment_status := old.amendment_status;
      new.amendment_note   := old.amendment_note;
      new.review_text      := old.review_text;
      new.earner_rating    := old.earner_rating;
      new.payment_method   := old.payment_method;
    end if;
    if new.status is distinct from old.status and not (
         (old.status = 'pending'   and new.status in ('declined','cancelled'))
      or (old.status = 'confirmed' and new.status = 'cancelled')
      or (old.status = 'confirmed' and new.status = 'completed' and new.earner_done and new.poster_done)
      or (old.status = 'completed' and new.status = 'verified'
          and exists (select 1 from public.payments p
                      where p.booking_id = old.id and p.status = 'captured'))
    ) then
      new.status := old.status;
    end if;
    return new;
  end if;

  if auth.uid() = old.earner_id then
    new.job_id         := old.job_id;
    new.earner_id      := old.earner_id;
    new.starts_at      := old.starts_at;  -- set only on INSERT from the slot
    if new.slot_id is distinct from old.slot_id and not (
      new.slot_id is null and old.slot_id is not null
      and not exists (select 1 from public.job_slots s where s.id = old.slot_id)
    ) then
      new.slot_id := old.slot_id;
    end if;
    new.poster_done    := old.poster_done;
    new.earner_rating  := old.earner_rating;
    new.review_text    := old.review_text;
    new.payment_method := old.payment_method;
    new.counter_offer  := old.counter_offer;
    new.amendment_note := old.amendment_note;
    new.tip_amount     := old.tip_amount;
    new.application_note := old.application_note;
    new.cancellation_fee := old.cancellation_fee;
    if old.started_at is not null or old.status <> 'confirmed' then
      new.started_at := old.started_at;
    end if;
    if new.earner_done is distinct from old.earner_done
       and old.status not in ('confirmed', 'completed') then
      new.earner_done := old.earner_done;
    end if;
    if new.status is distinct from old.status
       and not (new.status = 'completed' and old.status = 'confirmed' and old.poster_done)
       and not (new.status = 'cancelled' and old.status in ('pending', 'confirmed')) then
      new.status := old.status;
    end if;
    return new;
  end if;

  -- SECURITY: deny by default. Previously this fell through as an UNPINNED
  -- `return new`, so a caller who matched neither branch could rewrite every
  -- column. Only the two parties may ever update a booking.
  raise exception 'not authorized to modify this booking';
end;
$$;

revoke execute on function public.guard_bookings_write() from public;

-- ── Prove it, as `authenticated` and not as the owner ────────────────────────
-- Both halves key off auth.uid(), and the owner bypasses RLS entirely, so a probe run as
-- postgres would prove nothing. Staging happens as the owner with service_role claims
-- (every guard early-returns for it); the role and the claims are switched for each
-- attempted write and switched back to read the result.
do $$
declare
  uid uuid; jid uuid; b_conf uuid; b_ver uuid;
  note text; rtext text; rating numeric; pm text; n int;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select id into uid from public.profiles where deleted_at is null limit 1;
  if uid is null then raise exception 'no live profile to stage against'; end if;

  insert into public.jobs (poster_id, title, category, pay, pay_type, location, description, status)
  values (uid, 'reach probe', 'Odd Jobs', 100, 'flat', 'Probe', 'probe', 'open')
  returning id into jid;

  -- One profile on both sides, as the other probes in this directory do: the guard and
  -- the policy each branch on auth.uid() matching a side, and both sides matching is the
  -- cheapest way to exercise the poster branch without minting an auth user. Two
  -- bookings because the amendment path is a live 'confirmed' gig and the review policy
  -- requires a 'verified' one on the same job.
  insert into public.bookings (job_id, earner_id, status) values (jid, uid, 'confirmed')
  returning id into b_conf;
  insert into public.bookings (job_id, earner_id, status) values (jid, uid, 'verified')
  returning id into b_ver;

  perform set_config('request.jwt.claims',
    json_build_object('sub', uid::text, 'role', 'authenticated')::text, true);

  -- (a) CLEAN: the ordinary amendment still lands. If this ever fails, the fix has
  --     become a blanket freeze and the product is broken for everyone.
  perform set_config('role', 'authenticated', true);
  update public.bookings
     set amendment_note = 'probe note A', amendment_status = 'pending'
   where id = b_conf;
  perform set_config('role', 'postgres', true);
  select amendment_note, amendment_status into note, rtext
    from public.bookings where id = b_conf;
  if note is distinct from 'probe note A' or rtext is distinct from 'pending' then
    raise exception 'staging wrong: a clean amendment did not land (note=%, status=%)', note, rtext;
  end if;
  raise notice 'clean: an ordinary amendment lands, so the normal flow is untouched';

  -- (b) BLOCKED: the same write, plus the three columns that render beside it.
  insert into public.blocks (blocker_id, blocked_id) values (uid, uid);
  perform set_config('role', 'authenticated', true);
  update public.bookings
     set amendment_note = 'probe note B — BLOCKED',
         review_text    = 'probe review — BLOCKED',
         earner_rating  = 1,
         payment_method = 'probe method — BLOCKED'
   where id = b_conf;
  perform set_config('role', 'postgres', true);
  select amendment_note, review_text, earner_rating, payment_method
    into note, rtext, rating, pm
    from public.bookings where id = b_conf;
  if note is distinct from 'probe note A' then
    raise exception 'FIX FAILED: a blocked poster wrote an amendment note (%)', note;
  end if;
  if rtext is not null or rating is not null or pm is not null then
    raise exception 'FIX FAILED: a blocked poster wrote review_text=% / earner_rating=% / payment_method=%',
      rtext, rating, pm;
  end if;
  raise notice 'discriminates: on the old guard the note would now read "probe note B — BLOCKED"; it still reads "probe note A", and the three verified-block columns are still null';

  -- (c) The review half under the same block. This is the write that lands on a PUBLIC
  --     profile and that RUNBOOK_SAFETY §2.3 says cannot be taken back.
  begin
    perform set_config('role', 'authenticated', true);
    insert into public.reviews (job_id, reviewer_id, reviewed_user_id, author, role, rating, text, date)
    values (jid, uid, uid, 'Poster', 'earner', 1, 'probe review while blocked', 'probe');
    perform set_config('role', 'postgres', true);
    raise exception 'FIX FAILED: a blocked party published a review';
  exception
    when insufficient_privilege then
      perform set_config('role', 'postgres', true);
      raise notice 'blocked party refused by reviews_insert_auth (42501) — the old policy had no clause that could refuse this';
    when others then
      perform set_config('role', 'postgres', true);
      raise;
  end;

  -- (d) SUSPENDED, with no block at all: the other half of each clause.
  delete from public.blocks where blocker_id = uid and blocked_id = uid;
  update public.profiles set suspended_at = now() where id = uid;
  begin
    perform set_config('role', 'authenticated', true);
    insert into public.reviews (job_id, reviewer_id, reviewed_user_id, author, role, rating, text, date)
    values (jid, uid, uid, 'Poster', 'earner', 1, 'probe review while suspended', 'probe');
    perform set_config('role', 'postgres', true);
    raise exception 'FIX FAILED: a suspended party published a review';
  exception
    when insufficient_privilege then
      perform set_config('role', 'postgres', true);
      raise notice 'suspended party refused by reviews_insert_auth (42501)';
    when others then
      perform set_config('role', 'postgres', true);
      raise;
  end;

  perform set_config('role', 'authenticated', true);
  update public.bookings set amendment_note = 'probe note C — SUSPENDED' where id = b_conf;
  perform set_config('role', 'postgres', true);
  select amendment_note into note from public.bookings where id = b_conf;
  if note is distinct from 'probe note A' then
    raise exception 'FIX FAILED: a suspended poster wrote an amendment note (%)', note;
  end if;
  raise notice 'a suspended poster cannot move the amendment note either';

  -- (e) NEITHER: both writes work again, so this is a condition and not a freeze.
  update public.profiles set suspended_at = null where id = uid;
  perform set_config('role', 'authenticated', true);
  update public.bookings set amendment_note = 'probe note D' where id = b_conf;
  insert into public.reviews (job_id, reviewer_id, reviewed_user_id, author, role, rating, text, date)
  values (jid, uid, uid, 'Poster', 'earner', 5, 'probe review, unimpeded', 'probe');
  perform set_config('role', 'postgres', true);
  select amendment_note into note from public.bookings where id = b_conf;
  select count(*) into n from public.reviews where job_id = jid;
  if note is distinct from 'probe note D' or n <> 1 then
    raise exception 'the fix is a blanket freeze, not a condition (note=%, reviews=%)', note, n;
  end if;
  raise notice 'with neither a block nor a suspension both writes land, so nothing legitimate was closed';

  raise exception 'probe complete — rolling back';
exception when others then
  -- The handler can be entered while the role is still `authenticated`, which cannot
  -- set it back; swallow that so the real error is what surfaces.
  begin
    perform set_config('role', 'postgres', true);
  exception when others then null;
  end;
  perform set_config('request.jwt.claims', '', true);
  if sqlerrm = 'probe complete — rolling back' then
    raise notice 'reach probe passed; all staged rows rolled back';
  else
    raise;
  end if;
end $$;
