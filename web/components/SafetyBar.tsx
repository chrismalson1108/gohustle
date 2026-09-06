"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, MapPin, MapPinOff } from "lucide-react";
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
  const [busy, setBusy] = useState<"share" | "sos" | "revoke" | null>(null);
  const [liveShare, setLiveShare] = useState(false);
  const [confirming, setConfirming] = useState(false);

  // Whether a link is live decides whether the "Stop sharing" control exists at all.
  // The Terms and the Privacy Policy both tell the earner a share "can be switched off
  // at any time"; the schema always allowed it (gig_shares_revoke_own) and until the
  // mobile fix landed no client ever wrote the column. Shipping the web bar without
  // this would have re-created the same broken promise on a second surface — which is
  // what __tests__/parity.test.js caught when the two branches met.
  const refreshLiveShare = useCallback(async () => {
    const { data } = await supabase
      .from("gig_shares")
      .select("id")
      .eq("booking_id", bookingId)
      .is("revoked_at", null)
      .gt("expires_at", new Date().toISOString())
      .limit(1);
    setLiveShare((data?.length ?? 0) > 0);
  }, [bookingId]);

  useEffect(() => {
    refreshLiveShare();
  }, [refreshLiveShare]);

  const revoke = async () => {
    setBusy("revoke");
    try {
      // EVERY live link for this booking, not the newest one. create_gig_share hands
      // back an existing live link rather than minting a second, but a link minted
      // before that behaviour — or from the other client — must die here too: "stop
      // sharing" that leaves one alive is worse than none.
      const { error } = await supabase
        .from("gig_shares")
        .update({ revoked_at: new Date().toISOString() })
        .eq("booking_id", bookingId)
        .is("revoked_at", null);
      if (error) throw error;
      setLiveShare(false);
      showToast({ icon: "🔒", title: "Sharing stopped", message: "That link no longer works." });
    } catch (e) {
      showToast({
        icon: "⚠️",
        title: "Could not stop sharing",
        message: (e as Error)?.message ?? "Please try again.",
      });
    } finally {
      setBusy(null);
      refreshLiveShare();
    }
  };

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
          setLiveShare(true);
          return;
        } catch (e) {
          if ((e as { name?: string })?.name === "AbortError") {
            setLiveShare(true);
            return;
          }
        }
      }
      await navigator.clipboard.writeText(url);
      setLiveShare(true);
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

      {liveShare && (
        <button
          type="button"
          onClick={revoke}
          disabled={busy === "revoke"}
          className="mt-2 inline-flex items-center gap-1.5 text-sm font-semibold text-ink-soft underline underline-offset-2 disabled:opacity-50"
        >
          <MapPinOff className="size-4 shrink-0" />
          {busy === "revoke" ? "Stopping…" : "Stop sharing my location"}
        </button>
      )}

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
