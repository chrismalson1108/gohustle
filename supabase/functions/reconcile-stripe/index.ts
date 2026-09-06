// Reconcile the payments ledger against Stripe — the control that does not depend on
// predicting the bug.
//
// Every other control compares the database to ITSELF: statuses that contradict each
// other, sums that do not add up, rows that should not exist. All of them share one
// blind spot — if the database is internally consistent but WRONG about what Stripe
// actually did, they all pass. A double-processed webhook, a capture that succeeded at
// Stripe and failed to write here, a refund issued from the dashboard, an application
// fee that did not match: every one of those leaves a tidy, self-consistent, incorrect
// ledger.
//
// This asks Stripe. Your database is not the authority on money; the processor is.
//
// It is an edge function rather than a control function because SQL cannot make an HTTP
// call to Stripe. The hourly sweep invokes it through pg_net, it writes findings into
// the same control_findings table as everything else, and it registers itself under the
// control key `stripe_reconciliation` so the /controls page and the digest treat it
// identically to a SQL control — including auto-resolve when a discrepancy clears.
//
// SCOPE, and it is three passes rather than one because a reversal does not happen on
// our clock:
//   1. payments WE touched in the last N days (default 14) — greatest of created /
//      authorized / captured / refunded / cancelled, via payments_touched_since. This
//      line used to say "touched" while the query filtered created_at, and on this table
//      created_at is the FIRST hold ever placed, so a gig refunded three weeks after it
//      was accepted was never examined.
//   2. payments named by a Stripe REFUND or DISPUTE created in the same window, pulled
//      in by id however old the row is. A refund clicked in the Dashboard changes none
//      of our columns, so no filter over our own timestamps could ever find it.
//   3. payments that already carry an OPEN finding, so one can actually clear.
// A full historical sweep would be a different job with different pagination; the
// failures that matter are recent, because that is when they are still fixable.
//
// Secrets: STRIPE_SECRET_KEY, plus the shared secret in app_flags.controls_alert.
import Stripe from "npm:stripe@22";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-controls-secret",
};

const CONTROL_KEY = "stripe_reconciliation";
const TOLERANCE_CENTS = 0; // money reconciles exactly or it does not reconcile

// How many Stripe reversal objects the side-scan will walk before giving up. A bound,
// not a budget: if a sweep ever hits it the run is under-scanned and says so.
const STRIPE_SCAN_CAP = 500;

// The shape payments_touched_since returns, and the same columns a direct select must
// ask for so the two sources are interchangeable in the loop below.
const PAYMENT_COLUMNS =
  "id, booking_id, payment_intent_id, amount_cents, fee_cents, earner_amount_cents, refunded_cents, status, captured_at, created_at";

interface PaymentRow {
  id: string;
  booking_id: string | null;
  payment_intent_id: string | null;
  amount_cents: number | null;
  fee_cents: number | null;
  earner_amount_cents: number | null;
  refunded_cents: number | null;
  status: string | null;
  captured_at: string | null;
  created_at: string | null;
  touched_at?: string | null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Same auth as controls-alert: the shared secret from app_flags, so it rotates
    // without a redeploy. Fail closed — this reads every payment we have.
    const { data: cfgRow } = await supabase
      .from("app_flags").select("value").eq("key", "controls_alert").maybeSingle();
    const expected = (cfgRow?.value as Record<string, string> | null)?.secret;
    if (!expected) return json({ error: "not_configured" }, 503);
    if (req.headers.get("x-controls-secret") !== expected) return json({ error: "forbidden" }, 403);

    // Anything this run could not measure or could not record. It ends up on the
    // registry row as last_error, because a reconciliation that quietly did less than
    // it says it did is the same failure as one that stopped running.
    const warnings: string[] = [];

