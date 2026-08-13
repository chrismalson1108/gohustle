// Shared derivation of an earner's Stripe Connect payout readiness.
//
// WHY THIS EXISTS: Express onboarding lets a user defer requirements ("Skip for
// now"). Stripe then bounces them back to our return_url looking finished, but the
// account has details_submitted=true with charges_enabled/payouts_enabled still
// false. The app used to collapse all of that into one `onboarded` boolean, so the
// user saw "Payout setup complete" on the return page and "Set up payouts" in the
// app one tap later, with nothing explaining the contradiction.
//
// Worse in live mode: real identity checks land in `pending_verification` for hours
// or days. That user has NOTHING to do — but an "incomplete" UI would send them back
// into onboarding forever. `pending` and `incomplete` must be told apart.
import type Stripe from 'npm:stripe@15';

export type ConnectState =
  | 'none'        // no Connect account yet
  | 'incomplete'  // Stripe wants something FROM THE USER — send them back
  | 'pending'     // Stripe is reviewing; the user just waits
  | 'restricted'  // rejected / paused — support territory
  | 'active';     // charges + payouts live

export interface ConnectStatus {
  hasAccount: boolean;
  /** Unchanged semantics — the escrow gate in create-payment-intent/capture/tip reads this. */
  onboarded: boolean;
  state: ConnectState;
  detailsSubmitted: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  /** True only when the user must return to Stripe and supply something. */
  needsAction: boolean;
  /** True when Stripe is reviewing and the user should simply wait. */
  pendingVerification: boolean;
  /** Human-readable list of what Stripe still wants (deduped, max 6). */
  requirements: string[];
  disabledReason: string | null;
  /** Unix seconds — requirements.current_deadline, when Stripe will disable the account. */
  deadline: number | null;
  title: string;
  message: string;
}

// Stripe requirement keys → plain English. Keys arrive dotted and sometimes prefixed
// with the person id (e.g. "person_1Abc.verification.document"), so we match on the
// suffix after stripping any leading person/company token.
//
// Labels are written as lowercase SENTENCE FRAGMENTS so they read correctly inlined
// into `message` ("Stripe still needs a photo of your ID and your Social Security
// number"). Genuine proper nouns keep their capitals — never lowercase the whole
// label to fit the sentence, or "ID" becomes "id". `capitalize()` restores an
// initial capital for standalone list display.
const REQUIREMENT_LABELS: Array<[RegExp, string]> = [
  [/verification\.additional_document/, 'a second photo ID'],
  [/verification\.document/, 'a photo of your ID'],
  [/verification\.proof_of_liveness/, 'a selfie to match your ID'],
  [/\bid_number\b/, 'your Social Security number'],
  [/\bssn_last_4\b/, 'the last 4 digits of your SSN'],
  [/\bdob\b/, 'your date of birth'],
  [/address\.?/, 'your home address'],
  [/first_name|last_name/, 'your legal name'],
  [/\bphone\b/, 'your phone number'],
  [/\bemail\b/, 'your email address'],
  [/external_account|bank_account/, 'a bank account to deposit your earnings'],
  [/tos_acceptance/, "your acceptance of Stripe's terms"],
  [/business_profile\.(mcc|product_description|url)/, 'a short description of the work you do'],
  [/relationship\.|owners|directors|executives/, 'confirmation of who owns the account'],
];

function humanizeRequirement(key: string): string {
  // Drop a leading "person_xxx." / "company." scope so the suffix matches cleanly.
  const bare = key.replace(/^(person_[A-Za-z0-9]+|individual|company)\./, '');
  for (const [pattern, label] of REQUIREMENT_LABELS) {
    if (pattern.test(bare)) return label;
  }
  // Fallback: "individual.political_exposure" → "political exposure"
  return bare.split('.').pop()!.replace(/_/g, ' ').trim();
}

