"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { MessageCircle, Send, ArrowLeft } from "lucide-react";
import { useJobs } from "@/lib/jobs";
import { useAuth } from "@/lib/auth";
import { supabase } from "@/lib/supabaseClient";
import { fetchLastMessages, fetchConversationState, isUnread, previewText, markConversationRead } from "@/lib/messages";
import PageHeader, { EmptyState } from "@/components/PageHeader";
import Avatar from "@/components/ui/Avatar";
import { FullPageSpinner } from "@/components/ui/Spinner";
import { classNames, timeAgo } from "@/lib/format";

interface Conversation {
  bookingId: string;
  name: string;
  avatarUrl: string | null;
  avatarInitial: string | null;
  jobTitle: string;
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
  const { bookings, posterBookings, jobs, refreshUnread } = useJobs();

  // Build the conversation list from both sides of the user's bookings.
  const conversations = useMemo<Conversation[]>(() => {
    const list: Conversation[] = [];
    bookings.forEach((b) => {
      const job = jobs.find((j) => j.id === b.jobId);
      list.push({
        bookingId: b.id,
        name: job?.poster.name || b.job?.title || "Poster",
        avatarUrl: job?.poster.avatarUrl || null,
        avatarInitial: job?.poster.avatarInitial || "P",
        jobTitle: b.job?.title || job?.title || "Gig",
      });
    });
    posterBookings.forEach((b) => {
      list.push({
        bookingId: b.id,
        name: b.earner?.name || "Earner",
        avatarUrl: b.earner?.avatarUrl || null,
        avatarInitial: b.earner?.avatarInitial || "E",
        jobTitle: b.job?.title || "Gig",
      });
    });
    // De-dupe by bookingId (a booking belongs to one conversation).
    const seen = new Set<string>();
    return list.filter((c) => (seen.has(c.bookingId) ? false : (seen.add(c.bookingId), true)));
  }, [bookings, posterBookings, jobs]);

  const [last, setLast] = useState<Record<string, { text: string; unread: boolean; at: string }>>({});
  const [active, setActive] = useState<Conversation | null>(null);

  const loadPreviews = useCallback(async () => {
    if (!user) return;
    const ids = conversations.map((c) => c.bookingId);
    if (!ids.length) return;
    const [msgs, state] = await Promise.all([fetchLastMessages(ids), fetchConversationState(user.id, ids)]);
    const map: Record<string, { text: string; unread: boolean; at: string }> = {};
    ids.forEach((id) => {
      const m = msgs[id];
      map[id] = { text: previewText(m), unread: !state[id]?.archived && isUnread(m, state[id], user.id), at: m?.created_at || "" };
    });
    setLast(map);
  }, [conversations, user]);

  useEffect(() => {
    loadPreviews();
  }, [loadPreviews]);

  if (!user) return <FullPageSpinner />;

  return (
    <div>
      <div className={active ? "hidden md:block" : ""}>
        <PageHeader title="Messages" subtitle="Your conversations" />
      </div>
      <div className="mx-auto flex w-full max-w-3xl">
        {/* Conversation list */}
        <div className={classNames("w-full md:w-80 md:border-r md:border-line", active && "hidden md:block")}>
          {conversations.length === 0 ? (
            <EmptyState icon={<MessageCircle className="size-10" />} title="No conversations yet" body="Book or accept a gig to start chatting." />
          ) : (
            <ul>
              {conversations
                .slice()
                .sort((a, b) => (last[b.bookingId]?.at || "").localeCompare(last[a.bookingId]?.at || ""))
                .map((c) => (
                  <li key={c.bookingId}>
                    <button
                      onClick={() => { setActive(c); markConversationRead(user.id, c.bookingId).then(() => { loadPreviews(); refreshUnread(); }); }}
                      className="flex w-full items-center gap-3 border-b border-divider px-4 py-3 text-left hover:bg-primary-light/40"
                    >
                      <Avatar url={c.avatarUrl} initial={c.avatarInitial} name={c.name} size={44} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate font-bold text-ink">{c.name}</span>
                          {last[c.bookingId]?.at && <span className="shrink-0 text-[11px] text-ink-muted">{timeAgo(last[c.bookingId].at)}</span>}
                        </div>
                        <p className="truncate text-xs text-ink-muted">{c.jobTitle}</p>
                        <p className={classNames("truncate text-sm", last[c.bookingId]?.unread ? "font-bold text-ink" : "text-ink-soft")}>
                          {last[c.bookingId]?.text || "Say hi 👋"}
                        </p>
                      </div>
                      {last[c.bookingId]?.unread && <span className="size-2.5 shrink-0 rounded-full bg-urgent" />}
                    </button>
                  </li>
                ))}
            </ul>
          )}
        </div>

        {/* Chat pane */}
        {active && <ChatPane conversation={active} userId={user.id} onBack={() => { setActive(null); loadPreviews(); }} />}
        {!active && conversations.length > 0 && (
          <div className="hidden flex-1 items-center justify-center text-ink-muted md:flex">Select a conversation</div>
        )}
      </div>
    </div>
  );
}

function ChatPane({ conversation, userId, onBack }: { conversation: Conversation; userId: string; onBack: () => void }) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

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

  const send = async () => {
    const body = text.trim();
    if (!body) return;
    setSending(true);
    setText("");
    const { data } = await supabase
      .from("messages")
      .insert({ booking_id: conversation.bookingId, sender_id: userId, text: body })
      .select("id, booking_id, sender_id, text, image_url, created_at")
      .single();
    if (data) setMessages((prev) => (prev.some((m) => m.id === data.id) ? prev : [...prev, data as Msg]));
    setSending(false);
  };

  return (
    <div className="flex h-[calc(100vh-4rem)] w-full flex-col md:h-[calc(100vh-2rem)] md:flex-1">
      <div className="flex items-center gap-3 border-b border-line px-4 py-3">
        <button onClick={onBack} className="md:hidden">
          <ArrowLeft className="size-5 text-ink-soft" />
        </button>
        <Avatar url={conversation.avatarUrl} initial={conversation.avatarInitial} name={conversation.name} size={36} />
        <div>
          <p className="font-bold text-ink">{conversation.name}</p>
          <p className="text-xs text-ink-muted">{conversation.jobTitle}</p>
        </div>
      </div>

      <div className="flex-1 space-y-2 overflow-y-auto bg-canvas px-4 py-4">
        {messages.map((m, i) => {
          const mine = m.sender_id === userId;
          return (
            <div key={m.id || i} className={classNames("flex", mine ? "justify-end" : "justify-start")}>
              <div className={classNames("max-w-[75%] rounded-2xl px-3.5 py-2 text-sm", mine ? "bg-primary text-white" : "bg-white text-ink ring-1 ring-line")}>
                {m.image_url && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={m.image_url} alt="" className="mb-1 max-h-48 rounded-xl" />
                )}
                {m.text}
              </div>
            </div>
          );
        })}
        <div ref={endRef} />
      </div>

      <div className="flex items-center gap-2 border-t border-line p-3">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && (e.preventDefault(), send())}
          placeholder="Type a message…"
          className="flex-1 rounded-full border border-line bg-white px-4 py-2.5 text-[15px] outline-none focus:border-primary"
        />
        <button onClick={send} disabled={sending || !text.trim()} className="flex size-11 items-center justify-center rounded-full bg-primary text-white disabled:opacity-50">
          <Send className="size-5" />
        </button>
      </div>
    </div>
  );
}
