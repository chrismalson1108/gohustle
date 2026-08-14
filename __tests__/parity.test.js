const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// THE THINGS THAT SILENTLY GO OUT OF SYNC.
//
// Chris asked how to stop having to remember "and update the web app, and update
// Hustlr AI" every time we change something. The answer is not a document — CLAUDE.md
// already carried the amendment direction BACKWARDS for months and survived several
// audit rounds — and it is not an agent rewriting things unattended, which is how
// today's dropped WHERE clause and missing import would happen at 3am with nobody
// watching.
//
// It is this: the obligation becomes a test that fails. Every guard already in this
// suite replaced something somebody had to remember —
//
//   categories.test.js   JS categorySlug()  ↔  SQL category_slug()
//   pricing.test.js      shared/pricing.js  ↔  the fee migration
//   supportGuardDrift    the reopen exemption surviving a guard rewrite
//   importIntegrity      a JSX identifier that was never imported
//   headerDuplication    a screen printing its nav title twice
//
// — and each was added the day something broke. This file is the same idea applied to
// the three cross-cutting obligations nobody remembers unprompted.
//
// WHEN ONE OF THESE FAILS, IT IS NOT THE TEST BEING FUSSY. It is the second half of a
// change that has not been done yet.
// ─────────────────────────────────────────────────────────────────────────────
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// ── 1. Push deep-links ──────────────────────────────────────────────────────
// CLAUDE.md: tab route names are "a wire protocol, not just internal" — every push
// notification carries data.tab, and send-push validates it against KNOWN_TABS.
// Renaming a route breaks every notification deep-link, silently, on devices only.
describe('push deep-links still point at real tabs', () => {
  const app = read('App.js');
  const push = read('supabase/functions/send-push/index.ts');

  const routes = [...app.matchAll(/<Tab\.Screen\s+name="([A-Za-z]+)"/g)].map((m) => m[1]);
  const known = (push.match(/KNOWN_TABS = new Set\(\[([^\]]*)\]/) || [, ''])[1]
    .split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);

  it('finds both sides', () => {
    expect(routes.length).toBe(5);
    expect(known.length).toBe(5);
  });

  it('every tab route is a tab send-push will accept', () => {
    // A route missing here means notifications for that tab are dropped on the floor:
    // send-push strips an unknown data.tab, so the push arrives and goes nowhere.
    const missing = routes.filter((r) => !known.includes(r));
    expect(`unroutable: ${missing.join(', ') || 'none'}`).toBe('unroutable: none');
  });

  it('send-push does not accept a tab that no longer exists', () => {
    const stale = known.filter((k) => !routes.includes(k));
    expect(`stale: ${stale.join(', ') || 'none'}`).toBe('stale: none');
  });
});

