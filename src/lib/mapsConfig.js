// Is a native map actually usable on this platform, given this app config?
//
// On iOS `react-native-maps` renders Apple Maps and needs no key. On ANDROID it
// only speaks Google, and the Google Maps SDK refuses to initialise a MapView
// unless `com.google.android.geo.API_KEY` meta-data is in AndroidManifest.xml.
//
// There is exactly ONE way to get that meta-data into the manifest here, and it
// is not the one the Expo docs make obvious:
//
//   • react-native-maps ships its own `app.plugin.js`, and
//     @expo/prebuild-config registers it with `createLegacyPlugin({ packageName:
//     'react-native-maps', fallback: [...withGoogleMapsApiKey...] })`, which
//     calls `withStaticPlugin(..., { plugin: 'react-native-maps', fallback })`.
//     A package that ships its own plugin WINS, so the fallback never runs —
//     and the fallback is the only thing that reads `android.config.googleMaps.
//     apiKey`. Setting that field is therefore a silent no-op.
//   • The package's own Android mod is explicit about the other direction:
//     `if (props?.androidGoogleMapsApiKey) addMetaDataItem(...) else
//     removeMetaDataItem(...)`. With no props it REMOVES the meta-data.
//
// So the key must be a prop on a `["react-native-maps", { androidGoogleMapsApiKey
// }]` entry in app.json's `plugins`, and nothing else counts. This module reads
// exactly that, so the map turns itself on for Android the moment a real key is
// added — and until then the callers render a list-only fallback instead of
// constructing a MapView the Maps SDK will reject.
//
// Deliberately free of react-native / expo-constants imports: callers pass
// `Platform.OS` and `Constants.expoConfig` in, which keeps this predicate
// unit-testable in the plain-node Jest env and keeps the two callers in step.
// `__tests__/androidMapsKey.test.js` guards both halves.

export const ANDROID_MAPS_PLUGIN = 'react-native-maps';

// A placeholder is not a key. Mirrors the `REPLACE`-placeholder convention that
// `AuthContext` already uses for the Google sign-in client ids.
function isPlaceholder(value) {
  return /REPLACE|YOUR[_-]?KEY|XXXX/i.test(value);
}

// The Android Google Maps key this build will actually ship in its manifest, or
// null. Only the plugin-prop form is honoured — see the note above.
export function androidMapsApiKey(expoConfig) {
  const plugins = Array.isArray(expoConfig?.plugins) ? expoConfig.plugins : [];
  for (const entry of plugins) {
    if (!Array.isArray(entry) || entry[0] !== ANDROID_MAPS_PLUGIN) continue;
    const key = entry[1] && entry[1].androidGoogleMapsApiKey;
    if (typeof key === 'string' && key.trim() && !isPlaceholder(key)) return key.trim();
  }
  return null;
}

// May we render a native MapView? Web has no native map at all; Android needs
// the key; iOS is always fine.
export function mapsAvailable(os, expoConfig) {
  if (os === 'web') return false;
  if (os === 'android') return androidMapsApiKey(expoConfig) !== null;
  return true;
}

// Why the map is unavailable, for the fallback copy. Never mentions the key —
// a missing platform credential is not something a user can act on.
export function mapUnavailableReason(os, expoConfig) {
  if (mapsAvailable(os, expoConfig)) return null;
  if (os === 'web') return "Map view isn't available on web.";
  return "Map view isn't available on Android yet.";
}
