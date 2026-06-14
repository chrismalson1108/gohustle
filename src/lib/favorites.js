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
    .upsert({ user_id: userId, favorite_user_id: favoriteUserId }, { onConflict: 'user_id,favorite_user_id' });
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
