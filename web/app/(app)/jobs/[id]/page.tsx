"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Zap, MapPin, Repeat, DollarSign, Flag, Clock, CheckCircle2, RefreshCw, ShieldCheck, XCircle, MessageCircle, Bookmark, AlertTriangle, Lock } from "lucide-react";
import { categoryLabel, findProhibited, MIN_JOB_PAY, sameCategory, validateJobPay, platformFeeCents, feeLabel } from "@gohustlr/shared";
import { maskLocation, canSeeExactAddress } from "@/lib/address";
import { supabase } from "@/lib/supabaseClient";
import { useJobs } from "@/lib/jobs";
import { useUser } from "@/lib/user";
import { useAuth } from "@/lib/auth";
import { REPORT_REASONS, submitReport, logModerationBlock } from "@/lib/moderation";
import { useFeeBps } from "@/lib/pricing";
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
  pending: { Icon: Clock, title: "Application Pending", desc: "The poster hasn't reviewed your booking yet. Hang tight!", bg: "bg-warning-light", color: "text-warning-deep" },
  confirmed: { Icon: CheckCircle2, title: "Confirmed — You're In!", desc: "Accepted! Head to My Jobs to mark done when finished.", bg: "bg-success-light", color: "text-success" },
  completed: { Icon: RefreshCw, title: "Awaiting Verification", desc: "You marked done. The poster needs to verify your work.", bg: "bg-primary-light", color: "text-primary" },
  verified: { Icon: ShieldCheck, title: "Completed & Verified", desc: "All done! Go to My Jobs to rate the poster.", bg: "bg-success-light", color: "text-success" },
  declined: { Icon: XCircle, title: "Application Declined", desc: "The poster didn't accept your booking.", bg: "bg-urgent-light", color: "text-urgent" },
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-6">
      <h2 className="mb-3 text-[13px] font-semibold text-ink-muted">{title}</h2>
      {children}
    </section>
  );
}

