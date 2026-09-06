"use client";

import { useState } from "react";
import { AlertCircle, MapPin } from "lucide-react";
import { supabase } from "@/lib/supabaseClient";
import { useUser } from "@/lib/user";
import Button from "@/components/ui/Button";
import Modal from "@/components/ui/Modal";
import { SITE_URL } from "@/lib/config";

// Safety controls for a gig that is happening right now — the web half of
// src/components/SafetyBar.js.
//
// The web app can already START a gig (my-jobs writes bookings.started_at, which opens
// a safety_checkins row exactly as mobile does), but it carried neither of the two
// USER-INITIATED safety controls. The automatic side was never the gap: open_safety_checkin
// fires on any started_at write regardless of client, so a web earner still gets the
// check-in timer, its nudge and its escalation. What was missing is everything the person
// can reach for themselves — no way to tell a friend where they are, and no SOS. An
// earner working from a phone browser, with no TestFlight build, had only the generic
// Support form. The public /s/[token] page has existed on web the whole time; only the
// minting side was absent, so the feature was readable and not usable.
//
// Same two actions, deliberately the same difference in weight as mobile:
//   SHARE      one tap, no confirmation. Friction here means it does not get used, and
//              an unused safety feature is the same as an absent one.
//   EMERGENCY  a confirm step, because a mis-tap files a real report and pages a real
//              person — but the confirm is one click and the wording does not scold.
//
// The token is minted SERVER-SIDE by create_gig_share (SECURITY DEFINER, CSPRNG token,
// 24h cap, re-applies the accepted-booking condition, and hands back a LIVE link rather
// than minting a second one). INSERT on gig_shares is revoked from clients, so this
// component cannot choose the token or the expiry any more than the mobile one can.

const SHARE_HOURS = 12;

// Prefer the origin the earner is actually on — /s/[token] is a route of this same
// Next app, so a preview or staging deployment must not hand out gohustlr.com links
// that resolve against different data. SITE_URL is the SSR-time fallback.
function shareOrigin(): string {
  return typeof window !== "undefined" && window.location?.origin
    ? window.location.origin
    : SITE_URL;
}

export default function SafetyBar({ bookingId }: { bookingId: string }) {
  const { showToast } = useUser();
  const [busy, setBusy] = useState<"share" | "sos" | null>(null);
  const [confirming, setConfirming] = useState(false);

  const share = async () => {
    setBusy("share");
    try {
      const { data: token, error } = await supabase.rpc("create_gig_share", {
        p_booking: bookingId,
        p_hours: SHARE_HOURS,
      });
      if (error) throw error;
      if (!token) throw new Error("Could not create a link for this gig.");

      const url = `${shareOrigin()}/s/${token}`;
      const text =
        "I'm working a GoHustlr gig right now. You can see where I am and when I'm " +
        `due to finish here: ${url}`;

      // navigator.share is the phone-browser path this whole component exists for.
      // A user cancelling the sheet throws AbortError — that is not a failure and must
      // not become an error toast, so it falls through to the copy fallback silently.
      if (typeof navigator !== "undefined" && navigator.share) {
        try {
          await navigator.share({ text, url });
          return;
        } catch (e) {
          if ((e as { name?: string })?.name === "AbortError") return;
        }
      }
      await navigator.clipboard.writeText(url);
      showToast({
        icon: "📍",
        title: "Link copied",
        message: `Send it to someone you trust. It expires in ${SHARE_HOURS} hours.`,
      });
    } catch (e) {
      showToast({
        icon: "⚠️",
        title: "Could not share",
        message: (e as Error)?.message ?? "Please try again.",
      });
    } finally {
      setBusy(null);
    }
  };

  const raise = async () => {
    setBusy("sos");
    try {
      const { error } = await supabase.rpc("raise_gig_emergency", {
        p_booking: bookingId,
        p_note: "Emergency raised from the active gig screen (web).",
      });
      if (error) throw error;
      setConfirming(false);
      showToast({
        icon: "🚨",
        title: "Help is being alerted",
        message: "Our safety team has been notified. Keep this page open if you can.",
      });
    } catch (e) {
      showToast({
        icon: "⚠️",
        title: "Could not send",
        message: (e as Error)?.message ?? "Please call for help directly.",
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="mt-2.5 flex gap-2">
        <Button
          variant="secondary"
          size="sm"
          className="min-w-0 flex-1"
          loading={busy === "share"}
          onClick={share}
        >
          <MapPin className="size-4 shrink-0" />
          <span className="truncate">Share my gig</span>
        </Button>
        {/* Outline, not a filled red button — the same rule the Withdraw/Cancel links
            follow on this page. A filled red control beside a routine one reads as the
            primary action. */}
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-xl border border-urgent px-3.5 text-sm font-bold text-urgent transition hover:bg-urgent hover:text-white"
        >
          <AlertCircle className="size-4 shrink-0" />
          Get help
        </button>
      </div>

      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Get help now?"
        size="sm"
        footer={
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button variant="danger" className="flex-1" loading={busy === "sos"} onClick={raise}>
              Alert GoHustlr
            </Button>
          </div>
        }
      >
        <p className="text-sm text-ink-soft">
          This alerts the GoHustlr safety team immediately with your gig details. If you are
          in danger, call your local emergency number first.
        </p>
      </Modal>
    </>
  );
}
