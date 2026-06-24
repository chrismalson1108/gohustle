// Saved-people helpers. Port of src/lib/favorites.js.
import { supabase } from "./supabaseClient";

export interface FavProfile {
  id: string;
  name: string;
  avatar_initial: string;
  avatar_url: string | null;
  rating: number;
  review_count: number;
  city: string | null;
}

export async function fetchFavoriteIds(userId: string): Promise<Set<string>> {
  const { data } = await supabase.from("favorites").select("favorite_user_id").eq("user_id", userId);
  return new Set((data || []).map((r) => r.favorite_user_id));
}

export async function isFavorite(userId: string, favoriteUserId: string): Promise<boolean> {
  const { data } = await supabase
    .from("favorites")
    .select("favorite_user_id")
    .eq("user_id", userId)
    .eq("favorite_user_id", favoriteUserId)
    .maybeSingle();
  return !!data;
}

export async function addFavorite(userId: string, favoriteUserId: string): Promise<void> {
  const { error } = await supabase
    .from("favorites")
    .upsert({ user_id: userId, favorite_user_id: favoriteUserId }, { onConflict: "user_id,favorite_user_id" });
  if (error) throw error;
}

export async function removeFavorite(userId: string, favoriteUserId: string): Promise<void> {
  const { error } = await supabase.from("favorites").delete().eq("user_id", userId).eq("favorite_user_id", favoriteUserId);
  if (error) throw error;
}

export async function fetchFavorites(userId: string): Promise<FavProfile[]> {
  const { data } = await supabase
    .from("favorites")
    .select("favorite_user_id, created_at, profile:profiles!favorite_user_id(id, name, avatar_initial, avatar_url, rating, review_count, city)")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  return ((data || []).map((r) => r.profile).filter(Boolean) as unknown) as FavProfile[];
}
