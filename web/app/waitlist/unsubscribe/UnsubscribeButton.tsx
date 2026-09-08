"use client";

import { useState } from "react";
import Link from "next/link";
import { FUNCTIONS_URL, SUPABASE_ANON_KEY } from "@/lib/config";

// The confirm-then-act half of the unsubscribe page. A client island purely because
// the action has to be a POST the person initiates — see the page's own comment for
// why a GET would be wrong.
export default function UnsubscribeButton({ token }: { token: string }) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "gone" | "error">("idle");
  const [email, setEmail] = useState<string | null>(null);

  async function unsubscribe() {
    setState("busy");
    try {
      const res = await fetch(`${FUNCTIONS_URL}/waitlist-submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
        body: JSON.stringify({ op: "unsubscribe", token }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        setEmail(typeof data.email === "string" ? data.email : null);
        setState("done");
      } else if (res.status === 404) {
        // Already used, or the row is gone. Either way the person is not on the list,
        // which is what they came here for — so this is a success, not an error.
        setState("gone");
      } else {
        setState("error");
      }
    } catch {
      setState("error");
    }
  }

  if (state === "done" || state === "gone") {
    return (
      <>
        <h1 className="m-0 mb-3 text-[32px] leading-tight font-bold text-ink">You&rsquo;re unsubscribed.</h1>
        <p className="m-0 mb-6 text-[17px] leading-[1.6] text-ink-soft">
          {email ? (
            <>
              We won&rsquo;t email <strong className="font-semibold text-ink">{email}</strong> again. We keep
              the address on a suppression list for one reason only — so a future send can&rsquo;t reach it
              by accident — and nothing you can type into a form will put it back.
            </>
          ) : (
            <>This address is off the list and will not be emailed again.</>
          )}
        </p>
        <div className="flex flex-wrap gap-3">
          <Link
            href="/"
            className="inline-flex items-center rounded-xl border-2 border-line px-6 py-3 text-[16px] font-semibold text-ink transition hover:border-primary hover:text-primary"
          >
            Back to gohustlr.com
          </Link>
        </div>
      </>
    );
  }

  return (
    <>
      <h1 className="m-0 mb-3 text-[32px] leading-tight font-bold text-ink">
        Stop emails from Hustlr?
      </h1>
      <p className="m-0 mb-6 text-[17px] leading-[1.6] text-ink-soft">
        You&rsquo;ll come off the waitlist and we won&rsquo;t write again. Changed your mind later?
        Email us — we don&rsquo;t let a form put an address back on the list, because then anyone who
        knew your address could.
      </p>
      {state === "error" ? (
        <p role="alert" className="mb-4 text-[15px] font-semibold text-urgent">
          That didn&rsquo;t go through. Try again, or{" "}
          <Link href="/contact" className="underline">
            contact us
          </Link>{" "}
          and we&rsquo;ll remove you by hand.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-3">
        <button
          onClick={unsubscribe}
          disabled={state === "busy"}
          className="inline-flex items-center rounded-xl bg-urgent px-6 py-3.5 text-[16px] font-semibold text-white transition hover:opacity-90 disabled:opacity-60"
        >
          {state === "busy" ? "Removing…" : "Yes, unsubscribe me"}
        </button>
        <Link
          href="/"
          className="inline-flex items-center rounded-xl border-2 border-line px-6 py-3 text-[16px] font-semibold text-ink transition hover:border-primary hover:text-primary"
        >
          Keep me on the list
        </Link>
      </div>
    </>
  );
}
