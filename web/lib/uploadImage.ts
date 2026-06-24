import { supabase } from "./supabaseClient";

// Upload a browser File to a public Supabase Storage bucket; returns the public URL.
export async function uploadToBucket(file: File, bucket: string, userId: string): Promise<string> {
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
