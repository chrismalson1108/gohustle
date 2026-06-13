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
