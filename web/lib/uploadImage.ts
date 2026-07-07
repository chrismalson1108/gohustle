import { supabase } from "./supabaseClient";

// Only raster image types may be uploaded. Defense-in-depth that fails fast on the
// client and mirrors the storage-bucket allowed_mime_types allowlist (the DB-level
// list is the authoritative guard — a direct Storage API call bypasses this check).
// Blocks image/svg+xml and text/html, which execute on the storage origin.
const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg", "image/jpg", "image/png", "image/webp", "image/heic", "image/heif", "image/gif",
]);
function assertSafeImageType(file: File): void {
  // Some pickers report an empty type (e.g. HEIC on desktop); allow those (they
  // upload as image/jpeg). Reject only an explicitly non-image / dangerous type.
  if (file.type && !ALLOWED_IMAGE_TYPES.has(file.type.toLowerCase())) {
    throw new Error("Only image files (JPG, PNG, WEBP, HEIC, GIF) can be uploaded.");
  }
}

// Upload a browser File to a public Supabase Storage bucket; returns the public URL.
export async function uploadToBucket(file: File, bucket: string, userId: string): Promise<string> {
  assertSafeImageType(file);
  const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
  const rand = Math.random().toString(36).slice(2, 8);
  const path = `${userId}/${Date.now()}-${rand}.${ext}`;
  const { error } = await supabase.storage.from(bucket).upload(path, file, {
    upsert: false,
    contentType: file.type || "image/jpeg",
  });
  if (error) throw error;
  return supabase.storage.from(bucket).getPublicUrl(path).data.publicUrl;
}

export async function uploadImages(files: File[], bucket: string, userId: string): Promise<string[]> {
  const urls: string[] = [];
  for (const f of files) urls.push(await uploadToBucket(f, bucket, userId));
  return urls;
}

// Upload several files to a PRIVATE bucket; returns the object PATHS (render via
// getSignedUrl). Used for completion/before proof-of-work photos.
export async function uploadPrivateImages(files: File[], bucket: string, userId: string): Promise<string[]> {
  const paths: string[] = [];
  for (const f of files) paths.push(await uploadPrivateToBucket(f, bucket, userId));
  return paths;
}

// Upload to a PRIVATE bucket and return the object PATH (not a URL). Render via
// getSignedUrl(). Used for chat images (party-scoped) so DM photos aren't
// world-readable.
export async function uploadPrivateToBucket(file: File, bucket: string, userId: string): Promise<string> {
  assertSafeImageType(file);
  const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
  const rand = Math.random().toString(36).slice(2, 8);
  const path = `${userId}/${Date.now()}-${rand}.${ext}`;
  const { error } = await supabase.storage.from(bucket).upload(path, file, {
    upsert: false,
    contentType: file.type || "image/jpeg",
  });
  if (error) throw error;
  return path;
}

// A chat image_url is either a bare object path ("<uid>/<file>", new rows) or a
// legacy full public URL ending in "/chat-photos/<uid>/<file>". Return the path.
export function chatObjectPath(stored: string | null | undefined): string | null {
  if (!stored) return null;
  const marker = "/chat-photos/";
  const i = stored.indexOf(marker);
  return i >= 0 ? stored.slice(i + marker.length) : stored;
}

// Same idea for any private bucket: new rows store a bare "<uid>/<file>" path,
// legacy rows a full public URL "…/<bucket>/<uid>/<file>". Return the object path.
export function objectPath(stored: string | null | undefined, bucket: string): string | null {
  if (!stored) return null;
  const marker = `/${bucket}/`;
  const i = stored.indexOf(marker);
  return i >= 0 ? stored.slice(i + marker.length) : stored;
}

// Short-lived signed URL for a private object path (RLS decides who may sign).
export async function getSignedUrl(bucket: string, path: string, expiresIn = 3600): Promise<string | null> {
  if (!path) return null;
  const { data } = await supabase.storage.from(bucket).createSignedUrl(path, expiresIn);
  return data?.signedUrl || null;
}
