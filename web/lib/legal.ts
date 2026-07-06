// DB-driven legal documents + acceptance audit trail. Port of src/lib/legal.js.
import { supabase } from "./supabaseClient";

export const SUPPORT_EMAIL = "mainmail@gohustlr.com";
export const REQUIRED_SLUGS = ["terms", "privacy", "contractor"] as const;

export interface LegalDoc {
  slug: string;
  version: string;
  title: string;
  body: string;
  published_at?: string;
}

export async function fetchCurrentDocs(): Promise<Record<string, LegalDoc>> {
  const { data, error } = await supabase
    .from("legal_documents")
    .select("slug, version, title, body, published_at")
    .order("published_at", { ascending: false });
  if (error) throw error;
  const map: Record<string, LegalDoc> = {};
  (data || []).forEach((d) => {
    if (!map[d.slug]) map[d.slug] = d as LegalDoc;
  });
  return map;
}

export async function fetchAcceptedVersions(userId: string): Promise<Record<string, Set<string>>> {
  const { data, error } = await supabase
    .from("legal_acceptances")
    .select("slug, version")
    .eq("user_id", userId);
  // Surface read failures so checkNeedsAcceptance treats "couldn't determine" as
  // "needs acceptance" (fail closed) instead of silently assuming accepted.
  if (error) throw error;
  const map: Record<string, Set<string>> = {};
  (data || []).forEach((a) => {
    if (!map[a.slug]) map[a.slug] = new Set();
    map[a.slug].add(a.version);
  });
  return map;
}

export function needsAcceptance(
  currentDocs: Record<string, LegalDoc>,
  accepted: Record<string, Set<string>>,
): boolean {
  return REQUIRED_SLUGS.some((slug) => {
    const cur = currentDocs[slug];
    if (!cur) return false;
    const set = accepted[slug];
    return !set || !set.has(cur.version);
  });
}

export async function recordAcceptances(
  userId: string,
  currentDocs: Record<string, LegalDoc>,
): Promise<void> {
  const rows = REQUIRED_SLUGS.filter((s) => currentDocs[s]).map((s) => ({
    user_id: userId,
    slug: s,
    version: currentDocs[s].version,
  }));
  if (!rows.length) return;
  // Idempotent: the (user_id, slug, version) unique index makes re-recording a
  // no-op instead of piling duplicate audit rows (a double-tap, a concurrent tab,
  // or a re-run of onboarding). ignoreDuplicates keeps the original accepted_at.
  const { error } = await supabase
    .from("legal_acceptances")
    .upsert(rows, { onConflict: "user_id,slug,version", ignoreDuplicates: true });
  if (error) throw error;
}

export async function checkNeedsAcceptance(userId: string): Promise<boolean> {
  try {
    const [docs, accepted] = await Promise.all([
      fetchCurrentDocs(),
      fetchAcceptedVersions(userId),
    ]);
    return needsAcceptance(docs, accepted);
  } catch {
    // Fail CLOSED: if we cannot confirm the user has accepted the current terms
    // (a transient read error, RLS hiccup, offline reconnect), route them to
    // /consent rather than silently admitting them past a legally-binding gate.
    // /consent retries the document load and records acceptance, so a transient
    // failure self-heals there instead of bypassing consent.
    return true;
  }
}
