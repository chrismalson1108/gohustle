"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { supabase } from "@/lib/supabaseClient";
import { FUNCTIONS_URL, SUPABASE_ANON_KEY } from "@/lib/config";
import { SUPPORT_EMAIL } from "@/lib/legal";
import Logo from "@/components/Logo";

const CATEGORIES = ["General", "Payments", "A gig or booking", "My account", "Trust & safety", "Other"];

// Public support / contact form. Files a ticket via the support-submit edge
// function (which also emails the support inbox). No login required; if the
// visitor is signed in we prefill their email and link the ticket to them.
export default function ContactPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [category, setCategory] = useState(CATEGORIES[0]);
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.getSession();
      const s = data.session;
      if (s?.user?.email) setEmail(s.user.email);
      if (s?.access_token) setToken(s.access_token);
    })();
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`${FUNCTIONS_URL}/support-submit`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_ANON_KEY,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ name, email, category, subject, message }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.message || "Something went wrong. Please try again.");
      } else {
        setDone(true);
      }
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-canvas">
      <header className="mx-auto flex w-full max-w-2xl items-center justify-between px-5 py-5">
        <Link href="/" className="flex items-center gap-2 text-ink-soft hover:text-ink">
          <ArrowLeft size={18} /> <span className="text-sm">Back</span>
        </Link>
        <Logo />
      </header>

      <main className="mx-auto w-full max-w-2xl px-5 pb-20">
        <h1 className="font-display text-3xl font-bold text-ink">Contact support</h1>
        <p className="mt-2 text-ink-soft">
          Have a question or a problem with a gig, booking, or payment? Send us a message and we&apos;ll get back
          to you by email. You can also reach us at{" "}
          <a href={`mailto:${SUPPORT_EMAIL}`} className="text-primary underline">{SUPPORT_EMAIL}</a>.
        </p>

        {done ? (
          <div className="mt-8 rounded-2xl border border-line bg-white p-8 text-center shadow-card">
            <div className="mb-2 text-2xl">✅</div>
            <h2 className="font-display text-xl font-bold text-ink">Message sent</h2>
            <p className="mt-2 text-ink-soft">
              Thanks! We&apos;ll reply to <strong>{email}</strong> as soon as we can.
            </p>
            <Link href="/" className="mt-6 inline-block rounded-xl bg-primary px-5 py-2.5 font-semibold text-white">
              Back to GoHustlr
            </Link>
          </div>
        ) : (
          <form onSubmit={submit} className="mt-8 space-y-4 rounded-2xl border border-line bg-white p-6 shadow-card">
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-ink">Your name</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full rounded-xl border border-line px-3 py-2 outline-none focus:border-primary"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-ink">Email *</span>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full rounded-xl border border-line px-3 py-2 outline-none focus:border-primary"
                />
              </label>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-ink">Topic</span>
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  className="w-full rounded-xl border border-line bg-white px-3 py-2 outline-none focus:border-primary"
                >
                  {CATEGORIES.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-ink">Subject *</span>
                <input
                  required
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  className="w-full rounded-xl border border-line px-3 py-2 outline-none focus:border-primary"
                />
              </label>
            </div>
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-ink">How can we help? *</span>
              <textarea
                required
                rows={6}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                className="w-full resize-y rounded-xl border border-line px-3 py-2 outline-none focus:border-primary"
              />
            </label>
            {error && <p className="text-sm text-urgent">{error}</p>}
            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-xl bg-primary py-3 font-semibold text-white disabled:opacity-50"
            >
              {busy ? "Sending…" : "Send message"}
            </button>
          </form>
        )}
      </main>
    </div>
  );
}
