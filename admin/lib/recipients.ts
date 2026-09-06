// ─────────────────────────────────────────────────────────────────────────────
// Resolving a pasted list of "emails or usernames" into user ids.
//
// This lives outside the server action for one reason: the bug it exists to stop was
// arithmetic, not I/O. /pricing's direct-grant box matched the WHOLE list against
// profiles.username and only looked up emails `if (!ids.length)`, so one username in a
// mixed list dropped every email entry — and the success message then blamed the
// shortfall on people "already holding it". Both halves of that are pure functions of
// two lookup tables and a list, so both halves are testable without a database.
//
// The rule: every entry is resolved on its own, and an entry that resolved to nobody is
// NAMED. A grant box that silently discards recipients is worse than one that refuses,
// because the operator walks away believing the offer went out.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Split a pasted blob into normalised, de-duplicated entries.
 *
 * De-duplication matters for the message as much as the work: pasting the same address
 * twice must not make the denominator lie about how many people were addressed.
 */
export function parseRecipients(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of String(raw ?? "").split(/[\s,;]+/)) {
    const entry = part.trim().toLowerCase();
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }
  return out;
}

export interface Resolution {
  /** Distinct user ids to hand the RPC, in the order their entries appeared. */
  ids: string[];
  /** The entries that matched neither a username nor an account email. */
  unmatched: string[];
}

/**
 * Fold two INDEPENDENT lookups into one resolution.
 *
 * Both maps are consulted for every entry. Neither lookup being empty — or non-empty —
 * changes whether the other one is used; that conditional was the defect.
 */
export function resolveRecipients(
  entries: string[],
  byUsername: Map<string, string>,
  byEmail: Map<string, string>,
): Resolution {
  const ids: string[] = [];
  const claimed = new Set<string>();
  const unmatched: string[] = [];
  for (const entry of entries) {
    // Username first only as a preference, never as a gate: an entry that is not a
    // username falls through to the email map on its own merits.
    const id = byUsername.get(entry) ?? byEmail.get(entry);
    if (!id) {
      unmatched.push(entry);
      continue;
    }
    // Two entries can name the same person (their username and their email). Granting
    // twice is harmless — the RPC is on-conflict-do-nothing — but it would inflate the
    // "matched" figure the message reports.
    if (claimed.has(id)) continue;
    claimed.add(id);
    ids.push(id);
  }
  return { ids, unmatched };
}

/**
 * The sentence the operator reads.
 *
 * Three numbers, three different meanings, and the old message collapsed them into one:
 *   granted            — rows the RPC actually inserted
 *   matched − granted  — people who already held the grant (the RPC's own skip)
 *   unmatched          — entries that named nobody, which is an operator problem
 *
 * Only the middle one may ever be described as "already holding it".
 */
export function grantSummary(args: {
  granted: number;
  matched: number;
  unmatched: string[];
}): string {
  const { granted, matched, unmatched } = args;
  const already = Math.max(0, matched - granted);
  const parts = [`Granted to ${granted} of the ${matched} that matched.`];
  if (already > 0) parts.push(`${already} already held it.`);
  if (unmatched.length) {
    const shown = unmatched.slice(0, 10).join(", ");
    parts.push(
      `${unmatched.length} matched no account and got nothing: ${shown}` +
        `${unmatched.length > 10 ? ", …" : ""}.`,
    );
  }
  return parts.join(" ");
}
