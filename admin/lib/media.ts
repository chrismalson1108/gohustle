import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

// Job photos and avatars live in PUBLIC buckets and are stored as full public URLs
// — render them directly. Chat images (chat-photos) AND completion/before photos
// (completion-photos) live in PRIVATE buckets; the service role mints short-lived
// signed URLs so an admin can review flagged DM content and proof-of-work photos.
//
// SECURITY: messages.image_url is free text the sender controls. The DB write-guard
// (chat_photo_path_guard) validates the tail after the LAST "/chat-photos/" starts
// with the sender's folder. We must extract the SAME path (lastIndexOf, not
// indexOf) AND re-verify it lives under senderId/ before signing — otherwise a
// crafted URL with two "/chat-photos/" segments could make the service role
// (which bypasses RLS) sign another user's private object.
export async function signChatImage(
  service: SupabaseClient,
  imageUrl: string | null | undefined,
  senderId: string,
): Promise<string | null> {
  if (!imageUrl) return null;
  let path = imageUrl;
  if (imageUrl.startsWith("http")) {
    const marker = "/chat-photos/";
    const i = imageUrl.lastIndexOf(marker);
    if (i === -1) return null; // absolute URL that isn't a chat-photos object — refuse
    path = imageUrl.slice(i + marker.length).split("?")[0];
  }
  // Only ever sign an object under the message sender's own folder.
  if (!path.startsWith(`${senderId}/`) || path.includes("..")) return null;
  const { data } = await service.storage.from("chat-photos").createSignedUrl(path, 600);
  return data?.signedUrl ?? null;
}

// Sign a completion/before photo (private completion-photos bucket) so an admin can
// review proof-of-work evidence for a dispute. Handles both a bare object path
// ("<earnerId>/<file>", new rows) and a legacy full public URL. The service role
// bypasses RLS, so this signs whatever object the booking references; the value
// comes from the booking's own completion_photos/before_photos arrays (written only
// via the guarded upload path), and we reject traversal.
export async function signCompletionPhoto(
  service: SupabaseClient,
  stored: string | null | undefined,
): Promise<string | null> {
  if (!stored) return null;
  let path = stored;
  if (stored.startsWith("http")) {
    const marker = "/completion-photos/";
    const i = stored.lastIndexOf(marker);
    if (i === -1) return null; // absolute URL that isn't a completion-photos object
    path = stored.slice(i + marker.length).split("?")[0];
  }
  if (!path || path.includes("..")) return null;
  const { data } = await service.storage.from("completion-photos").createSignedUrl(path, 600);
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
