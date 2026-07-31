import Link from "next/link";
import { CheckCircle2, Sparkles } from "lucide-react";
import { collegeLine } from "@gohustlr/shared";
import Avatar from "./ui/Avatar";
import RatingStars from "./ui/RatingStars";
import StudentBadge from "./ui/StudentBadge";
import type { PosterMini } from "@/lib/types";

// Poster identity + trust snapshot shown on a gig. Links to the public profile.
// Mirrors src/components/PosterTrustCard.js: white card, 20px radius, ONE
// elevation mechanism (the resting card shadow — no ring on top of it).
export default function PosterTrustCard({
  poster,
  posterId,
}: {
  poster: PosterMini;
  posterId?: string;
}) {
  const college = collegeLine(poster);
  const body = (
    <div className="flex items-center gap-3 rounded-2xl bg-white p-4 shadow-[var(--shadow-card)]">
      <Avatar url={poster.avatarUrl} initial={poster.avatarInitial} name={poster.name} size={52} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="min-w-0 truncate text-base font-bold tracking-[-0.2px] text-ink">{poster.name}</p>
          {poster.verified && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-success-light px-2 py-0.5 text-[11px] font-semibold text-success">
              <CheckCircle2 className="size-3" /> Verified
            </span>
          )}
          <StudentBadge profile={poster} compact />
        </div>
        {college && <p className="mt-1 truncate text-xs font-medium text-ink-soft">{college}</p>}
        {poster.reviewCount > 0 ? (
          <div className="mt-1 flex min-w-0 items-center gap-2">
            <RatingStars value={poster.rating} size={14} />
            <span className="min-w-0 truncate text-xs text-ink-muted">
              {poster.rating.toFixed(1)} · {poster.reviewCount} review{poster.reviewCount !== 1 ? "s" : ""}
            </span>
          </div>
        ) : (
          <p className="mt-1 flex items-center gap-1 text-xs text-ink-muted">
            <Sparkles className="size-3 shrink-0" /> New · no reviews yet
          </p>
        )}
      </div>
    </div>
  );

  return posterId ? (
    <Link href={`/u/${posterId}`} className="block transition hover:opacity-90">
      {body}
    </Link>
  ) : (
    body
  );
}
