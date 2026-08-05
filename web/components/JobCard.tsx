"use client";

import Link from "next/link";
import { MapPin, CheckCircle2, Clock, RefreshCw, Heart, XCircle, Bookmark, AlertTriangle, Zap } from "lucide-react";
import { categoryLabel } from "@gohustlr/shared";
import Avatar from "./ui/Avatar";
import RatingStars from "./ui/RatingStars";
import StudentBadge from "./ui/StudentBadge";
import { useJobs } from "@/lib/jobs";
import { money, classNames } from "@/lib/format";
import { maskLocation, canSeeExactAddress } from "@/lib/address";
import type { Job, BookingStatus } from "@/lib/types";

// Muted, single-accent status pills — mirrors BOOKING_PILL in
// src/components/JobCard.js so a booked gig reads the same in both apps.
const BOOKING_PILL: Record<string, { label: string; Icon: typeof Clock; className: string }> = {
  pending: { label: "Applied — Pending", Icon: Clock, className: "bg-[#FFF7ED] text-[#D97706]" },
  confirmed: { label: "Confirmed — In Progress", Icon: CheckCircle2, className: "bg-[#ECFDF5] text-[#059669]" },
  completed: { label: "Awaiting Verification", Icon: RefreshCw, className: "bg-[#EFF6FF] text-[#2563EB]" },
  verified: { label: "Completed", Icon: Heart, className: "bg-[#F0FDF4] text-[#16A34A]" },
  declined: { label: "Declined", Icon: XCircle, className: "bg-[#FEF2F2] text-[#DC2626]" },
};

const RECUR_LABEL: Record<string, string> = { weekly: "Weekly", biweekly: "Biweekly", monthly: "Monthly" };

interface Props {
  job: Job;
  distanceLabel?: string | null;
  bookingStatus?: BookingStatus;
}

export default function JobCard({ job, distanceLabel, bookingStatus }: Props) {
  const { savedJobIds, toggleSavedJob } = useJobs();
  const pill = bookingStatus ? BOOKING_PILL[bookingStatus] : null;
  const saved = savedJobIds.has(job.id);

  // Same shape as mobile: an hourly gig shows the estimated TOTAL range rather
  // than the bare rate, and every amount goes through the shared formatter so a
  // $12.50/hr gig over 3 hours can't render as a raw float ("$37.5").
  const hours = job.estimatedHours || 1;
  const estPay =
    job.payType === "hourly"
      ? `${money(job.pay * hours)}–${money(job.pay * hours + job.pay)} est.`
      : `${money(job.pay)} flat`;

  // Category and recurrence are plain muted text, not colored chips — the
  // per-category rainbow was one of the AI-template tells mobile dropped.
  // Joined by filtering rather than a ternary: a gig can legitimately carry no
  // category now (transforms stopped defaulting a thin embed to "Odd Jobs"), and
  // the old shape rendered that as a leading " · Weekly".
  const meta = [categoryLabel(job.category || job.categorySlug), RECUR_LABEL[job.recurrence]]
    .filter(Boolean)
    .join(" · ");

  return (
    // The bookmark button is a SIBLING of the Link (not nested inside the anchor —
    // interactive-in-interactive is invalid HTML); the Link wraps the card body.
    // h-full so cards in one grid row share a height instead of ragged bottoms.
    // Hover deepens the shadow only — no lift, no ring. A translate-on-hover
    // card is a template flourish with no counterpart in the app.
    <div className="relative flex h-full overflow-hidden rounded-2xl bg-white shadow-[var(--shadow-card)] transition-shadow duration-150 hover:shadow-[var(--shadow-soft)]">
      <button
        onClick={() => toggleSavedJob(job.id)}
        className="absolute right-3 top-3 z-10 rounded-full bg-white/92 p-1.5 text-ink-muted transition hover:text-primary"
        aria-label={saved ? "Unsave gig" : "Save gig"}
      >
        <Bookmark className={saved ? "size-4 fill-primary text-primary" : "size-4"} />
      </button>

      <Link href={`/jobs/${job.id}`} className="flex min-w-0 flex-1 flex-col p-4">
        {job.photos?.length > 0 && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={job.photos[0]} alt="" className="mb-3 h-36 w-full rounded-xl bg-divider object-cover" />
        )}

        {pill && (
          // mr-8 clears the absolute bookmark button when the pill is the top element.
          <div
            className={classNames(
              "mb-2.5 mr-8 flex items-center justify-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-bold",
              pill.className,
            )}
          >
            <pill.Icon className="size-3.5 shrink-0" /> {pill.label}
          </div>
        )}

        <div className="mb-2 flex items-center justify-between gap-2 pr-7">
          <div className="flex min-w-0 items-center gap-2">
            {job.urgent && (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-urgent-light px-2 py-0.5 text-[11px] font-bold text-urgent">
                <Zap className="size-3" /> Urgent
              </span>
            )}
            <span className="truncate text-xs font-medium text-ink-muted">{meta}</span>
          </div>
          <span className="shrink-0 text-xs text-ink-muted">{job.postedAt}</span>
        </div>

        <h3 className="line-clamp-2 text-[17px] font-bold leading-[22px] tracking-[-0.2px] text-ink">{job.title}</h3>
        <p className="mt-1 line-clamp-2 text-[13.5px] leading-[19px] text-ink-soft">{job.description}</p>

        {job.tags?.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {job.tags.slice(0, 4).map((t) => (
              <span key={t} className="rounded-full bg-canvas px-2.5 py-1 text-[11px] font-medium text-ink-soft">
                #{t}
              </span>
            ))}
          </div>
        )}

        {job.hazards?.length > 0 && (
          <div className="mt-3 inline-flex items-center gap-1 text-[11px] font-bold text-urgent">
            <AlertTriangle className="size-3" />
            Safety notes
          </div>
        )}

        {/* mt-auto pins the money + poster rows to the bottom so cards of differing
            description lengths still line up across a grid row. */}
        <div className="mt-auto pt-3">
          <div className="flex items-center justify-between gap-2">
            <span className="shrink-0 text-[15px] font-bold text-ink">{estPay}</span>
            <span className="flex min-w-0 items-center gap-1 text-xs text-ink-muted">
              <MapPin className="size-3 shrink-0" />
              <span className="truncate">
                {canSeeExactAddress({ bookingStatus }) ? job.location : maskLocation(job.location)}
                {distanceLabel ? ` · ${distanceLabel}` : ""}
              </span>
            </span>
          </div>

          <div className="mt-3 flex items-center gap-1.5 border-t border-divider pt-2.5">
            <Avatar url={job.poster.avatarUrl} initial={job.poster.avatarInitial} name={job.poster.name} size={20} />
            {/* min-w-0 + truncate, or a long poster name evicts the rating stars
                past the card's overflow-hidden edge and they vanish. */}
            <span className="min-w-0 truncate text-xs font-semibold text-ink-soft">{job.poster.name}</span>
            {job.poster.verified && <CheckCircle2 className="size-3.5 shrink-0 text-success" />}
            {job.poster.studentVerified && <StudentBadge profile={job.poster} compact />}
            <span className="ml-auto shrink-0 pl-1">
              {job.poster.reviewCount > 0 ? (
                <RatingStars value={job.poster.rating} size={12} />
              ) : (
                <span className="text-[11px] font-semibold text-ink-muted">New</span>
              )}
            </span>
          </div>
        </div>
      </Link>
    </div>
  );
}
