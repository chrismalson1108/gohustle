// ─────────────────────────────────────────────────────────────────────────────
// A SECURITY DEFINER function in `public` that takes its subject from an ARGUMENT is an
// oracle over that argument, and PostgREST exposes every one of them at
// /rest/v1/rpc/<name> to anyone holding an anon key and a session.
//
// This project already wrote the rule down — 20260710030000 keeps `is_blocked_pair` in
// the `private` schema because a public one "would be a boolean ORACLE over any two
// users" — and then granted three of them to `authenticated` anyway:
// tier_fee_bps, earner_completed_count and earner_distinct_posters leaked any earner's
// private fee rate, verified-gig count and client count until 20260906082000.
//
// The default is the trap. `create function` grants EXECUTE to PUBLIC, so a definer
// function is world-callable unless a migration explicitly takes it away — which means
// the safe state is the one you have to remember, and forgetting looks like nothing.
//
// So this replays every grant and revoke across the migrations in apply order and fails
// on any public. SECURITY DEFINER function with a uuid argument that ends up executable
// by `authenticated` (or by PUBLIC), unless it is listed below WITH A REASON. Same shape
// as storagePolicies.test.js: cleared, or excused on the record.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const MIG = path.join(__dirname, '..', 'supabase', 'migrations');

// Excused, each because the function resolves the caller itself rather than trusting the
// argument, or because the value it returns is deliberately public.
const ALLOWED = {
  'public.profile_availability(uuid)':
    'gates on `p.show_availability or p.id = auth.uid()` inside the body — the whole '
    + 'point of the function is to enforce the opt-in the raw column grant could not '
    + '(20260630000000:205-219).',
  'public.recompute_user_rating(uuid)':
    'writes, and only recomputes the rating cache from `reviews` rows that are already '
    + 'SELECT-readable by every authenticated user; the guard it sets (app.recompute) is '
    + 'what stops it being a general profiles write (20260624194500:17-35).',
  'public.create_gig_share(uuid, text, integer)':
    'the uuid is a BOOKING, not a person, and the body requires `b.earner_id = auth.uid()` '
    + 'on an accepted booking before it mints anything (20260806300000:43-70).',
  'public.raise_gig_emergency(uuid, text)':
    'the uuid is a BOOKING; the body requires auth.uid() to be a party to it and the '
    + 'booking to be accepted, and a safety button must be callable by the person in '
    + 'danger (20260906060000:71-98).',
};

function signature(schema, name, args) {
  // Reduce an argument list to bare types, the way pg_proc and has_function_privilege
  // identify a function: drop names, defaults and whitespace noise.
  const types = args
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean)
    .map((a) => a.replace(/\s+default\s+[\s\S]*$/i, '').trim())
    .map((a) => {
      const parts = a.split(/\s+/);
      // `p_user uuid` → uuid; a bare `uuid` stays uuid; `p_ids uuid[]` → uuid[].
      return (parts.length > 1 ? parts.slice(1).join(' ') : parts[0]).toLowerCase();
    })
    .map((t) => (t === 'int' ? 'integer' : t));
  return `${schema}.${name}(${types.join(', ')})`;
}

// Function BODIES are dollar-quoted, and they contain SQL of their own — including, in
// 20260906082000, a probe that re-grants the very function it is proving is revoked.
// Reading a body as if it were a statement is how a guard reports the opposite of the
// truth, so drop every $tag$…$tag$ block before parsing anything.
function stripBodies(sql) {
  const tag = /\$([a-z_][a-z0-9_]*)?\$/gi;
  let out = '';
  let cursor = 0;
  let m;
  while ((m = tag.exec(sql))) {
    const close = sql.indexOf(m[0], m.index + m[0].length);
    if (close === -1) break;
    out += sql.slice(cursor, m.index);
    cursor = close + m[0].length;
    tag.lastIndex = cursor;
  }
  return out + sql.slice(cursor);
}

// Comments live inside argument lists in this repo (record_refund documents p_external_id
// mid-signature), so they have to go before the paren scan runs.
function stripComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

// Walk from the '(' that opens a signature to its match, so a type like numeric(10,2)
// cannot end the scan early.
function readArgs(sql, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < sql.length; i += 1) {
    if (sql[i] === '(') depth += 1;
    else if (sql[i] === ')') {
      depth -= 1;
      if (depth === 0) return sql.slice(openIdx + 1, i);
    }
  }
  return null;
}

