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

// Strip comments before asserting on source. Several files here EXPLAIN the contract they
// implement — quoting row titles, URLs and schemes verbatim — so a naive grep matches the
// explanation and reports a guard as green when the code underneath has drifted.
const codeOnly = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

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

  // The SAME set again, twice more: the in-app inboxes route a tapped alert by the
  // same data.tab. A tab missing from one of these does not fail loudly — the row
  // resolves to "nowhere", is marked read, and becomes a dead button. That is how
  // ProfileTab (the "Two-factor authentication was turned off" alert, the payout
  // alerts, every admin notice) was unroutable on mobile, and then, after mobile was
  // fixed, on the website.
  const inboxRouters = {
    'the app inbox (src/lib/notifications.js)': [
      read('src/lib/notifications.js'),
      /const TABS = \{([^}]*)\}/,
      /(\w+):/g,
    ],
    'the website inbox (web/lib/notifications.ts)': [
      read('web/lib/notifications.ts'),
      /const TAB_ROUTE: Record<string, string> = \{([^}]*)\}/,
      /(\w+):/g,
    ],
  };

  Object.entries(inboxRouters).forEach(([who, [src, block, key]]) => {
    it(`${who} routes every tab send-push will send`, () => {
      const body = src.match(block);
      expect(`${who} has a tab table: ${body ? 'yes' : 'NO'}`).toBe(`${who} has a tab table: yes`);
      const tabs = [...body[1].matchAll(key)].map((m) => m[1]);
      const unroutable = known.filter((k) => !tabs.includes(k));
      expect(`${who} cannot route: ${unroutable.join(', ') || 'none'}`)
        .toBe(`${who} cannot route: none`);
    });
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
  const shared = assistant.slice(assistant.indexOf('You are **Hustlr AI**'));

  // ONE function, TWO clients, and they do not have the same screens. Both POST the
  // same body, so the prompt used to hard-code the phone's navigation for everyone —
  // "You → Payments & payouts → Transactions" and "Messages → GoHustlr Support" name
  // screens gohustlr.com does not have. The prompt now carries a per-client block and
  // the caller says which surface it is; every check below runs against BOTH of the
  // prompts a real user can be served, not just the phone's.
  const placesBlock = (name) => {
    const m = assistant.match(new RegExp('const ' + name + ' = `([\\s\\S]*?)`;'));
    if (!m) throw new Error(`${name} is missing from supabase/functions/assistant/index.ts`);
    return m[1];
  };
  const PLACES = { mobile: placesBlock('PLACES_MOBILE'), web: placesBlock('PLACES_WEB') };
  const CLIENTS = ['mobile', 'web'];
  // The template interpolates ${places}; put each block back to get the prompt that
  // client is actually served. Function replacement, so a $ in the block is literal.
  const promptFor = (c) => shared.replace('${places}', () => PLACES[c]);
  const prompt = promptFor('mobile');

  const labels = [...app.matchAll(/<Tab\.Screen\s+name="[A-Za-z]+"\s+component=\{\w+\}\s+options=\{\{ title: '([^']+)'/g)]
    .map((m) => m[1]);

  it('finds the tab labels', () => {
    expect(labels).toEqual(expect.arrayContaining(['Browse', 'My Jobs', 'Hire', 'Messages', 'You']));
  });

  // ⚠️ These are checked against the prompt's TAB SENTENCE, not the whole prompt.
  //
  // A bare `prompt.includes(label)` was vacuous for exactly the tab whose rename this
  // block was written after: the prompt is sliced from "You are **Hustlr AI**", so
  // includes('You') is satisfied by its own first word — rename the tab back to
  // "Profile" and the suite stayed green. 'Hire' was weak the same way, satisfied by the
  // substring inside 'Hiring', which is the other stale name.
  const tabsLine = prompt.split('\n').find((l) => /^- The tabs are /.test(l)) ?? '';
  // Only the enumeration: the rest of the line legitimately QUOTES the old names in
  // `do not call them "Hiring" or "Profile"`.
  const tabsEnumeration = tabsLine.split(/They are named exactly that/)[0];

  it('the prompt still enumerates the tabs in one line', () => {
    // Everything below reads this line, so its absence must fail loudly rather than
    // quietly making four assertions vacuous.
    expect(`tabs line: ${tabsLine ? 'present' : 'MISSING FROM PROMPT'}`).toBe('tabs line: present');
    expect(tabsLine).toMatch(/do not call them/i);
  });

  labels.forEach((label) => {
    it(`names the "${label}" tab as the app names it`, () => {
      // Catches the exact drift that happened: a renamed tab the prompt never heard
      // about, so the assistant sends people to a tab that is not called that.
      // Word-bounded, so "Hire" cannot be satisfied by "Hiring".
      const named = new RegExp(`(^|[^A-Za-z])${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z]|$)`)
        .test(tabsEnumeration);
      expect(`${label}: ${named ? 'known' : 'MISSING FROM THE PROMPT’S TAB LINE'}`)
        .toBe(`${label}: known`);
    });
  });

  it('does not enumerate a tab by a name the app retired', () => {
    // The regression this block exists for, stated directly: "Hiring" and "Profile" are
    // what the prompt called Hire and You for months after they were renamed.
    const stale = ['Hiring', 'Profile'].filter((n) => tabsEnumeration.includes(n));
    expect(`retired names in the tab line: ${stale.join(', ') || 'none'}`)
      .toBe('retired names in the tab line: none');
  });

  // ── The assistant can tell the two clients apart at all ───────────────────
  // Without this the per-client block is decoration: the server would still send
  // every user the same directions.
  describe('is told which client is asking', () => {
    it('reads a client field off the request and passes it to the prompt', () => {
      const code = codeOnly(assistant);
      expect(code).toMatch(/client\?:\s*string/);
      expect(code).toMatch(/body\.client === 'web'/);
      expect(code).toMatch(/buildSystemPrompt\(user\.id, profile \?\? \{\}, client\)/);
    });

    it('the app says it is the app', () => {
      expect(codeOnly(read('src/lib/assistantClient.js'))).toMatch(/client:\s*'mobile'/);
    });

    it('the website says it is the website', () => {
      expect(codeOnly(read('web/lib/assistant.ts'))).toMatch(/client:\s*"web"/);
    });
  });

  // ── A named Settings row has to be a row that client HAS ──────────────────
  // This is the check that would have caught the original defect: the one prompt
  // told website users to open "Settings → Security", which on the website is
  // titled "Two-factor authentication".
  const rowTitles = (src) => [...src.matchAll(/title:\s*["']([^"']+)["']/g)].map((m) => m[1]);
  const SETTINGS_ROWS = {
    mobile: rowTitles(read('src/screens/SettingsScreen.js')),
    web: rowTitles(read('web/app/(app)/settings/page.tsx')),
  };

  CLIENTS.forEach((c) => {
    it(`every "Settings → …" row the ${c} prompt names exists in ${c} Settings`, () => {
      const named = [...PLACES[c].matchAll(/Settings → ([^,.;\n·]+)/g)].map((m) => m[1].trim());
      expect(named.length).toBeGreaterThan(0);
      const invented = named.filter((t) => !SETTINGS_ROWS[c].includes(t));
      expect(`${c} names rows that do not exist: ${invented.join(', ') || 'none'}`)
        .toBe(`${c} names rows that do not exist: none`);
    });
  });

  // ── The website block must not hand out app-only screens ──────────────────
  // Both of these are real screens — on a phone. On gohustlr.com they are nowhere,
  // and a user told to open one concludes the feature is broken.
  const APP_ONLY = [
    ['the Transactions ledger screen', /→ Transactions/],
    ['the in-app Support conversation', /Messages → GoHustlr Support/],
  ];
  APP_ONLY.forEach(([what, re]) => {
    it(`does not send website users to ${what}`, () => {
      expect(`${what}: ${re.test(PLACES.web) ? 'POINTS AT A SCREEN THE WEBSITE LACKS' : 'ok'}`)
        .toBe(`${what}: ok`);
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
    // Added 2026-09-05 with the share-link revoke control, extended when the same
    // controls reached the website. The share/SOS bar has existed since 2026-08-06 and
    // the prompt never mentioned it, so the assistant could not answer the two
    // questions it most obviously generates — "how do I stop sharing my location" and
    // "how do I get help right now" — and those are asked while someone is nervous
    // about going to a stranger's address. "I don't think the app does that" is the
    // worst available answer to either.
    ['stopping a location share', /Stop sharing my location/i],
    ['the in-gig safety controls', /Share my gig|Get help/],
    // Added 2026-09-06. The prompt named five destinations and the app has a dozen
    // more that people ASK about — so the assistant fell back on "I'm not sure, ask
    // Support" for questions one tap answers. The first two are the ones that cost
    // something: a ghosted earner was being told escrow releases "on completion" with
    // no mention of the button that releases it, and a poster holding a promo code was
    // sent to Support for a row that sits in Settings on both clients.
    ['claiming payment when a poster goes quiet', /Claim your payment/],
    ['redeeming a promo or referral code', /Have a code\?/],
    ['reporting or blocking someone', /Reporting or blocking/],
    // Added 2026-09-06 with the report control on the browse card. A user who
    // describes a scam listing they have NOT applied to was being told to open a
    // conversation or a profile they do not have — the one report path the prompt
    // knew about required a relationship with the person they are trying to avoid.
    ['reporting a listing from Browse', /Reporting a LISTING/],
    ['identity and student verification', /Verify Student Status/],
    ['inviting friends', /Invite friends/],
    ['saved gigs and saved people', /Saved gigs/],
    ['the alerts inbox', /Alerts inbox/],
    ['notification settings', /Notification settings/],
    ['availability and class schedule', /Availability & schedule/],
    ['market insights', /Browse → Insights/],
    ['closing an account', /Manage your account/],
    // Added 2026-09-08 with the two-party dispute flow. The earner's side of this is
    // the single most alarming notification the platform sends — "the poster asked to
    // pay you 50%" — and it is on a 48-hour clock. Before the flow existed there was
    // nothing to point at; now there is, and an assistant that answers "I'm not sure,
    // ask Support" costs the person the window.
    ['answering a reported problem', /48 hours to accept/],
    ['reporting a problem with finished work', /There was a problem/],
  ];

  // Run against BOTH prompts. A destination the website answers differently still
  // has to be answered — "it is in the phone app" is an answer; silence is not.
  CLIENTS.forEach((c) => {
    MUST_KNOW.forEach(([what, re]) => {
      it(`can point a ${c} user at ${what}`, () => {
        expect(`${c}/${what}: ${re.test(promptFor(c)) ? 'known' : 'MISSING FROM PROMPT'}`)
          .toBe(`${c}/${what}: known`);
      });
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

  // ── Forcing it is not the same as supporting it ───────────────────────────
  //
  // Until 2026-08-17 the web could FORCE you through two-factor and could not help you
  // manage it: the gate above shipped, and no page on gohustlr.com could turn 2FA on,
  // mint recovery codes, or turn it off. The only surface that could was a CURRENT build
  // of the mobile app — which is exactly the device someone locked out of their
  // authenticator may not have.
  //
  // It surfaced when an admin needed recovery codes, the simulator carried a stale SDK 54
  // dev client, and the honest answer from a laptop was "you cannot, from anywhere".
  describe('both clients can MANAGE two-factor, not only enforce it', () => {
    const managers = {
      mobile: read('src/screens/SecurityScreen.js'),
      web: read('web/app/(app)/settings/security/page.tsx'),
    };
    for (const [name, src] of Object.entries(managers)) {
      it(`${name} can enrol`, () => {
        expect(src).toMatch(/startEnrollment/);
        expect(src).toMatch(/confirmEnrollment/);
      });

      it(`${name} mints recovery codes AT enrolment, not later`, () => {
        // 2FA with no way back in turns a lost phone into a lost account, and "I'll do
        // it later" is how that happens. The generate call must sit inside the verify
        // path, not only behind a separate button.
        expect(src).toMatch(/generateRecoveryCodes/);
        const verifyAt = src.search(/confirmEnrollment\(/);
        const codesAt = src.search(/showFreshCodes\(\)/);
        expect(verifyAt).toBeGreaterThan(-1);
        expect(codesAt).toBeGreaterThan(verifyAt);
      });

      it(`${name} shows the codes BEFORE retiring the previous set`, () => {
        // confirmRecoveryCodes is the point of no return. Calling it before the new
        // codes are on screen destroys a working set for one nobody has seen.
        const show = src.search(/setCodes\(/);
        const confirm = src.search(/confirmRecoveryCodes\(\)/);
        expect(show).toBeGreaterThan(-1);
        expect(show).toBeLessThan(confirm);
      });

      it(`${name} requires a current code to turn it OFF`, () => {
        expect(src).toMatch(/disableMfa\(/);
      });

      it(`${name} reports "factor on, codes failed" as its own state`, () => {
        // The generic error here tells someone enrolment failed while the card reads
        // On — so they walk away believing they have neither 2FA nor recovery codes,
        // when in fact they have 2FA and no recovery codes. That is the exact state
        // that turns a lost phone into a lost account.
        expect(src).toMatch(/factorOn/);
        expect(src).toMatch(/could not create your recovery codes|couldn't create your recovery codes/i);
      });
    }

    it('is reachable from the web settings hub, not just by typing the URL', () => {
      expect(read('web/app/(app)/settings/page.tsx')).toMatch(/\/settings\/security/);
    });
  });

  // ── Every web gate lands in the APP, never on the marketing page ──────────
  //
  // "/" is web/app/page.tsx — the signed-out marketing hero, with no session check. The
  // MFA screen sent users there after a correct code, in all four of its navigations,
  // while login / onboarding / consent / the app layout all used /browse. Reported
  // 2026-08-17: "typed in MFA, it took me back to home screen, but when I clicked sign in
  // it took me right back logged in" — the second half being /login noticing the session
  // the user already had.
  //
  // A gate that lands you somewhere indistinguishable from signed-out is a gate people
  // conclude did not work.
  it('no auth gate on web sends a signed-in user to the marketing page', () => {
    const gates = [
      'web/app/mfa/page.tsx',
      'web/app/login/page.tsx',
      'web/app/onboarding/page.tsx',
      'web/app/consent/page.tsx',
      'web/app/(app)/layout.tsx',
    ];
    const offenders = [];
    for (const g of gates) {
      const src = read(g)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      // Exactly `router.replace("/")` — the root. Sub-paths are fine.
      if (/router\.(replace|push)\((["'])\/\2\)/.test(src)) offenders.push(g);
    }
    expect(offenders).toEqual([]);
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
// Both surfaces must be able to show — and delete — what the assistant remembers.
//
// `remember` appends to profiles.assistant_memory and every stored fact is replayed
// into the system prompt of every future conversation. The viewer shipped mobile-only,
// so a web user's only way to remove one was to keep chatting until 25 newer facts
// pushed it out. And the prompt now TELLS every user, on both clients, to go to
// Settings and read or delete them — a privacy control that exists on one surface and
// is advertised on both is worse than one that exists on neither.
//
// The two mechanics below are asserted because both are invisible when wrong and both
// were got right once already: the column is outside the profiles SELECT grant
// (20260624221000_profile_column_lockdown.sql), so a direct .select() returns a
// permission error rather than the list — and chaining .select() onto the WRITE reports
// a failure on a write that succeeded.
// ─────────────────────────────────────────────────────────────────────────────
describe('the assistant memory viewer is wired on BOTH clients', () => {
  const read = (p) => require('fs').readFileSync(require('path').join(__dirname, '..', p), 'utf8');

  const helpers = { mobile: 'src/lib/assistantMemory.js', web: 'web/lib/assistantMemory.ts' };
  const screens = {
    mobile: 'src/screens/AssistantMemoryScreen.js',
    web: 'web/app/(app)/settings/memory/page.tsx',
  };
  const settings = { mobile: 'src/screens/SettingsScreen.js', web: 'web/app/(app)/settings/page.tsx' };

  // Both helpers explain in prose why they never call .select() on this column, quoting
  // the very call they forbid — so the check below has to read the CODE. Whole-line
  // comments only: the trailing ones in these files carry no PostgREST calls, and
  // stripping `//` anywhere would eat the `https://` in a link.
  const code = (p) => read(p).split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

  for (const [name, helper] of Object.entries(helpers)) {
    describe(name, () => {
      const src = read(helper);

      it('reads the list through my_profile()', () => {
        expect(`${helper}: ${/rpc\(['"]my_profile['"]\)/.test(src)}`).toBe(`${helper}: true`);
      });

      it('never asks PostgREST for the column directly', () => {
        // assistant_memory is not in the profiles column allowlist, so a direct select
        // returns a permission error — which renders as "nothing is stored about you".
        // The same call chained onto the UPDATE is the other half: it would report a
        // failure on a write that had already succeeded.
        expect(`${helper}: ${/\.select\(/.test(code(helper))}`).toBe(`${helper}: false`);
      });

      it('offers both a single delete and a clear-all', () => {
        expect(src).toMatch(/export async function forgetMemory/);
        expect(src).toMatch(/export async function forgetAllMemories/);
      });
    });
  }

  it('there is a user-reachable entry point on BOTH clients', () => {
    // A helper nothing renders is a dead end one layer up. The wording is asserted, not
    // just the link: the assistant's prompt names this row verbatim ("Settings → What
    // Hustlr AI remembers"), so renaming it on one client sends those users looking for
    // something that is not there.
    //
    // Matched against CODE ONLY. Both files explain this contract in a comment that
    // quotes the row title, so a whole-file grep was satisfied by the prose: renaming
    // the actual web row to "AI memory" left this green. Third time in one day that an
    // assertion here matched an explanation instead of the thing it describes.
    for (const p of Object.values(settings)) {
      expect(`${p}: ${/What Hustlr AI remembers/.test(codeOnly(read(p)))}`).toBe(`${p}: true`);
    }
  });

  it('both screens can delete one note and all of them', () => {
    for (const p of Object.values(screens)) {
      const src = read(p);
      expect(`${p}: ${/forgetMemory/.test(src)}`).toBe(`${p}: true`);
      expect(`${p}: ${/forgetAllMemories/.test(src)}`).toBe(`${p}: true`);
    }
  });

  it('neither screen renders an empty list it never loaded', () => {
    // The one wrong answer this feature must never give is "nothing is stored about
    // you" when plenty is. Both screens keep a not-yet-loaded state distinct from an
    // empty one, which is the same three-state discipline the ledger needed.
    for (const p of Object.values(screens)) {
      const src = read(p);
      expect(`${p}: ${/useState\(null\)|useState<string\[\] \| null>\(null\)/.test(src)}`).toBe(`${p}: true`);
      expect(`${p}: ${/memories === null/.test(src)}`).toBe(`${p}: true`);
    }
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
// A client that can START a gig must be able to raise the alarm on it.
//
// The web app could write bookings.started_at long before it could mint a share link
// or raise an SOS. The server side was never the gap — open_safety_checkin fires on
// any started_at write regardless of client, so a web earner always got the check-in
// timer, its nudge and its escalation. What was absent is everything the person can
// reach for THEMSELVES: an earner on a phone browser with no TestFlight build stood in
// a stranger's house with no way to tell anyone where they were and no SOS, while the
// public /s/[token] page existed on web the whole time. A safety feature that is
// readable and not usable is worse than an absent one, because the product implies it.
//
// This is the same shape as the assistant-gate and 2FA sections above: nothing is
// broken, nothing fails to compile, one client simply does not speak the protocol. So
// the check has to be an explicit assertion that both clients call both RPCs.
// ─────────────────────────────────────────────────────────────────────────────
describe('the in-gig safety controls are wired on BOTH clients', () => {
  // Read defensively: a client that has no safety bar at all is the exact regression
  // this section is for, and it must report as a named failing assertion rather than
  // throwing at describe-body time and taking the other 80 parity tests with it.
  const readOrNull = (p) => {
    try { return read(p); } catch { return null; }
  };
  const surfaces = {
    mobile: readOrNull('src/components/SafetyBar.js'),
    web: readOrNull('web/components/SafetyBar.tsx'),
  };
  const RPCS = ['create_gig_share', 'raise_gig_emergency'];

  it('the RPCs the clients call actually exist server-side', () => {
    const mig = read('supabase/migrations/20260806180000_gig_safety.sql')
      + read('supabase/migrations/20260806300000_share_token_hardening.sql');
    for (const rpc of RPCS) expect(mig).toMatch(new RegExp(`function public\\.${rpc}\\(`));
  });

  for (const [name, src] of Object.entries(surfaces)) {
    describe(name, () => {
      it('has an in-gig safety component at all', () => {
        expect(`${name} SafetyBar: ${src === null ? 'MISSING' : 'present'}`)
          .toBe(`${name} SafetyBar: present`);
      });

      for (const rpc of RPCS) {
        it(`can call ${rpc}`, () => {
          // codeOnly: both files EXPLAIN the contract in prose that names the RPCs,
          // so a naive grep passes on a component that only talks about them.
          expect(codeOnly(src ?? '')).toMatch(new RegExp(`rpc\\(\\s*['"]${rpc}['"]`));
        });
      }

      it('gates the emergency behind a confirm and the share behind none', () => {
        // Deliberately different weights: a mis-tapped SOS pages a real person, while
        // friction on the share is how a safety feature goes unused.
        expect(src ?? '').toMatch(/cancel/i);
      });
    });
  }

  it('the started-gig card on web actually renders it', () => {
    // The component existing but never mounted is the same outage with extra steps.
    const page = read('web/app/(app)/my-jobs/page.tsx');
    expect(page).toMatch(/import SafetyBar from/);
    expect(codeOnly(page)).toMatch(/<SafetyBar\b/);
  });

  it('the started-gig card on mobile actually renders it', () => {
    expect(codeOnly(read('src/screens/EarnScreen.js'))).toMatch(/<SafetyBar\b/);
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

// ─────────────────────────────────────────────────────────────────────────────
// Deleting a gig is gated ONLY in the clients, so the three must say the same thing.
//
// deleteJob is a bare `update({ status: 'cancelled' })` (JobsContext / web jobs.tsx).
// guard_jobs_delete fires on a hard DELETE and guard_jobs_write never reads status, so
// nothing server-side decides whether a listing may be withdrawn — the predicate in the
// client IS the rule. Two of the three agreed on pending/confirmed/completed;
// EditJobScreen reused its core-terms lock (confirmed/completed/verified) instead, and
// was wrong at both ends:
//
//   · 'pending' missing — Edit → Delete soft-cancelled a gig out from under live
//     applications, leaving applicants on "Awaiting confirmation" for a listing that no
//     longer exists until expire_stale_pending_bookings(14) catches up 14 days later.
//   · 'verified' included — a finished, paid gig answered "Someone is actively working
//     this gig" on Edit while the Hire tab deleted it without a word.
//
// Editing and deleting are different questions: 'verified' locks the TERMS (the deal is
// done and cannot be restated) and 'pending' does not, while 'pending' blocks the
// WITHDRAWAL and 'verified' does not. The lock predicate is deliberately left alone here.
// ─────────────────────────────────────────────────────────────────────────────
describe('all three delete gates enumerate the same booking statuses', () => {
  // The statuses named in the statement that declares the gate. Comment-stripped, since
  // every one of these files explains the rule in prose right next to it.
  const gateStatuses = (file, varName) => {
    const src = codeOnly(read(file));
    const at = src.indexOf(varName);
    expect(`${file} declares ${varName}`).toBe(at > -1 ? `${file} declares ${varName}` : 'MISSING');
    const stmt = src.slice(at, src.indexOf(';', at));
    return [...stmt.matchAll(/["']([a-z]+)["']/g)].map((m) => m[1]).sort();
  };

  const EXPECTED = ['completed', 'confirmed', 'pending'];

  it('the mobile Hire tab gates on pending/confirmed/completed', () => {
    expect(gateStatuses('src/screens/GigsScreen.js', 'activeBookings')).toEqual(EXPECTED);
  });

  it('the web edit page gates on the same set', () => {
    expect(gateStatuses('web/app/(app)/hiring/[id]/edit/page.tsx', 'hasUnresolvedBooking')).toEqual(EXPECTED);
  });

  it('the mobile edit screen gates on the same set, not on its core-terms lock', () => {
    expect(gateStatuses('src/screens/EditJobScreen.js', 'unresolvedBooking')).toEqual(EXPECTED);
  });

  it('the mobile edit screen deletes on the delete gate, not on isLocked', () => {
    // The defect was one identifier: handleDelete tested `isLocked`, which is the
    // core-terms lock. Reusing it here is what produced both wrong answers.
    const src = codeOnly(read('src/screens/EditJobScreen.js'));
    const handler = src.slice(src.indexOf('const handleDelete'), src.indexOf('const handleDelete') + 400);
    expect(handler).toMatch(/if \(!canDelete\)/);
    expect(handler).not.toMatch(/if \(isLocked\)/);
  });

  it('the core-terms lock is still its own, different predicate', () => {
    // Guarding the fix in the other direction: collapsing the two would unlock a
    // verified booking's terms, or lock a poster out of editing a gig that only has
    // applications.
    const src = codeOnly(read('src/screens/EditJobScreen.js'));
    const stmt = src.slice(src.indexOf('const lockedBooking'), src.indexOf(';', src.indexOf('const lockedBooking')));
    expect([...stmt.matchAll(/["']([a-z]+)["']/g)].map((m) => m[1]).sort())
      .toEqual(['completed', 'confirmed', 'verified']);
  });
});

// ── 6. A consent document promising a control that exists ───────────────────
// The Terms and the Privacy Policy (20260806190000, republished verbatim as the
// 2026-08-12 versions) tell posters and earners that a gig share link "can be switched
// off by the Earner at any time" and that "the Earner can revoke it at any time". The
// schema always allowed it — gig_shares_revoke_own, plus a pin trigger that permits
// revoked_at — and no client ever wrote the column. SafetyBar had exactly two actions,
// share and SOS, so the only end to a link was its 12-hour expiry (24-hour ceiling),
// and a link discloses the poster's exact street address, both first names and live
// status.
//
// A document asserting a control that does not exist is worse than a missing feature:
// it is what the user relied on when they consented.
// ─────────────────────────────────────────────────────────────────────────────
describe('the share link can be revoked, because the legal text says it can', () => {
  const legal = read('supabase/migrations/20260806190000_safety_share_disclosure.sql');

  it('the published legal text does promise revocation', () => {
    // If this stops matching, the promise moved and the assertion below is aimed at
    // nothing — fix the pointer rather than deleting the guard.
    expect(legal).toMatch(/switched off by the Earner at any time|revoke it at any time/);
  });

  it('every client that mints a share also offers a way to stop it', () => {
    const src = ['src', 'web', 'admin'];
    const minters = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '.next') continue;
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(rel);
        else if (/\.(js|jsx|ts|tsx)$/.test(e.name)) {
          const body = fs.readFileSync(path.join(ROOT, rel), 'utf8');
          if (body.includes('create_gig_share')) minters.push([rel, body]);
        }
      }
    };
    src.forEach(walk);

    expect(minters.length).toBeGreaterThan(0);
    const silent = minters
      .filter(([, body]) => !codeOnly(body).includes('revoked_at'))
      .map(([rel]) => rel);
    expect(silent).toEqual([]);
  });
});
