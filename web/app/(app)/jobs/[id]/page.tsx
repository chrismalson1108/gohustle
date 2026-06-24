"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Zap, MapPin, Repeat, DollarSign, Flag, Clock, CheckCircle2, RefreshCw, ShieldCheck, XCircle, MessageCircle } from "lucide-react";
import { CATEGORY_COLORS } from "@gohustlr/shared";
import { useJobs } from "@/lib/jobs";
import { useUser } from "@/lib/user";
import { useAuth } from "@/lib/auth";
import { REPORT_REASONS, submitReport } from "@/lib/moderation";
import { SERVICE_FEE_PCT } from "@/lib/config";
import PosterTrustCard from "@/components/PosterTrustCard";
import SlotPicker from "@/components/SlotPicker";
import RatingStars from "@/components/ui/RatingStars";
import Button from "@/components/ui/Button";
import Modal from "@/components/ui/Modal";
import { FullPageSpinner } from "@/components/ui/Spinner";
import { payLabel } from "@/lib/format";

const RECUR_LABEL: Record<string, string> = { weekly: "Weekly", biweekly: "Biweekly", monthly: "Monthly" };

const STATUS_CONTENT: Record<string, { Icon: typeof Clock; title: string; desc: string; bg: string; color: string }> = {
  pending: { Icon: Clock, title: "Application Pending", desc: "The poster hasn't reviewed your booking yet. Hang tight!", bg: "#FFF7ED", color: "#D97706" },
  confirmed: { Icon: CheckCircle2, title: "Confirmed — You're In!", desc: "Accepted! Head to My Jobs to mark done when finished.", bg: "#ECFDF5", color: "#059669" },
  completed: { Icon: RefreshCw, title: "Awaiting Verification", desc: "You marked done. The poster needs to verify your work.", bg: "#EFF6FF", color: "#2563EB" },
  verified: { Icon: ShieldCheck, title: "Completed & Verified", desc: "All done! Go to My Jobs to rate the poster.", bg: "#F0FDF4", color: "#16A34A" },
  declined: { Icon: XCircle, title: "Application Declined", desc: "The poster didn't accept your booking.", bg: "#FEF2F2", color: "#DC2626" },
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-7">
      <h2 className="mb-3 text-xs font-extrabold uppercase tracking-wide text-ink-muted">{title}</h2>
      {children}
    </section>
  );
}

