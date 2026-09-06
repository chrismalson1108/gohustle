const fs = require('fs');
const path = require('path');
const { findProhibited } = require('../src/lib/contentFilter');

// The prohibited-term blocklist is hand-maintained in THREE places that must stay
// in lockstep (there is no shared import across the RN app, the Deno edge function,
// and Postgres): the client filter, the AI-assistant edge function, and the DB
// backstop trigger. A term added to one but not the others is a moderation gap
// (security audit finding). This test fails loudly if they drift.
const ROOT = path.join(__dirname, '..');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');

// The DB copy is whichever `create or replace` lands LAST — resolve it instead of
// naming a file. This test used to hard-code 20260715060000_moderation_normalize_parity
// one line under a comment saying the newest definition is the one that wins, and the
// newest has been 20260726050000_moderation_plural_suffix since 2026-07-26. Two ways
// that bites: a term added to shared plus a NEW migration fails here until someone
// edits 20260715060000 — a migration production has already applied, which is exactly
// the file/production drift CLAUDE.md forbids — and, the other way round, a new
// migration whose term list drifts from shared is invisible to the test that exists to
// catch it. Same helper as __tests__/supportGuardDrift.test.js.
function newestDefining(fnName) {
  const hits = fs
    .readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) =>
      new RegExp(`create or replace function public\\.${fnName}\\b`, 'i').test(
        fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'),
      ),
    )
    .sort();
  if (!hits.length) return null;
  const file = hits[hits.length - 1];
  return { file, sql: fs.readFileSync(path.join(MIGRATIONS, file), 'utf8') };
}

function quotedTerms(text, startMarker, endMarker, source) {
  const start = text.indexOf(startMarker);
  if (start === -1) throw new Error(`marker not found: ${startMarker}${source ? ` (in ${source})` : ''}`);
  const rest = text.slice(start + startMarker.length);
  const end = rest.indexOf(endMarker);
  const block = end === -1 ? rest : rest.slice(0, end);
  const terms = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  return terms.sort();
}

// The live DB definition — resolved, not named. Every assertion below that reads SQL
// reads THIS file, and reports its name on failure so the test says what it measured.
const backstop = newestDefining('contains_prohibited');

describe('moderation blocklist stays in sync across all three copies', () => {
  const shared = quotedTerms(
    fs.readFileSync(path.join(ROOT, 'shared/contentFilter.js'), 'utf8'),
    'const BLOCKED = [',
    '];',
    'shared/contentFilter.js',
  );
  const assistant = quotedTerms(
    fs.readFileSync(path.join(ROOT, 'supabase/functions/assistant/index.ts'), 'utf8'),
    'const BLOCKED_TERMS = [',
    '];',
    'supabase/functions/assistant/index.ts',
  );

  test('a migration defines the DB backstop', () => {
    expect(backstop).not.toBeNull();
  });
  test('shared has terms', () => {
    expect(shared.length).toBeGreaterThan(0);
  });
  test('assistant edge function matches shared', () => {
    expect(assistant).toEqual(shared);
  });
  test('DB backstop (contains_prohibited) matches shared', () => {
    const sql = quotedTerms(backstop.sql, 'terms text[] := array[', '];', backstop.file);
    expect(`${backstop.file}: ${JSON.stringify(sql)}`).toBe(`${backstop.file}: ${JSON.stringify(shared)}`);
  });
});

// The term ARRAYS staying in sync isn't enough — each copy also normalizes text
// before matching (NFKC fold, zero-width strip, separator strip, leet fold), and a
// drift in the normalization steps is just as much a moderation gap as a drift in
// the terms (a variant caught by one layer but not another = inverted defense in
// depth). These tests assert the normalization steps agree between the shared client
// filter and the DB normalization in the migration that currently defines the function.
describe('moderation normalization stays in sync (client filter vs DB backstop)', () => {
  // Same resolved definition the term-list assertion reads — a migration that
  // redefines the function must carry the normalization forward with it.
  const parity = backstop.sql;
  const where = backstop.file;

  // 1. NFKC fold — a fullwidth-character variant of a known blocked term must be
  //    caught by the shared client filter (fullwidth 'cocaine').
  test('client filter catches an NFKC (fullwidth) variant of a blocked term', () => {
    const fullwidth = 'ｃｏｃａｉｎｅ'; // U+FF43 U+FF4F ... → 'cocaine' under NFKC
    expect(fullwidth.normalize('NFKC').toLowerCase()).toBe('cocaine');
    expect(findProhibited(fullwidth)).toBe('cocaine');
  });
  test('DB backstop NFKC-folds and lowercases like the client', () => {
    expect(`${where}: ${/lower\(normalize\(/.test(parity)}`).toBe(`${where}: true`);
  });

  // 2. Zero-width strip — U+200B/200C/200D/FEFF interleaved into a blocked term must
  //    still be caught, and the DB must strip the SAME four codepoints.
  test('client filter catches a zero-width-joined variant of a blocked term', () => {
    const zw = 'c​o‌c‍a​i‌n﻿e'; // zero-width chars inside 'cocaine'
    expect(findProhibited(zw)).toBe('cocaine');
    expect(findProhibited('onlyf‍ans')).toBe('onlyfans');
  });
  test('DB backstop strips the same four zero-width codepoints (U+200B/200C/200D/FEFF)', () => {
    // The migration strips them via translate(low, chr(8203)||chr(8204)||chr(8205)||chr(65279), '').
    for (const cp of [8203, 8204, 8205, 65279]) {
      expect(`${where}: chr(${cp}) ${parity.includes(`chr(${cp})`)}`).toBe(`${where}: chr(${cp}) true`);
    }
  });

  // 3. Separator strip — in-word . _ * - must be stripped by both copies.
  test('client filter catches a separator-obfuscated variant of a blocked term', () => {
    expect(findProhibited('c.o.c.a.i.n.e')).toBe('cocaine');
    expect(findProhibited('o-n-l-y-f-a-n-s')).toBe('onlyfans');
  });
  test('DB backstop strips the same in-word separators', () => {
    expect(`${where}: ${parity.includes("translate(low, '._*-', '')")}`).toBe(`${where}: true`);
  });

  // 4. Leet fold — the digit/symbol → letter mapping must be identical in both, and
  //    a leetspeak variant of a blocked term must be caught by the client filter.
  test('client filter catches a leetspeak variant of a blocked term', () => {
    expect(findProhibited('c0ca1n3')).toBe('cocaine'); // 0→o 1→i 3→e
    expect(findProhibited('0nlyf4n5')).toBe('onlyfans'); // 0→o 4→a 5→s
  });
  test('DB backstop leet fold maps the same digits/symbols to the same letters', () => {
    // Client LEET_MAP: 0→o 1→i 3→e 4→a 5→s 7→t 8→b @→a $→s.
    // DB: translate(low, '0134578@$', 'oieastbas') — same from/to ordering.
    expect(`${where}: ${parity.includes("translate(low, '0134578@$', 'oieastbas')")}`).toBe(`${where}: true`);
  });
});
