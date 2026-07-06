// DB-driven legal documents + acceptance audit trail.
// Docs live in the `legal_documents` table (latest row per slug = current). User
// acceptances are appended to `legal_acceptances` (one row per slug+version).
import { supabase } from './supabase';

export const SUPPORT_EMAIL = 'mainmail@gohustlr.com';
export const REQUIRED_SLUGS = ['terms', 'privacy', 'contractor'];

// Returns the current doc per slug: { [slug]: { slug, version, title, body } }
export async function fetchCurrentDocs() {
  const { data, error } = await supabase
    .from('legal_documents')
    .select('slug, version, title, body, published_at')
    .order('published_at', { ascending: false });
  if (error) throw error;
  const map = {};
  (data || []).forEach(d => { if (!map[d.slug]) map[d.slug] = d; }); // first = newest
  return map;
}

// Returns accepted versions per slug: { [slug]: Set<version> }
export async function fetchAcceptedVersions(userId) {
  const { data, error } = await supabase
    .from('legal_acceptances')
    .select('slug, version')
    .eq('user_id', userId);
  // Surface read failures so checkNeedsAcceptance fails CLOSED (treats "couldn't
  // determine" as "needs acceptance") instead of silently assuming accepted.
  if (error) throw error;
  const map = {};
  (data || []).forEach(a => {
    if (!map[a.slug]) map[a.slug] = new Set();
    map[a.slug].add(a.version);
  });
  return map;
}

// True if any required doc's current version hasn't been accepted by the user.
export function needsAcceptance(currentDocs, accepted) {
  return REQUIRED_SLUGS.some(slug => {
    const cur = currentDocs[slug];
    if (!cur) return false; // not configured → don't block
    const set = accepted[slug];
    return !set || !set.has(cur.version);
  });
}

// Append acceptance rows for the current version of each required doc.
export async function recordAcceptances(userId, currentDocs) {
  const rows = REQUIRED_SLUGS
    .filter(s => currentDocs[s])
    .map(s => ({ user_id: userId, slug: s, version: currentDocs[s].version }));
  if (!rows.length) return;
  // Idempotent: the (user_id, slug, version) unique index makes re-recording a
  // no-op (concurrent tab / re-run onboarding / retried accept) instead of piling
  // duplicate audit rows — and instead of a 23505 error now that the index exists.
  const { error } = await supabase
    .from('legal_acceptances')
    .upsert(rows, { onConflict: 'user_id,slug,version', ignoreDuplicates: true });
  if (error) throw error;
}

// Convenience: does this user need to (re)accept? Fails CLOSED — if we can't
// confirm acceptance of the current terms, treat it as "needs acceptance" and
// route to the consent screen rather than silently admitting past a legal gate.
export async function checkNeedsAcceptance(userId) {
  try {
    const [docs, accepted] = await Promise.all([fetchCurrentDocs(), fetchAcceptedVersions(userId)]);
    return needsAcceptance(docs, accepted);
  } catch {
    return true;
  }
}
