// Pure tax-format helpers (no native imports) so they're unit-testable.

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
export function buildTaxSummaryCSV({ year, stripeIncome, income, expenses }) {
  const cashTotal = income.reduce((s, e) => s + Number(e.amount || 0), 0);
  const expTotal = expenses.reduce((s, e) => s + Number(e.amount || 0), 0);
  const grossIncome = Number(stripeIncome || 0) + cashTotal;
  const lines = [];
  lines.push(`GoHustlr Tax Summary,${year}`);
  lines.push('');
  lines.push('INCOME');
  lines.push('Date,Source,Description,Amount');
  lines.push(`,Platform (card via Stripe),,${Number(stripeIncome || 0).toFixed(2)}`);
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
