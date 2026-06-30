"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { CheckCircle2, GraduationCap, MapPin, ArrowLeft, Heart, MoreVertical, Flag, Ban, ShieldCheck } from "lucide-react";
import { collegeLine, computeCertifications, DAYS, windowsForDay, fmtTime, availabilitySummary } from "@gohustlr/shared";
import { supabase } from "@/lib/supabaseClient";
import { useAuth } from "@/lib/auth";
import { useUser } from "@/lib/user";
import { useJobs } from "@/lib/jobs";
import { notify } from "@/lib/push";
import { isFavorite, addFavorite, removeFavorite } from "@/lib/favorites";
import { fetchCertifications, type Certification } from "@/lib/certifications";
import { submitReport, blockUserDb, REPORT_REASONS } from "@/lib/moderation";
import PageHeader, { PageContainer, EmptyState } from "@/components/PageHeader";
import Avatar from "@/components/ui/Avatar";
import RatingStars from "@/components/ui/RatingStars";
import Modal from "@/components/ui/Modal";
import Button from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Field";
import { FullPageSpinner } from "@/components/ui/Spinner";
import { classNames, money, payLabel } from "@/lib/format";

interface PubProfile {
  id: string;
  name: string;
  avatar_initial: string;
  avatar_url: string | null;
  city: string | null;
  bio: string | null;
  skills: string[] | null;
  skill_rates: Record<string, number> | null;
  rating: number;
  review_count: number;
  member_since: string | null;
  verified: boolean;
  school: string | null;
  major: string | null;
  grad_year: number | null;
  student_verified: boolean;
  student_status: string;
}

type AvailabilityWindow = { day: number; start: string; end: string };

interface PubReview {
  id: string;
  rating: number;
  text: string | null;
  date: string | null;
  role: string;
  job: { title: string | null; category?: string | null; tags?: string[] | null } | null;
  reviewer: { name: string | null; avatar_initial: string | null; avatar_url: string | null } | null;
}

interface PubListing {
  id: string;
  title: string;
  category: string;
  pay: number;
  pay_type: "flat" | "hourly";
  location: string;
}

// Only render certificate images/links that are genuine Supabase storage public
// URLs over https. A user can insert an arbitrary image_url via a direct API call
// (the insert RLS only checks ownership), so block javascript:/data: schemes and
// off-platform phishing links at render. The DB CHECK constraint is the durable guard.
function safeCertUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return null;
    if (!u.pathname.includes("/storage/v1/object/public/")) return null;
    return url;
  } catch {
    return null;
  }
}

