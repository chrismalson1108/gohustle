"use client";

import { useState, useMemo, useEffect } from "react";
import dynamic from "next/dynamic";
import { Search, SlidersHorizontal, Map as MapIcon, List, X, Flame } from "lucide-react";
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
import XPBar from "@/components/XPBar";
import { classNames } from "@/lib/format";
import type { Job } from "@/lib/types";

const JobsMap = dynamic(() => import("@/components/JobsMap"), {
  ssr: false,
  loading: () => <div className="h-[70vh] w-full animate-pulse rounded-3xl bg-white/60" />,
});

export default function BrowsePage() {
  const { name, streakDays, levelInfo, xp, school } = useUser();
  const { jobs, bookings, blockedIds } = useJobs();

  const [selectedCat, setSelectedCat] = useState("all");
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [showFilter, setShowFilter] = useState(false);
  const [viewMode, setViewMode] = useState<"list" | "map">("list");
  const [userCoords, setUserCoords] = useState<{ lat: number; lng: number } | null>(null);

  useEffect(() => {
    if (!("geolocation" in navigator)) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => setUserCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => {},
      { enableHighAccuracy: false, timeout: 8000 },
    );
  }, []);

  const availableStates = useMemo(() => availableStatesFrom(jobs), [jobs]);

  const filtered: Job[] = useMemo(
    () => applyJobFilters(jobs, { selectedCat, search, filters, blockedIds, userCoords, mySchool: school }),
    [jobs, selectedCat, search, filters, blockedIds, userCoords, school],
  );

  const activeFilterCount = countActiveFilters(filters);

  return (
    <div>
      {/* Header */}
      <header className="bg-brand px-5 pb-6 pt-8 text-white md:rounded-b-[2rem]">
        <div className="mx-auto w-full max-w-3xl">
          <div className="flex items-start justify-between">
            <div>
              <h1 className="text-2xl font-black">Hey {name}</h1>
              <p className="text-sm text-white/70">Ready to hustle?</p>
            </div>
            <div className="flex flex-col items-center rounded-2xl bg-white/15 px-3.5 py-2">
              <Flame className="size-5 text-gold" />
              <span className="text-xl font-black leading-none">{streakDays}</span>
              <span className="text-[10px] text-white/75">day streak</span>
            </div>
          </div>
          <div className="mt-4">
            <XPBar levelInfo={levelInfo} xp={xp} dark />
          </div>
          <div className="mt-4 flex gap-2.5">
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
        </div>
      </header>

      <div className="mx-auto w-full max-w-3xl px-5">
        {/* Category chips */}
        <div className="-mx-1 flex gap-2 overflow-x-auto py-4">
          {CATEGORIES.map((cat) => {
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
              <button onClick={() => setFilters(DEFAULT_FILTERS)} className="text-[13px] font-bold text-primary">
                Clear filters
              </button>
            )}
            <button
              onClick={() => setViewMode((m) => (m === "list" ? "map" : "list"))}
              className="flex items-center gap-1 text-[13px] font-bold text-primary"
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
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <Search className="size-10 text-ink-muted" />
            <p className="text-ink-soft">No gigs match your filters</p>
            {activeFilterCount > 0 && (
              <button
                onClick={() => setFilters(DEFAULT_FILTERS)}
                className="rounded-xl bg-primary-light px-5 py-2.5 text-sm font-bold text-primary"
              >
                Reset all filters
              </button>
            )}
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
      </div>

      <FilterSheet
        open={showFilter}
        filters={filters}
        availableStates={availableStates}
        mySchool={school}
        onApply={(f) => {
          setFilters(f);
          setShowFilter(false);
        }}
        onClose={() => setShowFilter(false)}
      />
    </div>
  );
}
