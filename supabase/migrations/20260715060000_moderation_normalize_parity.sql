-- ─────────────────────────────────────────────────────────────────────────────
-- Content-moderation: bring the DB backstop normalization into lockstep with the
-- client / assistant copies (2026-07-15).
--
-- shared/contentFilter.js normalizeForMatch does: NFKC-fold + lowercase, strip
-- zero-width chars AND in-word separators, fold leet digits. The assistant copy
-- matches. The live DB contains_prohibited (20260710060000) only did lower() +
-- translate(separators) + translate(leet) — it dropped the NFKC fold and the
-- zero-width strip. Because the DB trigger is the ONLY moderation layer on the
-- direct-PostgREST path (the client filter and moderate-text are client-invoked and
-- moderate-text fails open), a term interleaved with U+200B or written fullwidth
-- passed the server backstop while the weaker client filter would have caught it —
-- an inverted defense-in-depth ordering.
--
-- This recreates contains_prohibited to normalize identically:
--   1. NFKC-fold + lowercase           (fullwidth / compatibility forms → ASCII)
--   2. strip zero-width chars          (U+200B U+200C U+200D U+FEFF)
--   3. strip in-word separators . _ * -
--   4. fold leet/homoglyph digits+symbols → letters
-- then match with the SAME word-boundary regex. The term array is copied VERBATIM
-- from 20260710060000_moderation_expand_terms.sql (still the lockstep source of truth
-- read by __tests__/moderationSync.test.js). Idempotent (create or replace); the
-- guard_prohibited_content trigger already calls this by name.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.contains_prohibited(txt text)
returns boolean
language plpgsql
immutable
set search_path = public
as $$
declare
  term  text;
  -- NFKC-fold + lowercase, matching the client's String(text).normalize('NFKC').toLowerCase().
  low   text := lower(normalize(coalesce(txt, ''), NFKC));
  terms text[] := array[
    -- slurs / hate
    'nigger','faggot','retard','kike','spic','chink',
    -- explicit sexual solicitation
    'escort','prostitute','sexual favor','sexual favors','nudes','onlyfans',
    -- obvious illegal / scam
    'cocaine','meth','heroin','launder','money laundering','stolen goods',
    -- controlled / illegal drugs
    'marijuana','cannabis','adderall','xanax','mdma','lsd','ecstasy',
    'ketamine','fentanyl','percocet','oxycodone','psilocybin','shrooms',
    -- weapons
    'handgun','firearm','firearms','ammunition','silencer','ghost gun','assault rifle',
    -- alcohol to minors / fraudulent identification
    'fake id','fake ids','buy me alcohol','buy me beer','buy alcohol for',
    -- academic / contract cheating
    'write my essay','write my paper','do my homework','do my assignment',
    'take my exam','take my test','take my quiz','exam answers',
    -- off-platform payment (escrow circumvention)
    'venmo','cashapp','cash app','zelle','paypal'
  ];
begin
  if low = '' then
    return false;
  end if;
  -- Normalize evasions (in lockstep with the client normalizeForMatch).
  -- Strip zero-width chars U+200B U+200C U+200D U+FEFF (translate removes chars in
  -- `from` that have no counterpart in the empty `to`).
  low := translate(low, chr(8203) || chr(8204) || chr(8205) || chr(65279), '');
  low := translate(low, '._*-', '');            -- strip in-word separators (keep spaces)
  low := translate(low, '0134578@$', 'oieastbas'); -- leet/homoglyph -> letters
  foreach term in array terms loop
    -- (^|[^a-z])term([^a-z]|$) — same word boundary as the client filter. Terms are
    -- lowercase letters + spaces only, so no regex-escaping is needed.
    if low ~ ('(^|[^a-z])' || term || '([^a-z]|$)') then
      return true;
    end if;
  end loop;
  return false;
end;
$$;

-- Trigger + grants unchanged (guard_prohibited_content already calls this by name;
-- execute stays revoked from public/anon/authenticated via the original migration).
