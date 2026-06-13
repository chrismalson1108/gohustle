// Image picking + upload to Supabase Storage. Used for profile avatars and
// job-completion photos. Web is guarded (image-manipulator/picker are native).
import { Platform } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { supabase } from './supabase';

// Launch the library and return picked local URIs.
// Returns { canceled, denied, uris }.
export async function pickImages({ multiple = false, allowsEditing = false, aspect } = {}) {
  if (Platform.OS === 'web') return { canceled: true };
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) return { canceled: true, denied: true };

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsEditing: multiple ? false : allowsEditing, // editing not allowed w/ multi-select
    aspect,
    quality: 1,
    allowsMultipleSelection: multiple,
    selectionLimit: multiple ? 6 : 1,
  });
  if (result.canceled || !result.assets?.length) return { canceled: true };
  return { canceled: false, uris: result.assets.map(a => a.uri) };
}

// Convenience for a single pick.
export async function pickImage(opts = {}) {
  const res = await pickImages({ ...opts, multiple: false });
  return res.canceled ? res : { canceled: false, denied: false, uri: res.uris[0] };
}

// Compress/resize a local image and upload it to `bucket` under "<userId>/...".
// Returns the public URL.
export async function uploadImage({ uri, bucket, userId, maxWidth = 1024, compress = 0.7 }) {
  const manipulated = await manipulateAsync(
    uri,
    [{ resize: { width: maxWidth } }],
    { compress, format: SaveFormat.JPEG }
  );
  const arraybuffer = await fetch(manipulated.uri).then(r => r.arrayBuffer());
  const path = `${userId}/${Date.now()}-${Math.round(arraybuffer.byteLength % 100000)}.jpg`;
  const { error } = await supabase.storage.from(bucket).upload(path, arraybuffer, {
    contentType: 'image/jpeg',
    upsert: true,
  });
  if (error) throw error;
  const { data } = supabase.storage.from(bucket).getPublicUrl(path);
  return data.publicUrl;
}

// Upload many local URIs sequentially; returns array of public URLs.
export async function uploadImages({ uris, bucket, userId, maxWidth = 1280, compress = 0.6 }) {
  const urls = [];
  for (const uri of uris) {
    urls.push(await uploadImage({ uri, bucket, userId, maxWidth, compress }));
  }
  return urls;
}
