const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// guard_support_ticket_write has now been re-created four times, and the
// `app.support_reopen` exemption has been dropped by TWO of those rewrites —
// including by the migration whose own header warned about exactly this.
//
// The failure is silent and one-directional. Without the exemption, the message
// trigger's rollup UPDATE re-enters the ticket guard and gets pinned back, so a
// user's reply never moves last_author. The console's needs-reply filter and
// ctl_support_ticket_unanswered both read that column, so the queue stops showing
// the customer — and an empty queue looks exactly like a queue with nothing in it.
//
// Prose warnings did not hold. This asserts it instead: the newest migration that
// defines this function must carry the exemption.
// ─────────────────────────────────────────────────────────────────────────────
const DIR = path.join(__dirname, '..', 'supabase', 'migrations');

function newestDefining(fnName) {
  const hits = fs
    .readdirSync(DIR)
    .filter(f => f.endsWith('.sql'))
    .filter(f => new RegExp(`create or replace function public\\.${fnName}\\b`, 'i')
      .test(fs.readFileSync(path.join(DIR, f), 'utf8')))
    .sort();
  return hits.length ? { file: hits[hits.length - 1], sql: fs.readFileSync(path.join(DIR, hits[hits.length - 1]), 'utf8') } : null;
}

describe('support guard drift', () => {
  it('the ticket guard is defined somewhere', () => {
    expect(newestDefining('guard_support_ticket_write')).not.toBeNull();
  });

  it('the newest ticket guard still exempts the message trigger rollup', () => {
    // Losing this makes every user reply invisible to the support queue.
    const { sql, file } = newestDefining('guard_support_ticket_write');
    const body = sql.slice(sql.toLowerCase().indexOf('create or replace function public.guard_support_ticket_write'));
    expect(`${file}: ${body.includes('app.support_reopen')}`).toBe(`${file}: true`);
  });

  it('the message guard still SETS the GUC the ticket guard reads', () => {
    // Two halves of one mechanism: if either is re-created without the other, the
    // rollup silently stops working.
    const { sql } = newestDefining('guard_support_message_write');
    expect(sql).toMatch(/set_config\(\s*'app\.support_reopen'\s*,\s*'on'\s*,\s*true\s*\)/);
  });

  it('the ticket guard still pins the columns a client must not control', () => {
    // The exemption must not be "return new" for everyone — these pins are the
    // trust boundary that stops a user promoting their own ticket.
    const { sql } = newestDefining('guard_support_ticket_write');
    ['opened_by', 'priority', 'assigned_to', 'last_author', 'user_id'].forEach(col => {
      expect(sql).toMatch(new RegExp(`new\\.${col}\\s*:=\\s*old\\.${col}`));
    });
  });

  it('the message guard still pins author and admin_id for non-staff', () => {
    // A message rendered with a GoHustlr badge must have come from GoHustlr.
    const { sql } = newestDefining('guard_support_message_write');
    expect(sql).toMatch(/new\.author\s*:=\s*'user'/);
    expect(sql).toMatch(/new\.admin_id\s*:=\s*null/);
  });
});
