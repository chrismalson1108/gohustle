"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Settings, Wallet, Receipt, Heart, ShieldCheck, GraduationCap, Gift, FileText, ChevronRight, Star, Bookmark, CalendarClock, Eye, Briefcase, Bell, BellRing, LifeBuoy, Search, AlertCircle, CreditCard,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { BADGE_DEFS, collegeLine, computeEarnerInsights } from "@gohustlr/shared";
import { useUser } from "@/lib/user";
import { useJobs } from "@/lib/jobs";
import { useAuth } from "@/lib/auth";
import { supabase } from "@/lib/supabaseClient";
import { fetchVerificationStatus, requestVerification } from "@/lib/verification";
import { getReferralCode, fetchReferralCount } from "@/lib/referrals";
import { SUPPORT_EMAIL } from "@/lib/legal";
import PageHeader, { PageContainer } from "@/components/PageHeader";
import Avatar from "@/components/ui/Avatar";
import XPBar from "@/components/XPBar";
import MoneyGoalCard from "@/components/MoneyGoalCard";
import WeeklyGoalsCard from "@/components/WeeklyGoalsCard";
import ChallengeCard from "@/components/ChallengeCard";
import RatingStars from "@/components/ui/RatingStars";
import Button, { buttonClasses } from "@/components/ui/Button";
import { FullPageSpinner } from "@/components/ui/Spinner";
import { classNames, money } from "@/lib/format";

interface Review {
  id: string;
  rating: number;
  text: string | null;
  date: string | null;
  role: string;
  reviewer: { name: string | null; avatar_initial: string | null; avatar_url: string | null } | null;
}

