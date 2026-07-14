// Image picking + upload to Supabase Storage. Used for profile avatars, job
// photos, completion photos, and chat images. Web is guarded.
//
// Library picking uses PHPicker (launchImageLibraryAsync) which needs NO photo
// permission/usage string on iOS — so we must NOT call
// requestMediaLibraryPermissionsAsync (doing so crashes when the usage string
// is absent). Camera capture DOES need NSCameraUsageDescription + permission.
import { Platform, ActionSheetIOS, Alert } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { supabase } from './supabase';

async function runLibrary({ multiple }) {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsEditing: !multiple,
    quality: 1,
    allowsMultipleSelection: multiple,
    selectionLimit: multiple ? 6 : 1,
  });
  if (result.canceled || !result.assets?.length) return { canceled: true };
  return { canceled: false, uris: result.assets.map(a => a.uri) };
}

async function runCamera() {
  const perm = await ImagePicker.requestCameraPermissionsAsync();
  if (!perm.granted) return { canceled: true, denied: true };
  const result = await ImagePicker.launchCameraAsync({
    mediaTypes: ['images'],
    allowsEditing: true,
    quality: 1,
  });
  if (result.canceled || !result.assets?.length) return { canceled: true };
  return { canceled: false, uris: result.assets.map(a => a.uri) };
}

// Ask the user: take a photo or choose from library. Resolves 'camera' | 'library' | null.
function chooseSource() {
  return new Promise(resolve => {
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { options: ['Take Photo', 'Choose from Library', 'Cancel'], cancelButtonIndex: 2 },
        idx => resolve(idx === 0 ? 'camera' : idx === 1 ? 'library' : null)
      );
    } else {
      Alert.alert('Add Photo', undefined, [
        { text: 'Take Photo', onPress: () => resolve('camera') },
        { text: 'Choose from Library', onPress: () => resolve('library') },
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(null) },
      ]);
    }
  });
}

// Pick one or more images (offers camera + library). Returns { canceled, denied, uris }.
export async function pickImages({ multiple = false } = {}) {
  if (Platform.OS === 'web') return { canceled: true };
  const source = await chooseSource();
  if (!source) return { canceled: true };
  return source === 'camera' ? runCamera() : runLibrary({ multiple });
}

// Convenience for a single pick.
export async function pickImage(opts = {}) {
  const res = await pickImages({ ...opts, multiple: false });
  return res.canceled ? res : { canceled: false, denied: false, uri: res.uris[0] };
}

// Server-side image moderation (Claude vision via the moderate-image function).
// Called right after an object lands in Storage. Throws a user-facing error when
// the image violates policy (the object is deleted server-side). Fails open on
// invocation/network errors so a moderation outage doesn't block legit uploads.
async function moderateOrThrow(bucket, path) {
  try {
    const { data, error } = await supabase.functions.invoke('moderate-image', { body: { bucket, path } });
    if (!error && data && data.allowed === false) {
      const e = new Error('That image was blocked — it may violate our content policy.');
      e.blocked = true;
      throw e;
    }
  } catch (e) {
    if (e?.blocked) throw e; // re-throw genuine policy blocks
    console.warn('moderateOrThrow:', e?.message || e); // else fail open
  }
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
    // Paths are already unique (timestamp + byte-length suffix), so never overwrite —
    // matches the web uploader and sidesteps the buckets that lack an UPDATE policy.
    upsert: false,
  });
  if (error) throw error;
  await moderateOrThrow(bucket, path);
  const { data } = supabase.storage.from(bucket).getPublicUrl(path);
  return data.publicUrl;
}

// Upload to a PRIVATE bucket and return the storage path (not a public URL).
// Display these via getSignedUrl(). Used for sensitive files like receipts.
export async function uploadPrivateImage({ uri, bucket, userId, maxWidth = 1280, compress = 0.6 }) {
  const manipulated = await manipulateAsync(
    uri,
    [{ resize: { width: maxWidth } }],
    { compress, format: SaveFormat.JPEG }
  );
  const arraybuffer = await fetch(manipulated.uri).then(r => r.arrayBuffer());
  const path = `${userId}/${Date.now()}-${Math.round(arraybuffer.byteLength % 100000)}.jpg`;
  const { error } = await supabase.storage.from(bucket).upload(path, arraybuffer, {
    contentType: 'image/jpeg',
    // Paths are already unique (timestamp + byte-length suffix), so never overwrite —
    // matches the web uploader and sidesteps the buckets that lack an UPDATE policy.
    upsert: false,
  });
  if (error) throw error;
  await moderateOrThrow(bucket, path);
  return path;
}

// Create a temporary signed URL for a private object path.
export async function getSignedUrl(bucket, path, expiresIn = 3600) {
  if (!path) return null;
  try {
    const { data } = await supabase.storage.from(bucket).createSignedUrl(path, expiresIn);
    return data?.signedUrl || null;
  } catch (_) { return null; }
}

// Upload many local URIs sequentially; returns array of public URLs.
export async function uploadImages({ uris, bucket, userId, maxWidth = 1280, compress = 0.6 }) {
  const urls = [];
  for (const uri of uris) {
    urls.push(await uploadImage({ uri, bucket, userId, maxWidth, compress }));
  }
  return urls;
}

// Upload many local URIs to a PRIVATE bucket; returns array of object PATHS
// (render via getSignedUrl). Used for completion/before proof-of-work photos.
export async function uploadPrivateImages({ uris, bucket, userId, maxWidth = 1280, compress = 0.6 }) {
  const paths = [];
  for (const uri of uris) {
    paths.push(await uploadPrivateImage({ uri, bucket, userId, maxWidth, compress }));
  }
  return paths;
}

// A stored value is a bare object path ("<uid>/<file>", new rows) or a legacy full
// public URL ("…/<bucket>/<uid>/<file>"). Return the object path for signing.
export function objectPath(stored, bucket) {
  if (!stored) return null;
  const marker = `/${bucket}/`;
  const i = stored.indexOf(marker);
  return i >= 0 ? stored.slice(i + marker.length) : stored;
}
