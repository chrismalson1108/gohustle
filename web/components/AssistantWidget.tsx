"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Sparkles, Send, Mic, MicOff, X, Loader2, History, Plus, Trash2, ArrowLeft } from "lucide-react";
import { askAssistant, type AssistantMsg, type AssistantAction } from "@/lib/assistant";
import { listThreads, loadThread, deleteThread, type ThreadRow } from "@/lib/assistantThreads";
import { useJobs } from "@/lib/jobs";
import { useUser } from "@/lib/user";
import { classNames } from "@/lib/format";

const GREETING =
  "Hey! I'm Hustlr AI 👋 I can find gigs for you, post a gig (just describe it — even by voice), book work, and check how you're doing. What do you need?";

const SUGGESTIONS = [
  "Find me a gig this weekend",
  "Post a gig for me",
  "Recommend gigs for my skills",
  "How am I doing?",
];

// Minimal Web Speech API typing (not in lib.dom for all targets).
type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
};

export default function AssistantWidget() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<AssistantMsg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [view, setView] = useState<"chat" | "history">("chat");
  const [threads, setThreads] = useState<ThreadRow[]>([]);
  const [loadingThreads, setLoadingThreads] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const baseInputRef = useRef("");

  const { refreshJobs, refreshBookings, refreshPosterBookings } = useJobs();
  const { refreshProfile, showToast } = useUser();

  // Speech support detection (client only).
  const [voiceSupported, setVoiceSupported] = useState(false);
  useEffect(() => {
    const w = window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
    setVoiceSupported(Boolean(w.SpeechRecognition || w.webkitSpeechRecognition));
  }, []);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, busy, open]);

  // Greet a fresh chat only — not when a reopened thread loads empty or errors.
  useEffect(() => {
    if (open && messages.length === 0 && threadId === null) {
      setMessages([{ role: "assistant", content: GREETING }]);
    }
  }, [open, messages.length, threadId]);

  const runActions = (actions: AssistantAction[]) => {
    if (!actions.length) return;
    const kinds = new Set(actions.map((a) => a.type));
    if (kinds.has("gig_created")) {
      refreshJobs();
      refreshPosterBookings();
      showToast({ icon: "📣", title: "Gig posted!", message: "Hustlr AI created your gig." });
    }
    if (kinds.has("gig_booked")) {
      refreshJobs();
      refreshBookings();
      showToast({ icon: "✅", title: "Booked!", message: "Hustlr AI sent your request." });
    }
    if (kinds.has("profile_updated")) refreshProfile();
  };

  const send = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    stopListening();
    setError(null);
    setInput("");
    const next: AssistantMsg[] = [...messages, { role: "user", content: trimmed }];
    setMessages(next);
    setBusy(true);
    try {
      // The synthetic greeting bubble is render-only — don't feed it to the model.
      const payload = next[0]?.role === "assistant" && next[0].content === GREETING ? next.slice(1) : next;
      const res = await askAssistant(payload, { threadId, newThread: !threadId });
      setMessages([...next, { role: "assistant", content: res.reply }]);
      if (res.thread_id) setThreadId(res.thread_id);
      runActions(res.actions);
    } catch (err) {
      // Show one friendly error in the composer banner. Don't inject it as an
      // assistant bubble — that duplicated the message and (worse) got sent back
      // to the model as a real assistant turn on the next request.
      const raw = (err as Error).message || "";
      const friendly =
        raw && raw !== "Edge function error" && raw !== "Unauthorized" && !/fetch/i.test(raw)
          ? raw
          : "Hustlr AI is unavailable right now. Please try again in a moment.";
      setError(friendly);
    } finally {
      setBusy(false);
    }
  };

  // ── Voice ──
  const startListening = () => {
    const w = window as unknown as {
      SpeechRecognition?: new () => SpeechRecognitionLike;
      webkitSpeechRecognition?: new () => SpeechRecognitionLike;
    };
    const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!Ctor) return;
    const rec = new Ctor();
    rec.lang = "en-US";
    rec.interimResults = true;
    rec.continuous = false;
    baseInputRef.current = input ? input + " " : "";
    rec.onresult = (e) => {
      let transcript = "";
      for (let i = 0; i < e.results.length; i++) transcript += e.results[i][0].transcript;
      setInput(baseInputRef.current + transcript);
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recognitionRef.current = rec;
    setListening(true);
    rec.start();
  };

  const stopListening = () => {
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        /* noop */
      }
      recognitionRef.current = null;
    }
    setListening(false);
  };

  // Stop the mic if the component unmounts (e.g. sign-out) while listening.
  useEffect(() => () => stopListening(), []);

  // These switch conversation context, so they're blocked mid-send (and their
  // buttons disabled) — otherwise an in-flight reply could clobber the new view.
  const newChat = () => {
    if (busy) return;
    stopListening();
    setError(null);
    setThreadId(null);
    setMessages([{ role: "assistant", content: GREETING }]);
    setView("chat");
  };

  const openHistory = async () => {
    if (busy) return;
    setView("history");
    setLoadingThreads(true);
    try {
      setThreads(await listThreads());
    } catch {
      setThreads([]);
    }
    setLoadingThreads(false);
  };

  const pickThread = async (t: ThreadRow) => {
    if (busy) return;
    try {
      const msgs = await loadThread(t.id);
      setThreadId(t.id);
      setMessages(msgs.map((m) => ({ role: m.role, content: m.content })));
      setError(null);
      setView("chat");
    } catch {
      setError("Couldn't open that conversation — please try again.");
    }
  };

  const removeThread = async (id: string) => {
    if (busy) return;
    try {
      await deleteThread(id);
      setThreads((ts) => ts.filter((t) => t.id !== id));
      if (id === threadId) newChat();
    } catch {
      setError("Couldn't delete that conversation.");
    }
  };

  // Hide the assistant on the Messages route — its floating launcher overlaps the
  // chat composer's send button on mobile, and the assistant is redundant mid-chat.
  if (pathname === "/messages") return null;

  return (
    <>
      {/* Floating launcher — sits above the mobile tab bar and clears the safe area. */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          aria-label="Open Hustlr AI assistant"
          className="fixed bottom-[calc(5rem+env(safe-area-inset-bottom))] right-4 z-40 flex size-14 items-center justify-center rounded-full bg-primary text-white shadow-[var(--shadow-card)] ring-4 ring-primary/20 transition hover:scale-105 md:bottom-6 md:right-6"
        >
          <Sparkles className="size-6" />
        </button>
      )}

      {/* Chat panel */}
      {open && (
        <div className="fixed inset-x-0 bottom-0 z-50 flex h-[80vh] flex-col overflow-hidden rounded-t-3xl bg-white shadow-[var(--shadow-pop)] ring-1 ring-line/70 md:inset-auto md:bottom-6 md:right-6 md:h-[600px] md:w-[400px] md:rounded-3xl">
          {/* Header */}
          <div className="flex items-center gap-2.5 bg-primary px-4 py-3 text-white">
            <div className="flex size-9 items-center justify-center rounded-full bg-white/20">
              <Sparkles className="size-5" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="font-black leading-tight">Hustlr AI</p>
              <p className="text-xs text-white/80">Your gig sidekick</p>
            </div>
            <button onClick={newChat} disabled={busy} aria-label="New chat" title="New chat" className="rounded-full p-1.5 hover:bg-white/15 disabled:opacity-40">
              <Plus className="size-5" />
            </button>
            <button onClick={openHistory} disabled={busy} aria-label="Past conversations" title="Past conversations" className="rounded-full p-1.5 hover:bg-white/15 disabled:opacity-40">
              <History className="size-5" />
            </button>
            <button onClick={() => { stopListening(); setOpen(false); }} aria-label="Close" className="rounded-full p-1.5 hover:bg-white/15">
              <X className="size-5" />
            </button>
          </div>

          {view === "history" ? (
            <HistoryPanel
              threads={threads}
              loading={loadingThreads}
              activeId={threadId}
              onBack={() => setView("chat")}
              onPick={pickThread}
              onDelete={removeThread}
            />
          ) : (
            <>
          {/* Messages */}
          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto bg-canvas px-3 py-4">
            {messages.map((m, i) => (
              <Bubble key={i} role={m.role} content={m.content} />
            ))}
            {busy && (
              <div className="flex items-center gap-2 px-1 text-sm text-ink-muted">
                <Loader2 className="size-4 animate-spin" /> Thinking…
              </div>
            )}
            {messages.length <= 1 && !busy && (
              <div className="flex flex-wrap gap-2 px-1 pt-1">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    onClick={() => send(s)}
                    className="rounded-full border border-line bg-white px-3 py-1.5 text-xs font-bold text-ink-soft transition hover:border-primary hover:text-primary"
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Composer */}
          <div className="border-t border-line bg-white p-3">
            {error && <p className="mb-2 px-1 text-xs font-semibold text-urgent">{error}</p>}
            <div className="flex items-end gap-2">
              {voiceSupported && (
                <button
                  onClick={listening ? stopListening : startListening}
                  aria-label={listening ? "Stop voice input" : "Start voice input"}
                  className={classNames(
                    "flex size-10 shrink-0 items-center justify-center rounded-full transition",
                    listening ? "animate-pulse bg-urgent text-white" : "bg-primary-light text-primary hover:bg-[#dcd6ff]",
                  )}
                >
                  {listening ? <MicOff className="size-5" /> : <Mic className="size-5" />}
                </button>
              )}
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send(input);
                  }
                }}
                rows={1}
                disabled={listening}
                placeholder={listening ? "Listening…" : "Ask anything, or describe a gig…"}
                className="max-h-28 min-h-10 flex-1 resize-none rounded-2xl border border-line bg-canvas px-3 py-2.5 text-sm text-ink outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/15 disabled:opacity-70"
              />
              <button
                onClick={() => send(input)}
                disabled={busy || !input.trim()}
                aria-label="Send"
                className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary text-white shadow-[var(--shadow-soft)] transition hover:bg-primary-dark disabled:opacity-40"
              >
                <Send className="size-5" />
              </button>
            </div>
          </div>
            </>
          )}
        </div>
      )}
    </>
  );
}