/** Sentence-fragment labels, deduped, capped at 6. */
function humanizeAll(keys: string[]): string[] {
  const seen = new Set<string>();
  for (const k of keys) {
    seen.add(humanizeRequirement(k));
    if (seen.size >= 6) break;
  }
  return [...seen];
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Joins ["A", "B", "C"] → "A, B and C". */
function listToSentence(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

export const NO_ACCOUNT_STATUS: ConnectStatus = {
  hasAccount: false,
  onboarded: false,
  state: 'none',
  detailsSubmitted: false,
  chargesEnabled: false,
  payoutsEnabled: false,
  needsAction: true,
  pendingVerification: false,
  requirements: [],
  disabledReason: null,
  deadline: null,
  title: 'Set up payouts',
  message: 'Connect a bank account so you can get paid for the jobs you complete.',
};

export function deriveConnectStatus(account: Stripe.Account): ConnectStatus {
  const req = account.requirements ?? ({} as Stripe.Account.Requirements);
  const currentlyDue = req.currently_due ?? [];
  const pastDue = req.past_due ?? [];
  const pendingVer = req.pending_verification ?? [];
  const errors = req.errors ?? [];
  const disabledReason = req.disabled_reason ?? null;

  const detailsSubmitted = !!account.details_submitted;
  const chargesEnabled = !!account.charges_enabled;
  const payoutsEnabled = !!account.payouts_enabled;
  // Keep IDENTICAL to the gate in stripe-create-payment-intent — changing what
  // counts as onboarded here would silently change who can be paid.
  const onboarded = detailsSubmitted && chargesEnabled && payoutsEnabled;

  // A hard stop from Stripe's side — the user can't fix these by resubmitting.
  const isRestricted =
    !!disabledReason &&
    (disabledReason.startsWith('rejected.') ||
      disabledReason === 'platform_paused' ||
      disabledReason === 'listed');

  let state: ConnectState;
  if (onboarded) state = 'active';
  else if (isRestricted) state = 'restricted';
  // Anything the USER still owes wins over "pending" — an unreadable document shows
  // up as an error plus a re-requested currently_due, and that needs them to act.
  else if (currentlyDue.length > 0 || pastDue.length > 0 || errors.length > 0) state = 'incomplete';
  else if (
    pendingVer.length > 0 ||
    disabledReason === 'requirements.pending_verification' ||
    disabledReason === 'under_review'
  ) state = 'pending';
  else if (!detailsSubmitted) state = 'incomplete';
  // Details are in and nothing is outstanding, but the capabilities still aren't
  // live — Stripe is finishing up. Waiting is the correct advice.
  else state = 'pending';

  // Fragments read naturally inlined into `message`; the exposed list is capitalized
  // for standalone display in the UI's bulleted requirement list.
  const fragments = humanizeAll([...pastDue, ...currentlyDue]);
  const requirements = fragments.map(capitalize);
  const deadline = req.current_deadline ?? null;

  let title: string;
  let message: string;
  switch (state) {
    case 'active':
      title = 'Payouts are active';
      message =
        'Your bank is connected. Earnings deposit automatically after a job is verified.';
      break;
    case 'pending':
      title = 'Stripe is verifying your details';
      message =
        "Nothing more is needed from you. Stripe is reviewing your ID — this is usually quick but can take 1–2 business days. Payouts switch on automatically as soon as it clears.";
      break;
    case 'restricted':
      title = 'Payouts unavailable';
      message =
        "Stripe couldn't approve this payout account, so we can't send you money through it. Contact support and we'll help sort it out.";
      break;
    case 'incomplete': {
      title = 'Finish your payout setup';
      const what = fragments.length
        ? ` Stripe still needs ${listToSentence(fragments)}.`
        : ' Stripe still needs a few details before it can pay you.';
      const overdue =
        disabledReason === 'requirements.past_due' || pastDue.length > 0
          ? ' This is now overdue, so payouts are paused until it’s done.'
          : '';
      message =
        `You skipped a step, so your payout account isn’t finished yet.${what}${overdue} It takes about a minute.`;
      break;
    }
    default:
      title = 'Set up payouts';
      message = 'Connect a bank account so you can get paid for the jobs you complete.';
  }

  return {
    hasAccount: true,
    onboarded,
    state,
    detailsSubmitted,
    chargesEnabled,
    payoutsEnabled,
    // 'none' is unreachable here — this function only runs once an account exists, and
    // the no-account case is answered by the caller (src/lib/connectStatus.js). Left as
    // a comment rather than a comparison so `deno check` stays clean.
    needsAction: state === 'incomplete',
    pendingVerification: state === 'pending',
    requirements,
    disabledReason,
    deadline,
    title,
    message,
  };
}
