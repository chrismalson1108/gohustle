"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Settings, LogOut, Wallet, Receipt, Heart, ShieldCheck, GraduationCap, Camera, Gift, FileText, ChevronRight, Star, Bookmark, CalendarClock, Eye,
} from "lucide-react";
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
  const { postedJobs } = useJobs();
  const { signOut, user } = useAuth();

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
      const res = await requestVerification();
      if (res?.url) window.location.href = res.url;
      else setIdv((p) => ({ ...p, status: "pending" }));
    } catch (err) {
      showToast({ icon: "⚠️", title: "Could not start", message: (err as Error).message || "Please try again." });
    }
  };

  const invite = async () => {
    const text = `Join me on GoHustlr — the gig marketplace for students. Sign up with my referral code ${refCode} to get started!`;
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

  // Single, findable account menu — the destinations users actually hunt for
  // (money, settings, schedule, saved) grouped near the top instead of buried
  // below badges/reviews.
  const links = [
    { href: "/profile/payouts", label: "Payouts & payments", icon: Wallet },
    { href: "/profile/taxes", label: "Tax Center", icon: Receipt },
    { href: "/profile/availability", label: "Availability & schedule", icon: CalendarClock },
    { href: "/profile/saved", label: "Saved people", icon: Heart },
    { href: "/profile/saved-gigs", label: "Saved gigs", icon: Bookmark },
    { href: "/verify-student", label: u.studentVerified ? "Verified Student ✓" : "Verify student status", icon: GraduationCap },
    { href: user ? `/u/${user.id}` : "/profile", label: "View my public profile", icon: Eye },
    { href: "/profile/settings", label: "Settings", icon: Settings },
    { href: "/legal/terms", label: "Legal & terms", icon: FileText },
  ];

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
              <RatingStars value={u.rating} size={14} />
              <span className="text-sm">
                {u.rating.toFixed(1)} · {u.reviewCount} review{u.reviewCount !== 1 ? "s" : ""}
              </span>
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

        {/* Verify identity — the primary trust action stays a prominent card. */}
        <button
          onClick={verifyIdentity}
          disabled={idv.verified}
          className="flex w-full items-center gap-3 rounded-2xl bg-white p-4 text-left shadow-[var(--shadow-card)] ring-1 ring-line/70 disabled:opacity-100"
        >
          <ShieldCheck className={`size-6 ${idv.verified ? "text-success" : "text-primary"}`} />
          <div className="flex-1">
            <p className="font-bold text-ink">
              {idv.verified ? "Identity verified" : idv.status === "pending" ? "Verification in progress" : "Verify your identity"}
            </p>
            <p className="text-xs text-ink-muted">
              {idv.verified ? "Your profile shows a Verified badge" : "Get a Verified badge to build trust"}
            </p>
          </div>
          {!idv.verified && <ChevronRight className="size-5 text-ink-muted" />}
        </button>

        {/* Account menu — moved up so money/settings/schedule are findable at a glance. */}
        <div className="divide-y divide-line overflow-hidden rounded-2xl bg-white shadow-[var(--shadow-card)] ring-1 ring-line/70">
          {links.map((l) => {
            const Icon = l.icon;
            return (
              <Link key={l.href} href={l.href} className="flex items-center gap-3 px-4 py-3.5 hover:bg-primary-light/40">
                <Icon className="size-5 text-primary" />
                <span className="flex-1 font-bold text-ink">{l.label}</span>
                <ChevronRight className="size-4 text-ink-muted" />
              </Link>
            );
          })}
        </div>

        {/* Invite friends — growth action. */}
        <button onClick={invite} className="flex w-full items-center gap-3 rounded-2xl bg-white p-4 text-left shadow-[var(--shadow-card)] ring-1 ring-line/70">
          <Gift className="size-6 text-primary" />
          <div className="flex-1">
            <p className="font-bold text-ink">Invite friends</p>
            <p className="text-xs text-ink-muted">
              {refCount > 0 ? `${refCount} friend${refCount !== 1 ? "s" : ""} joined · ` : ""}
              Share your code {refCode && <span className="font-bold text-primary">{refCode}</span>}
            </p>
          </div>
          <ChevronRight className="size-5 text-ink-muted" />
        </button>

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

        <button onClick={() => signOut()} className={buttonClasses("outline", "md", "w-full text-urgent hover:border-urgent hover:text-urgent")}>
          <LogOut className="size-4" /> Sign out
        </button>

        <div className="flex items-center justify-center gap-1.5 text-xs text-ink-muted">
          <ShieldCheck className="size-3.5" /> Need help? <a href={`mailto:${SUPPORT_EMAIL}`} className="font-bold text-primary">{SUPPORT_EMAIL}</a>
        </div>
      </PageContainer>
    </div>
  );
}
