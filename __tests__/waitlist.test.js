// ─────────────────────────────────────────────────────────────────────────────
// The waitlist's promises, asserted.
//
// A waitlist is a small feature with three failures that are expensive out of all
// proportion to its size, and every one of them is silent:
//
//   1. You mail somebody who opted out. There is no support thread and no account —
//      the unsubscribe link is the ONLY way they can make it stop, so the code that
//      honours it must not be able to be switched off, deferred, or raced.
//   2. You tell somebody they are invited and the signup gate does not agree. They
//      click the link and handle_new_user raises server-side with no message.
//   3. You turn the form into a mailer for a stranger's inbox. A cooldown is not a
//      cap, and a GET that unsubscribes is not an opt-out — it is a way for a link
//      scanner to empty the list.
//
// Everything below exists because the alternative was already written once and
// looked correct.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const MIGRATION = 'supabase/migrations/20260908010000_a_waitlist_for_a_launch_that_has_not_happened.sql';
const sql = read(MIGRATION);
// SQL with the prose stripped. The header ARGUES the cuts ("NO PHONE COLUMN…"), which is
// exactly what it should do — but a check for the absence of a word has to look at the
// DDL, not at the paragraph explaining why the word is absent.
const sqlCode = sql.replace(/^\s*--.*$/gm, '');
const fn = strip(read('supabase/functions/waitlist-submit/index.ts'));
const form = strip(read('web/components/waitlist/WaitlistForm.tsx'));
const page = strip(read('web/app/page.tsx'));
const unsubBtn = strip(read('web/app/waitlist/unsubscribe/UnsubscribeButton.tsx'));
const adminPage = strip(read('admin/app/(console)/waitlist/page.tsx'));
const adminActions = strip(read('admin/app/(console)/waitlist/actions.ts'));
const config = read('supabase/config.toml');

