"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Zap, MapPin, Repeat, DollarSign, Flag, Clock, CheckCircle2, RefreshCw, ShieldCheck, XCircle, MessageCircle, Bookmark, AlertTriangle, Lock } from "lucide-react";
import { CATEGORY_COLORS, findProhibited } from "@gohustlr/shared";
import { maskLocation, canSeeExactAddress } from "@/lib/address";
import { useJobs } from "@/lib/jobs";
import { useUser } from "@/lib/user";
import { useAuth } from "@/lib/auth";
import { REPORT_REASONS, submitReport, logModerationBlock } from "@/lib/moderation";
import { SERVICE_FEE_PCT } from "@/lib/config";
import { PageContainer, EmptyState } from "@/components/PageHeader";
import PosterTrustCard from "@/components/PosterTrustCard";
import SlotPicker from "@/components/SlotPicker";
import RatingStars from "@/components/ui/RatingStars";
import Button from "@/components/ui/Button";
import Modal from "@/components/ui/Modal";
import { FullPageSpinner } from "@/components/ui/Spinner";
import { Textarea } from "@/components/ui/Field";
import { classNames, money, payLabel } from "@/lib/format";
import type { Job } from "@/lib/types";

const RECUR_LABEL: Record<string, string> = { weekly: "Weekly", biweekly: "Biweekly", monthly: "Monthly" };

const STATUS_CONTENT: Record<string, { Icon: typeof Clock; title: string; desc: string; bg: string; color: string }> = {
  pending: { Icon: Clock, title: "Application Pending", desc: "The poster hasn't reviewed your booking yet. Hang tight!", bg: "bg-accent-light", color: "text-accent-deep" },
  confirmed: { Icon: CheckCircle2, title: "Confirmed — You're In!", desc: "Accepted! Head to My Jobs to mark done when finished.", bg: "bg-success-light", color: "text-success" },
  completed: { Icon: RefreshCw, title: "Awaiting Verification", desc: "You marked done. The poster needs to verify your work.", bg: "bg-primary-light", color: "text-primary" },
  verified: { Icon: ShieldCheck, title: "Completed & Verified", desc: "All done! Go to My Jobs to rate the poster.", bg: "bg-success-light", color: "text-success" },
  declined: { Icon: XCircle, title: "Application Declined", desc: "The poster didn't accept your booking.", bg: "bg-urgent-light", color: "text-urgent" },
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-6">
      <h2 className="mb-3 text-xs font-bold uppercase tracking-wide text-ink-muted">{title}</h2>
      {children}
    </section>
  );
}

