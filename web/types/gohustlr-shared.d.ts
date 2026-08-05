// Type declarations for the plain-JS @gohustlr/shared package so the web app
// (strict TS) can consume it. Keep in sync with the modules in /shared.
declare module "@gohustlr/shared" {
  // ── theme ──
  export const colors: Record<string, string>;
  export const gradients: Record<string, [string, string]>;
  export const cssGradients: Record<string, string>;
  export const shadows: Record<string, unknown>;

  // ── constants ──
  /** Pay floor/ceiling in whole dollars; applies to the RATE, not the computed total. */
  export const MIN_JOB_PAY: number;
  export const MAX_JOB_PAY: number;
  /** Returns null when valid, else a ready-to-show error string. */
  export function validateJobPay(value: string | number): string | null;
  export const BADGE_DEFS: Record<string, { icon: string; ion: string; label: string; desc: string }>;
  export interface Level { level: number; label: string; minXP: number; color: string }
  export const LEVELS: Level[];

  // ── categories ──
  // The gig taxonomy. `slug` is the identity everything filters, groups and
  // compares on; `label` is display only. Every export of shared/categories.js is
  // declared here — this file is the only type check the web app gets over it, so
  // an omission silently un-types a call site rather than failing here.

  /**
   * One category. Rows loaded from the `categories` table carry `usageCount` and
   * `status` as well, which is why both are optional — an app-level list stays
   * structurally assignable wherever an `extra` catalog is accepted.
   */
  export interface CategoryEntry {
    slug: string;
    label: string;
    group: string;
    groupLabel: string;
    /** Per-hour starting point for the pricing coach. */
    rate: number;
    /** Ionicons name. */
    ion: string;
    canonical: boolean;
    usageCount?: number;
    status?: string;
  }

  export interface CategoryGroupMeta {
    key: string;
    label: string;
    ion: string;
    /** Map-pin color for every category in the group. */
    color: string;
    rate: number;
  }

  /** A browse chip: identity + what to draw, plus how many gigs carry it right now. */
  export interface BrowseChip {
    /** Same value as `slug` — React key / selection id. */
    id: string;
    slug: string;
    label: string;
    ion: string;
    count: number;
  }

  export interface NormalizedCategory {
    ok: boolean;
    slug: string;
    label: string;
    /** True when submitting this will mint a community category. */
    isNew: boolean;
    error: string | null;
  }

  /** User-created categories to consider alongside the seed catalog. */
  type CategoryExtra = ReadonlyArray<CategoryEntry> | null;
  type ProhibitedCheck = (text: string) => string | null;

  export const CATEGORY_LABEL_MIN: number;
  export const CATEGORY_LABEL_MAX: number;
  export const CATEGORY_SLUG_MAX: number;
  export const NEUTRAL_BASE_RATE: number;
  export const CATEGORY_CATALOG: CategoryEntry[];
  export const CATEGORY_GROUPS: CategoryGroupMeta[];
  /** { typedSlug: canonicalSlug } — spellings that fold into an existing category. */
  export const CATEGORY_ALIASES: Record<string, string>;
  /** Slugs the app keeps for its own control values ('all', 'foryou', 'other', …). */
  export const RESERVED_CATEGORY_SLUGS: ReadonlySet<string>;
  export const LEGACY_CATEGORY_LABELS: string[];

