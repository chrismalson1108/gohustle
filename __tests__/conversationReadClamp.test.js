const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// The unread badge is the only signal that a message arrived, and it is decided by
// comparing two clocks: conversation_state.last_read_at (written by the handset in
// markConversationRead) against messages.created_at (the server's `DEFAULT NOW()`).
// A phone whose clock runs fast marks replies read before they are written; a phone
// that runs slow leaves read threads badged. 20260906094000 fixes it in the one place
// that covers mobile, web and every build already installed: a BEFORE trigger that
// takes the server's now() instead of the device's value.
//
// This asserts that trigger keeps existing, and — just as importantly — keeps its
// narrow condition. Rewriting last_read_at on EVERY write would make
// setConversationArchived (which upserts only `archived`, carrying last_read_at
// through unchanged) silently mark the conversation read: a worse version of the bug
// it replaced, and invisible from the client.
// ─────────────────────────────────────────────────────────────────────────────
const DIR = path.join(__dirname, '..', 'supabase', 'migrations');

function newestDefining(fnName) {
  const hits = fs
    .readdirSync(DIR)
    .filter(f => f.endsWith('.sql'))
    .filter(f => new RegExp(`create or replace function public\\.${fnName}\\b`, 'i')
      .test(fs.readFileSync(path.join(DIR, f), 'utf8')))
    .sort();
  return hits.length
    ? { file: hits[hits.length - 1], sql: fs.readFileSync(path.join(DIR, hits[hits.length - 1]), 'utf8') }
    : null;
}

describe('conversation read receipts come from the server clock', () => {
  it('a guard on conversation_state.last_read_at exists at all', () => {
    // Without it the receipt is whatever the handset says, and the comparison in
    // isUnread is between two unsynchronised clocks.
    expect(newestDefining('guard_conversation_state_read_at')).not.toBeNull();
  });

  it('the guard takes now() for the receipt', () => {
    const { sql, file } = newestDefining('guard_conversation_state_read_at');
    expect(`${file}: ${/new\.last_read_at\s*:=\s*now\(\)/.test(sql)}`).toBe(`${file}: true`);
  });

  it('the guard only rewrites a receipt the write actually changes', () => {
    // This condition is what keeps archiving from marking a conversation read:
    // setConversationArchived's upsert carries the stored last_read_at through
    // untouched, and an unconditional bump would move it.
    const { sql, file } = newestDefining('guard_conversation_state_read_at');
    expect(`${file}: ${/new\.last_read_at\s+is\s+distinct\s+from\s+old\.last_read_at/i.test(sql)}`)
      .toBe(`${file}: true`);
  });

  it('the guard leaves a receipt-less row alone, so an unopened thread stays unread', () => {
    // isUnread treats a missing last_read_at as unread. An archive-first INSERT must
    // not mint one.
    const { sql, file } = newestDefining('guard_conversation_state_read_at');
    expect(`${file}: ${/new\.last_read_at\s+is\s+not\s+null/i.test(sql)}`).toBe(`${file}: true`);
  });

  it('the guard is bound to conversation_state for both insert and update', () => {
    // A function nothing fires is not a guard. Both paths matter: the receipt is
    // created by the first read (INSERT via upsert) and moved by every read after.
    const { sql, file } = newestDefining('guard_conversation_state_read_at');
    const trigger = sql.match(
      /create trigger\s+\w+\s+before\s+insert\s+or\s+update\s+on\s+public\.conversation_state[\s\S]{0,200}?execute function public\.guard_conversation_state_read_at\(\)/i,
    );
    expect(`${file}: ${trigger !== null}`).toBe(`${file}: true`);
  });

  it('both clients still decide unread by comparing the receipt to created_at', () => {
    // If either client ever stops reading last_read_at, the trigger above is
    // protecting a column nothing uses and this test should be revisited rather than
    // left as decoration.
    const mobile = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'messages.js'), 'utf8');
    const web = fs.readFileSync(path.join(__dirname, '..', 'web', 'lib', 'messages.ts'), 'utf8');
    [['src/lib/messages.js', mobile], ['web/lib/messages.ts', web]].forEach(([name, src]) => {
      expect(`${name}: ${/new Date\(lastMsg\.created_at\)[\s\S]{0,80}state\.last_read_at/.test(src)}`)
        .toBe(`${name}: true`);
    });
  });
});
