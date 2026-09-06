/**
 * Tax Center load failures must not be dressed up as an empty year.
 *
 * fetchExpenses/fetchIncome throw on a PostgREST error. Both Tax Centers caught that
 * and dropped it — mobile with `catch (_) {}`, web with a comment that said the quiet
 * part out loud ("swallow — empty state will show") — then rendered "No expenses yet",
 * Expenses $0.00, and a net profit and ~27% set-aside computed as though the user had
 * claimed no deductions. Export stayed enabled, so that could be written into a CSV
 * and handed to an accountant.
 *
 * The ledger screen was fixed for this same class ("Load failures render as
 * authoritative empty states"); this guards its two siblings. Source-level, like the
 * other screen-wiring guards in this suite: these are JSX render decisions with no
 * pure function to call.
 */
const fs = require('fs');
const path = require('path');

const MOBILE = 'src/screens/ExpensesScreen.js';
const WEB = 'web/app/(app)/profile/taxes/page.tsx';
const SCREENS = [MOBILE, WEB];

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

// The load() callback body, from its declaration to the dependency array.
function loadBody(src) {
  const start = src.indexOf('const load = useCallback');
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf('}, [user', start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe.each(SCREENS)('%s', (file) => {
  const src = read(file);

  test('the read failure is recorded, not swallowed', () => {
    const body = loadBody(src);
    // A catch that actually does something with the error.
    expect(body).toMatch(/catch\s*(\([^)]*\)\s*)?\{[^}]*setError\(/);
    // And it must not fall through into the render as though nothing happened.
    expect(body).toMatch(/setError\([\s\S]*?\)[\s\S]*?return;/);
  });

  test('a successful read is what marks the data as known', () => {
    expect(loadBody(src)).toMatch(/setLoaded\(true\)/);
  });

  test('"unknown" is failure-with-no-data, never a failed refresh over real rows', () => {
    expect(src).toMatch(/const unknownTotals = Boolean\(error\) && !loaded;/);
  });

  test('the error state is rendered ahead of the empty state, with a retry', () => {
    const unknown = src.indexOf('unknownTotals ? (');
    const empty = Math.max(src.indexOf('No expenses yet'), src.indexOf('No cash income logged'));
    expect(unknown).toBeGreaterThan(-1);
    expect(empty).toBeGreaterThan(-1);
    // The list branch tests unknownTotals BEFORE it can claim the year is empty.
    expect(unknown).toBeLessThan(empty);
    expect(src).toMatch(/Try again|Retry/);
  });

  test('the summary prints a dash, not $0.00, for totals it does not have', () => {
    // Every headline figure goes through the guarded formatter rather than the raw one.
    const guarded = file === MOBILE ? /money\(/g : /stat\(summary\./g;
    expect((src.match(guarded) || []).length).toBeGreaterThanOrEqual(4);
    expect(src).toMatch(/unknownTotals \? ['"]—['"]/);
  });

  test('Export refuses to write a CSV built on a failed read', () => {
    const start = src.indexOf('handleExport');
    const nothing = src.indexOf('Nothing to export', start);
    const gate = src.indexOf('unknownTotals', start);
    expect(gate).toBeGreaterThan(-1);
    // The gate comes first: "we could not load this" outranks "there is nothing here".
    expect(gate).toBeLessThan(nothing);
  });
});

describe('the receipt-signing pass stays best-effort', () => {
  // Rows are already in state by then; a thumbnail that will not sign is not a reason
  // to tell someone their books failed to load. Guarded so the fix above is not
  // "improved" into failing the whole screen on a storage hiccup.
  test.each(SCREENS)('%s signs receipts in its own try', (file) => {
    const body = loadBody(read(file));
    const signing = body.indexOf('getSignedUrl');
    const firstCatch = body.indexOf('catch');
    expect(signing).toBeGreaterThan(firstCatch);
  });
});
