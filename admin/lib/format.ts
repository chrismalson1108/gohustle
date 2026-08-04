export function fmtDate(value: string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function fmtCents(cents: number | null | undefined): string {
  if (cents == null) return "—";
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

// For columns stored as NUMERIC DOLLARS rather than integer cents — chiefly
// bookings.tip_amount, which credit_and_claim_tip writes as `p_cents::numeric/100`.
// Those were being rendered as `$${value}` beside fmtCents fields, so a $5.50 tip
// printed as "$5.5" and a $5 tip as "$5" in a column of "$120.00"s. Same currency
// formatting, different input unit — never pass cents to this.
export function fmtDollars(dollars: number | string | null | undefined): string {
  if (dollars == null || dollars === "") return "—";
  const n = typeof dollars === "string" ? Number(dollars) : dollars;
  if (!Number.isFinite(n)) return "—";
  // tip_amount is `numeric(10,2) default 0`, so an untipped booking holds 0, never
  // null. The call sites this replaced used a truthiness guard and rendered "—";
  // formatting 0 as "$0.00" filled the Tip column with noise and made the rows that
  // DO have a tip stop standing out. A tip below 50c is impossible (stripe-tip
  // bounds it), so zero unambiguously means "none".
  if (n === 0) return "—";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}
