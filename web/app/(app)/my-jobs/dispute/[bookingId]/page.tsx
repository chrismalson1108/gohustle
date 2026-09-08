"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Clock, Camera, LifeBuoy } from "lucide-react";
import { supabase } from "@/lib/supabaseClient";
import { useAuth } from "@/lib/auth";
import { useUser } from "@/lib/user";
import { useJobs } from "@/lib/jobs";
import { money } from "@/lib/format";
import { findProhibited } from "@gohustlr/shared";
import { logModerationBlock } from "@/lib/moderation";
import { uploadPrivateImages } from "@/lib/uploadImage";
import SignedPhotoStrip from "@/components/SignedPhotoStrip";
import PageHeader, { PageContainer } from "@/components/PageHeader";
import { FullPageSpinner } from "@/components/ui/Spinner";
import { Textarea, FieldError } from "@/components/ui/Field";
import Button from "@/components/ui/Button";

// The web half of src/screens/DisputeScreen.js. Same read path (my_dispute), same write
// path (respond_to_dispute), same one-reply rule — a second copy of either would be a
// second place for "who may answer, and how often" to drift.
export default function DisputePage() {
  const { bookingId } = useParams<{ bookingId: string }>();
  const { user } = useAuth();
  const { showToast } = useUser();
  const { bookings, refreshBookings } = useJobs();

  type Dispute = {
    id: string;
    raised_by: string;
    reason: string | null;
    photos: string[] | null;
    proposed_pct: number | null;
    pct_paid: number | null;
    respondent_id: string | null;
    settle_after: string | null;
    responded_at: string | null;
    response_stance: string | null;
    response_note: string | null;
    response_photos: string[] | null;
    resolution_pct: number | null;
    resolution_note: string | null;
  };

  const [dispute, setDispute] = useState<Dispute | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [note, setNote] = useState("");
  const [photos, setPhotos] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [contesting, setContesting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error: e } = await supabase.rpc("my_dispute", { p_booking_id: bookingId });
    // A failed read and an empty one must not look the same: "nothing here" told to
    // somebody whose pay is being withheld is the worst possible wrong answer.
    if (e) { setFailed(true); setDispute(null); }
    else { setFailed(false); setDispute((Array.isArray(data) ? data[0] : data) ?? null); }
    setLoading(false);
  }, [bookingId]);

  useEffect(() => { void load(); }, [load]);

  const booking = bookings.find((b) => b.id === bookingId);
  const proposed = dispute?.proposed_pct ?? 100;
  const settled = dispute?.pct_paid != null;
  const answered = !!dispute?.responded_at;
  const isRespondent = !!dispute && user?.id === dispute.respondent_id;
  // The poster reaches this same page to watch their own report, and every label below
  // is perspective-dependent — "$30 of your pay is on hold" is about their money, not
  // the reader's, and reads as a bug on a screen about somebody else's money.
  const isRaiser = !!dispute && user?.id === dispute.raised_by;
  const amountCents = booking?.amountCentsQuoted ?? null;
  const atStake = amountCents != null ? Math.round((amountCents * (100 - proposed)) / 100) : null;
  const hoursLeft = dispute?.settle_after
    ? Math.max(0, Math.round((new Date(dispute.settle_after).getTime() - Date.now()) / 3_600_000))
    : null;

  async function addPhotos(files: FileList | null) {
    if (!files?.length || !user) return;
    setBusy(true);
    try {
      const paths = await uploadPrivateImages(Array.from(files).slice(0, 6), "completion-photos", user.id);
      setPhotos((p) => [...p, ...paths].slice(0, 6));
    } catch {
      setError("Those photos didn't upload. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function respond(stance: "accept" | "contest") {
    setError(null);
    if (stance === "contest" && !note.trim()) {
      setError("Say what actually happened so it can be reviewed.");
      return;
    }
    const term = note ? findProhibited(note) : null;
    if (term) {
      logModerationBlock(term, "dispute_response", note);
      setError("That contains words that aren't allowed. Please edit it.");
      return;
    }
    setBusy(true);
    try {
      const { error: e } = await supabase.rpc("respond_to_dispute", {
        p_dispute_id: dispute!.id,
        p_stance: stance,
        p_note: note.trim() || null,
        p_photos: photos,
      });
      if (e) throw e;
      showToast(
        stance === "accept"
          ? { icon: "✅", title: "Accepted", message: "This will be paid at the adjusted amount shortly." }
          : { icon: "📨", title: "Sent", message: "Nothing is paid while we look at it — and if nobody has decided in about five days, you are paid in full." },
      );
      await load();
      await refreshBookings();
    } catch (e) {
      setError((e as Error)?.message || "That didn't send. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <FullPageSpinner />;

  return (
    <>
      <PageHeader title="Payment adjustment" subtitle={booking?.job?.title ?? undefined} />
      <PageContainer>
        {failed ? (
          <div className="rounded-2xl bg-white p-6 shadow-[var(--shadow-card)]">
            <h2 className="m-0 mb-2 text-xl font-bold text-ink">Couldn&apos;t load this</h2>
            <p className="m-0 mb-4 text-[15px] text-ink-soft">
              Something on our side went wrong. Your case is unaffected.
            </p>
            <Button onClick={() => void load()}>Try again</Button>
          </div>
        ) : !dispute ? (
          <div className="rounded-2xl bg-white p-6 shadow-[var(--shadow-card)]">
            <h2 className="m-0 mb-2 text-xl font-bold text-ink">Nothing reported</h2>
            <p className="m-0 text-[15px] text-ink-soft">There is no open report on this gig.</p>
          </div>
        ) : (
          <div className="space-y-4">
            {/* What is at stake, in money. A percentage of an unstated number is not
                something a person can act on. */}
            <div className="rounded-2xl bg-white p-6 text-center shadow-[var(--shadow-card)]">
              <p className="m-0 text-sm text-ink-soft">{isRaiser ? "You asked to pay" : "The poster asked to pay"}</p>
              <p className="m-0 text-[46px] font-extrabold leading-none tracking-tight text-ink">{proposed}%</p>
              {atStake != null && (
                <p className="m-0 mt-1 text-[15px] text-ink-soft">
                  {isRaiser
                    ? `${money(atStake / 100)} comes back to you if this stands`
                    : `${money(atStake / 100)} of your pay is on hold`}
                </p>
              )}
              {!settled && !answered && hoursLeft != null && (
                <span className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-warning-light px-3 py-1.5 text-xs font-bold text-warning-deep">
                  <Clock className="size-3.5" />
                  {hoursLeft > 0
                    ? `${hoursLeft} hour${hoursLeft === 1 ? "" : "s"} left ${isRaiser ? "for them to reply" : "to reply"}`
                    : "The reply window has closed"}
                </span>
              )}
            </div>

            <section className="rounded-2xl bg-white p-6 shadow-[var(--shadow-card)]">
              <h2 className="m-0 mb-3 text-xs font-bold tracking-wide text-ink-muted uppercase">
                {isRaiser ? "What you said" : "What they said"}
              </h2>
              <p className="m-0 text-[15px] leading-relaxed text-ink">{dispute.reason || "No reason given."}</p>
              <SignedPhotoStrip label={isRaiser ? "Your photos" : "Their photos"} values={dispute.photos} bucket="completion-photos" />
            </section>

            {answered ? (
              <section className="rounded-2xl bg-white p-6 shadow-[var(--shadow-card)]">
                <h2 className="m-0 mb-3 text-xs font-bold tracking-wide text-ink-muted uppercase">
                  {isRaiser ? "Their reply" : "Your reply"}
                </h2>
                <p className="m-0 mb-1 text-[15px] font-bold text-ink">
                  {dispute.response_stance === "accept"
                    ? isRaiser ? "They accepted the adjustment." : "You accepted the adjustment."
                    : isRaiser ? "They disputed this." : "You disputed this."}
                </p>
                {dispute.response_note && (
                  <p className="m-0 text-[15px] leading-relaxed text-ink">{dispute.response_note}</p>
                )}
                <SignedPhotoStrip values={dispute.response_photos} bucket="completion-photos" />
                {!settled && dispute.response_stance === "contest" && (
                  <p className="m-0 mt-3 text-sm text-ink-soft">
                    Nothing is paid while this is open. Someone from GoHustlr reads both sides
                    — and if we have not decided within about five days of the payment being held, you are paid in
                    FULL rather than the amount they asked for.
                  </p>
                )}
              </section>
            ) : settled ? null : isRaiser ? (
              <section className="rounded-2xl bg-white p-6 shadow-[var(--shadow-card)]">
                <h2 className="m-0 mb-3 text-xs font-bold tracking-wide text-ink-muted uppercase">Waiting for them</h2>
                <p className="m-0 text-[15px] leading-relaxed text-ink-soft">
                  They have been told, and can accept or reply until{" "}
                  {dispute.settle_after ? new Date(dispute.settle_after).toLocaleString() : "the window closes"}. If they
                  say nothing, this settles at {proposed}% on its own — you do not need to do anything.
                </p>
              </section>
            ) : isRespondent ? (
              <section className="rounded-2xl bg-white p-6 shadow-[var(--shadow-card)]">
                <h2 className="m-0 mb-3 text-xs font-bold tracking-wide text-ink-muted uppercase">Your side</h2>
                {!contesting ? (
                  <>
                    <p className="m-0 mb-4 text-sm leading-relaxed text-ink-soft">
                      If they are right, accepting pays you {proposed}% now. If they are not, say
                      what actually happened — nothing is paid while we look at it, and if we run
                      out of time you are paid in full.
                    </p>
                    <div className="flex flex-wrap gap-3">
                      <Button variant="secondary" disabled={busy} onClick={() => void respond("accept")}>
                        Accept {proposed}%
                      </Button>
                      <Button disabled={busy} onClick={() => setContesting(true)}>
                        That&apos;s not right
                      </Button>
                    </div>
                  </>
                ) : (
                  <>
                    <Textarea
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      maxLength={1000}
                      placeholder="e.g. That's the back door — we were hired for the front, and it's in our finished photos."
                    />
                    <label className="mt-3 inline-flex cursor-pointer items-center gap-2 text-sm font-semibold text-primary">
                      <Camera className="size-4" />
                      {photos.length ? `${photos.length} photo${photos.length === 1 ? "" : "s"} added` : "Add your photos"}
                      <input
                        type="file"
                        accept="image/*"
                        multiple
                        className="hidden"
                        onChange={(e) => void addPhotos(e.target.files)}
                      />
                    </label>
                    <FieldError>{error}</FieldError>
                    <div className="mt-4 flex flex-wrap gap-3">
                      <Button variant="secondary" disabled={busy} onClick={() => setContesting(false)}>
                        Back
                      </Button>
                      <Button disabled={busy} onClick={() => void respond("contest")}>
                        {busy ? "Sending…" : "Send my reply"}
                      </Button>
                    </div>
                    <p className="m-0 mt-3 text-sm text-ink-soft">
                      You can reply once, so include everything that matters.
                    </p>
                  </>
                )}
                {!contesting && <FieldError>{error}</FieldError>}
              </section>
            ) : null}

            {settled && (
              <section className="rounded-2xl bg-white p-6 shadow-[var(--shadow-card)]">
                <h2 className="m-0 mb-3 text-xs font-bold tracking-wide text-ink-muted uppercase">Outcome</h2>
                <p className="m-0 text-[15px] font-bold text-ink">
                  Settled at {dispute.pct_paid}%{dispute.resolution_pct != null ? " by GoHustlr" : ""}.
                </p>
                {dispute.resolution_note && (
                  <p className="m-0 mt-1 text-[15px] leading-relaxed text-ink">{dispute.resolution_note}</p>
                )}
              </section>
            )}

            <Link
              href="/support"
              className="flex items-center justify-center gap-2 py-3 text-sm text-ink-soft hover:text-primary"
            >
              <LifeBuoy className="size-4" />
              Something else wrong? Contact support
            </Link>
          </div>
        )}
      </PageContainer>
    </>
  );
}
