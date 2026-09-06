const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// A console page that asks PostgREST for a column that does not exist.
//
// /promotions selected `promo_grants.uses_used`. That column has never existed — the
// table has `uses_consumed` (20260806070000:121) — and PostgREST rejects the WHOLE select
// with 42703 when one name is wrong. supabase-js hands back `{ data: null, error }`, the
// page destructured only `data`, and `(grants ?? []).length === 0` then rendered "No
// grants issued." over a table with rows in it. The only Revoke lever in the console went
// with it, and the section beneath rendered normally, so the empty list read as truth.
//
// Nothing could have caught it: TypeScript has no generated database types here, and a
// server component's query only runs when a human opens the page.
//
// So this asserts the column names in the console's own selects against the columns the
// schema creates. It reads BOTH halves of the schema — supabase/*.sql, which still holds
// roughly half the CREATE TABLEs, and supabase/migrations/*.sql, which holds the rest and
// every ALTER — because a check that read only migrations/ would call half the real
// columns imaginary.
//
// Deliberately narrow, so it never has to be muted:
//   · embedded resources (`profiles!inner(name)`) are skipped — they are a different
//     grammar and the name inside them belongs to the joined table;
//   · `*` and `count` are skipped;
//   · an alias (`want:actual`) is checked on the right-hand side, which is the real column;
//   · a table this file cannot find is REPORTED, not silently skipped, or the guard could
//     quietly stop covering the console one rename at a time.
// ─────────────────────────────────────────────────────────────────────────────
const ROOT = path.join(__dirname, '..');
const SUPA = path.join(ROOT, 'supabase');
const ADMIN = path.join(ROOT, 'admin');

function schemaSql() {
  const files = [];
  for (const f of fs.readdirSync(SUPA)) if (f.endsWith('.sql')) files.push(path.join(SUPA, f));
  const mig = path.join(SUPA, 'migrations');
  for (const f of fs.readdirSync(mig)) if (f.endsWith('.sql')) files.push(path.join(mig, f));
  return files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
}

// Split on commas that are not inside parentheses — a column definition carries its own
// `check (a between 0 and 1)` and a select carries `profiles(name, id)`.
function topSplit(s) {
  let depth = 0;
  let cur = '';
  const parts = [];
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  parts.push(cur);
  return parts;
}

function buildSchema(sql) {
  const cols = {};
  const views = new Set();

  for (const m of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-z0-9_]+)\s*\(/gi)) {
    const table = m[1];
    let i = m.index + m[0].length - 1;
    const start = i;
    let depth = 0;
    for (; i < sql.length; i++) {
      if (sql[i] === '(') depth++;
      else if (sql[i] === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    // Strip line comments BEFORE splitting: a comma inside a comment would split the body
    // mid-sentence and swallow the column that follows it.
    const body = sql.slice(start + 1, i).replace(/--[^\n]*/g, '');
    cols[table] = cols[table] || new Set();
    for (const part of topSplit(body)) {
      const mm = part.trim().match(/^([a-z0-9_]+)\s/i);
      if (!mm) continue;
      if (/^(constraint|primary|unique|foreign|check|exclude|like)$/i.test(mm[1])) continue;
      cols[table].add(mm[1].toLowerCase());
    }
  }

  // One ALTER TABLE can add several columns in a single comma-separated statement, so walk
  // the whole statement rather than matching only its first ADD COLUMN.
  for (const m of sql.matchAll(/alter\s+table\s+(?:if\s+exists\s+)?(?:public\.)?([a-z0-9_]+)([\s\S]*?);/gi)) {
    const table = m[1];
    for (const c of m[2].matchAll(/add\s+column\s+(?:if\s+not\s+exists\s+)?([a-z0-9_]+)/gi)) {
      (cols[table] = cols[table] || new Set()).add(c[1].toLowerCase());
    }
  }

  for (const m of sql.matchAll(/create\s+(?:or\s+replace\s+)?(?:materialized\s+)?view\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-z0-9_]+)/gi)) {
    views.add(m[1]);
  }
  return { cols, views };
}

function sourceFiles(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.next') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(p, acc);
    else if (/\.(ts|tsx)$/.test(e.name)) acc.push(p);
  }
  return acc;
}

const { cols, views } = buildSchema(schemaSql());

const selects = [];
for (const file of sourceFiles(ADMIN)) {
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(/\.from\(\s*"([a-z0-9_]+)"\s*\)\s*(?:\r?\n\s*)?\.select\(\s*(["'`])([\s\S]*?)\2/g)) {
    selects.push({ file: path.relative(ROOT, file), table: m[1], sel: m[3] });
  }
}

describe('the console never selects a column the schema does not have', () => {
  it('found the schema and the console queries', () => {
    // If either half stops parsing, everything below passes vacuously — which is the
    // failure mode of every guard written as a scan.
    expect(Object.keys(cols).length).toBeGreaterThan(50);
    expect(cols.promo_grants && cols.promo_grants.has('uses_consumed')).toBe(true);
    expect(selects.length).toBeGreaterThan(80);
  });

  it('every table the console reads from is one this file can find', () => {
    const unknown = [
      ...new Set(selects.filter((s) => !cols[s.table] && !views.has(s.table)).map((s) => `${s.file}: ${s.table}`)),
    ];
    expect(unknown).toEqual([]);
  });

  it('every column name in every console select exists', () => {
    const bad = [];
    for (const { file, table, sel } of selects) {
      if (views.has(table) || !cols[table]) continue;
      for (let part of topSplit(sel)) {
        part = part.trim();
        if (!part || part === '*' || part === 'count') continue;
        if (part.includes('(')) continue; // embedded resource — a different table's columns
        if (part.includes(':')) part = part.split(':').pop().trim(); // alias:actual
        if (!/^[a-z0-9_]+$/.test(part)) continue;
        if (!cols[table].has(part)) bad.push(`${file}: ${table}.${part}`);
      }
    }
    // Named individually: PostgREST fails the whole select on one wrong name, so each of
    // these is a page rendering as if the table were empty.
    expect(bad).toEqual([]);
  });
});

describe('/promotions can still show and revoke a grant', () => {
  const page = fs.readFileSync(path.join(ADMIN, 'app/(console)/promotions/page.tsx'), 'utf8');

  it('reads uses_consumed, the column that exists', () => {
    // Checked against the select string and the render, not the whole file — the page's
    // own comment names the dead column on purpose, so a reader knows what broke.
    const sel = /from\("promo_grants"\)[\s\S]{0,200}?\.select\("([^"]*)"\)/.exec(page);
    expect(sel).not.toBeNull();
    expect(sel[1].split(',').map((c) => c.trim())).toContain('uses_consumed');
    expect(sel[1]).not.toContain('uses_used');
    expect(page).toMatch(/g\.uses_consumed/);
    expect(page).not.toMatch(/g\.uses_used/);
  });

  it('a failed grants query is never rendered as an empty one', () => {
    // The defect was one wrong name; what made it invisible for weeks was discarding the
    // error. "No grants issued." next to a working bonus_ledger table reads as truth.
    expect(page).toMatch(/from\("promo_grants"\)/);
    expect(page).toMatch(/error:\s*grantsError/);
    const empty = page.indexOf('No grants issued.');
    const guard = page.indexOf('grantsError ?');
    expect(`error branch before the empty branch: ${guard > 0 && guard < empty}`).toBe(
      'error branch before the empty branch: true',
    );
  });
});
