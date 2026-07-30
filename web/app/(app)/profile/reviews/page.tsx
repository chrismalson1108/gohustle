"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, Star } from "lucide-react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { supabase } from "@/lib/supabaseClient";
import PageHeader, { PageContainer, EmptyState } from "@/components/PageHeader";
import Avatar from "@/components/ui/Avatar";
import RatingStars from "@/components/ui/RatingStars";
import { FullPageSpinner } from "@/components/ui/Spinner";

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
  const router = useRouter();
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
      <PageHeader title="Reviews" subtitle="Everything people have said about your work" variant="gold" />
      <PageContainer>
        <button onClick={() => router.push("/profile")} className="mb-4 flex items-center gap-1 text-sm font-bold text-primary">
          <ArrowLeft className="size-4" /> Back
        </button>

        {reviews.length === 0 ? (
          <EmptyState
            icon={<Star className="size-10" />}
            title="No reviews yet"
            body="Complete gigs as a worker or client to start earning reviews."
          />
        ) : (
          <>
            <div className="mb-4 flex gap-2">
              {FILTERS.map((f) => {
                const count = f.id === "all" ? reviews.length : reviews.filter((r) => r.role === f.id).length;
                return (
                  <button
                    key={f.id}
                    onClick={() => setFilter(f.id)}
                    className={`rounded-full px-3.5 py-1.5 text-sm font-bold transition ${
                      filter === f.id
                        ? "bg-primary text-white"
                        : "bg-white text-ink-soft ring-1 ring-line/70 hover:bg-primary-light/40"
                    }`}
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

            <div className="space-y-2.5">
              {shown.map((r) => (
                <div key={r.id} className="rounded-2xl bg-white p-4 shadow-[var(--shadow-card)] ring-1 ring-line/70">
                  <div className="flex items-center gap-2.5">
                    <Avatar
                      url={r.reviewer?.avatar_url}
                      initial={r.reviewer?.avatar_initial || r.reviewer?.name?.[0]}
                      name={r.reviewer?.name}
                      size={32}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-bold text-ink">{r.reviewer?.name || "User"}</p>
                      <RatingStars value={r.rating} size={12} />
                    </div>
                    {r.date && <span className="text-xs text-ink-muted">{r.date}</span>}
                  </div>
                  {r.text && <p className="mt-2 text-sm text-ink-soft">{r.text}</p>}
                </div>
              ))}
            </div>
          </>
        )}
      </PageContainer>
    </div>
  );
}
