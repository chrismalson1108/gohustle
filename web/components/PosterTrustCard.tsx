import Link from "next/link";
import { CheckCircle2, Sparkles } from "lucide-react";
import { collegeLine } from "@gohustlr/shared";
import Avatar from "./ui/Avatar";
import RatingStars from "./ui/RatingStars";
import StudentBadge from "./ui/StudentBadge";
import type { PosterMini } from "@/lib/types";

// Poster identity + trust snapshot shown on a gig. Links to the public profile.
export default function PosterTrustCard({
  poster,
  posterId,
}: {
  poster: PosterMini;
  posterId?: string;
}) {
  const college = collegeLine(poster);
  const body = (
    <div className="flex items-center gap-3.5 rounded-2xl bg-white p-4 ring-1 ring-line/70 shadow-[var(--shadow-card)]">
      <Avatar url={poster.avatarUrl} initial={poster.avatarInitial} name={poster.name} size={52} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate font-bold text-ink">{poster.name}</p>
          {poster.verified && (
            <span className="inline-flex items-center gap-1 rounded-md bg-success-light px-1.5 py-0.5 text-[11px] font-bold text-success">
              <CheckCircle2 className="size-3" /> Verified
            </span>
          )}
          <StudentBadge profile={poster} compact />
        </div>
        {college && <p className="mt-0.5 truncate text-xs font-semibold text-ink-soft">{college}</p>}
        {poster.reviewCount > 0 ? (
          <div className="mt-0.5 flex items-center gap-2">
            <RatingStars value={poster.rating} size={14} />
            <span className="text-xs text-ink-soft">
              {poster.rating.toFixed(1)} · {poster.reviewCount} review{poster.reviewCount !== 1 ? "s" : ""}
            </span>
          </div>
        ) : (
          <p className="mt-0.5 flex items-center gap-1 text-xs text-ink-muted">
            <Sparkles className="size-3" /> New · no reviews yet
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
