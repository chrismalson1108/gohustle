// Fetches the two fonts the render needs into a gitignored cache.
//
// They are NOT committed: Inter is ~100 KB per weight and Ionicons.ttf is 430 KB,
// and neither is a source file — the app gets them from its own dependencies. The
// npm registry is the source of truth for both, and it is reachable from CI and
// from a sandboxed agent session where a CDN may not be.
//
// Ionicons is pinned to react-native-vector-icons 10.2.0 because that is the
// glyph set @expo/vector-icons resolves for Ionicons; a different major renumbers
// codepoints and every icon in the screenshots silently becomes a different one.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CACHE = path.join(HERE, '.cache');

const PKGS = [
  {
    name: '@fontsource/inter', version: '5.3.0',
    probe: 'package/files/inter-latin-700-normal.woff2',
    // Only the five weights the screens use.
    patterns: [400, 500, 600, 700, 800].map((w) => `package/files/inter-latin-${w}-normal.woff2`),
  },
  {
    name: 'react-native-vector-icons', version: '10.2.0',
    probe: 'package/Fonts/Ionicons.ttf',
    patterns: ['package/Fonts/Ionicons.ttf', 'package/glyphmaps/Ionicons.json'],
  },
];

function tarballUrl(name, version) {
  const meta = execFileSync('curl', [
    '-sSf', '--max-time', '30',
    `https://registry.npmjs.org/${name.replace('/', '%2F')}`,
  ], { encoding: 'utf8', maxBuffer: 1 << 28 });
  const json = JSON.parse(meta);
  const v = json.versions[version];
  if (!v) throw new Error(`${name}@${version} not published`);
  return v.dist.tarball;
}

export function ensureFonts() {
  fs.mkdirSync(CACHE, { recursive: true });
  for (const pkg of PKGS) {
    if (fs.existsSync(path.join(CACHE, pkg.probe))) continue;
    const tgz = path.join(CACHE, `${pkg.name.replace(/[@/]/g, '_')}.tgz`);
    process.stdout.write(`  fetching ${pkg.name}@${pkg.version}\n`);
    execFileSync('curl', ['-sSf', '--max-time', '90', '-o', tgz, tarballUrl(pkg.name, pkg.version)]);
    // Extract only what the render reads — the full react-native-vector-icons
    // tarball is 30 MB of sources nothing here touches. Patterns are per-package:
    // tar exits non-zero when a named member is absent, so one shared list would
    // fail on whichever tarball does not carry the other's files.
    execFileSync('tar', ['xzf', tgz, '-C', CACHE, ...pkg.patterns], {
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    fs.unlinkSync(tgz);
  }
  for (const pkg of PKGS) {
    const probe = path.join(CACHE, pkg.probe);
    if (!fs.existsSync(probe)) throw new Error(`bootstrap failed: ${probe} missing after fetching ${pkg.name}`);
  }
}
