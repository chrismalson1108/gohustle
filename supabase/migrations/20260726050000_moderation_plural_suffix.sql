-- ─────────────────────────────────────────────────────────────────────────────
-- SECURITY (MEDIUM, moderation bypass): plurals defeated the blocklist (2026-07-26).
--
-- The matcher wrapped each term as (^|[^a-z])term([^a-z]|$). The trailing boundary
-- requires a NON-letter after the term, so any inflection walked straight through
-- while the singular was blocked. Verified against the shipped client filter:
--
--     'escort'      -> BLOCKED        'escorts'      -> BYPASS
--     'prostitute'  -> BLOCKED        'prostitutes'  -> BYPASS
--     'handgun'     -> BLOCKED        'handguns'     -> BYPASS
--
-- Since all three copies of the matcher share this shape, the bypass applied on every
-- moderated surface at once — client filter, assistant tools, and this DB backstop —
-- and plural phrasing is the natural way to write most of these terms in a listing.
--
-- Fix: allow an optional plural suffix, (e?s)?. Deliberately narrow rather than a
-- general suffix wildcard: allowing arbitrary continuations would match 'meth' inside
-- 'method' and 'methodology'. Confirmed no false positives against method,
-- methodology, assistant, classes, password, address, processing, escorted.
--
-- The term array below is copied VERBATIM from 20260715060000 (generated from that
-- file rather than retyped, so it cannot drift); only the boundary regex and its
-- comment change. The three copies stay in lockstep — __tests__/moderationSync.test.js
-- enforces the term lists, and all three matchers now carry the same suffix rule.
-- Idempotent.
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
    -- (^|[^a-z])term(e?s)?([^a-z]|$) — same word boundary as the client filter,
    -- including the plural suffix (see banner). Terms are lowercase letters +
    -- spaces only, so no regex-escaping is needed.
    if low ~ ('(^|[^a-z])' || term || '(e?s)?([^a-z]|$)') then
      return true;
    end if;
  end loop;
  return false;
end;
$$;
-- Trigger + grants unchanged (guard_prohibited_content already calls this by name;
-- execute stays revoked from public/anon/authenticated via the original migration).
revoke execute on function public.contains_prohibited(text) from public, anon, authenticated;
