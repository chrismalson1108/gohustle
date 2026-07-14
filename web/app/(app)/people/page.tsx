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
      <PageHeader title="Find people" subtitle="Search workers and clients by name or username" />
      <PageContainer>
        <div className="mb-4 flex items-center gap-2 rounded-2xl bg-white px-4 py-3 shadow-[var(--shadow-card)] ring-1 ring-line/70 focus-within:ring-primary/40">
          <Search className="size-4 shrink-0 text-ink-muted" />
          <input
            value={query}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && runSearch(query)}
            placeholder="Search by name or @username"
            autoFocus
            className="min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-ink-muted"
          />
          {query.length > 0 && (
            <button
              onClick={() => {
                setQuery("");
                setResults(null);
              }}
              aria-label="Clear search"
              className="rounded-full p-1 text-ink-muted hover:bg-line/60"
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
          <div className="space-y-3">
            {results.map((p) => (
              <Link
                key={p.id}
                href={`/u/${p.id}`}
                className="flex items-center gap-3 rounded-2xl bg-white p-4 shadow-[var(--shadow-card)] ring-1 ring-line/70 transition hover:ring-primary/40"
              >
                <Avatar url={p.avatar_url} initial={p.avatar_initial} name={p.name || "?"} size={44} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <p className="truncate font-bold text-ink">{p.name || "GoHustlr user"}</p>
                    {p.verified && <CheckCircle2 className="size-4 shrink-0 text-primary" />}
                  </div>
                  {p.username && <p className="truncate text-xs font-semibold text-primary">@{p.username}</p>}
                  <div className="mt-0.5 flex items-center gap-2">
                    {(p.review_count || 0) > 0 ? (
                      <>
                        <RatingStars value={Number(p.rating) || 0} size={12} />
                        <span className="text-xs text-ink-muted">
                          {Number(p.rating).toFixed(1)} ({p.review_count})
                        </span>
                      </>
                    ) : (
                      <span className="text-xs text-ink-muted">No reviews yet</span>
                    )}
                    {p.city && <span className="truncate text-xs text-ink-muted">· {p.city}</span>}
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
