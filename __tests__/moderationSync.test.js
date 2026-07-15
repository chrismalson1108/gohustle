const fs = require('fs');
const path = require('path');
const { findProhibited } = require('../src/lib/contentFilter');

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
  // Read the term array from the LATEST migration that redefines the array — the
  // create-or-replace with the newest timestamp is the one that wins live.
  const sql = quotedTerms(
    fs.readFileSync(path.join(ROOT, 'supabase/migrations/20260715060000_moderation_normalize_parity.sql'), 'utf8'),
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

// The term ARRAYS staying in sync isn't enough — each copy also normalizes text
// before matching (NFKC fold, zero-width strip, separator strip, leet fold), and a
// drift in the normalization steps is just as much a moderation gap as a drift in
// the terms (a variant caught by one layer but not another = inverted defense in
// depth). These tests assert the normalization steps agree between the shared client
// filter and the documented DB normalization in the latest parity migration.
describe('moderation normalization stays in sync (client filter vs DB backstop)', () => {
  // Latest migration that redefines contains_prohibited with the full normalization.
  const parity = fs.readFileSync(
    path.join(ROOT, 'supabase/migrations/20260715060000_moderation_normalize_parity.sql'),
    'utf8',
  );

  // 1. NFKC fold — a fullwidth-character variant of a known blocked term must be
  //    caught by the shared client filter (fullwidth 'cocaine').
  test('client filter catches an NFKC (fullwidth) variant of a blocked term', () => {
    const fullwidth = 'ｃｏｃａｉｎｅ'; // U+FF43 U+FF4F ... → 'cocaine' under NFKC
    expect(fullwidth.normalize('NFKC').toLowerCase()).toBe('cocaine');
    expect(findProhibited(fullwidth)).toBe('cocaine');
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
      expect(parity).toContain(`chr(${cp})`);
    }
  });

  // 3. Separator strip — in-word . _ * - must be stripped by both copies.
  test('client filter catches a separator-obfuscated variant of a blocked term', () => {
    expect(findProhibited('c.o.c.a.i.n.e')).toBe('cocaine');
    expect(findProhibited('o-n-l-y-f-a-n-s')).toBe('onlyfans');
  });
  test('DB backstop strips the same in-word separators', () => {
    expect(parity).toContain("translate(low, '._*-', '')");
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
    expect(parity).toContain("translate(low, '0134578@$', 'oieastbas')");
  });
});
