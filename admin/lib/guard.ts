import "server-only";
import { redirect } from "next/navigation";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { getServerSupabase } from "./supabaseServer";
import { getServiceClient } from "./serviceClient";

export type AdminRole = "admin" | "support";

export interface AdminContext {
  user: User;
  role: AdminRole;
  service: SupabaseClient;
}

export type DenyReason = "unauthenticated" | "mfa" | "forbidden";

export class AdminAuthError extends Error {
  constructor(public readonly reason: DenyReason) {
    super(`admin auth failed: ${reason}`);
  }
}

// THE enforcement point. Every server component page and every server action
// calls this before touching data. Chain: authentic session (getUser hits the
// auth server, not just cookie parsing) → TOTP MFA satisfied this session
// (AAL2) → admin_users membership → role tier. proxy.ts only does UX
// redirects; nothing is protected unless it passes here.
export async function requireAdmin(minRole: AdminRole = "support"): Promise<AdminContext> {
  const supa = await getServerSupabase();

  const {
    data: { user },
    error,
  } = await supa.auth.getUser();
  if (error || !user) throw new AdminAuthError("unauthenticated");

  const { data: aal } = await supa.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aal?.currentLevel !== "aal2") throw new AdminAuthError("mfa");

  const service = getServiceClient();
  const { data: row, error: lookupErr } = await service
    .from("admin_users")
    .select("role")
    .eq("user_id", user.id)
    .maybeSingle();
  if (lookupErr) throw new Error(`admin_users lookup failed: ${lookupErr.message}`);
  if (!row) throw new AdminAuthError("forbidden");

  const role = row.role as AdminRole;
  if (minRole === "admin" && role !== "admin") throw new AdminAuthError("forbidden");

  return { user, role, service };
}

// Page wrapper: turns deny reasons into the right redirect instead of a 500.
export async function requireAdminPage(minRole: AdminRole = "support"): Promise<AdminContext> {
  try {
    return await requireAdmin(minRole);
  } catch (e) {
    if (e instanceof AdminAuthError) {
      if (e.reason === "unauthenticated") redirect("/login");
      if (e.reason === "mfa") redirect("/mfa");
      redirect("/denied");
    }
    throw e;
  }
}
