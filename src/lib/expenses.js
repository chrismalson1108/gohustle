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
