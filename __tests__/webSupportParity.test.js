// ─────────────────────────────────────────────────────────────────────────────
// Signed-in web support was a `mailto:`, and mobile deleted its own three for a
// stated reason: "NO beta tester's request would ever have entered the ticket
// system: it would land in a personal inbox, unassignable, un-triageable, with no
// status and no record that it was answered."
//
// The web had exactly that failure and one worse property. The only web surface that
// reached support-submit was /contact, linked from the marketing footer and from
// nowhere a signed-in user goes — and even a ticket filed there could not be READ
// back: no web code touched support_tickets or support_ticket_messages. The agent's
// answer went out by email with `reply_to = mainmail@` and "reply to this email";
// nothing in this repo ingests inbound mail, so the reply landed in a mailbox where
// `last_author` never flips, the reopen rule never fires, ctl_support_ticket_unanswered
// stays blind, and an agent's attachment is a signed URL into the private
// support-photos bucket inside an app the user never installed.
//
// supportIntake.test.js pins the MOBILE screens to the in-app form. This is the same
// guard for the web, plus the property the fix rests on: the "which thread do I show"
// rules live once, in shared/support.js, so the two clients cannot show one person
// two different active conversations.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const exists = (p) => fs.existsSync(path.join(ROOT, p));
const read = (p) => (exists(p) ? fs.readFileSync(path.join(ROOT, p), 'utf8') : `MISSING FILE: ${p}`);

// Strip comments before asserting. These files legitimately EXPLAIN in prose why they
// no longer use mailto:, and a raw /mailto:/ scan flags the documentation as the very
// regression it documents — the same trap supportIntake.test.js already dodges.
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('signed-in web support reaches the ticket queue', () => {
  const SIGNED_IN = [
    ['settings', 'web/app/(app)/settings/page.tsx'],
    ['profile', 'web/app/(app)/profile/page.tsx'],
  ];

  test.each(SIGNED_IN)('the %s hub no longer sends support to a mailto:', (_name, file) => {
    const src = stripComments(read(file));
    // A row whose destination is a mailto: bypasses support_tickets entirely.
    // Targets the ROW's href rather than the substring: settings/page.tsx keeps a
    // generic `href.startsWith("mailto:")` branch in its Row renderer, which is
    // plumbing for any future non-app scheme and not a support path.
    expect(src).not.toMatch(/href:\s*`?mailto:/);
    expect(src).not.toMatch(/(?:external)?[Hh]ref=\{?`?mailto:/);
    // And neither hub reaches for the inbox address at all any more.
    expect(src).not.toMatch(/SUPPORT_EMAIL/);
  });

  test.each(SIGNED_IN)('the %s hub links the in-app Support page', (_name, file) => {
    expect(read(file)).toMatch(/"\/support"/);
  });

  test('the Support page exists', () => {
    expect(exists('web/app/(app)/support/page.tsx')).toBe(true);
  });

  test('Messages pins a Support conversation, as mobile does', () => {
    // Support is pinned above gig conversations rather than sorted among them: it is
    // the thread you look for when something has already gone wrong.
    const msgs = read('web/app/(app)/messages/page.tsx');
    expect(msgs).toMatch(/GoHustlr Support/);
    expect(msgs).toMatch(/href="\/support"/);
  });

  test('/contact still exists for signed-OUT visitors', () => {
    // The public form is not the thing being replaced — a visitor with no account
    // still needs a way in, and it already files a real ticket.
    expect(exists('web/app/contact/page.tsx')).toBe(true);
  });
});

