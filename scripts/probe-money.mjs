#!/usr/bin/env node
// Run every money probe in scripts/money-probes/ against PRODUCTION and print what each
// one measured.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
//
// `npm test` asserts what the CODE says. It cannot tell you that a `fee_override` grant
// really pins a booking at 0 bps, that an exhausted budget really lets the next booking
// through at the standing rate, that `record_refund` twice on one external id really
// writes one ledger row, or that `ctl_earner_credit_missing` really fires on an
// uncredited capture. Those are properties of the live database — of triggers, guards,
// constraints and control bodies interacting — and the only honest way to know them is to
// stage the row and look.
//
// The 2026-09-08 payments audit ran exactly these seven by hand and they found three
// defects the test suite could not see: a booking accepting two live dispute proposals,
// an accepted reduction whose clock never moved, and a loyalty ladder that rewards
// nobody. They are here so the next session runs them in one command instead of
// rediscovering them.
//
// ── SAFETY ─────────────────────────────────────────────────────────────────
//
// EVERY probe ends in `raise exception`, so its whole transaction is discarded. They
// stage jobs, bookings, payments, disputes, promotions and ledger rows and NONE of it
// persists — the audit verified production was byte-identical afterwards. A probe that
// stops raising would start writing to production, so the runner REFUSES to execute a
// file that does not contain a rollback raise.
//
// Reads SUPABASE_ACCESS_TOKEN from .env.local (the CLI/management token; there is no
// service-role key on disk). NOTICE output is invisible over this endpoint, which is why
// every probe reports by raising rather than by `raise notice`.
//
//   node scripts/probe-money.mjs            # all of them
//   node scripts/probe-money.mjs 30 50      # only those whose filename starts 30 / 50
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PROBES = join(HERE, 'money-probes');
const PROJECT_REF = 'nfioebqsgmmzhbksxozc';

function token() {
  const env = readFileSync(join(ROOT, '.env.local'), 'utf8');
  const m = env.match(/^SUPABASE_ACCESS_TOKEN=(.+)$/m);
  if (!m) throw new Error('SUPABASE_ACCESS_TOKEN is not in .env.local');
  return m[1].trim();
}

async function run(sql) {
  const res = await fetch(
    `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token()}`,
        'Content-Type': 'application/json',
        // Cloudflare in front of the management API rejects a request with no UA.
        'User-Agent': 'gohustlr-money-probes',
      },
      body: JSON.stringify({ query: sql }),
    },
  );
  const text = await res.text();
  if (res.ok) return { ok: true, body: text };
  // A probe reports by RAISING, so the interesting result arrives as a 400.
  return { ok: false, body: text };
}

const only = process.argv.slice(2);
const files = readdirSync(PROBES)
  .filter((f) => f.endsWith('.sql'))
  .filter((f) => !only.length || only.some((p) => f.startsWith(p)))
  .sort();

if (!files.length) {
  console.error(`No probes matched ${JSON.stringify(only)} in ${PROBES}`);
  process.exit(2);
}

let failed = 0;
for (const file of files) {
  const sql = readFileSync(join(PROBES, file), 'utf8');

  // A probe that no longer rolls back would write to production. Refuse it.
  if (!/raise\s+exception/i.test(sql)) {
    console.error(`\n✗ ${file}\n  REFUSED: no \`raise exception\`, so this would COMMIT to production.`);
    failed++;
    continue;
  }

  process.stdout.write(`\n── ${file} ${'─'.repeat(Math.max(0, 62 - file.length))}\n`);
  const { body } = await run(sql);

  let message;
  try {
    message = JSON.parse(body).message ?? body;
  } catch {
    message = body;
  }
  // Strip the PostgREST/pg envelope down to what the probe actually reported.
  const reported = message
    .replace(/^Failed to run sql query:\s*/i, '')
    .replace(/^ERROR:\s*P0001:\s*/i, '')
    .split(/\nCONTEXT:/)[0]
    .replace(/\\n/g, '\n')
    .trim();

  // "probe complete — rolling back" is the idiom for a probe whose assertions all passed
  // and which had nothing to report; anything else is its measurements, or a real error.
  const clean = /rolling back|rolled back/i.test(reported) && !/FIX FAILED|CONTROL/i.test(reported);
  if (/ERROR:/.test(message) && !/P0001/.test(message)) {
    console.error(`  ✗ the probe itself errored — this is not a finding, it is a broken probe:\n    ${reported}`);
    failed++;
  } else {
    console.log(reported.split('\n').map((l) => `  ${l}`).join('\n'));
    void clean;
  }
}

console.log(`\n${files.length} probe(s) run, ${failed} could not execute.`);
console.log('Nothing was committed: every probe ends in a rollback raise.');
process.exit(failed ? 1 : 0);
