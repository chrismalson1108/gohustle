// ─────────────────────────────────────────────────────────────────────────────
// A grant box that drops recipients must not report them as already served.
//
// /pricing's direct-grant field is labelled "Emails or usernames". It resolved the whole
// pasted list against profiles.username, and reached for auth emails only
// `if (!ids.length)` — so ONE username in the list suppressed the email lookup for every
// other entry. The RPC then granted to the one person who matched, and the message said
//
//   "Granted to 1 of 10. Anyone already holding it was skipped."
//
// which attributes nine people who were never looked up to a skip that never happened.
// Nobody re-checks a number that has an explanation attached to it.
//
// Three separate outcomes were collapsed into one figure, and they have three different
// owners: the RPC's insert count, the RPC's on-conflict skip (people who already hold the
// grant), and entries that named nobody (an operator problem, and the only one that can
// be acted on).
//
// The first block below runs the OLD algorithm and the NEW one over the same mixed list
// and the same lookup tables — that is the discrimination, and it does not need a
// database because the defect was arithmetic, not I/O.
//
// Found by the 2026-09-05 audit (admin-console#11).
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const {
  parseRecipients,
  resolveRecipients,
  grantSummary,
} = require('../admin/lib/recipients.ts');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const codeOnly = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const actions = codeOnly(read('admin', 'app', '(console)', 'pricing', 'actions.ts'));
const grantStart = actions.indexOf('export async function grantToUsers');
const grantEnd = actions.indexOf('export async function ', grantStart + 1);
const grantBody = actions.slice(grantStart, grantEnd === -1 ? undefined : grantEnd);

// The audit's own scenario: one username, nine emails, every one of them a real account.
const LIST = 'sam_k, a@school.edu, b@school.edu, c@school.edu, d@school.edu, e@school.edu, f@school.edu, g@school.edu, h@school.edu, i@school.edu';
const BY_USERNAME = new Map([['sam_k', 'u-sam']]);
const BY_EMAIL = new Map(
  'abcdefghi'.split('').map((c) => [`${c}@school.edu`, `u-${c}`]),
);

// The shipped algorithm, transcribed from actions.ts:114-123 before the fix.
function resolveTheOldWay(entries, byUsername, byEmail) {
  let ids = entries.map((e) => byUsername.get(e)).filter(Boolean);
  if (!ids.length) ids = entries.map((e) => byEmail.get(e)).filter(Boolean);
  return ids;
}

describe('every entry is resolved on its own', () => {
  const entries = parseRecipients(LIST);

  it('parses the mixed list into ten entries', () => {
    expect(entries).toHaveLength(10);
    expect(entries[0]).toBe('sam_k');
  });

  it('DISCRIMINATES: the old algorithm resolved 1 of 10, the new one resolves 10', () => {
    // One username hit is enough to make the email map unreachable.
    expect(resolveTheOldWay(entries, BY_USERNAME, BY_EMAIL)).toEqual(['u-sam']);

    const { ids, unmatched } = resolveRecipients(entries, BY_USERNAME, BY_EMAIL);
    expect(ids).toHaveLength(10);
    expect(unmatched).toEqual([]);
  });

  it('still resolves a pure-email list, which is the case that used to work', () => {
    const only = parseRecipients('a@school.edu b@school.edu');
    const { ids } = resolveRecipients(only, new Map(), BY_EMAIL);
    expect(ids).toEqual(['u-a', 'u-b']);
  });

  it('names the entries that matched nobody instead of counting them as served', () => {
    const mixed = parseRecipients('sam_k, a@school.edu, ghost@nowhere.test');
    const { ids, unmatched } = resolveRecipients(mixed, BY_USERNAME, BY_EMAIL);
    expect(ids).toEqual(['u-sam', 'u-a']);
    expect(unmatched).toEqual(['ghost@nowhere.test']);
  });

  it('counts a person once when both their username and their email are pasted', () => {
    const dupes = parseRecipients('sam_k sam_k@school.edu');
    const byEmail = new Map([['sam_k@school.edu', 'u-sam']]);
    const { ids, unmatched } = resolveRecipients(dupes, BY_USERNAME, byEmail);
    // Granting twice is harmless — the RPC is on-conflict-do-nothing — but it would
    // inflate the denominator the message reports.
    expect(ids).toEqual(['u-sam']);
    expect(unmatched).toEqual([]);
  });

  it('normalises and de-duplicates before anything is counted', () => {
    expect(parseRecipients(' A@School.edu\nA@school.edu ; b@school.edu,,')).toEqual([
      'a@school.edu',
      'b@school.edu',
    ]);
    expect(parseRecipients('')).toEqual([]);
  });
});