describe('the web can read the conversation back, not just write to it', () => {
  const lib = read('web/lib/support.ts');

  test('reads both ticket tables', () => {
    // Before this file, `grep -rn support_ticket web/` returned nothing — support was
    // write-only on the web, which is what makes support feel absent even when
    // someone is answering.
    expect(lib).toMatch(/from\("support_tickets"\)/);
    expect(lib).toMatch(/from\("support_ticket_messages"\)/);
  });

  test('a user reply is an INSERT on the thread, which reopens it server-side', () => {
    expect(lib).toMatch(/insert\(\{ ticket_id: ticketId, body: text, images \}\)/);
    // `text`, not `text || null`: body is NOT NULL, so a photo-only reply — which the
    // guard explicitly permits — would insert null and fail every time.
    expect(lib).not.toMatch(/body: text \|\| null/);
  });

  test('archiving and closing are separate operations', () => {
    // Archiving is the user's inbox preference; closing is the team's workflow state.
    // Conflating them is what makes an agent's queue disagree with the user's inbox.
    expect(lib).toMatch(/archived_at:/);
    expect(lib).toMatch(/status: "closed"/);
  });

  test('the reply-to address comes from the session, not a form field', () => {
    // Otherwise a user could file a ticket under someone else's address from inside
    // the app. getSession() (local, cached) rather than getUser() (a round-trip),
    // because contacting support happens disproportionately on a bad connection.
    expect(lib).toMatch(/supabase\.auth\.getSession\(\)/);
    expect(lib).not.toMatch(/supabase\.auth\.getUser\(\)/);
  });

  test('the first message still goes through support-submit', () => {
    // That is what attributes the ticket to the signed-in user — the JWT invoke
    // attaches is how support_tickets.user_id gets set.
    expect(lib).toMatch(/functions\.invoke\("support-submit"/);
  });

  test('agent attachments render as signed URLs, never getPublicUrl', () => {
    // support-photos is a PRIVATE bucket; getPublicUrl returns a URL that 400s.
    const page = read('web/app/(app)/support/page.tsx');
    expect(page).toMatch(/SignedPhotoStrip/);
    expect(page).toMatch(/bucket="support-photos"/);
    // Stripped, because the page's own comment says "never getPublicUrl" and a raw
    // scan would flag the warning as the regression it warns about.
    expect(stripComments(page)).not.toMatch(/getPublicUrl/);
  });
});

describe('the thread-selection rules exist exactly once', () => {
  const shared = read('shared/support.js');
  const mobile = read('src/lib/support.js');
  const web = read('web/lib/support.ts');

  ['ticketHasUnread', 'pickActiveTicket', 'groupTickets'].forEach((fn) => {
    it(`${fn} is defined in shared/support.js and nowhere else`, () => {
      const defined = (src) => new RegExp(`function ${fn}\\s*\\(`).test(src);
      expect(`${fn} shared:${defined(shared)} mobile:${defined(mobile)} web:${defined(web)}`)
        .toBe(`${fn} shared:true mobile:false web:false`);
    });
  });

  it('the topic list is shared too', () => {
    // priority and booking_id are per-TICKET, so the topic decides routing. Two
    // vocabularies would route the same complaint to two different queues.
    expect(shared).toMatch(/export const SUPPORT_CATEGORIES/);
    expect(mobile).toMatch(/export \{ SUPPORT_CATEGORIES[^}]*\} from '\.\.\/\.\.\/shared\/support'/);
    expect(web).toMatch(/SUPPORT_CATEGORIES,/);
  });

  it('shared/support.js is on the web barrel', () => {
    expect(read('shared/index.js')).toMatch(/export \* from '\.\/support\.js';/);
  });
});

describe('the runbook says where tickets actually land', () => {
  const runbook = read('RUNBOOK_SAFETY.md');

  it('names both clients and the public form', () => {
    expect(runbook).toMatch(/support_tickets/);
    expect(runbook).toMatch(/\/contact/);
  });

  it('warns that an emailed reply cannot re-enter the ticket', () => {
    // The trap that made the old line dangerous rather than merely wrong: an agent
    // replying by email leaves the queue thinking the ticket is still waiting on us.
    expect(runbook).toMatch(/nothing ingests inbound mail/i);
    expect(runbook).toMatch(/never by email/i);
  });
});
