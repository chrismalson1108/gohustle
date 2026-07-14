const { withDangerousMod } = require('@expo/config-plugins');
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
