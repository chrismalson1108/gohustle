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
const codeOnly = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

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

describe('every guarded call has a recovery path', () => {
  // Any client component that invokes a step-up-guarded action must hold a useStepUp
  // instance AND render the prompt, or the operator dead-ends on "stale_mfa".
  const FILES = ['promotions/PromoControls.tsx', 'pricing/PricingControls.tsx'];

  FILES.forEach((rel) => {
    it(`${rel}: no component can enter step-up without a way out`, () => {
      const src = codeOnly(read(...rel.split('/')));
      const marks = [...src.matchAll(/(?:export )?function (\w+)\(/g)];
      const bounds = marks.map((m, i) => ({
        name: m[1],
        body: src.slice(m.index, i + 1 < marks.length ? marks[i + 1].index : src.length),
      }));
      const broken = bounds
        .filter((c) => /stepUp\.run\(|pendingFd|pendingCall/.test(c.body))
        // The prompt must be CONDITIONED on the step-up state, not merely present.
        // Checking for the component name alone passed `false && <ReauthPrompt …>`, which
        // is a dead end wearing the right import.
        .filter((c) => !(
          /useStepUp\(\)|useState<FormData/.test(c.body)
          // Both shapes in use: `{x && <ReauthPrompt …>}` and `{x && (\n <ReauthPrompt`.
          && /(stepUp\.needed|pendingFd|pendingCall)\s*&&\s*\(?\s*</.test(c.body)
          && /ReauthPrompt/.test(c.body)
        ))
        .map((c) => c.name);
      expect({ file: rel, dead_ends: broken }).toEqual({ file: rel, dead_ends: [] });
    });
  });
});
