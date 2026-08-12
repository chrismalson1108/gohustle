-- ─────────────────────────────────────────────────────────────────────────────
-- Disclose share-my-gig in the Terms and Privacy Policy (2026-08-06).
--
-- 20260806180000 shipped share links: an Earner working a gig can mint a link that
-- shows a third party of their choosing the gig's EXACT ADDRESS, both parties' first
-- names, and live status. That is the correct design — a worker's physical safety
-- outranks an address they are already standing at — but a Poster who lists a gig at
-- their home has not been told it can happen, and a safety feature that surprises the
-- person whose address it discloses is a feature that will be argued about later.
--
-- STILL DRAFTS, STILL NOT ATTORNEY-REVIEWED, unchanged from what 20260702020000 says
-- about the whole legal set.
--
-- TERMS: AMENDED IN PLACE, NOT RE-VERSIONED. Zero users have accepted 2026-08-06 (all
-- 11 acceptances on record are against 2026-07-02 and 2026-06-13), so editing it costs
-- nobody a second consent prompt. Minting 2026-08-06b instead would re-prompt the same
-- people twice for two edits made the same day, which is how a consent gate becomes
-- something users click through without reading.
--
-- PRIVACY: NEW VERSION, because the live one (2026-07-02) HAS been accepted and
-- rewriting an accepted document would falsify what those users agreed to.
--
-- Both edits are targeted replacements against the live bodies, and both RAISE if the
-- anchor text is missing — a silent no-op would publish a byte-identical document and
-- force a pointless re-consent.
-- ─────────────────────────────────────────────────────────────────────────────

do $$
declare
  t_body   text;
  t_new    text;
  p_body   text;
  p_new    text;
  p_title  text;
  t_anchor text := 'You are solely responsible for evaluating anyone you deal with and for your own safety. Meet in safe, public settings where appropriate and use your own judgment.';
  t_add    text := 'You are solely responsible for evaluating anyone you deal with and for your own safety. Meet in safe, public settings where appropriate and use your own judgment. To support that, an Earner working a Booking may create a temporary link that shows a person of their choosing — such as a friend or family member — the Gig''s address, both parties'' first names, the expected finish time, and whether the Earner has checked out. Posters should expect that a Gig''s address may be shared this way with someone the Earner trusts. The link expires automatically, can be switched off by the Earner at any time, and never discloses either party''s surname, contact details, or account.';
  p_anchor text := 'Precise location is optional; you can decline it or turn it off anytime in your device settings, and core features still work without it.';
  p_add    text := 'Precise location is optional; you can decline it or turn it off anytime in your device settings, and core features still work without it. Separately, an Earner working a Booking may create a temporary "share my gig" link so that someone they choose — typically a friend or family member — can see where they are working. Anyone holding that link can see the Gig''s address, both parties'' first names, the expected finish time, and the current status, without needing a GoHustlr account. The link expires automatically, the Earner can revoke it at any time, and it never discloses surnames, email addresses, phone numbers, profiles, or payment information. We provide this because knowing where someone is working is a meaningful safety protection for the person doing the work.';
begin
  -- ── Terms: amend 2026-08-06 in place ──────────────────────────────────────
  if exists (select 1 from public.legal_acceptances where slug = 'terms' and version = '2026-08-06') then
    raise exception 'terms 2026-08-06 has acceptances — amend by publishing a new version, not in place';
  end if;

  select body into t_body from public.legal_documents
   where slug = 'terms' and version = '2026-08-06';
  if t_body is null then raise exception 'terms 2026-08-06 not found'; end if;

  if position(t_anchor in t_body) = 0 then
    raise exception 'terms safety anchor not found — refusing to guess where this belongs';
  end if;
  t_new := replace(t_body, t_anchor, t_add);
  if t_new = t_body then raise exception 'terms replacement was a no-op'; end if;

  update public.legal_documents set body = t_new
   where slug = 'terms' and version = '2026-08-06';
  raise notice 'terms 2026-08-06 amended in place (% -> % chars)', length(t_body), length(t_new);

  -- ── Privacy: new version ──────────────────────────────────────────────────
  if exists (select 1 from public.legal_documents where slug = 'privacy' and version = '2026-08-06') then
    raise notice 'privacy 2026-08-06 already present; skipping';
    return;
  end if;

  select body, title into p_body, p_title from public.legal_documents
   where slug = 'privacy' order by published_at desc limit 1;
  if p_body is null then raise exception 'no privacy document to derive from'; end if;

  if position(p_anchor in p_body) = 0 then
    raise exception 'privacy location anchor not found — refusing to guess where this belongs';
  end if;
  p_new := replace(p_body, p_anchor, p_add);
  if p_new = p_body then raise exception 'privacy replacement was a no-op'; end if;

  insert into public.legal_documents (slug, version, title, body, published_at)
  values ('privacy', '2026-08-06', p_title, p_new, now());
  raise notice 'published privacy 2026-08-06 (% -> % chars)', length(p_body), length(p_new);
end $$;
