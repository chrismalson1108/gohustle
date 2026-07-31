"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import Link from "next/link";
import { MessageCircle, Send, ArrowLeft, ImagePlus, MoreVertical, Flag, Ban, Check, Loader2, Archive, ArchiveRestore, Search } from "lucide-react";
import { useJobs } from "@/lib/jobs";
import { useAuth } from "@/lib/auth";
import { useUser } from "@/lib/user";
import { supabase } from "@/lib/supabaseClient";
import { fetchLastMessages, fetchConversationState, isUnread, previewText, markConversationRead, setConversationArchived, notBlocked } from "@/lib/messages";
import { notify } from "@/lib/push";
import { uploadPrivateToBucket, getSignedUrl, chatObjectPath } from "@/lib/uploadImage";
import { submitReport, REPORT_REASONS, moderateText, logModerationBlock } from "@/lib/moderation";
import { findProhibited } from "@gohustlr/shared";
import PageHeader, { EmptyState, WIDTHS } from "@/components/PageHeader";
import Avatar from "@/components/ui/Avatar";
import Modal from "@/components/ui/Modal";
import Button from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Field";
import { FullPageSpinner } from "@/components/ui/Spinner";
import { classNames, timeAgo } from "@/lib/format";

interface Conversation {
  bookingId: string;
  otherId: string | null;
  name: string;
  avatarUrl: string | null;
  avatarInitial: string | null;
  jobTitle: string;
  jobId: string | null;
}

interface Msg {
  id?: string;
  booking_id: string;
  sender_id: string;
  text: string | null;
  image_url: string | null;
  created_at: string;
}

