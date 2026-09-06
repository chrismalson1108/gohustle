// ─────────────────────────────────────────────────────────────────────────────
// Android has no Google Maps API key, so nothing may construct a MapView there.
//
// `react-native-maps` renders Apple Maps on iOS (no key) and Google Maps on
// Android (key REQUIRED — the SDK refuses to initialise a MapView without
// `com.google.android.geo.API_KEY` meta-data in AndroidManifest.xml, the classic
// symptom being a fatal "API key not found" at the moment the map is shown).
//
// app.json supplies no such key, and it is worse than merely absent:
// react-native-maps ships its own `app.plugin.js`, whose Android mod does
//   `if (props?.androidGoogleMapsApiKey) addMetaDataItem(...) else removeMetaDataItem(...)`
// so a prebuild with no props actively STRIPS the meta-data. And because
// @expo/prebuild-config registers the package with `createLegacyPlugin(...)` →
// `withStaticPlugin({ plugin: 'react-native-maps', fallback })`, a package that
// ships its own plugin wins and the fallback never runs — the fallback being the
// only thing that reads `android.config.googleMaps.apiKey`. Setting THAT field
// is a silent no-op, which is exactly the trap this test exists to catch.
//
// Meanwhile HomeScreen's Map/List toggle and MarketInsights' heat-map had no
// platform gate at all, so the first Android build to ship would have offered a
// Map button that could not work. iOS-only beta traffic would never surface it.
//
// Until a real key exists the gate keeps Android on the list-only fallback. The
// gate is config-driven, not hardcoded to a platform, so adding the key to
// app.json turns the map on with no code change — and this test flips to
// checking the key's SHAPE instead, because the only form that reaches the
// manifest is the plugin prop.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const { androidMapsApiKey, mapsAvailable, mapUnavailableReason, ANDROID_MAPS_PLUGIN } =
  require('../src/lib/mapsConfig');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const appJson = JSON.parse(read('app.json'));
const expo = appJson.expo;
const pkg = require(path.join(ROOT, 'package.json'));

describe('androidMapsApiKey reads only the form that reaches the manifest', () => {
  test('the plugin prop is the key', () => {
    const key = 'AIzaSyExampleExampleExampleExampleExample';
    expect(androidMapsApiKey({ plugins: [[ANDROID_MAPS_PLUGIN, { androidGoogleMapsApiKey: key }]] }))
      .toBe(key);
  });

  test('android.config.googleMaps.apiKey does NOT count — that fallback never runs', () => {
    // The whole point: this is the field the Expo docs suggest, and with
    // react-native-maps installed it is dead config.
    expect(androidMapsApiKey({ android: { config: { googleMaps: { apiKey: 'AIzaWhatever' } } } }))
      .toBeNull();
  });

  test('a placeholder or blank is not a key', () => {
    for (const bad of ['', '   ', 'REPLACE_ME', 'your-key-here', 'XXXXXXXX']) {
      expect(androidMapsApiKey({ plugins: [[ANDROID_MAPS_PLUGIN, { androidGoogleMapsApiKey: bad }]] }))
        .toBeNull();
    }
  });

  test('a bare string plugin entry carries no props, so no key', () => {
    expect(androidMapsApiKey({ plugins: [ANDROID_MAPS_PLUGIN] })).toBeNull();
  });

  test('missing/!array config never throws', () => {
    for (const cfg of [undefined, null, {}, { plugins: 'nope' }]) {
      expect(androidMapsApiKey(cfg)).toBeNull();
    }
  });
});

