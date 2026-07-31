"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { Search, UsersRound, CheckCircle2, X } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useJobs } from "@/lib/jobs";
import { supabase } from "@/lib/supabaseClient";
import PageHeader, { PageContainer, EmptyState } from "@/components/PageHeader";
import Avatar from "@/components/ui/Avatar";
import RatingStars from "@/components/ui/RatingStars";

const DEBOUNCE_MS = 350;
const MIN_QUERY = 2;

interface PersonRow {
  id: string;
  name: string | null;
  username: string | null;
  avatar_initial: string | null;
  avatar_url: string | null;
  rating: number | null;
  review_count: number | null;
  verified: boolean | null;
  city: string | null;
}

// Search people by name or @username → tap through to their public profile
// (message / invite / favorite live there). Mirror of mobile FindPeopleScreen;
// reachable from Profile → Grow → Find people and the Messages header icon.
export default function FindPeoplePage() {
  const { user } = useAuth();
  const { blockedIds } = useJobs();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PersonRow[] | null>(null); // null = nothing searched yet
  const [searching, setSearching] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = useRef(0);

  const runSearch = async (raw: string) => {
    // Leading @ is how usernames are displayed — accept it. Strip characters
    // that are ilike wildcards or would break the PostgREST or() syntax.
    const q = raw.trim().replace(/^@/, "").replace(/[%_,()]/g, "");
    if (q.length < MIN_QUERY) {
      setResults(null);
      setSearching(false);
      return;
    }
    const mySeq = ++seq.current;
    setSearching(true);
    const { data } = await supabase
      .from("profiles")
      .select("id, name, username, avatar_initial, avatar_url, rating, review_count, verified, city")
      .or(`username.ilike.%${q}%,name.ilike.%${q}%`)
      .not("username", "is", null) // only users who finished onboarding
      .order("review_count", { ascending: false })
      .limit(25);
    if (mySeq !== seq.current) return; // a newer query superseded this one
    const list = ((data as PersonRow[]) || []).filter((p) => p.id !== user?.id && !blockedIds.has(p.id));
    setResults(list);
    setSearching(false);
  };

  const onChange = (v: string) => {
    setQuery(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => runSearch(v), DEBOUNCE_MS);
  };

  return (
    <div>
      <PageHeader title="Find people" subtitle="Search workers and clients by name or username" width="feed" />
      <PageContainer width="feed">
        {/* Search box carries a 1px border, not a shadow — one elevation mechanism
            per surface, and a bordered field is the shared Field recipe. */}
        <div className="mb-4 flex items-center gap-2 rounded-xl border border-line bg-white px-4 py-3 transition focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/15">
          <Search className="size-4 shrink-0 text-ink-muted" />
          <input
            value={query}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && runSearch(query)}
            placeholder="Search by name or @username"
            autoFocus
            // 16px at the small end or iOS Safari zooms the page on focus.
            className="min-w-0 flex-1 bg-transparent text-base text-ink outline-none placeholder:text-ink-muted sm:text-[15px]"
          />
          {query.length > 0 && (
            <button
              onClick={() => {
                setQuery("");
                setResults(null);
              }}
              aria-label="Clear search"
              // An explicit 44px box. Padding around a 16px glyph only reached
              // 32px, and the negative margin pulls the layout back in — it does
              // not enlarge the hit area.
              className="-m-3.5 flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full text-ink-muted transition hover:text-ink"
            >
              <X className="size-4" />
            </button>
          )}
        </div>

        {searching ? (
          <p className="mt-8 text-center text-sm text-ink-muted">Searching…</p>
        ) : results === null ? (
          <EmptyState
            icon={<UsersRound className="size-10" />}
            title="Find people on GoHustlr"
            body="Search by name or username, then view their profile to message, invite, or favorite them."
          />
        ) : results.length === 0 ? (
          <EmptyState
            icon={<Search className="size-10" />}
            title="No one found"
            body={`Nobody matches "${query.trim()}". Check the spelling or try a different name.`}
          />
        ) : (
          // A directory is a grid, not a thin column: container queries (main is
          // the @container) add columns off the space the content box ACTUALLY
          // has, so the count is right whether or not the sidebar is showing.
          <div className="grid grid-cols-1 gap-3 pb-8 @2xl:grid-cols-2 @5xl:grid-cols-3 @7xl:grid-cols-4">
            {results.map((p) => (
              <Link
                key={p.id}
                href={`/u/${p.id}`}
                className="flex items-center gap-3 rounded-2xl bg-white p-4 shadow-[var(--shadow-card)] transition hover:shadow-[var(--shadow-soft)]"
              >
                <Avatar url={p.avatar_url} initial={p.avatar_initial} name={p.name || "?"} size={48} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <p className="min-w-0 truncate text-[15px] font-semibold text-ink">{p.name || "GoHustlr user"}</p>
                    {p.verified && <CheckCircle2 className="size-4 shrink-0 text-success" />}
                  </div>
                  {/* The @handle is a static label, not a link — brand purple is
                      reserved for active state, saved, and real links/CTAs. */}
                  {p.username && <p className="mt-0.5 truncate text-xs text-ink-muted">@{p.username}</p>}
                  <div className="mt-1 flex min-w-0 items-center gap-1.5">
                    {(p.review_count || 0) > 0 ? (
                      <>
                        <RatingStars value={Number(p.rating) || 0} size={12} className="shrink-0" />
                        <span className="shrink-0 text-xs text-ink-muted">
                          {Number(p.rating).toFixed(1)} ({p.review_count})
                        </span>
                      </>
                    ) : (
                      <span className="shrink-0 text-xs text-ink-muted">No reviews yet</span>
                    )}
                    {p.city && <span className="min-w-0 truncate text-xs text-ink-muted">· {p.city}</span>}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </PageContainer>
    </div>
  );
}
