// ─────────────────────────────────────────────────────────────────────────────
// A work queue may not decide what is in it after the window has already cut.
//
// /support asked for the 200 most recent open+pending tickets, ordered
// `last_message_at desc`, and then applied the actual queue predicate — the last
// message is the CUSTOMER's — to that array in JavaScript. The rows a
// newest-first limit cuts are the oldest, and on a queue whose whole promise is
// "the person waiting longest comes first" those are the rows it exists to show. Past
// 200 open tickets the tab reads "Nothing waiting on us" while people wait, and the
// "N waiting" badge, counted off the same truncated array, agrees with it.
//
// /bookings already fixed this exact shape and its comment says why: "the stuck
// bookings — old by definition, and the list is newest-first — were never in the page-0
// window, so the default queue rendered 'nothing needs attention' while the dashboard
// tile counted dozens."
//
// The ordering has to move server-side too, or the pager is incoherent — and that is
// what `priority_rank` is for, since PostgREST can only order by a column and
// `priority` is text that sorts high, low, normal, urgent. So the SQL rank and the
// console's notion of urgency are pinned to each other here, the same way pricing.test
// pins shared/pricing.js to its migration.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const codeOnly = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const PAGE = codeOnly(read('admin', 'app', '(console)', 'support', 'page.tsx'));
const MIGRATION = read(
  'supabase', 'migrations', '20260906015300_support_queue_orders_by_rank_in_the_database.sql',
);

describe('the needs-reply predicate is in the query', () => {
  it('filters last_author server-side', () => {
    expect(PAGE).toMatch(/\.eq\("last_author", "user"\)/);
  });

  it('does not decide the queue by filtering an already-truncated array', () => {
    // The exact line that produced the false negative.
    expect(PAGE).not.toMatch(/tickets\s*=\s*tickets\.filter\(waitingOnUs\)/);
    expect(PAGE).not.toMatch(/\.limit\(200\)/);
  });

  it('keeps waitingOnUs for the row BADGE, which is display and not selection', () => {
    // Removing it entirely would lose the "needs reply" pill on the other tabs.
    expect(PAGE).toMatch(/const waitingOnUs =/);
    expect(PAGE).toMatch(/waitingOnUs\(t\) \? <Pill/);
  });
});

describe('the page can reach every ticket, and says how many there are', () => {
  it('asks for an exact count', () => {
    expect(PAGE).toMatch(/count: "exact"/);
  });

  it('pages with a range rather than a bare limit', () => {
    expect(PAGE).toMatch(/\.range\(page \* PAGE_SIZE, page \* PAGE_SIZE \+ PAGE_SIZE - 1\)/);
    expect(PAGE).toMatch(/const pageHref = /);
  });

  it('renders a pager when there is more than one page', () => {
    expect(PAGE).toMatch(/\(count \?\? 0\) > \(page \+ 1\) \* PAGE_SIZE/);
    expect(PAGE).toMatch(/pageHref\(page - 1\)/);
    expect(PAGE).toMatch(/pageHref\(page \+ 1\)/);
  });

  it('counts the badge with its own exact head query, not an array length', () => {
    // `(raw ?? []).filter(...).length` was the bug: it could only ever report a number
    // no larger than the window, on the one figure an agent uses to judge the backlog.
    expect(PAGE).not.toMatch(/const needsReply = \(raw \?\? \[\]\)/);
    const i = PAGE.indexOf('needsReplyCount');
    expect(i).toBeGreaterThan(-1);
    const q = PAGE.slice(i, i + 400);
    expect(q).toMatch(/count: "exact", head: true/);
    expect(q).toMatch(/\.in\("status", \["open", "pending"\]\)/);
    expect(q).toMatch(/\.eq\("last_author", "user"\)/);
  });
});

describe('the ordering is server-side and ranked, not alphabetical', () => {
  it('orders the queue by priority_rank then oldest-first', () => {
    const i = PAGE.indexOf('needsReplyTab) {');
    const branch = PAGE.slice(i, i + 500);
    expect(branch).toMatch(/\.order\("priority_rank", \{ ascending: true \}\)/);
    expect(branch).toMatch(/\.order\("last_message_at", \{ ascending: true \}\)/);
  });

  it('no longer sorts the fetched page in JavaScript', () => {
    // A sort over one page's rows cannot be paged: which page a ticket lands on then
    // depends on what the window happened to catch.
    expect(PAGE).not.toMatch(/PRIORITY_RANK/);
    expect(PAGE).not.toMatch(/localeCompare/);
  });

  it('never orders by the raw text column, which sorts high before urgent', () => {
    expect(PAGE).not.toMatch(/\.order\("priority"/);
  });
});

describe('the rank the console relies on is defined in the database', () => {
  it('adds priority_rank as a STORED generated column', () => {
    expect(MIGRATION).toMatch(/add column if not exists priority_rank smallint/);
    expect(MIGRATION).toMatch(/generated always as \(/);
    expect(MIGRATION).toMatch(/\)\s*stored;/);
  });

  it('ranks urgent 0, high 1, normal 2, low 3 — and anything unknown last', () => {
    const expr = MIGRATION.slice(
      MIGRATION.indexOf('generated always as ('),
      MIGRATION.indexOf(') stored;'),
    );
    expect(expr).toMatch(/when 'urgent' then 0/);
    expect(expr).toMatch(/when 'high'\s+then 1/);
    expect(expr).toMatch(/when 'normal' then 2/);
    expect(expr).toMatch(/when 'low'\s+then 3/);
    expect(expr).toMatch(/else 4/);
  });

  it('covers the four values the CHECK constraint allows, and no others', () => {
    const check = read('supabase', 'migrations', '20260806360000_support_two_way.sql');
    const allowed = check
      .slice(check.indexOf('support_tickets_priority_check'))
      .match(/priority in \(([^)]+)\)/)[1]
      .split(',')
      .map((s) => s.trim().replace(/'/g, ''));
    const expr = MIGRATION.slice(
      MIGRATION.indexOf('generated always as ('),
      MIGRATION.indexOf(') stored;'),
    );
    const ranked = [...expr.matchAll(/when '(\w+)'/g)].map((m) => m[1]);
    expect(ranked.sort()).toEqual(allowed.sort());
  });

  it('proves the old ordering was wrong before changing anything, and asserts the new one', () => {
    // House style: a pre-fix probe that must FAIL to be discriminating, then the
    // assertion. Both are rolled back.
    expect(MIGRATION).toMatch(/probe is not discriminating/);
    expect(MIGRATION).toMatch(/FIX FAILED: ranked ordering did not lead with the urgent ticket/);
    expect(MIGRATION).toMatch(/probe complete — rolling back/);
  });

  it('indexes the shape the queue actually asks for', () => {
    expect(MIGRATION).toMatch(
      /create index if not exists support_tickets_needs_reply_idx[\s\S]{0,200}priority_rank, last_message_at/,
    );
    expect(MIGRATION).toMatch(/where status <> 'closed' and last_author = 'user'/);
  });
});
