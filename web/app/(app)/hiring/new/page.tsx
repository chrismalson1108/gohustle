"use client";

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { useJobs } from "@/lib/jobs";
import { useUser } from "@/lib/user";
import PageHeader, { PageContainer } from "@/components/PageHeader";
import GigForm from "@/components/GigForm";

function PostGigInner() {
  const router = useRouter();
  const params = useSearchParams();
  const { jobs, addJob } = useJobs();
  const { showToast } = useUser();

  // Duplicate flow (?from=<jobId>) — prefill the form from an existing gig,
  // but with fresh slots and no photos carried over (mirrors mobile PostJob prefill).
  const fromId = params.get("from");
  const fromJob = fromId ? jobs.find((j) => j.id === fromId) : undefined;
  const initial = fromJob
    ? {
        title: fromJob.title,
        category: fromJob.category,
        pay: fromJob.pay,
        payType: fromJob.payType,
        location: fromJob.location,
        lat: fromJob.lat,
        lng: fromJob.lng,
        description: fromJob.description,
        requirements: fromJob.requirements,
        recurrence: fromJob.recurrence,
        urgent: fromJob.urgent,
        tags: fromJob.tags,
        hazards: fromJob.hazards,
        estimatedHours: fromJob.estimatedHours,
      }
    : undefined;

  return (
    <div>
      <PageHeader
        title={fromJob ? "Duplicate Gig" : "Post a Gig"}
        subtitle={fromJob ? "Review the details, then post your copy" : "Hire a motivated college student"}
      />
      <PageContainer>
        <button onClick={() => router.back()} className="mb-4 flex items-center gap-1 text-sm font-bold text-primary">
          <ArrowLeft className="size-4" /> Back
        </button>
        <GigForm
          initial={initial}
          submitLabel="Post Gig"
          onError={(message) => showToast({ icon: "⚠️", title: "Check your gig", message })}
          onSubmit={async (data) => {
            await addJob(data as unknown as Record<string, unknown>);
            showToast({ icon: "🚀", title: "Gig Posted!", message: "Your gig is live — students can now apply!" });
            router.push("/hiring");
          }}
        />
      </PageContainer>
    </div>
  );
}

export default function PostGigPage() {
  return (
    <Suspense fallback={null}>
      <PostGigInner />
    </Suspense>
  );
}
