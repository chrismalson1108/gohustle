"use client";

import { useState, useMemo, useEffect } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { Search, SlidersHorizontal, Map as MapIcon, List, X, Flame, BarChart3 } from "lucide-react";
import {
  CATEGORIES,
  DEFAULT_FILTERS,
  countActiveFilters,
  applyJobFilters,
  availableStatesFrom,
  milesLabel,
} from "@gohustlr/shared";
import { useUser } from "@/lib/user";
import { useJobs } from "@/lib/jobs";
import JobCard from "@/components/JobCard";
import FilterSheet, { type Filters } from "@/components/FilterSheet";
import PageHeader, { PageContainer, EmptyState } from "@/components/PageHeader";
import Button, { buttonClasses } from "@/components/ui/Button";
import { classNames } from "@/lib/format";
import type { Job } from "@/lib/types";

const JobsMap = dynamic(() => import("@/components/JobsMap"), {
  ssr: false,
  loading: () => <div className="h-[70vh] w-full animate-pulse rounded-3xl bg-white/60" />,
});

const CHIPS = [{ id: "foryou", label: "For You", icon: "✨" }, ...CATEGORIES];

export default function BrowsePage() {
  const { name, streakDays, school, skills, city } = useUser();
  const { jobs, bookings, blockedIds } = useJobs();

  const [selectedCat, setSelectedCat] = useState("all");
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [showFilter, setShowFilter] = useState(false);
  const [viewMode, setViewMode] = useState<"list" | "map">("list");
  const [userCoords, setUserCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [profileCoords, setProfileCoords] = useState<{ lat: number; lng: number } | null>(null);

  useEffect(() => {
    if (!("geolocation" in navigator)) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => setUserCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => {},
      { enableHighAccuracy: false, timeout: 8000 },
    );
  }, []);

  // Geocode the profile city → default center for the radius filter ("within X mi
  // of [profile location]"). Falls back to device location when the city is blank.
  useEffect(() => {
    if (!city) return;
    let cancelled = false;
    fetch(`/api/geocode?q=${encodeURIComponent(city)}`)
      .then((r) => r.json())
      .then((j) => {
        const c = j.features?.[0]?.geometry?.coordinates;
        if (!cancelled && Array.isArray(c)) setProfileCoords({ lat: c[1], lng: c[0] });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [city]);

  // Back-fill coords for gigs whose location wasn't geocoded at post time (legacy
  // data) by geocoding their location string once, cached by string, so the radius
  // filter can place them. Remote gigs need no coords.
  const [geoCache, setGeoCache] = useState<Record<string, { lat: number; lng: number }>>({});
  useEffect(() => {
    const needed = [
      ...new Set(
        jobs
          .filter((j) => (j.lat == null || j.lng == null) && j.location && !j.location.toLowerCase().includes("remote"))
          .map((j) => j.location),
      ),
    ].filter((loc) => !(loc in geoCache));
    if (needed.length === 0) return;
    let cancelled = false;
    needed.forEach((loc) => {
      fetch(`/api/geocode?q=${encodeURIComponent(loc)}`)
        .then((r) => r.json())
        .then((j) => {
          const c = j.features?.[0]?.geometry?.coordinates;
          if (!cancelled && Array.isArray(c)) setGeoCache((p) => ({ ...p, [loc]: { lat: c[1], lng: c[0] } }));
        })
        .catch(() => {});
    });
    return () => {
      cancelled = true;
    };
  }, [jobs, geoCache]);

  const jobsGeo = useMemo(
    () =>
      jobs.map((j) =>
        (j.lat != null && j.lng != null) || !geoCache[j.location]
          ? j
          : { ...j, lat: geoCache[j.location].lat, lng: geoCache[j.location].lng },
      ),
    [jobs, geoCache],
  );

  const availableStates = useMemo(() => availableStatesFrom(jobs), [jobs]);

  // Radius-filter center: an explicitly chosen location wins, else the geocoded
  // profile city, else the device location.
  const center =
    filters.near?.lat != null && filters.near?.lng != null
      ? { lat: filters.near.lat, lng: filters.near.lng }
      : profileCoords ?? userCoords;

  const filtered: Job[] = useMemo(
    () => applyJobFilters(jobsGeo, { selectedCat, search, filters, blockedIds, userCoords, center, mySchool: school, forYouSkills: skills }),
    [jobsGeo, selectedCat, search, filters, blockedIds, userCoords, center, school, skills],
  );

  const forYouNoSkills = selectedCat === "foryou" && skills.length === 0;

  const activeFilterCount = countActiveFilters(filters);
  const hasNarrowed =
    activeFilterCount > 0 || search.trim() !== "" || (selectedCat !== "all" && selectedCat !== "foryou");

  return (
    <div>
      <PageHeader
        title={`Hey ${name}`}
        subtitle="Ready to hustle?"
        variant="brand"
        right={
          <div className="flex flex-col items-center rounded-2xl bg-white/15 px-3.5 py-2">
            <Flame className="size-5 text-gold" />
            <span className="text-xl font-black leading-none">{streakDays}</span>
            <span className="text-[10px] text-white/75">week streak</span>
          </div>
        }
      >
        <div className="mt-5 flex gap-2.5">
          <div className="flex h-11 flex-1 items-center gap-2 rounded-2xl bg-white px-3.5">
            <Search className="size-4 text-ink-muted" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search gigs..."
              className="h-full flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-ink-muted"
            />
            {search && (
              <button onClick={() => setSearch("")} aria-label="Clear">
                <X className="size-4 text-ink-muted" />
              </button>
            )}
          </div>
          <button
            onClick={() => setShowFilter(true)}
            aria-label={`Filters${activeFilterCount > 0 ? ` (${activeFilterCount} active)` : ""}`}
            className={classNames(
              "relative flex size-11 items-center justify-center rounded-2xl",
              activeFilterCount > 0 ? "bg-white text-primary" : "bg-white/20 text-white",
            )}
          >
            <SlidersHorizontal className="size-5" />
            {activeFilterCount > 0 && (
              <span className="absolute -right-1 -top-1 flex size-4 items-center justify-center rounded-full bg-urgent text-[10px] font-black">
                {activeFilterCount}
              </span>
            )}
          </button>
        </div>
      </PageHeader>

      <PageContainer>
        {/* Category chips */}
        <div className="-mx-1 flex gap-2 overflow-x-auto pb-4">
          {CHIPS.map((cat) => {
            const active = selectedCat === cat.id;
            return (
              <button
                key={cat.id}
                onClick={() => setSelectedCat(cat.id)}
                className={classNames(
                  "flex shrink-0 items-center gap-1.5 rounded-full border px-3.5 py-2 text-[13px] font-bold transition",
                  active ? "border-primary bg-primary text-white" : "border-line bg-white text-ink-soft hover:border-primary",
                )}
              >
                <span>{cat.icon}</span>
                {cat.label}
              </button>
            );
          })}
        </div>

        {/* Campus quick-toggle */}
        {school && (
          <button
            onClick={() => setFilters((f) => ({ ...f, campusOnly: !f.campusOnly }))}
            className={classNames(
              "mb-3 flex w-full items-center justify-center gap-1.5 rounded-2xl border px-4 py-2.5 text-sm font-bold transition",
              filters.campusOnly ? "border-primary bg-primary text-white" : "border-primary/40 bg-primary-light/50 text-primary",
            )}
          >
            🏫 {filters.campusOnly ? `Showing ${school} only` : `Show gigs from ${school}`}
          </button>
        )}

        {/* Results bar */}
        <div className="mb-3 flex items-center justify-between">
          <p className="text-xs font-bold uppercase tracking-wide text-ink-muted">
            {filtered.length} gig{filtered.length !== 1 ? "s" : ""} available
          </p>
          <div className="flex items-center gap-4">
            {activeFilterCount > 0 && (
              <button onClick={() => setFilters(DEFAULT_FILTERS)} className="text-sm font-bold text-primary">
                Clear filters
              </button>
            )}
            <Link href="/insights" className="flex items-center gap-1 text-sm font-bold text-primary">
              <BarChart3 className="size-4" />
              Insights
            </Link>
            <button
              onClick={() => setViewMode((m) => (m === "list" ? "map" : "list"))}
              className="flex items-center gap-1 text-sm font-bold text-primary"
            >
              {viewMode === "list" ? <MapIcon className="size-4" /> : <List className="size-4" />}
              {viewMode === "list" ? "Map" : "List"}
            </button>
          </div>
        </div>

        {/* Content */}
        {viewMode === "map" ? (
          <div className="pb-8">
            <JobsMap jobs={filtered} userCoords={userCoords} />
          </div>
        ) : filtered.length === 0 ? (
          <div>
            <EmptyState
              icon={<Search className="size-10" />}
              title="No gigs found"
              body={
                forYouNoSkills
                  ? "Add skills to your profile to get gigs matched to you"
                  : selectedCat === "foryou"
                    ? "No gigs match your skills right now"
                    : hasNarrowed
                      ? "No gigs match your filters"
                      : "No gigs near you yet — check back soon, or post one to get the ball rolling."
              }
            />
            <div className="-mt-8 flex justify-center pb-16">
              {forYouNoSkills ? (
                <Link href="/profile/settings" className={buttonClasses("secondary", "md")}>
                  Add your skills
                </Link>
              ) : hasNarrowed ? (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setFilters(DEFAULT_FILTERS);
                    setSearch("");
                    setSelectedCat("all");
                  }}
                >
                  Clear search &amp; filters
                </Button>
              ) : (
                <Link href="/hiring/new" className={buttonClasses("secondary", "md")}>
                  Post a gig
                </Link>
              )}
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 pb-8 lg:grid-cols-2">
            {filtered.map((job) => (
              <JobCard
                key={job.id}
                job={job}
                distanceLabel={milesLabel(job._distanceMi ?? null)}
                bookingStatus={bookings.find((b) => b.jobId === job.id)?.status}
              />
            ))}
          </div>
        )}
      </PageContainer>

      <FilterSheet
        open={showFilter}
        filters={filters}
        availableStates={availableStates}
        mySchool={school}
        defaultCenterLabel={city}
        onApply={(f) => {
          setFilters(f);
          setShowFilter(false);
        }}
        onClose={() => setShowFilter(false)}
      />
    </div>
  );
}
