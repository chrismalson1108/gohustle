/**
 * Rate limiting a safety control must not disable it.
 *
 * moderate-text's quota lives in `moderation_rate` and is PER USER — 20/min, 500/day
 * — and the assistant forwards the caller's own JWT, so a user's direct calls and the
 * ones Hustlr AI makes on their behalf draw on one bucket. `moderateViaEdge` returned
 * "allowed" for any `!res.ok`, the 429 included, so burning your own quota with junk
 * calls switched the Claude layer off for everything the assistant would then write
 * for you in that minute: create_gig (staged with only the keyword filter behind it,
 * then posted on a tap), update_profile's bio and work-status note, and `remember` —
 * whose text is replayed into the system prompt of every later conversation.
 *
 * src/lib/moderation.js was fixed for exactly this reasoning ("a 429 is
 * SELF-INFLICTED … the rate limiter became a self-service kill switch"), while the
 * comment on moderateViaEdge still claimed to mirror that wrapper. Both sides are
 * asserted here so they cannot drift apart again.
 */
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const fn = read('supabase/functions/assistant/index.ts');
const wrapper = read('src/lib/moderation.js');
const moderateText = read('supabase/functions/moderate-text/index.ts');

const moderateViaEdge = (() => {
  const i = fn.indexOf('async function moderateViaEdge');
  if (i < 0) throw new Error('moderateViaEdge not found in the assistant function');
  // Up to the next top-level declaration after it.
  const end = fn.indexOf('\nconst ANTHROPIC_URL', i);
  if (end < i) throw new Error('could not bound moderateViaEdge');
  return fn.slice(i, end);
})();

describe('moderate-text still answers a quota breach with a 429', () => {
  // The premise of everything below. If this ever stops being true the branch the
  // assistant now takes is unreachable and this whole guard is decorative.
  it('returns { error: rate_limited } with status 429, before the classifier runs', () => {
    expect(moderateText).toMatch(/return json\(\{ error: 'rate_limited' \}, 429\)/);
    const limit = moderateText.indexOf("error: 'rate_limited'");
    const classify = moderateText.indexOf('fetch(ANTHROPIC_URL');
    expect(limit).toBeLessThan(classify);
  });
});

describe('the assistant fails CLOSED on a 429', () => {
  it('the old blanket fail-open on any non-2xx is gone', () => {
    expect(moderateViaEdge).not.toMatch(/if \(!res\.ok\) return true;/);
  });

  it('a 429 — by status or by body marker — is not allowed', () => {
    expect(moderateViaEdge).toMatch(
      /res\.status === 429[\s\S]{0,60}rate_limited'[\s\S]{0,120}allowed: false, rateLimited: true/,
    );
  });

  it('the 429 check runs BEFORE the remaining fail-open branch', () => {
    const closed = moderateViaEdge.indexOf('res.status === 429');
    const open = moderateViaEdge.indexOf('if (!res.ok) return { allowed: true }');
    expect(closed).toBeGreaterThan(-1);
    expect(open).toBeGreaterThan(closed);
  });

  it('still fails OPEN on an outage or a timeout', () => {
    // A provider hiccup must never wedge posting — that half was always right.
    expect(moderateViaEdge).toMatch(/if \(!res\.ok\) return \{ allowed: true \};/);
    expect(moderateViaEdge).toMatch(/catch \{[\s\S]{0,120}return \{ allowed: true \}/);
  });
});

describe('every surface the assistant writes handles the quota answer', () => {
  // create_gig, update_profile and remember. Each must stop, and none may report it
  // as prohibited content — the user did not write anything banned.
  const CALLS = [...fn.matchAll(/moderateViaEdge\(token, [^)]*\)/g)];

  it('there are three call sites and every one is verdict-shaped', () => {
    expect(CALLS).toHaveLength(3);
    // No call site may test the verdict object for truthiness: an object is always
    // truthy, so `if (!(await moderateViaEdge(...)))` would silently allow everything.
    expect(fn).not.toMatch(/!\(await moderateViaEdge\(/);
  });

  it('each call site returns the rate-limited reply', () => {
    const guards = [...fn.matchAll(/Verdict\.rateLimited\) return RATE_LIMITED_REPLY;/g)];
    expect(guards).toHaveLength(3);
  });

  it('the rate-limited reply does not accuse the user of prohibited content', () => {
    const i = fn.indexOf('const RATE_LIMITED_REPLY');
    const reply = fn.slice(i, fn.indexOf('});', i));
    expect(reply).toMatch(/error: 'rate_limited'/);
    expect(reply).not.toMatch(/prohibited/i);
    expect(reply).toMatch(/safety check/i);
  });
});

describe('the client wrapper it claims to mirror behaves the same way', () => {
  it('src/lib/moderation.js also fails closed on 429', () => {
    expect(wrapper).toMatch(/if \(isRateLimited\(error, data\)\) \{[\s\S]{0,120}allowed: false/);
  });

  it('and open on an outage', () => {
    expect(wrapper).toMatch(/if \(error \|\| !data\) return \{ allowed: true \}/);
  });
});