export default function JobDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { jobs, bookings, posterBookings, bookJob, isBooked, savedJobIds, toggleSavedJob, fetchJobById } = useJobs();
  const { addXP, updateChallenge, showToast } = useUser();
  const { user } = useAuth();

  const [selectedSlot, setSelectedSlot] = useState<string | null>(null);
  const [counterPrice, setCounterPrice] = useState("");
  const [applicationNote, setApplicationNote] = useState("");
  const [reportOpen, setReportOpen] = useState(false);
  const [booking, setBooking] = useState(false);

  // Not every viewable job is in the browse feed — conversation links can point
  // at past (soft-cancelled) listings, so fall back to a direct fetch before
  // declaring the gig gone (mirror of mobile JobDetailScreen).
  const [fetchedJob, setFetchedJob] = useState<Job | null>(null);
  const [fetchTried, setFetchTried] = useState(false);
  const listJob = jobs.find((j) => j.id === id);
  const job = listJob || fetchedJob;
  useEffect(() => {
    if (listJob || fetchTried) return;
    let live = true;
    fetchJobById(id)
      .then((j) => { if (live) setFetchedJob(j); })
      .finally(() => { if (live) setFetchTried(true); });
    return () => { live = false; };
  }, [id, listJob, fetchTried, fetchJobById]);

  if (!job) {
    if (!fetchTried) return <FullPageSpinner label="Loading gig…" />;
    return (
      <PageContainer>
        <EmptyState
          icon={<AlertTriangle className="size-10" />}
          title="Gig not found"
          body="This listing may have been removed, already filled, or the link is no longer valid."
        />
        <div className="flex justify-center">
          <Button size="lg" onClick={() => router.replace("/browse")}>
            Browse gigs
          </Button>
        </div>
      </PageContainer>
    );
  }

  const alreadyBooked = isBooked(job.id);
  const isOwnJob = job.posterId && user?.id === job.posterId;
  const currentBooking = bookings.find((b) => b.jobId === job.id);
  // Address privacy: exact location shows only to the poster or an accepted earner.
  const showExactAddress = canSeeExactAddress({ isPoster: !!isOwnJob, bookingStatus: currentBooking?.status });
  const displayLocation = showExactAddress ? job.location : maskLocation(job.location);
  const addressMasked = !showExactAddress && !String(job.location || "").toLowerCase().includes("remote");
  const jobPosterBookings = posterBookings.filter((b) => b.jobId === job.id);
  const catColor = CATEGORY_COLORS[job.category] || "#3F25FE";
  const estPay =
    job.payType === "hourly"
      ? `${payLabel(job)} · ~${money(job.pay * job.estimatedHours)} estimated`
      : `${money(job.pay)} flat rate`;
  // A slot is bookable only if it isn't taken and isn't already in the past (matches
  // the SlotPicker's past-slot filter) — otherwise the CTA would gate on stale slots.
  const nowMs = new Date().getTime();
  const hasAvailableSlot = job.slots?.some((s) => !s.taken && (!s.startsAt || Date.parse(s.startsAt) > nowMs));

  const baseRate = counterPrice ? parseFloat(counterPrice) || job.pay : job.pay;
  const gross = job.payType === "hourly" ? baseRate * (job.estimatedHours || 1) : baseRate;
  const fee = gross * SERVICE_FEE_PCT;
  const net = gross - fee;

  const handleBook = async () => {
    if (!selectedSlot && hasAvailableSlot) return;
    const note = applicationNote.trim() || null;
    const noteTerm = note && findProhibited(note);
    if (noteTerm) {
      logModerationBlock(noteTerm, "note", note);
      showToast({ icon: "⚠️", title: "Check your wording", message: "Your note contains content that isn't allowed. Please edit it." });
      return;
    }
    setBooking(true);
    const slot = job.slots?.find((s) => s.id === selectedSlot);
    const counter = counterPrice ? parseFloat(counterPrice) : null;
    const ok = await bookJob(job.id, selectedSlot, slot?.label, counter, note);
    if (!ok) {
      // The booking didn't persist — don't award XP/challenges or claim success.
      setBooking(false);
      showToast({ icon: "⚠️", title: "Couldn't book", message: "That gig couldn't be booked. Please try again." });
      return;
    }
    addXP(25);
    updateChallenge("c1", 1);
    if (job.category === "Tech Help") updateChallenge("c3", 1);
    showToast({
      icon: "🎉",
      title: "Gig Booked! +25 XP",
      message: `"${job.title}" booked${counter ? ` · counter-offer ${money(counter)} sent` : ""}`,
    });
    router.push("/my-jobs");
  };

  const report = async (reason: string) => {
    if (!user) return;
    try {
      await submitReport({ reporterId: user.id, reportedUserId: job.posterId, jobId: job.id, reason });
      showToast({ icon: "🚩", title: "Report submitted", message: "Thanks — our team will review this gig." });
    } catch {
      showToast({ icon: "⚠️", title: "Could not submit", message: "Please try again." });
    }
    setReportOpen(false);
  };

  const status = currentBooking ? STATUS_CONTENT[currentBooking.status] || STATUS_CONTENT.pending : null;
  const canMessage = !!currentBooking && ["pending", "confirmed", "completed"].includes(currentBooking.status);

  return (
    <PageContainer className="pb-32">
      {job.urgent && (
        <div className="mb-4 flex items-center justify-center gap-1.5 rounded-2xl bg-urgent-light py-2.5 text-sm font-extrabold text-urgent">
          <Zap className="size-4" /> URGENT — Needed ASAP
        </div>
      )}

      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-block rounded-full px-2.5 py-1 text-xs font-bold" style={{ backgroundColor: catColor + "22", color: catColor }}>
            {job.category}
          </span>
        </div>
        <button
          onClick={() => toggleSavedJob(job.id)}
          className="rounded-full p-2 text-ink-muted ring-1 ring-line hover:text-primary"
          aria-label={savedJobIds.has(job.id) ? "Unsave" : "Save"}
        >
          <Bookmark className={savedJobIds.has(job.id) ? "size-5 fill-primary text-primary" : "size-5"} />
        </button>
      </div>
      <h1 className="mt-3 text-2xl font-black leading-tight text-ink">{job.title}</h1>

      <div className="mt-3 flex flex-wrap gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-xl bg-accent px-3 py-2 text-sm font-bold text-ink">
          <DollarSign className="size-4" /> {estPay}
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-xl bg-canvas px-3 py-2 text-sm font-semibold text-ink-soft">
          <MapPin className="size-4" /> {displayLocation}
        </span>
        {RECUR_LABEL[job.recurrence] && (
          <span className="inline-flex items-center gap-1.5 rounded-xl bg-primary-light px-3 py-2 text-sm font-bold text-primary">
            <Repeat className="size-4" /> Repeats {RECUR_LABEL[job.recurrence]}
          </span>
        )}
      </div>

      {addressMasked && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-ink-muted">
          <Lock className="size-3.5" /> The poster shares the exact address once your booking is accepted.
        </p>
      )}

      {job.tags?.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {job.tags.map((t) => (
            <span key={t} className="rounded-full bg-canvas px-2.5 py-1 text-xs font-semibold text-ink-soft ring-1 ring-line">
              #{t}
            </span>
          ))}
        </div>
      )}

      {job.hazards?.length > 0 && (
        <div className="mt-5 rounded-2xl border-2 border-urgent bg-urgent-light p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-extrabold uppercase tracking-wide text-urgent">
            <AlertTriangle className="size-5" /> Safety notes
          </div>
          <ul className="space-y-1.5">
            {job.hazards.map((h) => (
              <li key={h} className="flex items-start gap-2 text-sm font-semibold text-ink">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-urgent" />
                {h}
              </li>
            ))}
          </ul>
        </div>
      )}

      {job.photos?.length > 0 && (
        <div className="mt-5 flex gap-3 overflow-x-auto">
          {job.photos.map((u, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={i} src={u} alt="" className="h-44 w-64 shrink-0 rounded-2xl object-cover" />
          ))}
        </div>
      )}

      <div className="mt-7">
        <Section title="About this gig">
          <p className="whitespace-pre-wrap leading-relaxed text-ink">{job.description}</p>
        </Section>

        {job.requirements?.length > 0 && (
          <Section title="Requirements">
            <ul className="space-y-1.5">
              {job.requirements.map((r, i) => (
                <li key={i} className="flex gap-2 text-ink">
                  <span className="text-primary">•</span> {r}
                </li>
              ))}
            </ul>
          </Section>
        )}

        <Section title="About the poster">
          <PosterTrustCard poster={job.poster} posterId={job.posterId} />
          {!isOwnJob && (
            <button onClick={() => setReportOpen(true)} className="mt-3 flex w-full items-center justify-center gap-1.5 text-sm font-medium text-ink-muted hover:text-urgent">
              <Flag className="size-3.5" /> Report this gig
            </button>
          )}
        </Section>

        {job.slots?.length > 0 && !alreadyBooked && !isOwnJob && (
          <Section title="Available times">
            <SlotPicker slots={job.slots} selected={selectedSlot} onSelect={setSelectedSlot} />
            {!selectedSlot && hasAvailableSlot && <p className="mt-2 text-sm italic text-ink-muted">Pick a time slot to select it</p>}
          </Section>
        )}

        {!alreadyBooked && !isOwnJob && (
          <Section title="Counter-offer (optional)">
            <div className="rounded-2xl bg-white p-4 shadow-[var(--shadow-card)] ring-1 ring-line/70">
              <p className="text-sm text-ink-soft">
                Listed rate: <span className="font-bold text-ink">{estPay}</span>
              </p>
              <p className="mb-3 mt-1 text-xs text-ink-muted">Propose a different rate to negotiate before booking.</p>
              <div className="flex items-center gap-2 rounded-2xl border border-line bg-white px-3 py-2 transition focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/15">
                <span className="text-lg font-bold text-primary">$</span>
                <input
                  inputMode="decimal"
                  value={counterPrice}
                  onChange={(e) => setCounterPrice(e.target.value.replace(/[^0-9.]/g, ""))}
                  placeholder={String(job.pay)}
                  className="flex-1 bg-transparent text-lg font-bold text-ink outline-none"
                />
                <span className="text-sm font-medium text-ink-muted">{job.payType === "hourly" ? "/ hr" : "flat"}</span>
              </div>
            </div>
          </Section>
        )}

        {!alreadyBooked && !isOwnJob && (
          <Section title="Add a note to the poster (optional)">
            <div className="rounded-2xl bg-white p-4 shadow-[var(--shadow-card)] ring-1 ring-line/70">
              <p className="mb-3 text-xs text-ink-muted">Tell the poster why you&apos;re a great fit.</p>
              <Textarea
                value={applicationNote}
                onChange={(e) => setApplicationNote(e.target.value)}
                placeholder="Why you're a great fit…"
                maxLength={500}
                rows={3}
              />
            </div>
          </Section>
        )}

        {!alreadyBooked && !isOwnJob && (
          <Section title="Payment">
            <div className="rounded-2xl bg-white p-4 shadow-[var(--shadow-card)] ring-1 ring-line/70">
              <Row label={`Gig pay${job.payType === "hourly" ? " (est.)" : ""}`} value={money(gross)} />
              <Row label={`GoHustlr service fee (${Math.round(SERVICE_FEE_PCT * 100)}%)`} value={`−${money(fee)}`} />
              <div className="my-2 h-px bg-line" />
              <Row label="You receive" value={money(net)} bold />
              <p className="mt-2.5 text-xs leading-relaxed text-ink-muted">
                Paid securely in-app and released to you after the poster verifies your work. Tips (if any) are yours in full.
              </p>
            </div>
          </Section>
        )}

        {job.reviews?.length > 0 && (
          <Section title={`Reviews (${job.reviews.length})`}>
            <div className="space-y-2.5">
              {job.reviews.map((r) => (
                <div key={r.id} className="rounded-2xl bg-white p-4 shadow-[var(--shadow-card)] ring-1 ring-line/70">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold text-ink">{r.author}</span>
                    <RatingStars value={r.rating} size={12} />
                    <span className="ml-auto text-xs text-ink-muted">{r.date}</span>
                  </div>
                  {r.text && <p className="mt-1.5 text-sm text-ink-soft">{r.text}</p>}
                </div>
              ))}
            </div>
          </Section>
        )}
      </div>

      {/* Sticky action bar */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-white/95 backdrop-blur md:left-64">
        <div className="mx-auto w-full max-w-3xl px-5 py-4 pb-6 md:pb-4">
          {job.status === "cancelled" ? (
            <div className="rounded-2xl bg-canvas py-4 text-center font-bold text-ink-muted">This listing has been removed</div>
          ) : isOwnJob ? (
            <div className="rounded-2xl border border-primary/30 bg-primary-light py-3.5 text-center">
              <p className="font-bold text-primary">
                {jobPosterBookings.length > 0
                  ? `${jobPosterBookings.length} application${jobPosterBookings.length !== 1 ? "s" : ""} received`
                  : "Your gig — awaiting applications"}
              </p>
              {jobPosterBookings.length > 0 && (
                <button onClick={() => router.push("/hiring")} className="mt-1 text-sm font-bold text-primary underline">
                  Manage in Hiring →
                </button>
              )}
            </div>
          ) : alreadyBooked && status ? (
            <div>
              <div className={classNames("flex items-start gap-3 rounded-2xl p-3.5", status.bg)}>
                <status.Icon className={classNames("mt-0.5 size-5 shrink-0", status.color)} />
                <div>
                  <p className={classNames("font-extrabold", status.color)}>{status.title}</p>
                  <p className="text-xs text-ink-soft">{status.desc}</p>
                </div>
              </div>
              {canMessage && (
                <Button variant="secondary" fullWidth className="mt-2.5" onClick={() => router.push("/messages")}>
                  <MessageCircle className="size-4" /> Message poster
                </Button>
              )}
            </div>
          ) : (
            <Button fullWidth size="lg" loading={booking} disabled={!selectedSlot && hasAvailableSlot} onClick={handleBook}>
              {selectedSlot || !hasAvailableSlot
                ? Number.isFinite(parseFloat(counterPrice)) && parseFloat(counterPrice) > 0
                  ? `Book · counter ${money(parseFloat(counterPrice))}`
                  : "Book this gig"
                : "Select a time slot first"}
            </Button>
          )}
        </div>
      </div>

      <Modal open={reportOpen} onClose={() => setReportOpen(false)} title="Report this gig" size="sm">
        <p className="mb-3 text-sm text-ink-soft">Why are you reporting it?</p>
        <div className="space-y-2">
          {REPORT_REASONS.map((reason) => (
            <button
              key={reason}
              onClick={() => report(reason)}
              className="w-full rounded-2xl bg-white px-4 py-3 text-left text-sm font-semibold text-ink ring-1 ring-line/70 hover:text-urgent hover:ring-urgent"
            >
              {reason}
            </button>
          ))}
        </div>
      </Modal>
    </PageContainer>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className="flex items-center justify-between py-1">
      <span className={bold ? "font-extrabold text-ink" : "text-sm text-ink-soft"}>{label}</span>
      <span className={bold ? "text-base font-black text-success" : "text-sm font-semibold text-ink"}>{value}</span>
    </div>
  );
}