// Section heading inside the booking panel — same label token, tighter rhythm
// because the panel packs four blocks into one card.
function PanelLabel({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-2.5 text-[13px] font-semibold text-ink-muted">{children}</h2>;
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

  // jobs.location is masked server-side (migration 20260722040000); the exact address
  // lives in job_locations, readable only by the poster/accepted earner via RLS. Fetch
  // it for an authorized viewer so the "address after acceptance" reveal still works.
  // MUST sit above the `if (!job)` early return below — a hook called after a
  // conditional return runs on some renders and not others, which React reports as
  // "Rendered more hooks than during the previous render" and crashes the page.
  // This is the rate a booking made right now would be pinned at.
  const feeBps = useFeeBps();

  const [exactLocation, setExactLocation] = useState<string | null>(null);
  useEffect(() => {
    const cb = bookings.find((b) => b.jobId === job?.id);
    const canSee = canSeeExactAddress({ isPoster: !!(job?.posterId && user?.id === job.posterId), bookingStatus: cb?.status });
    if (!job?.id || !canSee) { setExactLocation(null); return; }
    let live = true;
    supabase
      .from("job_locations")
      .select("exact_location")
      .eq("job_id", job.id)
      .maybeSingle()
      .then(
        ({ data }) => { if (live) setExactLocation((data?.exact_location as string) || null); },
        () => { if (live) setExactLocation(null); },
      );
    return () => { live = false; };
  }, [job?.id, job?.posterId, bookings, user?.id]);

  if (!job) {
    if (!fetchTried) return <FullPageSpinner label="Loading gig…" />;
    return (
      <PageContainer width="content">
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
  // job.location is already the masked label from the server; the exact address (when
  // the viewer is entitled to it) is fetched separately into exactLocation.
  const displayLocation = showExactAddress ? (exactLocation || job.location) : maskLocation(job.location);
  const addressMasked = !showExactAddress && !String(job.location || "").toLowerCase().includes("remote");
  const jobPosterBookings = posterBookings.filter((b) => b.jobId === job.id);
  const estPay =
    job.payType === "hourly"
      ? `${payLabel(job)} · ~${money(job.pay * job.estimatedHours)} estimated`
      : `${money(job.pay)} flat rate`;
  // A slot is bookable only if it isn't taken and isn't already in the past (matches
  // the SlotPicker's past-slot filter) — otherwise the CTA would gate on stale slots.
  // Drives BOTH the CTA's disabled state and the handleBook guard. Previously the
  // button was disabled only on `!selectedSlot && hasAvailableSlot`, which left it
  // enabled and labelled "Book this gig" once every slot was taken or past — booking
  // with slot_id = null, outside the one-active-booking-per-slot unique index and
  // with no schedule for earner-claim-payment to settle against.
  const nowMs = new Date().getTime();
  const hasAvailableSlot = job.slots?.some((s) => !s.taken && (!s.startsAt || Date.parse(s.startsAt) > nowMs));

  const baseRate = counterPrice ? parseFloat(counterPrice) || job.pay : job.pay;
  const gross = job.payType === "hourly" ? baseRate * (job.estimatedHours || 1) : baseRate;
  // Computed in CENTS through the shared function so this quote equals what
  // stripe-create-payment-intent will actually charge, floor included. A plain
  // percentage multiply cannot express the floor and drifts by a cent on odd amounts.
  const grossCents = Math.round(gross * 100);
  const feeCents = platformFeeCents(grossCents, feeBps);
  const fee = feeCents / 100;
  const net = (grossCents - feeCents) / 100;

  const handleBook = async () => {
    // Every gig always carries at least one bookable slot (PostJob/EditJob attach a
    // "Flexible — Contact to Schedule" slot when the poster picks no times), so
    // "nothing available" means every slot is taken or in the past — i.e. this gig is
    // not bookable right now. The old guard read `!selectedSlot && hasAvailableSlot`,
    // which SKIPPED itself in exactly that case and booked with slot_id = null: a
    // phantom booking outside the one-active-booking-per-slot unique index (so the
    // slot could be double-booked), with no schedule for earner-claim-payment to
    // settle against. Refuse instead.
    if (!hasAvailableSlot) {
      showToast({
        icon: "⚠️",
        title: "No times available",
        message: "Every time slot for this gig is taken or has passed.",
      });
      return;
    }
    if (!selectedSlot) return;
    const note = applicationNote.trim() || null;
    const noteTerm = note && findProhibited(note);
    if (noteTerm) {
      logModerationBlock(noteTerm, "note", note);
      showToast({ icon: "⚠️", title: "Check your wording", message: "Your note contains content that isn't allowed. Please edit it." });
      return;
    }
    // A counter-offer REPLACES the posted rate, so it has to clear the same floor —
    // otherwise the minimum on posting is trivially undercut from the earner side.
    const counterError = counterPrice ? validateJobPay(counterPrice) : null;
    if (counterError) {
      showToast({ icon: "⚠️", title: "Check your offer", message: counterError });
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
    // Slug comparison, not the label: the "Tech Whiz" challenge has to credit a gig
    // posted as "tech support" or "Tech help" too, or whether it counts depends on
    // how the poster happened to type the category.
    if (sameCategory(job.categorySlug || job.category, "tech-help")) updateChallenge("c3", 1);
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
  // Slots / counter-offer / note / payment only exist for a viewer who can still book.
  const showBookingForm = !alreadyBooked && !isOwnJob;

  // The one decision control on the page. Built once and rendered in exactly ONE
  // place at a time: inside the sticky panel from `lg` up, and in the bottom action
  // bar below it. Sharing the node keeps the two placements from drifting apart.
  const bookingAction =
    job.status === "cancelled" ? (
      <div className="rounded-xl bg-canvas py-4 text-center text-sm font-medium text-ink-soft">
        This listing has been removed
      </div>
    ) : isOwnJob ? (
      <div>
        <div className="rounded-2xl bg-canvas p-3.5">
          <p className="text-sm font-semibold text-ink">
            {jobPosterBookings.length > 0
              ? `${jobPosterBookings.length} application${jobPosterBookings.length !== 1 ? "s" : ""} received`
              : "Your gig — awaiting applications"}
          </p>
        </div>
        {jobPosterBookings.length > 0 && (
          <Button fullWidth className="mt-2.5" onClick={() => router.push("/hiring")}>
            Manage in Hiring →
          </Button>
        )}
      </div>
    ) : alreadyBooked && status ? (
      <div>
        <div className={classNames("flex items-start gap-3 rounded-2xl p-3.5", status.bg)}>
          <status.Icon className={classNames("mt-0.5 size-5 shrink-0", status.color)} />
          <div className="min-w-0">
            <p className={classNames("text-sm font-bold", status.color)}>{status.title}</p>
            <p className="mt-0.5 text-xs leading-[17px] text-ink-soft">{status.desc}</p>
          </div>
        </div>
        {canMessage && (
          <Button variant="outline" fullWidth className="mt-2.5" onClick={() => router.push("/messages")}>
            <MessageCircle className="size-4 shrink-0" /> <span className="truncate">Message poster</span>
          </Button>
        )}
      </div>
    ) : (
      <Button
        fullWidth
        size="lg"
        loading={booking}
        disabled={!hasAvailableSlot || !selectedSlot}
        onClick={handleBook}
      >
        <span className="truncate">
          {!hasAvailableSlot
            ? "No times available"
            : selectedSlot
              ? Number.isFinite(parseFloat(counterPrice)) && parseFloat(counterPrice) > 0
                ? `Book · counter ${money(parseFloat(counterPrice))}`
                : "Book this gig"
              : "Select a time slot first"}
        </span>
      </Button>
    );

  return (
    // The old `pb-32` existed to clear a FIXED action bar. The bar below is sticky
    // and therefore in flow, so the page only needs ordinary tail spacing — a large
    // reserve would just leave a dead cream band under the bar at full scroll.
    <PageContainer width="content" className="pb-8">
      {/* Two columns once there is room: the booking decision sits beside the
          listing instead of below it, so nobody has to scroll past the whole gig to
          book. Container steps, not `lg:`/`xl:` — `<main>` is the @container, and a
          viewport query is wrong by one sidebar width (at a 1024px viewport the
          content box is only 784px). `@3xl` (768px container) is that same 1024px
          viewport and `@5xl` (1024px container) the 1280px one, so the split lands
          where it always did while measuring the space the page ACTUALLY has.
          The sticky aside, the two CTA placements and the bottom bar below are all
          keyed to `@3xl` too — they must switch with the grid or the Book button
          renders twice (or not at all) at some widths. */}
      <div className="grid gap-6 @3xl:grid-cols-[minmax(0,1fr)_22rem] @5xl:grid-cols-[minmax(0,1fr)_24rem]">
        {/* ── Listing ────────────────────────────────────────────────────────
            Its own `@container`: the photo gallery below has to size against THIS
            column, which is ~344px once the aside splits off, not against `<main>`
            or the viewport. */}
        <div className="@container min-w-0">
          {job.urgent && (
            <div className="mb-4 flex items-center justify-center gap-1.5 rounded-xl bg-urgent-light px-3 py-2.5 text-[13px] font-semibold text-urgent">
              <Zap className="size-4 shrink-0" /> <span className="truncate">Urgent — needed ASAP</span>
            </div>
          )}

          {/* Category is plain muted metadata, not a per-category colored chip —
              the runtime CATEGORY_COLORS tint made the page's palette change
              identity per gig. */}
          <div className="flex items-center justify-between gap-3">
            <span className="min-w-0 truncate text-[13px] font-medium text-ink-muted">
              {categoryLabel(job.category || job.categorySlug)}
            </span>
            <button
              onClick={() => toggleSavedJob(job.id)}
              className="flex size-11 shrink-0 items-center justify-center rounded-full border border-line bg-white text-ink-muted transition hover:text-primary"
              aria-label={savedJobIds.has(job.id) ? "Unsave" : "Save"}
            >
              <Bookmark className={savedJobIds.has(job.id) ? "size-5 fill-primary text-primary" : "size-5"} />
            </button>
          </div>

          <h1 className="mt-3 text-[26px] font-bold leading-[32px] tracking-[-0.02em] text-ink sm:text-[28px] sm:leading-[34px]">
            {job.title}
          </h1>

          {/* One soft accent (pay) and neutral outlines for the rest — mobile's
              pillRow. Amber never carries white text: accent-light + accent-deep. */}
          <div className="mt-4 flex flex-wrap gap-2">
            <span className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-wash px-3 py-2 text-[13px] font-semibold text-wash-deep">
              <DollarSign className="size-3.5 shrink-0" /> <span className="truncate">{estPay}</span>
            </span>
            <span className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-line bg-white px-3 py-2 text-[13px] font-medium text-ink-soft">
              <MapPin className="size-3.5 shrink-0" /> <span className="truncate">{displayLocation}</span>
            </span>
            {RECUR_LABEL[job.recurrence] && (
              <span className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-line bg-white px-3 py-2 text-[13px] font-medium text-ink-soft">
                <Repeat className="size-3.5 shrink-0" />
                <span className="truncate">Repeats {RECUR_LABEL[job.recurrence]}</span>
              </span>
            )}
          </div>

          {addressMasked && (
            <p className="mt-2.5 flex items-start gap-1.5 text-xs leading-[17px] text-ink-muted">
              <Lock className="mt-0.5 size-3.5 shrink-0" />
              The poster shares the exact address once your booking is accepted.
            </p>
          )}

          {job.photos?.length > 0 && (
            // A grid, not a fixed-width horizontal scroller: 176×256px thumbs showed
            // 1.3 images on a phone and stayed a cramped rail on desktop.
            // `@xl` is measured against the listing column (see its @container), not
            // the viewport: a `sm:` step went 3-up at a 640px WINDOW, which on a
            // 1024px desktop meant three ~99px thumbs inside the ~344px column.
            <div className="mt-5 grid grid-cols-2 gap-3 @xl:grid-cols-3">
              {job.photos.map((u, i) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={i} src={u} alt="" className="aspect-[4/3] w-full rounded-2xl bg-divider object-cover" />
              ))}
            </div>
          )}

          <div className="mt-6">
            <Section title="About this gig">
              <p className="whitespace-pre-wrap text-[15px] leading-[23px] text-ink-soft">{job.description}</p>
              {job.tags?.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {job.tags.map((t) => (
                    <span
                      key={t}
                      className="max-w-full truncate rounded-full border border-line bg-white px-2.5 py-1 text-xs font-medium text-ink-soft"
                    >
                      #{t}
                    </span>
                  ))}
                </div>
              )}
            </Section>

            {job.hazards?.length > 0 && (
              // The tinted fill carries the warning on its own — a 2px red border on
              // top of a red fill and a red heading was three emphasis mechanisms
              // stacked on one block.
              <div className="mb-6 rounded-2xl bg-urgent-light p-4">
                <div className="mb-2 flex items-center gap-2 text-sm font-bold text-urgent">
                  <AlertTriangle className="size-[18px] shrink-0" /> Safety notes
                </div>
                <ul className="space-y-1.5">
                  {job.hazards.map((h) => (
                    <li key={h} className="flex items-start gap-2 text-sm leading-5 text-ink">
                      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-urgent" />
                      <span className="min-w-0">{h}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {job.requirements?.length > 0 && (
              <Section title="Requirements">
                <ul className="space-y-2">
                  {job.requirements.map((r, i) => (
                    <li key={i} className="flex gap-2 text-sm leading-[21px] text-ink-soft">
                      <span className="shrink-0 text-ink-muted">•</span>
                      <span className="min-w-0">{r}</span>
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            <Section title="About the poster">
              <PosterTrustCard poster={job.poster} posterId={job.posterId} />
              {!isOwnJob && (
                <button onClick={() => setReportOpen(true)} className="mt-2 flex w-full items-center justify-center gap-1.5 py-3 text-[13px] font-medium text-ink-muted hover:text-urgent">
                  <Flag className="size-3.5 shrink-0" /> Report this gig
                </button>
              )}
            </Section>

            {job.reviews?.length > 0 && (
              <Section title={`Reviews (${job.reviews.length})`}>
                <div className="space-y-3">
                  {job.reviews.map((r) => (
                    <div key={r.id} className="rounded-2xl bg-white p-4 shadow-[var(--shadow-card)]">
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 truncate text-[13px] font-semibold text-ink">{r.author}</span>
                        <RatingStars value={r.rating} size={12} />
                        <span className="ml-auto shrink-0 text-[11px] text-ink-muted">{r.date}</span>
                      </div>
                      {r.text && <p className="mt-2 text-[13px] leading-5 text-ink-soft">{r.text}</p>}
                    </div>
                  ))}
                </div>
              </Section>
            )}
          </div>
        </div>

        {/* ── Booking panel ────────────────────────────────────────────────
            Sticks beside the listing from `@3xl`; below that it is a normal block
            in the flow and the CTA lives in the bottom bar instead. */}
        <aside className="@3xl:sticky @3xl:top-6 @3xl:self-start">
          {showBookingForm ? (
            <div className="rounded-2xl bg-white p-4 shadow-[var(--shadow-card)]">
              {job.slots?.length > 0 && (
                <div className="mb-5">
                  <PanelLabel>Available times</PanelLabel>
                  <SlotPicker slots={job.slots} selected={selectedSlot} onSelect={setSelectedSlot} />
                  {!selectedSlot && hasAvailableSlot && (
                    <p className="mt-3 text-center text-xs text-ink-muted">Pick a time slot to select it</p>
                  )}
                </div>
              )}

              <div className="mb-5">
                <PanelLabel>Counter-offer (optional)</PanelLabel>
                <p className="text-sm leading-5 text-ink-soft">
                  Listed rate: <span className="font-semibold text-ink">{estPay}</span>
                </p>
                <p className="mb-3 mt-1 text-xs leading-[18px] text-ink-muted">
                  Propose a different rate to negotiate before booking (minimum ${MIN_JOB_PAY}).
                </p>
                {/* Sunken fill inside a white card — the input has to contrast its
                    container, and canvas is the neutral for that. */}
                <div className="flex items-center gap-1.5 rounded-xl border border-line bg-canvas px-3.5 py-2.5 transition focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/15">
                  <span className="shrink-0 text-lg font-semibold text-ink-muted">$</span>
                  <input
                    inputMode="decimal"
                    value={counterPrice}
                    onChange={(e) => setCounterPrice(e.target.value.replace(/[^0-9.]/g, ""))}
                    placeholder={String(job.pay)}
                    aria-label="Counter-offer amount"
                    className="min-w-0 flex-1 bg-transparent text-xl font-semibold text-ink outline-none placeholder:text-ink-muted"
                  />
                  <span className="shrink-0 text-sm font-medium text-ink-muted">{job.payType === "hourly" ? "/ hr" : "flat"}</span>
                </div>
              </div>

              <div className="mb-5">
                <PanelLabel>Add a note to the poster (optional)</PanelLabel>
                <p className="mb-2.5 text-xs leading-[18px] text-ink-muted">Tell the poster why you&apos;re a great fit.</p>
                <Textarea
                  value={applicationNote}
                  onChange={(e) => setApplicationNote(e.target.value)}
                  placeholder="Why you're a great fit…"
                  aria-label="Note to the poster"
                  maxLength={500}
                  rows={3}
                />
              </div>

              <div>
                <PanelLabel>Payment</PanelLabel>
                <Row label={`Gig pay${job.payType === "hourly" ? " (est.)" : ""}`} value={money(gross)} />
                <Row label={`GoHustlr service fee (${feeLabel(feeBps)})`} value={`−${money(fee)}`} />
                <div className="my-2 h-px bg-divider" />
                <Row label="You receive" value={money(net)} bold />
                <p className="mt-3 text-xs leading-[17px] text-ink-muted">
                  Paid securely in-app and released to you after the poster verifies your work. Tips (if any) are yours in full.
                </p>
              </div>

              <div className="mt-5 hidden border-t border-divider pt-4 @3xl:block">{bookingAction}</div>
            </div>
          ) : (
            <div className="hidden @3xl:block">{bookingAction}</div>
          )}
        </aside>
      </div>

      {/* ── Bottom action bar (below `@3xl` only) ────────────────────────────
          `sticky`, not `fixed`: a fixed bar has to be told where the sidebar is,
          and the old `md:left-64` hardcoded a rail width the shell no longer has
          (it is 76px at md and the shell is no longer centered), so the bar painted
          over the sidebar. Sticky inherits the content column's geometry for free.
          The bottom offset clears AppShell's fixed tab bar, which is z-40 and used
          to paint over this bar (it sat at z-30) — on a notched phone that hid the
          Book button completely.
          `md:bottom-0` stays a VIEWPORT query on purpose: it tracks AppShell's
          `md:hidden` tab bar, which is keyed to the window. Only the show/hide of
          this bar is a container query, because that pairs with the grid split. */}
      <div className="sticky bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-40 -mx-4 mt-6 border-t border-divider bg-white px-4 py-4 sm:-mx-6 sm:px-6 md:bottom-0 @3xl:hidden">
        {bookingAction}
      </div>

      <Modal open={reportOpen} onClose={() => setReportOpen(false)} title="Report this gig" size="sm">
        <p className="mb-3 text-sm text-ink-soft">Why are you reporting it?</p>
        <div className="space-y-2">
          {REPORT_REASONS.map((reason) => (
            <button
              key={reason}
              onClick={() => report(reason)}
              className="w-full rounded-xl border border-line bg-white px-4 py-3.5 text-left text-sm font-semibold text-ink transition hover:border-urgent hover:text-urgent"
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
    <div className="flex items-center justify-between gap-3 py-1.5">
      <span className={classNames("min-w-0", bold ? "text-[15px] font-semibold text-ink" : "text-sm text-ink-soft")}>{label}</span>
      {/* Money reads as ink + weight. Green is reserved for confirmed/paid/verified —
          this figure is an estimate, not a payout (same rule as mobile's feeCard). */}
      <span className={classNames("shrink-0", bold ? "text-base font-bold text-ink" : "text-sm font-medium text-ink")}>{value}</span>
    </div>
  );
}
