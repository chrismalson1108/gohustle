"use client";

import { useState, useMemo, useEffect } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { Search, SlidersHorizontal, Map as MapIcon, List, X, Flame, BarChart3, School, ChevronDown } from "lucide-react";
import {
  DEFAULT_FILTERS,
  countActiveFilters,
  applyJobFilters,
  availableStatesFrom,
  browsableJobs,
  browseChipsFromJobs,
  categoryLabel,
  milesLabel,
} from "@gohustlr/shared";
import { useUser } from "@/lib/user";
import { useJobs } from "@/lib/jobs";
import { fetchCategories, type CategoryIndex } from "@/lib/categories";
import JobCard from "@/components/JobCard";
import CategoryPicker from "@/components/CategoryPicker";
import FilterSheet, { type Filters } from "@/components/FilterSheet";
import PageHeader, { PageContainer, EmptyState } from "@/components/PageHeader";
import { FullPageSpinner } from "@/components/ui/Spinner";
import Button, { buttonClasses } from "@/components/ui/Button";
import Modal from "@/components/ui/Modal";
import { MAP_FRAME } from "@/lib/mapFrame";
import { classNames } from "@/lib/format";
import type { Job } from "@/lib/types";

// The skeleton reuses the map's own frame class, so switching to Map view doesn't
// reflow the page when the (client-only) map chunk finishes loading.
const JobsMap = dynamic(() => import("@/components/JobsMap"), {
  ssr: false,
  loading: () => <div className={`${MAP_FRAME} animate-pulse bg-white/60`} />,
});

// The two pseudo-categories the chip row leads with. Their ids are in
// RESERVED_CATEGORY_SLUGS precisely so a real category can never slug to either
// and hijack the selection.
const HEAD_CHIPS = [
  { slug: "foryou", label: "For You" },
  { slug: "all", label: "All" },
];

