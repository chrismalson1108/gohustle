"use client";

import { useState } from "react";
import Link from "next/link";
import { Megaphone, Plus, Check, X, MessageCircle, ShieldCheck, Pencil } from "lucide-react";
import { useJobs } from "@/lib/jobs";
import PageHeader, { PageContainer, EmptyState } from "@/components/PageHeader";
import StatusBadge from "@/components/ui/StatusBadge";
import StudentBadge from "@/components/ui/StudentBadge";
import Avatar from "@/components/ui/Avatar";
import Button, { buttonClasses } from "@/components/ui/Button";
import CompletionModal, { type VerifyArgs } from "@/components/CompletionModal";
import { money, payLabel } from "@/lib/format";
import type { Booking } from "@/lib/types";

export default function HiringPage() {
  const { postedJobs, posterBookings, acceptBooking, declineBooking, cancelBooking, markPosterDone, verifyAndRate } = useJobs();
  const [verifyBooking, setVerifyBooking] = useState<Booking | null>(null);

  const onVerify = async (args: VerifyArgs) => {
    if (!verifyBooking) return;
    await verifyAndRate(verifyBooking.id, args);
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
        {postedJobs.length === 0 ? (
          <EmptyState icon={<Megaphone className="size-10" />} title="You haven't posted any gigs" body="Post a gig to get help from students near you." />
        ) : (
          <div className="space-y-4">
            {postedJobs.map((job) => {
              const reqs = posterBookings.filter((b) => b.jobId === job.id);
              return (
                <div key={job.id} className="rounded-2xl bg-white p-4 shadow-[var(--shadow-card)] ring-1 ring-line/70">
                  <div className="flex items-center justify-between gap-3">
                    <Link href={`/jobs/${job.id}`} className="min-w-0">
                      <p className="truncate font-bold text-ink">{job.title}</p>
                      <p className="text-sm text-ink-soft">
                        {payLabel(job)} · {reqs.length} request{reqs.length !== 1 ? "s" : ""}
                      </p>
                    </Link>
                    <Link href={`/hiring/${job.id}/edit`} className={buttonClasses("outline", "sm")}>
                      <Pencil className="size-3.5" /> Edit
                    </Link>
                  </div>

                  {reqs.length > 0 && (
                    <div className="mt-3 space-y-3 border-t border-divider pt-3">
                      {reqs.map((b) => (
                        <div key={b.id} className="rounded-2xl bg-canvas p-3">
                          <div className="flex items-center gap-2.5">
                            <Avatar url={b.earner?.avatarUrl} initial={b.earner?.avatarInitial} name={b.earner?.name} size={36} />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5">
                                <span className="truncate text-sm font-bold text-ink">{b.earner?.name || "Someone"}</span>
                                {b.earner?.studentVerified && <StudentBadge profile={b.earner} compact />}
                              </div>
                              <p className="text-xs text-ink-muted">
                                {b.slotLabel || "Flexible"}
                                {b.counterOffer ? ` · counter-offer ${money(b.counterOffer)}` : ""}
                              </p>
                            </div>
                            <StatusBadge status={b.status} />
                          </div>

                          {/* Actions */}
                          <div className="mt-2.5 flex flex-wrap gap-2">
                            {b.status === "pending" && (
                              <>
                                <Button size="sm" onClick={() => acceptBooking(b.id)}>
                                  <Check className="size-4" /> Accept
                                </Button>
                                <Button size="sm" variant="outline" className="text-urgent" onClick={() => declineBooking(b.id)}>
                                  <X className="size-4" /> Decline
                                </Button>
                              </>
                            )}
                            {b.status === "confirmed" && (
                              <>
                                {!b.posterDone && (
                                  <Button size="sm" onClick={() => markPosterDone(b.id)}>
                                    Mark done
                                  </Button>
                                )}
                                <Link href="/messages" className={buttonClasses("secondary", "sm")}>
                                  <MessageCircle className="size-4" /> Message
                                </Link>
                                <Button size="sm" variant="ghost" className="text-urgent" onClick={() => cancelBooking(b.id)}>
                                  Cancel
                                </Button>
                                {b.earnerDone && <span className="self-center text-xs font-bold text-success">Earner marked done ✓</span>}
                              </>
                            )}
                            {b.status === "completed" && (
                              <Button size="sm" className="bg-success" onClick={() => setVerifyBooking(b)}>
                                <ShieldCheck className="size-4" /> Verify &amp; rate
                              </Button>
                            )}
                            {b.status === "verified" && (
                              <span className="text-xs font-bold text-success">
                                Completed &amp; paid{b.earnerRating ? ` · ${b.earnerRating}★` : ""}
                              </span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </PageContainer>

      <CompletionModal open={!!verifyBooking} booking={verifyBooking} onClose={() => setVerifyBooking(null)} onConfirm={onVerify} />
    </div>
  );
}
