"use client";

import { useState } from "react";
import Link from "next/link";
import { Briefcase, MessageCircle, Check } from "lucide-react";
import { useJobs } from "@/lib/jobs";
import { useUser } from "@/lib/user";
import PageHeader, { PageContainer, EmptyState } from "@/components/PageHeader";
import StatusBadge from "@/components/ui/StatusBadge";
import Button, { buttonClasses } from "@/components/ui/Button";
import Modal from "@/components/ui/Modal";
import RatingStars from "@/components/ui/RatingStars";
import { Textarea } from "@/components/ui/Field";
import MoneyGoalCard from "@/components/MoneyGoalCard";
import WorkStatusBar from "@/components/WorkStatusBar";
import { money } from "@/lib/format";
import type { Booking } from "@/lib/types";

export default function MyJobsPage() {
  const { bookings, jobs, markEarnerDone, cancelBooking, ratePoster } = useJobs();
  const { earningsToday, earningsWeek, earningsTotal } = useUser();

  const [rateBooking, setRateBooking] = useState<Booking | null>(null);
  const [rating, setRating] = useState(5);
  const [reviewText, setReviewText] = useState("");
  const [busy, setBusy] = useState(false);

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
        <div className="mt-4 grid grid-cols-3 gap-2">
          {[
            { label: "Today", value: money(earningsToday) },
            { label: "This week", value: money(earningsWeek) },
            { label: "All time", value: money(earningsTotal) },
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
                          <Button size="sm" onClick={() => markEarnerDone(b.id)}>
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
    </div>
  );
}
