// Type declarations for the plain-JS @gohustlr/shared package so the web app
// (strict TS) can consume it. Keep in sync with the modules in /shared.
declare module "@gohustlr/shared" {
  // ── theme ──
  export const colors: Record<string, string>;
  export const gradients: Record<string, [string, string]>;
  export const cssGradients: Record<string, string>;
  export const shadows: Record<string, unknown>;

  // ── constants ──
  export interface Category { id: string; label: string; icon: string; ion: string }
  export const CATEGORIES: Category[];
  export const CATEGORY_COLORS: Record<string, string>;
  export const BADGE_DEFS: Record<string, { icon: string; ion: string; label: string; desc: string }>;
  export interface Level { level: number; label: string; minXP: number; color: string }
  export const LEVELS: Level[];

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
  export function matchesForYou(job: { category?: string; title?: string; description?: string; tags?: string[] } | null, skills: string[]): boolean;
  export function skillFitScore(job: { category?: string; title?: string; description?: string; tags?: string[] } | null, skills: string[] | undefined): number;
  export function availableStatesFrom(jobs: Array<{ location: string }>): string[];
  export function applyJobFilters<T>(
    jobs: T[],
    opts?: {
      selectedCat?: string;
      search?: string;
      filters?: JobFilters;
      blockedIds?: Set<string>;
      userCoords?: { lat: number; lng: number } | null;
      center?: { lat: number; lng: number } | null;
      mySchool?: string | null;
      forYouSkills?: string[];
    },
  ): Array<T & { _distanceMi?: number | null }>;

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
  export const CATEGORY_BASE_RATES: Record<string, number>;
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
    jobs: Array<{ category?: string; pay?: number }>,
    category?: string | null,
  ): { avg: number | null; median: number | null; count: number };
  export function scoreGig(job: Record<string, unknown>, opts?: { skills?: string[]; remaining?: number }): number;
  export function rankGigsForGoal<T>(jobs: T[], opts?: { skills?: string[]; remaining?: number }): T[];

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
    jobs: Array<{ location?: string | null; pay?: number | null; category?: string | null }> | null | undefined,
  ): Array<{ area: string; jobCount: number; avgPay: number | null; topCategory: string | null }>;

  // ── analytics (Hustlr Certified) ──
  export function computeCertifications(
    workerReviews: Array<{
      rating?: number | null;
      job?: { category?: string | null; tags?: string[] | null } | null;
    }> | null | undefined,
    opts?: { threshold?: number; minRating?: number },
  ): {
    certified: Array<{ label: string; count: number; avg: number }>;
    progress: Array<{ label: string; count: number; needed: number }>;
  };
}
