"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { CheckCircle2, GraduationCap, MapPin, ArrowLeft } from "lucide-react";
import { collegeLine } from "@gohustlr/shared";
import { supabase } from "@/lib/supabaseClient";
import PageHeader, { PageContainer, EmptyState } from "@/components/PageHeader";
import Avatar from "@/components/ui/Avatar";
import RatingStars from "@/components/ui/RatingStars";
import { FullPageSpinner } from "@/components/ui/Spinner";
import { payLabel } from "@/lib/format";

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

interface PubReview {
  id: string;
  rating: number;
  text: string | null;
  date: string | null;
  role: string;
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

export default function PublicProfilePage() {
  const { id } = useParams<{ id: string }>();
  const [profile, setProfile] = useState<PubProfile | null>(null);
  const [reviews, setReviews] = useState<PubReview[]>([]);
  const [listings, setListings] = useState<PubListing[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    (async () => {
      const [{ data: prof }, { data: revs }, { data: jobs }] = await Promise.all([
        supabase
          .from("profiles")
          .select(
            "id, name, avatar_initial, avatar_url, city, bio, skills, skill_rates, rating, review_count, member_since, verified, school, major, grad_year, student_verified, student_status",
          )
          .eq("id", id)
          .single(),
        supabase
          .from("reviews")
          .select("id, rating, text, date, role, reviewer:profiles!reviewer_id(name, avatar_initial, avatar_url)")
          .eq("reviewed_user_id", id)
          .order("created_at", { ascending: false }),
        supabase
          .from("jobs")
          .select("id, title, category, pay, pay_type, location")
          .eq("poster_id", id)
          .eq("status", "open"),
      ]);
      if (!active) return;
      setProfile((prof as PubProfile) || null);
      setReviews((revs as unknown as PubReview[]) || []);
      setListings((jobs as PubListing[]) || []);
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [id]);

  if (loading) return <FullPageSpinner />;
  if (!profile) return <EmptyState title="Profile not found" />;

  const college = collegeLine(profile);
  const overall = reviews.length ? reviews.reduce((s, r) => s + Number(r.rating || 0), 0) / reviews.length : null;

  return (
    <div>
      <PageHeader title="" subtitle="">
        <Link href="/browse" className="mb-3 flex items-center gap-1 text-sm font-bold text-white/80">
          <ArrowLeft className="size-4" /> Back
        </Link>
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

      <PageContainer>
        {profile.bio && (
          <>
            <h2 className="mb-2 text-sm font-extrabold uppercase tracking-wide text-ink-muted">About</h2>
            <p className="mb-6 leading-relaxed text-ink">{profile.bio}</p>
          </>
        )}

        {profile.skills && profile.skills.length > 0 && (
          <>
            <h2 className="mb-2 text-sm font-extrabold uppercase tracking-wide text-ink-muted">Skills</h2>
            <div className="mb-6 flex flex-wrap gap-2">
              {profile.skills.map((s) => (
                <span key={s} className="rounded-full border border-line bg-white px-3 py-1.5 text-sm font-bold text-ink-soft">
                  {s}
                  {profile.skill_rates?.[s] ? ` · $${profile.skill_rates[s]}/hr` : ""}
                </span>
              ))}
            </div>
          </>
        )}

        {listings.length > 0 && (
          <>
            <h2 className="mb-2 text-sm font-extrabold uppercase tracking-wide text-ink-muted">Open gigs</h2>
            <div className="mb-6 space-y-2">
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

        <h2 className="mb-2 text-sm font-extrabold uppercase tracking-wide text-ink-muted">Reviews</h2>
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
    </div>
  );
}
