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
    sortBy: string;
  }
  export const DEFAULT_FILTERS: JobFilters;
  export const DAY_OPTIONS: string[];
  export const PAY_OPTIONS: { id: string; label: string }[];
  export const PAY_TYPE_OPTIONS: { id: string; label: string }[];
  export const SORT_OPTIONS: { id: string; label: string }[];
  export function countActiveFilters(f: JobFilters): number;
  export function getState(location: string): string | null;
  export function getSlotDays(slots: Array<{ taken?: boolean; label?: string }>): Set<string>;
  export function matchesPay(job: { pay: number; payType: string; estimatedHours?: number }, payRange: string): boolean;
  export function availableStatesFrom(jobs: Array<{ location: string }>): string[];
  export function applyJobFilters<T>(
    jobs: T[],
    opts?: {
      selectedCat?: string;
      search?: string;
      filters?: JobFilters;
      blockedIds?: Set<string>;
      userCoords?: { lat: number; lng: number } | null;
    },
  ): Array<T & { _distanceMi?: number | null }>;

  // ── lifecycle ──
  export const BOOKING_STATUS: Record<string, { label: string; ion: string; color: string; bg: string }>;
  export function statusMeta(status: string): { label: string; ion: string; color: string; bg: string };
  export function earnBadgeCount(bookings: Array<{ status: string }>): number;
  export function profileBadgeCount(posterBookings: Array<{ status: string }>): number;
  export function nextStatusOnDone(booking: { status: string; posterDone: boolean; earnerDone: boolean }, side: "earner" | "poster"): string;

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
}
