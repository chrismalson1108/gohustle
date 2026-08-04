// Two `fatal` rows in the admin /errors page said:
//   Property 'formatMoney' doesn't exist   at JobCard          (2026-07-31, v1.4.0)
//   Property 'formatMoney' doesn't exist   at EarningsTiles    (2026-07-30, v1.4.0)
//
// Both are Hermes' wording for "this identifier resolved to undefined". They date
// from the commit that moved the formatter out of src/lib/finance.js and turned that
// file into `export * from '../../shared/finance.js'` — the classic failure mode
// being a re-export that resolves to nothing (a stale bundler cache, a renamed
// export, or an import cycle that leaves the module half-initialised).
//
// The chain is fine today. This pins it, because the symptom is invisible until a
// screen renders on a device: nothing in CI imports these components, `export *`
// fails silently rather than at build time, and both crash sites are money on the
// two screens users open most (Browse and Profile earnings).
const path = require('path');

const financeLib = require(path.join(__dirname, '..', 'src', 'lib', 'finance.js'));
const financeShared = require(path.join(__dirname, '..', 'shared', 'finance.js'));

describe('formatMoney survives the shared/ re-export chain', () => {
  test('src/lib/finance.js actually re-exports it', () => {
    // The exact resolution JobCard.js and MonthSummaryCard.js perform.
    expect(typeof financeLib.formatMoney).toBe('function');
  });

  test('it is the same function as the shared definition, not a shadow', () => {
    expect(financeLib.formatMoney).toBe(financeShared.formatMoney);
  });

  test('it still formats money the way both apps expect', () => {
    expect(financeLib.formatMoney(2640.5)).toBe('$2,640.50');
    expect(financeLib.formatMoney(2640)).toBe('$2,640');
    expect(financeLib.formatMoney(-12.5)).toBe('-$12.50'); // sign outside the symbol
    expect(financeLib.formatMoney(0)).toBe('$0');
  });

  test('the crash sites still import through that path', () => {
    const fs = require('fs');
    for (const f of ['src/components/JobCard.js', 'src/components/MonthSummaryCard.js']) {
      const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
      expect(src).toMatch(/import \{[^}]*formatMoney[^}]*\} from '\.\.\/lib\/finance'/);
    }
  });

  test('shared/finance.js has no import cycle back to its dependents', () => {
    // finance -> filters -> geo is acyclic today. A cycle here is precisely what
    // would make `formatMoney` undefined at module-eval time on a real device while
    // every unit test still passed.
    const fs = require('fs');
    const seen = new Set();
    const walk = (name) => {
      if (seen.has(name)) return;
      seen.add(name);
      const file = path.join(__dirname, '..', 'shared', `${name}.js`);
      if (!fs.existsSync(file)) return;
      const deps = [...fs.readFileSync(file, 'utf8').matchAll(/from '\.\/([a-zA-Z]+)\.js'/g)].map((m) => m[1]);
      for (const d of deps) {
        expect(d).not.toBe('finance'); // nothing finance depends on may depend back on it
        walk(d);
      }
    };
    walk('finance');
  });
});
