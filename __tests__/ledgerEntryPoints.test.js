const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// A ROUTE REGISTERED IN A STACK THAT NOTHING IN THAT STACK NAVIGATES TO.
//
// `Payments` (nav title "Transactions") was registered in HomeStack's sibling
// GigsStack from the day the ledger shipped, and nothing on the Hire tab ever
// navigated to it. CLAUDE.md recorded the consequence in its own words — "a poster
// cannot reach their own ledger from the Hire tab. That is a gap, not a design" —
// and it sat there, because a registration that no caller uses looks exactly like a
// working feature from every angle except a user's.
//
// Registering a screen in a stack is a claim that someone in that stack can get to
// it. This test makes the claim checkable: for every route a stack registers, some
// screen in the SAME stack must navigate to it by name, or the route must be excused
// here with the reason.
// ─────────────────────────────────────────────────────────────────────────────
const ROOT = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(ROOT, 'App.js'), 'utf8');

// `import GigsScreen from './src/screens/GigsScreen';` → component name → file.
const FILE_OF = Object.fromEntries(
  [...app.matchAll(/^import\s+(\w+)\s+from\s+'(\.\/src\/screens\/[^']+)';/gm)]
    .map((m) => [m[1], m[2]]),
);

const stacks = [...app.matchAll(/function (\w+Stack)\(\) \{([\s\S]*?)\n\}/g)].map(([, name, body]) => ({
  name,
  screens: [...body.matchAll(/<Stack\.Screen\s+name="(\w+)"\s+component=\{(\w+)\}/g)]
    .map((m) => ({ route: m[1], component: m[2] })),
}));

// A route reached from OUTSIDE its own stack, or deliberately not reached at all.
// Anything listed here needs a reason, and the reason has to still be true.
const EXCUSED = {
  // CLAUDE.md: "Registered in ProfileStack but unreachable — nothing navigates to it;
  // the last entry point was deleted in bc5cc0a. GigsScreen superseded it. Delete it
  // or re-link it; don't build against it." Excused as a KNOWN dead registration, not
  // a healthy one.
  ManageBookings: 'documented dead registration — GigsScreen superseded it',
  // CLAUDE.md: "route Chat, registered in every stack". The live caller is
  // MessagesScreen; the sibling registrations exist so the name resolves from whichever
  // stack a conversation is opened in. The other stacks host the chat as the
  // MessageSheet modal instead of pushing this route.
  Chat: 'registered in every stack on purpose; the caller is MessagesScreen',
  // Reached from GigsScreen (GigsStack). ProfileStack registers it for the same
  // resolve-from-anywhere reason as Chat.
  EditJob: 'the caller is GigsScreen; ProfileStack registers it so the name resolves',
};

// Where a screen in this stack can send you: navigation.navigate('X') / go('X') /
// navigate('X', { … }), in any of the stack's own screen files.
const navTargets = (files) => {
  // The imports are extensionless; every screen is a .js file.
  const src = files.map((f) => fs.readFileSync(path.join(ROOT, `${f}.js`), 'utf8')).join('\n');
  return new Set([...src.matchAll(/(?:navigate|go)\(\s*'(\w+)'/g)].map((m) => m[1]));
};

describe('every route a stack registers can be reached from inside that stack', () => {
  it('parses App.js', () => {
    expect(stacks.map((s) => s.name).sort())
      .toEqual(['EarnStack', 'GigsStack', 'HomeStack', 'MessagesStack', 'ProfileStack']);
    expect(Object.keys(FILE_OF).length).toBeGreaterThan(20);
  });

  stacks.forEach(({ name, screens }) => {
    it(`${name}`, () => {
      const files = screens.map((s) => FILE_OF[s.component]).filter(Boolean);
      const reachable = navTargets(files);
      const orphans = screens
        .slice(1) // index 0 is the stack root
        .map((s) => s.route)
        .filter((r) => !reachable.has(r) && !(r in EXCUSED));
      expect(`${name} registers unreachable: ${orphans.join(', ') || 'none'}`)
        .toBe(`${name} registers unreachable: none`);
    });
  });
});

// The specific one this file was written for. Kept as its own assertion because the
// generic check above would go quiet the moment somebody excused the route instead of
// linking it, and the ledger is the poster's only record of what they were charged.
describe('a poster can reach their own ledger from the Hire tab', () => {
  it('GigsScreen navigates to Payments', () => {
    const gigs = fs.readFileSync(path.join(ROOT, 'src/screens/GigsScreen.js'), 'utf8');
    expect(gigs).toMatch(/navigate\('Payments'\)/);
  });

  it('and Payments is registered in GigsStack, so that call resolves', () => {
    const gigsStack = stacks.find((s) => s.name === 'GigsStack');
    expect(gigsStack.screens.map((s) => s.route)).toContain('Payments');
  });
});
