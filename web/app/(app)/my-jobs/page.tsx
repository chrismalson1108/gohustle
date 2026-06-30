"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  Briefcase, MessageCircle, Check, Camera, X, FileText, Play,
  ChevronDown, Star, Clock, AlertCircle,
} from "lucide-react";
import { useJobs } from "@/lib/jobs";
import { useUser } from "@/lib/user";
import { useAuth } from "@/lib/auth";
import PageHeader, { PageContainer, EmptyState } from "@/components/PageHeader";
import StatusBadge from "@/components/ui/StatusBadge";
import Button, { buttonClasses } from "@/components/ui/Button";
import Modal from "@/components/ui/Modal";
import RatingStars from "@/components/ui/RatingStars";
import { Textarea } from "@/components/ui/Field";
import MoneyGoalCard from "@/components/MoneyGoalCard";
import WorkStatusBar from "@/components/WorkStatusBar";
import { uploadImages } from "@/lib/uploadImage";
import { money, classNames } from "@/lib/format";
import { computeEarnerInsights } from "@gohustlr/shared";
import type { Booking, BookingStatus } from "@/lib/types";

// Lifecycle buckets — mirror of mobile EarnScreen so web/mobile stay in parity.
const ACTIVE_STATUSES = new Set<BookingStatus>(["confirmed", "completed"]); // in progress / needs action
const AWAITING_STATUSES = new Set<BookingStatus>(["pending"]); // waiting on poster to accept
const COMPLETED_STATUSES = new Set<BookingStatus>(["verified", "declined", "cancelled"]); // finished / closed

type Tab = "active" | "awaiting" | "completed";
const SEGMENTS: { id: Tab; label: string }[] = [
  { id: "active", label: "Active" },
  { id: "awaiting", label: "Awaiting" },
  { id: "completed", label: "Completed" },
];

// A booking is "action-needed" when the next move in the lifecycle is the EARNER's.
const needsAction = (b: Booking) =>
  b.amendmentStatus === "pending" ||
  (b.status === "confirmed" && !b.earnerDone) ||
  (b.status === "verified" && !b.posterRating);

