"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

// The public safety page. Someone's friend or parent opens this — they are almost never
// a GoHustlr user and may be opening it worried, on a phone, at night.
//
// Three consequences for the design:
//   1. NO LOGIN. The token is the credential. Requiring a signup is how a safety
//      feature goes unused at exactly the moment it matters.
//   2. The answer to "is she okay" must be readable in one glance, above everything
//      else. Status first, in plain words, in a colour that means something.
//   3. It must degrade honestly. An expired or revoked link says so plainly rather than
//      erroring, because "this link no longer works" and "something broke" lead to very
//      different actions at 11pm.

interface Share {
  earner_first: string;
  poster_first: string;
  job_title: string;
  location: string | null;
  location_is_exact: boolean;
  lat: number | null;
  lng: number | null;
  status: string;
  started_at: string | null;
  scheduled_at: string | null;
  expected_end: string | null;
  completed_at: string | null;
  is_done: boolean;
  expires_at: string;
  label: string | null;
}

const fmt = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString(undefined, {
        weekday: "short", hour: "numeric", minute: "2-digit", month: "short", day: "numeric",
      })
    : null;

export default function SharePage() {
  const params = useParams<{ token: string }>();
  const [share, setShare] = useState<Share | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "gone">("loading");

  const load = async () => {
    const { data, error } = await supabase.rpc("view_gig_share", { p_token: params.token });
    if (error || !data) {
      setState("gone");
      return;
    }
    setShare(data as Share);
    setState("ok");
  };

  useEffect(() => {
    load();
    // Refresh while the page is open. Someone watching a gig in progress will leave
    // this tab up; making them pull-to-refresh to find out their friend checked out
    // would be the wrong ergonomics for the situation.
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.token]);

  if (state === "loading") {
    return <Shell><p className="text-ink-muted">Loading…</p></Shell>;
  }

  if (state === "gone" || !share) {
    return (
      <Shell>
        <h1 className="text-xl font-semibold text-ink">This link isn&rsquo;t active</h1>
        <p className="mt-2 text-sm text-ink-muted">
          It may have expired, or the person who shared it turned it off. Links stop
          working a few hours after a gig ends.
        </p>
        <p className="mt-4 text-sm text-ink-muted">
          If you&rsquo;re worried about someone right now, contact them directly — or
          your local emergency number.
        </p>
      </Shell>
    );
  }

  const late =
    !share.is_done &&
    share.expected_end != null &&
    Date.parse(share.expected_end) < Date.now();

  // Status is the headline. Everything else on this page is supporting detail.
  const headline = share.is_done
    ? { text: `${share.earner_first} has finished and checked out.`, tone: "ok" as const }
    : share.started_at
      ? late
        ? { text: `${share.earner_first} is still working — past the expected finish.`, tone: "warn" as const }
        : { text: `${share.earner_first} is working now.`, tone: "live" as const }
      : { text: `${share.earner_first} hasn't started yet.`, tone: "idle" as const };

  const toneClass = {
    ok: "border-green-300 bg-green-50 text-green-900",
    live: "border-indigo-300 bg-indigo-50 text-indigo-900",
    warn: "border-amber-400 bg-amber-50 text-amber-900",
    idle: "border-[var(--color-divider)] bg-paper text-ink",
  }[headline.tone];

  return (
    <Shell>
      <div className={`rounded-2xl border px-4 py-4 ${toneClass}`}>
        <p className="text-lg font-semibold leading-snug">{headline.text}</p>
        {late && (
          <p className="mt-1 text-sm">
            This can simply mean they forgot to tap &ldquo;done&rdquo;. GoHustlr checks in
            with them automatically when a gig runs long.
          </p>
        )}
      </div>

      <dl className="mt-5 space-y-3 text-sm">
        <Row label="Job" value={share.job_title} />
        <Row label="With" value={share.poster_first} />
        {share.location && (
          <Row
            // Honest labelling. When all we have is a city-level pin, saying "Where"
            // over it implies a precision we do not have — and a confident wrong
            // location is worse than an admitted approximate one at 11pm.
            label={share.location_is_exact ? "Where" : "Approximate area"}
            value={
              share.location_is_exact ? (
                // Link the ADDRESS STRING, not lat/lng: Google resolves it to the
                // building, while the stored coordinates are a city centroid rounded
                // to 2dp and would drop a pin in the wrong place.
                <a
                  className="text-primary underline"
                  href={`https://maps.google.com/?q=${encodeURIComponent(share.location)}`}
                  target="_blank" rel="noreferrer"
                >
                  {share.location}
                </a>
              ) : share.lat != null && share.lng != null ? (
                <span>
                  <a
                    className="text-primary underline"
                    href={`https://maps.google.com/?q=${share.lat},${share.lng}`}
                    target="_blank" rel="noreferrer"
                  >
                    {share.location}
                  </a>
                  <span className="block text-xs text-ink-muted">
                    The exact address becomes visible once the gig is accepted.
                  </span>
                </span>
              ) : (
                share.location
              )
            }
          />
        )}
        {share.started_at && <Row label="Started" value={fmt(share.started_at)} />}
        {share.expected_end && !share.is_done && (
          <Row label="Expected to finish" value={fmt(share.expected_end)} />
        )}
        {share.completed_at && <Row label="Finished" value={fmt(share.completed_at)} />}
      </dl>

      <p className="mt-6 text-xs leading-relaxed text-ink-muted">
        {share.earner_first} shared this with you from GoHustlr so someone knows where
        they are. It updates on its own and stops working {fmt(share.expires_at)}.
      </p>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto min-h-screen max-w-md px-5 py-10">
      <div className="mb-6 text-sm font-bold text-primary">GoHustlr</div>
      {children}
    </main>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <dt className="w-32 shrink-0 text-ink-muted">{label}</dt>
      <dd className="font-medium text-ink">{value}</dd>
    </div>
  );
}
