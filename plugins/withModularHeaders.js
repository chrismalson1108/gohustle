// `expo/config-plugins`, NOT the bare `@expo/config-plugins`.
//
// The SDK 57 attempt (d074f0e) added a direct `@expo/config-plugins: ~57.0.7` dependency.
// That attempt was abandoned for SDK 55 (c3df9d6) and the pin came along for the ride, so
// master shipped expo 55.0.28 — which bundles config-plugins 55.0.11 — beside a hoisted
// 57.0.7. This file resolved the hoisted one, giving prebuild TWO different instances of
// config-plugins: the withDangerousMod applied here was not the one Expo's own pipeline
// ran, and the EAS "Configure expo-updates" phase failed with an unhelpful "Unknown
// error" (build 29, 2026-08-14).
//
// It could not fail locally: `/ios` is checked in here and excluded by .easignore, so
// prebuild never runs on this machine and always runs on EAS. That asymmetry is why a
// green local build proved nothing.
//
// The sub-export always resolves to the instance the installed Expo is using, so it
// cannot drift from the SDK again. This is also what expo-doctor's "should not be
// installed directly" check asks for.
const { withDangerousMod } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

// GoogleSignIn 9.x (pulled in by @react-native-google-signin/google-signin)
// depends on the Swift pod AppCheckCore, which in turn depends on the
// non-modular Obj-C pods GoogleUtilities and RecaptchaInterop. With Expo's
// default static-library pod integration, CocoaPods refuses to integrate the
// Swift pod ("cannot yet be integrated as static libraries ... do not define
// modules") and `pod install` fails — which is what broke the EAS iOS build.
//
// Enabling `use_modular_headers!` makes CocoaPods generate module maps for
// those transitive pods so the Swift pod links, without switching the whole
// project to frameworks. Prebuild regenerates the Podfile on every EAS build,
// so this plugin re-applies the line each time.
module.exports = function withModularHeaders(config) {
  return withDangerousMod(config, [
    'ios',
    (config) => {
      const podfilePath = path.join(config.modRequest.platformProjectRoot, 'Podfile');
      let contents = fs.readFileSync(podfilePath, 'utf8');
      if (!contents.includes('use_modular_headers!')) {
        contents = contents.replace(
          /use_expo_modules!/,
          'use_expo_modules!\n  use_modular_headers!'
        );
        fs.writeFileSync(podfilePath, contents);
      }
      return config;
    },
  ]);
};
