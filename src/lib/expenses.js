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

export async function addExpense(userId, { amount, category, description, date, receiptUrl, bookingId, miles }) {
  const { data, error } = await supabase
    .from('expenses')
    .insert({
      user_id: userId,
      amount,
      category,
      description: description || null,
      date,
      receipt_url: receiptUrl || null,
      booking_id: bookingId || null,
      miles: miles ?? null,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// Group expenses by their tied booking_id and sum amounts. `bookings` (from
// useJobs) supplies the job title for display. Returns an array sorted by total
// desc; entries with no matching booking are skipped.
export function expensesByJob(expenses, bookings) {
  const titleFor = {};
  (bookings || []).forEach(b => { if (b?.id) titleFor[b.id] = b.job?.title || 'Untitled gig'; });
  const groups = {};
  (expenses || []).forEach(e => {
    if (!e.booking_id) return;
    if (!groups[e.booking_id]) {
      groups[e.booking_id] = { bookingId: e.booking_id, title: titleFor[e.booking_id] || 'Gig', total: 0, count: 0 };
    }
    groups[e.booking_id].total += Number(e.amount || 0);
    groups[e.booking_id].count += 1;
  });
  return Object.values(groups).sort((a, b) => b.total - a.total);
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
