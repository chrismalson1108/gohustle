"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Support — the two-way ticket thread, on the web.
//
// Signed-in web had a `mailto:` here. Mobile deleted its three because "NO beta
// tester's request would ever have entered the ticket system: it would land in a
// personal inbox, unassignable, un-triageable, with no status and no record that it
// was answered." The web kept exactly that failure, and the one form that does reach
// support-submit (/contact) is linked from the marketing footer and from nowhere a
// signed-in user goes.
//
// The email leg cannot close the loop on its own. support-reply sends with
// reply_to = mainmail@ and invites a reply; nothing in this repo ingests inbound
// mail. So a reply landed in a mailbox, `last_author` never flipped, the reopen rule
// never fired, the console queue and ctl_support_ticket_unanswered stayed blind, and
// an agent's attachment was a signed URL into the private support-photos bucket
// inside an app the web user had never installed.
//
// ONE implementation, as on mobile: threads are per topic (forced by the schema —
// `priority` and `booking_id` are per-ticket and safety is urgent by definition), the
// switcher is the title, and the pure rules for which thread to show come from
// shared/support.js so both clients agree.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Archive, Camera, Check, LifeBuoy, Plus, Send, X } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useUser } from "@/lib/user";
import {
  SUPPORT_CATEGORIES,
  fetchMyTickets,
  fetchTicketMessages,
  groupTickets,
  markTicketRead,
  pickActiveTicket,
  replyToTicket,
  resolveTicket,
  setTicketArchived,
  submitSupportRequest,
  ticketHasUnread,
  type SupportMessage,
  type SupportTicket,
} from "@/lib/support";
import { uploadPrivateImages } from "@/lib/uploadImage";
import PageHeader, { PageContainer, EmptyState } from "@/components/PageHeader";
import SignedPhotoStrip from "@/components/SignedPhotoStrip";
import Modal from "@/components/ui/Modal";
import Button from "@/components/ui/Button";
import { Input, Textarea, Label, Select } from "@/components/ui/Field";
import { FullPageSpinner } from "@/components/ui/Spinner";
import { classNames } from "@/lib/format";

const when = (v?: string | null) =>
  v
    ? new Date(v).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "";

const titleOf = (t: SupportTicket | null) => t?.subject?.trim() || "Support";

