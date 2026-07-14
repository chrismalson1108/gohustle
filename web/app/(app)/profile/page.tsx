"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Settings, LogOut, Wallet, Receipt, Heart, ShieldCheck, GraduationCap, Camera, Gift, FileText, ChevronRight, Star, Bookmark, CalendarClock, Eye, Briefcase, Bell, BellRing, LifeBuoy, Search,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { BADGE_DEFS, collegeLine } from "@gohustlr/shared";
import { useUser } from "@/lib/user";
import { useJobs } from "@/lib/jobs";
import { useAuth } from "@/lib/auth";
import { supabase } from "@/lib/supabaseClient";
import { uploadToBucket } from "@/lib/uploadImage";
import { fetchVerificationStatus, requestVerification } from "@/lib/verification";
import { getReferralCode, fetchReferralCount } from "@/lib/referrals";
import { SUPPORT_EMAIL } from "@/lib/legal";
import PageHeader, { PageContainer } from "@/components/PageHeader";
import Avatar from "@/components/ui/Avatar";
import XPBar from "@/components/XPBar";
import RatingStars from "@/components/ui/RatingStars";
import Button, { buttonClasses } from "@/components/ui/Button";
import { FullPageSpinner } from "@/components/ui/Spinner";
import { money } from "@/lib/format";

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
  const { postedJobs, profileBadgeCount } = useJobs();
  const { signOut, user } = useAuth();
  const [alertCount, setAlertCount] = useState(0);

  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [idv, setIdv] = useState({ verified: false, status: "none" });
  const [refCode, setRefCode] = useState("");
  const [refCount, setRefCount] = useState(0);
  const [reviews, setReviews] = useState<Review[]>([]);

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
  }, [user, loadReviews]);

  const onAvatar = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !user) return;
    setUploadingAvatar(true);
    try {
      const url = await uploadToBucket(file, "avatars", user.id);
      await supabase.from("profiles").update({ avatar_url: url }).eq("id", user.id);
      await refreshProfile();
      showToast({ icon: "✅", title: "Photo updated!", message: "Your new profile picture is live." });
    } catch (err) {
      showToast({ icon: "⚠️", title: "Upload failed", message: (err as Error).message || "Please try again." });
    }
    setUploadingAvatar(false);
  };

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
        <PageHeader title="Profile" variant="gold" />
        <PageContainer>
          {u.profileStatus === "loading" ? (
            <FullPageSpinner label="Loading your profile…" />
          ) : (
            <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 text-center">
              <p className="text-lg font-bold text-ink">Couldn&apos;t load your profile</p>
              <p className="max-w-xs text-sm text-ink-soft">
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
        title="Profile"
        variant="gold"
        right={
          <Link href="/profile/settings" className="rounded-full bg-white/15 p-2 text-white">
            <Settings className="size-5" />
          </Link>
        }
      >
        <div className="mt-4 flex items-center gap-4">
          <label className="relative cursor-pointer">
            <Avatar url={u.avatarUrl} initial={u.avatarInitial} name={u.name} size={64} ring />
            <span className="absolute -bottom-1 -right-1 flex size-6 items-center justify-center rounded-full bg-primary ring-2 ring-white">
              <Camera className="size-3 text-white" />
            </span>
            <input type="file" accept="image/*" className="hidden" onChange={onAvatar} disabled={uploadingAvatar} />
          </label>
          <div>
            <div className="flex items-center gap-1.5">
              <p className="text-xl font-black">{u.name}</p>
              {idv.verified && <ShieldCheck className="size-4 text-white/90" />}
              {u.studentVerified && <GraduationCap className="size-4 text-white/90" />}
            </div>
            <div className="mt-0.5 flex items-center gap-2 text-white/85">
              {u.reviewCount > 0 ? (
                <>
                  <RatingStars value={u.rating} size={14} />
                  <span className="text-sm">
                    {u.rating.toFixed(1)} · {u.reviewCount} review{u.reviewCount !== 1 ? "s" : ""}
                  </span>
                </>
              ) : (
                <span className="text-sm">No reviews yet</span>
              )}
            </div>
            {college && <p className="mt-0.5 text-sm font-semibold text-white/90">{college}</p>}
          </div>
        </div>
        <div className="mt-4">
          <XPBar levelInfo={u.levelInfo} xp={u.xp} dark />
        </div>
      </PageHeader>

      <PageContainer className="space-y-5">
        {/* Stats — XP lives in the header level bar, so the third stat shows the
            trust-relevant rating instead of duplicating XP. */}
        <div className="grid grid-cols-3 gap-3">
          {[
            { label: "Earned", value: money(u.earningsTotal) },
            { label: "Streak", value: `${u.streakDays}w` },
            { label: "Rating", value: u.reviewCount > 0 ? `${u.rating.toFixed(1)}★` : "—" },
          ].map((s) => (
            <div key={s.label} className="rounded-2xl bg-white p-4 text-center shadow-[var(--shadow-card)] ring-1 ring-line/70">
              <p className="text-xl font-black text-ink">{s.value}</p>
              <p className="text-xs font-bold text-ink-muted">{s.label}</p>
            </div>
          ))}
        </div>

        {/* Primary action — tied to the identity header above. */}
        <Link
          href="/profile/settings"
          className="flex items-center justify-center gap-2 rounded-2xl bg-primary px-4 py-3.5 font-black text-white shadow-[var(--shadow-soft)] transition hover:bg-primary-dark"
        >
          <Settings className="size-[18px]" /> Edit Profile &amp; Settings
        </Link>

        <Group title="Gigs & Earnings">
          {postedJobs.length > 0 && (
            <Row
              icon={Briefcase}
              title="Manage my gigs"
              sub={profileBadgeCount > 0 ? `${profileBadgeCount} need${profileBadgeCount === 1 ? "s" : ""} attention` : "Posted gigs & booking requests"}
              href="/hiring"
              badge={profileBadgeCount || undefined}
            />
          )}
          <Row icon={Wallet} title="Payouts & payments" sub="Manage payout & payment methods" href="/profile/payouts" />
          <Row icon={Receipt} title="Tax Center" sub="Track expenses & export for taxes" href="/profile/taxes" />
        </Group>

        <Group title="Saved & Alerts">
          <Row icon={Bell} title="Alerts" sub="Booking updates & gig matches" href="/notifications" badge={alertCount || undefined} badgeTone="primary" />
          <Row icon={Bookmark} title="Saved gigs" sub="Gigs you've bookmarked to book later" href="/profile/saved-gigs" />
          <Row icon={Heart} title="Saved people" sub="Workers & clients you've favorited" href="/profile/saved" />
        </Group>

        <Group title="Preferences">
          <Row icon={BellRing} title="Notification settings" sub="Push & email preferences" href="/profile/notifications" />
          <Row icon={CalendarClock} title="Availability & schedule" sub="Set your work status, hours & classes" href="/profile/availability" />
        </Group>

        <Group title="Profile & Trust">
          <Row icon={Eye} title="View my public profile" sub="See exactly how others see you" href={user ? `/u/${user.id}` : "/profile"} />
          <Row
            icon={ShieldCheck}
            tone={idv.verified ? "success" : "primary"}
            title={idv.verified ? "Identity verified" : idv.status === "pending" ? "Verification in progress" : "Verify your identity"}
            sub={idv.verified ? "Your profile shows a Verified badge" : idv.status === "pending" ? "Tap to finish or resume your ID check" : "Get a Verified badge to build trust"}
            onClick={idv.verified ? undefined : verifyIdentity}
            disabled={idv.verified}
          />
          <Row
            icon={GraduationCap}
            tone={u.studentVerified ? "success" : "primary"}
            title={u.studentVerified ? "Verified Student" : "Verify student status"}
            sub={u.studentVerified ? "Your profile shows a Verified Student badge" : "Confirm your .edu email for a badge"}
            href={u.studentVerified ? undefined : "/verify-student"}
            disabled={u.studentVerified}
          />
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

        {/* Badges */}
        <section>
          <h2 className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-muted">Badges</h2>
          <div className="flex flex-wrap gap-3">
            {Object.entries(BADGE_DEFS).map(([key, def]) => {
              const unlocked = u.badges[key]?.unlocked;
              return (
                <div key={key} className={`flex w-20 flex-col items-center gap-1 rounded-2xl p-3 text-center ${unlocked ? "bg-gold-light ring-1 ring-gold" : "bg-white ring-1 ring-line/70"}`}>
                  <span className={`text-2xl ${unlocked ? "" : "opacity-40"}`}>{def.icon}</span>
                  <span className={`text-[10px] font-bold leading-tight ${unlocked ? "text-ink" : "text-ink-muted"}`}>{def.label}</span>
                </div>
              );
            })}
          </div>
        </section>

        {/* Reviews received */}
        <section>
          <h2 className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-muted">Reviews I&apos;ve received</h2>
          {reviews.length > 0 && (
            <div className="mb-3 flex gap-3 text-sm">
              <span className="text-ink-soft">As a worker: <span className="font-bold text-ink">{avg(workerReviews)}★</span> ({workerReviews.length})</span>
              <span className="text-ink-soft">As a client: <span className="font-bold text-ink">{avg(clientReviews)}★</span> ({clientReviews.length})</span>
            </div>
          )}
          {reviews.length === 0 ? (
            <div className="flex flex-col items-center gap-1.5 rounded-2xl bg-white p-6 text-center shadow-[var(--shadow-card)] ring-1 ring-line/70">
              <Star className="size-7 text-gold" />
              <p className="font-bold text-ink">No reviews yet</p>
              <p className="text-sm text-ink-soft">Complete gigs as a worker or client to start earning reviews.</p>
            </div>
          ) : (
            <div className="space-y-2.5">
              {reviews.map((r) => (
                <div key={r.id} className="rounded-2xl bg-white p-4 shadow-[var(--shadow-card)] ring-1 ring-line/70">
                  <div className="flex items-center gap-2.5">
                    <Avatar url={r.reviewer?.avatar_url} initial={r.reviewer?.avatar_initial || r.reviewer?.name?.[0]} name={r.reviewer?.name} size={32} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-bold text-ink">{r.reviewer?.name || "User"}</p>
                      <RatingStars value={r.rating} size={12} />
                    </div>
                    {r.date && <span className="text-xs text-ink-muted">{r.date}</span>}
                  </div>
                  {r.text && <p className="mt-2 text-sm text-ink-soft">{r.text}</p>}
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Posted gigs */}
        {postedJobs.length > 0 && (
          <section>
            <h2 className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-muted">Your gigs</h2>
            <div className="space-y-2">
              {postedJobs.map((j) => (
                <Link key={j.id} href={`/jobs/${j.id}`} className="flex items-center justify-between rounded-2xl bg-white p-3.5 shadow-[var(--shadow-card)] ring-1 ring-line/70">
                  <span className="truncate font-bold text-ink">{j.title}</span>
                  <span className="text-sm font-bold text-success">{money(j.pay)}</span>
                </Link>
              ))}
            </div>
          </section>
        )}

        <Group title="Support & Legal">
          <Row icon={FileText} title="Terms of Service" href="/legal/terms" />
          <Row icon={FileText} title="Privacy Policy" href="/legal/privacy" />
          <Row icon={FileText} title="Independent Contractor Agreement" href="/legal/contractor" />
          <Row icon={LifeBuoy} title="Contact support" externalHref={`mailto:${SUPPORT_EMAIL}?subject=GoHustlr%20Support`} />
        </Group>

        <button onClick={() => signOut()} className={buttonClasses("outline", "md", "w-full text-urgent hover:border-urgent hover:text-urgent")}>
          <LogOut className="size-4" /> Sign out
        </button>
      </PageContainer>
    </div>
  );
}

// A titled group of rows rendered as one rounded card (matches the mobile app).
function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 ml-1 text-xs font-bold uppercase tracking-wide text-ink-muted">{title}</h2>
      <div className="divide-y divide-line overflow-hidden rounded-2xl bg-white shadow-[var(--shadow-card)] ring-1 ring-line/70">
        {children}
      </div>
    </section>
  );
}

const ROW_TONES = {
  primary: { tile: "bg-primary-light", icon: "text-primary" },
  success: { tile: "bg-success-light", icon: "text-success" },
  urgent: { tile: "bg-urgent-light", icon: "text-urgent" },
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
  const t = ROW_TONES[tone];
  const content = (
    <>
      <span className={`flex size-9 shrink-0 items-center justify-center rounded-xl ${t.tile}`}>
        <Icon className={`size-[18px] ${t.icon}`} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-bold text-ink">{title}</span>
        {sub && <span className="block truncate text-xs text-ink-muted">{sub}</span>}
      </span>
      {badge ? (
        <span className={`inline-flex min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-black text-white ${badgeTone === "primary" ? "bg-primary" : "bg-urgent"}`}>
          {badge}
        </span>
      ) : null}
      {!disabled && <ChevronRight className="size-4 text-ink-muted" />}
    </>
  );
  const cls = "flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-primary-light/40";
  if (disabled) return <div className={`${cls} cursor-default`}>{content}</div>;
  if (externalHref) return <a href={externalHref} className={cls}>{content}</a>;
  if (href) return <Link href={href} className={cls}>{content}</Link>;
  return <button type="button" onClick={onClick} className={cls}>{content}</button>;
}
