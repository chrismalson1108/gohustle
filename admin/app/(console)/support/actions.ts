"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin, AdminAuthError } from "@/lib/guard";
import { audit, auditRead } from "@/lib/audit";
import { getServerSupabase } from "@/lib/supabaseServer";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "@/lib/config";

export interface ActionResult {
  ok: boolean;
  message: string;
}

// Support staff (support tier and up) own the ticket queue — replying to and
// triaging support requests is their whole job, so this is NOT gated to admin.
async function ctxOrFail() {
  return requireAdmin("support");
}

// Call a support edge function as the signed-in admin — the function validates
// the JWT + admin_users membership itself (no shared secret to manage).
async function callEdge(fn: string, payload: unknown): Promise<Response> {
  const supa = await getServerSupabase();
  const {
    data: { session },
  } = await supa.auth.getSession();
  const token = session?.access_token ?? "";
  return fetch(`${SUPABASE_URL}/functions/v1/${fn}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      apikey: SUPABASE_ANON_KEY,
    },
    body: JSON.stringify(payload),
  });
}

export async function replyTicket(formData: FormData): Promise<ActionResult> {
  const ticketId = String(formData.get("ticketId") ?? "");
  const body = String(formData.get("body") ?? "").trim();
  if (!ticketId || !body) return { ok: false, message: "Reply is empty." };

  let ctx;
  try {
    ctx = await ctxOrFail();
  } catch (e) {
    if (e instanceof AdminAuthError) return { ok: false, message: "Not authorized." };
    throw e;
  }
  try {
    const { data: ticket, error: tErr } = await ctx.service
      .from("support_tickets")
      .select("id, email, subject")
      .eq("id", ticketId)
      .maybeSingle();
    if (tErr || !ticket) throw new Error("Ticket not found.");

    // Record the reply, then send the email. If the email send fails, the message
    // is still recorded and we surface the error (fail-loud, not silent).
    const { error: mErr } = await ctx.service
      .from("support_ticket_messages")
      .insert({ ticket_id: ticket.id, author: "admin", admin_id: ctx.user.id, body });
    if (mErr) throw new Error(mErr.message);

    const res = await callEdge("support-reply", {
      ticketId: ticket.id,
      toEmail: ticket.email,
      subject: `Re: ${ticket.subject} (#${ticket.id})`,
      body,
    });
    const sent = res.ok;

    await ctx.service
      .from("support_tickets")
      .update({ status: "pending", last_message_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", ticket.id);

    await audit(ctx, "support.reply", "ticket", String(ticket.id), { email_sent: sent });
    revalidatePath(`/support/${ticketId}`);
    revalidatePath("/support");
    return sent
      ? { ok: true, message: "Reply sent." }
      : { ok: false, message: "Reply saved, but the email failed to send (check Resend)." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

export async function setTicketStatus(formData: FormData): Promise<ActionResult> {
  const ticketId = String(formData.get("ticketId") ?? "");
  const status = String(formData.get("status") ?? "");
  if (!ticketId || !["open", "pending", "closed"].includes(status)) return { ok: false, message: "Bad status." };
  let ctx;
  try {
    ctx = await ctxOrFail();
  } catch (e) {
    if (e instanceof AdminAuthError) return { ok: false, message: "Not authorized." };
    throw e;
  }
  try {
    const { error } = await ctx.service
      .from("support_tickets")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("id", ticketId);
    if (error) throw new Error(error.message);
    await audit(ctx, "support.status", "ticket", ticketId, { status });
    revalidatePath(`/support/${ticketId}`);
    revalidatePath("/support");
    return { ok: true, message: `Marked ${status}.` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

export async function aiDraft(ticketId: string): Promise<{ ok: boolean; draft?: string; message?: string }> {
  let ctx;
  try {
    ctx = await ctxOrFail();
  } catch (e) {
    if (e instanceof AdminAuthError) return { ok: false, message: "Not authorized." };
    throw e;
  }
  try {
    const { data: ticket } = await ctx.service.from("support_tickets").select("subject").eq("id", ticketId).maybeSingle();
    const { data: messages } = await ctx.service
      .from("support_ticket_messages")
      .select("author, body")
      .eq("ticket_id", ticketId)
      .order("created_at", { ascending: true })
      .limit(40);
    const res = await callEdge("support-ai-draft", { subject: ticket?.subject, messages: messages ?? [] });
    if (!res.ok) return { ok: false, message: "AI draft unavailable." };
    const data = await res.json();
    // The draft ships ticket content to the LLM — record the PII egress (best-effort).
    await auditRead(ctx, "support.ai_draft", "ticket", ticketId);
    return { ok: true, draft: data.draft ?? "" };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}
