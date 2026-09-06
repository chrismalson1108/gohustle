// ─────────────────────────────────────────────────────────────────────────────
// A finding that could not be WRITTEN must never read as a finding that CLEARED.
//
// reconcile-stripe pushes every payment it retrieves into `examined` before evaluating
// it, and pushed a problem into `seen` only if record_reconciliation_finding succeeded.
// writeFinding returned null on an RPC error — so a transient statement timeout left the
// entity in `examined` and out of `seen`, which is EXACTLY the predicate
// resolve_reconciliation_findings closes on:
//
//   and (p_examined is null or f.entity_id = any (p_examined))
//   and not (f.entity_id = any (coalesce(p_still_open, '{}')))
//
// with the note 'auto-resolved: reconciles against Stripe'. A real, already-detected
// captured_total_mismatch was therefore converted into a resolved one by a database
// hiccup, and the queue then asserted a reconciliation that had never happened.
//
// 20260806270000 already named this class in its own header: "the worst class of
// monitoring bug. It does not fail loudly or stop working; it reports success it did not
// verify." It fixed the aged-out half. This is the same bug through the other door.
//
// The webhook-config half is a different shape and is asserted separately: there the
// entity is pushed into `open` BEFORE the write, so a failed write cannot auto-resolve
// anything — but resolve_external_findings ends by setting last_error = null, so a
// misconfiguration whose finding could not be recorded left the board green with no row
// to look at.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

function code(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

const src = code(read('supabase', 'functions', 'reconcile-stripe', 'index.ts'));

const writeFinding = src.slice(
  src.indexOf('async function writeFinding('),
  src.indexOf('function json('),
);

describe('a failed finding write leaves the entity reported as broken', () => {
  test('writeFinding cannot return null', () => {
    // The null was the whole defect: it is what made the caller drop the entity from
    // `seen`. Pin the signature, not just the body.
    expect(writeFinding).toMatch(/\): Promise<string> \{/);
    expect(writeFinding).not.toMatch(/return null/);
    expect(writeFinding).toMatch(/return entityId;/);
  });

  test('the failure is recorded rather than only logged to a console nobody reads', () => {
    expect(writeFinding).toMatch(/warnings\.push\(/);
  });

  test('every problem found lands in the still-open list unconditionally', () => {
    // The old shape was `const id = await writeFinding(...); if (id) seen.push(id);`
    // — the conditional IS the bug.
    expect(src).not.toMatch(/if \(id\) seen\.push\(id\)/);
    expect(src).toMatch(/seen\.push\(await writeFinding\(/);
    // Both call sites inside the loop, not just one.
    expect(src.match(/seen\.push\(await writeFinding\(/g)).toHaveLength(2);
  });

  test('the run reports ERRORING rather than clean when it could not record', () => {
    // resolve_reconciliation_findings runs on `seen`/`examined`; the registry row is
    // what a human actually looks at, so a run that could not write must not clear it.
    expect(src).toMatch(/last_error: warnings\.length \? warnings\.join/);
  });
});

describe('the webhook-config half reports a failed write too', () => {
  const cfg = src.slice(src.indexOf('async function checkWebhookConfig('));

  test('every record_external_finding error is captured', () => {
    expect(cfg).toMatch(/const writeErrors: string\[\] = \[\]/);
    // Three call sites: no_endpoint, <entity>:missing, and missing_events.
    expect(cfg.match(/const \{ error: wErr \} = await supabase\.rpc\("record_external_finding"/g))
      .toHaveLength(3);
    expect(cfg.match(/if \(wErr\) writeErrors\.push\(/g)).toHaveLength(3);
  });

  test('it is re-stamped AFTER resolve_external_findings, which clears last_error', () => {
    const resolveAt = cfg.indexOf('resolve_external_findings');
    const stampAt = cfg.indexOf('last_error: writeErrors.join');
    expect(resolveAt).toBeGreaterThan(-1);
    expect(stampAt).toBeGreaterThan(resolveAt);
    expect(cfg).toMatch(/\.eq\("key", CONTROL_WEBHOOK\)/);
  });
});