    const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!stripeKey) {
      // No key = we cannot reconcile. That is itself a finding: silently returning
      // "all clear" would be the worst possible answer.
      await writeFinding(supabase, "config", {
        kind: "no_stripe_key",
        detail: "STRIPE_SECRET_KEY is unset — reconciliation cannot run at all.",
      }, warnings);
      return json({ ok: false, reason: "no_stripe_key" }, 503);
    }
    const stripe = new Stripe(stripeKey, { apiVersion: '2026-07-29.dahlia' });

    // Assert the WIRING before reconciling the data. Every stripe-webhook handler
    // depends on a subscription nothing asserts, and on 2026-08-13 two were wrong:
    // the Connect endpoint carried account.updated only (so the payout handler had
    // been live and receiving nothing), and live mode had no endpoint at all. Neither
    // errors — nothing is delivered, so nothing fails. Non-fatal on purpose: a webhook
    // misconfiguration must not stop the money reconciliation that follows it.
    try {
      await checkWebhookConfig(supabase, stripe, stripeKey);
    } catch (e) {
      console.error("[reconcile-stripe] webhook config check failed:", e);
    }

    const body = await req.json().catch(() => ({}));
    const days = Number.isFinite(Number(body?.days)) ? Number(body.days) : 14;
    const limit = Math.min(500, Number(body?.limit) || 200);

    const since = new Date(Date.now() - days * 86400_000).toISOString();
    const sinceUnix = Math.floor(Date.parse(since) / 1000);

    // ── SCOPE, in three passes that catch three different things ─────────────
    //
    // 1. Payments WE touched recently. Not payments we CREATED recently, which is what
    //    the header has always promised and the query never did: created_at is the
    //    first hold ever placed (a recovery re-hold moves authorized_at and leaves it
    //    alone) and this table has no updated_at. A gig accepted on day 0 and refunded
    //    on day 20 was out of the window on the very sweep that should have caught it.
    //    payments_touched_since orders by greatest(created/authorized/captured/
    //    refunded/cancelled), so the cap keeps the row the filter just let in.
    const { data: touched, error: pErr } = await supabase.rpc("payments_touched_since", {
      p_since: since,
      p_limit: limit,
    });
    if (pErr) return json({ error: pErr.message }, 500);

    const payments: PaymentRow[] = (touched ?? []) as PaymentRow[];
    const byId = new Map<string, PaymentRow>(payments.map((p) => [p.id, p]));

    // 2. Reversals on STRIPE's clock. A refund clicked in the Dashboard changes none of
    //    our columns, so no filter over our own timestamps can ever see it — and that
    //    is the exact leak the registry text names. Ask Stripe what came back out since
    //    the window opened and pull those payments in by id, however old they are.
    //
    //    This matters most for the one failure where reconciliation is the ONLY
    //    backstop: an admin refund that succeeds at Stripe and then fails to ledger.
    //    stripe-webhook skips filing anything while the refund_source='admin' in-flight
    //    marker is fresh and answers 200, so Stripe never retries and
    //    ctl_external_reversal_not_ledgered has no disputes row to read.
    const reversalPis = new Set<string>();
    try {
      let n = 0;
      for await (const r of stripe.refunds.list({ created: { gte: sinceUnix }, limit: 100 })) {
        const id = typeof r.payment_intent === "string" ? r.payment_intent : r.payment_intent?.id;
        if (id) reversalPis.add(id);
        if (++n >= STRIPE_SCAN_CAP) break;
      }
      n = 0;
      for await (const d of stripe.disputes.list({ created: { gte: sinceUnix }, limit: 100 })) {
        const id = typeof d.payment_intent === "string" ? d.payment_intent : d.payment_intent?.id;
        if (id) reversalPis.add(id);
        if (++n >= STRIPE_SCAN_CAP) break;
      }
    } catch (e) {
      warnings.push(
        `stripe reversal scan failed: ${String((e as Error)?.message ?? e).slice(0, 160)}`,
      );
    }
    const knownPis = new Set(
      payments.map((p) => p.payment_intent_id).filter((v): v is string => !!v),
    );
    await pullIn(
      supabase,
      payments,
      byId,
      "payment_intent_id",
      [...reversalPis].filter((pi) => !knownPis.has(pi)),
      warnings,
    );

    // 3. Payments already REPORTED broken. A finding may only resolve if this run
    //    examined its entity, so an open row on an aged-out payment could never clear
    //    even after a human fixed it.
    const { data: openRows, error: oErr } = await supabase
      .from("control_findings")
      .select("entity_id")
      .eq("control_key", CONTROL_KEY)
      .is("resolved_at", null)
      .limit(500);
    if (oErr) {
      warnings.push(`could not read open findings: ${oErr.message.slice(0, 160)}`);
    } else {
      await pullIn(
        supabase,
        payments,
        byId,
        "id",
        (openRows ?? [])
          .map((r) => String((r as { entity_id: string }).entity_id))
          // "config" is this function's own non-payment entity; it is not a uuid and
          // an `in` filter carrying it fails the whole query.
          .filter((e) => e && e !== "config" && !byId.has(e)),
        warnings,
      );
    }

    const seen: string[] = [];
    // Every payment this run actually LOOKED AT. Auto-resolution is scoped to these:
    // a finding on a payment outside the scan window was never re-checked, so closing
    // it would assert a reconciliation that never happened.
    const examined: string[] = [];
    let checked = 0;

    for (const p of payments) {
      if (!p.payment_intent_id) continue;
      checked++;
      examined.push(p.id);
      let pi: Stripe.PaymentIntent;
      try {
        pi = await stripe.paymentIntents.retrieve(p.payment_intent_id, {
          expand: ["latest_charge"],
        });
      } catch (e) {
        // A PaymentIntent our ledger references that Stripe does not have is a
        // serious discrepancy, not a transient error worth swallowing.
        seen.push(await writeFinding(supabase, p.id, {
          kind: "payment_intent_missing_at_stripe",
          booking_id: p.booking_id,
          payment_intent_id: p.payment_intent_id,
          error: String((e as Error)?.message ?? e).slice(0, 200),
        }, warnings));
        continue;
      }

      const charge = (pi.latest_charge ?? null) as Stripe.Charge | null;
      const receivedCents = pi.amount_received ?? 0;
      const refundedAtStripe = charge?.amount_refunded ?? 0;
      const ourCaptured = (p.earner_amount_cents ?? 0) + (p.fee_cents ?? 0);
      const ourRefunded = p.refunded_cents ?? 0;

      const problems: Record<string, unknown>[] = [];

      // 1. Captured total must equal what Stripe actually received.
      if (p.status === "captured" && Math.abs(receivedCents - ourCaptured) > TOLERANCE_CENTS) {
        problems.push({
          kind: "captured_total_mismatch",
          ours: ourCaptured, stripe: receivedCents, diff: receivedCents - ourCaptured,
        });
      }

      // 2. We think it is captured; Stripe does not agree it succeeded.
      if (p.status === "captured" && pi.status !== "succeeded") {
        problems.push({ kind: "captured_but_stripe_not_succeeded", stripe_status: pi.status });
      }

      // 3. Stripe took the money and our ledger still says it is only held. This is
      //    the shape that leaves an earner unpaid on completed work.
      if (p.status === "authorized" && receivedCents > 0) {
        problems.push({
          kind: "stripe_captured_but_ledger_says_authorized",
          stripe_received: receivedCents, stripe_status: pi.status,
        });
      }

      // 4. Refund drift, but ONLY on money that was actually captured.
      //
      //    Releasing an uncaptured authorization is NOT a refund — there is nothing to
      //    refund — yet Stripe still reports the released amount as amount_refunded on
      //    the charge. Comparing that against our (correct) refunded_cents = 0 fired on
      //    every cancelled hold and could never be resolved by fixing anything, which
      //    is the permanent-false-positive shape that teaches people to ignore the
      //    queue. Gate on captured_at, which is null precisely when nothing was taken.
      //    THE SAME TRAP AGAIN, ONE LEVEL DOWN: a PARTIAL capture.
      //
      //    Capturing less than the authorized amount makes Stripe release the remainder,
      //    and it reports that release in charge.amount_refunded exactly as it does for
      //    a real refund. Our refunded_cents is correctly 0 — we did not refund
      //    anything, we captured less — so the naive comparison fired on every partial
      //    capture and could never be cleared. Partial capture is not an edge case here:
      //    it is the whole "report a problem" flow in CompletionModal, so this would
      //    have produced a permanent false finding for every disputed gig.
      //
      //    ── AND THEN STRIPE CHANGED IT UNDER US (2026-08-13) ─────────────────
      //
      //    Everything above describes pre-Basil behaviour. Stripe's 2025-03-31.basil
      //    release removed the Refund from the partial-capture and cancellation flows:
      //    "amount_refunded will no longer be updated by these actions", and
      //    charge.refunded is no longer sent for them. We only met that change on
      //    2026-08-13 when the SDK moved 2024-04-10 → 2026-07-29.dahlia; the old pin had
      //    been preserving the old behaviour, which is exactly what API versions are for.
      //
      //    So the compensation below is now WRONG, and wrong in the dangerous direction.
      //    autoReleased is still > 0 on every partial capture, but refundedAtStripe no
      //    longer contains it, so subtracting over-subtracts:
      //
      //      false fire — a genuine refund R after a partial capture reports R − released
      //      false PASS — an unledgered external refund R ≤ released collapses to 0,
      //                   compares equal to our 0, and produces NO FINDING
      //
      //    The second one silently blinds the reconciler to the precise leak it exists
      //    to catch: a refund issued from the Stripe Dashboard that never reached our
      //    ledger. A money control that has quietly stopped looking is worse than no
      //    control, because the board still shows green.
      //
      //    Under the version we now pin, amount_refunded means genuine refunds and
      //    nothing else, so no compensation is correct. That is a DEPENDENCY ON THE PIN,
      //    which is why __tests__/stripeApiVersion.test.js fails if anyone moves it.
      //
      //    Safe to switch outright rather than straddle both behaviours: production has
      //    zero partial captures (verified), so there is no historical charge carrying
      //    a pre-Basil amount_refunded to misread.
      //    ── AND ONE MORE REVERSAL SHAPE THAT IS NOT A REFUND (2026-09-06) ────
      //
      //    A LOST CHARGEBACK takes the money back and moves NO refund figure at Stripe:
      //    a Dispute is not a Refund object, so charge.amount_refunded stays 0. Stripe
      //    will not even let refunds.create touch a disputed charge (charge_disputed),
      //    which is why the only way to ledger one is admin-payment-action's
      //    `record_reversal` op — a ledger-only write that makes no Stripe call and is
      //    exactly what RUNBOOK_MONEY §2 tells the operator to press.
      //
      //    So comparing refunded_cents against amount_refunded alone punished the
      //    correct behaviour: every properly-recorded chargeback reported here as a
      //    critical `refund_mismatch` (ours X, stripe 0) that no action could clear —
      //    hand-resolving it re-opened it on the next sweep, because the open-rows
      //    unique index only collapses duplicates while a row is OPEN. That is the same
      //    permanent-false-positive shape as the cancelled-hold and partial-capture
      //    traps above, and this file has now been bitten by it three times.
      //
      //    It cut the other way too, which is the worse half: a lost chargeback that
      //    NOBODY recorded compared 0 against 0 and produced no finding at all. The
      //    money left the platform balance and this control said nothing.
      //
      //    payments.refund_source is NOT the signal to read here. It is a short-lived
      //    in-flight marker: record_refund clears it (and refund_source_at) on every
      //    exit path, so by the time a chargeback is ledgered the column is null again.
      //    Ask Stripe instead — the whole premise of this function is that the
      //    processor, not our table, is the authority on what money moved.
      const authorizedCents = pi.amount ?? 0;
      const autoReleased = Math.max(0, authorizedCents - receivedCents);

      let disputeLostCents = 0;
      let disputesUnreadable: string | null = null;
      const disputeDetail: Record<string, unknown>[] = [];
      if (charge?.disputed) {
        try {
          const dl = await stripe.disputes.list({ charge: charge.id, limit: 10 });
          for (const d of dl.data) {
            disputeDetail.push({ id: d.id, status: d.status, amount: d.amount ?? 0 });
            // Only a LOST dispute is money that is gone for good, and it is the only
            // outcome the runbook tells an operator to record. An open one has been
            // withdrawn pending the outcome and our ledger is correctly still 0, so
            // counting it would fire on every live dispute — noise, not signal.
            if (d.status === "lost") disputeLostCents += d.amount ?? 0;
          }
        } catch (e) {
          disputesUnreadable = String((e as Error)?.message ?? e).slice(0, 200);
        }
      }

      // What Stripe says came back out, by BOTH mechanisms it has.
      const reversedAtStripe = refundedAtStripe + disputeLostCents;

      const wasCaptured = Boolean(p.captured_at) || receivedCents > 0;
      if (wasCaptured && disputesUnreadable) {
        // Say "I could not measure" rather than quoting a number built on half the
        // picture. A comparison that silently omits the dispute leg is exactly the
        // false finding this block exists to stop.
        problems.push({
          kind: "dispute_unreadable",
          ours: ourRefunded,
          stripe_raw_refunded: refundedAtStripe,
          error: disputesUnreadable,
          note:
            "the charge is disputed but disputes.list failed, so the reversal total " +
            "cannot be computed — refund_mismatch is skipped rather than guessed.",
        });
      } else if (wasCaptured && Math.abs(reversedAtStripe - ourRefunded) > TOLERANCE_CENTS) {
        problems.push({
          kind: "refund_mismatch",
          ours: ourRefunded,
          stripe: reversedAtStripe,
          stripe_raw_refunded: refundedAtStripe,
          stripe_disputed_lost: disputeLostCents,
          disputes: disputeDetail,
          auto_released: autoReleased,
          diff: reversedAtStripe - ourRefunded,
        });
      }

      // 4b. The genuine version of the case above: money actually taken on a booking
      //     whose payment we consider dead. That IS a problem, and a serious one.
      if ((p.status === "cancelled" || p.status === "failed") && receivedCents > 0) {
        problems.push({
          kind: "money_captured_on_dead_payment",
          stripe_received: receivedCents, our_status: p.status,
        });
      }

      // 5. The hold lapsed at Stripe while we still believe it is live.
      if (p.status === "authorized" && (pi.status === "canceled" || pi.status === "requires_payment_method")) {
        problems.push({ kind: "hold_dead_at_stripe", stripe_status: pi.status });
      }

      if (problems.length) {
        seen.push(await writeFinding(supabase, p.id, {
          booking_id: p.booking_id,
          payment_intent_id: p.payment_intent_id,
          our_status: p.status,
          stripe_status: pi.status,
          problems,
        }, warnings));
      }
    }

    // Auto-resolve anything that reconciles now. Same contract as run_control: a
    // finding the check stops producing is closed, so the queue stays honest.
    // Done in SQL because the "not in (…)" form over PostgREST is fragile with an
    // empty set, and an empty set is the healthy case.
    // Pass BOTH: what is still broken, and what was examined at all. Without the
    // second list the RPC resolved every open finding not in `seen` — including ones
    // for payments that fell outside the 14-day / 200-row window and were therefore
    // never checked. Those were closed with the note "reconciles against Stripe",
    // which was simply untrue: a real money discrepancy could age out of the window
    // and be silently marked resolved.
    await supabase.rpc("resolve_reconciliation_findings", {
      p_still_open: seen,
      p_examined: examined,
    });

    await supabase.from("controls").update({
      last_run_at: new Date().toISOString(),
      last_violations: seen.length,
      // A run that could not read part of its own scope is ERRORING, not clean. The
      // board showing green off a partial scan is the failure this whole function
      // exists to prevent, one level up.
      last_error: warnings.length ? warnings.join(" | ").slice(0, 300) : null,
    }).eq("key", CONTROL_KEY);

    return json({
      ok: true,
      checked,
      discrepancies: seen.length,
      window_days: days,
      stripe_side_reversals: reversalPis.size,
      warnings,
    });
  } catch (err) {
    console.error("reconcile-stripe:", err);
    try {
      const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      );
      // Record the failure on the registry row so /controls shows reconciliation as
      // ERRORING rather than quietly stale — a reconciliation that silently stops is
      // indistinguishable from one that keeps passing.
      await supabase.from("controls").update({
        last_run_at: new Date().toISOString(),
        last_error: String((err as Error)?.message ?? err).slice(0, 300),
        last_violations: null,
      }).eq("key", CONTROL_KEY);
    } catch { /* the sink itself is down; the platform log has it */ }
    return json({ error: "Something went wrong." }, 500);
  }
});

