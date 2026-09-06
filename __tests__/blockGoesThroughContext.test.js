// ─────────────────────────────────────────────────────────────────────────────
// Every "Block this user" affordance must go through the jobs context, never
// straight to the blocks table.
//
// `blockedIds` is loaded exactly once per signed-in user (a useEffect keyed on
// user.id in web/lib/jobs.tsx and src/context/JobsContext.js) and is what Browse
// filters gigs with and what the Messages hub filters conversations with. The only
// in-context mutator is `blockUser`, which writes the row AND adds the id to the Set.
//
// The web public-profile page shipped calling `blockUserDb(user.id, id)` directly and
// then `router.push("/browse")`. That is a client-side transition inside the same
// (app) layout, so JobsProvider is never remounted and the Set is still stale: the
// page the user lands on immediately after blocking still lists the blocked poster's
// gigs, and /messages still shows the conversation, until a hard reload. The toast
// says "You won't see their gigs anymore" while they are on screen.
//
// The mobile screen and the web Messages hub already used the context method; only
// the web profile page did not. This guard asserts all of them so the next port
// cannot reintroduce it.
//
// It reads source off disk because the action lives inside a React component that a
// pure-logic Jest suite cannot mount — the same pattern parity.test.js uses.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

// Prose in these files discusses blockUserDb at length; assert on code, not comments.
const codeOnly = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// The block action itself, from its declaration to the next top-level `const`
// declaration after it. Slicing matters: `blockUser` / `blockUserDb` appear elsewhere
// in these files (imports, destructuring, the context mutator), so a whole-file grep
// would pass on the broken version — the defect was WHICH function the handler called.
function handlerBody(src, decl) {
  const start = src.indexOf(decl);
  expect(start).toBeGreaterThan(-1);
  const rest = src.slice(start + decl.length);
  const end = rest.search(/\n {2}const \w/);
  return decl + (end > -1 ? rest.slice(0, end) : rest);
}

const profiles = [
  { name: 'web public profile', file: 'web/app/(app)/u/[id]/page.tsx' },
  { name: 'mobile public profile', file: 'src/screens/PublicProfileScreen.js' },
];

describe('blocking someone updates blockedIds, not just the blocks table', () => {
  for (const { name, file } of profiles) {
    describe(name, () => {
      const src = codeOnly(read(file));
      const handler = handlerBody(src, 'const doBlock = async () => {');

      it('calls the context blockUser', () => {
        expect(handler).toMatch(/await blockUser\(/);
      });

      it('does not write the blocks row directly', () => {
        expect(handler).not.toMatch(/blockUserDb/);
        expect(handler).not.toMatch(/from\(["']blocks["']\)/);
      });

      it('destructures blockUser off the jobs context', () => {
        const line = src.split('\n').find((l) => l.includes('useJobs()'));
        expect(line).toBeDefined();
        expect(line).toMatch(/\bblockUser\b/);
      });
    });
  }

  it('the web Messages hub blocks through the context too', () => {
    const src = codeOnly(read('web/app/(app)/messages/page.tsx'));
    expect(src).toMatch(/await blockUser\(/);
    expect(src).not.toMatch(/blockUserDb/);
  });

  it('the context mutator is the only web caller of blockUserDb, and it updates the Set', () => {
    const src = codeOnly(read('web/lib/jobs.tsx'));
    const fn = handlerBody(src, 'const blockUser = async (blockedId: string) => {');
    expect(fn).toMatch(/blockUserDb\(/);
    expect(fn).toMatch(/setBlockedIds\(/);
  });
});