// ── 2. Hustlr AI's picture of the app ───────────────────────────────────────
// The assistant's system prompt described tabs called "Hiring" and "Profile" months
// after they became Hire and You, and knew nothing about Transactions, the Tax
// Center, in-app Support or two-factor. Users asking "where do I see what I got
// paid?" got a guess. Nobody noticed because nothing could notice.
describe('Hustlr AI knows what the app actually looks like', () => {
  const app = read('App.js');
  const assistant = read('supabase/functions/assistant/index.ts');
  const prompt = assistant.slice(assistant.indexOf('You are **Hustlr AI**'));

  const labels = [...app.matchAll(/<Tab\.Screen\s+name="[A-Za-z]+"\s+component=\{\w+\}\s+options=\{\{ title: '([^']+)'/g)]
    .map((m) => m[1]);

  it('finds the tab labels', () => {
    expect(labels).toEqual(expect.arrayContaining(['Browse', 'My Jobs', 'Hire', 'Messages', 'You']));
  });

  labels.forEach((label) => {
    it(`names the "${label}" tab as the app names it`, () => {
      // Catches the exact drift that happened: a renamed tab the prompt never heard
      // about, so the assistant sends people to a tab that is not called that.
      expect(`${label}: ${prompt.includes(label) ? 'known' : 'MISSING FROM PROMPT'}`)
        .toBe(`${label}: known`);
    });
  });

  // Curated on purpose. Not every screen belongs in the prompt — internal and
  // one-off screens would be noise — but a user-facing destination people ASK for
  // does. Adding a feature here is the cheapest possible reminder to teach the
  // assistant about it, and the test fails until you do.
  const MUST_KNOW = [
    ['Transactions', /Transactions/],
    ['bank deposit timing', /Bank deposits|reaches their bank/i],
    ['Tax Center', /Tax Center/],
    ['human support', /GoHustlr Support|Contact support/],
    ['two-factor', /two-factor|Security/i],
    ['escrow', /escrow/i],
    ['who pays the fee', /comes out of the EARNER|earner's payout/i],
    // Added 2026-08-14 with the memory viewer. The single most likely question this
    // feature generates is "what do you remember about me / forget that" — and until
    // the screen existed the prompt told the model there was nowhere to send them,
    // which is now false.
    ['where stored memories live', /Hustlr AI remembers|Settings → What/i],
  ];

  MUST_KNOW.forEach(([what, re]) => {
    it(`can point someone at ${what}`, () => {
      expect(`${what}: ${re.test(prompt) ? 'known' : 'MISSING FROM PROMPT'}`)
        .toBe(`${what}: known`);
    });
  });

  it('is told not to invent screens or policies', () => {
    // The failure mode a stale prompt produces is not silence, it is confident
    // invention — the worst possible answer about someone's money.
    expect(prompt).toMatch(/[Nn]ever invent a screen/);
  });
});

// ── 3. Brand tokens, mobile ↔ web ───────────────────────────────────────────
// CLAUDE.md: "The web app mirrors the same values BY HAND as Tailwind @theme custom
// properties in web/app/globals.css; keep the two in lockstep." Nothing enforced it,
// and Tailwind v4 emits NO utility for an undefined token — so a drifted colour does
// not error, it silently renders as currentColor.
describe('brand colours match between the app and the website', () => {
  const theme = require('../shared/theme.js');
  const css = read('web/app/globals.css');

  const cssVar = (name) => {
    const m = css.match(new RegExp(`--color-${name}:\\s*(#[0-9A-Fa-f]{6})`));
    return m ? m[1].toLowerCase() : null;
  };

  // Only the tokens the website actually mirrors. Asserting every mobile token would
  // fail on ones the web has no use for, which is noise, and a noisy guard is a
  // deleted guard.
  const MIRRORED = [
    ['primary', 'primary'],
    ['primary-dark', 'primaryDark'],
    ['primary-light', 'primaryLight'],
    ['secondary', 'secondary'],
    ['urgent', 'urgent'],
  ];

  MIRRORED.forEach(([cssName, themeKey]) => {
    it(`--color-${cssName} matches theme.colors.${themeKey}`, () => {
      const web = cssVar(cssName);
      const mobile = String(theme.colors[themeKey] ?? '').toLowerCase();
      expect(`${cssName}: web=${web} mobile=${mobile}`)
        .toBe(`${cssName}: web=${mobile} mobile=${mobile}`);
    });
  });

  it('the retired accent/gold tokens have not crept back', () => {
    // CLAUDE.md: these were deliberately removed and split into warning/wash/rating/
    // primary. Tailwind emits nothing for an undefined token, so a stale accent-*
    // class fails silently as currentColor rather than erroring.
    expect(theme.colors.accent).toBeUndefined();
    expect(theme.colors.gold).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Both surfaces must be able to CONFIRM a staged action.
//
// The assistant gate stages anything hard to undo — posting a gig, booking work —
// and returns a `confirm_action` instead of doing it. The mobile sheet was taught to
// render that card and send the id back. The web widget was not, so for the life of
// that gate Hustlr AI on gohustlr.com received the staged action, dropped it on the
// floor, and quietly could not post or book at all. It still SAID it had.
//
// That is the shape of every cross-surface regression in this repo: a server contract
// changes, one client is updated, and the other keeps compiling perfectly. Nothing
// typed or bundled catches it, because nothing is broken — it is just absent. So the
// check has to be an explicit assertion that both clients speak the whole protocol.
// ─────────────────────────────────────────────────────────────────────────────
describe('the assistant confirmation gate is wired on BOTH clients', () => {
  const read = (p) => require('fs').readFileSync(require('path').join(__dirname, '..', p), 'utf8');
  const server = read('supabase/functions/assistant/index.ts');
  const surfaces = {
    mobile: read('src/components/AssistantButton.js') + read('src/lib/assistantClient.js'),
    web: read('web/components/AssistantWidget.tsx') + read('web/lib/assistant.ts'),
  };

  it('the server actually stages actions (otherwise this whole suite is moot)', () => {
    expect(server).toMatch(/type:\s*'confirm_action'/);
    expect(server).toMatch(/confirm_action_id/);
  });

  for (const [name, src] of Object.entries(surfaces)) {
    describe(name, () => {
      it('recognises a staged action instead of ignoring it', () => {
        expect(src).toMatch(/confirm_action/);
      });

      it('can send the id back to execute it', () => {
        // Without this the card is a dead end: the user clicks and nothing happens.
        expect(src).toMatch(/confirm_action_id|confirmActionId/);
      });

      it('offers a way to decline', () => {
        // A confirmation with no "no" is not a confirmation.
        expect(src).toMatch(/decline/i);
      });
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Both clients must hold the 2FA gate, and hold it FIRST.
//
// Two-factor shipped mobile-only. gohustlr.com had no assurance-level check anywhere,
// so a user who enrolled TOTP on their phone signed into the website with the password
// alone and got a full session — browse, book, message, PII. The feature was bypassable
// by opening a browser, which is the same as not having it.
//
// It survived because nothing was broken: web compiled, tested and shipped perfectly
// while simply not having the check. Absence compiles. Same shape as the assistant
// confirm-gate regression below — a capability lands on one surface and the other keeps
// building fine.
//
// ORDER is asserted too. A password sign-in on an account with a factor returns a REAL
// session at aal1, so the onboarding and terms gates would each let it through. The MFA
// branch has to come before them or holding it achieves nothing.
// ─────────────────────────────────────────────────────────────────────────────
describe('the two-factor gate is wired on BOTH clients', () => {
  const read = (p) => require('fs').readFileSync(require('path').join(__dirname, '..', p), 'utf8');

  const surfaces = {
    mobile: { auth: read('src/context/AuthContext.js'), shell: read('App.js') },
    web: { auth: read('web/lib/auth.tsx'), shell: read('web/app/(app)/layout.tsx') },
  };

  for (const [name, src] of Object.entries(surfaces)) {
    describe(name, () => {
      it('checks the assurance level after sign-in', () => {
        expect(src.auth).toMatch(/getAuthenticatorAssuranceLevel/);
      });

      it("treats nextLevel aal2 + currentLevel aal1 as 'owes a code'", () => {
        expect(src.auth).toMatch(/nextLevel\s*===\s*['"]aal2['"]/);
        expect(src.auth).toMatch(/currentLevel\s*===\s*['"]aal1['"]/);
      });

      it('keys the check on the ACCESS TOKEN, not the user id', () => {
        // Verifying a code issues a NEW session for the SAME user. Keyed on user id the
        // effect never re-runs and a correct code hangs the app forever — that bug
        // shipped on mobile and was hit immediately.
        expect(src.auth).toMatch(/session\?\.access_token/);
      });

      it('exposes the gate to the app shell', () => {
        expect(src.shell).toMatch(/needsMfaChallenge/);
      });

      it('holds the code prompt BEFORE onboarding and terms', () => {
        // Measure the DECISION lines, not the first mention. A naive search matches the
        // import and destructuring lines, where the order is alphabetical noise — the
        // first draft of this test failed on correct code for exactly that reason.
        const decisions = src.shell
          .split('\n')
          .filter((l) => /router\.replace\(|return <\w+Screen/.test(l));
        const idx = (re) => decisions.findIndex((l) => re.test(l));
        const mfa = idx(/needsMfaChallenge|MfaChallengeScreen/);
        const onboarding = idx(/\/onboarding|OnboardingScreen/);
        const terms = idx(/\/consent|ConsentScreen/);
        expect(`${name} has an mfa decision`).toBe(mfa > -1 ? `${name} has an mfa decision` : 'MISSING');
        if (onboarding > -1) expect(mfa).toBeLessThan(onboarding);
        if (terms > -1) expect(mfa).toBeLessThan(terms);
      });
    });
  }

  it('web offers the lost-phone recovery path', () => {
    // A 2FA screen with no exit turns a lost phone into a lost account, and fills a
    // support queue with cases nobody can verify.
    const page = read('web/app/mfa/page.tsx');
    expect(page).toMatch(/redeem_mfa_recovery_code/);
    expect(page).toMatch(/lost my phone/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Back-swipe stays on the EDGE, not the whole screen.
//
// react-native-screens flipped this default under us during the SDK 55 upgrade. 4.16.0
// (SDK 54) explicitly disabled UIKit's iOS 26 content-pop gesture — it set
// `interactiveContentPopGestureRecognizer.enabled = NO` and said in a comment that it
// could not safely own the delegate. 4.23.0 removed that line and now documents the prop
// as "defaults to false on iOS < 26 and TRUE for iOS >= 26". We build against the iOS 26
// SDK, so leaving it unset enables full-screen swipe-to-go-back on every pushed screen.
//
// A horizontal drag ANYWHERE then pops the screen: mid-form on PostJob or EditJob,
// mid-message on Chat, across ProfileSettings. Nothing in this app guards removal — there
// is no usePreventRemove anywhere — so the work is simply gone.
//
// This is a one-line opt-out that is easy to drop in a refactor and produces no error
// when it goes, which is exactly the shape that needs a test rather than a comment.
// ─────────────────────────────────────────────────────────────────────────────
describe('pushed screens do not swipe back from the middle of the screen', () => {
  const app = require('fs').readFileSync(require('path').join(__dirname, '..', 'App.js'), 'utf8');

  it('DETAIL_OPTS opts out of the full-screen pop gesture', () => {
    const block = app.slice(app.indexOf('const DETAIL_OPTS'), app.indexOf('const MANAGE_OPTS'));
    expect(block).toMatch(/fullScreenGestureEnabled:\s*false/);
  });

  it('nothing re-enables it elsewhere', () => {
    expect(app).not.toMatch(/fullScreenGestureEnabled:\s*true/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A minted promo code must be redeemable by somebody.
//
// `redeem_promo_code(text)` was granted to `authenticated` when promotions shipped and
// had ZERO callers in any client — verified by grep across src/, web/ and
// supabase/functions/. So the console could mint codes and no user could ever type one:
// every fee_override or poster_discount campaign distributed by code reached nobody.
// Direct grants worked, so incentives were not blocked — but a minted code was a dead
// string, which is worse than not offering codes.
//
// The RPC returns a bare boolean on purpose: distinct errors would be an existence oracle
// for brute-forcing valid codes, and it is rate-limited on ATTEMPTS rather than successes.
// So the client must show ONE message for every failure — asserted here, because the
// tempting "improvement" is to tell the user which kind of failure it was.
// ─────────────────────────────────────────────────────────────────────────────
describe('promo codes can actually be redeemed', () => {
  const read = (p) => require('fs').readFileSync(require('path').join(__dirname, '..', p), 'utf8');

  it('both clients call redeem_promo_code', () => {
    for (const p of ['src/lib/promoCodes.js', 'web/lib/promoCodes.ts']) {
      expect(`${p}: ${/rpc\(['"]redeem_promo_code['"]/.test(read(p))}`).toBe(`${p}: true`);
    }
  });

  it('there is a user-reachable entry point on BOTH clients', () => {
    // A helper nothing renders is the same dead end one layer up. And a code that only
    // works on the phone means a campaign distributed by code reaches half the users —
    // the same one-surface gap that made 2FA bypassable by opening a browser.
    for (const p of ['src/screens/SettingsScreen.js', 'web/app/(app)/settings/page.tsx']) {
      const settings = read(p);
      expect(`${p}: ${/redeemPromoCode/.test(settings)}`).toBe(`${p}: true`);
      expect(`${p}: ${/Have a code\?/.test(settings)}`).toBe(`${p}: true`);
    }
  });

  it('does not leak which failure occurred', () => {
    const settings = read('src/screens/SettingsScreen.js');
    // Exactly one failure message in the redemption path.
    const branch = settings.slice(settings.indexOf('redeemPromoCode(code)'), settings.indexOf('finally { setCodeBusy(false); }'));
    const messages = branch.match(/setCodeErr\((['"`])/g) ?? [];
    expect(messages.length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The address-masking contract must stay written down AND stay wired.
//
// `jobs.location` is masked by trg_mask_job_location → capture_job_location(); the exact
// label lives in `job_locations` behind an RLS policy that reveals it to the poster, and
// to an earner ONLY once their booking is accepted.
//
// None of that appeared in CLAUDE.md until 2026-08-13. A session that does not know it
// either concludes the address feature is broken, or "fixes" the masking and publishes
// every street address on the platform. That is a privacy control nobody had written
// down — which is strictly more dangerous than an undocumented feature.
// ─────────────────────────────────────────────────────────────────────────────
describe('the address-masking contract is documented', () => {
  const claude = require('fs').readFileSync(require('path').join(__dirname, '..', 'CLAUDE.md'), 'utf8');

  it('says jobs.location is masked', () => {
    expect(claude).toMatch(/jobs\.location.{0,40}MASKED|MASKED.{0,40}jobs\.location/is);
  });

  it('names where the exact address actually lives', () => {
    expect(claude).toMatch(/job_locations/);
  });

  it('states that an earner only sees it once the booking is accepted', () => {
    // The condition is the whole point — without it, an open application would leak it.
    expect(claude).toMatch(/confirmed.{0,60}completed.{0,60}verified/s);
  });

  it('names the rest of the safety subsystem', () => {
    expect(claude).toMatch(/gig_shares/);
    expect(claude).toMatch(/safety_checkins/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A documented prop signature must match the component's real one.
//
// CLAUDE.md listed MessageSheet's and CompletionModal's props and omitted `visible` —
// the prop that makes a modal appear. Anything built from those docs renders a component
// that mounts and never shows, with no error to explain it. A wrong signature is the
// expensive kind of doc rot: it does not send you searching, it sends you debugging.
//
// Only checks the props CLAUDE.md actually names — this is not a demand that the docs
// enumerate everything, just that what they DO say is true.
// ─────────────────────────────────────────────────────────────────────────────
describe('documented component props exist on the component', () => {
  const fs = require('fs');
  const path = require('path');
  const claude = fs.readFileSync(path.join(__dirname, '..', 'CLAUDE.md'), 'utf8');

  const components = ['MessageSheet', 'CompletionModal', 'FilterSheet', 'SlotPicker', 'BookingStatusBadge', 'ScreenHeader'];

  for (const name of components) {
    it(`${name}'s documented props are real`, () => {
      const file = path.join(__dirname, '..', 'src/components', `${name}.js`);
      if (!fs.existsSync(file)) return;
      const sig = (fs.readFileSync(file, 'utf8').match(new RegExp(`export default function ${name}\\(\\{([^}]*)\\}`)) || [])[1];
      if (!sig) return;
      const real = new Set(sig.split(',').map((t) => t.split('=')[0].trim()).filter(Boolean));

      // The doc line for this component, and the `backticked` props on it.
      const line = claude.split('\n').find((l) => l.includes(`**\`${name}\`**`)) ?? '';
      const documented = [...line.matchAll(/`([a-zA-Z][a-zA-Z0-9]*)`/g)]
        .map((m) => m[1])
        .filter((t) => t !== name && real.size > 0);

      const bogus = documented.filter((d) => /^(on[A-Z]|visible$|embedded$)/.test(d) && !real.has(d));
      expect(`${name}: ${bogus.join(', ') || 'none'}`).toBe(`${name}: none`);
    });
  }
});
