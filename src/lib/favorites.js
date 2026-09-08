import { supabase } from './supabase';

export async function fetchFavoriteIds(userId) {
  const { data } = await supabase.from('favorites').select('favorite_user_id').eq('user_id', userId);
  return new Set((data || []).map(r => r.favorite_user_id));
}

export async function isFavorite(userId, favoriteUserId) {
  const { data } = await supabase
    .from('favorites').select('favorite_user_id')
    .eq('user_id', userId).eq('favorite_user_id', favoriteUserId).maybeSingle();
  return !!data;
}

export async function addFavorite(userId, favoriteUserId) {
  const { error } = await supabase
    .from('favorites')
  // ignoreDuplicates IS LOAD-BEARING. Without it supabase-js sends ON CONFLICT DO
  // UPDATE, which needs an UPDATE grant `20260812040000_grant_rls_parity.sql` revoked
  // from `authenticated` on this table — so the write was refused `42501 permission
  // denied` on both clients. Re-blocking somebody must be a no-op, not a rewrite, so
  // DO NOTHING is also the correct semantics. See src/lib/referrals.js for the long note.
    .upsert({ user_id: userId, favorite_user_id: favoriteUserId },
            { onConflict: 'user_id,favorite_user_id', ignoreDuplicates: true });
  if (error) throw error;
}

export async function removeFavorite(userId, favoriteUserId) {
  const { error } = await supabase
    .from('favorites').delete().eq('user_id', userId).eq('favorite_user_id', favoriteUserId);
  if (error) throw error;
}

// Favorited people with their profile info for the Favorites list.
export async function fetchFavorites(userId) {
  const { data } = await supabase
    .from('favorites')
    .select('favorite_user_id, created_at, profile:profiles!favorite_user_id(id, name, avatar_initial, avatar_url, rating, review_count, city)')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  return (data || []).map(r => r.profile).filter(Boolean);
}
