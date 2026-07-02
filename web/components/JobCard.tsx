"use client";

import Link from "next/link";
import { CATEGORY_COLORS } from "@gohustlr/shared";
import { Zap, MapPin, Repeat, CheckCircle2, Clock, RefreshCw, Heart, XCircle, Bookmark, AlertTriangle } from "lucide-react";
import Avatar from "./ui/Avatar";
import RatingStars from "./ui/RatingStars";
import StudentBadge from "./ui/StudentBadge";
import { useJobs } from "@/lib/jobs";
import { payLabel, classNames } from "@/lib/format";
import type { Job, BookingStatus } from "@/lib/types";

const BOOKING_PILL: Record<string, { label: string; Icon: typeof Clock; className: string }> = {
  pending: { label: "Applied — Pending", Icon: Clock, className: "bg-accent-light text-accent-deep" },
  confirmed: { label: "Confirmed — In Progress", Icon: CheckCircle2, className: "bg-success/10 text-success" },
  completed: { label: "Awaiting Verification", Icon: RefreshCw, className: "bg-primary-light text-primary" },
  verified: { label: "Completed", Icon: Heart, className: "bg-success/10 text-success" },
  declined: { label: "Declined", Icon: XCircle, className: "bg-urgent-light text-urgent" },
};

const RECUR_LABEL: Record<string, string> = { weekly: "Weekly", biweekly: "Biweekly", monthly: "Monthly" };

interface Props {
  job: Job;
  distanceLabel?: string | null;
  bookingStatus?: BookingStatus;
}

export default function JobCard({ job, distanceLabel, bookingStatus }: Props) {
  const { savedJobIds, toggleSavedJob } = useJobs();
  const catColor = CATEGORY_COLORS[job.category] || "#3F25FE";
  const pill = bookingStatus ? BOOKING_PILL[bookingStatus] : null;
  const saved = savedJobIds.has(job.id);

  return (
    // The bookmark button is a SIBLING of the Link (not nested inside the anchor —
    // interactive-in-interactive is invalid HTML); the Link wraps the card body.
    <div className="group relative flex overflow-hidden rounded-2xl bg-white shadow-[var(--shadow-card)] ring-1 ring-line/70 transition hover:-translate-y-0.5 hover:shadow-[var(--shadow-soft)]">
      <button
        onClick={() => toggleSavedJob(job.id)}
        className="absolute right-3 top-3 z-10 rounded-full bg-white/90 p-1.5 text-ink-muted ring-1 ring-line backdrop-blur hover:text-primary"
        aria-label={saved ? "Unsave gig" : "Save gig"}
      >
        <Bookmark className={saved ? "size-4 fill-primary text-primary" : "size-4"} />
      </button>
      <Link href={`/jobs/${job.id}`} className="flex min-w-0 flex-1">
      <div className="w-1.5 shrink-0" style={{ backgroundColor: catColor }} />
      <div className="min-w-0 flex-1 p-5">
        {job.photos?.length > 0 && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={job.photos[0]} alt="" className="mb-3 h-36 w-full rounded-2xl object-cover" />
        )}

        {pill && (
          <div
            className={classNames(
              "mb-3 flex items-center justify-center gap-1.5 rounded-full px-2.5 py-1.5 text-xs font-bold",
              pill.className,
            )}
          >
            <pill.Icon className="size-3.5" /> {pill.label}
          </div>
        )}

        {job.urgent && (
          <span className="mb-2 inline-flex items-center gap-1 rounded-full bg-urgent-light px-2 py-0.5 text-[11px] font-extrabold tracking-wide text-urgent">
            <Zap className="size-3" /> URGENT
          </span>
        )}

        <div className="flex items-center justify-between gap-2 pr-8">
          <div className="flex items-center gap-1.5">
            <span className="rounded-full px-2 py-0.5 text-[11px] font-bold" style={{ backgroundColor: catColor + "22", color: catColor }}>
              {job.category}
            </span>
            {RECUR_LABEL[job.recurrence] && (
              <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-bold text-primary">
                <Repeat className="size-3" /> {RECUR_LABEL[job.recurrence]}
              </span>
            )}
          </div>
          <span className="shrink-0 text-[11px] text-ink-muted">{job.postedAt}</span>
        </div>

        <h3 className="mt-2 line-clamp-2 text-base font-extrabold leading-snug text-ink">{job.title}</h3>
        <p className="mt-1 line-clamp-2 text-sm text-ink-soft">{job.description}</p>

        {job.tags?.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {job.tags.slice(0, 4).map((t) => (
              <span key={t} className="rounded-full bg-canvas px-2 py-0.5 text-[11px] font-semibold text-ink-soft ring-1 ring-line">
                #{t}
              </span>
            ))}
          </div>
        )}

        {job.hazards?.length > 0 && (
          <div className="mt-2 inline-flex items-center gap-1 text-[11px] font-bold text-urgent">
            <AlertTriangle className="size-3.5" />
            Safety notes
          </div>
        )}

        <div className="mt-3 flex items-center gap-2">
          <span className="rounded-full bg-accent px-2.5 py-1 text-[13px] font-extrabold text-ink">
            {payLabel(job)}
            {job.payType === "hourly" ? "" : " flat"}
          </span>
          <MapPin className="size-3.5 shrink-0 text-ink-soft" />
          <span className="truncate text-xs text-ink-soft">
            {job.location}
            {distanceLabel ? ` · ${distanceLabel}` : ""}
          </span>
        </div>

        <div className="mt-3 flex items-center gap-2 border-t border-divider pt-3">
          <Avatar url={job.poster.avatarUrl} initial={job.poster.avatarInitial} name={job.poster.name} size={22} />
          <span className="truncate text-xs font-semibold text-ink-soft">{job.poster.name}</span>
          {job.poster.verified && <CheckCircle2 className="size-3.5 text-success" />}
          {job.poster.studentVerified && <StudentBadge profile={job.poster} compact />}
          <span className="ml-auto">
            {job.poster.reviewCount > 0 ? (
              <RatingStars value={job.poster.rating} size={13} />
            ) : (
              <span className="text-[11px] font-bold text-ink-muted">New</span>
            )}
          </span>
        </div>
      </div>
      </Link>
    </div>
  );
}