function HistoryPanel({
  threads,
  loading,
  activeId,
  onBack,
  onPick,
  onDelete,
}: {
  threads: ThreadRow[];
  loading: boolean;
  activeId: string | null;
  onBack: () => void;
  onPick: (t: ThreadRow) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-canvas">
      <button onClick={onBack} className="flex items-center gap-1 px-4 py-3 text-sm font-bold text-primary">
        <ArrowLeft className="size-4" /> Back to chat
      </button>
      <div className="flex-1 overflow-y-auto px-3 pb-4">
        {loading ? (
          <div className="flex items-center gap-2 px-1 py-4 text-sm text-ink-muted">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
        ) : threads.length === 0 ? (
          <p className="px-1 py-6 text-center text-sm text-ink-muted">No past conversations yet.</p>
        ) : (
          <div className="space-y-1.5">
            {threads.map((t) => (
              <div
                key={t.id}
                className={classNames(
                  "group flex items-center gap-2 rounded-xl px-3 py-2.5 ring-1 transition",
                  t.id === activeId ? "bg-primary-light ring-primary/30" : "bg-white ring-line/70 hover:bg-primary-light/40",
                )}
              >
                <button onClick={() => onPick(t)} className="min-w-0 flex-1 text-left">
                  <p className="truncate text-sm font-semibold text-ink">{t.title || "Conversation"}</p>
                  <p className="text-[11px] text-ink-muted">{relTime(t.updated_at)}</p>
                </button>
                <button
                  onClick={() => onDelete(t.id)}
                  aria-label="Delete conversation"
                  className="rounded-full p-1.5 text-ink-muted opacity-60 transition hover:bg-urgent/10 hover:text-urgent"
                >
                  <Trash2 className="size-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function relTime(iso: string): string {
  const then = new Date(iso).getTime();
  const m = Math.floor((Date.now() - then) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

function Bubble({ role, content }: { role: "user" | "assistant"; content: string }) {
  const isUser = role === "user";
  return (
    <div className={classNames("flex", isUser ? "justify-end" : "justify-start")}>
      <div
        className={classNames(
          "max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed",
          isUser ? "bg-primary text-white" : "bg-white text-ink ring-1 ring-line/70",
        )}
      >
        {renderRich(content)}
      </div>
    </div>
  );
}

// Light markdown: **bold** + lines starting with "- " / "•" as bullets.
function renderRich(text: string): React.ReactNode {
  return text.split("\n").map((line, i) => {
    const bullet = /^\s*[-•]\s+/.test(line);
    const body = bullet ? line.replace(/^\s*[-•]\s+/, "") : line;
    const parts = body.split(/(\*\*[^*]+\*\*)/g).map((seg, j) =>
      seg.startsWith("**") && seg.endsWith("**") ? (
        <strong key={j}>{seg.slice(2, -2)}</strong>
      ) : (
        <span key={j}>{seg}</span>
      ),
    );
    return (
      <div key={i} className={bullet ? "flex gap-1.5" : undefined}>
        {bullet && <span className="select-none">•</span>}
        <span>{parts}</span>
      </div>
    );
  });
}