export default function SupportPage() {
  const { user } = useAuth();
  const { showToast } = useUser();
  const userId = user?.id;

  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<SupportMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showThreads, setShowThreads] = useState(false);

  const fileRef = useRef<HTMLInputElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    if (!userId) return;
    setError(null);
    try {
      const rows = await fetchMyTickets();
      setTickets(rows);
      // Unread WINS over status — an agent's note on a resolved thread deliberately
      // leaves it closed, and a status-only rule would open a different one.
      setActiveId((cur) => cur ?? pickActiveTicket(rows)?.id ?? null);
    } catch (e) {
      setError((e as Error).message || "Could not load your support messages.");
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    load();
  }, [load]);

  const active = useMemo(() => tickets.find((t) => t.id === activeId) ?? null, [tickets, activeId]);
  const groups = useMemo(() => groupTickets(tickets, activeId), [tickets, activeId]);

  useEffect(() => {
    // No active thread means the empty state is rendering and nothing reads
    // `messages`, so there is nothing to clear.
    if (!activeId) return;
    let alive = true;
    fetchTicketMessages(activeId)
      .then((m) => {
        if (alive) setMessages(m);
      })
      .catch(() => {
        if (alive) setMessages([]);
      });
    // Opening the thread is what marks it read; a badge that clears on load without
    // the person seeing anything is a lie. The local row moves only AFTER the write
    // lands, so a failed update leaves the dot on rather than hiding an unread reply.
    markTicketRead(activeId)
      .then(() => {
        if (alive) {
          setTickets((cur) =>
            cur.map((t) => (t.id === activeId ? { ...t, user_read_at: new Date().toISOString() } : t)),
          );
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [activeId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  const send = async () => {
    if (!activeId || !userId) return;
    if (!draft.trim() && pending.length === 0) return;
    setSending(true);
    try {
      const paths = pending.length ? await uploadPrivateImages(pending, "support-photos", userId) : [];
      await replyToTicket(activeId, { body: draft, images: paths });
      setDraft("");
      setPending([]);
      setMessages(await fetchTicketMessages(activeId));
      // A reply REOPENS a closed thread and un-archives it, server-side. Reflect it
      // here rather than leaving the row saying "closed" beside the message.
      setTickets((cur) =>
        cur.map((t) => (t.id === activeId ? { ...t, status: "open", archived_at: null } : t)),
      );
    } catch (e) {
      showToast({ icon: "⚠️", title: "Couldn't send", message: (e as Error).message || "Please try again." });
    } finally {
      setSending(false);
    }
  };

  const archive = async (archived: boolean) => {
    if (!activeId) return;
    try {
      await setTicketArchived(activeId, archived);
      setTickets((cur) =>
        cur.map((t) => (t.id === activeId ? { ...t, archived_at: archived ? new Date().toISOString() : null } : t)),
      );
      showToast({
        icon: "🗂️",
        title: archived ? "Archived" : "Moved to inbox",
        message: archived ? "You can still reply to reopen it." : "It's back in your inbox.",
      });
    } catch (e) {
      showToast({ icon: "⚠️", title: "Couldn't update", message: (e as Error).message || "Please try again." });
    }
  };

  const close = async () => {
    if (!activeId) return;
    try {
      await resolveTicket(activeId);
      setTickets((cur) => cur.map((t) => (t.id === activeId ? { ...t, status: "closed" } : t)));
      showToast({ icon: "✅", title: "Marked as resolved", message: "Reply any time to reopen it." });
    } catch (e) {
      showToast({ icon: "⚠️", title: "Couldn't close", message: (e as Error).message || "Please try again." });
    }
  };

  if (loading) return <FullPageSpinner />;

  return (
    <div>
      <PageHeader
        title="Support"
        subtitle="Real people answer — usually within a day"
        width="form"
        back="/profile"
        right={
          <Button variant="outline" onClick={() => setShowNew(true)}>
            <Plus className="size-4" /> New request
          </Button>
        }
      />

      <PageContainer width="form" className="space-y-4 pb-10">
        {error && (
          <div className="rounded-2xl bg-urgent-light p-4">
            <p className="text-sm font-bold text-urgent">Couldn&apos;t load your messages</p>
            <p className="mt-1 text-xs leading-relaxed text-ink-soft">{error}</p>
          </div>
        )}

        {tickets.length === 0 ? (
          <EmptyState
            icon={<LifeBuoy className="size-8" />}
            title="No conversations yet"
            body="Ask us anything — a payment that hasn't arrived, a gig that went wrong, or something that looks broken. You'll get the answer right here, not in your inbox."
          />
        ) : (
          <>
            {/* The thread switcher IS the title, as on mobile — threads are per topic
                and a person can legitimately have several open. */}
            <div className="rounded-2xl bg-white p-4 shadow-[var(--shadow-card)]">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <button
                    type="button"
                    onClick={() => setShowThreads(true)}
                    className="text-left text-base font-bold tracking-[-0.2px] text-ink hover:underline"
                  >
                    {titleOf(active)}
                  </button>
                  <p className="mt-0.5 text-xs text-ink-muted">
                    {active?.status === "closed" ? "Resolved" : "Open"}
                    {active?.category ? ` · ${active.category}` : ""}
                    {tickets.length > 1 ? ` · ${tickets.length} conversations` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1">
                  {active?.status !== "closed" && (
                    <button
                      type="button"
                      onClick={close}
                      title="Mark resolved"
                      className="rounded-lg p-2 text-ink-muted hover:bg-canvas hover:text-ink"
                    >
                      <Check className="size-4" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => archive(!active?.archived_at)}
                    title={active?.archived_at ? "Move to inbox" : "Archive"}
                    className="rounded-lg p-2 text-ink-muted hover:bg-canvas hover:text-ink"
                  >
                    <Archive className="size-4" />
                  </button>
                </div>
              </div>

              <div className="mt-4 space-y-3">
                {messages.length === 0 ? (
                  <p className="py-6 text-center text-sm text-ink-muted">No messages in this conversation yet.</p>
                ) : (
                  messages.map((m) => {
                    const mine = m.author === "user";
                    return (
                      <div
                        key={m.id}
                        className={classNames(
                          "max-w-[85%] rounded-2xl px-3.5 py-2.5",
                          mine ? "ml-auto bg-primary text-white" : "mr-auto bg-canvas text-ink",
                        )}
                      >
                        {!mine && (
                          <p className="mb-1 text-[11px] font-bold uppercase tracking-wide text-primary">
                            GoHustlr Support
                          </p>
                        )}
                        {m.body && <p className="whitespace-pre-wrap text-sm leading-relaxed">{m.body}</p>}
                        {m.images && m.images.length > 0 && (
                          // support-photos is PRIVATE — signed URLs, never getPublicUrl.
                          <div className="mt-2">
                            <SignedPhotoStrip values={m.images} bucket="support-photos" />
                          </div>
                        )}
                        <p
                          className={classNames(
                            "mt-1 text-[11px]",
                            mine ? "text-white/70" : "text-ink-muted",
                          )}
                        >
                          {when(m.created_at)}
                        </p>
                      </div>
                    );
                  })
                )}
                <div ref={bottomRef} />
              </div>

              {/* Replying REOPENS a resolved thread. Say so rather than hiding the
                  composer, which is what pushes people back to email. */}
              {active?.status === "closed" && (
                <p className="mt-3 rounded-xl bg-canvas px-3 py-2 text-xs text-ink-soft">
                  This conversation is marked resolved. Replying reopens it with its history intact.
                </p>
              )}

              {pending.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {pending.map((f, i) => (
                    <span
                      key={`${f.name}-${i}`}
                      className="inline-flex items-center gap-1.5 rounded-full bg-canvas px-3 py-1.5 text-xs text-ink-soft"
                    >
                      {f.name.slice(0, 24)}
                      <button
                        type="button"
                        onClick={() => setPending((cur) => cur.filter((_, j) => j !== i))}
                        aria-label="Remove attachment"
                      >
                        <X className="size-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}

              <div className="mt-3 flex items-end gap-2">
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  multiple
                  hidden
                  onChange={(e) => {
                    setPending((cur) => [...cur, ...Array.from(e.target.files ?? [])].slice(0, 6));
                    e.target.value = "";
                  }}
                />
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  title="Attach a photo"
                  className="rounded-lg p-2.5 text-ink-muted hover:bg-canvas hover:text-ink"
                >
                  <Camera className="size-5" />
                </button>
                <Textarea
                  rows={2}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="Write a message"
                  className="flex-1"
                />
                <Button loading={sending} onClick={send} disabled={!draft.trim() && pending.length === 0}>
                  <Send className="size-4" />
                </Button>
              </div>
            </div>
          </>
        )}
      </PageContainer>

      <NewRequestModal
        open={showNew}
        onClose={() => setShowNew(false)}
        userId={userId}
        onFiled={async (id) => {
          setShowNew(false);
          await load();
          setActiveId(id);
          showToast({
            icon: "✅",
            title: "Message sent",
            message: "We'll reply right here — you'll see it in Support.",
          });
        }}
      />

      <Modal open={showThreads} onClose={() => setShowThreads(false)} title="Your conversations" size="sm">
        <ThreadList
          label="Open"
          tickets={active ? [active, ...groups.live] : groups.live}
          activeId={activeId}
          onPick={(id) => {
            setActiveId(id);
            setShowThreads(false);
          }}
        />
        <ThreadList
          label="Resolved & archived"
          tickets={groups.archived}
          activeId={activeId}
          onPick={(id) => {
            setActiveId(id);
            setShowThreads(false);
          }}
        />
      </Modal>
    </div>
  );
}

function ThreadList({
  label,
  tickets,
  activeId,
  onPick,
}: {
  label: string;
  tickets: SupportTicket[];
  activeId: string | null;
  onPick: (id: string) => void;
}) {
  if (!tickets.length) return null;
  return (
    <div className="mb-4 last:mb-0">
      <p className="mb-1 text-xs font-bold uppercase tracking-wide text-ink-muted">{label}</p>
      <ul className="divide-y divide-line">
        {tickets.map((t) => (
          <li key={t.id}>
            <button
              type="button"
              onClick={() => onPick(t.id)}
              className={classNames(
                "flex w-full items-center gap-2 py-2.5 text-left",
                t.id === activeId && "font-bold",
              )}
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-ink">{t.subject?.trim() || "Support"}</p>
                <p className="text-xs text-ink-muted">{when(t.last_message_at ?? t.created_at)}</p>
              </div>
              {ticketHasUnread(t) && <span aria-label="unread" className="size-2 shrink-0 rounded-full bg-primary" />}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function NewRequestModal({
  open,
  onClose,
  userId,
  onFiled,
}: {
  open: boolean;
  onClose: () => void;
  userId?: string;
  onFiled: (id: string | null) => void | Promise<void>;
}) {
  const [subject, setSubject] = useState("");
  const [category, setCategory] = useState(SUPPORT_CATEGORIES[0].key);
  const [message, setMessage] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setErr(null);
    setBusy(true);
    try {
      const paths = files.length && userId ? await uploadPrivateImages(files, "support-photos", userId) : [];
      const id = await submitSupportRequest({ subject, category, message, images: paths });
      setSubject("");
      setMessage("");
      setFiles([]);
      await onFiled(id);
    } catch (e) {
      setErr((e as Error).message || "Could not send your message.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New support request"
      size="sm"
      footer={
        <div className="flex gap-2">
          <Button variant="outline" fullWidth onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button fullWidth loading={busy} onClick={submit} disabled={!message.trim()}>
            Send
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        {/* One topic per thread, because the schema forces it: priority and booking_id
            are per-ticket, and a safety report must not share a thread with a
            routine question. */}
        <div>
          <Label>What is it about?</Label>
          <Select value={category} onChange={(e) => setCategory(e.target.value)}>
            {SUPPORT_CATEGORIES.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label>Subject</Label>
          <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Short summary" />
        </div>
        <div>
          <Label>What happened?</Label>
          <Textarea
            rows={5}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Tell us what's going on. Include anything that helps — a gig name, an amount, a date."
          />
        </div>
        <div>
          <input
            id="support-new-files"
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              setFiles((cur) => [...cur, ...Array.from(e.target.files ?? [])].slice(0, 6));
              e.target.value = "";
            }}
          />
          <label
            htmlFor="support-new-files"
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-canvas px-3 py-1.5 text-xs font-semibold text-ink-soft hover:bg-line"
          >
            <Camera className="size-3.5" /> Add a photo
          </label>
          {files.length > 0 && <span className="ml-2 text-xs text-ink-muted">{files.length} attached</span>}
        </div>
        {err && <p className="text-sm font-semibold text-urgent">{err}</p>}
      </div>
    </Modal>
  );
}
