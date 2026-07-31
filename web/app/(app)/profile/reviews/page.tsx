"use client";

import { useEffect, useState } from "react";
import { Star } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { supabase } from "@/lib/supabaseClient";
import PageHeader, { PageContainer, EmptyState } from "@/components/PageHeader";
import Avatar from "@/components/ui/Avatar";
import RatingStars from "@/components/ui/RatingStars";
import { FullPageSpinner } from "@/components/ui/Spinner";
import { classNames } from "@/lib/format";

interface Review {
  id: string;
  rating: number;
  text: string | null;
  date: string | null;
  role: string;
  reviewer: { name: string | null; avatar_initial: string | null; avatar_url: string | null } | null;
}

type Filter = "all" | "earner" | "poster";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "earner", label: "As a worker" },
  { id: "poster", label: "As a client" },
];

// Every review the user has received. The profile hub shows only the three most
// recent — this is where "See all" lands, so a user with 200 reviews doesn't
// render all of them inline on the page they open most.
export default function ReviewsPage() {
  const { user } = useAuth();
  const [reviews, setReviews] = useState<Review[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>("all");

  useEffect(() => {
    if (!user) return;
    supabase
      .from("reviews")
      .select("id, rating, text, date, role, reviewer:profiles!reviewer_id(name, avatar_initial, avatar_url)")
      .eq("reviewed_user_id", user.id)
      .order("created_at", { ascending: false })
      .then(({ data }) => {
        setReviews((data as unknown as Review[]) || []);
        setLoading(false);
      }, () => setLoading(false));
  }, [user]);

  if (loading) return <FullPageSpinner label="Loading your reviews…" />;

  const shown = filter === "all" ? reviews : reviews.filter((r) => r.role === filter);
  const avg = (arr: Review[]) =>
    arr.length ? (arr.reduce((s, r) => s + Number(r.rating || 0), 0) / arr.length).toFixed(1) : "—";

  return (
    <div>
      <PageHeader
        title="Reviews"
        subtitle="Everything people have said about your work"
        width="feed"
        back="/profile"
      />
      <PageContainer width="feed">
        {reviews.length === 0 ? (
          <EmptyState
            icon={<Star className="size-10" />}
            title="No reviews yet"
            body="Complete gigs as a worker or client to start earning reviews."
          />
        ) : (
          <>
            {/* Pill segmented control, same as mobile's ReviewsScreen tabs. Capped so
                it stays a control rather than stretching across a 1760px feed. */}
            <div className="mb-4 flex w-full max-w-md rounded-full border border-line bg-white p-1">
              {FILTERS.map((f) => {
                const count = f.id === "all" ? reviews.length : reviews.filter((r) => r.role === f.id).length;
                const active = filter === f.id;
                return (
                  <button
                    key={f.id}
                    onClick={() => setFilter(f.id)}
                    aria-pressed={active}
                    className={classNames(
                      // Weight is 600 in both states: a 600→700 bump on select
                      // re-measures the label and clips it on a narrow phone.
                      "flex-1 truncate rounded-full px-2 py-2.5 text-[13px] font-semibold transition",
                      active ? "bg-primary text-white" : "text-ink-soft hover:text-ink",
                    )}
                  >
                    {f.label} ({count})
                  </button>
                );
              })}
            </div>

            {shown.length > 0 && (
              <p className="mb-3 text-sm text-ink-soft">
                Average <span className="font-bold text-ink">{avg(shown)}★</span> across {shown.length} review
                {shown.length !== 1 ? "s" : ""}
              </p>
            )}

            {/* Auto-fill, not a breakpoint ladder: a `@5xl:grid-cols-2` step stayed
                single-column all the way to a 1024px container and then never went
                past two, so a card ran ~870px wide at the 1760px feed cap. Auto-fill
                against a 320px card measure adds columns wherever they fit and needs
                no threshold. */}
            <div className="grid grid-cols-[repeat(auto-fill,minmax(min(320px,100%),1fr))] gap-3 pb-8">
              {shown.map((r) => (
                <div key={r.id} className="rounded-2xl bg-white p-4 shadow-[var(--shadow-card)]">
                  <div className="flex items-center gap-3">
                    <Avatar
                      url={r.reviewer?.avatar_url}
                      initial={r.reviewer?.avatar_initial || r.reviewer?.name?.[0]}
                      name={r.reviewer?.name}
                      size={36}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-bold text-ink">{r.reviewer?.name || "User"}</p>
                      {/* The ink numeral carries the meaning — star count alone is
                          hard to read at 12px in a dense row. */}
                      <div className="mt-0.5 flex items-center gap-1.5">
                        <RatingStars value={r.rating} size={12} />
                        <span className="text-xs text-ink-muted">{Number(r.rating).toFixed(1)}</span>
                      </div>
                    </div>
                    {r.date && <span className="shrink-0 text-[11px] text-ink-muted">{r.date}</span>}
                  </div>
                  {r.text && <p className="mt-2 text-[13px] leading-5 text-ink-soft">{r.text}</p>}
                </div>
              ))}
            </div>
          </>
        )}
      </PageContainer>
    </div>
  );
}
