import { supabase } from "./supabaseClient";

// Re-export the pure format/category helpers from the shared package so callers
// can import everything Tax-Center related from one module (mirrors the mobile
// src/lib/expenses.js, which re-exports from ./taxFormat).
export {
  EXPENSE_CATEGORIES,
  categoryMeta,
  INCOME_SOURCES,
  sourceMeta,
  buildCSV,
  buildTaxSummaryCSV,
} from "@gohustlr/shared";

export interface Expense {
  id: string;
  user_id: string;
  amount: number;
  category: string;
  description: string | null;
  date: string;
  receipt_url: string | null;
  created_at?: string;
}

export interface IncomeEntry {
  id: string;
  user_id: string;
  amount: number;
  source: string;
  description: string | null;
  date: string;
  created_at?: string;
}

// ── Expenses CRUD ──────────────────────────────────────────────────────────

export async function fetchExpenses(userId: string): Promise<Expense[]> {
  const { data, error } = await supabase
    .from("expenses")
    .select("*")
    .eq("user_id", userId)
    .order("date", { ascending: false });
  if (error) throw error;
  return (data as Expense[]) || [];
}

export async function addExpense(
  userId: string,
  {
    amount,
    category,
    description,
    date,
    receiptUrl,
  }: { amount: number; category: string; description?: string; date: string; receiptUrl?: string | null },
): Promise<Expense> {
  const { data, error } = await supabase
    .from("expenses")
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
  return data as Expense;
}

export async function deleteExpense(id: string): Promise<void> {
  const { error } = await supabase.from("expenses").delete().eq("id", id);
  if (error) throw error;
}

// ── Cash income CRUD ───────────────────────────────────────────────────────

export async function fetchIncome(userId: string): Promise<IncomeEntry[]> {
  const { data, error } = await supabase
    .from("income_entries")
    .select("*")
    .eq("user_id", userId)
    .order("date", { ascending: false });
  if (error) throw error;
  return (data as IncomeEntry[]) || [];
}

export async function addIncome(
  userId: string,
  {
    amount,
    source,
    description,
    date,
  }: { amount: number; source: string; description?: string; date: string },
): Promise<IncomeEntry> {
  const { data, error } = await supabase
    .from("income_entries")
    .insert({ user_id: userId, amount, source, description: description || null, date })
    .select()
    .single();
  if (error) throw error;
  return data as IncomeEntry;
}

export async function deleteIncome(id: string): Promise<void> {
  const { error } = await supabase.from("income_entries").delete().eq("id", id);
  if (error) throw error;
}

// ── Receipt storage (private "receipts" bucket) ────────────────────────────
// The receipts bucket is PRIVATE (financial docs). Mirroring the mobile flow:
// upload returns the storage PATH (not a public URL) which we persist in
// expenses.receipt_url, then sign on demand for display via getSignedUrl().

export async function uploadReceipt(file: File, userId: string): Promise<string> {
  const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
  const rand = Math.random().toString(36).slice(2, 8);
  const path = `${userId}/${Date.now()}-${rand}.${ext}`;
  const { error } = await supabase.storage.from("receipts").upload(path, file, {
    upsert: false,
    contentType: file.type || "image/jpeg",
  });
  if (error) throw error;
  return path;
}

export async function getSignedUrl(
  bucket: string,
  path: string,
  expiresIn = 3600,
): Promise<string | null> {
  if (!path) return null;
  try {
    const { data } = await supabase.storage.from(bucket).createSignedUrl(path, expiresIn);
    return data?.signedUrl || null;
  } catch {
    return null;
  }
}

// ── Year summary ───────────────────────────────────────────────────────────
// Net profit = (Stripe/platform card earnings + logged cash income) − expenses.
// Stripe income comes from profiles.earnings_total (passed in by the caller via
// useUser().earningsTotal, exactly like the mobile screen). Set-aside ~27% of
// positive net is a rough self-employment + income tax hint.

export interface YearSummary {
  year: number;
  expTotal: number;
  cashTotal: number;
  grossIncome: number;
  net: number;
  setAside: number;
  yearExpenses: Expense[];
  yearIncome: IncomeEntry[];
}

const inYear = (dateStr: string | null | undefined, year: number) =>
  (dateStr || "").startsWith(String(year));

export function yearSummary({
  year,
  stripeIncome,
  expenses,
  income,
}: {
  year: number;
  stripeIncome: number;
  expenses: Expense[];
  income: IncomeEntry[];
}): YearSummary {
  const yearExpenses = expenses.filter((e) => inYear(e.date, year));
  const yearIncome = income.filter((e) => inYear(e.date, year));
  const expTotal = yearExpenses.reduce((s, e) => s + Number(e.amount || 0), 0);
  const cashTotal = yearIncome.reduce((s, e) => s + Number(e.amount || 0), 0);
  const grossIncome = Number(stripeIncome || 0) + cashTotal;
  const net = grossIncome - expTotal;
  const setAside = Math.max(0, net) * 0.27;
  return { year, expTotal, cashTotal, grossIncome, net, setAside, yearExpenses, yearIncome };
}