export default function MyJobsPage() {
  const { bookings, jobs, markEarnerDone, cancelBooking, ratePoster, respondToAmendment, startJob, getPayoutStatus } = useJobs();
  const { earningsToday, earningsWeek, earningsTotal, showToast } = useUser();
  const { user } = useAuth();

  const [tab, setTab] = useState<Tab>("active");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showMonth, setShowMonth] = useState(false);

  // Payout readiness — earners need a Connect account before they can be paid. Show a
  // reminder so they set it up before finishing a job (non-blocking; they can still apply).
  const [payoutReady, setPayoutReady] = useState(true); // optimistic until checked
  useEffect(() => {
    getPayoutStatus().then((s) => setPayoutReady(s.onboarded)).catch(() => {});
  }, [getPayoutStatus]);

  // Avg $/job over verified (paid-out) bookings — earnings only accrue on verify.
  const completedCount = bookings.filter((b) => b.status === "verified").length;
  const avgPerJob = completedCount ? earningsTotal / completedCount : 0;

  // Personal insights from this earner's own completed work (null until they have any).
  const insights = computeEarnerInsights(bookings);

  const [rateBooking, setRateBooking] = useState<Booking | null>(null);
  const [rating, setRating] = useState(5);
  const [reviewText, setReviewText] = useState("");
  const [busy, setBusy] = useState(false);

  // Finish (mark-done) sheet with optional before & after proof-of-work photos → completion-photos bucket.
  const [finishBooking, setFinishBooking] = useState<Booking | null>(null);
  const [beforePhotos, setBeforePhotos] = useState<string[]>([]);
  const [photos, setPhotos] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const beforeFileRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // ── Segment buckets ─────────────────────────────────────────────────────────
  const counts = {
    active: bookings.filter((b) => ACTIVE_STATUSES.has(b.status)).length,
    awaiting: bookings.filter((b) => AWAITING_STATUSES.has(b.status)).length,
    completed: bookings.filter((b) => COMPLETED_STATUSES.has(b.status)).length,
  };
  const set = tab === "active" ? ACTIVE_STATUSES : tab === "awaiting" ? AWAITING_STATUSES : COMPLETED_STATUSES;
  const shown = bookings
    .filter((b) => set.has(b.status))
    // In Active, float gigs that need the user's action to the top; keep a stable
    // secondary order so cards don't visibly reshuffle as state advances.
    .sort((a, b) => (tab === "active" ? Number(needsAction(b)) - Number(needsAction(a)) : 0));

  // Cross-segment nudges (Airbnb-style alert band): only render when there's a decision waiting.
  const pendingAmendments = bookings.filter((b) => b.amendmentStatus === "pending");
  const unrated = bookings.filter((b) => b.status === "verified" && !b.posterRating);

  const openFinish = (b: Booking) => {
    setFinishBooking(b);
    setBeforePhotos([]);
    setPhotos([]);
  };

  const addPhotos = async (files: FileList | null, kind: "before" | "after") => {
    if (!files?.length || !user) return;
    setUploading(true);
    try {
      const urls = await uploadImages(Array.from(files), "completion-photos", user.id);
      if (kind === "before") setBeforePhotos((p) => [...p, ...urls]);
      else setPhotos((p) => [...p, ...urls]);
    } catch {
      showToast({ icon: "⚠️", title: "Upload failed", message: "Couldn't add those photos." });
    }
    setUploading(false);
  };

  const submitFinish = async () => {
    if (!finishBooking) return;
    setBusy(true);
    await markEarnerDone(finishBooking.id, photos.length ? photos : null, beforePhotos.length ? beforePhotos : null);
    setBusy(false);
    setFinishBooking(null);
    showToast({ icon: "✅", title: "Marked done", message: "The poster will verify and release payment." });
  };

  const handleStart = async (b: Booking) => {
    const ok = await startJob(b.id);
    if (ok) showToast({ icon: "🚀", title: "You're on the clock", message: "The poster has been notified that you started." });
  };

  const respondAmend = async (b: Booking, accept: boolean) => {
    await respondToAmendment(b.id, accept);
    showToast(
      accept
        ? { icon: "✅", title: "Change accepted", message: "The poster can now update the gig terms." }
        : { icon: "❌", title: "Change declined", message: "The original terms stay in effect." },
    );
  };

  const openRate = (b: Booking) => {
    setRateBooking(b);
    setRating(5);
    setReviewText("");
  };

  const submitRate = async () => {
    if (!rateBooking) return;
    setBusy(true);
    await ratePoster(rateBooking.id, { rating, reviewText });
    setBusy(false);
    setRateBooking(null);
  };

  // ── Per-gig helpers ─────────────────────────────────────────────────────────
  const payLine = (b: Booking) => {
    const job = jobs.find((j) => j.id === b.jobId);
    const pay = money(b.counterOffer ?? b.job?.pay ?? job?.pay);
    return `${b.slotLabel || "Flexible"} · ${pay}${b.tipAmount > 0 ? ` · +${money(b.tipAmount)} tip` : ""}`;
  };
  const titleOf = (b: Booking) => b.job?.title || jobs.find((j) => j.id === b.jobId)?.title || "Gig";

  // A demoted, secondary "Message" affordance (jumps to the messages hub).
  const MessageBtn = () => (
    <Link href="/messages" className={buttonClasses("secondary", "sm")}>
      <MessageCircle className="size-4" /> Message
    </Link>
  );

  // The single, state-derived primary action + demoted secondary controls for a gig.
  function GigActions({ b }: { b: Booking }) {
    if (b.status === "pending") {
      return (
        <div className="mt-3 flex items-center justify-between gap-2">
          <MessageBtn />
          <button className="text-sm font-bold text-urgent hover:underline" onClick={() => cancelBooking(b.id)}>
            Withdraw
          </button>
        </div>
      );
    }

    if (b.status === "confirmed" && !b.startedAt && !b.earnerDone) {
      return (
        <div className="mt-3">
          <Button fullWidth onClick={() => handleStart(b)}>
            <Play className="size-4" /> Start job · I&apos;m on site
          </Button>
          <p className="mt-1.5 text-xs text-ink-muted">Next: tap when you arrive on site.</p>
          <div className="mt-2 flex items-center justify-between gap-2">
            <MessageBtn />
            <button className="text-sm font-bold text-urgent hover:underline" onClick={() => cancelBooking(b.id)}>
              Cancel
            </button>
          </div>
        </div>
      );
    }

    if (b.status === "confirmed" && b.startedAt && !b.earnerDone) {
      return (
        <div className="mt-3">
          <span className="mb-2 inline-flex items-center gap-1.5 text-xs font-bold text-success">
            <span className="size-2 rounded-full bg-success" /> In progress
          </span>
          <Button fullWidth onClick={() => openFinish(b)}>
            <Check className="size-4" /> Mark done
          </Button>
          <p className="mt-1.5 text-xs text-ink-muted">Next: mark the job done when you&apos;ve finished.</p>
          <div className="mt-2 flex items-center justify-between gap-2">
            <MessageBtn />
            <span className="text-xs italic text-ink-muted">
              Can&apos;t cancel — you&apos;ve started. Open a dispute if there&apos;s a problem.
            </span>
          </div>
        </div>
      );
    }

    // Passive waiting states — earner has nothing to do; de-emphasize.
    if (b.status === "confirmed" && b.earnerDone && !b.posterDone) {
      return (
        <div className="mt-3 flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-ink-muted">You marked done — waiting for the poster to confirm.</span>
          <MessageBtn />
        </div>
      );
    }
    if (b.status === "completed") {
      return (
        <div className="mt-3 flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-ink-muted">Waiting for the poster to verify &amp; pay.</span>
          <MessageBtn />
        </div>
      );
    }
    return null;
  }

  // Amendment block — a change request requires a decision, so it stays inline.
  function AmendmentBlock({ b }: { b: Booking }) {
    if (b.amendmentStatus === "pending") {
      return (
        <div className="mt-3 rounded-2xl border border-primary/30 bg-primary-light/40 p-3">
          <div className="flex items-center gap-1.5 text-sm font-bold text-primary">
            <FileText className="size-4" /> Change proposed by poster
          </div>
          {b.amendmentNote && <p className="mt-1 text-sm text-ink-soft">{b.amendmentNote}</p>}
          <p className="mt-1 text-xs text-ink-muted">Accepting lets the poster update the gig terms.</p>
          <div className="mt-2.5 flex gap-2">
            <Button size="sm" onClick={() => respondAmend(b, true)}>
              <Check className="size-4" /> Accept
            </Button>
            <Button size="sm" variant="outline" className="text-urgent" onClick={() => respondAmend(b, false)}>
              <X className="size-4" /> Decline
            </Button>
          </div>
        </div>
      );
    }
    if (b.amendmentStatus === "accepted") {
      return <p className="mt-3 rounded-xl bg-success/10 px-3 py-2 text-xs font-bold text-success">Change accepted — the poster can update the terms.</p>;
    }
    if (b.amendmentStatus === "declined") {
      return <p className="mt-3 rounded-xl bg-urgent/10 px-3 py-2 text-xs font-bold text-urgent">Change declined — original terms remain.</p>;
    }
    return null;
  }

  // Card chrome by role: actionable gigs stand out (accent left border), passive ones recede (canvas).
  const cardClass = (b: Booking) => {
    if (needsAction(b)) {
      const gold = b.status === "verified" && !b.posterRating;
      return classNames(
        "rounded-2xl bg-white p-4 shadow-[var(--shadow-card)] ring-1 ring-line/70 border-l-4",
        gold ? "border-accent" : "border-primary",
      );
    }
    const passive =
      (b.status === "confirmed" && b.earnerDone && !b.posterDone) || b.status === "completed";
    if (passive) return "rounded-2xl bg-canvas p-4 ring-1 ring-line/60";
    return "rounded-2xl bg-white p-4 shadow-[var(--shadow-card)] ring-1 ring-line/70";
  };

  return (
    <div>
      <PageHeader title="My Jobs" subtitle="Gigs you've booked" variant="earn">
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className="inline-flex items-baseline gap-1.5 rounded-full bg-white/15 px-4 py-2">
            <span className="text-lg font-black leading-none">{money(earningsWeek)}</span>
            <span className="text-xs font-semibold text-white/75">this week</span>
          </span>
        </div>
      </PageHeader>

      <PageContainer className="space-y-4">
        {/* Payout reminder — earners must set up payouts to receive money. Non-blocking. */}
        {!payoutReady && (
          <Link
            href="/profile/payouts"
            className="flex items-center gap-2.5 rounded-2xl bg-urgent-light px-4 py-3 ring-1 ring-urgent/20 transition hover:bg-urgent-light/70"
          >
            <AlertCircle className="size-5 shrink-0 text-urgent" />
            <span className="flex-1 text-sm font-bold text-urgent">Set up payouts so you can get paid for your work.</span>
            <span className="shrink-0 text-sm font-extrabold text-urgent">Set up →</span>
          </Link>
        )}

        {/* Action-needed band — only appears when a decision is waiting. */}
        {(pendingAmendments.length > 0 || (unrated.length > 0 && tab !== "completed")) && (
          <div className="space-y-2">
            {pendingAmendments.length > 0 && (
              <button
                onClick={() => setTab("active")}
                className="flex w-full items-center gap-2.5 rounded-2xl bg-primary-light px-4 py-3 text-left ring-1 ring-primary/20 transition hover:bg-primary-light/70"
              >
                <FileText className="size-5 shrink-0 text-primary" />
                <span className="flex-1 text-sm font-bold text-primary">
                  {pendingAmendments.length} change {pendingAmendments.length === 1 ? "request" : "requests"} to respond to
                </span>
                <ChevronDown className="size-4 -rotate-90 text-primary" />
              </button>
            )}
            {unrated.length > 0 && tab !== "completed" && (
              <button
                onClick={() => setTab("completed")}
                className="flex w-full items-center gap-2.5 rounded-2xl bg-accent-light px-4 py-3 text-left ring-1 ring-accent/30 transition hover:brightness-[0.98]"
              >
                <Star className="size-5 shrink-0 text-accent-deep" />
                <span className="flex-1 text-sm font-bold text-accent-deep">
                  Rate {unrated.length} completed {unrated.length === 1 ? "gig" : "gigs"} to finish up
                </span>
                <ChevronDown className="size-4 -rotate-90 text-accent-deep" />
              </button>
            )}
          </div>
        )}

        {/* Segmented control — the spine of the page. */}
        <div className="flex gap-1 rounded-2xl bg-white p-1 shadow-[var(--shadow-card)] ring-1 ring-line/70">
          {SEGMENTS.map((s) => (
            <button
              key={s.id}
              onClick={() => setTab(s.id)}
              className={classNames(
                "flex-1 rounded-xl py-2 text-sm font-bold transition",
                tab === s.id ? "bg-primary text-white shadow-[var(--shadow-soft)]" : "text-ink-soft hover:bg-primary-light/40",
              )}
            >
              {s.label}
              {counts[s.id] > 0 ? ` (${counts[s.id]})` : ""}
            </button>
          ))}
        </div>

        {/* The booked-gig list — the primary content. */}
        {shown.length === 0 ? (
          <EmptyState
            icon={tab === "awaiting" ? <Clock className="size-10" /> : <Briefcase className="size-10" />}
            title={tab === "active" ? "No active jobs" : tab === "awaiting" ? "Nothing awaiting" : "No completed jobs yet"}
            body={
              tab === "active"
                ? "Gigs you're actively working show up here. Find one on Browse to get started."
                : tab === "awaiting"
                  ? "Gigs you've applied to — waiting on the poster to accept — appear here."
                  : "Completed and closed gigs will show up here."
            }
          />
        ) : tab === "completed" ? (
          // Completed history: collapsed one-line rows that expand on tap.
          <div className="space-y-3">
            {shown.map((b) => {
              const expanded = expandedId === b.id;
              const canRate = b.status === "verified" && !b.posterRating;
              return (
                <div
                  key={b.id}
                  className={classNames(
                    "overflow-hidden rounded-2xl bg-white shadow-[var(--shadow-card)] ring-1 ring-line/70",
                    canRate && "border-l-4 border-accent",
                  )}
                >
                  <div className="flex items-center gap-3 px-4 py-3">
                    <Link href={`/jobs/${b.jobId}`} className="min-w-0 flex-1">
                      <p className="truncate font-bold text-ink">{titleOf(b)}</p>
                      <p className="truncate text-sm text-ink-soft">{payLine(b)}</p>
                    </Link>
                    <StatusBadge status={b.status} />
                    {canRate && (
                      <Button size="sm" onClick={() => openRate(b)}>
                        <Star className="size-4" /> Rate
                      </Button>
                    )}
                    <button
                      onClick={() => setExpandedId(expanded ? null : b.id)}
                      className="rounded-full p-1 text-ink-muted hover:bg-line/60"
                      aria-label={expanded ? "Collapse" : "Expand"}
                    >
                      <ChevronDown className={classNames("size-5 transition", expanded && "rotate-180")} />
                    </button>
                  </div>
                  {expanded && (
                    <div className="space-y-3 border-t border-divider px-4 py-3">
                      {b.posterRating ? (
                        <p className="text-sm font-bold text-success">You rated the poster {b.posterRating}★</p>
                      ) : null}
                      {b.earnerRating ? (
                        <div className="rounded-xl bg-success-light px-3 py-2">
                          <div className="flex items-center gap-1.5">
                            <RatingStars value={b.earnerRating} size={14} />
                            <span className="text-sm font-bold text-success">
                              {b.earnerRating.toFixed(1)} from poster
                              {b.paymentMethod ? ` · Paid via ${b.paymentMethod}` : ""}
                            </span>
                          </div>
                          {b.reviewText ? <p className="mt-1 text-sm italic text-ink-soft">&ldquo;{b.reviewText}&rdquo;</p> : null}
                        </div>
                      ) : null}
                      {(b.beforePhotos?.length > 0 || b.completionPhotos?.length > 0) && (
                        <div className="space-y-2">
                          {b.beforePhotos?.length > 0 && <PhotoStrip label="Before" urls={b.beforePhotos} />}
                          {b.completionPhotos?.length > 0 && <PhotoStrip label="After" urls={b.completionPhotos} />}
                        </div>
                      )}
                      {!b.posterRating && !b.earnerRating && b.beforePhotos?.length === 0 && b.completionPhotos?.length === 0 && (
                        <p className="text-sm text-ink-muted">No additional details for this gig.</p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          // Active / Awaiting: full cards with one state-derived primary action.
          <div className="space-y-3">
            {shown.map((b) => (
              <div key={b.id} className={cardClass(b)}>
                <div className="flex items-start justify-between gap-3">
                  <Link href={`/jobs/${b.jobId}`} className="min-w-0">
                    <p className="truncate font-bold text-ink">{titleOf(b)}</p>
                    <p className="mt-0.5 text-sm text-ink-soft">{payLine(b)}</p>
                  </Link>
                  <StatusBadge status={b.status} />
                </div>
                <AmendmentBlock b={b} />
                <GigActions b={b} />
              </div>
            ))}
          </div>
        )}

        {/* "Your month" — earnings, goal, insights & status, demoted below the gigs. */}
        <div>
          <button
            onClick={() => setShowMonth((v) => !v)}
            className="flex w-full items-center justify-between rounded-2xl bg-white px-4 py-3 shadow-[var(--shadow-card)] ring-1 ring-line/70 transition hover:bg-canvas"
          >
            <span className="flex items-center gap-2 font-bold text-ink">
              <AlertCircle className="size-4 text-ink-muted" /> Your month
            </span>
            <ChevronDown className={classNames("size-5 text-ink-muted transition", showMonth && "rotate-180")} />
          </button>

          {showMonth && (
            <div className="mt-3 space-y-3">
              <MoneyGoalCard />

              <div className="rounded-2xl bg-white p-4 shadow-[var(--shadow-card)] ring-1 ring-line/70">
                <p className="mb-3 text-xs font-bold uppercase tracking-wide text-ink-muted">Earnings</p>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {[
                    { label: "Today", value: money(earningsToday) },
                    { label: "This week", value: money(earningsWeek) },
                    { label: "All time", value: money(earningsTotal) },
                    { label: "Avg / job", value: completedCount ? money(avgPerJob) : "—" },
                  ].map((s) => (
                    <div key={s.label} className="rounded-xl bg-canvas px-3 py-2.5 text-center">
                      <p className="text-base font-black text-ink">{s.value}</p>
                      <p className="text-[11px] text-ink-muted">{s.label}</p>
                    </div>
                  ))}
                </div>
              </div>

              {insights && insights.jobCount > 0 && (
                <div className="rounded-2xl bg-white p-4 shadow-[var(--shadow-card)] ring-1 ring-line/70">
                  <p className="mb-3 text-xs font-bold uppercase tracking-wide text-ink-muted">Your insights</p>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                    <div className="rounded-xl bg-primary-light/40 px-3 py-2.5">
                      <p className="text-[11px] font-semibold text-ink-muted">Top area</p>
                      <p className="mt-0.5 truncate font-bold text-ink">{insights.topArea?.label ?? "—"}</p>
                    </div>
                    <div className="rounded-xl bg-primary-light/40 px-3 py-2.5">
                      <p className="text-[11px] font-semibold text-ink-muted">Busiest day</p>
                      <p className="mt-0.5 truncate font-bold text-ink">{insights.busiestDay?.label ?? "—"}</p>
                    </div>
                    <div className="rounded-xl bg-primary-light/40 px-3 py-2.5">
                      <p className="text-[11px] font-semibold text-ink-muted">Best day</p>
                      <p className="mt-0.5 truncate font-bold text-ink">
                        {insights.mostProfitableDay
                          ? `${insights.mostProfitableDay.label} (${money(insights.mostProfitableDay.total)})`
                          : "—"}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              <WorkStatusBar />
            </div>
          )}
        </div>
      </PageContainer>

      <Modal
        open={!!rateBooking}
        onClose={() => setRateBooking(null)}
        title="Rate the poster"
        footer={
          <Button fullWidth size="lg" loading={busy} onClick={submitRate}>
            Submit rating
          </Button>
        }
      >
        <p className="mb-3 text-sm text-ink-soft">How was working with this poster?</p>
        <RatingStars value={rating} size={34} onChange={setRating} />
        <Textarea className="mt-4 min-h-[90px]" value={reviewText} onChange={(e) => setReviewText(e.target.value)} placeholder="Share a few words (optional)" />
      </Modal>

      <Modal
        open={!!finishBooking}
        onClose={() => setFinishBooking(null)}
        title="Mark gig complete"
        footer={
          <Button fullWidth size="lg" loading={busy} onClick={submitFinish}>
            Mark complete
          </Button>
        }
      >
        <p className="text-sm text-ink-soft">Add before &amp; after photos of the finished work (optional) so the poster can verify and release payment.</p>

        <p className="mt-4 text-xs font-bold uppercase tracking-wide text-ink-muted">Before photos (optional)</p>
        <input ref={beforeFileRef} type="file" accept="image/*" multiple hidden onChange={(e) => { addPhotos(e.target.files, "before"); e.target.value = ""; }} />
        {beforePhotos.length > 0 && (
          <div className="mt-2 grid grid-cols-3 gap-2">
            {beforePhotos.map((url, i) => (
              <div key={url} className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={url} alt="" className="aspect-square w-full rounded-xl object-cover ring-1 ring-line" />
                <button
                  onClick={() => setBeforePhotos((p) => p.filter((_, j) => j !== i))}
                  className="absolute -right-1.5 -top-1.5 flex size-6 items-center justify-center rounded-full bg-ink text-white"
                  aria-label="Remove photo"
                >
                  <X className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
        <button
          onClick={() => beforeFileRef.current?.click()}
          disabled={uploading}
          className="mt-2 flex w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-line py-3 text-sm font-bold text-ink-soft hover:border-primary hover:text-primary disabled:opacity-50"
        >
          <Camera className="size-4" /> {uploading ? "Uploading…" : "Add photos"}
        </button>

        <p className="mt-4 text-xs font-bold uppercase tracking-wide text-ink-muted">After photos (optional)</p>
        <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => { addPhotos(e.target.files, "after"); e.target.value = ""; }} />
        {photos.length > 0 && (
          <div className="mt-2 grid grid-cols-3 gap-2">
            {photos.map((url, i) => (
              <div key={url} className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={url} alt="" className="aspect-square w-full rounded-xl object-cover ring-1 ring-line" />
                <button
                  onClick={() => setPhotos((p) => p.filter((_, j) => j !== i))}
                  className="absolute -right-1.5 -top-1.5 flex size-6 items-center justify-center rounded-full bg-ink text-white"
                  aria-label="Remove photo"
                >
                  <X className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
        <button
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          className="mt-2 flex w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-line py-3 text-sm font-bold text-ink-soft hover:border-primary hover:text-primary disabled:opacity-50"
        >
          <Camera className="size-4" /> {uploading ? "Uploading…" : "Add photos"}
        </button>
      </Modal>
    </div>
  );
}

// Horizontal thumbnail strip used in the expanded Completed row.
function PhotoStrip({ label, urls }: { label: string; urls: string[] }) {
  return (
    <div>
      <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-ink-muted">{label}</p>
      <div className="flex gap-2 overflow-x-auto">
        {urls.map((u) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img key={u} src={u} alt="" className="size-16 shrink-0 rounded-xl object-cover ring-1 ring-line" />
        ))}
      </div>
    </div>
  );
}
