"use client";

import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { useJobs } from "@/lib/jobs";
import { useUser } from "@/lib/user";
import PageHeader, { PageContainer } from "@/components/PageHeader";
import GigForm from "@/components/GigForm";

export default function PostGigPage() {
  const router = useRouter();
  const { addJob } = useJobs();
  const { showToast } = useUser();

  return (
    <div>
      <PageHeader title="Post a Gig" subtitle="Hire a motivated college student" />
      <PageContainer>
        <button onClick={() => router.back()} className="mb-4 flex items-center gap-1 text-sm font-bold text-primary">
          <ArrowLeft className="size-4" /> Back
        </button>
        <GigForm
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