  /** The canonical identity of a category; '' for anything that normalizes away. */
  export function categorySlug(input: unknown): string;
  /** categorySlug + alias chain. Pass the DB alias map for merges curated post-build. */
  export function resolveCategorySlug(input: unknown, extraAliases?: Record<string, string> | null): string;
  export function findCategory(input: unknown, extra?: CategoryExtra): CategoryEntry | null;
  /** Display string: canonical casing when known, the caller's tidied text otherwise. */
  export function categoryLabel(input: unknown, extra?: CategoryExtra): string;
  export function categoryGroup(input: unknown, extra?: CategoryExtra): CategoryGroupMeta;
  /** Map-pin color. Total — community categories get a stable slug-derived hue. */
  export function categoryColor(input: unknown, extra?: CategoryExtra): string;
  export function categoryIcon(input: unknown, extra?: CategoryExtra): string;
  export function categoryBaseRate(input: unknown, extra?: CategoryExtra): number;
  /** Slug-level, alias-aware equality — the only correct way to compare categories. */
  export function sameCategory(a: unknown, b: unknown): boolean;
  /** null when the label is usable, else a ready-to-show message. */
  export function validateCategoryLabel(raw: unknown, findProhibited?: ProhibitedCheck | null): string | null;
  export function normalizeCategoryInput(
    raw: unknown,
    opts?: { findProhibited?: ProhibitedCheck | null; extra?: CategoryExtra },
  ): NormalizedCategory;
  export function searchCategories(
    query: unknown,
    opts?: { extra?: CategoryExtra; limit?: number; includeGroups?: boolean },
  ): CategoryEntry[];
  export function categoriesByGroup(extra?: CategoryExtra): Array<CategoryGroupMeta & { items: CategoryEntry[] }>;
  export function browseChipsFromJobs(
    jobs: ReadonlyArray<{ category?: string | null } | null | undefined> | null | undefined,
    opts?: { recentSlugs?: readonly string[] | null; extra?: CategoryExtra; limit?: number },
  ): BrowseChip[];

  // ── geo ──
  export function haversineMiles(
    a: { lat: number | null; lng: number | null } | null,
    b: { lat: number | null; lng: number | null } | null,
  ): number | null;
  export function milesLabel(mi: number | null): string | null;

  // ── leveling ──
  export function getLevelInfo(xp: number): {
    current: Level;
    next: Level | null;
    progress: number;
  };

  // ── transforms (return `any` at the JS/TS boundary; callers cast to Job/Booking) ──
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function transformJob(dbJob: Record<string, unknown>): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function transformBooking(b: Record<string, unknown>): any;

  // ── filters ──
  export interface JobFilters {
    payRange: string;
    days: string[];
    location: string;
    payType: string;
    urgentOnly: boolean;
    verifiedStudentsOnly: boolean;
    campusOnly: boolean;
    radius: string | number;
    near: { label: string; lat: number | null; lng: number | null } | null;
    sortBy: string;
  }
  export const DEFAULT_FILTERS: JobFilters;
  export const DAY_OPTIONS: string[];
  export const PAY_OPTIONS: { id: string; label: string }[];
  export const PAY_TYPE_OPTIONS: { id: string; label: string }[];
  export const SORT_OPTIONS: { id: string; label: string }[];
  export const RADIUS_OPTIONS: { id: string | number; label: string }[];
  export function countActiveFilters(f: JobFilters): number;
  export function getState(location: string): string | null;
  export function getSlotDays(slots: Array<{ taken?: boolean; label?: string }>): Set<string>;
  export function matchesPay(job: { pay: number; payType: string; estimatedHours?: number }, payRange: string): boolean;
  /** Anything a skill can be matched against. `categorySlug` is the identity and wins over the label. */
  interface MatchableJob {
    category?: string | null;
    categorySlug?: string | null;
    title?: string | null;
    description?: string | null;
    tags?: string[] | null;
  }
  interface SkillMatchOpts {
    /** {fromSlug: toSlug} for categories merged after this build shipped. */
    extraAliases?: Record<string, string> | null;
  }
  /** Points a single skill scores: a shared category counts double a text hit. */
  export const SKILL_MATCH_WEIGHT: { category: number; text: number };
  /** Every category identity a gig carries — its category plus its tags — as slugs. */
  export function jobCategorySlugs(job: MatchableJob | null | undefined, extraAliases?: Record<string, string> | null): Set<string>;
  export function matchesForYou(job: MatchableJob | null | undefined, skills: string[] | undefined, opts?: SkillMatchOpts): boolean;
  export function skillFitScore(job: MatchableJob | null | undefined, skills: string[] | undefined, opts?: SkillMatchOpts): number;
  export function availableStatesFrom(jobs: Array<{ location: string }>): string[];
  export function applyJobFilters<T>(
    jobs: T[],
    opts?: {
      /** 'all', 'foryou', or a category SLUG — never a display label. */
      selectedCat?: string;
      search?: string;
      filters?: JobFilters;
      blockedIds?: Set<string>;
      userCoords?: { lat: number; lng: number } | null;
      center?: { lat: number; lng: number } | null;
      mySchool?: string | null;
      forYouSkills?: string[];
      /** Viewer's own bookings — gigs they already won/finished leave their feed. */
      myBookings?: Array<{ jobId: string; status: string }>;
      /** fetchCategories().aliases — merges curated after this build shipped. */
      extraAliases?: Record<string, string> | null;
    },
  ): Array<T & { _distanceMi?: number | null }>;
  /** Can ANYONE still book this gig? Slot-aware, so multi-slot gigs stay while any slot is free. */
  export function isJobBookable(job: { status?: string; slots?: Array<{ taken?: boolean }> } | null | undefined): boolean;
  /** Should THIS viewer still see it? True once they hold a confirmed/completed/verified booking. */
  export function isHiddenForViewer(
    job: { id: string } | null | undefined,
    myBookings: Array<{ jobId: string; status: string }> | null | undefined,
  ): boolean;

