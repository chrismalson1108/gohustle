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
import { FullPageSpinner } from "@/components/ui/Spinner";

export default function EditGigPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { jobs, posterBookings, updateJob, deleteJob, clearAmendment } = useJobs();
  const { showToast } = useUser();
  const { user } = useAuth();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const job = jobs.find((j) => j.id === id);
  // The jobs feed loads async — don't flash "not found" before it resolves.
  if (!job) return jobs.length === 0 ? <FullPageSpinner /> : <EmptyState title="Gig not found" />;
  if (user && job.posterId !== user.id) return <EmptyState title="You can only edit your own gigs." />;

  // Lock core terms once a booking is confirmed/completed (unless an amendment
  // was accepted) — mirrors the mobile EditJob rule.
  const bookings = posterBookings.filter((b) => b.jobId === job.id);
  const hasActive = bookings.some((b) => ["confirmed", "completed", "verified"].includes(b.status));
  const amendmentAccepted = bookings.some((b) => b.amendmentStatus === "accepted");
  const lockedCore = hasActive && !amendmentAccepted;
  // Pay stays locked whenever a booking is active (escrow hold can't be re-priced),
  // even after an amendment unlocks the other core terms.
  const lockedPay = hasActive;

  // Deleting soft-cancels the gig, which hides its bookings from the Hiring view.
  // Block it while any booking is unresolved (mirrors mobile handleDelete) so a
  // poster can never orphan a booking that still has an escrow hold — the earner
  // would be stranded and funds stuck. Only allow delete once everything is
  // verified/declined/cancelled.
  const hasUnresolvedBooking = bookings.some((b) =>
    ["pending", "confirmed", "completed"].includes(b.status),
  );

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
          lockedPay={lockedPay}
          existingPhotos={job.photos}
          initial={{
            title: job.title,
            category: job.category,
            pay: job.pay,
            payType: job.payType,
            location: job.location,
            lat: job.lat,
            lng: job.lng,
            description: job.description,
            requirements: job.requirements,
            recurrence: job.recurrence,
            urgent: job.urgent,
            tags: job.tags,
            hazards: job.hazards,
            slots: job.slots,
            estimatedHours: job.estimatedHours,
            instantBook: job.instantBook,
          }}
          onError={(message) => showToast({ icon: "⚠️", title: "Check your gig", message })}
          onSubmit={async (data) => {
            try {
              await updateJob(job.id, data as unknown as Record<string, unknown>);
            } catch (e) {
              showToast({ icon: "⚠️", title: "Couldn't save changes", message: (e as Error).message || "Please try again." });
              return;
            }
            // If this edit was unlocked by an accepted amendment, reset it so the
            // core terms re-lock afterward (mirrors mobile EditJobScreen).
            const amended = bookings.find((b) => b.amendmentStatus === "accepted");
            if (amended) await clearAmendment(amended.id);
            showToast({ icon: "✅", title: "Gig updated!", message: "Your changes are live." });
            router.push("/hiring");
          }}
        />

        {hasUnresolvedBooking ? (
          <p className="mt-4 text-center text-sm text-ink-muted">
            This gig has active or unverified bookings and can&apos;t be deleted. Decline pending
            requests and verify any completed work first.
          </p>
        ) : (
          <Button variant="ghost" fullWidth className="mt-4 text-urgent" onClick={() => setConfirmDelete(true)}>
            <Trash2 className="size-4" /> Delete this gig
          </Button>
        )}
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
                // Guard again at click time in case a booking landed while the modal was open.
                if (hasUnresolvedBooking) {
                  setConfirmDelete(false);
                  showToast({ icon: "⚠️", title: "Can't delete", message: "This gig has active or unverified bookings." });
                  return;
                }
                try {
                  await deleteJob(job.id);
                } catch (e) {
                  setConfirmDelete(false);
                  showToast({ icon: "⚠️", title: "Couldn't delete", message: (e as Error).message || "Please try again." });
                  return;
                }
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
