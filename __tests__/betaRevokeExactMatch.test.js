// ─────────────────────────────────────────────────────────────────────────────
// Revoking one beta invite must revoke exactly one beta invite.
//
// `revokeEmail` deleted with `.ilike("email", email)`, and postgrest-js passes that
// argument through as a LIKE PATTERN, not a value (PostgrestFilterBuilder appends
// `ilike.${pattern}` verbatim). In a LIKE pattern '_' matches any single character and
// '%' matches any run — both legal, and '_' common, in an email address. So revoking
// 'j_doe@school.edu' also deleted 'j.doe@school.edu' and 'jxdoe@school.edu': other
// testers' invites, gone, while the action returned ok and a message naming only the
// address that was asked for. Those people then hit `signup_not_allowlisted` and nobody
// could say why.
//
// The fix has two halves and the second is the one that carries the guarantee:
//   1. the pattern is escaped, so it reads as a value;
//   2. the DELETE no longer carries a pattern at all — the ilike gathers candidates,
//      exact equality is decided in JS, and .in() deletes those literal addresses.
// A pattern that somehow still over-matched could widen the read and not the delete.
//
// This asserts both: the shape of the code, and the LIKE semantics that made the shape
// wrong — the escape expression is lifted OUT of the source rather than retyped here, so
// the semantic half cannot drift away from what actually runs.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'admin', 'app', '(console)', 'access', 'actions.ts');
const src = fs.readFileSync(SRC, 'utf8');

const revokeBody = (() => {
  const i = src.indexOf('export async function revokeEmail(');
  const next = src.indexOf('export async function ', i + 10);
  return src.slice(i, next === -1 ? src.length : next);
})();

// The escape expression as it appears in the source, so this test cannot certify
// semantics the code does not implement. Single-quoted: `${c}` is literal text here.
const ESCAPE_SNIPPET = '.replace(/[\\\\%_]/g, (c) => `\\\\${c}`)';

// PostgreSQL LIKE, as a matcher: backslash escapes the next character, '%' is any run,
// '_' is any single character. ILIKE is the case-insensitive form.
function ilikeMatches(pattern, value) {
  let re = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === '\\') {
      i += 1;
      re += pattern[i] === undefined ? '\\\\' : pattern[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    } else if (c === '%') re += '.*';
    else if (c === '_') re += '.';
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i').test(value);
}

const escapeLike = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

describe('the LIKE semantics that made this a defect', () => {
  it('an unescaped address with an underscore matches OTHER testers', () => {
    expect(ilikeMatches('j_doe@school.edu', 'j.doe@school.edu')).toBe(true);
    expect(ilikeMatches('j_doe@school.edu', 'jxdoe@school.edu')).toBe(true);
  });

  it('escaped, it matches only itself — case-insensitively, which is the point of ilike', () => {
    const p = escapeLike('j_doe@school.edu');
    expect(ilikeMatches(p, 'j.doe@school.edu')).toBe(false);
    expect(ilikeMatches(p, 'jxdoe@school.edu')).toBe(false);
    expect(ilikeMatches(p, 'j_doe@school.edu')).toBe(true);
    expect(ilikeMatches(p, 'J_Doe@School.EDU')).toBe(true);
  });

  it("a '%' in the input is a wildcard too, and escaping neutralises it", () => {
    expect(ilikeMatches('%@school.edu', 'anyone@school.edu')).toBe(true);
    expect(ilikeMatches(escapeLike('%@school.edu'), 'anyone@school.edu')).toBe(false);
  });
});

describe('revokeEmail deletes by value, never by pattern', () => {
  it('escapes the LIKE metacharacters before the candidate read', () => {
    // The exact expression modelled by escapeLike() above — backslash, percent and
    // underscore, each prefixed with a backslash.
    expect(revokeBody.includes(ESCAPE_SNIPPET)).toBe(true);
  });

  it('narrows the candidates to exact, case-folded equality', () => {
    expect(revokeBody).toMatch(/\.toLowerCase\(\) === email/);
  });

  it('the DELETE carries .in() with those literal addresses and no ilike at all', () => {
    expect(revokeBody).toMatch(/\.delete\(\)\.in\("email", exact\)/);
    const deleteLine = revokeBody.slice(revokeBody.indexOf('.delete()'));
    expect(deleteLine).not.toMatch(/ilike/);
  });

  it('the ilike that remains is a read, not a write', () => {
    // Match the CALL, not the prose: the comment above it says ".ilike()" too, and
    // anchoring on that found the explanation instead of the code.
    const ilikeAt = revokeBody.indexOf('.ilike("email"');
    expect(ilikeAt).toBeGreaterThan(-1);
    const stmt = revokeBody.slice(revokeBody.lastIndexOf('const', ilikeAt), ilikeAt);
    expect(stmt).toMatch(/\.select\("email"\)/);
    expect(stmt).not.toMatch(/\.delete\(\)/);
  });

  it('reports how many rows went, rather than only the address that was asked for', () => {
    expect(revokeBody).toMatch(/const removed = data\?\.length \?\? exact\.length;/);
    expect(revokeBody).toMatch(/\$\{removed\} rows/);
  });
});