export default function JobDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { jobs, bookings, posterBookings, bookJob, isBooked } = useJobs();
  const { addXP, recordApply, updateChallenge, showToast } = useUser();
  const { user } = useAuth();

  const [selectedSlot, setSelectedSlot] = useState<string | null>(null);
  const [counterPrice, setCounterPrice] = useState("");
  const [reportOpen, setReportOpen] = useState(false);
  const [booking, setBooking] = useState(false);

  const job = jobs.find((j) => j.id === id);
  if (!job) return <FullPageSpinner label="Loading gig…" />;

  const alreadyBooked = isBooked(job.id);
  const isOwnJob = job.posterId && user?.id === job.posterId;
  const currentBooking = bookings.find((b) => b.jobId === job.id);
  const jobPosterBookings = posterBookings.filter((b) => b.jobId === job.id);
  const catColor = CATEGORY_COLORS[job.category] || "#6D28D9";
  const estPay =
    job.payType === "hourly" ? `$${job.pay}/hr · ~$${job.pay * job.estimatedHours} estimated` : `$${job.pay} flat rate`;
  const hasAvailableSlot = job.slots?.some((s) => !s.taken);

  const baseRate = counterPrice ? parseFloat(counterPrice) || job.pay : job.pay;
  const gross = job.payType === "hourly" ? baseRate * (job.estimatedHours || 1) : baseRate;
  const fee = gross * SERVICE_FEE_PCT;
  const net = gross - fee;

  const handleBook = async () => {
    if (!selectedSlot && hasAvailableSlot) return;
    setBooking(true);
    const slot = job.slots?.find((s) => s.id === selectedSlot);
    const counter = counterPrice ? parseFloat(counterPrice) : null;
    await bookJob(job.id, selectedSlot, slot?.label, counter);
    addXP(25);
    recordApply(job.payType === "flat" ? job.pay : job.pay * job.estimatedHours);
    updateChallenge("c1", 1);
    if (job.category === "Tech Help") updateChallenge("c3", 1);
    showToast({
      icon: "🎉",
      title: "Gig Booked! +25 XP",
      message: `"${job.title}" booked${counter ? ` · counter-offer $${counter} sent` : ""}`,
    });
    router.push("/my-jobs");
  };

  const report = async (reason: string) => {
    if (!user) return;
    try {
      await submitReport({ reporterId: user.id, reportedUserId: job.posterId, jobId: job.id, reason });
      showToast({ icon: "🚩", title: "Report submitted", message: "Thanks — our team will review this gig." });
    } catch {
      showToast({ icon: "⚠️", title: "Could not submit", message: "Please try again." });
    }
    setReportOpen(false);
  };

  const status = currentBooking ? STATUS_CONTENT[currentBooking.status] || STATUS_CONTENT.pending : null;
  const canMessage = !!currentBooking && ["pending", "confirmed", "completed"].includes(currentBooking.status);

  return (
    <div className="mx-auto w-full max-w-2xl px-5 py-6 pb-32">
      {job.urgent && (
        <div className="mb-4 flex items-center justify-center gap-1.5 rounded-xl bg-urgent-light py-2.5 text-sm font-extrabold text-urgent">
          <Zap className="size-4" /> URGENT — Needed ASAP
        </div>
      )}

      <span className="inline-block rounded-lg px-2.5 py-1 text-xs font-bold" style={{ backgroundColor: catColor + "22", color: catColor }}>
        {job.category}
      </span>
      <h1 className="mt-3 text-2xl font-black leading-tight text-ink">{job.title}</h1>

      <div className="mt-3 flex flex-wrap gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-xl bg-accent-light px-3 py-2 text-sm font-bold text-success">
          <DollarSign className="size-4" /> {estPay}
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-xl bg-canvas px-3 py-2 text-sm font-semibold text-ink-soft">
          <MapPin className="size-4" /> {job.location}
        </span>
        {RECUR_LABEL[job.recurrence] && (
          <span className="inline-flex items-center gap-1.5 rounded-xl bg-primary/10 px-3 py-2 text-sm font-bold text-primary">
            <Repeat className="size-4" /> Repeats {RECUR_LABEL[job.recurrence]}
          </span>
        )}
      </div>

      {job.photos?.length > 0 && (
        <div className="mt-5 flex gap-3 overflow-x-auto">
          {job.photos.map((u, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={i} src={u} alt="" className="h-44 w-64 shrink-0 rounded-2xl object-cover" />
          ))}
        </div>
      )}

      <div className="mt-7">
        <Section title="About this gig">
          <p className="whitespace-pre-wrap leading-relaxed text-ink">{job.description}</p>
        </Section>

        {job.requirements?.length > 0 && (
          <Section title="Requirements">
            <ul className="space-y-1.5">
              {job.requirements.map((r, i) => (
                <li key={i} className="flex gap-2 text-ink">
                  <span className="text-primary">•</span> {r}
                </li>
              ))}
            </ul>
          </Section>
        )}

        <Section title="About the poster">
          <PosterTrustCard poster={job.poster} posterId={job.posterId} />
          {!isOwnJob && (
            <button onClick={() => setReportOpen(true)} className="mt-3 flex w-full items-center justify-center gap-1.5 text-sm font-medium text-ink-muted hover:text-urgent">
              <Flag className="size-3.5" /> Report this gig
            </button>
          )}
        </Section>

        {job.slots?.length > 0 && !alreadyBooked && !isOwnJob && (
          <Section title="Available times">
            <SlotPicker slots={job.slots} selected={selectedSlot} onSelect={setSelectedSlot} />
            {!selectedSlot && hasAvailableSlot && <p className="mt-2 text-sm italic text-ink-muted">Pick a time slot to select it</p>}
          </Section>
        )}

        {!alreadyBooked && !isOwnJob && (
          <Section title="Counter-offer (optional)">
            <div className="rounded-2xl border border-line bg-canvas p-4">
              <p className="text-sm text-ink-soft">
                Listed rate: <span className="font-bold text-ink">{estPay}</span>
              </p>
              <p className="mb-3 mt-1 text-xs text-ink-muted">Propose a different rate to negotiate before booking.</p>
              <div className="flex items-center gap-2 rounded-xl border border-line bg-white px-3 py-2">
                <span className="text-lg font-bold text-primary">$</span>
                <input
                  inputMode="decimal"
                  value={counterPrice}
                  onChange={(e) => setCounterPrice(e.target.value.replace(/[^0-9.]/g, ""))}
                  placeholder={String(job.pay)}
                  className="flex-1 bg-transparent text-lg font-bold text-ink outline-none"
                />
                <span className="text-sm font-medium text-ink-muted">{job.payType === "hourly" ? "/ hr" : "flat"}</span>
              </div>
            </div>
          </Section>
        )}

        {!alreadyBooked && !isOwnJob && (
          <Section title="Payment">
            <div className="rounded-2xl border border-line bg-canvas p-4">
              <Row label={`Gig pay${job.payType === "hourly" ? " (est.)" : ""}`} value={`$${gross.toFixed(2)}`} />
              <Row label={`GoHustlr service fee (${Math.round(SERVICE_FEE_PCT * 100)}%)`} value={`−$${fee.toFixed(2)}`} />
              <div className="my-2 h-px bg-line" />
              <Row label="You receive" value={`$${net.toFixed(2)}`} bold />
              <p className="mt-2.5 text-xs leading-relaxed text-ink-muted">
                Paid securely in-app and released to you after the poster verifies your work. Tips (if any) are yours in full.
              </p>
            </div>
          </Section>
        )}

        {job.reviews?.length > 0 && (
          <Section title={`Reviews (${job.reviews.length})`}>
            <div className="space-y-2.5">
              {job.reviews.map((r) => (
                <div key={r.id} className="rounded-2xl bg-canvas p-4">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold text-ink">{r.author}</span>
                    <RatingStars value={r.rating} size={12} />
                    <span className="ml-auto text-xs text-ink-muted">{r.date}</span>
                  </div>
                  {r.text && <p className="mt-1.5 text-sm text-ink-soft">{r.text}</p>}
                </div>
              ))}
            </div>
          </Section>
        )}
      </div>

      {/* Sticky action bar */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-white/95 backdrop-blur md:left-64">
        <div className="mx-auto w-full max-w-2xl px-5 py-4 pb-6 md:pb-4">
          {job.status === "cancelled" ? (
            <div className="rounded-2xl bg-canvas py-4 text-center font-bold text-ink-muted">This listing has been removed</div>
          ) : isOwnJob ? (
            <div className="rounded-2xl border border-primary/30 bg-primary-light py-3.5 text-center">
              <p className="font-bold text-primary">
                {jobPosterBookings.length > 0
                  ? `${jobPosterBookings.length} application${jobPosterBookings.length !== 1 ? "s" : ""} received`
                  : "Your gig — awaiting applications"}
              </p>
              {jobPosterBookings.length > 0 && (
                <button onClick={() => router.push("/hiring")} className="mt-1 text-sm font-bold text-primary underline">
                  Manage in Hiring →
                </button>
              )}
            </div>
          ) : alreadyBooked && status ? (
            <div>
              <div className="flex items-start gap-3 rounded-2xl p-3.5" style={{ backgroundColor: status.bg }}>
                <status.Icon className="mt-0.5 size-5 shrink-0" style={{ color: status.color }} />
                <div>
                  <p className="font-extrabold" style={{ color: status.color }}>{status.title}</p>
                  <p className="text-xs text-ink-soft">{status.desc}</p>
                </div>
              </div>
              {canMessage && (
                <Button variant="secondary" fullWidth className="mt-2.5" onClick={() => router.push("/messages")}>
                  <MessageCircle className="size-4" /> Message poster
                </Button>
              )}
            </div>
          ) : (
            <Button fullWidth size="lg" loading={booking} disabled={!selectedSlot && hasAvailableSlot} onClick={handleBook}>
              {selectedSlot
                ? counterPrice
                  ? `Book · counter $${counterPrice}`
                  : "Book this gig"
                : hasAvailableSlot
                  ? "Select a time slot first"
                  : "Book this gig"}
            </Button>
          )}
        </div>
      </div>

      <Modal open={reportOpen} onClose={() => setReportOpen(false)} title="Report this gig" size="sm">
        <p className="mb-3 text-sm text-ink-soft">Why are you reporting it?</p>
        <div className="space-y-2">
          {REPORT_REASONS.map((reason) => (
            <button
              key={reason}
              onClick={() => report(reason)}
              className="w-full rounded-xl border border-line bg-white px-4 py-3 text-left text-sm font-semibold text-ink hover:border-urgent hover:text-urgent"
            >
              {reason}
            </button>
          ))}
        </div>
      </Modal>
    </div>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className="flex items-center justify-between py-1">
      <span className={bold ? "font-extrabold text-ink" : "text-sm text-ink-soft"}>{label}</span>
      <span className={bold ? "text-base font-black text-success" : "text-sm font-semibold text-ink"}>{value}</span>
    </div>
  );
}
