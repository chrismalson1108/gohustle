// ─────────────────────────────────────────────────────────────────────────────
// The Messages badge and the Messages inbox must agree about who is blocked.
//
// Both clients build the unread-message badge from every earner and poster booking,
// and both hubs HIDE a conversation whose other party the reader has blocked. If the
// badge does not apply the same filter, a message that was unread at the moment of
// the block is counted forever: the conversation the hub hides can never be opened,
// so it can never be marked read. There is no unblock affordance on either client
// (`unblockUserDb` / `unblockUser` have no callers), so "until they unblock" is not
// an escape hatch — the badge is permanent.
//
// Mobile fixed this in src/context/JobsContext.js; the web port shipped without it
// (web/lib/jobs.tsx refreshUnread had no reference to blockedIds at all). This guard
// asserts the filter on BOTH sides so the next port cannot drop it again.
//
// It reads source off disk because the logic lives inside a React provider that a
// pure-logic Jest suite cannot mount — the same pattern parity.test.js uses.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

// The `refreshUnread` callback, from its declaration to the end of its dependency
// array. Slicing to the callback is what makes this discriminating: `blockedIds`
// appears elsewhere in both files (state, block actions, browse filtering), so a
// whole-file grep would pass on the broken version.
function refreshUnreadBlock(src) {
  const start = src.indexOf('const refreshUnread = useCallback(');
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf('useEffect(', start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

// The same region plus the counterparty map, wherever it is built. Mobile builds it
// inline inside the callback; web hoists it into a `counterparties` useMemo so the
// callback is not re-created on every jobs fetch. Both shapes are fine — what must
// not disappear is the resolution itself.
function badgeRegion(src) {
  const memo = src.indexOf('const counterparties');
  const cb = src.indexOf('const refreshUnread = useCallback(');
  const start = memo >= 0 ? Math.min(memo, cb) : cb;
  const end = src.indexOf('useEffect(', cb);
  return src.slice(start, end);
}

// Prose explains this defect at length in both files; assert on code, not comments.
const codeOnly = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const clients = {
  mobile: { file: 'src/context/JobsContext.js', hub: 'src/screens/MessagesScreen.js' },
  web: { file: 'web/lib/jobs.tsx', hub: 'web/app/(app)/messages/page.tsx' },
};

describe('the unread badge drops the conversations the inbox hides', () => {
  for (const [client, { file, hub }] of Object.entries(clients)) {
    describe(client, () => {
      const src = read(file);
      const block = codeOnly(refreshUnreadBlock(src));
      const region = codeOnly(badgeRegion(src));

      it('the hub hides blocked conversations (the premise)', () => {
        expect(codeOnly(read(hub))).toMatch(/blockedIds/);
      });

      it('refreshUnread consults blockedIds', () => {
        expect(block).toMatch(/blockedIds/);
      });

      it('refreshUnread FILTERS the conversation ids, not just reads the set', () => {
        // A `.filter(` between building the id list and counting is the whole fix.
        expect(block).toMatch(/\.filter\(/);
        expect(block).toMatch(/blockedIds\.has\(/);
      });

      it('blockedIds is in the dependency array, so a fresh block re-counts', () => {
        // Without it the badge keeps its stale count until the next bookings load.
        const deps = block.slice(block.lastIndexOf('}, ['));
        expect(deps).toMatch(/blockedIds/);
      });

      it('the counterparty is resolved from BOTH sides of the booking', () => {
        // Poster bookings carry the earner inline; an earner booking's poster comes
        // from the jobs feed. Resolving only one side leaves the other unfiltered.
        expect(region).toMatch(/earner\??\.(id)/);
        // The poster side may be resolved inline or through shared/lifecycle's
        // bookingPosterId(booking, jobs) — the mobile client uses the helper, which is
        // the same resolution the Messages hub and every notify() call site use. What
        // this guards is that BOTH sides are resolved, not which spelling does it.
        expect(region).toMatch(/posterId|bookingPosterId/i);
      });
    });
  }
});