export default function BrowsePage() {
  const { name, streakDays, school, skills, city, profileStatus, recentCategorySlugs } = useUser();
  const { jobs, bookings, blockedIds, jobsLoading } = useJobs();

  // Show the real name only once the profile has actually loaded — never render the
  // "Hustler" placeholder as if it were the signed-in user's account.
  const greeting = profileStatus === "ready" ? `Hey ${name}` : "Hey there";
  // First jobs load still in flight (nothing arrived yet) → show a loader, not the
  // "no gigs" empty state, so a still-loading feed never looks like an empty one.
  const jobsFirstLoad = jobsLoading && jobs.length === 0;

  // A SLUG, never a label — 'lawn care' and 'Lawn Care' are one category, and the
  // chip row, the picker sheet and applyJobFilters all compare on this.
  const [selectedCat, setSelectedCat] = useState("all");
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [showFilter, setShowFilter] = useState(false);
  const [showCategories, setShowCategories] = useState(false);
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

  // The catalog (seed + community rows): `list` gives a user-created category its
  // stored label instead of a title-cased guess at its slug, and `aliases` carries
  // the merges curated since this build shipped, which only the DB knows about.
  const [catIndex, setCatIndex] = useState<CategoryIndex | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchCategories()
      .then((index) => {
        if (!cancelled) setCatIndex(index);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  const categories = catIndex?.list;
  const catAliases = catIndex?.aliases;

  // Chips come from the feed, not from a fixed array: a category someone created is
  // reachable the moment a gig carries it. The old module-level constant was computed
  // once at import from seven hardcoded labels, which is why everything outside those
  // seven was only findable under "All".
  //
  // The source is the BROWSABLE subset, not the raw list — a category whose only gigs
  // are already booked (or hidden from this viewer) would otherwise get a chip that
  // filters to "No gigs match your filters", which reads as a broken control.
  const chips = useMemo(() => {
    const derived = browseChipsFromJobs(
      browsableJobs(jobs, { blockedIds, myBookings: bookings }),
      { recentSlugs: recentCategorySlugs, extra: categories, aliases: catAliases },
    ).map((c: { slug: string; label: string }) => ({
      slug: c.slug,
      label: c.label,
    }));
    // A category picked from the sheet may have no gigs in the current feed, or
    // sit past the chip limit. A filter with no visible chip reads as no filter at
    // all, so the active one always gets a chip.
    if (
      selectedCat !== "all" &&
      selectedCat !== "foryou" &&
      !derived.some((c) => c.slug === selectedCat)
    ) {
      derived.unshift({ slug: selectedCat, label: categoryLabel(selectedCat, categories) });
    }
    return [...HEAD_CHIPS, ...derived];
  }, [jobs, bookings, blockedIds, recentCategorySlugs, categories, catAliases, selectedCat]);

  // Radius-filter center: an explicitly chosen location wins, else the geocoded
  // profile city, else the device location.
  const center =
    filters.near?.lat != null && filters.near?.lng != null
      ? { lat: filters.near.lat, lng: filters.near.lng }
      : profileCoords ?? userCoords;

  const filtered: Job[] = useMemo(
    () => applyJobFilters(jobsGeo, { selectedCat, search, filters, blockedIds, userCoords, center, mySchool: school, forYouSkills: skills, myBookings: bookings, extraAliases: catAliases }),
    // bookings included: the feed hides gigs this viewer already won.
    [jobsGeo, bookings, selectedCat, search, filters, blockedIds, userCoords, center, school, skills, catAliases],
  );

  const forYouNoSkills = selectedCat === "foryou" && skills.length === 0;

  const activeFilterCount = countActiveFilters(filters);
  const hasNarrowed =
    activeFilterCount > 0 || search.trim() !== "" || (selectedCat !== "all" && selectedCat !== "foryou");

  return (
    <div>
      <PageHeader
        title={greeting}
        subtitle="Ready to hustle?"
        right={
          <div className="flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5">
            <Flame className="size-3.5 text-primary" />
            {profileStatus === "ready" && streakDays > 0 ? (
              <>
                <span className="text-sm font-bold text-ink">{streakDays}</span>
                <span className="text-xs font-medium text-ink-soft">week streak</span>
              </>
            ) : (
              <span className="text-xs font-medium text-ink-soft">Start a streak</span>
            )}
          </div>
        }
      >
        <div className="mt-4 flex gap-2.5">
          <div className="flex h-12 flex-1 items-center gap-2 rounded-xl bg-white px-3.5">
            <Search className="size-4 shrink-0 text-ink-muted" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search gigs..."
              className="h-full min-w-0 flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-ink-muted"
            />
            {search && (
              <button onClick={() => setSearch("")} aria-label="Clear search">
                <X className="size-4 text-ink-muted" />
              </button>
            )}
          </div>
          <button
            onClick={() => setShowFilter(true)}
            aria-label={`Filters${activeFilterCount > 0 ? ` (${activeFilterCount} active)` : ""}`}
            className={classNames(
              "relative flex size-12 shrink-0 items-center justify-center rounded-xl text-white transition",
              activeFilterCount > 0 ? "bg-primary" : "bg-ink",
            )}
          >
            <SlidersHorizontal className="size-5" />
            {activeFilterCount > 0 && (
              <span className="absolute -right-1 -top-1 flex size-4 items-center justify-center rounded-full bg-urgent text-[10px] font-bold">
                {activeFilterCount}
              </span>
            )}
          </button>
        </div>
      </PageHeader>

      <PageContainer>
        {/* Category chips — active state is ink, not brand purple. Purple is
            reserved for links/CTAs and the active filter state. `no-scrollbar`
            keeps the horizontal rail clean where it overflows.
            Once the content column is wide enough the rail WRAPS instead of
            scrolling: a mouse wheel can't scroll an x-overflow row, so on desktop
            the trailing categories were reachable only by dragging a hairline
            scrollbar. Container query, not `md:` — the row's real width is the
            viewport minus the sidebar. */}
        <div className="no-scrollbar -mx-1 flex gap-2 overflow-x-auto px-1 pb-4 @3xl:flex-wrap @3xl:overflow-visible">
          {chips.map((cat) => {
            const active = selectedCat === cat.slug;
            return (
              <button
                key={cat.slug}
                onClick={() => setSelectedCat(cat.slug)}
                aria-pressed={active}
                className={classNames(
                  "max-w-full shrink-0 truncate rounded-full px-3.5 py-2 text-[13px] font-semibold transition",
                  active ? "bg-ink text-white" : "bg-white text-ink hover:bg-white/70",
                )}
              >
                {cat.label}
              </button>
            );
          })}
          {/* The feed can only ever surface the categories it currently holds —
              this is the way into the other ~190. Filter mode: picking is the
              point, minting a category from a browse screen is not. */}
          <button
            onClick={() => setShowCategories(true)}
            aria-haspopup="dialog"
            aria-expanded={showCategories}
            className="flex shrink-0 items-center gap-1 rounded-full bg-white px-3.5 py-2 text-[13px] font-semibold text-ink transition hover:bg-white/70"
          >
            More
            <ChevronDown className="size-3.5 shrink-0" />
          </button>
        </div>

        {/* Campus quick-toggle — the same shortcut as before, restyled to read as
            one more chip in the category row (lucide glyph, ink active state)
            rather than a full-width tinted banner with an emoji on it. The
            authoritative control still lives in the FilterSheet's Trust section. */}
        {school && (
          <button
            onClick={() => setFilters((f) => ({ ...f, campusOnly: !f.campusOnly }))}
            aria-pressed={filters.campusOnly}
            className={classNames(
              "mb-3 inline-flex max-w-full items-center gap-1.5 rounded-full px-3.5 py-2 text-[13px] font-semibold transition",
              filters.campusOnly ? "bg-ink text-white" : "bg-white text-ink hover:bg-white/70",
            )}
          >
            <School className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate">
              {filters.campusOnly ? `Showing ${school} only` : `Show gigs from ${school}`}
            </span>
          </button>
        )}

        {/* Results bar */}
        {/* The count yields space (and ellipsizes) so the right-hand action
            cluster is never clipped when a filter is active — with "Clear
            filters" showing, the two sides compete for a ~470px row. */}
        <div className="mb-3 flex items-center justify-between gap-3">
          <p className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink-muted">
            {jobsFirstLoad
              ? "Loading gigs…"
              : `${filtered.length} gig${filtered.length !== 1 ? "s" : ""} available`}
          </p>
          <div className="flex shrink-0 items-center gap-3 md:gap-4">
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
        {jobsFirstLoad && viewMode === "list" ? (
          <FullPageSpinner label="Finding gigs near you…" />
        ) : viewMode === "map" ? (
          <div className="pb-8">
            <JobsMap jobs={filtered} userCoords={userCoords} />
          </div>
        ) : filtered.length === 0 ? (
          // The CTA used to be pulled back up into EmptyState's py-16 with a
          // `-mt-8`, so two hardcoded numbers on opposite sides of a component
          // boundary had to agree. Instead, neutralize EmptyState's own bottom
          // padding here and let the CTA sit at a normal rhythm below it.
          <div className="flex flex-col items-center pb-16">
            <div className="w-full [&>div]:pb-4">
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
            </div>
            <div className="flex justify-center">
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
          // Truly fluid: auto-fill + minmax lets the grid add a column whenever
          // ~320px of room appears, so the feed fills a 2560px monitor the way
          // Marketplace does and collapses to one column on a phone — without a
          // breakpoint ladder that only works at the widths someone remembered.
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(320px,100%),1fr))] gap-4 pb-8">
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

      {/* Every category, searchable — the chip row's overflow. Choosing one (or
          clearing the token, which reports an empty pair) applies it and closes:
          the results behind the sheet are the answer. */}
      <Modal open={showCategories} onClose={() => setShowCategories(false)} title="Browse by category">
        <CategoryPicker
          value={selectedCat === "all" || selectedCat === "foryou" ? "" : categoryLabel(selectedCat, categories)}
          onChange={(label, slug) => {
            setSelectedCat(slug || "all");
            setShowCategories(false);
          }}
          recentSlugs={recentCategorySlugs}
          allowCreate={false}
          placeholder="Search all categories…"
        />
      </Modal>

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
