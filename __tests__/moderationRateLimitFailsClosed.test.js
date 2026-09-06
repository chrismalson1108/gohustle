// Image moderation must not be switchable off by its own rate limiter.
//
// moderate-image caps a user at 20 calls/min and 500/day. That branch used to
// answer HTTP 429 `{ error: 'rate_limited' }`, and supabase-js surfaces any
// non-2xx as a FunctionsHttpError with `data === null`. Both image wrappers only
// blocked on `!error && data.allowed === false`, so the 429 fell into their
// fail-open branch: `console.warn('moderateOrThrow: ...')` and the upload
// completed — object already in Storage, public URL written to
// profiles.avatar_url / jobs.photos / certifications.image_url, rendered to every
// user, no moderation_flags row, no auto-report.
//
// So: upload one benign photo, spend the rest of the minute on junk calls against
// your own path, then upload anything. Image moderation is the ONLY scanning layer
// images have — there is no keyword equivalent for pixels. moderateText() has
// failed CLOSED on 429 since the identical hole was closed on the text path
// (src/lib/moderation.js: "A 429 is SELF-INFLICTED ... Rating limiting a safety
// control must not disable it"); the image path never got that change.
//
// These tests fail on the old code: the behavioural ones because uploadImage()
// resolved with a public URL under both rate-limited shapes, and the source ones
// because the function returned a 429 and neither wrapper knew what a 429 was.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// ---------------------------------------------------------------------------
// Behavioural: the real mobile uploader, with Storage and the edge call mocked.
// ---------------------------------------------------------------------------

// Mutable so each test can set the moderate-image reply.
const invokeResult = { data: null, error: null };
const removed = [];

jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  ActionSheetIOS: { showActionSheetWithOptions: () => {} },
  Alert: { alert: () => {} },
}));
jest.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: async () => ({ canceled: true }),
  launchCameraAsync: async () => ({ canceled: true }),
  requestCameraPermissionsAsync: async () => ({ granted: false }),
}));
jest.mock('expo-image-manipulator', () => ({
  manipulateAsync: async () => ({ uri: 'file:///tmp/manipulated.jpg' }),
  SaveFormat: { JPEG: 'jpeg' },
}));
// Shape only — beforeAll swaps in implementations that read `invokeResult`.
jest.mock('../src/lib/supabase', () => ({
  supabase: { storage: { from: () => ({}) }, functions: { invoke: async () => ({}) } },
}));

