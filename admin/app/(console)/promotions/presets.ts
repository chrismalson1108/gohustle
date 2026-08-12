// Campaign presets.
//
// These are not generic marketing templates — each one is aimed at a problem this
// specific marketplace has right now: a two-sided cold start on college campuses,
// where the platform fee comes out of the EARNER's side and Stripe is still in test
// mode pending a live cutover.
//
// Two facts shape every preset here:
//   1. A fee override reaches EARNERS only. The poster's price does not move, so a
//      "0% fee" campaign buys supply, not demand. Reaching posters needs a
//      poster_discount, which the platform funds out of its own margin.
//   2. Every discount is capped by the headroom between the fee and the processing
//      floor. On a $100 gig at 10% that is $6.55, so a "$10 off" preset will honour
//      $6.55 on that gig — deliberately, because the alternative is paying Stripe's
//      costs out of pocket. The UI says so rather than letting an operator discover it.
//
// `why` is shown in the console. It exists so that whoever runs a campaign in six
// months knows what it was FOR, which is the thing that decides whether to renew it.

export interface Preset {
  key: string;
  label: string;
  why: string;
  side: "earner" | "poster" | "both";
  fields: {
    name: string;
    kind: "fee_override" | "bonus" | "poster_discount";
    fee_pct?: number;
    bonus_dollars?: number;
    discount_dollars?: number;
    uses_allowed?: number;
    budget_dollars: number;
    max_redemptions: number;
    days: number;
  };
}

export const PRESETS: Preset[] = [
  {
    key: "first_gigs_free",
    label: "First 2 gigs — no platform fee",
    side: "earner",
    why:
      "The strongest supply lever you have. A student's first gig is where they decide " +
      "whether this is worth their time, and 'you keep everything' removes the only " +
      "reason to arrange it off-platform. Costs you nothing on someone who never " +
      "returns, because the benefit only lands when they actually work.",
    fields: {
      name: "First 2 gigs free",
      kind: "fee_override",
      fee_pct: 0,
      uses_allowed: 2,
      budget_dollars: 500,
      max_redemptions: 200,
      days: 90,
    },
  },
  {
    key: "campus_launch",
    label: "Campus launch — 30 days, code-gated",
    side: "earner",
    why:
      "For opening a new school. Code-gated rather than targeted on profiles.school, " +
      "which is a field users can edit until they are student-verified — so the CODE is " +
      "the targeting, handed out at a table or in a campus email, and cannot be " +
      "self-assigned. Per-code seats mean one leaked code burns itself, not the budget.",
    fields: {
      name: "Campus launch",
      kind: "fee_override",
      fee_pct: 0,
      uses_allowed: 3,
      budget_dollars: 750,
      max_redemptions: 300,
      days: 30,
    },
  },
  {
    key: "first_hire_discount",
    label: "$10 off your first hire",
    side: "poster",
    why:
      "The demand-side counterpart, and the only preset that reaches posters at all. " +
      "The earner still receives their full agreed pay — you absorb it out of margin — " +
      "so it can never quietly become a pay cut for the student. Capped at the fee " +
      "headroom, which on a $100 gig is $6.55.",
    fields: {
      name: "$10 off your first hire",
      kind: "poster_discount",
      discount_dollars: 10,
      budget_dollars: 500,
      max_redemptions: 100,
      days: 60,
    },
  },
  {
    key: "referral_reward",
    label: "$10 per successful referral",
    side: "earner",
    why:
      "The growth loop. Pays only after the referred person completes a gig that is " +
      "VERIFIED and survives the refund window — so farming it requires doing real work " +
      "and paying real fees on both sides. Delivered as a fee credit, which is worth $10 " +
      "to someone who works and $0 to someone gaming it.",
    fields: {
      name: "$10 per successful referral",
      kind: "bonus",
      bonus_dollars: 10,
      budget_dollars: 1000,
      max_redemptions: 200,
      days: 180,
    },
  },
  {
    key: "win_back",
    label: "Win-back — 5% for 30 days",
    side: "earner",
    why:
      "For earners who have gone quiet. Cheaper than acquiring someone new, and a " +
      "halved fee is a concrete reason to open the app again. Issue grants directly to " +
      "a chosen list rather than minting a public code — a win-back offer that leaks to " +
      "active users is pure margin given away for behaviour you already had.",
    fields: {
      name: "Win-back — 5% for 30 days",
      kind: "fee_override",
      fee_pct: 5,
      uses_allowed: 5,
      budget_dollars: 300,
      max_redemptions: 150,
      days: 30,
    },
  },
  {
    key: "peak_week",
    label: "Peak week — move-in / finals",
    side: "earner",
    why:
      "Short, sharp, and tied to when demand actually spikes on a campus: move-in, " +
      "finals, move-out. Supply is the constraint in those weeks, not demand, so cutting " +
      "the earner's fee is the lever that adds capacity. Keep the window tight — this is " +
      "the preset most likely to be left running by accident, which is why it defaults " +
      "to 10 days.",
    fields: {
      name: "Peak week",
      kind: "fee_override",
      fee_pct: 0,
      uses_allowed: 4,
      budget_dollars: 400,
      max_redemptions: 150,
      days: 10,
    },
  },
  {
    key: "category_boost",
    label: "Category boost — fix a supply gap",
    side: "earner",
    why:
      "When gigs in one category sit unfilled. A reduced fee pulls earners toward it " +
      "without touching what posters pay. Pair it with the browse chips to see which " +
      "categories are actually starved before choosing — a boost on a category that is " +
      "already liquid is margin spent on nothing.",
    fields: {
      name: "Category boost",
      kind: "fee_override",
      fee_pct: 5,
      uses_allowed: 3,
      budget_dollars: 250,
      max_redemptions: 100,
      days: 45,
    },
  },
  {
    key: "two_sided_launch",
    label: "Two-sided launch pair (earner half)",
    side: "both",
    why:
      "Run alongside the first-hire discount to open a campus on both sides at once. " +
      "A one-sided launch usually stalls: free supply with no jobs to do is as dead as " +
      "cheap jobs with nobody to take them. Create BOTH, activate them together, and " +
      "give them the same end date so they expire as a pair.",
    fields: {
      name: "Campus launch — earner half",
      kind: "fee_override",
      fee_pct: 0,
      uses_allowed: 2,
      budget_dollars: 600,
      max_redemptions: 250,
      days: 45,
    },
  },
];