function replay() {
  const files = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();
  // sig → { definer, uuidArg, authenticated, lastTouched }
  const state = new Map();

  for (const file of files) {
    const sql = stripComments(stripBodies(fs.readFileSync(path.join(MIG, file), 'utf8')));

    const create = /create\s+(?:or\s+replace\s+)?function\s+(public|private)\.([a-z0-9_]+)\s*\(/gi;
    let m;
    while ((m = create.exec(sql))) {
      const args = readArgs(sql, create.lastIndex - 1);
      if (args === null) continue;
      // The head runs from the close paren to the `as` that introduced the (now removed)
      // body; that window is where `security definer` lives.
      const rest = sql.slice(create.lastIndex + args.length + 1, create.lastIndex + args.length + 900);
      const head = rest.split(/\bas\b/i)[0];
      const sig = signature(m[1].toLowerCase(), m[2].toLowerCase(), args);
      const prev = state.get(sig);
      state.set(sig, {
        definer: /\bsecurity\s+definer\b/i.test(head),
        uuidArg: /\buuid\b/i.test(args),
        // CREATE (and CREATE OR REPLACE of a function that never existed) leaves EXECUTE
        // held by PUBLIC unless a later statement takes it away. That default is the
        // whole reason this guard exists: the safe state is the one you must remember.
        authenticated: prev ? prev.authenticated : true,
        lastTouched: prev ? prev.lastTouched : `${file} (create — PUBLIC default)`,
      });
    }

    const acl = /\b(grant|revoke)\s+execute\s+on\s+function\s+(public|private)\.([a-z0-9_]+)\s*\(/gi;
    while ((m = acl.exec(sql))) {
      const args = readArgs(sql, acl.lastIndex - 1);
      if (args === null) continue;
      const after = sql.slice(acl.lastIndex + args.length + 1);
      const roles = (after.match(/^\s*(?:to|from)\s+([^;]+);/i) || [])[1];
      if (!roles) continue;
      const sig = signature(m[2].toLowerCase(), m[3].toLowerCase(), args);
      const entry = state.get(sig);
      if (!entry) continue; // a signature we never saw created; nothing to reason about
      if (!/\bauthenticated\b/i.test(roles) && !/\bpublic\b/i.test(roles)) continue;
      entry.authenticated = m[1].toLowerCase() === 'grant';
      entry.lastTouched = `${file} (${m[1].toLowerCase()} ${roles.trim().replace(/\s+/g, ' ')})`;
    }
  }
  return state;
}

describe('SECURITY DEFINER functions that take a uuid argument', () => {
  const state = replay();

  it('found the loyalty helpers to reason about', () => {
    // If the parser stops recognising these the guard silently covers nothing.
    for (const sig of [
      'public.tier_fee_bps(uuid)',
      'public.earner_completed_count(uuid)',
      'public.earner_distinct_posters(uuid)',
    ]) {
      expect(state.has(sig)).toBe(true);
      expect(state.get(sig).definer).toBe(true);
    }
  });

  it('are never executable by authenticated unless excused with a reason', () => {
    const offenders = [];
    for (const [sig, e] of state) {
      if (!sig.startsWith('public.')) continue; // PostgREST only exposes public
      if (!e.definer || !e.uuidArg) continue;
      if (!e.authenticated) continue;
      if (ALLOWED[sig]) continue;
      offenders.push(`${sig} — granted by ${e.lastTouched}`);
    }
    expect(offenders.sort()).toEqual([]);
  });

  it('keeps the loyalty helpers service_role only', () => {
    // The specific regression 20260906082000 closed: an oracle over any earner's private
    // fee rate, verified-gig count and distinct-client count.
    for (const sig of [
      'public.tier_fee_bps(uuid)',
      'public.earner_completed_count(uuid)',
      'public.earner_distinct_posters(uuid)',
    ]) {
      expect({ sig, authenticated: state.get(sig).authenticated })
        .toEqual({ sig, authenticated: false });
    }
    expect(ALLOWED['public.tier_fee_bps(uuid)']).toBeUndefined();
  });

  it('every allowlist entry still names a real function, so the excuses cannot rot', () => {
    for (const [sig, reason] of Object.entries(ALLOWED)) {
      expect({ sig, known: state.has(sig) }).toEqual({ sig, known: true });
      expect(reason.length).toBeGreaterThan(60);
    }
  });
});
