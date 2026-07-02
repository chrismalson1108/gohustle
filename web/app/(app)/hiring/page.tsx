"use client";

import { useState } from "react";
import Link from "next/link";
import { Megaphone, Plus, Check, X, MessageCircle, ShieldCheck, Pencil, Copy, ArrowUpToLine, FileText, Star, History, AlertCircle } from "lucide-react";
import { skillFitScore } from "@gohustlr/shared";
import { useJobs } from "@/lib/jobs";
import { useUser } from "@/lib/user";
import PageHeader, { PageContainer, EmptyState } from "@/components/PageHeader";
import StatusBadge from "@/components/ui/StatusBadge";
import StudentBadge from "@/components/ui/StudentBadge";
import Avatar from "@/components/ui/Avatar";
import RatingStars from "@/components/ui/RatingStars";
import Button, { buttonClasses } from "@/components/ui/Button";
import Modal from "@/components/ui/Modal";
import { Textarea } from "@/components/ui/Field";
import CompletionModal, { type VerifyArgs } from "@/components/CompletionModal";
import AcceptPaymentModal from "@/components/AcceptPaymentModal";
import { classNames, money, payLabel } from "@/lib/format";
import type { Booking, Job } from "@/lib/types";

const ACTIVE_STATUSES = new Set<Booking["status"]>(["pending", "confirmed", "completed"]);
const PAST_STATUSES = new Set<Booking["status"]>(["verified", "declined", "cancelled"]);

// A posted job, or a recovered stand-in for a soft-cancelled gig that still has
// active bookings (mirrors mobile GigsScreen's "phantom" jobs).
type HiringJob = Job & { removed?: boolean };

// Applicant sort options for a gig's request list.
const APPLICANT_SORTS = [
  { id: "newest", label: "Newest" },
  { id: "wage", label: "Wage" },
  { id: "rating", label: "Rating" },
  { id: "fit", label: "Fit" },
] as const;
type ApplicantSort = (typeof APPLICANT_SORTS)[number]["id"];

// Sort one gig's applicant bookings by the chosen key. Returns a new array; the
// default "newest" keeps the incoming (created-desc) order untouched.
function sortApplicants(reqs: Booking[], job: Job, sortBy: ApplicantSort): Booking[] {
  if (sortBy === "newest") return reqs;
  const wage = (b: Booking) => b.counterOffer ?? job.pay;
  const copy = [...reqs];
  if (sortBy === "wage") copy.sort((a, b) => wage(a) - wage(b)); // cheapest first
  else if (sortBy === "rating") copy.sort((a, b) => (b.earner?.rating ?? 0) - (a.earner?.rating ?? 0));
  else if (sortBy === "fit") copy.sort((a, b) => skillFitScore(job, b.earner?.skills) - skillFitScore(job, a.earner?.skills));
  return copy;
}