  // ── lifecycle ──
  export const BOOKING_STATUS: Record<string, { label: string; ion: string; color: string; bg: string }>;
  export function statusMeta(status: string): { label: string; ion: string; color: string; bg: string };
  export function earnBadgeCount(bookings: Array<{ status: string }>): number;
  export function profileBadgeCount(posterBookings: Array<{ status: string }>): number;
  export function nextStatusOnDone(booking: { status: string; posterDone: boolean; earnerDone: boolean }, side: "earner" | "poster"): string;
  export const EARNER_CLAIM_GRACE_DAYS: number;
  export function canClaimEarnerPayment(
    booking: { earnerDone?: boolean; status?: string; startsAt?: string | null } | null | undefined,
    now?: Date,
    graceDays?: number,
  ): boolean;

  // ── age ──
  export const MIN_AGE: number;
  export function parseDob(input: string | null | undefined): string | null;
  export function computeAge(dob: string | Date | null | undefined, now?: Date): number | null;
  export function isAdult(dob: string | Date | null | undefined, now?: Date): boolean;

  // ── taxFormat ──
  export const EXPENSE_CATEGORIES: { id: string; label: string; ion: string }[];
  export const INCOME_SOURCES: { id: string; label: string; ion: string }[];
  export function categoryMeta(id: string): { id: string; label: string; ion: string };
  export function sourceMeta(id: string): { id: string; label: string; ion: string };
  export function buildCSV(expenses: Array<Record<string, unknown>>): string;
  export function buildTaxSummaryCSV(args: {
    year: number | string;
    stripeIncome: number;
    income: Array<Record<string, unknown>>;
    expenses: Array<Record<string, unknown>>;
  }): string;

  // ── contentFilter ──
  export function findProhibited(text: string): string | null;
  export function isClean(...texts: string[]): boolean;

  // ── school ──
  export const CLASS_STANDINGS: string[];
  export const DEGREE_TYPES: string[];
  export const COLLEGE_DOMAINS: Record<string, string>;
  export function gradYearOptions(currentYear: number, back?: number, forward?: number): number[];
  export function isEduEmail(email: string): boolean;
  export function schoolDomainFromEmail(email: string): string | null;
  export function schoolNameFromDomain(domain: string | null): string | null;
  export function studentTrustLabel(profile: {
    studentVerified?: boolean;
    student_verified?: boolean;
    studentStatus?: string;
    student_status?: string;
  } | null): string | null;
  export function collegeLine(profile: {
    school?: string | null;
    major?: string | null;
    gradYear?: number | null;
    grad_year?: number | null;
  } | null): string | null;

