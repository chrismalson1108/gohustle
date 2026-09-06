import { timingSafeEqual } from "node:crypto";
import { getServiceClient } from "@/lib/serviceClient";

// ─────────────────────────────────────────────────────────────────────────────
// The dead-man's switch for pg_cron.
//
// Every alert this platform sends leaves the database from inside a pg_cron job:
// controls_sweep_and_page posts the hourly page, controls_digest posts the daily
// digest, and both net.http_post calls sit after the work they report on. Stop the
// scheduler and nothing happens — no control runs, no finding is written, no email is
// sent, and the only signal is an amber banner on /controls that somebody has to open.
//
// A control cannot catch that, because a control is run BY the thing that stopped. So
// the outward half lives here, outside Postgres, and the database watches this end
// through ctl_heartbeat_absent (20260906050000). Neither half can certify itself.
//
// TWO RULES, both of which are the entire point:
//
//   1. This does NOT dispatch through controls-alert, and it is NOT gated on
//      app_flags.controls_alert. A watcher that shares a transport with the thing it
//      watches watches nothing — and controls_alert is mutable from the console, which
//      would make silencing the pager also silence the check on the pager.
//
//   2. It never depends on the database to decide whether to speak. If the RPC fails —
//      wrong key, unreachable project, function missing — that IS the alert. "I could
//      not ask" and "the answer was bad" both page; only a clean ok is silent.
//
// Auth is the Vercel cron shared secret (CRON_SECRET), which Vercel sends as
// `Authorization: Bearer <secret>` on scheduled invocations. Fail closed when it is
// unset: an unauthenticated endpoint that reports control health is a reconnaissance
// gift, and a 503 is visible in the cron log where a silent 200 would not be.
//
// NOTE: routes under /api are excluded from proxy.ts's matcher. They carry no session
// cookie, and the proxy's signed-out redirect would answer this cron with a 307 to
// /login — a 200-looking success from Vercel's side and total silence from ours, which
// is the exact failure this file exists to prevent.
// ─────────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FROM = "GoHustlr Controls <support@gohustlr.com>";
const DEFAULT_TO = "mainmail@gohustlr.com";
const ADMIN_URL = "https://admin.gohustlr.com";

type Heartbeat = {
  verdict?: string;
  reasons?: string[];
  sweep_last_run_at?: string | null;
  sweep_age_minutes?: number | null;
  sweep_stale_after_minutes?: number;
  scheduler?: unknown;
  scheduler_broken?: string[];
  controls_erroring?: number;
  open_critical?: number;
  open_high?: number;
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

// Constant-time, and length-safe: timingSafeEqual throws on a length mismatch, which
// would otherwise leak the secret's length through a 500 instead of a 403.
function secretMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const esc = (s: string) =>
  s.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]!);

async function page(subject: string, lines: string[]): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  const to = process.env.CONTROLS_EMAIL || DEFAULT_TO;
  if (!key) {
    // Reported, never thrown: a missing transport must not turn a detected outage into
    // a 500 that reads as "the heartbeat is broken" rather than "the controls are".
    console.error(`[controls-heartbeat] RESEND_API_KEY unset — cannot email ${to}: ${subject}`);
    return false;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: FROM,
      to: [to],
      subject,
      html: `<div style="font-family:Inter,Arial,sans-serif;font-size:14px;color:#363636;max-width:720px;">
        <p style="font-size:16px;"><strong>The controls scheduler is not healthy.</strong></p>
        <p>This email came from the external heartbeat, not from the database. It is sent
        precisely because the database's own alerting may be unable to speak.</p>
        <ul>${lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>
        <p style="color:#6B6482;">If the sweep has stopped, no control has run since the
        time above: no escrow-expiry warning, no reconciliation, no digest. Check pg_cron
        first — <code>select jobname, active, schedule from cron.job</code> — then
        <code>select public.run_all_controls()</code> to catch up.</p>
        <p style="margin-top:18px;"><a href="${ADMIN_URL}/controls" style="color:#5038FF;">Open the controls queue &rarr;</a></p>
      </div>`,
    }),
  });
  if (!res.ok) {
    console.error("[controls-heartbeat] resend error:", res.status, await res.text().catch(() => ""));
    return false;
  }
  return true;
}

export async function GET(req: Request): Promise<Response> {
  const expected = process.env.CRON_SECRET;
  if (!expected) return json({ error: "not_configured" }, 503);

  const presented = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!presented || !secretMatches(presented, expected)) {
    return json({ error: "forbidden" }, 403);
  }

  let hb: Heartbeat | null = null;
  let rpcError: string | null = null;
  try {
    const { data, error } = await getServiceClient().rpc("controls_heartbeat");
    if (error) rpcError = error.message;
    else hb = data as Heartbeat;
  } catch (e) {
    rpcError = e instanceof Error ? e.message : "unreachable";
  }

  // Could not ask ⇒ page. Silence here would mean the heartbeat goes quiet in exactly
  // the situation where the database is least able to speak for itself.
  if (!hb) {
    const emailed = await page("GoHustlr: the controls heartbeat cannot reach the database", [
      `The heartbeat RPC failed: ${rpcError ?? "no data returned"}.`,
      "Nothing can be said about whether the control sweep is running.",
    ]);
    return json({ ok: false, verdict: "blind", error: rpcError, emailed }, 502);
  }

  if (hb.verdict === "ok") {
    return json({ ok: true, verdict: "ok", emailed: false, sweep_age_minutes: hb.sweep_age_minutes });
  }

  const reasons = hb.reasons ?? [];
  const lines: string[] = [];
  if (reasons.includes("sweep_stale")) {
    lines.push(
      hb.sweep_last_run_at
        ? `No control has run for ${hb.sweep_age_minutes} minutes (threshold ${hb.sweep_stale_after_minutes}). Last sweep: ${hb.sweep_last_run_at}.`
        : "No control has ever recorded a run.",
    );
  }
  if (reasons.includes("scheduler")) {
    lines.push(
      `pg_cron is not holding the controls jobs: ${(hb.scheduler_broken ?? []).join(", ") || "unknown"}. ` +
        "20260806030000 is the definition of both schedules.",
    );
  }
  if (reasons.includes("controls_erroring")) {
    lines.push(`${hb.controls_erroring} control(s) are erroring — detection is degraded.`);
  }
  lines.push(`${hb.open_critical ?? 0} critical and ${hb.open_high ?? 0} high findings are open.`);

  const emailed = await page(
    `⚠️ GoHustlr controls scheduler: ${reasons.join(", ")}`,
    lines,
  );
  return json({ ok: false, verdict: hb.verdict, reasons, emailed });
}
