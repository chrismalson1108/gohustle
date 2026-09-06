// What each `app_flags` row actually is, and what actually happens when you flip it.
//
// WHY THIS FILE EXISTS. `app_flags` started life as five feature kill switches
// (20260804010000) and the console was written for exactly that: one list, one toggle,
// one success sentence — `"<key> is OFF. Users hitting that feature now get a
// \"temporarily paused\" message."` Five more rows of two entirely different kinds were
// added later and inherited that UI wholesale:
//
//   • safety_alert / controls_alert (20260806020000) are ALERT DISPATCH CONFIG. Turning
//     safety_alert off changes nothing for users — it stops paging a human when a safety
//     report lands. Telling an operator mid-incident that users now see a "temporarily
//     paused" message is not a small inaccuracy; it is the opposite of what happened,
//     and it hides the July 10 outage class (a safety trigger sat dead for four weeks)
//     behind reassuring copy. The console also never mentioned that the mute expires by
//     itself after 24 hours (trg_alert_flag_disable_expires + reenable_expired_alert_flags).
//
//   • stripe_mode / storage_public_origin / controls_heartbeat are CONFIGURATION rows
//     whose payload is `value`, and whose `enabled` bit is read by nothing at all. The
//     console rendered a Turn-off button for each — a switch that controls nothing, which
//     is precisely what flags/actions.ts's own comment calls "worse than having no switch
//     at all" — while offering no way to edit the thing that IS read. 20260814080000 ends
//     by saying /flags can flip stripe_mode at cutover; until now it could not.
//
// So the kind is the first thing every surface here asks about a row. Anything the
// console says about a flag comes from this table; nothing is written as a fixed
// sentence about "features" any more.
//
// __tests__/flagsConsoleDescribesEveryKey.test.js reads the migrations and fails if a
// seeded key has no entry here, so the next flag cannot arrive undescribed.

export type FlagKind =
  /** `enabled` is read by product code; OFF takes a feature away from users. */
  | "kill_switch"
  /** `enabled` gates an alert dispatcher. OFF is invisible to users and self-expiring. */
  | "alert_channel"
  /** The payload is `value`. `enabled` is read by nothing — do not offer a toggle. */
  | "config";

export interface FlagGuide {
  kind: FlagKind;
  /** Where the row is actually read. Rendered as the "Where each flag is enforced" list. */
  enforcedAt: string;
  /** The true consequence of `enabled = false`. Used in the confirm dialog AND the result. */
  offMeans: string;
  /** The true consequence of `enabled = true`, when "normal behaviour restored" is wrong. */
  onMeans?: string;
  /**
   * The dangerous direction. Default "off" — taking a feature away is the destructive act
   * and turning it back on is a restoration. `bonus_cash_payout_enabled` inverts that:
   * OFF is its seeded, intended state and ON opens real transfers off the platform balance.
   */
  confirmDirection?: "off" | "on";
  /** Config rows: which key inside `value` carries the payload. */
  valueKey?: string;
  /** Config rows: how `value` is changed, when the console cannot change it. */
  valueEditedBy?: string;
  /** Seeded OFF on purpose, so "currently paused" is not an incident. */
  offByDefault?: true;
}