describe('an opt-out cannot be blocked, deferred, or reached by a scanner', () => {
  it('unsubscribe refuses anything but POST', () => {
    // Corporate mail filters and link scanners fetch every URL in a message before the
    // human sees it. A GET that opts people out empties the list one appliance at a
    // time, and nobody would ever see an error.
    expect(fn).toMatch(/op === 'unsubscribe' && req\.method !== 'POST'/);
    expect(fn).toMatch(/method_not_allowed/);
  });

  it('confirm is still reachable by GET, so the plain link in the email works', () => {
    const guard = fn.slice(fn.indexOf("op === 'confirm' || op === 'unsubscribe'"), fn.indexOf('handleToken(supabase, op, token)'));
    expect(guard).not.toMatch(/op === 'confirm' &&[^]*?!== 'POST'/);
  });

  it('the waitlist_enabled flag gates JOIN only, never confirm or unsubscribe', () => {
    // A feature flag that can stop somebody unsubscribing is a feature flag with a
    // legal shape. The flag check must sit AFTER the token ops have already returned.
    const flagAt = fn.indexOf("app_flag', { p_key: 'waitlist_enabled'");
    const tokenReturn = fn.indexOf('return await handleToken');
    expect(flagAt).toBeGreaterThan(-1);
    expect(tokenReturn).toBeGreaterThan(-1);
    expect(tokenReturn).toBeLessThan(flagAt);
  });

  it('the row is scrubbed inline, not left for the purge', () => {
    // Honouring an opt-out must not depend on pg_cron. purge_waitlist_expired
    // deliberately does NOT touch unsubscribed rows.
    // Anchored on CODE, not on the comment that explains it — `strip` removes the
    // prose, so a comment anchor slices to nothing and the assertion passes vacuously.
    const unsub = fn.slice(fn.indexOf("if (op === 'confirm')"));
    expect(unsub).toMatch(/unsubscribed_at: row\.unsubscribed_at \?\? new Date\(\)\.toISOString\(\)/);
    expect(unsub).toMatch(/token_hash: `retired:\$\{row\.id\}`/);
    // And the purge deliberately leaves unsubscribed rows alone — the suppression
    // list is the point, so it must survive retention.
    const purge = sqlCode.slice(sqlCode.indexOf('create or replace function public.purge_waitlist_expired'), sqlCode.indexOf('revoke execute on function public.purge_waitlist_expired'));
    expect(purge).toMatch(/confirmed_at is null/);
    expect(purge).toMatch(/unsubscribed_at is null/);
    expect(purge).toMatch(/interval '180 days'/);
  });

  it('a control watches the promise against data, not against the send code', () => {
    expect(sql).toMatch(/create or replace function public\.ctl_waitlist_emailed_after_optout/);
    expect(sql).toMatch(/w\.last_email_sent_at > w\.unsubscribed_at/);
    expect(sql).toMatch(/\('waitlist_emailed_after_optout',[\s\S]{0,200}'critical', 'security'/);
  });

  it('the console can never invite an opted-out address, and says how many it skipped', () => {
    expect(adminActions).toMatch(/const optedOut = \(rows \?\? \[\]\)\.filter\(\(r\) => r\.unsubscribed_at\)/);
    expect(adminActions).toMatch(/!r\.unsubscribed_at/);
    expect(adminActions).toMatch(/skipped_unsubscribed/);
    // And the export excludes them in EVERY scope, not only the default one.
    const exp = adminActions.slice(adminActions.indexOf('export async function exportWaitlist'));
    const isNull = exp.indexOf('.is("unsubscribed_at", null)');
    const confirmed = exp.indexOf('.not("confirmed_at", "is", null)');
    const scopeIf = exp.indexOf('if (scope === "invitable")');
    expect(isNull).toBeGreaterThan(-1);
    expect(isNull).toBeLessThan(scopeIf);
    // Double opt-in gets no scope exception either. The confirmation email tells an
    // unconfirmed person "we won't write again" in as many words.
    expect(confirmed).toBeGreaterThan(-1);
    expect(confirmed).toBeLessThan(scopeIf);
  });
});

describe('the form cannot be turned into a mailer for somebody else', () => {
  it('the send cap is a LIFETIME count, not a cooldown', () => {
    // A ten-minute floor still allows 144 messages a day to one victim.
    expect(fn).toMatch(/LIFETIME_EMAIL_CAP = 3/);
    expect(fn).toMatch(/\(row\.email_sent_count \?\? 0\) < LIFETIME_EMAIL_CAP/);
    expect(fn).not.toMatch(/interval|cooldown|10 \* 60 \* 1000/);
  });

  it('an opt-out is never reversed by a join, and a suppressed row is never mailed', () => {
    // The first cut of this let a join clear unsubscribed_at, which made the opt-out
    // cancellable by anyone who knew the address — with one unauthenticated POST, no
    // proof of mailbox ownership, and no trace, because the same write also blinded
    // ctl_waitlist_emailed_after_optout (it anchors on unsubscribed_at is not null).
    expect(fn).not.toMatch(/unsubscribed_at: null/);
    expect(fn).not.toMatch(/resubscribing/);
    expect(fn).toMatch(/!row\.unsubscribed_at/);
  });

  it('a lost confirmation email does not strand the address forever', () => {
    // Gating the send on "this request created the row" meant one dropped send — a
    // rotated key, a bounce, a flood window — silently stranded that address: every
    // later attempt conflicted, skipped the email, and showed the same cheerful
    // success. The lifetime cap is the bound, not the newness of the row.
    const send = fn.slice(fn.indexOf('const shouldSend'), fn.indexOf('if (shouldSend)'));
    expect(send).not.toMatch(/isNew/);
    expect(send).toMatch(/email_sent_count \?\? 0\) < LIFETIME_EMAIL_CAP/);
    // And the token that goes OUT in that email is the one stored, or the link 404s.
    expect(fn).toMatch(/token_hash: tokenHash,/);
  });

  it('the stored address is the address GoTrue will see at signup', () => {
    // A +tag strip folded jane+hustlr@ulm.edu to jane@ulm.edu, so inviteCohort
    // allowlisted an address the person never types and handle_new_user refused their
    // signup server-side, minutes after we told them they were in.
    const norm = fn.slice(fn.indexOf('function normalizeEmail'), fn.indexOf('function normalizeEmail') + 400);
    expect(norm).toMatch(/return email\.trim\(\)\.toLowerCase\(\);/);
    expect(norm).not.toMatch(/split\('\+'\)/);
    const trigger = read('supabase/migrations/20260908020000_the_waitlist_purge_had_no_caller.sql');
    expect(trigger).toMatch(/new\.email := lower\(btrim\(coalesce\(new\.email, ''\)\)\);/);
    expect(trigger).not.toMatch(/position\('\+' in split_part/);
  });

  it('the per-caller cap cannot be switched off by omitting a header', () => {
    expect(fn).toMatch(/\|\| 'unknown'/);
    expect(fn).not.toMatch(/if \(!ip\) return null/);
  });

  it('the retention the migration and the privacy policy promise actually runs', () => {
    // purge_waitlist_expired shipped with a definition, a grant, a probe — and no
    // caller. Same shape as purge_assistant_pending_actions before 20260814070000.
    const sweep = read('supabase/migrations/20260908020000_the_waitlist_purge_had_no_caller.sql');
    expect(sweep).toMatch(/perform public\.purge_waitlist_expired\(\);/);
    // Copied forward from LIVE pg_proc, so the steps it already had survive. Rebuilding
    // from an older FILE is how 20260906034000 dropped a safety stage.
    ['run_safety_checkin_stages', 'vest_bonuses', 'expire_stale_pending_bookings',
     'expire_dead_listings', 'purge_assistant_pending_actions', 'run_all_controls'].forEach((step) => {
      expect(sweep).toContain(step);
    });
  });

  it('the counter is a compare-and-set, so two concurrent submissions cannot both send', () => {
    expect(fn).toMatch(/\.eq\('email_sent_count', sentSoFar\)/);
    expect(fn).toMatch(/stamped \?\? \[\]\)\.length === 0/);
  });

  it('the send is stamped BEFORE it goes out', () => {
    const body = fn.slice(fn.indexOf('async function sendConfirmEmail'));
    expect(body.indexOf("email_sent_count: sentSoFar + 1")).toBeLessThan(body.indexOf('api.resend.com'));
  });

  it('the per-caller rate check fails CLOSED', () => {
    expect(fn).toMatch(/if \(error\) return rateLimited\(\);/);
  });

  it('the global cap DEGRADES — the row is kept, only the email is skipped', () => {
    // Refusing on a global cap lets one flood take the waitlist away from every real
    // visitor for an hour. support-submit makes the same split for the same reason.
    expect(fn).toMatch(/globalFlood = globalErr \? true : \(globalCount \?\? 0\) >= 200/);
    expect(fn).toMatch(/!globalFlood &&/);
  });
});

