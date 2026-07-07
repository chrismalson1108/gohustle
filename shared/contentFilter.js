// Lightweight client-side content guard for user-generated text (gig posts,
// chat). This is a first line of defense, not a replacement for server-side
// moderation + the report/block system. Matches whole words, case-insensitive.
const BLOCKED = [
  // slurs / hate (kept short here; expand server-side)
  'nigger', 'faggot', 'retard', 'kike', 'spic', 'chink',
  // explicit sexual solicitation
  'escort', 'prostitute', 'sexual favor', 'sexual favors', 'nudes', 'onlyfans',
  // obvious illegal / scam
  'cocaine', 'meth', 'heroin', 'launder', 'money laundering', 'stolen goods',
];

// Normalize common evasions before whole-word matching. KEPT IN LOCKSTEP with the
// DB backstop public.contains_prohibited (supabase migration
// 20260707040000_moderation_normalize_evasions.sql) and the copy in
// supabase/functions/assistant/index.ts — update all three together.
//   1. NFKC-fold + lowercase
//   2. strip zero-width chars and in-word separators  . _ * -   (whitespace is
//      kept, so multi-word terms like "money laundering" still match on a boundary)
//   3. fold leetspeak/homoglyph digits+symbols to letters
// Word-boundary semantics are preserved (e.g. "escorted" still does NOT match
// "escort"). Residual (accepted — advisory filter, backed by report/block + human
// review): pure-space interleaving ("c o c a i n e") and cross-script homoglyphs.
const LEET_MAP = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '@': 'a', '$': 's' };
function normalizeForMatch(text) {
  let s = String(text).normalize('NFKC').toLowerCase();
  s = s.replace(/[​‌‍﻿]/g, ''); // zero-width chars
  s = s.replace(/[._*-]/g, '');                   // in-word separators (keep spaces)
  s = s.replace(/[0134578@$]/g, (c) => LEET_MAP[c]);
  return s;
}

// Returns the first prohibited term found, or null if the text is clean.
export function findProhibited(text) {
  if (!text) return null;
  const norm = normalizeForMatch(text);
  for (const term of BLOCKED) {
    const re = new RegExp(`(^|[^a-z])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`, 'i');
    if (re.test(norm)) return term;
  }
  return null;
}

export function isClean(...texts) {
  return texts.every(t => !findProhibited(t));
}
