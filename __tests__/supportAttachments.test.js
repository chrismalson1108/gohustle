// ─────────────────────────────────────────────────────────────────────────────
// Support attachments have to survive the whole round trip.
//
// Three separate breaks, each invisible from the side that caused it:
//
//  1. A photo-only reply wrote `body: text || null` into a NOT NULL column
//     (20260705040000:32), so the one message shape the guard above it explicitly
//     permits could never be sent — surfacing as the generic "Could not send your
//     message. Please try again."
//  2. Photos on the FIRST message were uploaded to support-photos and then dropped:
//     SupportScreen never passed them, submitSupportRequest never accepted them, and
//     support-submit never inserted them. The body literally reads "See attached
//     photos." while the agent opens a thread with none.
//  3. support-photos' only SELECT policy requires the path's first segment to equal
//     auth.uid(), and the console writes agent attachments to `ticket-<id>/…`. That
//     string can never be a uuid, so a user could never load what an agent sent them.
//     The console signs with the service role, so staff always saw the file fine —
//     which is why it survived.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const lib = read('src', 'lib', 'support.js');
const screen = read('src', 'screens', 'SupportScreen.js');
const submit = read('supabase', 'functions', 'support-submit', 'index.ts');

describe('a photo-only support reply can be sent', () => {
  it('never writes null into the NOT NULL body column', () => {
    expect(lib).toMatch(/\.insert\(\{ ticket_id: ticketId, body: text, images \}\)/);
    expect(lib).not.toMatch(/body: text \|\| null/);
  });

  it('still allows a message that is photos only', () => {
    // The guard that makes the above reachable at all.
    expect(lib).toMatch(/if \(!text && images\.length === 0\) throw new SupportError/);
  });

  it('body is genuinely NOT NULL, so this is not a theoretical fix', () => {
    const sql = read('supabase', 'migrations', '20260705040000_admin_console_v2.sql');
    const table = sql.slice(sql.indexOf('create table if not exists public.support_ticket_messages'));
    expect(table.slice(0, 400)).toMatch(/body\s+text not null/);
  });
});

describe('photos on the first message reach the agent', () => {
  it('the screen passes what it just uploaded', () => {
    const call = screen.slice(screen.indexOf('await submitSupportRequest('));
    expect(call.slice(0, 500)).toMatch(/images: paths/);
  });

  it('the client forwards them to support-submit', () => {
    expect(lib).toMatch(/images: Array\.isArray\(images\) \? images\.slice\(0, 6\) : \[\]/);
  });

  it('support-submit accepts and stores them', () => {
    expect(submit).toMatch(/bookingId, jobId, images \} = await req\.json\(\)/);
    expect(submit).toMatch(/images: ticketImages/);
  });

  it('and only accepts the CALLER\'S OWN owner-scoped paths', () => {
    // A caller naming any path could otherwise pull another user's private photos
    // into a thread staff will read — the same check the dispute-evidence path makes.
    expect(submit).toMatch(/startsWith\(`\$\{userId\}\/`\)/);
    expect(submit).toMatch(/\.slice\(0, 6\)/);
  });
});

describe('a user can read the attachment an agent sent them', () => {
  const MIG = path.join(ROOT, 'supabase', 'migrations');
  const policy = fs
    .readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort()
    .map((f) => fs.readFileSync(path.join(MIG, f), 'utf8'))
    .filter((s) => /create policy support_photos_read_ticket/i.test(s))
    .pop();

  it('a ticket-scoped read policy exists', () => {
    expect(policy).toBeDefined();
    expect(policy).toMatch(/bucket_id = 'support-photos'/);
  });

  it('it authorizes on the ticket OWNER, not on the path alone', () => {
    // Trusting the path would let anyone read any thread by guessing an id.
    expect(policy).toMatch(/from public\.support_tickets t/);
    expect(policy).toMatch(/t\.user_id = auth\.uid\(\)/);
  });

  it('it is scoped to the ticket- prefix the console actually writes', () => {
    expect(policy).toMatch(/like 'ticket-%'/);
    const actions = read('admin', 'app', '(console)', 'support', 'actions.ts');
    expect(actions).toMatch(/`ticket-\$\{ticketId\}\//);
  });

  it('the pre-existing owner policy really could not match that path', () => {
    // If it could, this is fixing nothing.
    const orig = read('supabase', 'migrations', '20260806360000_support_two_way.sql');
    expect(orig).toMatch(/support_photos_read_own[\s\S]{0,300}foldername\(name\)\)\[1\] = auth\.uid\(\)::text/);
  });
});
