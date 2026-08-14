// ─────────────────────────────────────────────────────────────────────────────
// A directly-installed @expo/config-plugins must match the SDK it is prebuilding for.
//
// The SDK 57 attempt (d074f0e) added `@expo/config-plugins: ~57.0.7`. That attempt was
// abandoned for SDK 55 (c3df9d6, "SDK 57 does not build on this toolchain") and the pin
// came along in the merge. So master shipped expo 55.0.28 — which resolves
// config-plugins 55.x internally — beside a hoisted 57.0.7, and npm gave @expo/config
// its own nested copy because the two could not dedupe. Prebuild then ran with TWO
// instances of config-plugins, and EAS build 29 died in "Configure expo-updates" with
// nothing more useful than "Unknown error".
//
// It could not reproduce locally, and that is the part worth remembering: /ios is
// checked in here and excluded by .easignore, so prebuild NEVER runs on this machine and
// ALWAYS runs on EAS. A green local build, a green fingerprint and a green test suite
// all proved exactly nothing about the thing that was broken.
//
// The dependency cannot simply be deleted: @stripe/stripe-react-native's own config
// plugin does a bare `require('@expo/config-plugins')`, so removing it breaks config
// resolution outright (verified — `expo config --type prebuild` then fails to resolve
// withStripe.js). It has to be present AND aligned. expo-doctor flags it either way,
// which is why the warning is not a sufficient guard on its own.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));
const major = (v) => Number(String(v).replace(/^[^\d]*/, '').split('.')[0]);

describe('@expo/config-plugins is aligned with the installed Expo SDK', () => {
  const declared = (pkg.dependencies || {})['@expo/config-plugins'];
  const expoVersion = require(path.join(ROOT, 'node_modules', 'expo', 'package.json')).version;

  it('is declared, because a dependency bare-requires it', () => {
    // @stripe/stripe-react-native/lib/commonjs/plugin/withStripe.js:1 requires the bare
    // specifier. Dropping this dependency breaks `expo config --type prebuild`.
    expect(declared).toBeDefined();
    const stripePlugin = path.join(
      ROOT, 'node_modules', '@stripe', 'stripe-react-native',
      'lib', 'commonjs', 'plugin', 'withStripe.js',
    );
    if (fs.existsSync(stripePlugin)) {
      expect(fs.readFileSync(stripePlugin, 'utf8')).toMatch(/require\(["']@expo\/config-plugins["']\)/);
    }
  });

  it('its major matches the Expo major it will prebuild with', () => {
    // Expo and @expo/config-plugins share a major line (expo 55.x → config-plugins 55.x).
    // A mismatch is what produced two instances and the unattributable EAS failure.
    expect(`config-plugins ${major(declared)} vs expo ${major(expoVersion)}`)
      .toBe(`config-plugins ${major(expoVersion)} vs expo ${major(expoVersion)}`);
  });

  it('resolves to exactly ONE instance in the tree', () => {
    // The symptom to catch: @expo/config carrying its own nested copy because the
    // hoisted one was a different major.
    const nested = path.join(
      ROOT, 'node_modules', '@expo', 'config', 'node_modules', '@expo', 'config-plugins',
    );
    expect({ nestedCopyExists: fs.existsSync(nested) }).toEqual({ nestedCopyExists: false });
  });

  it("this repo's own plugin uses the sub-export, which cannot drift", () => {
    // `expo/config-plugins` always resolves to the instance the installed Expo uses, so
    // our plugin is immune to this even if a third party re-introduces a mismatch.
    const plugin = fs.readFileSync(path.join(ROOT, 'plugins', 'withModularHeaders.js'), 'utf8');
    expect(plugin).toMatch(/require\(['"]expo\/config-plugins['"]\)/);
    expect(plugin).not.toMatch(/require\(['"]@expo\/config-plugins['"]\)/);
  });
});
