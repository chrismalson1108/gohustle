// Trade-school certifications / credentials shown on profiles. Public read;
// owner-only writes. Mirrors web/lib/certifications.ts.
import { supabase } from './supabase';
import { uploadImage } from './uploadImage';
import { findProhibited } from './contentFilter';

export async function fetchCertifications(userId) {
  const { data } = await supabase
    .from('certifications')
    .select('id, user_id, title, issuer, year, image_url, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  return data || [];
}

export async function addCertification({ userId, title, issuer = null, year = null, imageUri = null }) {
  // These render on the public profile, so apply the same content filter the rest of
  // the app uses for user-visible free text.
  if (findProhibited(`${title || ''} ${issuer || ''}`)) {
    throw new Error("That text isn't allowed — please edit the title or issuer.");
  }
  let image_url = null;
  if (imageUri) image_url = await uploadImage({ uri: imageUri, bucket: 'certificates', userId });

  const { data, error } = await supabase
    .from('certifications')
    .insert({ user_id: userId, title, issuer: issuer || null, year: year ?? null, image_url })
    .select('id, user_id, title, issuer, year, image_url, created_at')
    .single();
  if (error) throw error;
  return data;
}

export async function deleteCertification(id) {
  const { error } = await supabase.from('certifications').delete().eq('id', id);
  if (error) throw error;
}
