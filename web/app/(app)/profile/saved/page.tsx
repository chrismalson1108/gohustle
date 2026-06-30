"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Heart } from "lucide-react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { fetchFavorites, removeFavorite, type FavProfile } from "@/lib/favorites";
import PageHeader, { PageContainer, EmptyState } from "@/components/PageHeader";
import Avatar from "@/components/ui/Avatar";
import RatingStars from "@/components/ui/RatingStars";
import { FullPageSpinner } from "@/components/ui/Spinner";

export default function SavedPeoplePage() {
  const router = useRouter();
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
      <PageHeader title="Saved people" subtitle="Posters and earners you've saved" variant="gold" />
      <PageContainer>
        <button onClick={() => router.push("/profile")} className="mb-4 flex items-center gap-1 text-sm font-bold text-primary">
          <ArrowLeft className="size-4" /> Back
        </button>
        {people.length === 0 ? (
          <EmptyState icon={<Heart className="size-10" />} title="No saved people yet" body="Tap the heart on someone's profile to save them for quick rehiring." />
        ) : (
          <div className="space-y-3">
            {people.map((p) => (
              <div key={p.id} className="flex items-center gap-3 rounded-2xl bg-white p-4 shadow-[var(--shadow-card)] ring-1 ring-line/70">
                <Link href={`/u/${p.id}`} className="flex min-w-0 flex-1 items-center gap-3">
                  <Avatar url={p.avatar_url} initial={p.avatar_initial} name={p.name} size={44} />
                  <div className="min-w-0">
                    <p className="truncate font-bold text-ink">{p.name}</p>
                    <div className="flex items-center gap-2">
                      {p.review_count > 0 ? <RatingStars value={p.rating} size={12} /> : <span className="text-xs text-ink-muted">New</span>}
                      {p.city && <span className="truncate text-xs text-ink-muted">· {p.city}</span>}
                    </div>
                  </div>
                </Link>
                <button
                  onClick={async () => {
                    if (!user) return;
                    await removeFavorite(user.id, p.id);
                    setPeople((prev) => prev.filter((x) => x.id !== p.id));
                  }}
                  className="rounded-full p-1.5 text-urgent transition hover:bg-urgent/10"
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
