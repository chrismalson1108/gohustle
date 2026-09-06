// A failed preferences READ must not be answered with the defaults, and a single
// toggle must not write the other seven columns.
//
// getNotificationPrefs() used to destructure only `data` from the maybeSingle()
// call. supabase-js RESOLVES on a PostgREST or network error with
// `{ data: null, error }`, so an error landed in the same `if (!data) return
// { ...DEFAULT_NOTIF_PREFS }` branch as "this user has no row yet" — and the outer
// try/catch returned the defaults for the throwing paths too. The settings screen
// rendered that as the user's live settings.
//
// saveNotificationPrefs(prefs) then upserted the FULL eight-column row built from
// that in-memory object. So one transient read failure plus one toggle silently
// reverted every opt-out the user had saved: someone who had turned off
// bookings_email, payments_email and messages_push, opened the screen on a flaky
// connection and switched marketing_push off, had all three turned back on — and
// send-push reads that row, so the mail resumed.
//
// Two independent halves are asserted, because either one alone closes the hole
// and both were wrong:
//   1. the read fails closed (throws) instead of resolving to defaults;
//   2. the write carries ONE column, so the in-memory copy cannot overwrite
//      anything the user did not just touch.
//
// These tests fail on the old code: (1) resolved with DEFAULT_NOTIF_PREFS instead
// of rejecting, and (2) issued an upsert containing all eight boolean keys.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Recorded PostgREST calls, and the replies the test wants back.
const calls = [];
const reply = {
  auth: { data: { user: { id: 'user-1' } }, error: null },
  select: { data: null, error: null },
  update: { data: [{ user_id: 'user-1' }], error: null },
  insert: { error: null },
};

jest.mock('../src/lib/supabase', () => {
  const record = (entry) => { entry.table = entry.table || 'notification_preferences'; return entry; };
  return {
    supabase: {
      auth: { getUser: async () => reply.auth },
      from: (table) => {
        const api = {
          select(cols) {
            // Terminal `.select()` after an update returns the updated rows;
            // a leading `.select('*')` starts a read chain.
            if (this._op === 'update') { this._returning = cols; return this; }
            this._op = 'select';
            return this;
          },
          eq(col, val) { this._eq = [col, val]; return this; },
          async maybeSingle() {
            calls.push(record({ op: 'select', table }));
            return reply.select;
          },
          update(patch) { this._op = 'update'; this._patch = patch; return this; },
          insert(row) {
            calls.push(record({ op: 'insert', table, row }));
            return Promise.resolve(reply.insert);
          },
          upsert(row) {
            calls.push(record({ op: 'upsert', table, row }));
            return Promise.resolve({ error: null });
          },
          then(resolve, rejectFn) {
            // An update chain is awaited directly (with or without .select()).
            calls.push(record({ op: 'update', table, patch: this._patch }));
            return Promise.resolve(reply.update).then(resolve, rejectFn);
          },
        };
        return api;
      },
    },
  };
});

describe('getNotificationPrefs() fails closed on a read error', () => {
  let lib;

  beforeAll(() => {
    // eslint-disable-next-line global-require
    lib = require('../src/lib/notifications');
  });

  beforeEach(() => {
    calls.length = 0;
    reply.auth = { data: { user: { id: 'user-1' } }, error: null };
    reply.select = { data: null, error: null };
    reply.update = { data: [{ user_id: 'user-1' }], error: null };
    reply.insert = { error: null };
  });

  test('a PostgREST error rejects instead of resolving to the defaults', async () => {
    reply.select = { data: null, error: { message: 'network error', code: 'PGRST000' } };
    await expect(lib.getNotificationPrefs()).rejects.toBeTruthy();
  });

  test('an auth error rejects too', async () => {
    reply.auth = { data: { user: null }, error: { message: 'failed to fetch' } };
    await expect(lib.getNotificationPrefs()).rejects.toBeTruthy();
  });

  test('a genuinely empty row still resolves to the defaults', async () => {
    reply.select = { data: null, error: null };
    await expect(lib.getNotificationPrefs()).resolves.toEqual(lib.DEFAULT_NOTIF_PREFS);
  });

  test('a stored row wins over the defaults', async () => {
    reply.select = { data: { bookings_email: false, payments_email: false }, error: null };
    const prefs = await lib.getNotificationPrefs();
    expect(prefs.bookings_email).toBe(false);
    expect(prefs.payments_email).toBe(false);
    expect(prefs.bookings_push).toBe(true); // untouched column falls back to the default
  });
});