describe('uploadImage() blocks on the caller\'s own moderation rate limit', () => {
  let uploadImage;

  beforeAll(() => {
    // A stalled-call timeout of 8s lives inside moderateOrThrow; the invoke always
    // wins the race here, and fake timers keep the loser from outliving the test.
    jest.useFakeTimers();
    global.fetch = async () => ({ arrayBuffer: async () => new ArrayBuffer(64) });
    // eslint-disable-next-line global-require
    const supabaseMock = require('../src/lib/supabase').supabase;
    supabaseMock.functions.invoke = async () => ({ data: invokeResult.data, error: invokeResult.error });
    supabaseMock.storage.from = () => ({
      upload: async () => ({ error: null }),
      remove: async (paths) => { removed.push(...paths); return { error: null }; },
      getPublicUrl: (p) => ({ data: { publicUrl: `https://cdn.example/avatars/${p}` } }),
    });
    // eslint-disable-next-line global-require
    uploadImage = require('../src/lib/uploadImage').uploadImage;
  });

  afterAll(() => { jest.useRealTimers(); });

  const call = () => uploadImage({ uri: 'file:///tmp/a.jpg', bucket: 'avatars', userId: 'u-1' });

  test('the 200 body shape the function now returns is a block, not an allow', async () => {
    invokeResult.data = { allowed: false, reason: 'rate_limited', error: 'rate_limited' };
    invokeResult.error = null;
    await expect(call()).rejects.toThrow(/wait a minute/i);
  });

  test('a raw 429 from an older deployment (or the gateway) is a block too', async () => {
    // supabase-js FunctionsHttpError shape: data null, Response on error.context.
    invokeResult.data = null;
    invokeResult.error = Object.assign(new Error('Edge Function returned a non-2xx status code'), {
      context: { status: 429 },
    });
    await expect(call()).rejects.toThrow(/wait a minute/i);
  });

  test('the rate-limited message does not accuse the user of a policy violation', async () => {
    invokeResult.data = { allowed: false, reason: 'rate_limited', error: 'rate_limited' };
    invokeResult.error = null;
    await expect(call()).rejects.not.toThrow(/content policy/i);
  });

  test('a genuine policy verdict still blocks, with the policy wording', async () => {
    invokeResult.data = { allowed: false, categories: ['sexual'], reason: 'explicit' };
    invokeResult.error = null;
    await expect(call()).rejects.toThrow(/content policy/i);
  });

  test('an outage the user cannot arrange STILL fails open (unchanged)', async () => {
    invokeResult.data = null;
    invokeResult.error = Object.assign(new Error('FetchError: network down'), { context: { status: 503 } });
    await expect(call()).resolves.toMatch(/^https:\/\/cdn\.example\/avatars\/u-1\//);
  });

  test('a clean allow returns the public URL (unchanged)', async () => {
    invokeResult.data = { allowed: true };
    invokeResult.error = null;
    await expect(call()).resolves.toMatch(/^https:\/\/cdn\.example\/avatars\/u-1\//);
  });
});

// ---------------------------------------------------------------------------
// Source: the function's own verdict, and the web wrapper (not reachable from
// this Jest project — testPathIgnorePatterns excludes /web/ and it imports the
// Next-only Supabase client).
// ---------------------------------------------------------------------------

describe('moderate-image answers its own rate limit with a verdict, not a status', () => {
  const src = fs.readFileSync(path.join(ROOT, 'supabase/functions/moderate-image/index.ts'), 'utf8');
  const branch = src.slice(src.indexOf('(perMin ?? 0) > 20'), src.indexOf('Opportunistic cleanup'));
  // The branch carries a long comment that quotes the old, broken return, so the
  // assertions below run against code only.
  const code = branch.replace(/\/\/[^\n]*/g, '');

  test('finds the rate-limit branch', () => {
    expect(code).toMatch(/return json\(/);
  });

  test('returns allowed:false', () => {
    expect(code).toMatch(/allowed:\s*false/);
  });

  test('does not return a bare 429, which every fail-open wrapper reads as allowed', () => {
    // The status argument to json() is what made this a kill switch.
    expect(code).not.toMatch(/\},\s*429\s*\)/);
  });

  test('the branch still sits ahead of the download, so the cost guard is intact', () => {
    expect(src.indexOf('(perMin ?? 0) > 20')).toBeLessThan(src.indexOf('.storage.from(bucket).download('));
  });
});

describe('both image wrappers treat a rate limit as a block', () => {
  const mobile = fs.readFileSync(path.join(ROOT, 'src/lib/uploadImage.js'), 'utf8');
  const web = fs.readFileSync(path.join(ROOT, 'web/lib/uploadImage.ts'), 'utf8');

  for (const [name, src] of [['mobile', mobile], ['web', web]]) {
    describe(name, () => {
      test('imports the shared isRateLimited rather than re-deriving it', () => {
        expect(src).toMatch(/import \{ isRateLimited \} from ["']\.\/moderation["']/);
      });

      test('throws on a rate-limited reply', () => {
        const i = src.indexOf('isRateLimited(');
        const j = src.indexOf('allowed === false');
        expect(i).toBeGreaterThan(-1);
        // The rate-limit test must come BEFORE the allowed-false test: a 429 leaves
        // data null, so the allowed-false branch can never reach it.
        expect(i).toBeLessThan(j);
        expect(src.slice(i, j)).toMatch(/throw e;/);
      });
    });
  }

  test('isRateLimited is exported from both moderation modules (one definition per platform)', () => {
    expect(fs.readFileSync(path.join(ROOT, 'src/lib/moderation.js'), 'utf8'))
      .toMatch(/export function isRateLimited\(/);
    expect(fs.readFileSync(path.join(ROOT, 'web/lib/moderation.ts'), 'utf8'))
      .toMatch(/export function isRateLimited\(/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The same class, on the TEXT side. Merged 2026-09-05: two fixes landed on one
// filename because moderate-image and moderate-text failed open on a 429 the same
// way, in different call paths. Neither half subsumes the other — images have no
// keyword backstop, and the text side additionally covers the calls Hustlr AI makes
// on a user's behalf against that user's own quota.
// ─────────────────────────────────────────────────────────────────────────────

{
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
}
