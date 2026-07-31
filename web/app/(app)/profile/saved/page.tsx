"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Heart } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { fetchFavorites, removeFavorite, type FavProfile } from "@/lib/favorites";
import PageHeader, { PageContainer, EmptyState } from "@/components/PageHeader";
import Avatar from "@/components/ui/Avatar";
import RatingStars from "@/components/ui/RatingStars";
import { FullPageSpinner } from "@/components/ui/Spinner";

export default function SavedPeoplePage() {
  const { user } = useAuth();
  const [people, setPeople] = useState<FavProfile[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    fetchFavorites(user.id).then((p) => {
      setPeople(p);
      setLoading(false);
    });
  }, [user]);

  if (loading) return <FullPageSpinner />;

  return (
    <div>
      <PageHeader title="Saved people" subtitle="Posters and earners you've saved" width="feed" back="/profile" />
      <PageContainer width="feed">
        {people.length === 0 ? (
          <EmptyState icon={<Heart className="size-10" />} title="No saved people yet" body="Tap the heart on someone's profile to save them for quick rehiring." />
        ) : (
          // Auto-fill, not a breakpoint ladder: a `@5xl:grid-cols-2` step caps the
          // grid at two columns forever, so on a 2560px screen each row — a 44px
          // avatar, a name and a city — stretched to ~870px. `min(280px,100%)` is
          // the dense-list measure, and it needs no thresholds at all.
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(280px,100%),1fr))] gap-3 pb-8">
            {people.map((p) => (
              <div key={p.id} className="flex items-center gap-3 rounded-2xl bg-white p-4 shadow-[var(--shadow-card)]">
                <Link href={`/u/${p.id}`} className="flex min-w-0 flex-1 items-center gap-3">
                  <Avatar url={p.avatar_url} initial={p.avatar_initial} name={p.name} size={44} />
                  <div className="min-w-0">
                    <p className="truncate text-[15px] font-bold leading-5 text-ink">{p.name}</p>
                    <div className="mt-0.5 flex min-w-0 items-center gap-2">
                      {p.review_count > 0 ? (
                        <RatingStars className="shrink-0" value={p.rating} size={12} />
                      ) : (
                        <span className="shrink-0 text-xs text-ink-muted">New</span>
                      )}
                      {p.city && <span className="min-w-0 truncate text-xs text-ink-muted">· {p.city}</span>}
                    </div>
                  </div>
                </Link>
                <button
                  onClick={async () => {
                    if (!user) return;
                    await removeFavorite(user.id, p.id);
                    setPeople((prev) => prev.filter((x) => x.id !== p.id));
                  }}
                  // An explicit 44px box — padding around a 20px glyph only reached
                  // 40px, and the negative margin pulls the layout in without
                  // enlarging the hit area.
                  className="-m-1.5 flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full text-urgent transition hover:bg-urgent/10"
                  aria-label="Remove"
                >
                  <Heart className="size-5 fill-urgent" />
                </button>
              </div>
            ))}
          </div>
        )}
      </PageContainer>
    </div>
  );
}
