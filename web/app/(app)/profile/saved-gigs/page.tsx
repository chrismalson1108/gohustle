"use client";

import { useRouter } from "next/navigation";
import { ArrowLeft, Bookmark } from "lucide-react";
import { useJobs } from "@/lib/jobs";
import PageHeader, { PageContainer, EmptyState } from "@/components/PageHeader";
import JobCard from "@/components/JobCard";

export default function SavedGigsPage() {
  const router = useRouter();
  const { jobs, savedJobIds, bookings } = useJobs();
  const saved = jobs.filter((j) => savedJobIds.has(j.id));

  return (
    <div>
      <PageHeader title="Saved gigs" subtitle="Gigs you've bookmarked" />
      <PageContainer>
        <button onClick={() => router.push("/profile")} className="mb-4 flex items-center gap-1 text-sm font-bold text-primary">
          <ArrowLeft className="size-4" /> Back
        </button>
        {saved.length === 0 ? (
          <EmptyState icon={<Bookmark className="size-10" />} title="No saved gigs yet" body="Tap the bookmark on any gig to save it here to book later." />
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {saved.map((job) => (
              <JobCard key={job.id} job={job} bookingStatus={bookings.find((b) => b.jobId === job.id)?.status} />
            ))}
          </div>
        )}
      </PageContainer>
    </div>
  );
}
