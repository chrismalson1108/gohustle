import { supabase } from './supabase';

// Pure format/category helpers live in taxFormat.js (unit-tested); re-export so
// existing imports from '../lib/expenses' keep working.
export {
  EXPENSE_CATEGORIES, categoryMeta, INCOME_SOURCES, sourceMeta, buildCSV, buildTaxSummaryCSV,
} from './taxFormat';

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