export const FLAG_GUIDE: Record<string, FlagGuide> = {
  // ── Feature kill switches (20260804010000) ────────────────────────────────
  signups_enabled: {
    kind: "kill_switch",
    enforcedAt: "handle_new_user trigger; refuses the auth insert outright.",
    offMeans: "No new account can be created. Everyone already signed up is unaffected.",
  },
  posting_enabled: {
    kind: "kill_switch",
    enforcedAt: "guard_posting_flag trigger on jobs.",
    offMeans: "No new gig can be posted. Existing gigs stay bookable.",
  },
  payments_enabled: {
    kind: "kill_switch",
    enforcedAt:
      "stripe-create-payment-intent. Blocks NEW escrow holds only; bookings already confirmed still capture, so nobody mid-gig is stranded.",
    offMeans:
      "No poster can accept a booking — no new escrow hold can be minted. Confirmed bookings still capture, so nobody mid-gig is stranded. This does NOT expire on a timer; you turn it back on.",
  },
  tips_enabled: {
    kind: "kill_switch",
    enforcedAt: "stripe-tip.",
    offMeans: "The tip endpoint refuses. Nothing else changes.",
  },
  assistant_enabled: {
    kind: "kill_switch",
    enforcedAt: "assistant. The rest of the app is unaffected.",
    offMeans:
      "Hustlr AI refuses every request. It can post gigs and book work on a user's behalf — the widest blast radius in the product — so this is the switch to reach for first.",
  },

  // ── Feature kill switches (20260806070000) ────────────────────────────────
  promotions_enabled: {
    kind: "kill_switch",
    enforcedAt: "redeem_promo_code and the benefit chain under pin_booking_amount.",
    offMeans:
      "No code redeems and no grant applies to a NEW booking. Bookings already pinned keep the benefit they were struck with — killing a campaign never re-prices agreed work.",
  },
  bonus_cash_payout_enabled: {
    kind: "kill_switch",
    confirmDirection: "on",
    offByDefault: true,
    enforcedAt: "The bonus payout path. Seeded OFF and intended to stay OFF.",
    offMeans:
      "The intended state. Referral bonuses accrue as fee CREDITS only, bounded by what the user would have paid us.",
    onMeans:
      "REAL TRANSFERS off the platform balance are now enabled. Cash is the classic referral-farming target, and this needs balance monitoring and transfer-failure handling before it is safe.",
  },

  // ── Alert channels (20260806020000, deadline added 20260814100000) ─────────
  safety_alert: {
    kind: "alert_channel",
    enforcedAt:
      "notify_safety_report(), the AFTER INSERT trigger on reports. value.url + value.secret; the secret is set out of band.",
    offMeans:
      "NOBODY IS PAGED when a safety report lands. Users see no difference at all — reports still save. The mute lapses on its own after 24 hours (reenable_expired_alert_flags, at the top of every sweep).",
    onMeans: "Safety reports page a human again.",
  },
  controls_alert: {
    kind: "alert_channel",
    enforcedAt:
      "controls_sweep_and_page() and controls_digest(). value.url + value.secret; the secret is set out of band.",
    offMeans:
      "The hourly sweep and the daily digest stop paging. Controls still run and still record findings — you just are not told. Users see no difference. The mute lapses on its own after 24 hours.",
    onMeans: "The sweep and the digest page again.",
  },

  // ── Configuration rows: the payload is `value` ─────────────────────────────
  stripe_mode: {
    kind: "config",
    valueKey: "mode",
    enforcedAt:
      "ctl_stripe_id_mode_mismatch reads value->>'mode'. `enabled` is read by nothing.",
    offMeans:
      "Nothing. `enabled` is not read for this row — the mode below is the only part that does anything.",
  },
  storage_public_origin: {
    kind: "config",
    valueKey: "origin",
    valueEditedBy:
      "a migration, at a project cutover — guard_profile_avatar_url and guard_job_photo_urls pin public image URLs to this exact origin, so it is not a console-speed change.",
    enforcedAt:
      "is_own_public_image, via guard_profile_avatar_url and guard_job_photo_urls. `enabled` is read by nothing.",
    offMeans: "Nothing. `enabled` is not read for this row.",
  },
  controls_heartbeat: {
    kind: "config",
    valueKey: "grace_until",
    valueEditedBy:
      "controls_heartbeat(), called by the external Vercel cron at admin/app/api/controls-heartbeat. It is a check-in record, not a setting.",
    enforcedAt:
      "ctl_heartbeat_absent, the EXTERNAL dead-man's switch for the sweep. `enabled` is read by nothing — the watcher lives outside this database on purpose.",
    offMeans: "Nothing. `enabled` is not read for this row.",
  },
};

/**
 * Never invent a description. A key with no entry here is a key the console cannot
 * honestly describe, so it says so — and the confirm dialog inherits that warning rather
 * than the reassuring sentence that caused this whole problem.
 */
export function guideFor(key: string): FlagGuide {
  return (
    FLAG_GUIDE[key] ?? {
      kind: "kill_switch",
      enforcedAt: "Not described here. Read the migration that seeded it before touching it.",
      offMeans:
        "UNKNOWN — this key has no entry in admin/app/(console)/flags/guide.ts, so the console cannot tell you what turning it off does.",
    }
  );
}

export const KIND_LABEL: Record<FlagKind, string> = {
  kill_switch: "Feature kill switches",
  alert_channel: "Alert channels",
  config: "Configuration",
};
