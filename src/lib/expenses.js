import { supabase } from './supabase';

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

export async function fetchExpenses(userId) {
  const { data, error } = await supabase
    .from('expenses')
    .select('*')
    .eq('user_id', userId)
    .order('date', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function addExpense(userId, { amount, category, description, date, receiptUrl }) {
  const { data, error } = await supabase
    .from('expenses')
    .insert({
      user_id: userId,
      amount,
      category,
      description: description || null,
      date,
      receipt_url: receiptUrl || null,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteExpense(id) {
  const { error } = await supabase.from('expenses').delete().eq('id', id);
  if (error) throw error;
}

// ── Income (off-platform / cash, logged manually) ──────────────────────────
export const INCOME_SOURCES = [
  { id: 'cash',  label: 'Cash',  ion: 'cash-outline' },
  { id: 'tip',   label: 'Tip',   ion: 'gift-outline' },
  { id: 'other', label: 'Other', ion: 'ellipsis-horizontal' },
];

export function sourceMeta(id) {
  return INCOME_SOURCES.find(s => s.id === id) || INCOME_SOURCES[INCOME_SOURCES.length - 1];
}

export async function fetchIncome(userId) {
  const { data, error } = await supabase
    .from('income_entries')
    .select('*')
    .eq('user_id', userId)
    .order('date', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function addIncome(userId, { amount, source, description, date }) {
  const { data, error } = await supabase
    .from('income_entries')
    .insert({ user_id: userId, amount, source, description: description || null, date })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteIncome(id) {
  const { error } = await supabase.from('income_entries').delete().eq('id', id);
  if (error) throw error;
}

// Build a spreadsheet-ready CSV for the given expenses.
export function buildCSV(expenses) {
  const header = 'Date,Category,Description,Amount,Receipt';
  const rows = expenses.map(e => {
    const desc = (e.description || '').replace(/"/g, '""');
    const cat = categoryMeta(e.category).label;
    return `${e.date},"${cat}","${desc}",${Number(e.amount).toFixed(2)},${e.receipt_url || ''}`;
  });
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
    const desc = (e.description || '').replace(/"/g, '""');
    lines.push(`${e.date},"${sourceMeta(e.source).label}","${desc}",${Number(e.amount).toFixed(2)}`);
  });
  lines.push(`,,Gross income,${grossIncome.toFixed(2)}`);
  lines.push('');
  lines.push('EXPENSES');
  lines.push('Date,Category,Description,Amount,Receipt');
  expenses.forEach(e => {
    const desc = (e.description || '').replace(/"/g, '""');
    lines.push(`${e.date},"${categoryMeta(e.category).label}","${desc}",${Number(e.amount).toFixed(2)},${e.receipt_url || ''}`);
  });
  lines.push(`,,Total expenses,${expTotal.toFixed(2)}`);
  lines.push('');
  lines.push(`,,NET PROFIT,${(grossIncome - expTotal).toFixed(2)}`);
  return lines.join('\n');
}
