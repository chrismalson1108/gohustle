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

// ── Reaching out first ───────────────────────────────────────────────────────
// Until now the console could only REPLY to a thread the user started, plus fire a
// one-way push via users/[id] notifyUser. That push is a dead end by construction:
// it warns someone about a flag and gives them no way to answer it. For "we received
// a report about this gig" that is the wrong shape — the user usually has the context
// that resolves it, and refusing to hear it is how a wrong ban happens.
//
// ── WHY SUPPORT TIER, NOT trust/admin ───────────────────────────────────────
//
// My first instinct was trust (moderation's tier) or admin (where notifyUser sits,
// because it writes caller-authored text to a lock screen). Both are wrong here.
//
// notifyUser is gated at admin because it reaches ANY user with ANY wording. But
// support-reply's own header documents that a support-tier insider can ALREADY reach
// an arbitrary recipient in two steps: file a ticket naming the victim, then reply to
// it. So this capability is not new to support — and what lands here is strictly
// NARROWER than that workaround, because it targets an existing user_id rather than
// an arbitrary email address, and it cannot put GoHustlr branding in front of a
// stranger's inbox.
//
// It is also strictly better for traceability. The two-step workaround produces a row
// that LOOKS like the victim wrote in; this produces opened_by='agent' plus a
// support.open_thread audit entry naming the agent. Gating it above support would not
// close the hole, it would just keep the abuse in its less visible form — while
// blocking finance from answering a payout question, since trust and finance are peers
// and requireAdmin("trust") excludes finance.
//
// What actually bounds abuse is the rate limit below and the audit trail, not the tier.
const AGENT_THREAD_CAP_PER_HOUR = 20;
const CATEGORIES = ["payment", "booking", "safety", "account", "other"];

