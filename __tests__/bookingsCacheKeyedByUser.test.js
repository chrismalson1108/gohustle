// The bookings cache must be keyed per ACCOUNT, and a load that outlives its account
// must not write anything.
//
// Both clients used one constant key, 'bookings_v1', for every account on the device:
// loadBookings read it and dispatched whatever was there with no user check, then wrote
// it back AFTER an awaited, unbounded network fetch with no check that the same user was
// still signed in. Two ways the previous user's bookings then reached the next one:
//
//   (1) a bookings query still in flight at sign-out (EarnScreen refreshes on every
//       focus and the query has no .limit) completes afterwards — the access token stays
//       valid after a scope:'local' sign-out, so the request succeeds — and writes the
//       previous account's bookings back into the shared key;
//   (2) cacheClear() throws inside AsyncStorage and silently does nothing.
//
// Either way the next account's My Jobs, Earn badge and booked-gig cards were seeded
// from a stranger's bookings — their application notes, counter-offers and slot labels —
// for the whole 5-minute TTL, and for the whole session if that account's own fetch
// errored (loadBookings returns on error and leaves the cached list in place).
//
// UserContext has done this correctly since it was written: `profile_${userId}` plus an
// `activeUserId` ref re-checked after every await. This guard pins the same two
// properties onto the bookings path in both clients.

const fs = require('fs');
const path = require('path');

const mobile = fs.readFileSync(path.join(__dirname, '..', 'src', 'context', 'JobsContext.js'), 'utf8');
const web = fs.readFileSync(path.join(__dirname, '..', 'web', 'lib', 'jobs.tsx'), 'utf8');
const userCtx = fs.readFileSync(path.join(__dirname, '..', 'src', 'context', 'UserContext.js'), 'utf8');

describe('bookings cache key carries the user id', () => {
  test('mobile derives the key from the account, never a constant', () => {
    expect(mobile).toMatch(/const bookingsCacheKey = \(userId\) => `bookings_\$\{userId\}`;/);
    expect(mobile).toMatch(/const cacheKey = bookingsCacheKey\(uid\);/);
    // The shared key may survive ONLY as the legacy value being removed.
    expect(mobile).not.toMatch(/const BOOKINGS_CACHE\s*=\s*'bookings_v1'/);
    expect(mobile).toMatch(/cacheRemove\(LEGACY_BOOKINGS_CACHE\)/);
  });

  test('web derives the key from the account too', () => {
    expect(web).toMatch(/const bookingsCacheKey = \(userId: string\) => `bookings_\$\{userId\}`;/);
    expect(web).toMatch(/const cacheKey = bookingsCacheKey\(uid\);/);
    expect(web).not.toMatch(/const BOOKINGS_CACHE\s*=\s*"bookings_v1"/);
    expect(web).toMatch(/cacheRemove\(LEGACY_BOOKINGS_CACHE\)/);
  });

  test('neither client reads or writes the bookings cache under a bare constant', () => {
    expect(mobile).not.toMatch(/cache(Get|Set)\(BOOKINGS_CACHE/);
    expect(web).not.toMatch(/cache(Get|Set)<[^>]*>?\(BOOKINGS_CACHE/);
  });
});

describe('a load that outlives its account writes nothing', () => {
  test('mobile pins the account and re-checks it after the awaits', () => {
    expect(mobile).toMatch(/const activeUserId = useRef\(null\);\s*\n\s*activeUserId\.current = user\?\.id \?\? null;/);
    expect(mobile).toMatch(/const uid = user\.id;/);
    // Cached dispatch is guarded…
    expect(mobile).toMatch(/if \(cached\?\.length && activeUserId\.current === uid\) dispatch\(\{ type: 'SET_BOOKINGS'/);
    // …and so is everything after the network await.
    expect(mobile).toMatch(/if \(activeUserId\.current !== uid\) return; \/\/ signed out \/ switched accounts mid-flight/);
  });

  test('web pins the account the same way', () => {
    expect(web).toMatch(/const activeUserId = useRef<string \| null>\(null\);\s*\n\s*activeUserId\.current = user\?\.id \?\? null;/);
    expect(web).toMatch(/if \(cached\?\.length && activeUserId\.current === uid\) dispatch\(\{ type: "SET_BOOKINGS"/);
    expect(web).toMatch(/if \(activeUserId\.current !== uid\) return; \/\/ signed out \/ switched accounts mid-flight/);
  });

  test('the pattern is the one UserContext already proved out', () => {
    // If this ever stops being true, the comment in JobsContext points at a ghost.
    expect(userCtx).toContain('const cacheKey = `profile_${userId}`;');
    expect(userCtx).toContain('if (activeUserId.current !== userId) return;');
  });
});
