const fs = require('fs');
const path = require('path');

// The mobile app's only support path was three `mailto:` links — ProfileScreen,
// SettingsScreen and PayoutSetupScreen. support-submit, and therefore the whole
// support_tickets queue the admin console is built around (/support, /support/[id],
// replies, AI drafts, status triage), was reachable ONLY from web/app/contact.
//
// TestFlight is the beta channel. So in practice no beta tester's request would
// ever have entered the ticket system: it would arrive in a personal inbox,
// unattributed, un-triageable, with no status and no record it was answered — while
// the console showed an empty queue.
//
// This pins the mobile app to the in-app form.
const ROOT = path.join(__dirname, '..');
const SCREENS = ['ProfileScreen', 'SettingsScreen', 'PayoutSetupScreen'];

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// Strip comments before asserting. The screens legitimately EXPLAIN in prose why
// they no longer use mailto:, and a raw /mailto:/ scan flags that documentation as
// the very regression it documents.
const stripComments = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments, incl. the JSX {/* … */} form
    .replace(/^\s*\/\/.*$/gm, ''); //    whole-line // comments

describe('mobile support intake reaches the ticket queue', () => {
  test.each(SCREENS)('%s no longer sends support to a mailto:', (screen) => {
    const src = stripComments(read(`src/screens/${screen}.js`));
    // A mailto: in executable code here means a support path that bypasses
    // support_tickets — there is no other reason for these screens to open mail.
    expect(src).not.toMatch(/mailto:/);
  });

  // The mechanism moved: SupportSheet was a SECOND support UI, and it diverged the
  // moment the gig/payment picker was added to the screen and not the sheet — so
  // choosing "Payments & payouts" from Settings offered nothing to attach. There is now
  // one implementation, and these screens navigate to it.
  test.each(SCREENS)('%s opens the shared Support screen', (screen) => {
    const src = read(`src/screens/${screen}.js`);
    // SettingsScreen routes through its local `go(route, params)` helper, which is
    // `navigation.navigate` plus a haptic — so accept either spelling rather than
    // forcing one screen to write navigation differently to satisfy a test.
    expect(src).toMatch(/(?:navigate|go)\(\s*'Support'/);
    // The deleted sheet must not come back as a parallel path.
    expect(src).not.toContain('SupportSheet');
  });

  test('the Support route is registered everywhere those screens live', () => {
    // A navigate() to an unregistered route is a dead button that looks correct in
    // review and in a bundle. Settings, Profile and Payout Setup are all in
    // ProfileStack; the pinned row in Messages is in MessagesStack. Both need it, and
    // for a while only MessagesStack had it.
    const app = read('App.js');
    const stacks = app.split(/function \w+Stack\(\)/).slice(1);
    const withSupport = stacks.filter((s) => /name="Support"/.test(s)).length;
    expect(withSupport).toBeGreaterThanOrEqual(2);
  });

  test('there is exactly one support UI', () => {
    // Two implementations is what caused the picker to be missing from Settings.
    expect(fs.existsSync(path.join(ROOT, 'src/components/SupportSheet.js'))).toBe(false);
  });

  test('the support lib posts to the support-submit edge function', () => {
    const lib = read('src/lib/support.js');
    expect(lib).toContain("functions.invoke('support-submit'");
  });

  test('support-submit still attributes the ticket to the signed-in user', () => {
    // functions.invoke attaches the session JWT; the function uses it to set
    // support_tickets.user_id. If that branch ever goes away, in-app tickets stop
    // linking back to an account and the admin loses the one-click path from a
    // ticket to the reporter's profile.
    const fn = read('supabase/functions/support-submit/index.ts');
    expect(fn).toMatch(/auth\.getUser\(token\)/);
    expect(fn).toMatch(/user_id: userId/);
  });

  test('the reply-to address comes from the session, not the user', () => {
    // Resolved from the session so a user cannot file a ticket under someone else's
    // address from inside the app. Deliberately getSession() (local, cached) rather
    // than getUser() (a round-trip to the auth server): contacting support is
    // disproportionately something people do on a bad connection, and a failed
    // round-trip there produced an error naming an email field the sheet does not
    // render.
    const lib = read('src/lib/support.js');
    expect(lib).toMatch(/supabase\.auth\.getSession\(\)/);
    expect(lib).not.toMatch(/supabase\.auth\.getUser\(\)/);
  });
});
