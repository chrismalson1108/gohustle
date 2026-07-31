"use client";

import { Bookmark } from "lucide-react";
import { isJobBookable, isHiddenForViewer } from "@gohustlr/shared";
import { useJobs } from "@/lib/jobs";
import { useAuth } from "@/lib/auth";
import PageHeader, { PageContainer, EmptyState } from "@/components/PageHeader";
import JobCard from "@/components/JobCard";
import type { Job } from "@/lib/types";

export default function SavedGigsPage() {
  const { jobs, savedJobIds, bookings } = useJobs();
  const { user } = useAuth();

  const saved = jobs.filter((j) => savedJobIds.has(j.id));
  // Same two predicates Browse uses, but SPLIT rather than filtered out: the user
  // deliberately bookmarked these, so a gig silently vanishing here reads as a lost
  // bookmark, not a closed gig. Keep them, muted, where they can still be unsaved.
  //
  // Your own listing is booked-out for YOU no matter what its slots say, so it
  // belongs in the closed group too — otherwise "Ready to book" sends you to a
  // JobDetail that just tells you it's your gig.
  const stillOpen = (j: Job) =>
    isJobBookable(j) && !isHiddenForViewer(j, bookings) && j.posterId !== user?.id;
  const open = saved.filter(stillOpen);
  const closed = saved.filter((j) => !stillOpen(j));

  return (
    <div>
      <PageHeader title="Saved gigs" subtitle="Gigs you've bookmarked" width="feed" back="/profile" />
      <PageContainer width="feed" className="pb-8">
        {saved.length === 0 ? (
          <EmptyState icon={<Bookmark className="size-10" />} title="No saved gigs yet" body="Tap the bookmark on any gig to save it here to book later." />
        ) : (
          <>
            {open.length > 0 && (
              <>
                {closed.length > 0 && <h2 className="mb-2 text-[13px] font-semibold text-ink-muted">Ready to book</h2>}
                {/* The same auto-fill feed grid Browse uses: a column appears
                    whenever ~320px of room does, so saved gigs fill a wide monitor
                    and collapse to one column on a phone without a breakpoint ladder. */}
                <div className="grid grid-cols-[repeat(auto-fill,minmax(min(320px,100%),1fr))] gap-4">
                  {open.map((job) => (
                    <JobCard key={job.id} job={job} bookingStatus={bookings.find((b) => b.jobId === job.id)?.status} />
                  ))}
                </div>
              </>
            )}
            {closed.length > 0 && (
              <>
                <h2 className="mb-1 mt-6 text-[13px] font-semibold text-ink-muted">No longer open</h2>
                <p className="mb-3 text-xs text-ink-soft">Fully booked, or your own listing. Unsave to tidy this list up.</p>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(min(320px,100%),1fr))] gap-4 opacity-60">
                  {closed.map((job) => (
                    <JobCard key={job.id} job={job} bookingStatus={bookings.find((b) => b.jobId === job.id)?.status} />
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </PageContainer>
    </div>
  );
}
