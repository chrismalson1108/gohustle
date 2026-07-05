import "server-only";
import { headers } from "next/headers";
import type { AdminContext } from "./guard";

// Append-only accountability trail. Awaited and FAIL-CLOSED: if the audit row
// can't be written, the calling mutation must not proceed/commit its result to
// the user — so call audit() after the action succeeds and let a failure
// surface as an error. (The table itself revokes UPDATE/DELETE from
// service_role, so nothing the console does can rewrite history.)
export async function audit(
  ctx: AdminContext,
  action: string,
  targetType?: string,
  targetId?: string,
  detail?: Record<string, unknown>,
): Promise<void> {
  const h = await headers();
  const ip = (h.get("x-forwarded-for") ?? "").split(",")[0].trim() || null;

  const { error } = await ctx.service.from("admin_audit_log").insert({
    admin_id: ctx.user.id,
    action,
    target_type: targetType ?? null,
    target_id: targetId ?? null,
    detail: detail ?? {},
    ip,
  });
  if (error) throw new Error(`audit write failed (${action}): ${error.message}`);
}

// Best-effort audit for READ/view pages: the data was already fetched, so a
// failed audit insert shouldn't 500 the page (which would just deny the admin
// the view without preventing the access). Logs the failure and moves on.
export async function auditRead(
  ctx: AdminContext,
  action: string,
  targetType?: string,
  targetId?: string,
  detail?: Record<string, unknown>,
): Promise<void> {
  try {
    await audit(ctx, action, targetType, targetId, detail);
  } catch (e) {
    console.error("auditRead failed:", e);
  }
}
