const fs = require('fs');
const path = require('path');

// The prohibited-term blocklist is hand-maintained in THREE places that must stay
// in lockstep (there is no shared import across the RN app, the Deno edge function,
// and Postgres): the client filter, the AI-assistant edge function, and the DB
// backstop trigger. A term added to one but not the others is a moderation gap
// (security audit finding). This test fails loudly if they drift.
const ROOT = path.join(__dirname, '..');

function quotedTerms(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  if (start === -1) throw new Error(`marker not found: ${startMarker}`);
  const rest = text.slice(start + startMarker.length);
  const end = rest.indexOf(endMarker);
  const block = end === -1 ? rest : rest.slice(0, end);
  const terms = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  return terms.sort();
}

describe('moderation blocklist stays in sync across all three copies', () => {
  const shared = quotedTerms(
    fs.readFileSync(path.join(ROOT, 'shared/contentFilter.js'), 'utf8'),
    'const BLOCKED = [',
    '];',
  );
  const assistant = quotedTerms(
    fs.readFileSync(path.join(ROOT, 'supabase/functions/assistant/index.ts'), 'utf8'),
    'const BLOCKED_TERMS = [',
    '];',
  );
  const sql = quotedTerms(
    fs.readFileSync(path.join(ROOT, 'supabase/migrations/20260707040000_moderation_normalize_evasions.sql'), 'utf8'),
    'terms text[] := array[',
    '];',
  );

  test('shared has terms', () => {
    expect(shared.length).toBeGreaterThan(0);
  });
  test('assistant edge function matches shared', () => {
    expect(assistant).toEqual(shared);
  });
  test('DB backstop (contains_prohibited) matches shared', () => {
    expect(sql).toEqual(shared);
  });
});
