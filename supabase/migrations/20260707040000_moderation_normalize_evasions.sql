-- ─────────────────────────────────────────────────────────────────────────────
-- Content-moderation: normalize common evasions before matching (2026-07-07).
--
-- Security audit finding (Low): contains_prohibited() (and its client twin
-- shared/contentFilter.js findProhibited) matched a fixed ASCII term list on a
-- whole-word boundary with NO normalization, so a single-character change defeated
-- it — leetspeak ('c0caine', 'n1gger', '0nlyfans', 'me7h') and punctuation-in-word
-- ('c.o.c.a.i.n.e', 'o-n-l-y-f-a-n-s') all slipped through both the client filter
-- AND this DB backstop. This re-creates contains_prohibited to normalize first:
--   1. strip in-word separators  . _ * -   (whitespace kept, so multi-word terms
--      like 'money laundering' still match on a word boundary)
--   2. fold leetspeak/homoglyph digits+symbols to letters (0→o 1→i 3→e 4→a 5→s
--      7→t 8→b @→a $→s)
-- then match with the SAME word-boundary regex as before. Word-boundary semantics
-- are preserved (e.g. 'escorted' still does NOT match 'escort').
--
-- KEPT IN LOCKSTEP with shared/contentFilter.js `normalizeForMatch` and the copy
-- in supabase/functions/assistant/index.ts — update all three together. Residual
-- (accepted, advisory filter backed by report/block + human review): pure-space
-- interleaving ('c o c a i n e') and cross-script unicode homoglyphs are not folded
-- here. Idempotent (create or replace); triggers already call this by name.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.contains_prohibited(txt text)
returns boolean
language plpgsql
immutable
set search_path = public
as $$
declare
  term  text;
  low   text := lower(coalesce(txt, ''));
  terms text[] := array[
    -- slurs / hate
    'nigger','faggot','retard','kike','spic','chink',
    -- explicit sexual solicitation
    'escort','prostitute','sexual favor','sexual favors','nudes','onlyfans',
    -- obvious illegal / scam
    'cocaine','meth','heroin','launder','money laundering','stolen goods'
  ];
begin
  if low = '' then
    return false;
  end if;
  -- Normalize evasions (in lockstep with the client normalizeForMatch).
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
