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
  const files = formData.getAll("images").filter((f): f is File => f instanceof File && f.size > 0);
  if (!ticketId || !body) return { ok: false, message: "Reply is empty." };

  let ctx;
  try {
    ctx = await ctxOrFail();
  } catch (e) {
    if (e instanceof AdminAuthError) return { ok: false, message: "Not authorized." };
    throw e;
  }

  // EVIDENCE HAS TO RUN BOTH WAYS. The user can attach photos; until now the agent
  // could only describe things in prose. Half of support is "here is the payout
  // record", "here is the receipt", "here is the screenshot of what I'm seeing" —
  // and in a dispute, an agent who can't show their working is asking to be taken
  // on faith.
  const images: string[] = [];
  try {
    for (const f of files.slice(0, 6)) {
      if (f.size > 8 * 1024 * 1024) return { ok: false, message: `${f.name} is over 8MB.` };
      if (!/^image\//.test(f.type)) return { ok: false, message: `${f.name} is not an image.` };
      const ext = (f.name.split(".").pop() ?? "jpg").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5) || "jpg";
      // Namespaced under the ticket so the object path itself says which thread it
      // belongs to, and cannot collide with a user's own uploads.
      const path = `ticket-${ticketId}/agent-${crypto.randomUUID()}.${ext}`;
      const { error } = await ctx.service.storage
        .from("support-photos")
        .upload(path, await f.arrayBuffer(), { contentType: f.type, upsert: false });
      if (error) throw new Error(error.message);
      images.push(path);
    }
  } catch (e) {
    return { ok: false, message: `Attachment upload failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  try {
    const { data: ticket, error: tErr } = await ctx.service
      .from("support_tickets")
      .select("id, email, subject, user_id, status")
      .eq("id", ticketId)
      .maybeSingle();
    if (tErr || !ticket) throw new Error("Ticket not found.");

    // Record the reply, then deliver it. If delivery fails, the message is still
    // recorded and we surface the error (fail-loud, not silent).
    const { error: mErr } = await ctx.service
      .from("support_ticket_messages")
      .insert({ ticket_id: ticket.id, author: "admin", admin_id: ctx.user.id, body, images });
    if (mErr) throw new Error(mErr.message);

    // TWO CHANNELS, DELIBERATELY. The email is the only route to someone who filed
    // from the website and has no app account. The push is the only route to someone
    // reading the thread in Messages, which is where support now lives — without it
    // we answer into a screen they have no reason to open. Both are best-effort and
    // independent: the reply row is already saved, so neither failing loses the work.
    const [emailRes, pushRes] = await Promise.all([
      callEdge("support-reply", {
        ticketId: ticket.id,
        subject: `Re: ${ticket.subject} (#${ticket.id})`,
        body,
      }),
      ticket.user_id
        ? callEdge("send-push", {
            supportTicketId: ticket.id,
            // send-push fixes the wording for this path — the reply body is never
            // echoed to a lock screen. `type: system` keeps it out of the email
            // category map so nobody gets the same reply twice.
            data: { type: "system", tab: "MessagesTab" },
          }).catch(() => null)
        : Promise.resolve(null),
    ]);
    const sent = emailRes.ok;
    const pushed = pushRes?.ok ?? false;

    // The message trigger already moved status and last_message_at, and it knows a
    // rule this action does not: a reply on a CLOSED ticket leaves it closed, because
    // reopening is the user's to do. Blindly stamping 'pending' here overrode that.
    if (ticket.status !== "closed") {
      await ctx.service
        .from("support_tickets")
        .update({ status: "pending", updated_at: new Date().toISOString() })
        .eq("id", ticket.id)
        .neq("status", "closed");
    }

    await audit(ctx, "support.reply", "ticket", String(ticket.id), {
      email_sent: sent, pushed, images: images.length,
    });
    revalidatePath(`/support/${ticketId}`);
    revalidatePath("/support");
    if (sent || pushed) {
      return { ok: true, message: pushed && sent ? "Reply sent (in-app + email)." : pushed ? "Reply sent in-app (email failed — check Resend)." : "Reply emailed (no app device to notify)." };
    }
    return { ok: false, message: "Reply saved, but delivery failed (check Resend)." };
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

// ── Who is on it ─────────────────────────────────────────────────────────────
// Two agents answering the same person, or a ticket everyone assumed someone else
// had, are the two failure modes of a shared queue. `assigned_to` has existed since
// the two-way migration with nothing to write it.
//
// Claiming is deliberately not enforced — an unclaimed ticket is still answerable,
// and a queue that makes you claim before you can help is a queue people route
// around. It's a signal, not a lock.
export async function claimTicket(formData: FormData): Promise<ActionResult> {
  const ticketId = String(formData.get("ticketId") ?? "");
  const release = String(formData.get("release") ?? "") === "1";
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
      .update({ assigned_to: release ? null : ctx.user.id, updated_at: new Date().toISOString() })
      .eq("id", ticketId);
    if (error) throw new Error(error.message);
    await audit(ctx, release ? "support.release" : "support.claim", "ticket", ticketId, {});
    revalidatePath(`/support/${ticketId}`);
    revalidatePath("/support");
    return { ok: true, message: release ? "Released." : "Assigned to you." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

// Triage. Users never set this — self-declared urgency is a queue-jumping lever, so
// guard_support_ticket_write pins it (safety ⇒ urgent, everything else normal). An
// agent reading the thread is the one who can tell that a billing question is
// actually a rent-is-due question.
export async function setTicketPriority(formData: FormData): Promise<ActionResult> {
  const ticketId = String(formData.get("ticketId") ?? "");
  const priority = String(formData.get("priority") ?? "");
  if (!["low", "normal", "high", "urgent"].includes(priority)) return { ok: false, message: "Bad priority." };
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
      .update({ priority, updated_at: new Date().toISOString() })
      .eq("id", ticketId);
    if (error) throw new Error(error.message);
    await audit(ctx, "support.priority", "ticket", ticketId, { priority });
    revalidatePath(`/support/${ticketId}`);
    revalidatePath("/support");
    return { ok: true, message: `Priority: ${priority}.` };
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
