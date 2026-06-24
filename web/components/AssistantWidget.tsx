"use client";

import { useEffect, useRef, useState } from "react";
import { Sparkles, Send, Mic, MicOff, X, Loader2 } from "lucide-react";
import { askAssistant, type AssistantMsg, type AssistantAction } from "@/lib/assistant";
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
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<AssistantMsg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  // Greet on first open.
  useEffect(() => {
    if (open && messages.length === 0) {
      setMessages([{ role: "assistant", content: GREETING }]);
    }
  }, [open, messages.length]);

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
      const { reply, actions } = await askAssistant(next);
      setMessages([...next, { role: "assistant", content: reply }]);
      runActions(actions);
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => stopListening(), []);

  return (
    <>
      {/* Floating launcher */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          aria-label="Open Hustlr AI assistant"
          className="fixed bottom-20 right-4 z-50 flex size-14 items-center justify-center rounded-full bg-primary text-white shadow-[var(--shadow-card)] ring-4 ring-primary/20 transition hover:scale-105 md:bottom-6 md:right-6"
        >
          <Sparkles className="size-6" />
        </button>
      )}

      {/* Chat panel */}
      {open && (
        <div className="fixed inset-x-0 bottom-0 z-50 flex h-[80vh] flex-col overflow-hidden rounded-t-3xl bg-white shadow-2xl ring-1 ring-line md:inset-auto md:bottom-6 md:right-6 md:h-[600px] md:w-[400px] md:rounded-3xl">
          {/* Header */}
          <div className="flex items-center gap-2.5 bg-primary px-4 py-3 text-white">
            <div className="flex size-9 items-center justify-center rounded-full bg-white/20">
              <Sparkles className="size-5" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="font-black leading-tight">Hustlr AI</p>
              <p className="text-xs text-white/80">Your gig sidekick</p>
            </div>
            <button onClick={() => { stopListening(); setOpen(false); }} aria-label="Close" className="rounded-full p-1.5 hover:bg-white/15">
              <X className="size-5" />
            </button>
          </div>

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
                    listening ? "animate-pulse bg-urgent text-white" : "bg-primary-light text-primary hover:bg-primary/15",
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
                className="max-h-28 min-h-10 flex-1 resize-none rounded-2xl border border-line bg-canvas px-3 py-2.5 text-sm text-ink outline-none focus:border-primary disabled:opacity-70"
              />
              <button
                onClick={() => send(input)}
                disabled={busy || !input.trim()}
                aria-label="Send"
                className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary text-white transition hover:bg-primary/90 disabled:opacity-40"
              >
                <Send className="size-5" />
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Bubble({ role, content }: { role: "user" | "assistant"; content: string }) {
  const isUser = role === "user";
  return (
    <div className={classNames("flex", isUser ? "justify-end" : "justify-start")}>
      <div
        className={classNames(
          "max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed",
          isUser ? "rounded-br-md bg-primary text-white" : "rounded-bl-md bg-white text-ink ring-1 ring-line",
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
