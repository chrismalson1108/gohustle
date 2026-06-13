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

// Returns the first prohibited term found, or null if the text is clean.
export function findProhibited(text) {
  if (!text) return null;
  const lower = String(text).toLowerCase();
  for (const term of BLOCKED) {
    const re = new RegExp(`(^|[^a-z])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`, 'i');
    if (re.test(lower)) return term;
  }
  return null;
}

export function isClean(...texts) {
  return texts.every(t => !findProhibited(t));
}
