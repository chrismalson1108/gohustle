-- ─────────────────────────────────────────────────────────────────────────────
-- Terms v2026-08-06: take the hard-coded rate out of the fee clause (2026-08-06).
--
-- STILL A DRAFT, STILL NOT ATTORNEY-REVIEWED. 20260702020000 says the legal set is
-- "plain-language drafts for beta"; that remains true and this does not change it.
-- The owner approved publishing this specifically as a reference for counsel.
--
-- WHY THIS HAS TO HAPPEN BEFORE THE RATE EVER MOVES
--
-- Section 7 read "(currently 10% of the Gig amount)". Publishing a new legal_documents
-- version re-prompts EVERY user for consent (AuthContext -> checkNeedsAcceptance ->
-- ConsentScreen), so with that parenthetical in place, changing the take rate would
-- have meant a forced re-consent for the entire user base every time. That is the
-- expensive ordering mistake: it is nearly free today at 9 users with 34 acceptances
-- on record, and it gets worse every week the beta grows.
--
-- The rest of the clause was already right — it committed to disclosure before
-- confirmation and to prospective-only changes. Only the number had to go.
--
-- Three substantive edits:
--   1. The rate is removed, so future rate changes need no new Terms version.
--   2. It now states the fee is deducted from the EARNER'S payout. This was only
--      implied (Section 6 says "minus our service fee" in the payout context) and it
--      is material to the person actually paying it.
--   3. It states the fee is fixed when the Booking is made — which as of
--      20260806050000 is literally true: bookings.fee_bps_quoted is stamped at INSERT
--      and capture derives from it, so the Terms now describe the enforced behaviour
--      rather than an intention.
--
-- Derived from the live v2026-07-02 row by targeted replacement rather than pasting a
-- fresh 9KB body, so the diff is auditable and no other clause can drift by accident.
-- The DO block RAISES if the expected text is not found: a silent no-op replace would
-- publish a byte-identical document and force a pointless re-consent on every user.
-- ─────────────────────────────────────────────────────────────────────────────

do $$
declare
  src_body  text;
  new_body  text;
  old_claus text := '7. Service fee. GoHustlr charges a service fee on payments processed through the platform (currently 10% of the Gig amount). The fee and the amount you will pay or receive are disclosed before you confirm. Fees may change prospectively with notice.';
  new_claus text := '7. Service fee. GoHustlr charges a service fee on payments processed through the platform. The fee is deducted from the Earner''s payout, and both the fee and the amount you will pay or receive are disclosed before you confirm. The fee that applies to a Booking is fixed when the Booking is made and does not change afterwards. Fees may change prospectively with notice, and we may from time to time offer reduced or waived fees under a promotion, subject to that promotion''s terms.';
  src_title text;
begin
  -- Already published? Do nothing — re-running a migration must not mint a second
  -- version and re-prompt everyone again.
  if exists (select 1 from public.legal_documents where slug = 'terms' and version = '2026-08-06') then
    raise notice 'terms v2026-08-06 already present; skipping';
    return;
  end if;

  select body, title into src_body, src_title
    from public.legal_documents
   where slug = 'terms'
   order by published_at desc
   limit 1;

  if src_body is null then
    raise exception 'no terms document to derive from';
  end if;

  if position(old_claus in src_body) = 0 then
    raise exception 'the expected Section 7 text was not found in the current terms — '
      'refusing to publish a version whose only effect would be a forced re-consent';
  end if;

  new_body := replace(src_body, old_claus, new_claus);

  if new_body = src_body then
    raise exception 'replacement produced an identical body; refusing to publish';
  end if;

  insert into public.legal_documents (slug, version, title, body, published_at)
  values ('terms', '2026-08-06', src_title, new_body, now());

  raise notice 'published terms v2026-08-06 (% -> % chars)', length(src_body), length(new_body);
end $$;
