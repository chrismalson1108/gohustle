import { supabase } from './supabase';

// ─────────────────────────────────────────────────────────────────────────────
// What Hustlr AI has kept about you — and the ability to take it back.
//
// `profiles.assistant_memory` is a jsonb array of one-line facts the assistant's
// `remember` tool appends, capped at the 25 most recent. Every one of them is
// replayed into the system prompt of EVERY future conversation, so a wrong or
// unwanted line follows the user around until 25 newer ones push it out. Until
// this module there was no read and no delete anywhere in either client: the only
// way to remove a fact was to overflow the window.
//
// READ goes through my_profile(). SELECT on public.profiles is revoked from
// `authenticated` and re-granted column by column
// (20260624221000_profile_column_lockdown.sql), and assistant_memory is
// deliberately NOT in that allowlist — a direct .select('assistant_memory')
// returns a permission error, not a row. my_profile() is the SECURITY DEFINER
// owner self-read the app already uses for the other private columns.
//
// WRITE is a plain owner-scoped UPDATE, and that is checked rather than assumed:
// profiles_update_own is USING (auth.uid() = id), UPDATE on public.profiles is
// granted table-wide to `authenticated` (asserted by 20260812040000's own
// regression check), and guard_profiles_write — a DENYLIST — pins verified,
// ratings, earnings, suspension, created_at/member_since, date_of_birth and
// onboarding_done. assistant_memory is not among them, so its owner may rewrite
// it. No migration is needed for any of this.
//
// The update deliberately does NOT chain .select(): the column is unreadable
// through PostgREST, so asking for the row back would report a failure on a write
// that succeeded.
// ─────────────────────────────────────────────────────────────────────────────

async function readMemory() {
  const { data, error } = await supabase.rpc('my_profile');
  // Surface the failure. An empty list rendered on a failed read is the same
  // authoritative-empty-state bug the ledger screen already had to fix — here it
  // would tell someone nothing is stored about them when plenty is.
  if (error) throw new Error(error.message);
  const raw = data?.assistant_memory;
  if (!Array.isArray(raw)) return [];
  return raw.map((m) => String(m ?? '').trim()).filter(Boolean);
}

async function writeMemory(next) {
  // getSession() reads the locally-cached session rather than round-tripping to
  // the auth server — same reasoning as support.js. RLS is what actually scopes
  // the write; the id filter is so a missing session fails loudly here instead of
  // becoming an unfiltered PATCH that RLS silently narrows to nothing.
  const { data } = await supabase.auth.getSession();
  const uid = data?.session?.user?.id;
  if (!uid) throw new Error('You need to be signed in to change this.');

  const { error } = await supabase.from('profiles').update({ assistant_memory: next }).eq('id', uid);
  if (error) {
    // 42703 = column does not exist, i.e. the memory migration has not been
    // pushed. The assistant's own remember tool special-cases this too; saying
    // "undefined column" to a user looking at their own privacy screen does not.
    if (error.code === '42703') throw new Error("Memory isn't enabled on this account yet.");
    throw new Error(error.message);
  }
  return next;
}

export async function fetchMemories() {
  return readMemory();
}

// Delete by VALUE, off a FRESH read, not by the index the screen happened to
// render. The assistant can append a fact between the screen loading and the tap,
// which shifts every index after it — an index-based delete would then remove a
// line the user never chose, and write back a list missing the new one.
export async function forgetMemory(fact) {
  const target = String(fact ?? '');
  const current = await readMemory();
  // Every exact match, not just the first: `remember` de-dupes case-insensitively
  // today, but rows written before it did can still hold duplicates, and leaving
  // one behind reads as a delete that did not work.
  const next = current.filter((m) => m !== target);
  if (next.length === current.length) return current; // already gone — nothing to write
  return writeMemory(next);
}

export async function forgetAllMemories() {
  return writeMemory([]);
}