export async function openThreadWithUser(formData: FormData): Promise<ActionResult> {
  const userId = String(formData.get("userId") ?? "");
  const category = String(formData.get("category") ?? "other");
  const subject = String(formData.get("subject") ?? "").trim();
  const body = String(formData.get("body") ?? "").trim();
  const bookingId = String(formData.get("bookingId") ?? "").trim() || null;
  const priority = String(formData.get("priority") ?? "normal");

  if (!userId || !subject || !body) return { ok: false, message: "Subject and message are required." };
  if (!CATEGORIES.includes(category)) return { ok: false, message: "Unknown category." };
  if (!["low", "normal", "high", "urgent"].includes(priority)) return { ok: false, message: "Bad priority." };

  let ctx;
  try {
    ctx = await ctxOrFail();
  } catch (e) {
    if (e instanceof AdminAuthError) return { ok: false, message: "Not authorized." };
    throw e;
  }

  try {
    // The recipient must be a real account. Opening a thread against a stray uuid
    // would create a ticket nobody can ever read or answer.
    const { data: target } = await ctx.service
      .from("profiles").select("id, name").eq("id", userId).maybeSingle();
    if (!target) return { ok: false, message: "No such user." };

    // Cold contact is the console's strongest impersonation primitive: a message that
    // renders to the recipient with the GoHustlr badge. Pointing it at yourself
    // manufactures evidence; pointing it at a colleague plants a fabricated "support
    // said X" on their file. Same rule the destructive user actions already apply.
    if (userId === ctx.user.id) {
      return { ok: false, message: "You can't open a support thread with yourself." };
    }
    const { data: peer, error: peerErr } = await ctx.service
      .from("admin_users").select("role").eq("user_id", userId).maybeSingle();
    // FAIL CLOSED: not knowing whether the target is staff is not a reason to proceed.
    if (peerErr) return { ok: false, message: `Couldn't verify the recipient (${peerErr.message}). Refusing to send.` };
    if (peer) return { ok: false, message: "That account is a team member — use internal channels." };

    // RATE LIMIT — and it has to be countable from something the counted party
    // cannot edit. Counting agent-opened TICKETS keyed on assigned_to was worthless:
    // assigned_to is cleared by this same tier with the Release button, so twenty
    // threads then twenty releases resets the counter. The whole tier argument above
    // rests on this cap, so it reads from admin_audit_log, which is append-only —
    // service_role holds INSERT/SELECT and no UPDATE or DELETE.
    const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
    const { count } = await ctx.service
      .from("admin_audit_log")
      .select("id", { count: "exact", head: true })
      .eq("action", "support.open_thread")
      .eq("admin_id", ctx.user.id)
      .gte("created_at", hourAgo);
    if ((count ?? 0) >= AGENT_THREAD_CAP_PER_HOUR) {
      return { ok: false, message: `Rate limit: ${AGENT_THREAD_CAP_PER_HOUR} new threads per hour.` };
    }

    // A gig attached to the thread must be one THIS user is party to. Otherwise an
    // agent could staple a stranger's booking to the conversation, and every downstream
    // surface that renders "about this gig" would be quietly asserting something false.
    if (bookingId) {
      const { data: b } = await ctx.service
        .from("bookings")
        .select("id, earner_id, job:jobs!bookings_job_id_fkey(poster_id)")
        .eq("id", bookingId)
        .maybeSingle();
      const poster = (b as { job?: { poster_id?: string } } | null)?.job?.poster_id;
      if (!b || (b.earner_id !== userId && poster !== userId)) {
        return { ok: false, message: "That gig doesn't belong to this user." };
      }
    }

    // DON'T FRAGMENT. If there is already a live thread on the same topic and the same
    // gig, this belongs in it — a second thread about one problem splits the history
    // and leaves the user guessing which one to answer.
    // Reuse avoids fragmenting a topic across two threads — but ONLY into a thread we
    // opened ourselves, and never for safety.
    //
    // Categories are coarse, and merging a cold "we received a report about your
    // conduct" into the user's OWN open safety report would file our accusation under
    // their subject line, in the thread where they reported being harmed. Provenance
    // is the entire message there. Same gig as well as same topic: a thread about gig
    // A must not absorb a message about gig B just because both are 'booking'.
    let reuse: { id: number } | null = null;
    if (category !== "safety") {
      let reuseQ = ctx.service
        .from("support_tickets")
        .select("id")
        .eq("user_id", userId)
        .eq("category", category)
        .eq("opened_by", "agent")
        .neq("status", "closed")
        .limit(1);
      reuseQ = bookingId ? reuseQ.eq("booking_id", bookingId) : reuseQ.is("booking_id", null);
      reuse = (await reuseQ).data?.[0] ?? null;
    }
    let ticketId: number | null = reuse?.id ?? null;

    const { data: authUser } = await ctx.service.auth.admin.getUserById(userId);
    const email = authUser?.user?.email ?? "";

    if (!ticketId) {
      const { data: created, error: tErr } = await ctx.service
        .from("support_tickets")
        .insert({
          user_id: userId,
          email,
          name: target.name ?? null,
          subject,
          category,
          priority,
          status: "open",
          // The provenance that makes this honest on every surface: the user did not
          // write in, WE started this. The guard pins this to 'user' for anyone who is
          // not service_role, so a client can never forge it.
          opened_by: "agent",
          assigned_to: ctx.user.id,
          last_message_at: new Date().toISOString(),
        })
        .select("id")
        .single();
      if (tErr || !created) throw new Error(tErr?.message ?? "Could not open the thread.");
      ticketId = created.id;
    }

    const { error: mErr } = await ctx.service
      .from("support_ticket_messages")
      .insert({ ticket_id: ticketId, author: "admin", admin_id: ctx.user.id, body });
    if (mErr) throw new Error(mErr.message);

    // COLD CONTACT DOES NOT EMAIL. Branded mail carrying agent-chosen text to someone
    // who never wrote in is the exact capability notifyUser reserves for full admin,
    // and it is the leg that reaches outside the app where we control nothing about
    // how it is read. In-app plus the fixed-wording push is enough to reach a real
    // user; once they have replied, the thread is a normal conversation and
    // replyTicket emails as usual.
    const coldContact = !reuse;
    const [emailRes, pushRes] = await Promise.all([
      email && !coldContact
        ? callEdge("support-reply", { ticketId, subject: `${subject} (#${ticketId})`, body }).catch(() => null)
        : Promise.resolve(null),
      callEdge("send-push", {
        supportTicketId: ticketId,
        data: { type: "system", tab: "MessagesTab" },
      }).catch(() => null),
    ]);

    // HTTP 200 is not delivery. send-push returns { sent: 0 } when the user has no
    // registered device, and for a thread WE started the push is the only channel —
    // telling an agent a safety notice landed when nothing left the building is worse
    // than telling them it failed.
    let pushedCount: number | null = null;
    if (pushRes?.ok) {
      const d = await pushRes.json().catch(() => null);
      pushedCount = typeof d?.sent === "number" ? d.sent : null;
    }
    const reallyPushed = (pushedCount ?? 0) > 0;

    await audit(ctx, "support.open_thread", "ticket", String(ticketId), {
      user_id: userId, category, priority, booking_id: bookingId,
      reused_existing: Boolean(reuse), cold_contact: coldContact,
      emailed: emailRes?.ok ?? false, push_devices: pushedCount, body_chars: body.length,
    });
    revalidatePath("/support");
    revalidatePath(`/support/${ticketId}`);

    const where = reuse
      ? `Added to their existing ${category} conversation (#${ticketId}).`
      : `Thread opened (#${ticketId}).`;
    const reach = reallyPushed
      ? " They were notified and can reply from the app."
      : " NOTE: no push reached them — no registered device. It's waiting in their app, but assume they haven't seen it.";
    return { ok: true, message: where + reach };
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
