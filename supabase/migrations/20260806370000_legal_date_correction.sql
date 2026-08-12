-- ─────────────────────────────────────────────────────────────────────────────
-- Two published documents misstate their own effective date.
--
-- ctl_legal_doc_self_contradiction found it, and it is mine: 20260806190000 derived the
-- August privacy and terms bodies from the July ones and rewrote only the paragraph that
-- changed. The "Last updated: July 2, 2026" line came along for the ride. So the current
-- Terms and Privacy are filed as version 2026-08-06 and tell the reader July 2 — a date
-- BEFORE the share-my-gig disclosure they contain.
--
-- ── WHY A NEW VERSION AND NOT AN EDIT ───────────────────────────────────────
--
-- Three users have accepted each of the 2026-08-06 documents. Editing an accepted body
-- rewrites what those people agreed to, which is the one thing a consent record exists
-- to prevent — and it is exactly the reasoning 20260806190000 used when it published a
-- NEW privacy version rather than touching the accepted July one. The same rule applies
-- to me now that the accepted document is my own.
--
-- This re-prompts those three for consent. That cost is real and it is the correct one:
-- the alternative is a legal document whose own date contradicts its contents, which is
-- a bad thing to rely on if a poster ever argues they were not told their address could
-- be shared.
--
-- ── WHAT CHANGES ────────────────────────────────────────────────────────────
--
-- ONLY the date line. The bodies are copied verbatim from the current versions, share
-- disclosure and all, so nobody is being asked to agree to new terms — only to a
-- document that states honestly when it took effect. Both replacements RAISE if the
-- anchor is missing rather than silently publishing an identical body and charging
-- everyone a pointless re-consent.
-- ─────────────────────────────────────────────────────────────────────────────

do $$
declare
  v_new   text := '2026-08-12';
  stamp   text := 'Last updated: August 12, 2026';
  r       record;
  new_body text;
  n_fixed  int := 0;
begin
  for r in
    select distinct on (slug) slug, version, title, body
      from public.legal_documents
     where slug in ('terms', 'privacy')
     order by slug, published_at desc
  loop
    if exists (select 1 from public.legal_documents
                where slug = r.slug and version = v_new) then
      raise notice '% % already published; skipping', r.slug, v_new;
      continue;
    end if;

    if position('Last updated: ' in r.body) = 0 then
      raise exception '% has no "Last updated:" line — refusing to guess', r.slug;
    end if;

    -- Replace only the stamp; everything else is carried across byte for byte.
    new_body := regexp_replace(r.body, 'Last updated: [A-Za-z]+ [0-9]+, [0-9]+', stamp);
    if new_body = r.body then
      raise notice '% already stamped correctly; skipping', r.slug;
      continue;
    end if;

    insert into public.legal_documents (slug, version, title, body, published_at)
    values (r.slug, v_new, r.title, new_body, now());
    n_fixed := n_fixed + 1;
    raise notice 'published % % (was %, stamped %)', r.slug, v_new, r.version, stamp;
  end loop;

  raise notice 'corrected % document(s)', n_fixed;
end $$;