export default function HiringPage() {
  const { postedJobs, posterBookings, acceptBooking, declineBooking, cancelBooking, cancellationFeeFor, markPosterDone, verifyAndRate, bumpJob, proposeAmendment } = useJobs();
  const { showToast } = useUser();
  const [tab, setTab] = useState<"active" | "past">("active");
  const [verifyBooking, setVerifyBooking] = useState<Booking | null>(null);
  const [payBooking, setPayBooking] = useState<Booking | null>(null);
  const [sortBy, setSortBy] = useState<ApplicantSort>("newest");
  const [amendTarget, setAmendTarget] = useState<Booking | null>(null);
  const [amendNote, setAmendNote] = useState("");
  const [amendBusy, setAmendBusy] = useState(false);
  // Cancellation-fee confirm (display/record only — no money moves).
  const [cancelTarget, setCancelTarget] = useState<Booking | null>(null);
  const [cancelBusy, setCancelBusy] = useState(false);
  const cancelFee = cancelTarget ? cancellationFeeFor(cancelTarget.id) : 0;

  // The amount held on the poster's card for the booking being verified — mirrors the
  // server's escrow math (counter-offer ?? listed pay, × hours for hourly). Shown in the
  // verify modal so the poster sees exactly what's released to the earner.
  const verifyHeldCents = (() => {
    if (!verifyBooking) return 0;
    const fullJob = postedJobs.find((j) => j.id === verifyBooking.jobId);
    const baseRate = verifyBooking.counterOffer ?? Number(fullJob?.pay ?? verifyBooking.job?.pay ?? 0);
    const isHourly = (fullJob?.payType ?? verifyBooking.job?.payType) === "hourly";
    const hours = isHourly ? fullJob?.estimatedHours || 1 : 1;
    return Math.round(Number(baseRate) * hours * 100);
  })();

  // Past = completed/declined booking history (read-only)
  const pastBookings = posterBookings.filter((b) => PAST_STATUSES.has(b.status));

  // Active list = open listings + any gig that still has active bookings, including
  // gigs the poster deleted but that have unresolved bookings. Without this, those
  // bookings are invisible yet still counted in the tab badge ("ghost" count).
  const postedById = new Set(postedJobs.map((j) => j.id));
  const orphanIds = [...new Set(posterBookings.filter((b) => ACTIVE_STATUSES.has(b.status) && !postedById.has(b.jobId)).map((b) => b.jobId))];
  const phantomJobs = orphanIds.map((id) => {
    const b = posterBookings.find((x) => x.jobId === id);
    return {
      id,
      title: b?.job?.title || "Removed gig",
      pay: b?.job?.pay ?? 0,
      payType: b?.job?.payType ?? "flat",
      location: "Gig removed",
      status: "cancelled",
      removed: true,
    } as HiringJob;
  });
  const activeJobs: HiringJob[] = [...postedJobs, ...phantomJobs];

  const confirmCancel = async () => {
    if (!cancelTarget) return;
    setCancelBusy(true);
    const fee = cancelFee;
    await cancelBooking(cancelTarget.id);
    setCancelBusy(false);
    setCancelTarget(null);
    showToast(
      fee > 0
        ? { icon: "❌", title: "Booking cancelled", message: `A $${fee} cancellation fee was recorded.` }
        : { icon: "❌", title: "Booking cancelled", message: "The payment hold was released." },
    );
  };

  const onVerify = async (args: VerifyArgs) => {
    if (!verifyBooking) return;
    try {
      await verifyAndRate(verifyBooking.id, args);
    } catch (e) {
      showToast({ icon: "⚠️", title: "Couldn't verify", message: (e as Error)?.message || "Please try again." });
      throw e; // keep the modal open so the poster can retry
    }
  };

  const submitAmendment = async () => {
    if (!amendTarget || !amendNote.trim()) return;
    setAmendBusy(true);
    await proposeAmendment(amendTarget.id, amendNote.trim());
    setAmendBusy(false);
    const earnerName = amendTarget.earner?.name || "The earner";
    setAmendTarget(null);
    setAmendNote("");
    showToast({ icon: "📝", title: "Change requested", message: `${earnerName} will be asked to approve or decline.` });
  };

  return (
    <div>
      <PageHeader
        title="Hiring"
        subtitle="Gigs you've posted"
        right={
          <Link href="/hiring/new" className={buttonClasses("secondary", "sm", "bg-white text-primary hover:bg-white")}>
            <Plus className="size-4" /> Post
          </Link>
        }
      />
      <PageContainer>
        {/* Active / Past segmented control */}
        <div className="mb-4 flex gap-1 rounded-2xl bg-white p-1 shadow-[var(--shadow-card)] ring-1 ring-line/70">
          {(["active", "past"] as const).map((t) => {
            const count = t === "active" ? activeJobs.length : pastBookings.length;
            return (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={classNames(
                  "flex-1 rounded-xl py-2 text-sm font-bold capitalize transition",
                  tab === t ? "bg-primary text-white shadow-[var(--shadow-soft)]" : "text-ink-soft hover:bg-primary-light/40",
                )}
              >
                {t}
                {count > 0 ? ` (${count})` : ""}
              </button>
            );
          })}
        </div>

        {/* ===== ACTIVE: posted listings + current bookings ===== */}
        {tab === "active" && (activeJobs.length === 0 ? (
          <EmptyState icon={<Megaphone className="size-10" />} title="You haven't posted any gigs" body="Post a gig to get help from students near you." />
        ) : (
          <div className="space-y-4">
            {activeJobs.map((job) => {
              const reqs = sortApplicants(posterBookings.filter((b) => b.jobId === job.id && ACTIVE_STATUSES.has(b.status)), job, sortBy);
              return (
                <div key={job.id} className="rounded-2xl bg-white p-4 shadow-[var(--shadow-card)] ring-1 ring-line/70">
                  <div className="flex items-center justify-between gap-3">
                    {job.removed ? (
                      <div className="min-w-0">
                        <p className="truncate font-bold text-ink">{job.title}</p>
                        <p className="text-sm text-ink-soft">
                          {payLabel(job)} · {reqs.length} request{reqs.length !== 1 ? "s" : ""}
                        </p>
                      </div>
                    ) : (
                      <Link href={`/jobs/${job.id}`} className="min-w-0">
                        <p className="truncate font-bold text-ink">{job.title}</p>
                        <p className="text-sm text-ink-soft">
                          {payLabel(job)} · {reqs.length} request{reqs.length !== 1 ? "s" : ""}
                        </p>
                      </Link>
                    )}
                    {/* Job actions — hidden for removed gigs */}
                    {job.removed ? (
                      <span className="inline-flex shrink-0 items-center gap-1.5 text-xs font-bold text-accent-deep">
                        <AlertCircle className="size-3.5" /> Gig removed — resolve the bookings below.
                      </span>
                    ) : (
                      <div className="flex shrink-0 gap-2">
                        <button
                          onClick={() => { bumpJob(job.id); showToast({ icon: "🚀", title: "Bumped!", message: "Your gig jumped to the top of Browse." }); }}
                          className={buttonClasses("ghost", "sm")}
                          title="Bump to top of the feed"
                        >
                          <ArrowUpToLine className="size-3.5" /> Bump
                        </button>
                        <Link href={`/hiring/${job.id}/edit`} className={buttonClasses("outline", "sm")}>
                          <Pencil className="size-3.5" /> Edit
                        </Link>
                        <Link href={`/hiring/new?from=${job.id}`} className={buttonClasses("outline", "sm")} title="Post a copy of this gig">
                          <Copy className="size-3.5" /> Duplicate
                        </Link>
                      </div>
                    )}
                  </div>

                  {reqs.length > 1 && (
                    <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-divider pt-3">
                      <span className="mr-0.5 text-xs font-bold text-ink-muted">Sort:</span>
                      {APPLICANT_SORTS.map((s) => (
                        <button
                          key={s.id}
                          onClick={() => setSortBy(s.id)}
                          className={
                            sortBy === s.id
                              ? "rounded-full bg-primary px-2.5 py-1 text-xs font-bold text-white shadow-[var(--shadow-soft)]"
                              : "rounded-full bg-canvas px-2.5 py-1 text-xs font-bold text-ink-soft ring-1 ring-line/70 hover:bg-primary-light/40"
                          }
                        >
                          {s.label}
                        </button>
                      ))}
                    </div>
                  )}

                  {reqs.length > 0 && (
                    <div className={`space-y-3 ${reqs.length > 1 ? "mt-3" : "mt-3 border-t border-divider pt-3"}`}>
                      {reqs.map((b) => (
                        <div key={b.id} className="rounded-2xl bg-canvas p-3">
                          <div className="flex items-center gap-2.5">
                            <Link href={b.earner?.id ? `/u/${b.earner.id}` : "#"} className="shrink-0">
                              <Avatar url={b.earner?.avatarUrl} initial={b.earner?.avatarInitial} name={b.earner?.name} size={36} />
                            </Link>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5">
                                <Link
                                  href={b.earner?.id ? `/u/${b.earner.id}` : "#"}
                                  className="truncate text-sm font-bold text-ink hover:text-primary hover:underline"
                                >
                                  {b.earner?.name || "Someone"}
                                </Link>
                                {b.earner?.studentVerified && <StudentBadge profile={b.earner} compact />}
                                {b.earner?.reviewCount ? (
                                  <span className="inline-flex items-center gap-0.5 text-xs font-semibold text-ink-soft">
                                    <Star className="size-3 fill-gold text-gold" /> {Number(b.earner.rating).toFixed(1)}
                                  </span>
                                ) : (
                                  <span className="text-xs text-ink-muted">New</span>
                                )}
                              </div>
                              <p className="text-xs text-ink-muted">
                                {b.slotLabel || "Flexible"}
                                {b.counterOffer ? ` · counter-offer ${money(b.counterOffer)}` : ""}
                              </p>
                            </div>
                            <StatusBadge status={b.status} />
                          </div>

                          {b.applicationNote && (
                            <p className="mt-2 border-l-2 border-line pl-2.5 text-xs italic text-ink-soft">
                              &ldquo;{b.applicationNote}&rdquo;
                            </p>
                          )}

                          {/* Actions */}
                          <div className="mt-2.5 flex flex-wrap gap-2">
                            {b.status === "pending" && (
                              <>
                                <Button size="sm" onClick={() => setPayBooking(b)}>
                                  <Check className="size-4" /> Accept
                                </Button>
                                <Button size="sm" variant="outline" className="text-urgent" onClick={() => declineBooking(b.id)}>
                                  <X className="size-4" /> Decline
                                </Button>
                              </>
                            )}
                            {b.status === "confirmed" && (
                              <>
                                {b.startedAt && (
                                  <span className="inline-flex items-center gap-1.5 self-center text-xs font-bold text-success">
                                    <span className="size-2 rounded-full bg-success" /> In progress
                                  </span>
                                )}
                                {!b.posterDone && (
                                  <Button size="sm" onClick={() => markPosterDone(b.id)}>
                                    Mark done
                                  </Button>
                                )}
                                <Link href={`/messages?booking=${b.id}`} className={buttonClasses("secondary", "sm")}>
                                  <MessageCircle className="size-4" /> Message
                                </Link>
                                {!b.startedAt ? (
                                  <Button size="sm" variant="ghost" className="text-urgent" onClick={() => setCancelTarget(b)}>
                                    Cancel
                                  </Button>
                                ) : (
                                  <span className="self-center text-xs italic text-ink-muted">
                                    Can&apos;t cancel — the worker has started. Open a dispute if there&apos;s a problem.
                                  </span>
                                )}
                                {b.earnerDone && <span className="self-center text-xs font-bold text-success">Earner marked done ✓</span>}
                              </>
                            )}
                            {b.status === "completed" && (
                              <Button size="sm" onClick={() => setVerifyBooking(b)}>
                                <ShieldCheck className="size-4" /> Verify &amp; rate
                              </Button>
                            )}
                          </div>

                          {(b.status === "confirmed" || b.status === "completed") && b.amendmentStatus === "none" && (
                            <button
                              onClick={() => { setAmendTarget(b); setAmendNote(""); }}
                              className="mt-2 flex items-center gap-1.5 text-xs font-bold text-primary hover:underline"
                            >
                              <FileText className="size-3.5" /> Request a change to the terms
                            </button>
                          )}
                          {b.amendmentStatus === "pending" && (
                            <p className="mt-2 rounded-xl bg-primary-light/50 px-3 py-2 text-xs font-semibold text-primary">
                              Change requested — waiting for {b.earner?.name || "the earner"} to approve.
                            </p>
                          )}
                          {b.amendmentStatus === "accepted" && (
                            <div className="mt-2 flex flex-wrap items-center gap-2 rounded-xl bg-success/10 px-3 py-2">
                              <span className="text-xs font-bold text-success">Change approved — you can edit the gig terms.</span>
                              <Link href={`/hiring/${job.id}/edit`} className={buttonClasses("outline", "sm")}>
                                <Pencil className="size-3.5" /> Edit terms
                              </Link>
                            </div>
                          )}
                          {b.amendmentStatus === "declined" && (
                            <p className="mt-2 rounded-xl bg-urgent/10 px-3 py-2 text-xs font-bold text-urgent">
                              {b.earner?.name || "The earner"} declined the change — original terms remain.
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}

        {/* ===== PAST: completed / declined history (read-only) ===== */}
        {tab === "past" && (pastBookings.length === 0 ? (
          <EmptyState icon={<History className="size-10" />} title="No past gigs yet" body="Completed and declined bookings will show up here." />
        ) : (
          <div className="space-y-3">
            {pastBookings.map((b) => (
              <PastBookingCard key={b.id} booking={b} />
            ))}
          </div>
        ))}
      </PageContainer>

      <Modal
        open={!!amendTarget}
        onClose={() => setAmendTarget(null)}
        title="Request a change"
        size="sm"
        footer={
          <Button fullWidth size="lg" loading={amendBusy} disabled={!amendNote.trim()} onClick={submitAmendment}>
            Send request
          </Button>
        }
      >
        <p className="mb-3 text-sm text-ink-soft">
          Core terms are locked once a booking is active. Describe the change you need — {amendTarget?.earner?.name || "the earner"} must
          approve before you can edit the gig.
        </p>
        <Textarea
          value={amendNote}
          onChange={(e) => setAmendNote(e.target.value)}
          placeholder="e.g. Move the start time to 3pm, or raise the pay to $80."
          className="min-h-[96px]"
        />
      </Modal>

      <Modal
        open={!!cancelTarget}
        onClose={() => setCancelTarget(null)}
        title="Cancel this booking?"
        size="sm"
        footer={
          <Button fullWidth size="lg" variant="ghost" className="text-urgent" loading={cancelBusy} onClick={confirmCancel}>
            Cancel gig
          </Button>
        }
      >
        <p className="text-sm text-ink-soft">
          {cancelFee > 0
            ? `Cancelling now applies a cancellation fee of $${cancelFee} to the worker. This releases the payment hold and notifies them.`
            : "This cancels the gig and releases any payment hold. The earner will be notified."}
        </p>
      </Modal>

      <CompletionModal open={!!verifyBooking} booking={verifyBooking} heldCents={verifyHeldCents} onClose={() => setVerifyBooking(null)} onConfirm={onVerify} />
      <AcceptPaymentModal
        booking={payBooking}
        onClose={() => setPayBooking(null)}
        onConfirmed={async () => {
          const b = payBooking;
          setPayBooking(null);
          if (b) {
            const ok = await acceptBooking(b.id);
            // acceptBooking surfaces its own failure toast + rolls back — only
            // confirm success when the hold was actually captured server-side.
            if (ok) showToast({ icon: "✅", title: "Accepted — funds held", message: "Payment is in escrow until you verify the work." });
          }
        }}
      />
    </div>
  );
}

// Read-only history card for a verified/declined booking (mirrors mobile's PastBookingCard).
function PastBookingCard({ booking }: { booking: Booking }) {
  const earnerName = booking.earner?.name || "Someone";
  const earnerHref = booking.earner?.id ? `/u/${booking.earner.id}` : "#";
  const noRatings = booking.status === "declined" || booking.status === "cancelled";
  const date = booking.completedAt ? new Date(booking.completedAt).toLocaleDateString() : null;

  return (
    <div className="rounded-2xl bg-white p-4 shadow-[var(--shadow-card)] ring-1 ring-line/70">
      <div className="flex items-center gap-2.5">
        <Link href={earnerHref} className="shrink-0">
          <Avatar url={booking.earner?.avatarUrl} initial={booking.earner?.avatarInitial} name={earnerName} size={38} />
        </Link>
        <div className="min-w-0 flex-1">
          <p className="truncate font-bold text-ink">{booking.job?.title || "Gig"}</p>
          <Link href={earnerHref} className="text-sm text-ink-soft hover:text-primary hover:underline">
            {earnerName}
          </Link>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <StatusBadge status={booking.status} />
          {date && <span className="text-[11px] text-ink-muted">{date}</span>}
        </div>
      </div>
      {!noRatings && (
        <div className="mt-2.5 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-divider pt-2.5">
          {booking.earnerRating ? (
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink-soft">
              <RatingStars value={booking.earnerRating} size={13} />
              You rated {earnerName} {Number(booking.earnerRating).toFixed(1)}
            </span>
          ) : (
            <span className="text-xs text-ink-muted">Completed</span>
          )}
          {booking.posterRating ? (
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink-soft">
              <RatingStars value={booking.posterRating} size={13} />
              {earnerName} rated you {Number(booking.posterRating).toFixed(1)}
            </span>
          ) : null}
        </div>
      )}
      {!noRatings && booking.reviewText && (
        <p className="mt-2 border-l-2 border-line pl-2.5 text-xs italic text-ink-soft">&ldquo;{booking.reviewText}&rdquo;</p>
      )}
    </div>
  );
}
