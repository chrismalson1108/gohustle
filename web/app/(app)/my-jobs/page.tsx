"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { Briefcase, MessageCircle, Check, Camera, X, FileText } from "lucide-react";
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
import { money } from "@/lib/format";
import type { Booking } from "@/lib/types";

export default function MyJobsPage() {
  const { bookings, jobs, markEarnerDone, cancelBooking, ratePoster, respondToAmendment } = useJobs();
  const { earningsToday, earningsWeek, earningsTotal, showToast } = useUser();
  const { user } = useAuth();

  // Avg $/job over verified (paid-out) bookings — earnings only accrue on verify.
  const completedCount = bookings.filter((b) => b.status === "verified").length;
  const avgPerJob = completedCount ? earningsTotal / completedCount : 0;

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

  return (
    <div>
      <PageHeader title="My Jobs" subtitle="Gigs you've booked" variant="earn">
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[
            { label: "Today", value: money(earningsToday) },
            { label: "This week", value: money(earningsWeek) },
            { label: "All time", value: money(earningsTotal) },
            { label: "Avg / job", value: completedCount ? money(avgPerJob) : "—" },
          ].map((s) => (
            <div key={s.label} className="rounded-2xl bg-white/15 px-3 py-2.5 text-center">
              <p className="text-lg font-black">{s.value}</p>
              <p className="text-[11px] text-white/80">{s.label}</p>
            </div>
          ))}
        </div>
      </PageHeader>

      <PageContainer>
        <div className="mb-4 space-y-3">
          <MoneyGoalCard />
          <WorkStatusBar />
        </div>
        {bookings.length === 0 ? (
          <EmptyState icon={<Briefcase className="size-10" />} title="No booked gigs yet" body="Find a gig on Browse and book a slot to get started." />
        ) : (
          <div className="space-y-3">
            {bookings.map((b) => {
              const job = jobs.find((j) => j.id === b.jobId);
              const title = b.job?.title || job?.title || "Gig";
              return (
                <div key={b.id} className="rounded-2xl bg-white p-4 shadow-[var(--shadow-card)] ring-1 ring-line/70">
                  <div className="flex items-start justify-between gap-3">
                    <Link href={`/jobs/${b.jobId}`} className="min-w-0">
                      <p className="truncate font-bold text-ink">{title}</p>
                      <p className="text-sm text-ink-soft">
                        {b.slotLabel || "Flexible"} · {money(b.counterOffer ?? b.job?.pay ?? job?.pay)}
                        {b.tipAmount > 0 ? ` · +${money(b.tipAmount)} tip` : ""}
                      </p>
                    </Link>
                    <StatusBadge status={b.status} />
                  </div>

                  <div className="mt-2.5 flex flex-wrap gap-2">
                    {b.status === "pending" && (
                      <Button size="sm" variant="ghost" className="text-urgent" onClick={() => cancelBooking(b.id)}>
                        Withdraw
                      </Button>
                    )}
                    {b.status === "confirmed" && (
                      <>
                        {!b.earnerDone ? (
                          <Button size="sm" onClick={() => openFinish(b)}>
                            <Check className="size-4" /> Mark done
                          </Button>
                        ) : (
                          <span className="self-center text-xs font-bold text-success">You marked done ✓</span>
                        )}
                        <Link href="/messages" className={buttonClasses("secondary", "sm")}>
                          <MessageCircle className="size-4" /> Message
                        </Link>
                        <Button size="sm" variant="ghost" className="text-urgent" onClick={() => cancelBooking(b.id)}>
                          Cancel
                        </Button>
                      </>
                    )}
                    {b.status === "completed" && (
                      <span className="text-xs font-medium text-ink-muted">Waiting for the poster to verify & pay.</span>
                    )}
                    {b.status === "verified" &&
                      (b.posterRating ? (
                        <span className="text-xs font-bold text-success">You rated the poster {b.posterRating}★</span>
                      ) : (
                        <Button size="sm" onClick={() => openRate(b)}>
                          Rate the poster
                        </Button>
                      ))}
                  </div>

                  {b.amendmentStatus === "pending" && (
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
                  )}
                  {b.amendmentStatus === "accepted" && (
                    <p className="mt-3 rounded-xl bg-success/10 px-3 py-2 text-xs font-bold text-success">Change accepted — the poster can update the terms.</p>
                  )}
                  {b.amendmentStatus === "declined" && (
                    <p className="mt-3 rounded-xl bg-urgent/10 px-3 py-2 text-xs font-bold text-urgent">Change declined — original terms remain.</p>
                  )}
                </div>
              );
            })}
          </div>
        )}
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
        <p className="text-sm text-ink-soft">Add before & after photos of the finished work (optional) so the poster can verify and release payment.</p>

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