export default function PublicProfilePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const { showToast, name: myName } = useUser();
  const { postedJobs } = useJobs();
  const [profile, setProfile] = useState<PubProfile | null>(null);
  const [availability, setAvailabilityState] = useState<AvailabilityWindow[]>([]);
  const [reviews, setReviews] = useState<PubReview[]>([]);
  const [listings, setListings] = useState<PubListing[]>([]);
  const [certs, setCerts] = useState<Certification[]>([]);
  const [loading, setLoading] = useState(true);
  const [fav, setFav] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [reportReason, setReportReason] = useState(REPORT_REASONS[0]);
  const [reportDetails, setReportDetails] = useState("");
  const isSelf = user?.id === id;

  const myOpenGigs = (postedJobs || []).filter((j) => j.status === "open");

  const sendInvite = (job: { id: string; title: string }) => {
    notify(id, "You got a gig invitation", `${myName || "Someone"} invited you to apply to "${job.title}"`, { tab: "HomeTab" });
    setInviteOpen(false);
    showToast({ icon: "✅", title: "Invitation sent", message: `${profile?.name || "They"} were invited to "${job.title}".` });
  };

  const doBlock = async () => {
    setMenuOpen(false);
    if (!user) return;
    try {
      await blockUserDb(user.id, id);
      showToast({ icon: "🚫", title: "User blocked", message: "You won't see their gigs anymore." });
      router.push("/browse");
    } catch {
      showToast({ icon: "⚠️", title: "Couldn't block", message: "Please try again." });
    }
  };

  const doReport = async () => {
    if (!user) return;
    try {
      await submitReport({ reporterId: user.id, reportedUserId: id, reason: reportReason, details: reportDetails || null });
      showToast({ icon: "🚩", title: "Report submitted", message: "Thanks — our team will review it." });
    } catch {
      showToast({ icon: "⚠️", title: "Couldn't submit", message: "Please try again." });
    }
    setReportOpen(false);
    setReportDetails("");
  };

  useEffect(() => {
    if (user && id && !isSelf) isFavorite(user.id, id).then(setFav).catch(() => {});
  }, [user, id, isSelf]);

  const toggleFav = async () => {
    if (!user || isSelf) return;
    const next = !fav;
    setFav(next);
    try {
      if (next) await addFavorite(user.id, id);
      else await removeFavorite(user.id, id);
    } catch {
      setFav(!next);
    }
  };

  useEffect(() => {
    let active = true;
    (async () => {
      const [{ data: prof }, { data: revs }, { data: jobs }, certRows] = await Promise.all([
        supabase
          .from("profiles")
          .select(
            "id, name, avatar_initial, avatar_url, city, bio, skills, skill_rates, rating, review_count, member_since, verified, school, major, grad_year, student_verified, student_status",
          )
          .eq("id", id)
          .single(),
        supabase
          .from("reviews")
          .select("id, rating, text, date, role, job:jobs(title, category, tags), reviewer:profiles!reviewer_id(name, avatar_initial, avatar_url)")
          .eq("reviewed_user_id", id)
          .order("created_at", { ascending: false }),
        supabase
          .from("jobs")
          .select("id, title, category, pay, pay_type, location")
          .eq("poster_id", id)
          .eq("status", "open"),
        fetchCertifications(id).catch(() => [] as Certification[]),
      ]);
      if (!active) return;
      setProfile((prof as PubProfile) || null);
      setReviews((revs as unknown as PubReview[]) || []);
      setListings((jobs as PubListing[]) || []);
      setCerts(certRows);
      setLoading(false);

      // Availability is private by default. It's served through the SECURITY DEFINER
      // RPC profile_availability(), which returns windows ONLY when the owner opted in
      // (show_availability) or the viewer is the owner — the opt-out is enforced in the
      // DB, not just here. The raw column is revoked from `authenticated`, so only this
      // gated RPC (execute-granted to signed-in users) can read it cross-user.
      if (user) {
        try {
          const { data: avail } = await supabase.rpc("profile_availability", { uid: id });
          if (!active) return;
          setAvailabilityState(Array.isArray(avail) ? (avail as AvailabilityWindow[]) : []);
        } catch {
          /* degrade gracefully — just no availability shown */
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [id, user]);

  if (loading) return <FullPageSpinner />;
  if (!profile) return <EmptyState title="Profile not found" />;

  const college = collegeLine(profile);
  const overall = reviews.length ? reviews.reduce((s, r) => s + Number(r.rating || 0), 0) / reviews.length : null;
  const earnerReviews = reviews.filter((r) => r.role === "earner");
  const recentWork = earnerReviews.slice(0, 10);
  const { certified, progress } = computeCertifications(earnerReviews);

  const availDays = DAYS.map((label, day) => ({ label, day, windows: windowsForDay(availability, day) })).filter(
    (d) => d.windows.length > 0,
  );
  // Show availability only to a signed-in viewer, and only if the owner opted in
  // (or it's the owner viewing their own profile), and there are windows to show.
  const canShowAvailability = !!user && availDays.length > 0;

  return (
    <div>
      <PageHeader title="">
        <div className="mb-3 flex items-center justify-between">
          <Link href={isSelf ? "/profile" : "/browse"} className="flex items-center gap-1 text-sm font-bold text-white/80">
            <ArrowLeft className="size-4" /> Back
          </Link>
          {!isSelf && user && (
            <div className="relative flex items-center gap-2">
              <button onClick={toggleFav} className="rounded-full bg-white/15 p-2 text-white" aria-label={fav ? "Unsave" : "Save"}>
                <Heart className={fav ? "size-5 fill-white" : "size-5"} />
              </button>
              <button onClick={() => setMenuOpen((o) => !o)} className="rounded-full bg-white/15 p-2 text-white" aria-label="More options">
                <MoreVertical className="size-5" />
              </button>
              {menuOpen && (
                <div className="absolute right-0 top-11 z-20 w-44 overflow-hidden rounded-xl bg-white shadow-[var(--shadow-pop)] ring-1 ring-line">
                  <button onClick={() => { setMenuOpen(false); setReportOpen(true); }} className="flex w-full items-center gap-2 px-3.5 py-2.5 text-sm font-bold text-ink hover:bg-canvas">
                    <Flag className="size-4" /> Report
                  </button>
                  <button onClick={doBlock} className="flex w-full items-center gap-2 px-3.5 py-2.5 text-sm font-bold text-urgent hover:bg-canvas">
                    <Ban className="size-4" /> Block
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center gap-4">
          <Avatar url={profile.avatar_url} initial={profile.avatar_initial || profile.name?.[0]} name={profile.name} size={64} ring />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <p className="truncate text-xl font-black">{profile.name || "GoHustlr user"}</p>
              {profile.verified && <CheckCircle2 className="size-4 text-white/90" />}
              {profile.student_verified && <GraduationCap className="size-4 text-white/90" />}
            </div>
            {overall != null ? (
              <div className="mt-0.5 flex items-center gap-2 text-white/85">
                <RatingStars value={overall} size={14} />
                <span className="text-sm">
                  {overall.toFixed(1)} · {reviews.length} review{reviews.length !== 1 ? "s" : ""}
                </span>
              </div>
            ) : (
              <p className="mt-0.5 text-sm text-white/75">No reviews yet</p>
            )}
            {college && <p className="mt-0.5 text-sm font-semibold text-white/90">{college}</p>}
            {profile.city && (
              <p className="mt-0.5 flex items-center gap-1 text-sm text-white/75">
                <MapPin className="size-3.5" /> {profile.city}
              </p>
            )}
          </div>
        </div>
      </PageHeader>

      <PageContainer className="space-y-4">
        {isSelf && (
          <div className="flex items-center gap-2 rounded-2xl bg-primary-light px-4 py-3 text-sm font-semibold text-primary">
            👀 This is your public profile — exactly how others see you.
          </div>
        )}

        {canShowAvailability && (
          <>
            <h2 className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-muted">Availability</h2>
            <div className="rounded-2xl bg-white p-4 shadow-[var(--shadow-card)] ring-1 ring-line/70">
              <p className="mb-3 text-sm font-bold text-ink">{availabilitySummary(availability)}</p>
              <div className="space-y-1.5">
                {availDays.map(({ label, day, windows }) => (
                  <div key={day} className="flex items-center justify-between border-t border-line/70 pt-1.5 text-sm first:border-t-0 first:pt-0">
                    <span className="font-extrabold text-primary">{label}</span>
                    <span className="font-semibold text-ink-soft">
                      {windows.map((w) => `${fmtTime(w.start)}–${fmtTime(w.end)}`).join(", ")}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {!isSelf && user && myOpenGigs.length > 0 && (
          <Button fullWidth onClick={() => setInviteOpen(true)}>
            Invite to a gig
          </Button>
        )}

        {profile.bio && (
          <>
            <h2 className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-muted">About</h2>
            <p className="leading-relaxed text-ink">{profile.bio}</p>
          </>
        )}

        {profile.skills && profile.skills.length > 0 && (
          <>
            <h2 className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-muted">Skills</h2>
            <div className="flex flex-wrap gap-2">
              {profile.skills.map((s) => (
                <span key={s} className="rounded-full border border-line bg-white px-3 py-1.5 text-sm font-bold text-ink-soft">
                  {s}
                  {profile.skill_rates?.[s] ? ` · ${money(profile.skill_rates[s])}/hr` : ""}
                </span>
              ))}
            </div>
          </>
        )}

        {certified.length > 0 && (
          <>
            <h2 className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-muted">Hustlr Certified</h2>
            <div className="flex flex-wrap gap-2">
              {certified.map((c) => (
                <div
                  key={c.label}
                  className="flex items-center gap-2 rounded-2xl bg-success-light px-3.5 py-2.5 text-success ring-1 ring-success/20"
                >
                  <ShieldCheck className="size-5 shrink-0" />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-extrabold">Certified · {c.label}</p>
                    <p className="text-xs font-semibold text-success/80">{c.count} jobs</p>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {isSelf && certified.length === 0 && progress.length > 0 && (
          <>
            <h2 className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-muted">Progress to certification</h2>
            <div className="space-y-1.5 rounded-2xl bg-white p-4 shadow-[var(--shadow-card)] ring-1 ring-line/70">
              {progress.map((p) => (
                <div key={p.label} className="flex items-center justify-between text-sm">
                  <span className="font-bold text-ink">{p.label}</span>
                  <span className="font-semibold text-ink-muted">
                    {p.count}/{p.needed}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}

        {certs.length > 0 && (
          <>
            <h2 className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-muted">Certifications</h2>
            <div className="space-y-2">
              {certs.map((c) => {
                const certImg = safeCertUrl(c.image_url);
                return (
                <div key={c.id} className="flex items-center gap-3 rounded-2xl bg-white p-4 shadow-[var(--shadow-card)] ring-1 ring-line/70">
                  {certImg && (
                    <a href={certImg} target="_blank" rel="noopener noreferrer" className="shrink-0">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={certImg} alt={c.title} className="size-12 rounded-xl object-cover" />
                    </a>
                  )}
                  <div className="min-w-0">
                    <p className="truncate font-bold text-ink">{c.title}</p>
                    {(c.issuer || c.year) && (
                      <p className="truncate text-xs text-ink-muted">{[c.issuer, c.year].filter(Boolean).join(" · ")}</p>
                    )}
                  </div>
                </div>
                );
              })}
            </div>
          </>
        )}

        {listings.length > 0 && (
          <>
            <h2 className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-muted">Open gigs</h2>
            <div className="space-y-2">
              {listings.map((j) => (
                <Link key={j.id} href={`/jobs/${j.id}`} className="flex items-center justify-between rounded-2xl bg-white p-4 shadow-[var(--shadow-card)] ring-1 ring-line/70">
                  <div className="min-w-0">
                    <p className="truncate font-bold text-ink">{j.title}</p>
                    <p className="text-xs text-ink-muted">{j.category} · {j.location}</p>
                  </div>
                  <span className="shrink-0 font-bold text-success">{payLabel({ pay: j.pay, payType: j.pay_type })}</span>
                </Link>
              ))}
            </div>
          </>
        )}

        {recentWork.length > 0 && (
          <>
            <h2 className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-muted">Recent work</h2>
            <div className="space-y-2.5">
              {recentWork.map((r) => (
                <div key={r.id} className="rounded-2xl bg-white p-4 shadow-[var(--shadow-card)] ring-1 ring-line/70">
                  <div className="flex items-center justify-between gap-2">
                    <p className="min-w-0 truncate font-bold text-ink">{r.job?.title || "Completed gig"}</p>
                    <RatingStars value={r.rating} size={13} />
                  </div>
                  {r.text && <p className="mt-1 text-sm text-ink-soft">{r.text}</p>}
                  {r.date && <p className="mt-1 text-xs text-ink-muted">{r.date}</p>}
                </div>
              ))}
            </div>
          </>
        )}

        <h2 className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-muted">Reviews</h2>
        {reviews.length === 0 ? (
          <p className="text-sm text-ink-muted">No reviews yet.</p>
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
      </PageContainer>

      <Modal
        open={reportOpen}
        onClose={() => setReportOpen(false)}
        title={`Report ${profile.name || "this user"}`}
        size="sm"
        footer={<Button fullWidth onClick={doReport}>Submit report</Button>}
      >
        <div className="space-y-2">
          {REPORT_REASONS.map((r) => (
            <button
              key={r}
              onClick={() => setReportReason(r)}
              className={classNames(
                "flex w-full items-center justify-between rounded-xl border px-3.5 py-2.5 text-sm font-semibold transition",
                reportReason === r ? "border-primary bg-primary-light/50 text-primary" : "border-line text-ink-soft hover:border-ink-muted",
              )}
            >
              {r}
              {reportReason === r && <span>✓</span>}
            </button>
          ))}
          <Textarea value={reportDetails} onChange={(e) => setReportDetails(e.target.value)} placeholder="Add details (optional)" className="min-h-[72px]" />
        </div>
      </Modal>

      <Modal open={inviteOpen} onClose={() => setInviteOpen(false)} title={`Invite ${profile.name || "them"} to…`} size="sm">
        <div className="space-y-2">
          {myOpenGigs.map((j) => (
            <button
              key={j.id}
              onClick={() => sendInvite(j)}
              className="flex w-full items-center justify-between rounded-xl border border-line px-3.5 py-2.5 text-left text-sm font-semibold text-ink-soft transition hover:border-primary hover:bg-primary-light/40"
            >
              <span className="min-w-0 truncate">{j.title}</span>
              <span className="ml-2 shrink-0 text-ink-muted">{payLabel({ pay: j.pay, payType: j.payType })}</span>
            </button>
          ))}
        </div>
      </Modal>
    </div>
  );
}
