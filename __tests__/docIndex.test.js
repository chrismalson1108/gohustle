const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// CLAUDE.md is auto-loaded into every Claude Code session for this repo. That makes
// it the one document guaranteed to be read — and therefore the only reliable place
// to learn that the OTHER documents exist.
//
// On 2026-08-13 every one of them was an orphan: KNOWN_RISKS.md (the risk register),
// PRE_LAUNCH_DATA_RESET.md (the runbook for wiping test data before launch),
// LIFECYCLE_STATE_MACHINES.md, BETA_QA_PLAN.md and six more. A new session read
// CLAUDE.md, learned none of them existed, and went on to rediscover or re-break
// things that were already written down.
//
// So: a markdown file at the repo root must be mentioned in CLAUDE.md. Adding a doc
// nobody is told to read is the same as not writing it.
// ─────────────────────────────────────────────────────────────────────────────
const ROOT = path.join(__dirname, '..');
const claude = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');

// README is the GitHub landing page and is not session guidance; CLAUDE.md itself
// obviously need not reference itself.
const EXEMPT = new Set(['CLAUDE.md', 'README.md']);

const docs = fs
  .readdirSync(ROOT)
  .filter((f) => f.endsWith('.md'))
  .filter((f) => !EXEMPT.has(f));

describe('every root document is discoverable from CLAUDE.md', () => {
  it('finds documents to check', () => {
    expect(docs.length).toBeGreaterThan(3);
  });

  docs.forEach((doc) => {
    it(`${doc} is referenced`, () => {
      // Named with the extension so the reference is an unambiguous pointer to a file,
      // not a passing mention of a concept.
      expect(`${doc}: ${claude.includes(doc) ? 'linked' : 'ORPHANED — add it to the document map in CLAUDE.md'}`)
        .toBe(`${doc}: linked`);
    });
  });
});
