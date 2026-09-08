"use client";

import { useState } from "react";
import Link from "next/link";
import { FUNCTIONS_URL, SUPABASE_ANON_KEY } from "@/lib/config";
import { display } from "@/lib/landingTokens";

// The waitlist capture, as a client island.
//
// web/app/page.tsx is a SERVER component and says so in its own comments — the mobile
// nav is a native <details> specifically so a toggle does not ship 890 lines and a
// 160-line PhoneMock to the browser. This is the smallest thing that can hold useState
// without breaking that: the page imports it, and everything around it stays on the
// server.
//
// It is written in the PAGE's dialect — raw hex in arbitrary-value classes — not in the
// app's semantic tokens (`bg-canvas`, `text-ink`). That is not laziness: the page's
// cream is #FEF4E5 and `--color-canvas` is #f7f4ec, so a form built from the app tokens
// renders the v3 palette against a v1 page and reads as bolted on.

// Ouachita Parish plus the two campus towns in the stated expansion corridor. This list
// never leaves the browser: the ZIP is checked here and only the BOOLEAN is transmitted,
// so the row for a person with no account and no accepted terms holds no location.
const LAUNCH_ZIPS = new Set([
  // Monroe
  "71201", "71202", "71203", "71207", "71209", "71210", "71211", "71212", "71213",
  // West Monroe
  "71291", "71292", "71294",
  // Ruston
  "71270", "71272", "71273",
  // Grambling
  "71245",
]);

const ROLES = [
  { id: "earn", label: "I want to work", hint: "Pick up gigs between classes" },
  { id: "post", label: "I need help", hint: "Post a task near me" },
  { id: "both", label: "Both", hint: "" },
] as const;

type Role = (typeof ROLES)[number]["id"];

export default function WaitlistForm() {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("earn");
  const [zip, setZip] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const digits = zip.replace(/\D/g, "");
      // ?src=ulm-flyer / ig-bio / kappa-sigma — the whole attribution story, and the
      // reason there is no referral schema. Read here rather than passed down from the
      // page, because a `searchParams` prop would turn the entire 890-line landing page
      // from a static render into a dynamic one for a query parameter most visits do
      // not carry. The server strips it to a slug before storing it.
      const src = new URLSearchParams(window.location.search).get("src");
      const res = await fetch(`${FUNCTIONS_URL}/waitlist-submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
        body: JSON.stringify({
          op: "join",
          email,
          roleIntent: role,
          source: src,
          // Only the answer, never the ZIP. Omitted entirely when nothing was typed,
          // so "didn't say" stays distinct from "not local".
          inLaunchArea: digits.length === 5 ? LAUNCH_ZIPS.has(digits) : null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.message || "Something went wrong. Please try again.");
      } else {
        setDone(true);
      }
    } catch {
      // Two arms, the same split contact/page.tsx uses: a message the server wrote,
      // or the one case the server never gets to answer.
      setError("Network error. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    // Replaces the form in place, inside the same panel, so the section keeps its
    // height and nothing below it jumps.
    return (
      <div className="mx-auto max-w-[42ch] text-center">
        <p className={`${display} m-0 mb-3 text-[26px] leading-tight font-bold text-[#FEF4E5]`}>
          You&rsquo;re on the list.
        </p>
        {/* Deliberately true in EVERY branch. The endpoint answers identically for a new
            row, a duplicate and an address that already confirmed — it will not tell a
            stranger whether an address is on the list — so this copy must not claim an
            email was sent when, for a duplicate, none was. */}
        <p className="m-0 text-[16px] leading-[1.6] text-[#FEF4E5]/90">
          If this is the first time you&rsquo;ve entered{" "}
          <strong className="font-semibold text-[#FEF4E5]">{email}</strong>, check your inbox — there&rsquo;s a
          link to confirm it. Either way, we&rsquo;ll write once: the day Hustlr opens near you.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="mx-auto max-w-[620px] text-left">
      <fieldset className="m-0 mb-4 border-0 p-0">
        <legend className="mb-2 block text-[13px] font-semibold text-[#FEF4E5]/82">
          What brings you here?
        </legend>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,150px),1fr))] gap-2">
          {ROLES.map((r) => {
            const active = role === r.id;
            return (
              <button
                key={r.id}
                type="button"
                onClick={() => setRole(r.id)}
                aria-pressed={active}
                className={`rounded-[14px] border-2 px-4 py-3 text-left transition ${
                  active
                    ? "border-[#FEF4E5] bg-[#FEF4E5] text-[#5038FF]"
                    : "border-[#FEF4E5]/40 text-[#FEF4E5] hover:border-[#FEF4E5]/70"
                }`}
              >
                <span className="block text-[15px] font-semibold">{r.label}</span>
                {r.hint ? (
                  <span className={`block text-[12.5px] ${active ? "text-[#5038FF]/70" : "text-[#FEF4E5]/70"}`}>
                    {r.hint}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </fieldset>

      <div className="flex flex-col gap-2 sm:flex-row">
        <label className="sr-only" htmlFor="waitlist-email">
          Email address
        </label>
        <input
          id="waitlist-email"
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@school.edu"
          // 16px at the small end is deliberate — iOS Safari force-zooms the page on
          // focus for anything under it. Same rule as ui/Field.
          className="min-w-0 flex-1 rounded-[14px] border-2 border-transparent bg-[#FEF4E5] px-4 py-[15px] text-base text-[#363636] outline-none transition placeholder:text-[#9A93AD] focus:border-[#363636]/25"
        />
        <input
          type="text"
          inputMode="numeric"
          maxLength={5}
          value={zip}
          onChange={(e) => setZip(e.target.value.replace(/\D/g, "").slice(0, 5))}
          placeholder="ZIP"
          aria-label="ZIP code (optional)"
          className="w-full rounded-[14px] border-2 border-transparent bg-[#FEF4E5] px-4 py-[15px] text-base text-[#363636] outline-none transition placeholder:text-[#9A93AD] focus:border-[#363636]/25 sm:w-[104px]"
        />
        <button
          type="submit"
          disabled={busy}
          className="rounded-[14px] bg-[#363636] px-7 py-[15px] text-[16px] font-semibold whitespace-nowrap text-[#FEF4E5] transition hover:bg-[#1f1f1f] disabled:opacity-60"
        >
          {busy ? "Joining…" : "Join the waitlist"}
        </button>
      </div>

      {error ? (
        // role="alert" so it is announced the moment it appears — a silently injected
        // <p> is never read out (WCAG 4.1.3).
        <p role="alert" className="mt-3 text-[14px] font-semibold text-[#FEF4E5]">
          {error}
        </p>
      ) : null}

      <p className="mt-3 m-0 text-[13px] leading-[1.6] text-[#FEF4E5]/90">
        We&rsquo;ll email you when Hustlr opens in your area, and nothing else. Your ZIP is checked in your
        browser — we only store whether you&rsquo;re in the launch area, never the code itself. Unsubscribe
        from any email.{" "}
        <Link href="/legal/privacy" className="underline underline-offset-2 hover:text-[#FEF4E5]">
          Privacy Policy
        </Link>
        .
      </p>
    </form>
  );
}