export default function ProfilePage() {
  const u = useUser();
  const { refreshProfile, showToast } = u;
  const { postedJobs, posterBookings, profileBadgeCount, bookings, getPaymentReadiness } = useJobs();
  const { user } = useAuth();
  const [alertCount, setAlertCount] = useState(0);

  const [idv, setIdv] = useState({ verified: false, status: "none" });
  const [pane, setPane] = useState<"progress" | "profile">("progress");
  const [refCode, setRefCode] = useState("");
  const [refCount, setRefCount] = useState(0);
  const [reviews, setReviews] = useState<Review[]>([]);
  // null until checked — the nudge stays hidden rather than flashing "set up
  // payouts" at someone who already has.
  const [payReady, setPayReady] = useState<Awaited<ReturnType<typeof getPaymentReadiness>> | null>(null);

  const loadReviews = useCallback(async () => {
    if (!user) return;
    const { data } = await supabase
      .from("reviews")
      .select("id, rating, text, date, role, reviewer:profiles!reviewer_id(name, avatar_initial, avatar_url)")
      .eq("reviewed_user_id", user.id)
      .order("created_at", { ascending: false });
    setReviews((data as unknown as Review[]) || []);
  }, [user]);

  useEffect(() => {
    if (!user) return;
    fetchVerificationStatus(user.id).then(setIdv).catch(() => {});
    getReferralCode(user.id).then(setRefCode).catch(() => {});
    fetchReferralCount(user.id).then(setRefCount).catch(() => {});
    loadReviews();
    // One-off unread-alert count (the realtime badge hook lives in the layout;
    // re-subscribing here would collide on the shared channel name).
    supabase
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("read", false)
      .eq("archived", false)
      .then(({ count }) => setAlertCount(count || 0), () => {});
    // Payout/card readiness drives the pinned nudge above the pane switch.
    // Failure is non-blocking: payReady stays null and the nudge simply doesn't
    // render, which is the right default — never tell someone their payouts are
    // broken because a status call timed out.
    getPaymentReadiness().then(setPayReady).catch(() => {});
  }, [user, loadReviews, getPaymentReadiness]);

  const verifyIdentity = async () => {
    if (idv.verified) return;
    try {
      const res = (await requestVerification()) as { url?: string; alreadyVerified?: boolean };
      if (res?.url) window.location.href = res.url;
      else if (res?.alreadyVerified) {
        setIdv((p) => ({ ...p, verified: true, status: "verified" }));
        refreshProfile();
        showToast({ icon: "✅", title: "Already verified", message: "Your identity is verified." });
      } else setIdv((p) => ({ ...p, status: "pending" }));
    } catch (err) {
      showToast({ icon: "⚠️", title: "Could not start", message: (err as Error).message || "Please try again." });
    }
  };

  const invite = async () => {
    const text = `Join me on GoHustlr — the gig marketplace for students. Sign up with my referral code ${refCode} to get started!\n\nhttps://gohustlr.com`;
    if (typeof navigator !== "undefined" && navigator.share) {
      try {
        await navigator.share({ text });
      } catch {
        /* cancelled */
      }
    } else {
      try {
        await navigator.clipboard.writeText(text);
        showToast({ icon: "📋", title: "Copied!", message: "Referral message copied — paste it to a friend." });
      } catch {
        showToast({ icon: "🎁", title: "Your code", message: refCode });
      }
    }
  };

  // Avg $/job is over VERIFIED bookings — earnings only accrue on verify.
  const completedCount = (bookings || []).filter((b) => b.status === "verified").length;
  // "Jobs done" is derived from bookings that actually FINISHED (mutual
  // completion or verified), never a counter bumped at apply time — the same
  // rule mobile's stats strip uses.
  const jobsDone = (bookings || []).filter((b) => b.status === "completed" || b.status === "verified").length;
  const insights = computeEarnerInsights(bookings);

  // ── Payment readiness ───────────────────────────────────────────────────────
  // Ported from mobile ProfileScreen. Every user can both earn and post, so both
  // halves are always checked.
  //
  // 'pending' means Stripe is REVIEWING and the user has nothing to do — nagging
  // them to "finish setup" in that state is a circular prompt with no exit, which
  // is a bug mobile already fixed. Hence payoutWaiting suppresses the nudge.
  const payoutState = payReady?.payout?.state ?? "none";
  const payoutWaiting = payoutState === "pending";
  const needsPayout = !!payReady && !payReady.payoutReady && !payoutWaiting;
  const needsCard = !!payReady && !payReady.paymentMethodReady;
  const payoutAlertCopy =
    payoutState === "restricted"
      ? { title: "There's a problem with your payout account", sub: "Tap for details and support →" }
      : payReady?.payout?.hasAccount
        ? { title: "Finish your payout setup", sub: "Stripe still needs a few details →" }
        : { title: "Set up payouts to get paid", sub: "Connect your bank to receive earnings →" };
  const paymentAlert =
    needsPayout && needsCard
      ? { title: "Finish setting up payments", sub: "Connect a bank and add a card →" }
      : needsPayout
        ? payoutAlertCopy
        : needsCard
          ? { title: "Add a payment method to hire", sub: "Save a card so you can book gigs →" }
          : null;
  // The always-visible Payments row says what's actually true, rather than one
  // hard-coded string that reads the same whether or not you can be paid.
  const paymentsSub = !payReady ? "Manage your payment info" : "Manage payout & payment methods";

  const college = collegeLine({ school: u.school, major: u.major, gradYear: u.gradYear });
  const workerReviews = reviews.filter((r) => r.role === "earner");
  const clientReviews = reviews.filter((r) => r.role === "poster");
  const avg = (arr: Review[]) =>
    arr.length ? (arr.reduce((s, r) => s + Number(r.rating || 0), 0) / arr.length).toFixed(1) : "—";

  // Never render placeholder profile data as if it were the user's account — a
  // failed load must look like a load problem, not like a blank account.
  if (u.profileStatus !== "ready") {
    return (
      <div>
        <PageHeader title="You" width="content" />
        <PageContainer width="content">
          {u.profileStatus === "loading" ? (
            <FullPageSpinner label="Loading your profile…" />
          ) : (
            <div className="flex min-h-[50dvh] flex-col items-center justify-center gap-3 text-center">
              <p className="text-lg font-bold text-ink">Couldn&apos;t load your profile</p>
              <p className="max-w-prose text-sm text-ink-soft">
                Check your connection and try again — your account and data are safe.
              </p>
              <Button className="mt-2" onClick={u.retryProfile}>Try again</Button>
            </div>
          )}
        </PageContainer>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="You"
        width="content"
        right={
          // Bell + gear, pinned to the header exactly as on mobile's You tab, so
          // both live OUTSIDE the Progress/Profile switch and stay reachable from
          // either pane. The bell duplicates the "Alerts" row on purpose — it is
          // the one-tap path; the row is the discoverable one.
          <div className="flex items-center gap-1">
            <Link
              href="/notifications"
              aria-label={alertCount > 0 ? `Alerts, ${alertCount} unread` : "Alerts"}
              className="relative flex size-11 items-center justify-center rounded-full bg-white text-ink transition hover:text-primary"
            >
              <Bell className="size-5" />
              {alertCount > 0 && (
                <span className="absolute right-1.5 top-1.5 inline-flex min-w-4 shrink-0 items-center justify-center rounded-full bg-urgent px-1 text-[10px] font-bold leading-4 text-white">
                  {alertCount > 9 ? "9+" : alertCount}
                </span>
              )}
            </Link>
            <Link
              href="/profile/settings"
              aria-label="Profile settings"
              className="flex size-11 items-center justify-center rounded-full bg-white text-ink transition hover:text-primary"
            >
              <Settings className="size-5" />
            </Link>
          </div>
        }
      >
        <div className="mt-4 flex items-center gap-4">
          {/* The avatar opens your PUBLIC profile, mirroring the mobile You tab —
              seeing yourself as others do is the thing people actually want from
              their own picture. Changing the photo moved to /profile/settings. */}
          <Link
            href={user ? `/u/${user.id}` : "/profile"}
            aria-label="View your public profile"
            className="relative shrink-0 rounded-full transition hover:opacity-90"
          >
            <Avatar url={u.avatarUrl} initial={u.avatarInitial} name={u.name} size={64} />
          </Link>
          {/* min-w-0 on the text column so a long name truncates instead of
              pushing the block past the header's measure. */}
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-1.5">
              <p className="truncate text-xl font-bold text-ink">{u.name}</p>
              {idv.verified && <ShieldCheck className="size-4 shrink-0 text-success" />}
              {u.studentVerified && <GraduationCap className="size-4 shrink-0 text-ink-soft" />}
            </div>
            <div className="mt-0.5 flex min-w-0 items-center gap-2 text-ink-soft">
              {u.reviewCount > 0 ? (
                <>
                  <RatingStars value={u.rating} size={14} />
                  <span className="truncate text-sm">
                    {u.rating.toFixed(1)} · {u.reviewCount} review{u.reviewCount !== 1 ? "s" : ""}
                  </span>
                </>
              ) : (
                <span className="text-sm">No reviews yet</span>
              )}
            </div>
            {college && <p className="mt-0.5 truncate text-sm font-semibold text-ink-soft">{college}</p>}
          </div>
        </div>
      </PageHeader>

      <PageContainer width="content" className="space-y-5">
        {/* Pinned ABOVE the pane switch, exactly as on mobile: "you can't get
            paid" must never be one tab away on the page people open most. */}
        {paymentAlert && (
          <Link
            href="/profile/payouts"
            className="flex items-center gap-3 rounded-2xl bg-white p-4 shadow-[var(--shadow-card)] transition hover:bg-canvas"
          >
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-canvas">
              <CreditCard className="size-[18px] text-primary" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block line-clamp-2 text-sm font-semibold text-ink">{paymentAlert.title}</span>
              <span className="mt-0.5 block line-clamp-2 text-xs leading-4 text-ink-muted">{paymentAlert.sub}</span>
            </span>
            <ChevronRight className="size-[18px] shrink-0 text-ink-muted" />
          </Link>
        )}

        {/* Progress vs Profile, the split the mobile You tab uses. Deliberately a
            client-state toggle on ONE page rather than the native swipe pager or
            two routes: on web a second URL for the same identity page just hurts
            linkability, and there is no back-stack cost to pay for.

            Underline segmented control ported from that tab. Weight stays 600 in
            BOTH states — a 600→700 bump on selection re-measures the label and
            clips it at 320px; only colour and the 2px indicator change. */}
        <div role="tablist" className="flex border-b border-line">
          {([
            { id: "progress", label: "Progress" },
            { id: "profile", label: "Profile" },
          ] as const).map((p) => (
            <button
              key={p.id}
              role="tab"
              aria-selected={pane === p.id}
              onClick={() => setPane(p.id)}
              className={classNames(
                "min-w-0 flex-1 pt-3 text-[15px] font-semibold transition sm:w-40 sm:flex-none",
                pane === p.id ? "text-ink" : "text-ink-muted hover:text-ink-soft",
              )}
            >
              <span className="block truncate px-2">{p.label}</span>
              <span
                className={classNames(
                  "mx-auto mt-2.5 block h-0.5 w-3/5 rounded-full",
                  pane === p.id ? "bg-primary" : "bg-transparent",
                )}
              />
            </button>
          ))}
        </div>

        {pane === "progress" ? (
          <>
        {/* Stats — the same three mobile opens the Progress pane with, in the same
            order: Jobs done / Total earned / Avg rating.

            One card with three hairline-separated columns, as on mobile, rather
            than three separate tiles. The old version sized its values with an
            inline `clamp(…, 3.4vw, …)`: `vw` tracks the VIEWPORT while the tile
            tracks the content column, and the content column loses ~256px the
            moment the desktop sidebar appears — the two move in opposite
            directions across that breakpoint. A static step plus `truncate` is
            both smaller and correct at every width. */}
        <div className="grid grid-cols-3 rounded-2xl bg-white px-2 py-4 shadow-[var(--shadow-card)]">
          {[
            { label: "Jobs done", value: String(jobsDone) },
            { label: "Total earned", value: money(u.earningsTotal) },
            { label: "Avg rating", value: u.reviewCount > 0 ? `${u.rating.toFixed(1)} ★` : "—" },
          ].map((s, i) => (
            <div
              key={s.label}
              className={classNames("min-w-0 px-2 text-center", i > 0 && "border-l border-divider")}
            >
              <p className="truncate text-lg font-bold text-ink sm:text-xl">{s.value}</p>
              <p className="mt-1 truncate text-xs font-medium text-ink-muted">{s.label}</p>
            </div>
          ))}
        </div>

        {/* Goals, earnings and insights — all moved off My Jobs, which is now gigs
            in flight and nothing else. Everything here reads from context.

            The order below is mobile's Progress pane verbatim: money goal →
            earnings → weekly goals → challenges → XP → insights → badges →
            Gigs & earnings → Saved & alerts. It is deliberate, not incidental —
            money first, XP and insights last. */}
        <MoneyGoalCard />

        {/* Container queries, not viewport ones: `main` is the query container, so
            these count the columns the card ACTUALLY has rather than guessing from
            the window and being wrong by one sidebar width. */}
        <div className="rounded-2xl bg-white p-4 shadow-[var(--shadow-card)]">
          <p className="mb-3 text-[13px] font-semibold text-ink-muted">Earnings</p>
          <div className="grid grid-cols-2 gap-2 @2xl:grid-cols-4">
            {[
              { label: "Today", value: money(u.earningsToday) },
              { label: "This week", value: money(u.earningsWeek) },
              { label: "All time", value: money(u.earningsTotal) },
              { label: "Avg/job", value: completedCount ? money(u.earningsTotal / completedCount) : "—" },
            ].map((s) => (
              <div key={s.label} className="min-w-0 rounded-xl bg-canvas px-3 py-2.5 text-center">
                <p className="truncate text-base font-bold text-ink">{s.value}</p>
                <p className="truncate text-[11px] text-ink-muted">{s.label}</p>
              </div>
            ))}
          </div>
        </div>

        <WeeklyGoalsCard />

        {u.challenges.length > 0 && (
          <section>
            <h2 className="mb-2 ml-1 text-[13px] font-semibold text-ink-muted">Challenges</h2>
            <div className="grid gap-3 @4xl:grid-cols-2">
              {u.challenges.map((c) => (
                <ChallengeCard key={c.id} challenge={c} />
              ))}
            </div>
          </section>
        )}

        {/* XP sits low in the pane, below money and challenges, because that is
            where mobile puts it — it is the least important number here. That is
            also why the level bar left the page header. The streak rides along:
            it was the strip's third stat before the strip took mobile's
            Jobs done / Total earned / Avg rating, and it had nowhere else to go. */}
        <div className="rounded-2xl bg-white p-4 shadow-[var(--shadow-card)]">
          <XPBar levelInfo={u.levelInfo} xp={u.xp} />
          <div className="mt-3 flex flex-wrap items-baseline justify-between gap-x-3 border-t border-divider pt-3">
            <span className="min-w-0 truncate text-[13px] font-semibold text-ink">Streak</span>
            <span className="shrink-0 text-[13px] font-bold text-ink">{u.streakDays}w</span>
          </div>
        </div>

        {insights && insights.jobCount > 0 && (
          <div className="rounded-2xl bg-white p-4 shadow-[var(--shadow-card)]">
            <p className="mb-3 text-[13px] font-semibold text-ink-muted">Your insights</p>
            <div className="grid grid-cols-1 gap-2 @2xl:grid-cols-3">
              {[
                { label: "Top area", value: insights.topArea?.label ?? "—" },
                { label: "Busiest", value: insights.busiestDay?.label ?? "—" },
                {
                  label: "Best day",
                  value: insights.mostProfitableDay
                    ? `${insights.mostProfitableDay.label} (${money(insights.mostProfitableDay.total)})`
                    : "—",
                },
              ].map((s) => (
                <div key={s.label} className="min-w-0 rounded-xl bg-canvas px-3 py-2.5">
                  <p className="text-[11px] font-semibold text-ink-muted">{s.label}</p>
                  <p className="mt-0.5 truncate font-bold text-ink">{s.value}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Badges — auto-fill rather than a wrap of fixed 80px tiles, so the row
            packs 3-up on a 320px phone and keeps filling a 1120px column. */}
        <section>
          <h2 className="mb-2 text-[13px] font-semibold text-ink-muted">Badges</h2>
          <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fill,minmax(min(4.75rem,100%),1fr))]">
            {Object.entries(BADGE_DEFS).map(([key, def]) => {
              const unlocked = u.badges[key]?.unlocked;
              return (
                <div
                  key={key}
                  className={classNames(
                    "flex min-h-[5.5rem] min-w-0 flex-col items-center gap-1 rounded-xl p-3 text-center",
                    unlocked ? "bg-gold-light" : "bg-white",
                  )}
                >
                  <span className={classNames("text-2xl", !unlocked && "opacity-40")}>{def.icon}</span>
                  <span
                    className={classNames(
                      "line-clamp-2 w-full text-[10px] font-semibold leading-tight",
                      unlocked ? "text-ink" : "text-ink-muted",
                    )}
                  >
                    {def.label}
                  </span>
                </div>
              );
            })}
          </div>
        </section>

        <div className="grid gap-5 @4xl:grid-cols-2">
          <Group title="Gigs & earnings">
            {/* Shown to anyone with a posting history — a listing OR a booking on
                one. Someone whose only gig is finished and archived still needs
                the way back into it. */}
            {(postedJobs.length > 0 || posterBookings.length > 0) && (
              <Row
                icon={Briefcase}
                title="Manage my gigs"
                sub={profileBadgeCount > 0 ? `${profileBadgeCount} need${profileBadgeCount === 1 ? "s" : ""} attention` : "Posted gigs & booking requests"}
                href="/hiring"
                badge={profileBadgeCount || undefined}
              />
            )}
            <Row icon={Wallet} title="Payments" sub={paymentsSub} href="/profile/payouts" />
            <Row icon={Receipt} title="Tax Center" sub="Track expenses & export for taxes" href="/profile/taxes" />
          </Group>

          <Group title="Saved & alerts">
            <Row icon={Bell} title="Alerts" sub="Booking updates & gig matches" href="/notifications" badge={alertCount || undefined} badgeTone="primary" />
            <Row icon={Bookmark} title="Saved gigs" sub="Gigs you've bookmarked to book later" href="/profile/saved-gigs" />
            <Row icon={Heart} title="Saved people" sub="Workers & clients you've favorited" href="/profile/saved" />
          </Group>
        </div>
          </>
        ) : (
          <>
        {/* Primary action — tied to the identity header above. Web-only: mobile
            reaches settings from the pinned gear alone, which this page also has,
            but a full-width CTA is the desktop affordance people look for. */}
        <Link href="/profile/settings" className={buttonClasses("primary", "lg", "w-full sm:w-auto sm:min-w-[18rem]")}>
          <Settings className="size-[18px] shrink-0" />
          <span className="truncate">Edit Profile &amp; Settings</span>
        </Link>

        {/* Trust opens the Profile pane on mobile, ahead of reviews and settings —
            it is what a stranger judges you on. */}
        <Group title="Profile & trust">
          <Row icon={Eye} title="View my public profile" sub="See exactly how others see you" href={user ? `/u/${user.id}` : "/profile"} />
          <Row
            icon={idv.status === "rejected" && !idv.verified ? AlertCircle : ShieldCheck}
            tone={idv.verified ? "success" : idv.status === "rejected" ? "urgent" : "primary"}
            title={
              idv.verified
                ? "Identity verified"
                : idv.status === "pending"
                  ? "Verification in progress"
                  : idv.status === "rejected"
                    ? "Verification failed"
                    : "Verify your identity"
            }
            sub={
              idv.verified
                ? "Your profile shows a Verified badge"
                : idv.status === "pending"
                  ? "Tap to finish or resume your ID check"
                  : idv.status === "rejected"
                    ? "We couldn't verify your ID — tap to try again"
                    : "Get a Verified badge to build trust"
            }
            onClick={idv.verified ? undefined : verifyIdentity}
            disabled={idv.verified}
          />
          <Row
            icon={GraduationCap}
            tone={u.studentVerified ? "success" : "primary"}
            title={u.studentVerified ? (u.studentStatus === "alumni" ? "Verified Alumni" : "Verified Student") : "Verify Student Status"}
            sub={u.studentVerified ? "Your profile shows a Verified Student badge" : "Confirm your .edu email for a badge"}
            href={u.studentVerified ? undefined : "/verify-student"}
            disabled={u.studentVerified}
          />
        </Group>

        {/* Reviews received */}
        <section>
          <h2 className="mb-2 text-[13px] font-semibold text-ink-muted">Reviews I&apos;ve received</h2>
          {reviews.length > 0 && (
            <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">
              {/* No star glyph at all — mobile's breakdown is "As a worker: 4.8 (3)".
                  `avg` already returns an em dash for a role with no reviews. */}
              <span className="text-ink-soft">As a worker: <span className="font-bold text-ink">{avg(workerReviews)}</span> ({workerReviews.length})</span>
              <span className="text-ink-soft">As a client: <span className="font-bold text-ink">{avg(clientReviews)}</span> ({clientReviews.length})</span>
            </div>
          )}
          {reviews.length === 0 ? (
            <div className="flex flex-col items-center gap-1.5 rounded-2xl bg-white p-6 text-center shadow-[var(--shadow-card)]">
              <Star className="size-7 text-gold" />
              <p className="font-bold text-ink">No reviews yet</p>
              <p className="text-sm text-ink-soft">Complete gigs as a worker or client to start earning reviews.</p>
            </div>
          ) : (
            /* Only the three most recent. This page renders on every visit, and
               rendering every review inline grows without bound — the rest live
               behind "See all". */
            <div className="grid gap-2.5 @4xl:grid-cols-2">
              {reviews.slice(0, 3).map((r) => (
                <div key={r.id} className="rounded-2xl bg-white p-4 shadow-[var(--shadow-card)]">
                  <div className="flex items-center gap-2.5">
                    <Avatar url={r.reviewer?.avatar_url} initial={r.reviewer?.avatar_initial || r.reviewer?.name?.[0]} name={r.reviewer?.name} size={32} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-bold text-ink">{r.reviewer?.name || "User"}</p>
                      <RatingStars value={r.rating} size={12} />
                    </div>
                    {r.date && <span className="shrink-0 text-xs text-ink-muted">{r.date}</span>}
                  </div>
                  {r.text && <p className="mt-2 text-sm text-ink-soft">{r.text}</p>}
                </div>
              ))}
              {reviews.length > 3 && (
                <Link
                  href="/profile/reviews"
                  className="flex items-center justify-center gap-1 rounded-2xl bg-white p-3.5 text-sm font-bold text-primary shadow-[var(--shadow-card)] transition hover:bg-canvas @4xl:col-span-2"
                >
                  See all {reviews.length} reviews <ChevronRight className="size-4 shrink-0" />
                </Link>
              )}
            </div>
          )}
        </section>

        {/* Posted gigs — web-only, kept from the previous layout. Mobile has no
            equivalent list on this tab (it lives on Hiring); here it sits with
            the other "how you look to other people" content. */}
        {postedJobs.length > 0 && (
          <section>
            <h2 className="mb-2 text-[13px] font-semibold text-ink-muted">Your gigs</h2>
            <div className="grid gap-2 @4xl:grid-cols-2">
              {postedJobs.map((j) => (
                <Link key={j.id} href={`/jobs/${j.id}`} className="flex items-center justify-between gap-3 rounded-2xl bg-white p-3.5 shadow-[var(--shadow-card)] transition hover:bg-canvas">
                  <span className="min-w-0 truncate font-bold text-ink">{j.title}</span>
                  <span className="shrink-0 text-sm font-bold text-success">{money(j.pay)}</span>
                </Link>
              ))}
            </div>
          </section>
        )}

        <div className="grid gap-5 @4xl:grid-cols-2">
          <Group title="Preferences">
            <Row icon={BellRing} title="Notification settings" sub="Push & email preferences" href="/profile/notifications" />
            <Row icon={CalendarClock} title="Availability & schedule" sub="Set your work status, hours & classes" href="/profile/availability" />
          </Group>

          <Group title="Grow">
            <Row icon={Search} title="Find people" sub="Search anyone by name or username" href="/people" />
            <Row
              icon={Gift}
              title="Invite friends"
              sub={refCount > 0 ? `${refCount} friend${refCount !== 1 ? "s" : ""} joined · share your code` : "Share your referral code"}
              onClick={invite}
            />
          </Group>
        </div>

        <Group title="Legal & support">
          <Row icon={FileText} title="Terms of Service" href="/legal/terms" />
          <Row icon={FileText} title="Privacy Policy" href="/legal/privacy" />
          <Row icon={FileText} title="Independent Contractor Agreement" href="/legal/contractor" />
          <Row icon={LifeBuoy} title="Contact support" externalHref={`mailto:${SUPPORT_EMAIL}?subject=GoHustlr%20Support`} />
        </Group>

        {/* Sign out lives in Settings only — it sat at the bottom of the page
            people open most, one mis-tap from ending the session. */}
          </>
        )}
      </PageContainer>
    </div>
  );
}

// A titled group of rows rendered as one rounded card (matches the mobile app).
// One elevation mechanism: the shadow. The ring that used to sit on top of it is
// the doubled-border tell the de-AI pass removed everywhere else.
function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    // min-w-0 is load-bearing: every Group is a grid item, and a grid item's
    // default `min-width: auto` refuses to shrink below its content's min-content
    // width. Without it the row labels held the track open and the section spilled
    // ~32px past the page gutter at 320px, scrolling the whole document sideways.
    <section className="min-w-0">
      <h2 className="mb-2 ml-1 text-[13px] font-semibold text-ink-muted">{title}</h2>
      <div className="divide-y divide-divider overflow-hidden rounded-2xl bg-white shadow-[var(--shadow-card)]">
        {children}
      </div>
    </section>
  );
}

// The icon tile is a NEUTRAL canvas puck with a tinted glyph, as on mobile — a
// column of tinted pucks turns a settings list into a colour chart.
const ROW_TONES = {
  primary: "text-primary",
  success: "text-success",
  urgent: "text-urgent",
} as const;

// A single row inside a Group: tinted icon tile + title/subtitle + optional
// badge + chevron. Renders as a Link (href), plain <a> (externalHref), a button
// (onClick), or a static div (disabled).
function Row({
  icon: Icon, title, sub, href, externalHref, onClick, badge, badgeTone = "urgent", tone = "primary", disabled,
}: {
  icon: LucideIcon;
  title: string;
  sub?: string;
  href?: string;
  externalHref?: string;
  onClick?: () => void;
  badge?: number;
  badgeTone?: "urgent" | "primary";
  tone?: keyof typeof ROW_TONES;
  disabled?: boolean;
}) {
  const content = (
    <>
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-canvas">
        <Icon className={classNames("size-[18px]", ROW_TONES[tone])} />
      </span>
      {/* min-w-0 on the text column + shrink-0 on badge/chevron: this is what
          keeps a long row title from evicting the badge past the card edge. */}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] font-semibold text-ink">{title}</span>
        {sub && <span className="mt-0.5 block truncate text-xs leading-4 text-ink-muted">{sub}</span>}
      </span>
      {badge ? (
        <span className={classNames(
          "inline-flex min-w-5 shrink-0 items-center justify-center rounded-full px-1.5 text-[11px] font-bold text-white",
          badgeTone === "primary" ? "bg-primary" : "bg-urgent",
        )}>
          {badge}
        </span>
      ) : null}
      {!disabled && <ChevronRight className="size-4 shrink-0 text-ink-muted" />}
    </>
  );
  const cls = "flex w-full items-center gap-3 px-4 py-3.5 text-left transition hover:bg-canvas";
  if (disabled) return <div className={`${cls} cursor-default`}>{content}</div>;
  if (externalHref) return <a href={externalHref} className={cls}>{content}</a>;
  if (href) return <Link href={href} className={cls}>{content}</Link>;
  return <button type="button" onClick={onClick} className={cls}>{content}</button>;
}