describe('saveNotificationPref() writes ONE column', () => {
  let lib;

  beforeAll(() => {
    // eslint-disable-next-line global-require
    lib = require('../src/lib/notifications');
  });

  beforeEach(() => {
    calls.length = 0;
    reply.auth = { data: { user: { id: 'user-1' } }, error: null };
    reply.update = { data: [{ user_id: 'user-1' }], error: null };
    reply.insert = { error: null };
  });

  test('the patch carries only the toggled key (plus updated_at)', async () => {
    await lib.saveNotificationPref('marketing_push', false);
    const write = calls.find((c) => c.op === 'update');
    expect(write).toBeTruthy();
    expect(calls.some((c) => c.op === 'upsert')).toBe(false);
    const boolKeys = Object.keys(write.patch).filter((k) => typeof write.patch[k] === 'boolean');
    expect(boolKeys).toEqual(['marketing_push']);
    expect(write.patch.marketing_push).toBe(false);
  });

  test('the whole-object writer is gone, so nothing can smuggle eight columns in', () => {
    expect(lib.saveNotificationPrefs).toBeUndefined();
  });

  test('an unknown key is refused rather than written', async () => {
    await expect(lib.saveNotificationPref('bookings_sms', true)).rejects.toBeTruthy();
    expect(calls.length).toBe(0);
  });

  test('no row yet: the insert seeds the defaults with the one change applied', async () => {
    reply.update = { data: [], error: null };
    await lib.saveNotificationPref('messages_email', true);
    const insert = calls.find((c) => c.op === 'insert');
    expect(insert).toBeTruthy();
    expect(insert.row.messages_email).toBe(true);
    expect(insert.row.user_id).toBe('user-1');
    expect(insert.row.bookings_email).toBe(lib.DEFAULT_NOTIF_PREFS.bookings_email);
  });

  test('a signed-out save rejects rather than silently doing nothing', async () => {
    reply.auth = { data: { user: null }, error: null };
    await expect(lib.saveNotificationPref('bookings_push', false)).rejects.toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// The web copy is a hand-kept mirror of the same two functions (web/lib/
// notifications.ts says so). It had the identical swallow-and-upsert pair, so it
// is asserted at the source level — the same shape parity.test.js uses for the
// files jest cannot import.
// ---------------------------------------------------------------------------
describe('web/lib/notifications.ts mirrors the fail-closed contract', () => {
  const src = fs.readFileSync(path.join(ROOT, 'web', 'lib', 'notifications.ts'), 'utf8');
  const prefsBlock = src.slice(src.indexOf('export async function getNotificationPrefs'));

  test('the read surfaces the PostgREST error', () => {
    expect(prefsBlock).toMatch(/const \{ data, error \}[\s\S]*?if \(error\) throw error;/);
  });

  test('the read has no catch-all that returns the defaults', () => {
    const getBlock = prefsBlock.slice(0, prefsBlock.indexOf('export async function saveNotificationPref'));
    expect(getBlock).not.toMatch(/catch\s*\{[\s\S]*DEFAULT_NOTIF_PREFS/);
  });

  test('there is no whole-object upsert of the preferences row', () => {
    expect(src).not.toMatch(/notification_preferences"\)\.upsert/);
    expect(src).not.toMatch(/saveNotificationPrefs/);
  });

  test('the single-key writer exists', () => {
    expect(src).toMatch(/export async function saveNotificationPref\(key: keyof NotifPrefs, value: boolean\)/);
  });
});
