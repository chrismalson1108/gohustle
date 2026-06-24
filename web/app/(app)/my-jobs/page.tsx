"use client";

import Link from "next/link";
import { Briefcase } from "lucide-react";
import { useJobs } from "@/lib/jobs";
import PageHeader, { PageContainer, EmptyState } from "@/components/PageHeader";
import StatusBadge from "@/components/ui/StatusBadge";
import { money } from "@/lib/format";

// Phase 1 will add: mark-complete, message poster, rate poster, earnings dashboard.
export default function MyJobsPage() {
  const { bookings, jobs } = useJobs();

  return (
    <div>
      <PageHeader title="My Jobs" subtitle="Gigs you've booked" variant="earn" />
      <PageContainer>
        {bookings.length === 0 ? (
          <EmptyState
            icon={<Briefcase className="size-10" />}
            title="No booked gigs yet"
            body="Find a gig on Browse and book a slot to get started."
          />
        ) : (
          <div className="space-y-3">
            {bookings.map((b) => {
              const job = jobs.find((j) => j.id === b.jobId);
              return (
                <Link
                  key={b.id}
                  href={`/jobs/${b.jobId}`}
                  className="flex items-center justify-between gap-3 rounded-2xl bg-white p-4 shadow-[var(--shadow-card)] ring-1 ring-line/70"
                >
                  <div className="min-w-0">
                    <p className="truncate font-bold text-ink">{b.job?.title || job?.title || "Gig"}</p>
                    <p className="text-sm text-ink-soft">
                      {b.slotLabel || "Flexible"} · {money(b.counterOffer ?? b.job?.pay ?? job?.pay)}
                    </p>
                  </div>
                  <StatusBadge status={b.status} />
                </Link>
              );
            })}
          </div>
        )}
      </PageContainer>
    </div>
  );
}
