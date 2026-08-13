# OPEN WORK — the register that outlives a session

> **This file exists because work kept getting lost.** A payments audit produced ~72
> findings that lived only inside a Claude session transcript. A preflight audit produced
> 36 more that lived in a file under `/tmp`. Both were invisible to the next session, so
> "we fixed x and y" quietly became "z never got done".
>
> **If you are a Claude session working in this repo: this is your backlog.** Work the
> highest severity open item, verify it against live `pg_proc`/production BEFORE believing
> the description, fix it with a migration that asserts its own effect, prove the fix
> discriminates (broken vs fixed on the same staged row, rolled back), run the gate, and
> move the row to Closed with the commit that did it. Do not wait to be asked.
>
> `__tests__/openWork.test.js` fails if this file drifts out of the format below, so it
> cannot rot into prose.

_Last reconciled: 2026-08-13._

## Open (21)

| Sev | Area | Finding | Fix |
|---|---|---|---|
| medium | assistant-gate | The web app cannot confirm a staged action at all — Hustlr AI can no longer post or book on gohustlr.com | Port the mobile confirm flow to web: add `confirm_action_id` to web/lib/assistant.ts, capture the confirm_action in runActions, render a confirmation card, and post the id back. Until that ships, the alternativ |
| medium | assistant-gate | The per-turn caps on bookings and gigs are dead code after the gate, so one request can stage unbounded actions and the client renders only the first  | Count staged actions, not executed ones — cap on `actions.filter(a => a.type === 'confirm_action')` (and/or a per-user count of unconsumed rows in assistant_pending_actions) inside createGig/bookGig. On the cli |
| medium | assistant-gate | `remember` writes unmoderated model-authored text into every future system prompt, with no gate and no way for the user to see or delete it | Run the same two moderation layers on `fact` that create_gig/update_profile run, and surface memory to the user — a list in Settings with per-item delete, plus a line in the reply naming what was stored. Consid |
| medium | money-paths | A partial refund overstates the earner's loss by the platform-fee share, so Transactions disagrees with the earnings dashboard | Mirror record_refund: earnerRefundShare = round(refunded_cents * earner_amount_cents / (earner_amount_cents + fee_cents)), and use net = earner_amount_cents − earnerRefundShare. Show the fee portion of the refu |
| medium | money-paths | The payout upsert has no ordering guard, so a redelivered or out-of-order payout event reverts 'paid' to 'pending' | Store the event's `created` timestamp on the row and make the upsert conditional — skip the write when the incoming event is older than the stored one — or gate status transitions so a terminal state (paid/fail |
| medium | money-paths | Load failures render as authoritative empty states — the exact failure mode the screen's own comments forbid | Check `asEarner.error` / `asPoster.error` in fetchLedger and throw so the existing error card fires. Give payouts a third state (null = loading, [] = confirmed empty, 'error') instead of collapsing a failure in |
| medium | support-abuse | last_message_at is unpinned on INSERT — a self-created ticket can be made permanently invisible to the SLA control and can evict every real ticket fro | Pin `new.last_message_at := now()` (and `new.created_at := now()`, also unpinned) in guard_support_ticket_write's INSERT branch for non-service_role callers, matching how the UPDATE branch already pins them. Se |
| medium | support-abuse | A photo-only support reply can never be sent — support.js writes body: null into a NOT NULL column | Send an empty string instead of null (`body: text`) — the column is NOT NULL, not NOT-EMPTY — or make body nullable in a migration and keep the null. Both the admin console renderer (`{m.body ? <p …>` at [id]/p |
| medium | support-abuse | Photos attached to a FIRST support message are uploaded and then silently discarded | Thread images through: add `images` to submitSupportRequest and to support-submit's request body, and include it on the `support_ticket_messages` insert there. Failing that, have the app create the ticket via s |
| medium | support-abuse | Attachments an agent sends are unreadable by the user they were sent to — the object path can never satisfy the storage read policy | Add a ticket-scoped read policy alongside the owner one: allow SELECT on support-photos when the path's first segment is `ticket-<id>` and that ticket's user_id = auth.uid() — e.g. `(storage.foldername(name))[1 |
| low | mfa-lockout | Generating recovery codes destroys the previous set before the new one is delivered — a dropped response silently leaves the user with no valid codes  | Make delivery, not generation, the point of no return. Insert the new set alongside the old one marked inactive, return the plaintext, and have the client call a second tiny RPC ('I received and saved these') t |
| low | mfa-lockout | Enrollment can finish with 2FA switched ON, zero recovery codes, and a screen still reading 'Off' | Reload status in a `finally`, not only on the success path, so the card cannot claim 'Off' once the factor is verified. When code generation fails after a successful verify, say what is actually true — 'Two-fac |
| low | mfa-lockout | The recovery-code rate limiter is self-extending, so a user who mistypes can hold themselves out of their own account indefinitely | Check the limit before recording the attempt, or exclude attempts made while already over the threshold, so the window drains on a fixed schedule instead of ratcheting. Separately, this is the one place where t |
| low | assistant-gate | purge_assistant_pending_actions is never scheduled, so staged action payloads are retained indefinitely | Either schedule it (a cron.schedule entry, or a call at the top of controls_sweep_and_page next to vest_bonuses) or drop the function so the migration does not imply a retention policy that does not exist. |
| low | money-paths | A failed stripe_accounts lookup is silently treated as 'no such account' and nulls the payout's owner, hiding the deposit permanently | Destructure and check the error: on a lookup failure, throw so Stripe retries the event rather than persisting a wrong attribution, and never include user_id in the upsert payload when the lookup did not succee |
| low | money-paths | A poster discount is deducted a second time on a receipt whose total is already net of it | Show the pre-discount figure as 'Gig total' (amount_cents + poster_discount_cents) so the discount line has something to subtract from, leaving amount_cents as the total charged. Same correction in the stat gri |
| low | support-abuse | A user can staple a stranger's booking to their own support ticket, defeating the verification support-submit performs | In guard_support_ticket_write's INSERT branch, for non-service_role callers either force `new.booking_id := null; new.job_id := null` (the app's real path sets them through support-submit, which is service_role |
| low | support-abuse | The 'cold contact does not email' rule is bypassed by the second call: an agent-opened thread reused before the user has ever replied does send brande | Make the email gate the fact the comment describes rather than thread novelty: fetch `last_author` on the reuse row and set `coldContact = !reuse \|\| reuse.last_author !== 'user'` — i.e. only email once the us |
| low | support-abuse | support_tickets.ip is not pinned on UPDATE, so the ticket's author can rewrite the only forensic IP record on it | Add `new.ip := old.ip;` to the UPDATE branch of guard_support_ticket_write (alongside the existing pins), and clamp user_read_at to `least(new.user_read_at, now())` so a device clock — or a deliberate future va |
| low | regressions | Redeeming a recovery code leaves the local session's factor list stale, so a relaunch inside the hour re-prompts and burns a second code | After a successful redemption, call supabase.auth.refreshSession() before clearing the gate so the stored user object comes back without the factor; the fresh token also makes the access-token-keyed effect sett |
| low | regressions | The assistant's confirm turn is never written to the thread, so History shows a booking that reads as never made | Before returning from the confirm path, append the outcome to assistant_messages for body.thread_id (after the same ownership check the model path does at index.ts:443-452) — one assistant row with the reply is |

## Closed (15)

| Sev | Area | Finding | Closed by |
|---|---|---|---|
| critical | mfa-lockout | Any AAL1 session can mint its own recovery codes and redeem one — deleting every MFA factor on the account. Password alone defeats 2FA, the payout ste | 2026-08-13 |
| high | mfa-lockout | The 2FA challenge screen lets you into the app with no code at all when the factor lookup fails — put the phone in airplane mode and press Continue | 2026-08-13 |
| high | stepup-bypass | An AAL1 (non-stepped-up) session can self-neutralize MFA: generate_mfa_recovery_codes and redeem_mfa_recovery_code are granted to `authenticated` with | 2026-08-13 |
| high | assistant-gate | The confirmation card shows no details | 2026-08-13 |
| critical | stepup-bypass | requireStepUp fails closed on EVERY call | 2026-08-13 |
| critical | regressions | Payout setup and "Manage payout details" now fail for EVERY user | 2026-08-13 |
| high | regressions | Turning on two-factor never shows the recovery codes | 2026-08-13 |
| medium | regressions | Every hourly token refresh unmounts and remounts the whole app | 2026-08-13 |
| medium | regressions | The assistant confirmation card carries no server-derived detail | 2026-08-13 |
| high | assistant-gate | executeCreateGig references an undeclared… | 2026-08-13 |
| medium | money-paths | Export CSV ignores every on-screen filter… | 2026-08-13 |
| high | money-paths | Tips are stored in dollars but the ledger reads them as cents — every tip shows as 1/100th of its value | Convert at the boundary: `const tip = Math.round((Number(b.tip_amount) \|\| 0) * 100)` in toEntry. Number() also hardens against PostgREST ever emitting numeric as a string, which today's `typeof v === 'number' |
| high | money-paths | A partial capture (dispute payout) bills the poster's receipt for the full authorized hold, not what Stripe actually charged | Derive the settled total the way the console does: for a captured row, capturedTotal = earner_amount_cents + fee_cents, and use that (minus refunded_cents) as the poster's charge and as the earner's 'Gig total' |
| high | regressions | Hustlr AI "Post it" throws a ReferenceError after the gig has already been inserted — the user sees a failure for a gig that is live | Derive requirements from the staged payload inside executeCreateGig, the same way title/category/pay are re-derived at lines 927-934 — the payload already carries them (staged at index.ts:910). Add `deno check  |
| high | support-abuse | Any authenticated user can shut down the entire support intake channel for an hour with 60 direct PostgREST inserts | Support intake should have one writer. Revoke INSERT on public.support_tickets from `authenticated` and drop support_tickets_open_own so every new ticket goes through support-submit, which already rate-limits,  |

## Other registers that feed this one

- **Payments/incentives audit (2026-08-12)** — ~72 findings in 6 root causes, produced by a
  read-only session and never written to disk. Three of the worst are now closed
  (`ctl_escrow_hold_expiring_work_done` blind for a week; poster-discount campaigns
  refunding themselves at capture; fee overrides delivering 2.7× their cap). The rest are
  recoverable from that session's transcript by searching other sessions for
  `LIVE / DORMANT`. **Anything confirmed there belongs in the table above, not in a
  transcript.**
- `KNOWN_RISKS.md` — accepted risks and beta-readiness. Different purpose: that file is
  what we have DECIDED to live with; this one is what has not been done yet.
