// ─────────────────────────────────────────────────────────────────────────────
// Every `.rpc('fn', { … })` call site must name parameters the function actually has.
//
// PostgREST resolves an RPC by NAME AND ARGUMENT NAMES. Get a key wrong and the answer
// is "function public.fn(bad_arg => …) does not exist" — a 404 in a {data, error} pair.
// supabase-js RESOLVES with that error rather than throwing, so a call site that
// discards the result fails in complete silence, forever, and no surrounding try/catch
// ever sees it.
//
// That shipped. settle-disputes/index.ts:206 called
//
//     await supabase.rpc('recompute_user_rating', { p_user: b.earner_id });
//
// while the live signature is recompute_user_rating(target uuid) — which is exactly how
// both clients call it (src/context/JobsContext.js:684, web/lib/jobs.tsx:765). The result
// was not destructured. So every dispute that settled published the poster's held review
// onto the earner's public profile and never moved profiles.rating or review_count: a
// rating that counted for nothing, with nothing in /errors to say so.
//
// Nothing could have caught it short of this. deno check passes (the object is untyped),
// the suite passed, and production has never settled a dispute.
//
// Signatures come from the migrations and the legacy .sql files, last definition wins —
// the same "resolve it, never name a migration by hand" rule pricing.test.js follows.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function sqlFiles() {
  const out = [];
  const mig = path.join(ROOT, 'supabase', 'migrations');
  for (const f of fs.readdirSync(mig).filter((f) => f.endsWith('.sql')).sort()) {
    out.push(path.join(mig, f));
  }
  // Legacy schema.sql + migration_*.sql still define roughly half the functions.
  const legacy = path.join(ROOT, 'supabase');
  for (const f of fs.readdirSync(legacy).filter((f) => f.endsWith('.sql')).sort()) {
    out.push(path.join(legacy, f));
  }
  return out;
}

// name -> Set of parameter names, for the LAST definition seen. A function with several
// overloads accumulates the union, so an overload-resolvable name is never a false fail.
function collectSignatures() {
  const sigs = new Map();
  const re = /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([a-z0-9_]+)\s*\(([\s\S]*?)\)\s*\n?\s*returns\b/gi;
  for (const file of sqlFiles()) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(re)) {
      const name = m[1].toLowerCase();
      const params = new Set();
      // Split on top-level commas only — a default like `'{}'::text[]` has none, but
      // numeric precision `numeric(10,2)` does.
      let depth = 0, cur = '';
      const parts = [];
      for (const ch of m[2]) {
        if (ch === '(') depth++;
        if (ch === ')') depth--;
        if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
      }
      if (cur.trim()) parts.push(cur);
      for (const p of parts) {
        const t = p.trim().replace(/^\s*(in|out|inout|variadic)\s+/i, '');
        const first = t.split(/\s+/)[0];
        if (first && /^[a-z_][a-z0-9_]*$/i.test(first)) params.add(first.toLowerCase());
      }
      const prev = sigs.get(name);
      sigs.set(name, prev ? new Set([...prev, ...params]) : params);
    }
  }
  return sigs;
}

function codeFiles() {
  const out = [];
  const roots = ['supabase/functions', 'src', 'web', 'admin', 'shared'].map((r) => path.join(ROOT, r));
  const SKIP = new Set(['node_modules', '.next', 'dist', 'build', '.vercel', 'coverage']);
  (function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(ts|tsx|js|jsx)$/.test(e.name)) out.push(full);
    }
  })(path.join(ROOT, 'supabase', 'functions'));
  for (const r of roots.slice(1)) {
    (function walk(dir) {
      if (!fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (SKIP.has(e.name)) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.(ts|tsx|js|jsx)$/.test(e.name)) out.push(full);
      }
    })(r);
  }
  return out;
}

// `.rpc('name', { a: …, b: … })` -> { name, keys, file, line }. Object literal only;
// a spread or a variable is recorded as unparseable rather than guessed at.
function collectCalls() {
  const calls = [];
  const unparseable = [];
  const re = /\.rpc\(\s*['"]([a-z0-9_]+)['"]\s*(,\s*\{)?/gi;
  for (const file of codeFiles()) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(re)) {
      const name = m[1].toLowerCase();
      const line = src.slice(0, m.index).split('\n').length;
      const rel = path.relative(ROOT, file);
      if (!m[2]) { calls.push({ name, keys: [], file: rel, line }); continue; }
      // Walk the object literal to its matching brace.
      let i = m.index + m[0].length - 1, depth = 0, body = '';
      for (; i < src.length; i++) {
        const ch = src[i];
        if (ch === '{') depth++;
        if (ch === '}') { depth--; if (depth === 0) break; }
        if (depth >= 1) body += ch;
      }
      if (depth !== 0) { unparseable.push(`${rel}:${line} ${name}`); continue; }
      if (/\.\.\./.test(body)) { unparseable.push(`${rel}:${line} ${name} (spread)`); continue; }
      const keys = [];
      let d = 0, key = '', expecting = true;
      for (const ch of body.slice(1)) {
        if ('({['.includes(ch)) d++;
        else if (')}]'.includes(ch)) d--;
        if (d === 0 && ch === ',') { expecting = true; key = ''; continue; }
        if (d === 0 && ch === ':' && expecting) {
          const k = key.trim().replace(/['"]/g, '');
          if (/^[a-z_][a-z0-9_]*$/i.test(k)) keys.push(k.toLowerCase());
          expecting = false; key = ''; continue;
        }
        if (expecting) key += ch;
      }
      calls.push({ name, keys, file: rel, line });
    }
  }
  return { calls, unparseable };
}

const sigs = collectSignatures();
const { calls, unparseable } = collectCalls();

describe('every .rpc() call names parameters the function actually has', () => {
  it('found signatures and call sites at all — a guard that measures nothing is worse than none', () => {
    expect(sigs.size).toBeGreaterThan(100);
    expect(calls.length).toBeGreaterThan(50);
  });

  it('recompute_user_rating takes `target`, and every caller says so', () => {
    // The specific regression. Named on its own so the failure reads as itself.
    expect([...(sigs.get('recompute_user_rating') || [])]).toEqual(['target']);
    for (const c of calls.filter((c) => c.name === 'recompute_user_rating')) {
      expect(`${c.file}:${c.line} -> ${c.keys.join(',')}`).toBe(`${c.file}:${c.line} -> target`);
    }
  });

  const checkable = calls.filter((c) => sigs.has(c.name) && c.keys.length);
  it('there is something to check', () => expect(checkable.length).toBeGreaterThan(30));

  it.each(checkable.map((c) => [`${c.file}:${c.line} ${c.name}(${c.keys.join(', ')})`, c]))(
    '%s', (_label, c) => {
      const params = sigs.get(c.name);
      const bad = c.keys.filter((k) => !params.has(k));
      // Printed as a value, not a boolean, so the failure names the key AND the options.
      expect(`${c.name}: unknown ${JSON.stringify(bad)}`).toBe(`${c.name}: unknown []`);
    },
  );

  it('reports what it could not parse, so the coverage is honest', () => {
    // Not a failure — a spread or a computed key is legitimate. But it must be VISIBLE,
    // or this guard quietly stops covering the call sites that matter most.
    if (unparseable.length) console.log('rpcParamNames: not statically checkable:\n  ' + unparseable.join('\n  '));
    expect(unparseable.length).toBeLessThan(25);
  });
});
