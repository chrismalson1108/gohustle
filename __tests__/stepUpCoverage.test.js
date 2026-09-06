// ─────────────────────────────────────────────────────────────────────────────
// Every budget-spending console action steps up, and every step-up has a way out.
//
// TWO failures, both real, both from the 2026-08-12 audit:
//
//  1. /promotions was the ONLY budget-spending surface on plain requireAdmin, while the
//     same grant capability routed through /pricing (grantToUsers →
//     grant_promotion_to_users) required requireFreshAdmin. A borrowed session could mint
//     codes, clone a campaign, raise a budget or revoke a grant without a second factor.
//     A promotion is money — just money spent slowly.
//
//  2. The other half is the recovery path. requireFreshAdmin returns
//     { ok:false, message:"stale_mfa" }, which is RECOVERABLE — enter a current code and
//     the same action re-runs — but only if the surface offers the prompt. useStepUp's own
//     header records that this was missed on three surfaces at once, dead-ending operators
//     on a raw "stale_mfa" string. An operator who cannot complete a legitimate action is
//     one who will eventually ask for the guard to be removed, so a step-up with no
//     recovery is worse than no step-up.
//
// So both directions are asserted: mutating actions must be guarded, and any component
// that calls a guarded action must be able to finish it.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const CONSOLE = path.join(__dirname, '..', 'admin', 'app', '(console)');
const read = (...p) => fs.readFileSync(path.join(CONSOLE, ...p), 'utf8');
// Strip comments so a commented-out call cannot satisfy an assertion.
//
// Block comments are matched only where one STARTS A LINE. An unanchored /\/\*…\*\//
// also matched the `/*` inside `accept="image/*"`, and then ran on to the next real `*/`
// — which in support/[id]/Composer.tsx deleted 785 characters including the whole render,
// so the file looked like a component with no ReauthPrompt in it. A guard that silently
// deletes the code it is inspecting reports on something that does not exist.
const codeOnly = (s) => s
  .replace(/^[ \t]*\{?\/\*[\s\S]*?\*\/\}?/gm, '')
  .replace(/^\s*\/\/.*$/gm, '');