describe('mapsAvailable', () => {
  const withKey = { plugins: [[ANDROID_MAPS_PLUGIN, { androidGoogleMapsApiKey: 'AIzaReal' }]] };

  test('web never has a native map', () => {
    expect(mapsAvailable('web', withKey)).toBe(false);
  });

  test('iOS is always fine — Apple Maps needs no key', () => {
    expect(mapsAvailable('ios', { plugins: [] })).toBe(true);
  });

  test('Android is gated on the key, both ways', () => {
    expect(mapsAvailable('android', { plugins: [] })).toBe(false);
    expect(mapsAvailable('android', withKey)).toBe(true);
  });

  test('the unavailable copy never mentions a missing credential', () => {
    for (const os of ['web', 'android']) {
      const reason = mapUnavailableReason(os, { plugins: [] });
      expect(typeof reason).toBe('string');
      expect(reason).not.toMatch(/key|API|manifest/i);
    }
    expect(mapUnavailableReason('ios', { plugins: [] })).toBeNull();
  });
});

describe('the app config and the gate agree', () => {
  const declaredKey = androidMapsApiKey(expo);

  test('react-native-maps is still the dependency this is about', () => {
    expect(Object.keys(pkg.dependencies || {})).toContain('react-native-maps');
  });

  test('no key is declared through the dead android.config.googleMaps fallback', () => {
    // If someone "fixes" the missing key by setting this field, prebuild ignores
    // it AND react-native-maps' own mod removes the meta-data anyway — the build
    // is just as broken, but now it looks configured.
    const dead = expo?.android?.config?.googleMaps?.apiKey;
    expect({
      hint: 'put it in plugins: ["react-native-maps", { androidGoogleMapsApiKey }] — see src/lib/mapsConfig.js',
      deadFallbackKeySet: dead ? true : false,
    }).toEqual({
      hint: 'put it in plugins: ["react-native-maps", { androidGoogleMapsApiKey }] — see src/lib/mapsConfig.js',
      deadFallbackKeySet: false,
    });
  });

  test('every JobsMap host consults mapsAvailable rather than assuming a platform', () => {
    // The bug was three unconditional native-map render sites. Each must ask.
    for (const file of [
      'src/components/JobsMap.js',
      'src/screens/HomeScreen.js',
      'src/screens/MarketInsightsScreen.js',
    ]) {
      const src = read(file);
      expect({ file, importsGate: /from '(\.\.\/)+lib\/mapsConfig'/.test(src) })
        .toEqual({ file, importsGate: true });
      expect({ file, callsGate: /mapsAvailable\(\s*Platform\.OS\s*,\s*Constants\.expoConfig\s*\)/.test(src) })
        .toEqual({ file, callsGate: true });
    }
  });

  test('HomeScreen hides the Map toggle instead of offering a control that cannot work', () => {
    const src = read('src/screens/HomeScreen.js');
    expect(src).toMatch(/const canShowMap = mapsAvailable\(/);
    expect(src).toMatch(/\{canShowMap && \(/);
    // …and it cannot get stuck in map mode if the gate closes underneath it.
    expect(src).toMatch(/viewMode === 'map' && canShowMap/);
  });

  test('with no key declared, Android really is gated right now', () => {
    // This is the whole claim, evaluated against the config that will ship.
    expect({ declaredKey, androidMapWorks: mapsAvailable('android', expo) })
      .toEqual({ declaredKey, androidMapWorks: declaredKey !== null });
  });
});

describe('the installed react-native-maps still behaves the way this gate assumes', () => {
  // Guarded on existence: node_modules is not committed, and the pure-logic
  // assertions above must not depend on an install.
  const mod = path.join(ROOT, 'node_modules', 'react-native-maps', 'plugin', 'build', 'android.js');

  test('its Android mod REMOVES the meta-data when given no key', () => {
    if (!fs.existsSync(mod)) return;
    const src = fs.readFileSync(mod, 'utf8');
    expect(src).toMatch(/androidGoogleMapsApiKey/);
    expect(src).toMatch(/removeMetaDataItemFromMainApplication/);
    expect(src).toMatch(/com\.google\.android\.geo\.API_KEY/);
  });

  test('it ships its own app.plugin.js, which is why the Expo fallback never runs', () => {
    const own = path.join(ROOT, 'node_modules', 'react-native-maps', 'app.plugin.js');
    if (!fs.existsSync(own)) return;
    expect(fs.existsSync(own)).toBe(true);
  });
});
