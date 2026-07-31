"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { CheckCircle2, MapPin, Eye, Heart, MoreVertical, Flag, Ban, ShieldCheck, MessageCircle } from "lucide-react";
import { collegeLine, computeCertifications, DAYS, windowsForDay, fmtTime, workStatusMeta } from "@gohustlr/shared";
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
import StudentBadge from "@/components/ui/StudentBadge";
import Modal from "@/components/ui/Modal";
import Button, { buttonClasses } from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Field";
import { FullPageSpinner } from "@/components/ui/Spinner";
import { classNames, money, payLabel } from "@/lib/format";
import { maskLocation } from "@/lib/address";

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
  work_status: string | null;
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

// Label + content as one block. Previously the <h2>s and their cards were loose
// siblings of a `space-y-4` column, so a heading sat the same distance from its
// own content as from the section above it and the page read as one flat list.
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="min-w-0">
      <h2 className="mb-2 text-[13px] font-semibold text-ink-muted">{title}</h2>
      {children}
    </section>
  );
}

export default function PublicProfilePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const { showToast, name: myName } = useUser();
  const { postedJobs, jobs, bookings, posterBookings } = useJobs();
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

  // Messaging is booking-scoped (party-scoped RLS on messages), so this person is
  // messageable iff a booking connects us: me as the earner on their job, or them
  // as the earner on mine. Prefer an in-flight booking; both arrays are newest-first.
  const ACTIVE_MSG_STATUSES = ["pending", "confirmed", "completed"];
  const sharedBookings = [
    ...bookings.filter((b) => jobs.find((j) => j.id === b.jobId)?.posterId === id),
    ...posterBookings.filter((b) => b.earner?.id === id),
  ];
  const sharedBooking = sharedBookings.find((b) => ACTIVE_MSG_STATUSES.includes(b.status)) || sharedBookings[0] || null;

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
            "id, name, avatar_initial, avatar_url, city, bio, skills, skill_rates, rating, review_count, member_since, verified, school, major, grad_year, student_verified, student_status, work_status",
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

  if (loading) return <FullPageSpinner className="min-h-[60dvh]" />;
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
      {/* The person's name is the page's <h1>. It used to be a <p> under an empty
          PageHeader title, which left the whole profile without an accessible
          heading. */}
      <PageHeader
        title={profile.name || "GoHustlr user"}
        width="content"
        back={isSelf ? "/profile" : "/browse"}
        right={
          !isSelf && user ? (
            <div className="relative flex items-center gap-2">
              <button
                onClick={toggleFav}
                className="flex size-11 items-center justify-center rounded-full border border-line bg-white transition hover:border-primary"
                aria-label={fav ? "Unsave" : "Save"}
                aria-pressed={fav}
              >
                <Heart className={fav ? "size-5 fill-urgent text-urgent" : "size-5 text-ink"} />
              </button>
              <button
                onClick={() => setMenuOpen((o) => !o)}
                className="flex size-11 items-center justify-center rounded-full border border-line bg-white text-ink transition hover:border-primary"
                aria-label="More options"
                aria-expanded={menuOpen}
              >
                <MoreVertical className="size-5" />
              </button>
              {menuOpen && (
                // `rounded-2xl` (20px): an elevated floating menu is a PANEL, and
                // 14px is the control step (inputs/buttons/banners). Matches
                // LocationPicker's popover, the app's other floating panel.
                <div className="absolute right-0 top-12 z-20 w-44 overflow-hidden rounded-2xl bg-white shadow-[var(--shadow-pop)]">
                  <button onClick={() => { setMenuOpen(false); setReportOpen(true); }} className="flex w-full items-center gap-2 px-3.5 py-3 text-sm font-semibold text-ink transition hover:bg-canvas">
                    <Flag className="size-4 shrink-0" /> Report
                  </button>
                  <button onClick={doBlock} className="flex w-full items-center gap-2 px-3.5 py-3 text-sm font-semibold text-urgent transition hover:bg-canvas">
                    <Ban className="size-4 shrink-0" /> Block
                  </button>
                </div>
              )}
            </div>
          ) : undefined
        }
      >
        <div className="mt-4 flex items-center gap-4">
          <Avatar url={profile.avatar_url} initial={profile.avatar_initial || profile.name?.[0]} name={profile.name} size={64} />
          <div className="min-w-0">
            {(profile.verified || profile.student_verified) && (
              <div className="mb-1 flex min-w-0 flex-wrap items-center gap-1.5">
                {profile.verified && (
                  <span className="inline-flex min-w-0 shrink items-center gap-1 rounded-lg bg-success-light px-2 py-0.5 text-[11px] font-semibold text-success">
                    <CheckCircle2 className="size-3 shrink-0" />
                    <span className="truncate">Verified</span>
                  </span>
                )}
                <StudentBadge profile={profile} />
              </div>
            )}
            {overall != null ? (
              <div className="flex min-w-0 items-center gap-2 text-ink-soft">
                <RatingStars value={overall} size={14} />
                <span className="truncate text-sm">
                  {overall.toFixed(1)} · {reviews.length} review{reviews.length !== 1 ? "s" : ""}
                </span>
              </div>
            ) : (
              <p className="text-sm text-ink-muted">No reviews yet</p>
            )}
            {college && <p className="mt-0.5 truncate text-sm font-semibold text-ink-soft">{college}</p>}
            {profile.city && (
              <p className="mt-0.5 flex min-w-0 items-center gap-1 text-sm text-ink-muted">
                <MapPin className="size-3.5 shrink-0" /> <span className="truncate">{profile.city}</span>
              </p>
            )}
          </div>
        </div>
      </PageHeader>

      <PageContainer width="content" className="space-y-4">
        {isSelf && (
          <div className="flex items-center gap-2 rounded-2xl bg-white px-4 py-3 shadow-[var(--shadow-card)]">
            <Eye className="size-4 shrink-0 text-ink-muted" />
            <p className="min-w-0 text-[13px] text-ink-soft">
              This is your public profile — exactly how others see you.
            </p>
          </div>
        )}

        {/* Two columns once the content box clears 64rem: a fixed identity/trust
            rail (availability, skills, certifications) beside the fluid activity
            feed. Below that the two stack in exactly the mobile screen's order.
            A container step, not `lg:` — `<main>` is the @container, and a viewport
            query is wrong by one sidebar width: `lg:` fired at a 784px content box,
            splitting 720px of content into a 320px rail and a ~376px column, so the
            cards on the right got NARROWER at 1024px than they had been stacked. */}
        <div className="@5xl:grid @5xl:grid-cols-[20rem_minmax(0,1fr)] @5xl:items-start @5xl:gap-6">
          <div className="min-w-0 space-y-4">
            {canShowAvailability && (
              <Section title="Availability">
                <div className="rounded-2xl bg-white p-4 shadow-[var(--shadow-card)]">
                  {profile.work_status && (() => {
                    const ws = workStatusMeta(profile.work_status);
                    return (
                      <div className="mb-3 flex items-center gap-2 border-b border-divider pb-3">
                        <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: ws.color }} />
                        <span className="min-w-0 truncate text-sm font-bold text-ink">{ws.label}</span>
                      </div>
                    );
                  })()}
                  <div className="space-y-1.5">
                    {availDays.map(({ label, day, windows }) => (
                      <div key={day} className="flex items-start justify-between gap-3 border-t border-divider pt-1.5 text-sm first:border-t-0 first:pt-0">
                        <span className="shrink-0 font-semibold text-ink">{label}</span>
                        <span className="min-w-0 text-right font-medium text-ink-soft">
                          {windows.map((w) => `${fmtTime(w.start)}–${fmtTime(w.end)}`).join(", ")}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </Section>
            )}

            {!isSelf && user && (sharedBooking || myOpenGigs.length > 0) && (
              // `@5xl:flex-col` is keyed to the same step as the two-column split
              // above: once this becomes a 20rem rail the two CTAs have to stack
              // again. It must move with the grid, not with the viewport.
              <div className="flex flex-col gap-2 sm:flex-row @5xl:flex-col">
                {/* Deep-links into the Messages page, which opens the conversation for
                    that booking directly (?booking=<id>). */}
                {sharedBooking && (
                  <Link href={`/messages?booking=${sharedBooking.id}`} className={buttonClasses("primary", "md", "flex-1")}>
                    <MessageCircle className="size-4 shrink-0" /> <span className="truncate">Message</span>
                  </Link>
                )}
                {myOpenGigs.length > 0 && (
                  <Button className="flex-1" variant={sharedBooking ? "outline" : "primary"} onClick={() => setInviteOpen(true)}>
                    <span className="truncate">Invite to a gig</span>
                  </Button>
                )}
              </div>
            )}

            {profile.bio && (
              <Section title="About">
                <p className="text-[15px] leading-relaxed text-ink-soft">{profile.bio}</p>
              </Section>
            )}

            {profile.skills && profile.skills.length > 0 && (
              <Section title="Skills">
                <div className="flex flex-wrap gap-2">
                  {profile.skills.map((s) => (
                    <span key={s} className="inline-flex max-w-full items-center rounded-full border border-line bg-white px-3 py-1.5 text-[13px] font-semibold text-ink-soft">
                      <span className="truncate">
                        {s}
                        {profile.skill_rates?.[s] ? ` · ${money(profile.skill_rates[s])}/hr` : ""}
                      </span>
                    </span>
                  ))}
                </div>
              </Section>
            )}

            {certified.length > 0 && (
              <Section title="Hustlr Certified">
                <div className="flex flex-wrap gap-2">
                  {certified.map((c) => (
                    <div
                      key={c.label}
                      className="flex max-w-full items-center gap-2 rounded-xl bg-success-light px-3.5 py-2.5 text-success"
                    >
                      <ShieldCheck className="size-5 shrink-0" />
                      <div className="min-w-0">
                        <p className="truncate text-sm font-bold">Certified · {c.label}</p>
                        <p className="truncate text-xs font-semibold">{c.count} jobs</p>
                      </div>
                    </div>
                  ))}
                </div>
              </Section>
            )}

            {isSelf && certified.length === 0 && progress.length > 0 && (
              <Section title="Progress to certification">
                <div className="space-y-1.5 rounded-2xl bg-white p-4 shadow-[var(--shadow-card)]">
                  {progress.map((p) => (
                    <div key={p.label} className="flex items-center justify-between gap-3 text-sm">
                      <span className="min-w-0 truncate font-semibold text-ink">{p.label}</span>
                      <span className="shrink-0 font-semibold text-ink-muted">
                        {p.count}/{p.needed}
                      </span>
                    </div>
                  ))}
                </div>
              </Section>
            )}

            {certs.length > 0 && (
              <Section title="Certifications">
                <div className="space-y-2">
                  {certs.map((c) => {
                    const certImg = safeCertUrl(c.image_url);
                    return (
                    <div key={c.id} className="flex items-center gap-3 rounded-2xl bg-white p-4 shadow-[var(--shadow-card)]">
                      {certImg && (
                        <a href={certImg} target="_blank" rel="noopener noreferrer" className="shrink-0">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={certImg} alt={c.title} className="size-12 rounded-lg bg-divider object-cover" />
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
              </Section>
            )}
          </div>

          {/* Its own `@container`: below the split this column is the full content
              measure, above it that minus the 20rem rail. Querying the column
              itself is the only way a card grid inside it can count columns
              correctly on both sides of that split. */}
          <div className="@container mt-4 min-w-0 space-y-4 @5xl:mt-0">
            {listings.length > 0 && (
              <Section title="Open gigs">
                <div className="grid gap-2 @2xl:grid-cols-2">
                  {listings.map((j) => (
                    <Link key={j.id} href={`/jobs/${j.id}`} className="flex items-center justify-between gap-3 rounded-2xl bg-white p-4 shadow-[var(--shadow-card)] transition hover:bg-canvas">
                      <div className="min-w-0">
                        <p className="truncate font-bold text-ink">{j.title}</p>
                        <p className="truncate text-xs text-ink-muted">{j.category} · {maskLocation(j.location)}</p>
                      </div>
                      <span className="shrink-0 text-[15px] font-bold text-ink">{payLabel({ pay: j.pay, payType: j.pay_type })}</span>
                    </Link>
                  ))}
                </div>
              </Section>
            )}

            {recentWork.length > 0 && (
              <Section title="Recent work">
                <div className="grid gap-2.5 @2xl:grid-cols-2">
                  {recentWork.map((r) => (
                    <div key={r.id} className="rounded-2xl bg-white p-4 shadow-[var(--shadow-card)]">
                      <div className="flex items-center justify-between gap-2">
                        <p className="min-w-0 truncate font-bold text-ink">{r.job?.title || "Completed gig"}</p>
                        <RatingStars value={r.rating} size={13} />
                      </div>
                      {r.text && <p className="mt-1 line-clamp-3 text-sm text-ink-soft">{r.text}</p>}
                      {r.date && <p className="mt-1 text-xs text-ink-muted">{r.date}</p>}
                    </div>
                  ))}
                </div>
              </Section>
            )}

            <Section title="Reviews">
              {reviews.length === 0 ? (
                <p className="text-sm text-ink-muted">No reviews yet.</p>
              ) : (
                <div className="grid gap-2.5 @2xl:grid-cols-2">
                  {reviews.map((r) => (
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
                </div>
              )}
            </Section>
          </div>
        </div>
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
                "flex min-h-11 w-full items-center justify-between gap-2 rounded-xl border px-3.5 py-2.5 text-left text-sm font-semibold transition",
                reportReason === r ? "border-primary bg-primary-light/50 text-primary" : "border-line text-ink-soft hover:border-ink-muted",
              )}
            >
              <span className="min-w-0">{r}</span>
              {reportReason === r && <span className="shrink-0">✓</span>}
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
              className="flex min-h-11 w-full items-center justify-between gap-2 rounded-xl border border-line px-3.5 py-2.5 text-left text-sm font-semibold text-ink-soft transition hover:border-primary hover:bg-primary-light/40"
            >
              <span className="min-w-0 truncate">{j.title}</span>
              <span className="shrink-0 text-ink-muted">{payLabel({ pay: j.pay, payType: j.payType })}</span>
            </button>
          ))}
        </div>
      </Modal>
    </div>
  );
}
