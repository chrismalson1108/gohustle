const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// A component used in JSX but never imported.
//
// SupportScreen rendered <Modal> four times without importing it. Metro does not
// resolve free identifiers, so the bundle built cleanly; jest never mounts these
// screens, so 511 tests passed; and the failure only appeared as a red screen the
// moment a real person opened Support. Every gate I had was blind to it.
//
// This walks the JSX and asserts that anything used as a component is actually in
// scope. It is deliberately narrow — capitalised JSX tags only — so it stays fast
// and produces no false positives on props or locals.
// ─────────────────────────────────────────────────────────────────────────────
const ROOTS = ['src/screens', 'src/components'];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.jsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

const files = ROOTS.flatMap(r => {
  const abs = path.join(__dirname, '..', r);
  return fs.existsSync(abs) ? walk(abs) : [];
});

// Identifiers that are in scope without an import statement.
const AMBIENT = new Set(['React', 'Fragment']);

function declaredNames(src) {
  const names = new Set(AMBIENT);
  // import X, { a, b as c } from '...'   /   import * as NS from '...'
  const importRe = /import\s+([\s\S]*?)\s+from\s+['"][^'"]+['"]/g;
  let m;
  while ((m = importRe.exec(src))) {
    const clause = m[1];
    const named = clause.match(/\{([\s\S]*?)\}/);
    if (named) {
      named[1].split(',').forEach(part => {
        const name = part.trim().split(/\s+as\s+/).pop();
        if (name) names.add(name.trim());
      });
    }
    const def = clause.replace(/\{[\s\S]*?\}/, '').replace(/^\s*,|,\s*$/g, '').trim();
    if (def && !def.startsWith('*')) def.split(',').forEach(d => d.trim() && names.add(d.trim()));
    const ns = clause.match(/\*\s+as\s+(\w+)/);
    if (ns) names.add(ns[1]);
  }
  // Locally defined functions and classes.
  [
    /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/g,
    /(?:^|\n)\s*(?:export\s+)?class\s+(\w+)/g,
    /(?:^|\n)\s*(?:export\s+)?default\s+function\s+(\w+)/g,
  ].forEach(re => { let x; while ((x = re.exec(src))) names.add(x[1]); });

  // Variable declarations, INCLUDING multi-declarator lists. JobsMap.js does
  // `let MapView, Marker, PROVIDER_DEFAULT;` to lazy-require react-native-maps, and
  // a parser that took only the first name reported Marker as missing — a false
  // positive, which is how a guard like this ends up deleted instead of trusted.
  const declRe = /(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+([^=;\n]+)/g;
  let d;
  while ((d = declRe.exec(src))) {
    const list = d[1];
    // Destructuring: take the bound name, i.e. the right side of `orig: bound`.
    const destructured = list.match(/[{[]([^}\]]*)[}\]]/);
    const parts = destructured ? destructured[1].split(',') : list.split(',');
    parts.forEach(part => {
      const name = part.trim().split(':').pop().trim().replace(/^\.\.\./, '');
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    });
  }
  return names;
}

function usedComponents(src) {
  const used = new Set();
  // <Foo ...> and <Foo.Bar ...> — capitalised only, so host elements are ignored.
  const re = /<([A-Z]\w*)(?:\.\w+)*[\s/>]/g;
  let m;
  while ((m = re.exec(src))) used.add(m[1]);
  return used;
}

describe('every JSX component is in scope', () => {
  it('finds files to check', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  files.forEach(file => {
    const rel = path.relative(path.join(__dirname, '..'), file);
    it(`${rel} imports everything it renders`, () => {
      const src = fs.readFileSync(file, 'utf8');
      const declared = declaredNames(src);
      const missing = [...usedComponents(src)].filter(n => !declared.has(n));
      // Reported as a string so a failure names the file AND the identifier.
      expect(`${rel}: ${missing.join(', ') || 'none'}`).toBe(`${rel}: none`);
    });
  });
});
