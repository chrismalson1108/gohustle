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

// ─────────────────────────────────────────────────────────────────────────────
// Which support conversation the user is shown.
//
// This became load-bearing the moment support could START a thread (a flag, a
// dispute, a payout). Before that, "the newest non-closed one" was always right
// because the user had opened every thread themselves.
// ─────────────────────────────────────────────────────────────────────────────
jest.mock('../src/lib/supabase', () => ({ supabase: {} }));
const { pickActiveTicket, groupTickets, ticketHasUnread } = require('../src/lib/support');

const T = (o = {}) => ({
  id: o.id ?? 1,
  status: o.status ?? 'open',
  archived_at: o.archived_at ?? null,
  last_message_at: o.last_message_at ?? '2026-08-12T10:00:00Z',
  user_read_at: o.user_read_at ?? '2026-08-12T10:00:00Z',
  ...o,
});
const unread = (o = {}) => T({ ...o, user_read_at: null });

describe('pickActiveTicket', () => {
  it('opens the thread with something new in it, even when another is newer', () => {
    // The agent-opened case: we push "support replied", so the thread we push about
    // must be the one that opens. Anything else is a dead-end notification.
    const chosen = pickActiveTicket([T({ id: 1 }), unread({ id: 2 })]);
    expect(chosen.id).toBe(2);
  });

  it('opens an unread CLOSED thread over a read open one', () => {
    // An agent adding a note to a resolved ticket deliberately leaves it closed so it
    // does not re-enter their queue. Status alone would then open the wrong thread.
    const chosen = pickActiveTicket([T({ id: 1, status: 'open' }), unread({ id: 2, status: 'closed' })]);
    expect(chosen.id).toBe(2);
  });

  it('falls back to the live conversation when nothing is unread', () => {
    expect(pickActiveTicket([T({ id: 1, status: 'closed' }), T({ id: 2, status: 'open' })]).id).toBe(2);
  });

  it('still shows history rather than nothing when everything is closed', () => {
    expect(pickActiveTicket([T({ id: 9, status: 'closed' })]).id).toBe(9);
  });

  it('returns null for a user who has never contacted support', () => {
    expect(pickActiveTicket([])).toBeNull();
  });
});

describe('groupTickets', () => {
  it('never lists the thread already on screen', () => {
    const g = groupTickets([T({ id: 1 }), T({ id: 2 })], 1);
    expect(g.live.concat(g.archived).map(t => t.id)).toEqual([2]);
  });

  it('keeps an unread thread out of the collapsed archive', () => {
    // The whole point: a message we just sent a push about must not be hidden behind
    // a toggle because its status happens to be closed or the user archived it.
    const g = groupTickets([unread({ id: 2, status: 'closed', archived_at: '2026-08-01T00:00:00Z' })], 1);
    expect(g.live.map(t => t.id)).toEqual([2]);
    expect(g.archived).toHaveLength(0);
  });

  it('files a read, resolved thread as archive', () => {
    const g = groupTickets([T({ id: 2, status: 'closed' })], 1);
    expect(g.archived.map(t => t.id)).toEqual([2]);
    expect(g.live).toHaveLength(0);
  });

  it('treats a user-archived but still-open thread as archive', () => {
    // Archiving is the user's "put this away"; it is theirs to make until we say
    // something new.
    const g = groupTickets([T({ id: 2, status: 'open', archived_at: '2026-08-01T00:00:00Z' })], 1);
    expect(g.archived.map(t => t.id)).toEqual([2]);
  });

  it('puts every thread in exactly one group', () => {
    const all = [T({ id: 2 }), unread({ id: 3, status: 'closed' }), T({ id: 4, status: 'closed' })];
    const g = groupTickets(all, 1);
    expect(g.live.length + g.archived.length).toBe(3);
    expect(g.live.filter(t => g.archived.includes(t))).toHaveLength(0);
  });
});

describe('ticketHasUnread', () => {
  it('ignores your own reply arriving', () => {
    expect(ticketHasUnread(T({ last_message_at: '2026-08-12T10:00:00Z', user_read_at: '2026-08-12T10:00:00Z' }))).toBe(false);
  });
  it('flags a thread the user has never opened', () => {
    expect(ticketHasUnread(unread())).toBe(true);
  });
});