describe('the message keeps the three outcomes apart', () => {
  it('only the RPC\'s own skip is described as already holding it', () => {
    const msg = grantSummary({ granted: 7, matched: 9, unmatched: ['ghost@nowhere.test'] });
    expect(msg).toContain('Granted to 7 of the 9 that matched.');
    expect(msg).toContain('2 already held it.');
    expect(msg).toContain('ghost@nowhere.test');
    // The old sentence's exact failure: unmatched people folded into the skip.
    expect(msg).not.toMatch(/Granted to 7 of 10/);
  });

  it('says nothing about already-held grants when nobody was skipped', () => {
    const msg = grantSummary({ granted: 10, matched: 10, unmatched: [] });
    expect(msg).toBe('Granted to 10 of the 10 that matched.');
    expect(msg).not.toMatch(/already held/);
  });

  it('names unmatched entries but does not paste a wall of 500 of them', () => {
    const many = Array.from({ length: 25 }, (_, i) => `x${i}@school.edu`);
    const msg = grantSummary({ granted: 1, matched: 1, unmatched: many });
    expect(msg).toContain('25 matched no account');
    expect(msg).toContain('x0@school.edu');
    expect(msg).toContain('…');
    expect(msg).not.toContain('x24@school.edu');
  });
});

describe('the action is wired to the resolver, not to the old conditional', () => {
  it('grantToUsers resolves usernames AND emails, ungated', () => {
    expect(grantBody).toMatch(/resolveRecipients\(/);
    expect(grantBody).toMatch(/rpc\(\s*\n?\s*["']admin_find_user_ids["']/);

    // The defect itself was structural: `let ids` was filled from usernames and only
    // REASSIGNED from emails when the first pass came back empty. `ids` is now a const
    // derived from both maps at once, so the two-phase shape cannot come back.
    expect(grantBody).not.toMatch(/let\s+ids\b/);
    expect(grantBody).toMatch(/const\s*\{\s*ids\s*,\s*unmatched\s*\}\s*=\s*resolveRecipients\(/);

    // And the email lookup runs before anything counts ids, rather than behind a guard
    // on how many usernames matched.
    const emailLookup = grantBody.indexOf('admin_find_user_ids');
    const resolve = grantBody.indexOf('resolveRecipients(');
    const idsGuard = grantBody.indexOf('!ids.length');
    expect(emailLookup).toBeGreaterThan(-1);
    expect(emailLookup).toBeLessThan(resolve);
    expect(resolve).toBeLessThan(idsGuard);
  });

  it('does not resolve emails from a single unpaginated listUsers page', () => {
    // perPage: 1000 silently stops resolving anyone past the first thousand accounts,
    // which would have reproduced the same wrong message with no code change.
    expect(grantBody).not.toMatch(/listUsers/);
  });

  it('reports through grantSummary rather than an ad-hoc sentence', () => {
    expect(grantBody).toMatch(/grantSummary\(/);
    expect(grantBody).not.toMatch(/Anyone already holding it was skipped/);
  });

  it('records the unmatched entries in the audit row', () => {
    // The count alone does not say WHICH entries reached nobody, and admin_audit_log is
    // where a later reader looks when an operator says "they never got it".
    expect(grantBody).toMatch(/audit\([\s\S]*?unmatched[\s\S]*?\);/);
  });

  it('admin_find_user_ids is service_role only and returns one row per entry', () => {
    const mig = read(
      'supabase', 'migrations',
      '20260906092000_resolve_every_grant_recipient_not_just_the_first_kind.sql',
    );
    expect(mig).toMatch(/create or replace function public\.admin_find_user_ids/);
    // A lookup that answers "does this email have an account?" is an enumeration oracle.
    expect(mig).toMatch(/revoke execute on function public\.admin_find_user_ids\(text\[\]\) from public, anon, authenticated/);
    expect(mig).toMatch(/grant execute on function public\.admin_find_user_ids\(text\[\]\) to service_role/);
    // LEFT JOIN LATERAL is what makes a miss a row rather than an absence.
    expect(mig).toMatch(/left join lateral/);
  });
});
