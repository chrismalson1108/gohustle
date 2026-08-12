const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// useHaptic returns an OBJECT, not a function.
//
// SafetyBar called it as `haptic('light')` and `haptic('warning')`. Both threw
// TypeError synchronously, and both sat OUTSIDE the surrounding try — so "Share my gig"
// spun forever having minted nothing and shown no error, and "Get help" never even
// opened its confirmation dialog. The SOS button did nothing at all.
//
// It survived review because it looks exactly like a working call, and nothing in the
// app exercised it: the component only renders on a booking the earner has STARTED, so
// no unit test and no casual click reaches it. It took driving a real gig to its
// started state in a simulator to see it.
//
// Cheap to assert, so assert it: haptic is only ever used as haptic.<method>().
// ─────────────────────────────────────────────────────────────────────────────
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : p.endsWith('.js') ? [p] : [];
  });
}

const SRC = path.join(__dirname, '..', 'src');
const FILES = walk(SRC);

describe('useHaptic is used as an object, never called as a function', () => {
  test('no file invokes haptic(...) directly', () => {
    const offenders = [];
    for (const f of FILES) {
      const src = fs.readFileSync(f, 'utf8');
      src.split('\n').forEach((line, i) => {
        // Ignore comments — the fix documents the old broken form on purpose.
        const code = line.replace(/\/\/.*$/, '');
        if (/(?<![.\w])haptic\s*\(/.test(code)) {
          offenders.push(`${path.relative(SRC, f)}:${i + 1}  ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  test('SafetyBar buzzes inside the try, so a haptics failure cannot kill a safety action', () => {
    const src = fs.readFileSync(path.join(SRC, 'components', 'SafetyBar.js'), 'utf8');
    // The share handler must open its try BEFORE touching haptics.
    const share = src.slice(src.indexOf('const share ='), src.indexOf('const emergency ='));
    expect(share.indexOf('try {')).toBeLessThan(share.indexOf('haptic.'));
    // Both call sites optional-call, so a missing/failing method cannot throw.
    expect(src).toMatch(/haptic\.light\?\.\(\)/);
    expect(src).toMatch(/haptic\.error\?\.\(\)/);
  });
});
