// Drift guard for /flags — the console page that flips app_flags.
//
// WHAT WENT WRONG. app_flags was five feature kill switches when the page was written,
// and the page hard-coded that assumption three separate times: one list with one
// FlagToggle per row, one confirm dialog (`Turn OFF "<key>" for every user right now?`),
// and one success sentence (`<key> is OFF. Users hitting that feature now get a
// "temporarily paused" message.`). Five more rows of two other kinds arrived later —
// two alert-dispatch channels and three configuration rows — and inherited all of it.
//
// The sharp end: pressing Turn off on `safety_alert` mid-incident took nothing away from
// any user. It stopped a human being paged when a safety report landed, for 24 hours,
// and the console reported the opposite in the operator's own words. That is the July 10
// outage class (a safety trigger sat dead for four weeks) reintroduced through the UI.
//
// WHAT THIS ASSERTS. The migrations are the roster of keys; guide.ts is the console's
// statement about each one. This reads the first and requires the second to cover it, so
// a new flag cannot arrive undescribed and silently inherit somebody else's copy.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MIG_DIR = path.join(ROOT, 'supabase', 'migrations');
const FLAGS_DIR = path.join(ROOT, 'admin', 'app', '(console)', 'flags');

const read = (p) => fs.readFileSync(p, 'utf8');
const guideSrc = read(path.join(FLAGS_DIR, 'guide.ts'));
const pageSrc = read(path.join(FLAGS_DIR, 'page.tsx'));
const actionsSrc = read(path.join(FLAGS_DIR, 'actions.ts'));
const toggleSrc = read(path.join(FLAGS_DIR, 'FlagToggle.tsx'));

// The house rule from alertingWatched.test.js, in the harder direction: every one of
// these files QUOTES the copy it replaced, in a comment explaining why. Without this the
// negative assertions below would fail on the explanation of the fix rather than on the
// defect. No `//` appears inside a string literal in any of the four files (no URLs).
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const actionsCode = stripComments(actionsSrc);
const toggleCode = stripComments(toggleSrc);
const pageCode = stripComments(pageSrc);

// ── Every key any migration seeds into app_flags ─────────────────────────────
// Line comments stripped first (the migration prose quotes flag keys). The key is the
// first literal after a values-tuple's own open paren; the negative lookbehind keeps
// `jsonb_build_object('url', …)` inside the same tuple from reading as a key.
//
// Probe inserts inside DO blocks are still scanned, because a probe naming a REAL key
// the console cannot describe is worth failing on. The one exception is a key prefixed
// `probe_`: 20260906085000 stages `probe_unknown_switch_enabled` precisely to prove its
// control fires on a switch the console does not describe, so that key is unknown BY
// DESIGN and rolls back with the probe. This guard's original note claimed probes "only
// ever name real keys"; that stopped being true the moment a control about unknown keys
// needed one. Real keys never carry the prefix — nothing seeds a `probe_` row.
function seededKeys() {
  const keys = new Set();
  for (const f of fs.readdirSync(MIG_DIR).filter((n) => n.endsWith('.sql')).sort()) {
    const sql = read(path.join(MIG_DIR, f)).replace(/--[^\n]*/g, '');
    for (const m of sql.matchAll(
      /insert\s+into\s+public\.app_flags\s*\([^)]*\)\s*values([\s\S]*?);/gi,
    )) {
      for (const k of m[1].matchAll(/(?<![A-Za-z0-9_])\(\s*'([a-z0-9_]+)'/g)) {
        if (!k[1].startsWith('probe_')) keys.add(k[1]);
      }
    }
  }
  return [...keys].sort();
}

// The guide is TypeScript, not JSON, so parse the shape rather than eval it: each entry
// opens with `<key>: {` and carries a `kind:`.
function guideEntries() {
  const body = guideSrc.slice(guideSrc.indexOf('export const FLAG_GUIDE'));
  const out = {};
  for (const m of body.matchAll(/^ {2}([a-z0-9_]+):\s*\{([\s\S]*?)^ {2}\},/gm)) {
    const kind = m[2].match(/kind:\s*"([a-z_]+)"/);
    out[m[1]] = { kind: kind && kind[1], body: m[2] };
  }
  return out;
}

const KEYS = seededKeys();
const GUIDE = guideEntries();

