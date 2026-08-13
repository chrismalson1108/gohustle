// ─────────────────────────────────────────────────────────────────────────────
// Deno must never be allowed to manage this project's node_modules.
//
// The edge functions are Deno and the app is Expo/npm, and they share one directory
// tree. `deno check --node-modules-dir=auto` (or any deno command with nodeModulesDir
// enabled) resolves npm specifiers by writing node_modules/.deno/ and then REPLACING
// real package directories with symlinks into it.
//
// It did exactly that here on 2026-08-13: `node_modules/expo-updates` — a genuine Expo
// dependency — was replaced by a symlink to .deno/expo-updates@29.0.19, and a `stripe`
// symlink appeared for a package the app does not even depend on (Deno pulled it for
// the edge functions). Metro cannot resolve through that, and the running app died with
//
//     UnableToResolveError: Unable to resolve module @react-navigation/native
//
// which names an entirely innocent package, because what actually broke was the module
// map after 886 directories appeared inside node_modules at once. Chris hit it on his
// phone two minutes later and had no way to connect it to a type-check that had run in
// a different language for a different runtime.
//
// This test cannot stop the command. It makes the residue impossible to miss and names
// the real cause, instead of leaving the next person debugging a phantom import error.
//
// The fix, if this fails: rm -rf node_modules/.deno && rm the symlinks it left at the
// top level, then npm install --legacy-peer-deps. And type-check edge functions with a
// plain `deno check` — never --node-modules-dir.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const NM = path.join(__dirname, '..', 'node_modules');

describe('node_modules is npm-managed, not Deno-managed', () => {
  it('has no node_modules/.deno cache', () => {
    const denoDir = path.join(NM, '.deno');
    const present = fs.existsSync(denoDir);
    expect(
      present
        ? 'node_modules/.deno exists — a deno command wrote into the Expo project. See this file’s header.'
        : 'clean',
    ).toBe('clean');
  });

  it('has no top-level package symlinked into Deno’s cache', () => {
    if (!fs.existsSync(NM)) return; // nothing installed; nothing to corrupt
    const hijacked = fs
      .readdirSync(NM, { withFileTypes: true })
      .filter((e) => e.isSymbolicLink())
      .filter((e) => {
        try {
          return fs.readlinkSync(path.join(NM, e.name)).includes('.deno');
        } catch {
          return false;
        }
      })
      .map((e) => e.name);
    expect(hijacked).toEqual([]);
  });

  it('still has the packages App.js imports at module scope', () => {
    // The specific breakage was invisible until the app was opened. These are the
    // imports whose absence produces the confusing UnableToResolveError.
    const critical = ['@react-navigation/native', 'expo-updates', 'react-native', 'expo'];
    const missing = critical.filter((m) => !fs.existsSync(path.join(NM, m, 'package.json')));
    expect(missing).toEqual([]);
  });
});
