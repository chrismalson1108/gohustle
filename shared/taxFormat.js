// Pure tax-format helpers (no native imports) so they're unit-testable.

import { bookingNetDollars } from './pricing.js';

/**
 * Today's date in the USER's time zone, as YYYY-MM-DD.
 *
 * `new Date().toISOString().slice(0, 10)` is the UTC date, and this is a US college
 * market: from about 7pm Eastern (4pm Pacific) onward it is already tomorrow in UTC,
 * so the date prefilled into "Add expense" and stamped on an auto-logged gig drive was
 * the wrong day every evening. `expenses.date` is a DATE and the year filter, the
 * per-job grouping and the year-end CSV all read it, while the year those are scoped
 * to comes from the LOCAL clock (new Date().getFullYear()) — so the two disagreed. A
 * receipt logged at 9pm on 31 December filed itself into the NEXT tax year.
 *
 * Built from local components for that reason. Callers may pass a Date to format.
 */
export function localDateISO(dt = new Date()) {
  const d = dt instanceof Date ? dt : new Date(dt);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Deductible categories aligned to a gig worker's Schedule C.
export const EXPENSE_CATEGORIES = [
  { id: 'supplies',  label: 'Supplies',         ion: 'cube-outline' },
  { id: 'transport', label: 'Transport/Mileage',ion: 'car-outline' },
  { id: 'equipment', label: 'Equipment',        ion: 'construct-outline' },
  { id: 'fees',      label: 'Fees',             ion: 'card-outline' },
  { id: 'marketing', label: 'Marketing',        ion: 'megaphone-outline' },
  { id: 'phone',     label: 'Phone/Internet',   ion: 'phone-portrait-outline' },
  { id: 'meals',     label: 'Meals',            ion: 'restaurant-outline' },
  { id: 'other',     label: 'Other',            ion: 'ellipsis-horizontal' },
];

export function categoryMeta(id) {
  return EXPENSE_CATEGORIES.find(c => c.id === id) || EXPENSE_CATEGORIES[EXPENSE_CATEGORIES.length - 1];
}

export const INCOME_SOURCES = [
  { id: 'cash',  label: 'Cash',  ion: 'cash-outline' },
  { id: 'tip',   label: 'Tip',   ion: 'gift-outline' },
  { id: 'other', label: 'Other', ion: 'ellipsis-horizontal' },
];

export function sourceMeta(id) {
  return INCOME_SOURCES.find(s => s.id === id) || INCOME_SOURCES[INCOME_SOURCES.length - 1];
}

// Neutralize CSV/formula injection: a cell whose first char is = + - @ (or a tab/CR
// control char) is executed as a formula by Excel / Google Sheets / Numbers. Prefix
// any such value with a single quote, then wrap the cell in quotes and double any
// internal quotes. Used for every user-controlled cell so a description like
// `=HYPERLINK(...)` can't run when the exported file is opened.
export function csvCell(v) {
  const s = String(v == null ? '' : v);
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

/**
 * Gross dollar value of ONE booking, for income reporting.
 *
 * Prefers `amountCentsQuoted` — bookings.amount_cents_quoted, the amount PINNED at
 * insert by trg_z_pin_booking_amount as
 * `round(coalesce(counter_offer, j.pay) * (hourly ? coalesce(estimated_hours,1) : 1))`
 * (supabase/migrations/20260806320000). That is the figure the escrow hold and the
 * capture are derived from, so an income total built on it cannot disagree with the
 * payout.
 *
 * Only when the pin is absent (rows predating it) does this fall back to
 * pay x hours — and it reads `estimatedHours` from the full job row OR from the
 * booking's own job embed. Reading it from the full row alone is what valued every
 * hourly gig at ONE hour on a screen that had no full row to give it: a 6-hour
 * $25/hr gig counted as $25.
 */
export function bookingGrossDollars(booking, fullJob) {
  if (booking?.amountCentsQuoted != null) {
    const cents = Number(booking.amountCentsQuoted);
    if (Number.isFinite(cents)) return cents / 100;
  }
  const payType = fullJob?.payType ?? booking?.job?.payType;
  const basePay = Number(booking?.counterOffer ?? fullJob?.pay ?? booking?.job?.pay ?? 0);
  const hours = Number(fullJob?.estimatedHours ?? booking?.job?.estimatedHours) || 1;
  const effective = payType === 'hourly' ? basePay * hours : basePay;
  return Number.isFinite(effective) ? effective : 0;
}

/**
 * The earner's PLATFORM income for one calendar year, split into the two things the
 * platform actually paid them: fee-net gig earnings, and card tips.
 *
 * Each booking is netted at its OWN pinned rate (`feeBpsQuoted`), never at the current
 * rate card. Tips are NOT fee-bearing — stripe-tip routes the whole amount to the
 * earner with no application fee (a deliberate decision, KNOWN_RISKS T-1) — so they
 * are added gross, and kept separate so the year-end CSV can name them.
 *
 * `jobById` is optional (a Map from job id to the full job row); it only matters for
 * bookings predating the amount pin.
 */
export function platformIncomeForYear({ bookings, year, jobById } = {}) {
  const y = String(year);
  let earnings = 0;
  let tips = 0;
  (bookings || []).forEach((b) => {
    if (b?.status !== 'verified') return;
    if (!String(b?.completedAt || '').startsWith(y)) return;
    const gross = bookingGrossDollars(b, jobById?.get?.(b.jobId));
    earnings += bookingNetDollars(gross, b?.feeBpsQuoted);
    tips += Number(b?.tipAmount) || 0;
  });
  return { earnings, tips, total: earnings + tips };
}

// Build a spreadsheet-ready CSV for the given expenses.
export function buildCSV(expenses) {
  const header = 'Date,Category,Description,Amount,Receipt';
  const rows = expenses.map(e =>
    [
      csvCell(e.date),
      csvCell(categoryMeta(e.category).label),
      csvCell(e.description || ''),
      Number(e.amount).toFixed(2),
      csvCell(e.receipt_url || ''),
    ].join(',')
  );
  return [header, ...rows].join('\n');
}

// Combined year-end tax summary CSV: income (Stripe + logged) then expenses then totals.
//
// `tipIncome` is card tips paid through the platform. They are listed on their own row
// rather than folded into the gig line because they are not fee-bearing, and because a
// user reading this beside their bank statement should be able to see both numbers.
// Optional and defaulted so older callers keep their previous output exactly.
export function buildTaxSummaryCSV({ year, stripeIncome, tipIncome = 0, income, expenses }) {
  const cashTotal = income.reduce((s, e) => s + Number(e.amount || 0), 0);
  const expTotal = expenses.reduce((s, e) => s + Number(e.amount || 0), 0);
  const tipTotal = Number(tipIncome || 0);
  const grossIncome = Number(stripeIncome || 0) + tipTotal + cashTotal;
  const lines = [];
  lines.push(`GoHustlr Tax Summary,${year}`);
  lines.push('');
  lines.push('INCOME');
  lines.push('Date,Source,Description,Amount');
  lines.push(`,Platform (card via Stripe),,${Number(stripeIncome || 0).toFixed(2)}`);
  if (tipTotal > 0) lines.push(`,Platform tips (card),,${tipTotal.toFixed(2)}`);
  income.forEach(e => {
    lines.push([csvCell(e.date), csvCell(sourceMeta(e.source).label), csvCell(e.description || ''), Number(e.amount).toFixed(2)].join(','));
  });
  lines.push(`,,Gross income,${grossIncome.toFixed(2)}`);
  lines.push('');
  lines.push('EXPENSES');
  lines.push('Date,Category,Description,Amount,Receipt');
  expenses.forEach(e => {
    lines.push([csvCell(e.date), csvCell(categoryMeta(e.category).label), csvCell(e.description || ''), Number(e.amount).toFixed(2), csvCell(e.receipt_url || '')].join(','));
  });
  lines.push(`,,Total expenses,${expTotal.toFixed(2)}`);
  lines.push('');
  lines.push(`,,NET PROFIT,${(grossIncome - expTotal).toFixed(2)}`);
  return lines.join('\n');
}
