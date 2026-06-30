// Trade-school certifications / credentials shown on profiles. Public read;
// owner-only writes. Mirrors src/lib/certifications.js.
import { supabase } from "./supabaseClient";
import { uploadToBucket } from "./uploadImage";
import { findProhibited } from "@gohustlr/shared";

export interface Certification {
  id: string;
  user_id: string;
  title: string;
  issuer: string | null;
  year: number | null;
  image_url: string | null;
  created_at: string;
}

export interface AddCertificationInput {
  userId: string;
  title: string;
  issuer?: string | null;
  year?: number | null;
  file?: File | null;
}

export async function fetchCertifications(userId: string): Promise<Certification[]> {
  const { data } = await supabase
    .from("certifications")
    .select("id, user_id, title, issuer, year, image_url, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  return (data || []) as Certification[];
}

export async function addCertification({
  userId,
  title,
  issuer = null,
  year = null,
  file = null,
}: AddCertificationInput): Promise<Certification> {
  // These render on the public profile, so apply the same content filter the rest of
  // the app uses for user-visible free text.
  if (findProhibited(`${title || ""} ${issuer || ""}`)) {
    throw new Error("That text isn't allowed — please edit the title or issuer.");
  }
  let image_url: string | null = null;
  if (file) image_url = await uploadToBucket(file, "certificates", userId);

  const { data, error } = await supabase
    .from("certifications")
    .insert({ user_id: userId, title, issuer: issuer || null, year: year ?? null, image_url })
    .select("id, user_id, title, issuer, year, image_url, created_at")
    .single();
  if (error) throw error;
  return data as Certification;
}

export async function deleteCertification(id: string): Promise<void> {
  const { error } = await supabase.from("certifications").delete().eq("id", id);
  if (error) throw error;
}
