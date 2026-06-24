"use client";

import Link from "next/link";
import { Megaphone, Plus } from "lucide-react";
import { useJobs } from "@/lib/jobs";
import PageHeader, { PageContainer, EmptyState } from "@/components/PageHeader";
import StatusBadge from "@/components/ui/StatusBadge";
import { buttonClasses } from "@/components/ui/Button";
import { payLabel } from "@/lib/format";

// Phase 1 will add: accept/decline/verify/dispute actions, amendment flow, expandable bookings.
export default function HiringPage() {
  const { postedJobs, posterBookings } = useJobs();

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
          <EmptyState
            icon={<Megaphone className="size-10" />}
            title="You haven't posted any gigs"
            body="Post a gig to get help from students near you."
          />
        ) : (
          <div className="space-y-3">
            {postedJobs.map((job) => {
              const reqs = posterBookings.filter((b) => b.jobId === job.id);
              return (
                <div key={job.id} className="rounded-2xl bg-white p-4 shadow-[var(--shadow-card)] ring-1 ring-line/70">
                  <div className="flex items-center justify-between gap-3">
                    <Link href={`/jobs/${job.id}`} className="min-w-0">
                      <p className="truncate font-bold text-ink">{job.title}</p>
                      <p className="text-sm text-ink-soft">{payLabel(job)} · {reqs.length} request{reqs.length !== 1 ? "s" : ""}</p>
                    </Link>
                    <Link href={`/hiring/${job.id}/edit`} className={buttonClasses("outline", "sm")}>
                      Edit
                    </Link>
                  </div>
                  {reqs.length > 0 && (
                    <div className="mt-3 space-y-2 border-t border-divider pt-3">
                      {reqs.map((b) => (
                        <div key={b.id} className="flex items-center justify-between text-sm">
                          <span className="font-medium text-ink-soft">{b.earner?.name || "Someone"}</span>
                          <StatusBadge status={b.status} />
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
    </div>
  );
}
