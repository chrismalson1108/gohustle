#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Run this BEFORE `eas build` or `eas update`. It catches the one failure that has
// killed three builds across two days and reports success while doing it.
//
// ── WHAT IT CATCHES ─────────────────────────────────────────────────────────
// runtimeVersion policy is `fingerprint`. The CLI computes that fingerprint on THIS
// machine and EAS recomputes it in the cloud; if they disagree, CONFIGURE_EXPO_UPDATES
// fails with nothing but "Unknown error" — and `eas build` STILL EXITS 0, so any script
// or person trusting the exit code reports a build that does not exist.
//
// The same drift silently mis-targets `eas update`: the OTA publishes against a runtime
// no installed build has, reaches nobody, and looks like it worked. That is worse than
// the build failure, because nothing errors at all.
//
// Every occurrence so far has been one source: react-native-maps.
//   2026-08-14  builds 29, 30    local 2f21a192… vs EAS bd7bcd0a…
//   2026-08-17  build 32         local 2f21a192… vs EAS bd7bcd0a… (identical)
//   2026-08-17  after a rebuild  local 2f21a192… (caught here, before building)
//
// ── WHAT IS AND IS NOT KNOWN ────────────────────────────────────────────────
// The fix is certain: `rm -rf node_modules/react-native-maps && npm install
// --legacy-peer-deps` restores it every time.
//
// The MECHANISM is not. Two confident guesses have been wrong — both claimed a local iOS
// build rewrites the package. Measured 2026-08-17 and it does not:
//   · `find node_modules/react-native-maps -newermt '-90 minutes'` → ZERO files touched
//     while the hash sat drifted.
//   · `npm pack react-native-maps@1.27.2` extracted and `diff -rq` against the installed
//     tree → IDENTICAL. Nothing is written into the package.
//
// A third measurement narrows it further. Dropping ONE extra file into the package DOES
// move the hash, so it is content-sensitive after all. Put together:
//
//   · content-sensitive                          (adding a file changes it)
//   · clean install == published tarball, exactly (diff -rq is silent)
//   · zero files modified in 90 minutes          (find -newermt finds nothing)
//
// Those three reconcile in exactly one way: the drifted tree was **MISSING** content
// rather than carrying extra. Removing files leaves no recent mtime on the survivors and
// still changes the hash — which is the only shape that fits all three. The likely agent
// is npm pruning during an install, not a build writing anything.
//
// That is a theory with evidence rather than a guess, and it is still not proof. Capture
// the broken tree next time and it becomes one.
//
// Until that is pinned down, this script is the guard: it does not need the cause, only
// the observation, which has held three times.
// ─────────────────────────────────────────────────────────────────────────────
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);

// The value EAS computes for this version. If the version below changes, this hash is
// EXPECTED to change too — take the new one from a build that reached FINISHED, never
// from whatever the local tree happens to say, or the guard just blesses the drift.
const PINNED = {
  package: 'react-native-maps',
  version: '1.27.2',
  hash: 'bd7bcd0a3bd0561edaefc45d0519feda4d2e73cb',
};

const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

function fingerprint() {
  const out = execFileSync('npx', ['--yes', '@expo/fingerprint', '.'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return JSON.parse(out);
}

let fp;
try {
  fp = fingerprint();
} catch (e) {
  // Fail LOUD, not open. A preflight that shrugs when it cannot measure is worse than
  // none: it converts "I don't know" into "go ahead".
  console.error(red('✖ Could not compute the fingerprint, so the build is unverified.'));
  console.error(String(e.message ?? e).split('\n').slice(0, 3).join('\n'));
  process.exit(2);
}

const installed = require(`${PINNED.package}/package.json`).version;
const source = fp.sources.find((s) => String(s.filePath ?? '').includes(PINNED.package));

console.log(`runtime fingerprint : ${fp.hash}`);
console.log(`${PINNED.package.padEnd(20)}: ${source?.hash ?? 'NOT IN FINGERPRINT'}`);

if (!source) {
  console.error(red(`✖ ${PINNED.package} is not a fingerprint source any more.`));
  console.error('  Either it was removed, or the fingerprint sources changed shape.');
  console.error('  Re-derive the pin from a FINISHED build before trusting a release.');
  process.exit(2);
}

if (installed !== PINNED.version) {
  console.log(yellow(`\n⚠ ${PINNED.package} is ${installed}, but this check is pinned to ${PINNED.version}.`));
  console.log('  Update PINNED in this script using the hash from a build that reached');
  console.log('  FINISHED — not from the local tree, which is the thing being checked.');
  process.exit(1);
}

if (source.hash !== PINNED.hash) {
  console.error(red('\n✖ FINGERPRINT DRIFT — do not build or publish an OTA from this tree.'));
  console.error(`  expected ${PINNED.hash}`);
  console.error(`  found    ${source.hash}`);
  console.error('\n  An eas build would fail in CONFIGURE_EXPO_UPDATES and STILL EXIT 0.');
  console.error('  An eas update would publish to a runtime nobody is running.');
  console.error('\n  Fix:');
  console.error('    rm -rf node_modules/react-native-maps && npm install --legacy-peer-deps');
  console.error('\n  Before fixing, if you want the cause: the reinstall destroys the only');
  console.error('  copy of the broken state, which is why three occurrences have produced no');
  console.error('  diagnosis. Capture it first —');
  console.error(`    npm pack ${PINNED.package}@${installed} && diff -r <extracted> node_modules/${PINNED.package}`);
  process.exit(1);
}

console.log(green('\n✓ Native fingerprint matches the last known-good build. Safe to build or publish.'));