describe('the endpoint is not an existence oracle', () => {
  it('join answers identically whatever it found', () => {
    const join = fn.slice(fn.indexOf('const LIFETIME_EMAIL_CAP'), fn.indexOf('} catch (err)'));
    const bodies = [...join.matchAll(/return json\(\{([^}]*)\}\)/g)].map((m) => m[1].trim());
    expect(bodies).toContain('ok: true');
    // Nothing in the success body may vary with what was found.
    bodies.forEach((b) => expect(b).not.toMatch(/already|existing|duplicate|emailed|isNew|resubscrib/i));
  });

  it("the form's success copy is true whether or not an email was sent", () => {
    // "We sent a confirmation link to X" is false for a duplicate, and the endpoint
    // deliberately will not tell the client which case it was.
    expect(form).toMatch(/If this is the first time you&rsquo;ve entered/);
    expect(form).not.toMatch(/We sent a confirmation link/);
  });
});

describe('an invite is kept by a row in another table, so the order matters', () => {
  it('the gate is written BEFORE the row is stamped', () => {
    const body = adminActions.slice(adminActions.indexOf('export async function inviteCohort'));
    const gate = body.indexOf('.from("beta_allowlist")');
    const stamp = body.indexOf('invited_at: new Date()');
    expect(gate).toBeGreaterThan(-1);
    expect(stamp).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(stamp);
  });

  it('it routes through the same beta_allowlist upsert /access uses', () => {
    expect(adminActions).toMatch(/\.upsert\(\s*eligible\.map[\s\S]{0,200}\{ onConflict: "email" \}/);
  });

  it('a half-failed invite is reported as such, not as a clean success', () => {
    expect(adminActions).toMatch(/allowlist write failed, nothing was invited/);
    expect(adminActions).toMatch(/but recording the invite failed/);
  });

  it('a control catches the state where the two tables disagree', () => {
    expect(sql).toMatch(/create or replace function public\.ctl_waitlist_invite_broken/);
    expect(sql).toMatch(/w\.invited_at is not null/);
    expect(sql).toMatch(/from public\.beta_allowlist b where b\.email = '\*'/);
    expect(sql).toMatch(/from auth\.users u where lower\(u\.email\) = w\.email/);
  });

  it('the console says out loud that invites grant nothing while signups are open', () => {
    expect(adminPage).toMatch(/Signups are open to everyone right now/);
    expect(adminPage).toMatch(/beta_allowlist/);
  });
});

describe('the data collected is the data promised', () => {
  it('there is no phone column and no SMS anywhere in the feature', () => {
    // Scoped to the waitlist's OWN code. tombstone_profile legitimately says
    // `provider not in ('email', 'phone')` — that is an auth provider name, not a
    // column, and this migration re-types that function in full.
    const table = sqlCode.slice(sqlCode.indexOf('create table if not exists public.waitlist ('), sqlCode.indexOf('create table if not exists public.waitlist_attempts'));
    [table, fn, form].forEach((src) => {
      expect(src).not.toMatch(/\bphone\b|twilio|\bsms\b/i);
    });
  });

  it('the ZIP is checked in the browser and never transmitted', () => {
    expect(form).toMatch(/const LAUNCH_ZIPS = new Set\(/);
    // Only the boolean crosses the wire.
    const bodyBlock = form.slice(form.indexOf('body: JSON.stringify'), form.indexOf('});', form.indexOf('body: JSON.stringify')));
    expect(bodyBlock).toMatch(/inLaunchArea:/);
    expect(bodyBlock).not.toMatch(/\bzip\b/);
    expect(sql).not.toMatch(/^\s*zip\s/m);
  });

  it('the durable row holds no IP — the attempt ledger does, hashed', () => {
    const table = sql.slice(sql.indexOf('create table if not exists public.waitlist ('), sql.indexOf('comment on table public.waitlist'));
    expect(table).not.toMatch(/\bip\b/);
    expect(sql).toMatch(/create table if not exists public\.waitlist_attempts[\s\S]{0,300}ip_hash/);
    expect(fn).toMatch(/sha256Hex\(`\$\{ip\}:\$\{Deno\.env\.get\('SUPABASE_SERVICE_ROLE_KEY'\)/);
  });

  it('the subject-access export reaches the waitlist, because erasure deletes it', () => {
    // It cannot live in TABLES — every entry there filters on a column holding the
    // user's id, and waitlist is keyed on an email. exportCoverage.test.js enumerates
    // by FK, so it is structurally blind to the omission too.
    const route = strip(read('admin/app/(console)/users/[id]/export/route.ts'));
    expect(route).toMatch(/\["waitlist", "waitlist_attempts"\]/);
    expect(route).toMatch(/\.eq\("email", wlEmail\)/);
    // The token is a live credential, not subject data.
    expect(route).not.toMatch(/token_hash/);
  });

  it('the consent version is resolved server-side, not asserted by the client', () => {
    expect(fn).toMatch(/from\('legal_documents'\)[\s\S]{0,200}eq\('slug', 'privacy'\)/);
    expect(form).not.toMatch(/consentDocVersion/);
  });

  it('erasure reaches the waitlist row, and the backfill covers accounts already erased', () => {
    expect(sql).toMatch(/create or replace function public\.tombstone_profile/);
    const tomb = sql.slice(sql.indexOf('create or replace function public.tombstone_profile'));
    expect(tomb).toMatch(/delete from public\.waitlist w\s+using auth\.users u/);
    // The copy-forward must not have lost anything: these four are what the live body
    // carries, and dropping one silently breaks account deletion.
    ['student_email_verifications', 'auth.identities', "username        = 'deleted_'", 'deleted_at      = coalesce'].forEach((needle) => {
      expect(tomb).toContain(needle);
    });
    expect(tomb).toMatch(/set search_path = public/);
  });
});

describe('posture and registration', () => {
  it('RLS is on with no policies and every grant is revoked from anon', () => {
    expect(sql).toMatch(/alter table public\.waitlist enable row level security/);
    expect(sql).toMatch(/revoke all on public\.waitlist from anon, authenticated/);
    expect(sql).toMatch(/revoke all on public\.waitlist_attempts from anon, authenticated/);
    expect(sql).not.toMatch(/create policy[^;]*on public\.waitlist\b/);
  });

  it('the function is registered as no-JWT in config.toml, with the reason', () => {
    expect(config).toMatch(/\[functions\.waitlist-submit\]\s*\nverify_jwt = false/);
    const stanza = config.slice(config.indexOf('# waitlist-submit'), config.indexOf('[functions.waitlist-submit]'));
    expect(stanza.length).toBeGreaterThan(100);
  });

  it('all three controls are registered in the registry', () => {
    ['waitlist_emailed_after_optout', 'waitlist_invite_broken', 'waitlist_signup_flood'].forEach((key) => {
      expect(sql).toMatch(new RegExp(`\\('${key}',`));
      expect(sql).toMatch(new RegExp(`'ctl_${key}'`));
    });
  });

  it('every console action steps up, and the read is admin-tier', () => {
    expect(adminActions).toMatch(/async function adminCtx\(\)\s*\{\s*return requireFreshAdmin\("admin"\);/);
    expect(adminActions).not.toMatch(/requireAdmin\(/);
    expect(adminPage).toMatch(/requireAdminPage\("admin"\)/);
    // Authority computed from the tier the ACTIONS accept, never an equality check on
    // the role — the mismatch that let trust operators read /moderation and act on
    // nothing.
    expect(adminPage).toMatch(/const canAct = roleSatisfies\(ctx\.role, "admin"\)/);
    expect(adminPage).not.toMatch(/ctx\.role === "admin"/);
  });

  it('the console filters, orders and counts in the QUERY', () => {
    // Filtering a fetched window in JS drops exactly the people who have been waiting
    // longest and under-counts every badge at the same time — the /support lesson.
    expect(adminPage).toMatch(/\.range\(0, PAGE_SIZE - 1\)/);
    expect(adminPage).toMatch(/\{ count: "exact", head: true \}/);
    expect(adminPage).toMatch(/function scope</);
    // An email can legally contain % and _, so a pattern built from user input widens
    // the read silently. /access learned this the hard way.
    expect(adminPage).toMatch(/if \(q\) listQ = listQ\.eq\("email", q\)/);
    expect(adminPage).not.toMatch(/\.ilike\(/);
  });

  it('the CSV neutralises a formula, because source is user-supplied', () => {
    expect(adminActions).toMatch(/\/\^\[=\+\\-@\\t\\r\]\//);
  });
});

describe('the landing page stopped claiming things that were not true', () => {
  it('the invented testimonials are gone and nothing re-creates their shape', () => {
    expect(page).not.toMatch(/Maya R\.|Dana K\.|Jordan T\.|Ohio State/);
    expect(page).not.toMatch(/const REVIEWS/);
  });

  it('the invented metrics are gone', () => {
    expect(page).not.toMatch(/median weekly earnings|average job rating|12 campuses|240 open gigs/);
    expect(page).not.toMatch(/\d+ open · \$|urgent right now/);
  });

  it('the fee shown matches the live rate, not the founding fallback', () => {
    // platform_rates has been 700 bps since 2026-08-12; 1000 is the FALLBACK and
    // quoting it on the marketing page overstates what we take by 43%.
    expect(page).toMatch(/value: "7%"/);
  });

  it('the waitlist is the page’s primary call to action', () => {
    expect(page).toMatch(/id="waitlist"/);
    expect(page).toMatch(/\{ label: "Join the waitlist", href: "#waitlist" \}/);
    expect(page).toMatch(/<WaitlistForm \/>/);
    // Every signup CTA re-pointed. "Log in" stays for existing testers.
    expect(page).not.toMatch(/login\?mode=signup/);
  });

  it('the page is still a server component', () => {
    // It says so itself, and the mobile nav is a <details> to keep it that way. The
    // form is the island; converting the page would ship 890 lines and PhoneMock.
    expect(page.split('\n')[0]).not.toMatch(/use client/);
    expect(form.split('\n')[0]).toMatch(/use client/);
  });

  it('the three landing tokens have exactly one definition', () => {
    const tokens = read('web/lib/landingTokens.ts');
    expect(tokens).toMatch(/export const display =/);
    expect(tokens).toMatch(/export const overline =/);
    expect(tokens).toMatch(/export const gutter =/);
    expect(page).toMatch(/import \{ display, overline, gutter \} from "@\/lib\/landingTokens"/);
    expect(page).not.toMatch(/^const (display|overline|gutter) =/m);
  });
});

describe('the unsubscribe page asks before it acts', () => {
  it('the destructive call is behind a button, not a page load', () => {
    expect(unsubBtn).toMatch(/onClick=\{unsubscribe\}/);
    expect(unsubBtn).toMatch(/op: "unsubscribe"/);
  });

  it('a token that no longer resolves is a SUCCESS, not an error', () => {
    // They came here to be off the list. If the row is gone they are off the list.
    expect(unsubBtn).toMatch(/res\.status === 404[\s\S]{0,120}setState\("gone"\)/);
    expect(unsubBtn).toMatch(/state === "done" \|\| state === "gone"/);
  });
});