describe('/flags describes every app_flags row it renders', () => {
  test('the migrations seed keys of more than one kind (the premise of this file)', () => {
    // If this ever drops back to five homogeneous kill switches the rest of the file is
    // guarding nothing, and somebody should be told rather than left with green ticks.
    expect(KEYS.length).toBeGreaterThanOrEqual(10);
    expect(KEYS).toEqual(expect.arrayContaining(['safety_alert', 'controls_alert', 'stripe_mode']));
  });

  test('every seeded key has an entry in guide.ts', () => {
    const missing = KEYS.filter((k) => !GUIDE[k]);
    expect(missing).toEqual([]);
  });

  test('guide.ts invents no key the migrations do not seed', () => {
    // A description of a flag that does not exist is a switch in the UI for nothing —
    // the same failure actions.ts refuses to create by UPDATE-only writes.
    const extra = Object.keys(GUIDE).filter((k) => !KEYS.includes(k));
    expect(extra).toEqual([]);
  });

  test('the enforcement list is rendered from the guide, not hand-written', () => {
    // It named five of the ten keys for two months, and the five it omitted were the
    // ones whose effect is least obvious. Driving it from FLAG_GUIDE is what makes the
    // test above cover the rendered list.
    expect(pageCode).toMatch(/Object\.entries\(FLAG_GUIDE\)/);
  });

  test('the two alert channels are classified as alert channels, not kill switches', () => {
    for (const key of ['safety_alert', 'controls_alert']) {
      expect(GUIDE[key].kind).toBe('alert_channel');
      // The two facts the console never stated: users are unaffected, and the mute lapses.
      expect(GUIDE[key].body).toMatch(/24 hours/);
      expect(GUIDE[key].body.toLowerCase()).toMatch(/pag(e|ing)/);
    }
  });

  test('config rows are classified as config, so no toggle is offered for a bit nothing reads', () => {
    for (const key of ['stripe_mode', 'storage_public_origin', 'controls_heartbeat']) {
      expect(GUIDE[key].kind).toBe('config');
    }
    // The server refuses it as well, because the UI is not the enforcement.
    expect(actionsCode).toMatch(/guide\.kind === "config"/);
  });

  test('no fixed "temporarily paused" sentence is returned for every key', () => {
    // The exact copy that told an operator muting the safety pager that users were
    // seeing a paused feature.
    expect(actionsCode).not.toMatch(/Users hitting that feature/);
    expect(actionsCode).toMatch(/guide\.offMeans/);
  });

  test('the confirm dialog says what the flip actually does', () => {
    expect(toggleCode).not.toMatch(/for every user right now/);
    expect(toggleCode).toMatch(/guideFor/);
  });

  test('muting a pager records why, and the page shows the deadline', () => {
    expect(actionsCode).toMatch(/kind === "alert_channel" && !enabled && !note/);
    expect(actionsCode).toMatch(/disabled_reason/);
    // 20260814100000 added both columns and the page selected neither, so the bound on
    // the mute was invisible to the only person who could act on it.
    expect(pageCode).toMatch(/disabled_until/);
    expect(pageCode).toMatch(/disabled_reason/);
  });

  test('stripe_mode can be flipped from the console, as its migration says it can', () => {
    // 20260814080000: "the control is now armed, and /flags can flip it at cutover."
    // Nothing in admin/ wrote app_flags.value, so that sentence described no code.
    expect(actionsCode).toMatch(/export async function setStripeMode/);
    expect(actionsCode).toMatch(/value: \{ mode \}/);
    expect(actionsCode).toMatch(/\.eq\("key", "stripe_mode"\)/);
    // Same treatment the rate card gets: typed confirmation, admin tier, step-up.
    expect(actionsCode).toMatch(/SWITCH TO LIVE/);
    expect(actionsCode).toMatch(/requireFreshAdmin\("admin"\)/);
    expect(pageCode).toMatch(/StripeModeControl/);
  });

  test('a flag seeded OFF on purpose is not reported as a paused feature', () => {
    // bonus_cash_payout_enabled has been off since it was created; the banner counted it
    // every day, which is how a red banner stops being read.
    expect(GUIDE.bonus_cash_payout_enabled.body).toMatch(/offByDefault: true/);
    expect(pageCode).toMatch(/offByDefault/);
  });

  test('an undescribed key gets a warning, never an invented reassurance', () => {
    const fallback = guideSrc.slice(guideSrc.indexOf('export function guideFor'));
    expect(fallback).toMatch(/UNKNOWN/);
  });
});
