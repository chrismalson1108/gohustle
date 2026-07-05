import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

// Job photos, completion photos, and avatars live in PUBLIC buckets and are stored
// as full public URLs — render them directly. Chat images live in the PRIVATE
// chat-photos bucket and are stored as a path (or a legacy full URL); the service
// role mints a short-lived signed URL so an admin can view flagged DM images.
export async function signChatImage(
  service: SupabaseClient,
  imageUrl: string | null | undefined,
): Promise<string | null> {
  if (!imageUrl) return null;
  let path = imageUrl;
  if (imageUrl.startsWith("http")) {
    const marker = "/chat-photos/";
    const i = imageUrl.indexOf(marker);
    if (i === -1) return imageUrl; // some other absolute URL — show as-is
    path = imageUrl.slice(i + marker.length).split("?")[0];
  }
  const { data } = await service.storage.from("chat-photos").createSignedUrl(path, 600);
  return data?.signedUrl ?? null;
}

// Best-effort: extract the object path from a public storage URL for a given
// bucket, so take-down can delete the file. Returns null if it isn't that bucket.
export function pathFromPublicUrl(url: string, bucket: string): string | null {
  const marker = `/${bucket}/`;
  const i = url.indexOf(marker);
  if (i === -1) return null;
  return url.slice(i + marker.length).split("?")[0] || null;
}