// Add payments named by something OTHER than the time window — a Stripe-side reversal,
// or an already-open finding — into the set this run examines, without duplicating a row
// the window already produced. Batched in chunks because an `in` filter is a URL.
async function pullIn(
  supabase: SupabaseClient,
  into: PaymentRow[],
  byId: Map<string, PaymentRow>,
  column: "id" | "payment_intent_id",
  values: string[],
  warnings: string[],
): Promise<void> {
  for (let i = 0; i < values.length; i += 100) {
    const chunk = values.slice(i, i + 100);
    if (chunk.length === 0) continue;
    const { data, error } = await supabase
      .from("payments").select(PAYMENT_COLUMNS).in(column, chunk);
    if (error) {
      // Not fatal — the window pass still ran — but it must not be silent, or this run
      // reports fewer discrepancies than exist and calls that a clean bill of health.
      warnings.push(`could not load payments by ${column}: ${error.message.slice(0, 160)}`);
      return;
    }
    for (const row of (data ?? []) as PaymentRow[]) {
      if (byId.has(row.id)) continue;
      byId.set(row.id, row);
      into.push(row);
    }
  }
}

// Goes through an RPC rather than a PostgREST upsert: the findings uniqueness index is
// PARTIAL (`where resolved_at is null`), which cannot be named as an ON CONFLICT target
// over PostgREST. The RPC performs the same upsert-then-refresh contract run_control
// uses, so an externally-checked control behaves exactly like a SQL one.
//
// It ALWAYS returns the entity, even when the write failed, and that is the whole
// point. It used to return null on an RPC error — and the caller then left the entity
// out of `seen` while it stayed in `examined`, which is exactly the predicate
// resolve_reconciliation_findings uses to CLOSE an open finding with the note
// "auto-resolved: reconciles against Stripe". So one transient statement timeout turned
// a real, already-detected money discrepancy into a resolved one, and the queue then
// claimed a reconciliation that had never happened.
//
// A failed write is not evidence of health. The entity is still broken, so it stays in
// the still-open list, and the failure goes on the registry row where a human sees the
// control as ERRORING rather than clean.
async function writeFinding(
  supabase: SupabaseClient,
  entityId: string,
  detail: Record<string, unknown>,
  warnings: string[],
): Promise<string> {
  const { error } = await supabase.rpc("record_reconciliation_finding", {
    p_entity: entityId,
    p_detail: detail,
    p_severity: "critical",
  });
  if (error) {
    console.error("[reconcile-stripe] could not write finding:", error.message);
    warnings.push(`could not write finding for ${entityId}: ${error.message.slice(0, 120)}`);
  }
  return entityId;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Does Stripe's configuration allow it to deliver what stripe-webhook handles?
//
// Two destinations point at the same URL and are told apart only by signing secret:
//   ACCOUNT — payments, refunds, disputes, identity  (application === null)
//   CONNECT — connected-account events: account.updated and payout.*
//
// A `case` in the handler with no matching subscription is dead code that looks alive.
// That is exactly how the payout feature shipped, was correct, and received nothing.
//
// The two lists below MUST stay in step with the handler's switch. They are not
// documentation: __tests__/webhookEventCoverage.test.js parses stripe-webhook's real
// `case` labels and fails if either list drifts.
// ─────────────────────────────────────────────────────────────────────────────
const REQUIRED_ACCOUNT_EVENTS = [
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "payment_intent.canceled",
  "charge.refunded",
  "charge.dispute.created",
  "identity.verification_session.verified",
  "identity.verification_session.requires_input",
  "identity.verification_session.canceled",
];

const REQUIRED_CONNECT_EVENTS = [
  "account.updated",
  "payout.created",
  "payout.updated",
  "payout.paid",
  "payout.failed",
  "payout.canceled",
];

const CONTROL_WEBHOOK = "stripe_webhook_config";

async function checkWebhookConfig(
  supabase: SupabaseClient,
  stripe: Stripe,
  stripeKey: string,
): Promise<void> {
  // Every record_external_finding error lands here. Unlike the reconciliation half,
  // this one cannot auto-resolve a live finding by failing — the entity is pushed into
  // `open` BEFORE the write, so resolve_external_findings leaves it alone. What it CAN
  // do is report clean: resolve_external_findings ends by setting last_error = null, so
  // a misconfiguration whose finding could not be written leaves the board green with
  // no row to look at. These are re-stamped onto the registry row afterwards.
  const writeErrors: string[] = [];
  // The key decides which mode Stripe answers for, so this check always describes the
  // mode we are actually operating in — which is the whole point: live mode having no
  // endpoints is invisible from test mode.
  const mode = stripeKey.startsWith("sk_live_") ? "live" : "test";
  const open: string[] = [];

  const list = await stripe.webhookEndpoints.list({ limit: 100 });
  const ours = list.data.filter((w) => (w.url ?? "").includes("/functions/v1/stripe-webhook"));
  const enabled = ours.filter((w) => w.status === "enabled");

  if (enabled.length === 0) {
    open.push(`${mode}:no_endpoint`);
    const { error: wErr } = await supabase.rpc("record_external_finding", {
      p_control_key: CONTROL_WEBHOOK,
      p_entity: `${mode}:no_endpoint`,
      p_detail: {
        mode,
        endpoints_found: ours.length,
        note:
          `No ENABLED webhook endpoint for stripe-webhook in ${mode} mode. Every handler ` +
          `is dark: captures never mark paid, Connect onboarding never completes, ` +
          `identity never resolves, refunds never record. Nothing errors, because ` +
          `nothing is delivered.`,
      },
      p_severity: "critical",
    });
    if (wErr) writeErrors.push(`no_endpoint: ${wErr.message.slice(0, 100)}`);
  } else {
    for (const [kind, required] of [
      ["account", REQUIRED_ACCOUNT_EVENTS],
      ["connect", REQUIRED_CONNECT_EVENTS],
    ] as const) {
      const eps = enabled.filter((w) => (kind === "connect" ? !!w.application : !w.application));
      const entity = `${mode}:${kind}`;

      if (eps.length === 0) {
        open.push(`${entity}:missing`);
        const { error: wErr } = await supabase.rpc("record_external_finding", {
          p_control_key: CONTROL_WEBHOOK,
          p_entity: `${entity}:missing`,
          p_detail: {
            mode,
            destination: kind,
            note: kind === "connect"
              ? `No CONNECTED-ACCOUNT destination in ${mode} mode. payout.* never arrives, so ` +
                `stripe_payouts stays empty and Bank deposits shows nothing — which reads to ` +
                `an earner as "no deposits yet", not as "we are not listening".`
              : `No account destination in ${mode} mode. Payments, refunds and identity are dark.`,
          },
          p_severity: "critical",
        });
        if (wErr) writeErrors.push(`${entity}:missing: ${wErr.message.slice(0, 100)}`);
        continue;
      }

      // Union across endpoints of this kind: more than one is unusual but legal, and
      // between them they must cover the handler.
      const subscribed = new Set(eps.flatMap((w) => w.enabled_events ?? []));
      const missing = subscribed.has("*")
        ? []
        : required.filter((e) => !subscribed.has(e));

      if (missing.length > 0) {
        open.push(entity);
        const { error: wErr } = await supabase.rpc("record_external_finding", {
          p_control_key: CONTROL_WEBHOOK,
          p_entity: entity,
          p_detail: {
            mode,
            destination: kind,
            endpoint_ids: eps.map((w) => w.id),
            missing_events: missing,
            note:
              `stripe-webhook handles these events but ${kind} destination(s) in ${mode} ` +
              `mode are not subscribed to them. The handler runs, receives nothing, and ` +
              `reports no error.`,
          },
          p_severity: "high",
        });
        if (wErr) writeErrors.push(`${entity}: ${wErr.message.slice(0, 100)}`);
      }
    }
  }

  // Auto-resolve whatever is no longer reported, same contract as every other control.
  await supabase.rpc("resolve_external_findings", {
    p_control_key: CONTROL_WEBHOOK,
    p_still_open: open,
  });

  // AFTER the resolve, because that RPC ends by clearing last_error. A check whose
  // findings could not be recorded has not passed; it has failed to report.
  if (writeErrors.length) {
    await supabase.from("controls")
      .update({ last_error: writeErrors.join(" | ").slice(0, 300) })
      .eq("key", CONTROL_WEBHOOK);
  }
}
