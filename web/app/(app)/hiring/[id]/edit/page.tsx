"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, Trash2 } from "lucide-react";
import { useJobs } from "@/lib/jobs";
import { useUser } from "@/lib/user";
import { useAuth } from "@/lib/auth";
import PageHeader, { PageContainer, EmptyState } from "@/components/PageHeader";
import GigForm from "@/components/GigForm";
import Button from "@/components/ui/Button";
import Modal from "@/components/ui/Modal";

export default function EditGigPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { jobs, posterBookings, updateJob, deleteJob } = useJobs();
  const { showToast } = useUser();
  const { user } = useAuth();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const job = jobs.find((j) => j.id === id);
  if (!job) return <EmptyState title="Gig not found" />;
  if (user && job.posterId !== user.id) return <EmptyState title="You can only edit your own gigs." />;

  // Lock core terms once a booking is confirmed/completed (unless an amendment
  // was accepted) — mirrors the mobile EditJob rule.
  const bookings = posterBookings.filter((b) => b.jobId === job.id);
  const hasActive = bookings.some((b) => ["confirmed", "completed", "verified"].includes(b.status));
  const amendmentAccepted = bookings.some((b) => b.amendmentStatus === "accepted");
  const lockedCore = hasActive && !amendmentAccepted;

  return (
    <div>
      <PageHeader title="Edit gig" subtitle={job.title} />
      <PageContainer>
        <button onClick={() => router.back()} className="mb-4 flex items-center gap-1 text-sm font-bold text-primary">
          <ArrowLeft className="size-4" /> Back
        </button>

        <GigForm
          submitLabel="Save changes"
          lockedCore={lockedCore}
          existingPhotos={job.photos}
          initial={{
            title: job.title,
            category: job.category,
            pay: job.pay,
            payType: job.payType,
            location: job.location,
            description: job.description,
            requirements: job.requirements,
            recurrence: job.recurrence,
            urgent: job.urgent,
          }}
          onError={(message) => showToast({ icon: "⚠️", title: "Check your gig", message })}
          onSubmit={async (data) => {
            await updateJob(job.id, data as unknown as Record<string, unknown>);
            showToast({ icon: "✅", title: "Gig updated!", message: "Your changes are live." });
            router.push("/hiring");
          }}
        />

        <Button variant="ghost" fullWidth className="mt-4 text-urgent" onClick={() => setConfirmDelete(true)}>
          <Trash2 className="size-4" /> Delete this gig
        </Button>
      </PageContainer>

      <Modal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete this gig?"
        size="sm"
        footer={
          <div className="flex gap-2">
            <Button variant="outline" fullWidth onClick={() => setConfirmDelete(false)}>
              Keep it
            </Button>
            <Button
              variant="danger"
              fullWidth
              onClick={async () => {
                await deleteJob(job.id);
                showToast({ icon: "🗑️", title: "Gig deleted", message: "Your gig has been removed." });
                router.push("/hiring");
              }}
            >
              Delete
            </Button>
          </div>
        }
      >
        <p className="text-sm text-ink-soft">This removes the gig from Browse. Existing bookings are unaffected.</p>
      </Modal>
    </div>
  );
}