  // ── finance ──
  // (CATEGORY_BASE_RATES is gone: per-category rates live on the catalog now —
  // use categoryBaseRate(), which covers user-created categories too.)
  export const IRS_MILEAGE_RATE: number;
  export function computeGoalPlan(args: {
    monthlyGoal: number;
    earnedThisMonth?: number;
    avgGigValue?: number;
    gigsThisMonth?: number;
    now?: Date;
  }): {
    goal: number; earned: number; remaining: number; pctComplete: number;
    daysInMonth: number; dayOfMonth: number; daysLeft: number;
    gigsNeeded: number | null; perDayNeeded: number; perWeekNeeded: number;
    projectedTotal: number; expectedByNow: number; gigsThisMonth: number;
    status: "unset" | "behind" | "onTrack" | "ahead" | "reached";
  };
  export function suggestRate(args: { category?: string; skillRate?: number | null; marketAvg?: number | null }): {
    low: number; typical: number; high: number; basis: string;
  };
  export function marketRate(
    jobs: Array<{ category?: string | null; categorySlug?: string | null; pay?: number }>,
    category?: string | null,
  ): { avg: number | null; median: number | null; count: number };
  export function scoreGig(
    job: Record<string, unknown>,
    opts?: { skills?: string[]; remaining?: number; extraAliases?: Record<string, string> | null },
  ): number;
  /** Drops gigs nobody can book and gigs this viewer already won before ranking. */
  export function rankGigsForGoal<T>(
    jobs: T[],
    opts?: {
      skills?: string[];
      remaining?: number;
      myBookings?: Array<{ jobId?: string; status?: string }>;
      extraAliases?: Record<string, string> | null;
    },
  ): T[];
  /** The one dollar formatter: whole dollars or exactly 2dp, always separated. */
  export function formatMoney(n: number | null | undefined): string;

  // ── challenges (period reset) ──
  /** 'YYYY-MM-DD' for daily, 'YYYY-Wmmdd' (Monday-anchored) for weekly; null on a bad date. */
  export function periodKey(type: string, date?: Date): string | null;
  export function isSamePeriod(type: string, updatedAt: string | null | undefined, now?: Date): boolean;
  /** Stored progress inside its period, 0 outside it — this is what stops a finished challenge reading "Done" forever. */
  export function livingProgress(
    challenge: { type?: string; progress?: number } | null | undefined,
    updatedAt: string | null | undefined,
    now?: Date,
  ): number;
  export function isComplete(challenge: { progress?: number; target?: number } | null | undefined): boolean;
  export function resetLabel(type: string): string;

  // ── availability ──
  export const DAYS: string[];
  export interface WorkStatus { id: string; label: string; emoji: string; color: string }
  export const WORK_STATUSES: WorkStatus[];
  export function workStatusMeta(id: string): WorkStatus;
  export function parseTime(hhmm: string): number | null;
  export function fmtTime(hhmm: string): string;
  export interface AvailWindow { day: number; start: string; end: string }
  export function windowsForDay(availability: AvailWindow[], day: number): AvailWindow[];
  export function classOverlaps(classSchedule: Array<Record<string, unknown>>, window: { day: number; start: string; end: string }): boolean;
  export function isFreeAt(
    availability: AvailWindow[],
    classSchedule: Array<Record<string, unknown>>,
    window: { day: number; start: string; end: string },
  ): boolean;
  export function availabilitySummary(availability: AvailWindow[]): string;

  // ── analytics (personal earner Insights) ──
  export function computeEarnerInsights(bookings: unknown[]): {
    topArea: { label: string; count: number } | null;
    busiestDay: { label: string; count: number } | null;
    mostProfitableDay: { label: string; total: number } | null;
    jobCount: number;
  } | null;

  // ── analytics (Market Insights — area heat-map fallback) ──
  export function computeAreaInsights(
    jobs: Array<{
      location?: string | null;
      pay?: number | null;
      category?: string | null;
      categorySlug?: string | null;
    }> | null | undefined,
    /** `topCategory` is a canonical label, or null when the area has no categorized gig. */
  ): Array<{ area: string; jobCount: number; avgPay: number | null; topCategory: string | null }>;

  // ── analytics (Hustlr Certified) ──
  export function computeCertifications(
    workerReviews: Array<{
      rating?: number | null;
      job?: { category?: string | null; categorySlug?: string | null; tags?: string[] | null } | null;
    }> | null | undefined,
    opts?: { threshold?: number; minRating?: number },
  ): {
    certified: Array<{ label: string; count: number; avg: number }>;
    progress: Array<{ label: string; count: number; needed: number }>;
  };
}
