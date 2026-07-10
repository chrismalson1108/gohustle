-- ─────────────────────────────────────────────────────────────────────────────
-- Content-moderation: expand the prohibited-term blocklist (2026-07-10).
--
-- Beta-audit finding H8 (prohibited-activity-policy-gap): the ~18-term wordlist let
-- academic/contract cheating, alcohol-to-minors, most drugs, weapons, and
-- off-platform-payment solicitation all pass. This re-creates contains_prohibited
-- with the expanded set. Normalization (strip in-word separators, fold
-- leet/homoglyphs) is unchanged from 20260707040000 — same word-boundary regex.
--
-- KEPT IN LOCKSTEP with shared/contentFilter.js `BLOCKED` and the copy in
-- supabase/functions/assistant/index.ts `BLOCKED_TERMS` — update all three together.
-- The Jest test __tests__/moderationSync.test.js reads the term array out of THIS
-- file and fails if the three copies drift. Idempotent (create or replace); the
-- guard_prohibited_content trigger already calls this function by name.
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