describe('budget-spending actions require a fresh second factor', () => {
  const actions = codeOnly(read('promotions', 'actions.ts'));

  // Everything here either creates, changes or destroys campaign money.
  const MUTATING = [
    'createPromotion', 'setPromotionStatus', 'mintCodes',
    'editPromotion', 'clonePromotion', 'revokeGrant',
  ];
  // Reads. Forcing a re-auth to look at a number teaches people to re-auth reflexively,
  // which is how step-up stops meaning anything.
  const READS = ['previewCost'];

  const bodyOf = (name) => {
    const i = actions.indexOf(`export async function ${name}(`);
    if (i === -1) return '';
    const next = actions.indexOf('export async function ', i + 10);
    return actions.slice(i, next === -1 ? actions.length : next);
  };

  MUTATING.forEach((fn) => {
    it(`${fn} requires step-up`, () => {
      const b = bodyOf(fn);
      expect(`${fn}: found`).toBe(b.length > 50 ? `${fn}: found` : `${fn}: MISSING`);
      expect(`${fn}: ${/requireFreshAdmin\("admin"\)/.test(b)}`).toBe(`${fn}: true`);
    });
  });

  READS.forEach((fn) => {
    it(`${fn} does not, because it only reads`, () => {
      expect(bodyOf(fn)).toMatch(/requireAdmin\("admin"\)/);
      expect(bodyOf(fn)).not.toMatch(/requireFreshAdmin/);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Opening signups to the whole internet is an access grant, and it was the last
// high-consequence control still on plain requireAdmin.
//
// guard.ts states the rule as "use for anything that moves money, changes pricing, or
// GRANTS ACCESS". setOpenBeta upserts the '*' row, which handle_new_user reads as "allow
// every email" — the difference between a private beta and public signup — and it was
// satisfied by nothing more than a typed word and a session whose factor could be hours
// old. A borrowed unlocked screen inside the 12h session cap could make signups public
// without producing a second factor, while pausing payments from /flags in the same
// session would have asked for one.
//
// Invite and revoke are pinned here too: they are the same act at a smaller scale, and an
// exception carved by blast radius is the one that grows back.
// ─────────────────────────────────────────────────────────────────────────────
describe('access-granting actions require a fresh second factor', () => {
  const actions = codeOnly(read('access', 'actions.ts'));

  const bodyOf = (name) => {
    const i = actions.indexOf(`export async function ${name}(`);
    if (i === -1) return '';
    const next = actions.indexOf('export async function ', i + 10);
    return actions.slice(i, next === -1 ? actions.length : next);
  };

  it('the shared context helper steps up', () => {
    expect(actions).toMatch(/async function adminCtx\(\)\s*\{\s*return requireFreshAdmin\("admin"\);/);
    // Not merely "requireFreshAdmin appears somewhere": the plain guard must be gone,
    // or a later edit can reintroduce it beside the import and nothing notices.
    expect(actions).not.toMatch(/requireAdmin\(/);
  });

  ['inviteEmails', 'revokeEmail', 'setOpenBeta'].forEach((fn) => {
    it(`${fn} goes through it`, () => {
      const b = bodyOf(fn);
      expect(`${fn}: found`).toBe(b.length > 50 ? `${fn}: found` : `${fn}: MISSING`);
      expect(`${fn}: ${/await adminCtx\(\)/.test(b)}`).toBe(`${fn}: true`);
      // …and reports the recoverable denial as the sentinel useStepUp keys on, not as
      // the flat "Not authorized." that reads like a revoked role.
      expect(`${fn}: ${/return denyResult\(e\)/.test(b)}`).toBe(`${fn}: true`);
    });
  });

  it('the denial goes through the shared mapping', () => {
    expect(actions).toMatch(/denyResult/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A recoverable denial must survive as one, in every action.
//
// ae911e0 moved the 12-hour session cap INTO requireAdmin, so `stale_mfa` stopped being
// a step-up-only outcome: every action in the console can now throw it. The catch blocks
// were not updated, and they had three different answers —
//
//   flags/team/bookings/users  mapped it to the "stale_mfa" sentinel (correct, ×5 copies)
//   disputes/moderation/jobs/support/categories/access  collapsed it to "Not authorized."
//   controls/pricing/promotions  returned `e.reason` raw, printing "stale_mfa" at a human
//
// so a trust operator resolving a report twelve hours after their morning TOTP was told
// their access was revoked, with no prompt and nothing to press. Only a page navigation
// (which hits requireAdminPage) would have offered the code.
//
// One definition now, in guard.ts, asserted here — including the negative, because the
// failure mode is a NEW catch block hand-rolling the old wrong answer.
// ─────────────────────────────────────────────────────────────────────────────
describe('no console action hand-rolls its own denial', () => {
  const dirs = [];
  const walk = (dir, rel = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel ? `${rel}/${entry.name}` : entry.name);
      else if (entry.name === 'actions.ts') dirs.push(rel);
    }
  };
  walk(CONSOLE);

  it('finds every actions.ts under (console)', () => {
    // If this ever collapses to a handful, the walk broke and every case below is
    // passing on an empty set.
    expect(dirs.length).toBeGreaterThanOrEqual(13);
  });

  dirs.forEach((rel) => {
    it(`${rel}/actions.ts routes AdminAuthError through denyResult`, () => {
      const src = codeOnly(read(...rel.split('/'), 'actions.ts'));
      if (!/AdminAuthError/.test(src)) return;
      const findings = [];
      if (!/denyResult\(e\)/.test(src)) findings.push('does not call denyResult(e)');
      // The two wrong answers, spelled out so a reintroduction is named rather than
      // merely counted.
      if (/message: "Not authorized\."/.test(src)) findings.push('collapses a denial inline');
      if (/message: e\.reason/.test(src)) findings.push('leaks the raw reason at the operator');
      expect({ file: rel, findings }).toEqual({ file: rel, findings: [] });
    });
  });
});

describe('every guarded call has a recovery path', () => {
  // Any client component that invokes a guarded action must hold a useStepUp instance AND
  // render the prompt, or the operator dead-ends on "stale_mfa".
  //
  // ENUMERATED, not listed. This was three hand-written filenames while eleven components
  // called guarded actions, which is how the gap the header describes stayed unguarded
  // through the change that created it. Every client component under (console) that
  // imports from an actions module is now in scope, so a new surface is covered the day
  // it is written rather than the day someone remembers to add it here.
  const FILES = [];
  const walkTsx = (dir, rel = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walkTsx(path.join(dir, entry.name), next);
      else if (entry.name.endsWith('.tsx')) {
        const src = fs.readFileSync(path.join(dir, entry.name), 'utf8');
        if (/from "\.\.?\/(?:\.\.\/)*actions"/.test(src)) FILES.push(next);
      }
    }
  };
  walkTsx(CONSOLE);

  it('finds the client components that call server actions', () => {
    expect(FILES.length).toBeGreaterThanOrEqual(15);
  });

  FILES.forEach((rel) => {
    it(`${rel}: no component can enter step-up without a way out`, () => {
      const src = codeOnly(read(...rel.split('/')));
      // TOP-LEVEL declarations only — anchored at column 0. An unanchored match split on
      // nested helpers too (`function fire(…)` inside a component), which chopped the
      // render off the component that owns it and reported the helper as a dead end.
      const marks = [...src.matchAll(/^(?:export (?:default )?)?function (\w+)\(/gm)];
      const bounds = marks.map((m, i) => ({
        name: m[1],
        body: src.slice(m.index, i + 1 < marks.length ? marks[i + 1].index : src.length),
      }));
      // The action names this file imports. A component that touches one of them is in
      // scope whether or not it already knows about step-up — the old filter only looked
      // at components ALREADY calling stepUp.run, so a surface with no recovery at all
      // passed by having nothing to find.
      const imported = [...src.matchAll(/import \{([^}]*)\} from "\.\.?\/(?:\.\.\/)*actions";/g)]
        .flatMap((m) => m[1].split(','))
        .map((s) => s.trim())
        .filter((s) => /^[a-z]\w*$/.test(s));

      const broken = bounds
        .filter((c) => (
          /stepUp\.run\(|pendingFd|pendingCall/.test(c.body)
          || imported.some((fn) => new RegExp(`\\b${fn}\\b`).test(c.body))
        ))
        // The prompt must be CONDITIONED on the step-up state, not merely present.
        // Checking for the component name alone passed `false && <ReauthPrompt …>`, which
        // is a dead end wearing the right import.
        .filter((c) => !(
          /useStepUp\(\)|useState<FormData/.test(c.body)
          // Three shapes in use: `{x && <ReauthPrompt …>}`, `{x && (\n  <ReauthPrompt`,
          // and `{x && y && (\n  <ReauthPrompt` — the last of which the old pattern
          // rejected, because it demanded the prompt immediately after the first `&&`.
          // The prompt must still be REACHED FROM the step-up state, not merely present:
          // checking for the component name alone passed `false && <ReauthPrompt …>`,
          // a dead end wearing the right import.
          && /(stepUp\.needed|pendingFd|pendingCall)\s*&&[^;]{0,120}?<\s*ReauthPrompt/.test(c.body)
          && /ReauthPrompt/.test(c.body)
        ))
        .map((c) => c.name);
      expect({ file: rel, dead_ends: broken }).toEqual({ file: rel, dead_ends: [] });
    });
  });
});
