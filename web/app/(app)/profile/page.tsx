"use client";

import Link from "next/link";
import { Settings, LogOut, Wallet, Receipt, Heart, ShieldCheck, GraduationCap } from "lucide-react";
import { BADGE_DEFS, collegeLine } from "@gohustlr/shared";
import { useUser } from "@/lib/user";
import { useJobs } from "@/lib/jobs";
import { useAuth } from "@/lib/auth";
import PageHeader, { PageContainer } from "@/components/PageHeader";
import Avatar from "@/components/ui/Avatar";
import XPBar from "@/components/XPBar";
import RatingStars from "@/components/ui/RatingStars";
import { buttonClasses } from "@/components/ui/Button";
import { money } from "@/lib/format";

export default function ProfilePage() {
  const u = useUser();
  const { postedJobs } = useJobs();
  const { signOut } = useAuth();

  const college = collegeLine({ school: u.school, major: u.major, gradYear: u.gradYear });

  const links = [
    {
      href: "/verify-student",
      label: u.studentVerified ? "Verified Student ✓" : "Verify student status",
      icon: GraduationCap,
    },
    { href: "/profile/payouts", label: "Payouts & payments", icon: Wallet },
    { href: "/profile/taxes", label: "Tax Center", icon: Receipt },
    { href: "/profile/saved", label: "Saved people", icon: Heart },
    { href: "/profile/settings", label: "Settings", icon: Settings },
  ];

  return (
    <div>
      <PageHeader title="Profile" variant="gold" right={
        <Link href="/profile/settings" className="rounded-full bg-white/15 p-2 text-white">
          <Settings className="size-5" />
        </Link>
      }>
        <div className="mt-4 flex items-center gap-4">
          <Avatar url={u.avatarUrl} initial={u.avatarInitial} name={u.name} size={64} ring />
          <div>
            <div className="flex items-center gap-1.5">
              <p className="text-xl font-black">{u.name}</p>
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

      <PageContainer>
        {/* Stats */}
        <div className="grid grid-cols-3 gap-3">
          {[
            { label: "Earned", value: money(u.earningsTotal) },
            { label: "Streak", value: `${u.streakDays}d` },
            { label: "XP", value: String(u.xp) },
          ].map((s) => (
            <div key={s.label} className="rounded-2xl bg-white p-4 text-center shadow-[var(--shadow-card)] ring-1 ring-line/70">
              <p className="text-xl font-black text-ink">{s.value}</p>
              <p className="text-xs font-bold text-ink-muted">{s.label}</p>
            </div>
          ))}
        </div>

        {/* Badges */}
        <h2 className="mb-2 mt-6 text-sm font-extrabold uppercase tracking-wide text-ink-muted">Badges</h2>
        <div className="flex flex-wrap gap-3">
          {Object.entries(BADGE_DEFS).map(([key, def]) => {
            const unlocked = u.badges[key]?.unlocked;
            return (
              <div
                key={key}
                className={`flex w-20 flex-col items-center gap-1 rounded-2xl border p-3 text-center ${unlocked ? "border-gold bg-gold-light" : "border-line bg-white opacity-50"}`}
              >
                <span className="text-2xl">{def.icon}</span>
                <span className="text-[10px] font-bold leading-tight text-ink">{def.label}</span>
              </div>
            );
          })}
        </div>

        {/* Posted gigs */}
        {postedJobs.length > 0 && (
          <>
            <h2 className="mb-2 mt-6 text-sm font-extrabold uppercase tracking-wide text-ink-muted">Your gigs</h2>
            <div className="space-y-2">
              {postedJobs.map((j) => (
                <Link key={j.id} href={`/jobs/${j.id}`} className="flex items-center justify-between rounded-2xl bg-white p-3.5 shadow-[var(--shadow-card)] ring-1 ring-line/70">
                  <span className="truncate font-bold text-ink">{j.title}</span>
                  <span className="text-sm font-bold text-success">{money(j.pay)}</span>
                </Link>
              ))}
            </div>
          </>
        )}

        {/* Links */}
        <div className="mt-6 divide-y divide-line overflow-hidden rounded-2xl bg-white shadow-[var(--shadow-card)] ring-1 ring-line/70">
          {links.map((l) => {
            const Icon = l.icon;
            return (
              <Link key={l.href} href={l.href} className="flex items-center gap-3 px-4 py-3.5 hover:bg-primary-light/40">
                <Icon className="size-5 text-primary" />
                <span className="font-bold text-ink">{l.label}</span>
              </Link>
            );
          })}
        </div>

        <button onClick={() => signOut()} className={buttonClasses("outline", "md", "mt-6 w-full text-urgent")}>
          <LogOut className="size-4" /> Sign out
        </button>

        <div className="mt-4 flex items-center justify-center gap-1.5 text-xs text-ink-muted">
          <ShieldCheck className="size-3.5" /> GoHustlr · built for students
        </div>
      </PageContainer>
    </div>
  );
}