export default function MessagesPage() {
  const { user } = useAuth();
  const { bookings, posterBookings, jobs, refreshUnread, blockedIds } = useJobs();

  // Build the conversation list from both sides of the user's bookings.
  const conversations = useMemo<Conversation[]>(() => {
    const list: Conversation[] = [];
    bookings.forEach((b) => {
      const job = jobs.find((j) => j.id === b.jobId);
      list.push({
        bookingId: b.id,
        otherId: job?.posterId ?? b.job?.posterId ?? null,
        // Never fall back to the job title — this field is a PERSON'S name. The
        // browse list holds only currently-listed gigs, so a conversation about a
        // gig you already won, finished, or that was taken down finds no `job`
        // here, and the row then rendered the GIG as the person you were talking
        // to ("Fishing Assistance tutorial" sat where a name belongs, next to an
        // avatar initialled from someone else). Mobile keeps the counterparty null
        // in this case and never substitutes the title; web now matches.
        name: job?.poster?.name || "Poster",
        avatarUrl: job?.poster?.avatarUrl || null,
        avatarInitial: job?.poster?.avatarInitial || "P",
        jobTitle: b.job?.title || job?.title || "Gig",
        jobId: b.jobId ?? null,
      });
    });
    posterBookings.forEach((b) => {
      list.push({
        bookingId: b.id,
        otherId: b.earner?.id ?? null,
        name: b.earner?.name || "Earner",
        avatarUrl: b.earner?.avatarUrl || null,
        avatarInitial: b.earner?.avatarInitial || "E",
        jobTitle: b.job?.title || "Gig",
        jobId: b.jobId ?? null,
      });
    });
    // De-dupe by bookingId (a booking belongs to one conversation), and hide any
    // conversation whose other party I've blocked (H2 hub filter — mirrors mobile).
    const seen = new Set<string>();
    return list.filter((c) => {
      if (seen.has(c.bookingId)) return false;
      seen.add(c.bookingId);
      return notBlocked(c, blockedIds);
    });
  }, [bookings, posterBookings, jobs, blockedIds]);

  const [last, setLast] = useState<Record<string, { text: string; unread: boolean; at: string; archived: boolean }>>({});
  const [active, setActive] = useState<Conversation | null>(null);
  const [tab, setTab] = useState<"inbox" | "archived">("inbox");
  // Bumped on every archive toggle. A loadPreviews already in flight when the user
  // toggles would otherwise resolve later and overwrite the optimistic archived flag.
  const archiveSeq = useRef(0);

  const loadPreviews = useCallback(async () => {
    if (!user) return;
    const ids = conversations.map((c) => c.bookingId);
    if (!ids.length) return;
    const seq = archiveSeq.current;
    const [msgs, state] = await Promise.all([fetchLastMessages(ids), fetchConversationState(user.id, ids)]);
    if (seq !== archiveSeq.current) return; // a toggle happened mid-fetch — drop this stale snapshot
    const map: Record<string, { text: string; unread: boolean; at: string; archived: boolean }> = {};
    ids.forEach((id) => {
      const m = msgs[id];
      map[id] = { text: previewText(m), unread: !state[id]?.archived && isUnread(m, state[id], user.id), at: m?.created_at || "", archived: !!state[id]?.archived };
    });
    setLast(map);
  }, [conversations, user]);

  useEffect(() => {
    loadPreviews();
  }, [loadPreviews]);

  // Deep-link: /messages?booking=<id> opens that conversation directly (e.g. the
  // "Message" button on a booking). Runs once, when the matching conversation loads.
  const openedDeepLink = useRef(false);
  useEffect(() => {
    if (openedDeepLink.current || !user) return;
    const bId = new URLSearchParams(window.location.search).get("booking");
    if (!bId) return;
    const c = conversations.find((conv) => conv.bookingId === bId);
    if (!c) return;
    openedDeepLink.current = true;
    setActive(c);
    markConversationRead(user.id, bId).then(() => {
      loadPreviews();
      refreshUnread();
    });
  }, [conversations, user, loadPreviews, refreshUnread]);

  if (!user) return <FullPageSpinner />;

  const toggleArchive = async (c: Conversation) => {
    const next = !last[c.bookingId]?.archived;
    archiveSeq.current++; // invalidate any in-flight loadPreviews so it can't revert this
    setLast((prev) => ({
      ...prev,
      [c.bookingId]: { ...(prev[c.bookingId] || { text: "", unread: false, at: "" }), archived: next },
    }));
    try {
      await setConversationArchived(user.id, c.bookingId, next);
      refreshUnread();
    } catch {
      loadPreviews();
    }
  };

  const shown = conversations.filter((c) => (tab === "archived" ? !!last[c.bookingId]?.archived : !last[c.bookingId]?.archived));
  const inboxCount = conversations.filter((c) => !last[c.bookingId]?.archived).length;
  const archivedCount = conversations.length - inboxCount;

  return (
    // The messenger is an app surface, not a reading column: it fills the shell
    // at full width and owns the viewport height as ONE flex column. The height
    // is the screen minus the tab-bar clearance AppShell's <main> reserves
    // (`pb-[4.5rem+safe-area]`, dropped at md) — the only place that offset is
    // named. Everything below sizes with flex-1/min-h-0, so no child re-derives
    // a viewport offset and drifts (the old panes subtracted 4rem on mobile,
    // double-counting main's padding, and 2rem on desktop, ignoring the header).
    //
    // The feed measure is on THIS wrapper rather than on the panes individually:
    // PageHeader caps its own inner box at the same 1760px, so without a matching
    // cap the panes kept growing past the title on an ultra-wide monitor (at 2560px
    // the header started ~272px in while the first conversation card started at 16px).
    // A header and the content beneath it must share one box — see PageHeader WIDTHS.
    <div className={classNames("mx-auto flex h-[calc(100dvh-4.5rem-env(safe-area-inset-bottom))] w-full flex-col md:h-dvh", WIDTHS.feed)}>
      <div className={classNames("shrink-0", active && "hidden lg:block")}>
        <PageHeader
          title="Messages"
          subtitle="Your conversations"
          right={
            // In the header's flex row (not absolutely positioned over it), so it
            // inherits the on-surface ink color and stays tied to the title.
            <Link
              href="/people"
              aria-label="Find people"
              title="Find people"
              className="flex size-11 items-center justify-center rounded-full bg-white text-ink transition hover:text-primary"
            >
              <Search className="size-5" />
            </Link>
          }
        />
      </div>

      {conversations.length === 0 ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <EmptyState icon={<MessageCircle className="size-10" />} title="No conversations yet" body="Book or accept a gig to start chatting." />
        </div>
      ) : (
        // Two panes from lg only. At md the shell's icon rail is already showing,
        // so a 768–1023px window minus the rail minus a 320px list left the chat
        // ~190–400px wide — tablets stay single-pane instead.
        <div className="flex min-h-0 w-full flex-1">
          {/* Conversation list */}
          <div
            className={classNames(
              "flex min-h-0 w-full flex-col lg:w-80 lg:shrink-0 lg:border-r lg:border-line xl:w-96",
              active && "hidden lg:flex",
            )}
          >
            {/* Inbox / Archived segmented control — mobile's pill control. No
                shadow on the active pill, and the weight stays 600 in both
                states so a label can't re-measure and clip when selected.
                Same 44px box as Hiring's segmented control: 13px text plus
                `py-2.5` only measured ~39.5px, and the label needs its own
                `truncate` span once the button becomes a flex container. */}
            <div className="shrink-0 px-4 pb-2 pt-3 sm:px-6 lg:px-4">
              <div role="tablist" aria-label="Conversation folders" className="flex w-full rounded-full border border-line bg-white p-1">
                {([["inbox", inboxCount], ["archived", archivedCount]] as const).map(([t, n]) => (
                  <button
                    key={t}
                    role="tab"
                    aria-selected={tab === t}
                    onClick={() => setTab(t)}
                    className={classNames(
                      "flex min-h-11 flex-1 items-center justify-center rounded-full px-2 text-[13px] font-semibold capitalize transition",
                      tab === t ? "bg-primary text-white" : "text-ink-soft hover:text-ink",
                    )}
                  >
                    <span className="truncate">
                      {t}
                      {n > 0 ? ` (${n})` : ""}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            {shown.length === 0 ? (
              <div className="min-h-0 flex-1 overflow-y-auto">
                <EmptyState
                  icon={<MessageCircle className="size-10" />}
                  title={tab === "archived" ? "No archived chats" : "No messages yet"}
                  body={tab === "archived" ? "Archived conversations show up here." : "Everything is archived — check the Archived tab."}
                />
              </div>
            ) : (
              // The list scrolls inside the pane; the composer next door never
              // moves. Rows are floating cards (mobile's list), not hairline
              // dividers, so the same markup reads right in a 320px rail.
              <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 pb-4 sm:px-6 lg:px-4">
                {shown
                  .slice()
                  .sort((a, b) => (last[b.bookingId]?.at || "").localeCompare(last[a.bookingId]?.at || ""))
                  .map((c) => {
                    const unread = !!last[c.bookingId]?.unread;
                    return (
                      <li key={c.bookingId}>
                        <div className="flex w-full items-center gap-3 rounded-2xl bg-white px-4 py-3.5 shadow-[var(--shadow-card)] transition hover:shadow-[var(--shadow-soft)]">
                          {/* Avatar is its own link → the person's public profile. */}
                          {c.otherId ? (
                            <Link href={`/u/${c.otherId}`} aria-label={`View ${c.name}'s profile`} className="shrink-0 transition hover:opacity-85">
                              <Avatar url={c.avatarUrl} initial={c.avatarInitial} name={c.name} size={48} />
                            </Link>
                          ) : (
                            <Avatar url={c.avatarUrl} initial={c.avatarInitial} name={c.name} size={48} />
                          )}
                          <button
                            onClick={() => { setActive(c); markConversationRead(user.id, c.bookingId).then(() => { loadPreviews(); refreshUnread(); }); }}
                            className="min-w-0 flex-1 text-left"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className={classNames("truncate text-[15px] text-ink", unread ? "font-bold" : "font-semibold")}>{c.name}</span>
                              <span className="flex shrink-0 items-center gap-1.5">
                                {/* Unread marker: one 8px brand dot before the
                                    timestamp — the app's single unread pattern. */}
                                {unread && <span className="size-2 rounded-full bg-primary" />}
                                {last[c.bookingId]?.at && (
                                  <span className={classNames("text-[11px]", unread ? "font-semibold text-primary" : "text-ink-muted")}>
                                    {timeAgo(last[c.bookingId].at)}
                                  </span>
                                )}
                              </span>
                            </div>
                            <p className="mt-1 truncate text-xs text-ink-muted">{c.jobTitle}</p>
                            <p className={classNames("mt-1 truncate text-[13px]", unread ? "font-semibold text-ink" : "text-ink-soft")}>
                              {last[c.bookingId]?.text || "Say hi 👋"}
                            </p>
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); toggleArchive(c); }}
                            aria-label={tab === "inbox" ? "Archive conversation" : "Move to inbox"}
                            title={tab === "inbox" ? "Archive conversation" : "Move to inbox"}
                            // An explicit 44px box. Padding around a 16px glyph only
                            // reached 36px, and the negative margin pulls the LAYOUT
                            // back so the row keeps its height — it does not enlarge
                            // the hit area, which is why the box is sized outright.
                            className="-m-2 flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full text-ink-muted transition hover:text-ink"
                          >
                            {tab === "inbox" ? <Archive className="size-4" /> : <ArchiveRestore className="size-4" />}
                          </button>
                        </div>
                      </li>
                    );
                  })}
              </ul>
            )}
          </div>

          {/* Chat pane */}
          {active && <ChatPane conversation={active} userId={user.id} onBack={() => { setActive(null); loadPreviews(); }} />}
          {!active && (
            <div className="hidden min-w-0 flex-1 items-center justify-center bg-white text-[15px] text-ink-muted lg:flex">
              Select a conversation
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ChatPane({ conversation, userId, onBack }: { conversation: Conversation; userId: string; onBack: () => void }) {
  const { showToast } = useUser();
  const { blockUser, blockedIds } = useJobs();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  // Re-entry guard: setSending is async, so a double-Enter can pass the sending
  // check twice before a re-render. A ref flips synchronously and blocks the second.
  const sendingRef = useRef(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportReason, setReportReason] = useState(REPORT_REASONS[0]);
  const [reportDetails, setReportDetails] = useState("");
  const [reportBusy, setReportBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  // chat-photos is a private bucket — resolve each image message to a short-lived
  // signed URL (keyed by object path) rather than a permanent public URL.
  const [signedUrls, setSignedUrls] = useState<Record<string, string>>({});
  // Paths we've already tried to sign (success OR failure) — prevents a persistent
  // signing failure from re-triggering the effect forever (setSignedUrls returns a
  // new object each run, and signedUrls is a dep, so an uncached failure looped).
  const signAttempted = useRef<Set<string>>(new Set());

  useEffect(() => {
    let active = true;
    (async () => {
      const { data } = await supabase
        .from("messages")
        .select("id, booking_id, sender_id, text, image_url, created_at")
        .eq("booking_id", conversation.bookingId)
        .order("created_at", { ascending: true });
      if (active) setMessages((data as Msg[]) || []);
    })();

    const channel = supabase
      .channel(`messages-${conversation.bookingId}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages", filter: `booking_id=eq.${conversation.bookingId}` }, (payload) => {
        setMessages((prev) => (prev.some((m) => m.id === (payload.new as Msg).id) ? prev : [...prev, payload.new as Msg]));
      })
      .subscribe();

    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
  }, [conversation.bookingId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Sign any image messages we haven't signed yet (private bucket).
  useEffect(() => {
    let active = true;
    const missing = Array.from(new Set(messages
      .map((m) => chatObjectPath(m.image_url))
      .filter((p): p is string => !!p && !signedUrls[p] && !signAttempted.current.has(p))));
    if (!missing.length) return;
    // Mark attempted up-front so a null/failed sign result isn't retried every render.
    missing.forEach((p) => signAttempted.current.add(p));
    (async () => {
      const entries = await Promise.all(
        missing.map(async (p) => [p, await getSignedUrl("chat-photos", p)] as const),
      );
      if (!active) return;
      const resolved = entries.filter(([, url]) => !!url);
      if (!resolved.length) return; // nothing to commit → don't churn state (was the loop)
      setSignedUrls((prev) => {
        const next = { ...prev };
        for (const [p, url] of resolved) next[p] = url as string;
        return next;
      });
    })();
    return () => {
      active = false;
    };
  }, [messages, signedUrls]);

  // Ping the other party's phone + drop an in-app Alert (send-push persists a notification row).
  const pingOther = (preview: string) => {
    if (conversation.otherId) {
      notify(conversation.otherId, "New message", preview, { tab: "MessagesTab", type: "message" });
    }
  };

  const send = async () => {
    const body = text.trim();
    if (!body || sendingRef.current) return;
    // Same chat moderation as mobile — block off-platform-payment solicitation and
    // other prohibited content before it hits the DB (web previously bypassed this).
    const kwTerm = findProhibited(body);
    if (kwTerm) {
      logModerationBlock(kwTerm, "message", body, conversation.bookingId);
      showToast({ icon: "🚫", title: "Message blocked", message: "That message contains content that isn't allowed." });
      return;
    }
    // Guard BEFORE the async moderation await so the send button disables/spins and
    // a double-Enter can't send twice. finally resets on every path.
    sendingRef.current = true;
    setSending(true);
    try {
      // Context-aware check (harassment, threats, scams a keyword list misses).
      const mod = await moderateText(body, "message", conversation.bookingId);
      // A 429 here is self-inflicted (own quota), not an outage, so moderateText
      // fails CLOSED on it — otherwise burning the quota would disable this layer.
      if (mod.rateLimited) {
        showToast({ icon: "⏳", title: "Too many checks", message: "You've made a lot of checks in a row. Wait a minute and try again." });
        return;
      }
      if (!mod.allowed) {
        showToast({ icon: "🚫", title: "Message blocked", message: "That message contains content that isn't allowed." });
        return;
      }
      setText("");
      const { data, error } = await supabase
        .from("messages")
        .insert({ booking_id: conversation.bookingId, sender_id: userId, text: body })
        .select("id, booking_id, sender_id, text, image_url, created_at")
        .single();
      if (error || !data) {
        // Restore the text so the message isn't silently lost, and tell the user.
        setText(body);
        // If either side blocked the other, the party-scoped messages RLS rejects the
        // insert — surface that clearly instead of a generic "try again".
        if (conversation.otherId && blockedIds.has(conversation.otherId))
          showToast({ icon: "🚫", title: "Can't message", message: "You've blocked this person. Unblock them to message again." });
        else showToast({ icon: "⚠️", title: "Message not sent", message: "Please try again." });
        return;
      }
      setMessages((prev) => (prev.some((m) => m.id === data.id) ? prev : [...prev, data as Msg]));
      pingOther(body);
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  const sendImage = async (file: File) => {
    setSending(true);
    try {
      const path = await uploadPrivateToBucket(file, "chat-photos", userId);
      const { data, error } = await supabase
        .from("messages")
        .insert({ booking_id: conversation.bookingId, sender_id: userId, image_url: path })
        .select("id, booking_id, sender_id, text, image_url, created_at")
        .single();
      if (error || !data) throw error || new Error("insert failed");
      setMessages((prev) => (prev.some((m) => m.id === data.id) ? prev : [...prev, data as Msg]));
      pingOther("📷 Photo");
    } catch {
      showToast({ icon: "⚠️", title: "Couldn't send image", message: "The photo didn't send. Please try again." });
    }
    setSending(false);
  };

  const doReport = async () => {
    setReportBusy(true);
    try {
      await submitReport({ reporterId: userId, reportedUserId: conversation.otherId, bookingId: conversation.bookingId, reason: reportReason, details: reportDetails || null });
      showToast({ icon: "🚩", title: "Report submitted", message: "Thanks — our team will review it." });
    } catch {
      showToast({ icon: "⚠️", title: "Couldn't submit", message: "Please try again." });
    }
    setReportBusy(false);
    setReportOpen(false);
    setReportDetails("");
  };

  const doBlock = async () => {
    setMenuOpen(false);
    if (!conversation.otherId) return;
    try {
      // Use the context blockUser so blockedIds updates and this conversation drops
      // out of the hub list immediately (H2), then close the pane.
      await blockUser(conversation.otherId);
      showToast({ icon: "🚫", title: `${conversation.name} blocked`, message: "You won't see their gigs anymore." });
      onBack();
    } catch {
      showToast({ icon: "⚠️", title: "Couldn't block", message: "Please try again." });
    }
  };

  return (
    // No height math: the pane fills whatever the page's flex column gives it,
    // and min-h-0 lets the message list (not the document) do the scrolling.
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col bg-white">
      <div className="relative flex shrink-0 items-center gap-3 border-b border-divider px-4 py-3">
        {/* Explicit 44px boxes on both header icon buttons — padding around the
            glyph left them at 36/40px, and the negative margin only pulls the
            layout in, it does not grow the target. */}
        <button onClick={onBack} aria-label="Back to conversations" className="-m-3 flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full text-ink-soft transition hover:text-ink lg:hidden">
          <ArrowLeft className="size-5" />
        </button>
        {/* Person → their public profile; job line → the listing (works for past
            gigs via the job page's direct-fetch fallback). */}
        {conversation.otherId ? (
          <Link href={`/u/${conversation.otherId}`} aria-label={`View ${conversation.name}'s profile`} className="shrink-0 transition hover:opacity-85">
            <Avatar url={conversation.avatarUrl} initial={conversation.avatarInitial} name={conversation.name} size={36} />
          </Link>
        ) : (
          <Avatar url={conversation.avatarUrl} initial={conversation.avatarInitial} name={conversation.name} size={36} />
        )}
        <div className="min-w-0 flex-1">
          {conversation.otherId ? (
            <Link href={`/u/${conversation.otherId}`} className="block truncate text-[15px] font-bold text-ink hover:text-primary">
              {conversation.name}
            </Link>
          ) : (
            <p className="truncate text-[15px] font-bold text-ink">{conversation.name}</p>
          )}
          {conversation.jobId ? (
            <Link href={`/jobs/${conversation.jobId}`} className="block truncate text-xs font-semibold text-primary hover:underline">
              re: {conversation.jobTitle}
            </Link>
          ) : (
            <p className="truncate text-xs text-ink-muted">{conversation.jobTitle}</p>
          )}
        </div>
        <button onClick={() => setMenuOpen((o) => !o)} className="-m-1.5 flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full text-ink-muted transition hover:text-ink" aria-label="Conversation options">
          <MoreVertical className="size-5" />
        </button>
        {menuOpen && (
          // top-full so the menu follows the header's real height instead of a
          // magic 52px, and one elevation (neutral shadow, no ring).
          // `rounded-2xl` (20px): a floating menu is a PANEL, not a control — same
          // step as the profile page's report/block menu and LocationPicker.
          <div className="absolute right-3 top-full z-20 mt-1 w-44 overflow-hidden rounded-2xl bg-white shadow-[var(--shadow-soft)]">
            <button onClick={() => { setMenuOpen(false); setReportOpen(true); }} className="flex w-full items-center gap-2 px-3.5 py-2.5 text-sm font-semibold text-ink hover:bg-canvas">
              <Flag className="size-4 shrink-0" /> Report
            </button>
            <button onClick={doBlock} className="flex w-full items-center gap-2 px-3.5 py-2.5 text-sm font-semibold text-urgent hover:bg-canvas">
              <Ban className="size-4 shrink-0" /> Block
            </button>
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-4" onClick={() => menuOpen && setMenuOpen(false)}>
        {messages.map((m, i) => {
          const mine = m.sender_id === userId;
          const imgPath = chatObjectPath(m.image_url);
          const imgSrc = imgPath ? signedUrls[imgPath] : null;
          return (
            <div key={m.id || i} className={classNames("flex", mine ? "justify-end" : "justify-start")}>
              {/* Measured in characters, not a percentage: a percentage of a
                  wide desktop pane produces unreadable 200-character lines,
                  while 70ch stays a comfortable measure at any pane width. */}
              <div
                className={classNames(
                  "max-w-[70ch] break-words rounded-2xl px-3.5 py-2 text-sm leading-5",
                  mine ? "rounded-br-lg bg-primary text-white" : "rounded-bl-lg bg-canvas text-ink",
                )}
              >
                {imgPath && (
                  imgSrc ? (
                    // max-w-full keeps a wide photo inside the bubble instead of
                    // stretching it past the pane on a narrow screen.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={imgSrc} alt="" className="mb-1 max-h-48 max-w-full rounded-xl bg-divider" />
                  ) : (
                    <div className="mb-1 flex h-24 w-32 items-center justify-center rounded-xl bg-divider text-ink-muted">
                      <Loader2 className="size-4 animate-spin" />
                    </div>
                  )
                )}
                {m.text}
              </div>
            </div>
          );
        })}
        <div ref={endRef} />
      </div>

      <div className="flex shrink-0 items-center gap-2 border-t border-divider p-3">
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) sendImage(f);
            e.target.value = "";
          }}
        />
        {/* Transparent attach control with a brand glyph, like mobile — this is
            also what retires the off-token hardcoded hover fill that used to be
            baked in here. */}
        <button
          onClick={() => fileRef.current?.click()}
          disabled={sending}
          className="flex size-11 shrink-0 items-center justify-center rounded-full text-primary transition-all hover:bg-primary-light active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50"
          aria-label="Send a photo"
        >
          <ImagePlus className="size-5" />
        </button>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && (e.preventDefault(), send())}
          placeholder="Type a message…"
          // bg-canvas: the field sits on the white chat pane, so it has to be the
          // sunken tone to read as a field. 16px at the small end (iOS zoom).
          className="min-w-0 flex-1 rounded-full border border-line bg-canvas px-4 py-2.5 text-base text-ink outline-none transition placeholder:text-ink-muted focus:border-primary focus:ring-2 focus:ring-primary/15 sm:text-[15px]"
        />
        <button
          onClick={send}
          disabled={sending || !text.trim()}
          className="flex size-11 shrink-0 items-center justify-center rounded-full bg-primary text-white transition-all hover:bg-primary-dark active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50"
          aria-label="Send message"
        >
          {sending ? <Loader2 className="size-5 animate-spin" /> : <Send className="size-5" />}
        </button>
      </div>

      <Modal
        open={reportOpen}
        onClose={() => setReportOpen(false)}
        title={`Report ${conversation.name}`}
        size="sm"
        footer={<Button fullWidth loading={reportBusy} onClick={doReport}>Submit report</Button>}
      >
        <div className="space-y-2">
          {REPORT_REASONS.map((r) => (
            <button
              key={r}
              onClick={() => setReportReason(r)}
              className={classNames(
                "flex w-full items-center justify-between rounded-xl border px-3.5 py-2.5 text-sm font-semibold transition",
                reportReason === r ? "border-primary bg-primary-light/50 text-primary" : "border-line text-ink-soft hover:border-ink-muted",
              )}
            >
              {r}
              {reportReason === r && <Check className="size-4" />}
            </button>
          ))}
          <Textarea
            value={reportDetails}
            onChange={(e) => setReportDetails(e.target.value)}
            placeholder="Add details (optional)"
            className="min-h-[72px]"
          />
        </div>
      </Modal>
    </div>
  );
}
