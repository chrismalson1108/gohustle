"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { BarChart3, MapPin, TrendingUp, Sparkles, Users, Coins, Tag } from "lucide-react";
import { computeAreaInsights } from "@gohustlr/shared";
import { useJobs } from "@/lib/jobs";
import { supabase } from "@/lib/supabaseClient";
import PageHeader, { PageContainer, EmptyState } from "@/components/PageHeader";
import { MAP_FRAME } from "@/lib/mapFrame";
import { money } from "@/lib/format";

// The skeleton reuses the map's own frame class, so the page holds its shape
// while the (client-only) map chunk loads instead of reflowing when it lands.
const JobsMap = dynamic(() => import("@/components/JobsMap"), {
  ssr: false,
  loading: () => <div className={`${MAP_FRAME} animate-pulse bg-white`} />,
});

// One responsive ladder shared by the real rows AND the loading skeletons —
// container queries, so the columns track the width the cards actually have
// (viewport minus the sidebar), not the window.
const AREA_GRID = "grid grid-cols-1 gap-3 @3xl:grid-cols-2 @6xl:grid-cols-3";

// One ranked area row, normalized so the RPC result and the client-side fallback
// render through the same card. avgTip/workerCount only come from the RPC.
interface AreaRow {
  area: string;
  jobCount: number;
  avgPay: number | null;
  topCategory: string | null;
  avgTip: number | null;
  workerCount: number | null;
}

// Shape returned by the `area_market_stats` RPC (snake_case from Postgres).
interface RpcRow {
  area: string;
  job_count: number;
  avg_pay: number | string | null;
  top_category: string | null;
  avg_tip: number | string | null;
  worker_count: number | null;
}

function num(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export default function InsightsPage() {
  const { jobs } = useJobs();
  const [rows, setRows] = useState<AreaRow[] | null>(null);
  const [loading, setLoading] = useState(true);

  // Fallback rows from the already-loaded public jobs feed (no tips/workers).
  const fallbackRows: AreaRow[] = useMemo(
    () =>
      computeAreaInsights(jobs).map((r) => ({
        area: r.area,
        jobCount: r.jobCount,
        avgPay: r.avgPay,
        topCategory: r.topCategory,
        avgTip: null,
        workerCount: null,
      })),
    [jobs],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const { data, error } = await supabase.rpc("area_market_stats");
        if (cancelled) return;
        if (error || !Array.isArray(data) || data.length === 0) {
          setRows(fallbackRows);
        } else {
          setRows(
            (data as RpcRow[]).map((d) => ({
              area: d.area,
              jobCount: Number(d.job_count) || 0,
              avgPay: num(d.avg_pay),
              topCategory: d.top_category,
              avgTip: num(d.avg_tip),
              workerCount: d.worker_count == null ? null : Number(d.worker_count),
            })),
          );
        }
      } catch {
        if (!cancelled) setRows(fallbackRows);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // fallbackRows changes when jobs load; we want the latest fallback available.
  }, [fallbackRows]);

  const display = rows ?? fallbackRows;

  return (
    <div>
      <PageHeader
        title="Market Insights"
        subtitle="Where the demand is — by area"
        width="feed"
        right={
          // Amber never carries white text — the pair is always accent-light
          // fill + accent-deep ink (mirrors mobile's proPill).
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-accent-light px-2.5 py-1 text-[11px] font-bold text-accent-deep">
            <Sparkles className="size-3.5 shrink-0" />
            Pro
          </span>
        }
      />

      <PageContainer width="feed" className="space-y-4">
        {/* Optional map of open gigs */}
        {jobs.some((j) => j.lat != null && j.lng != null) && <JobsMap jobs={jobs} />}

        {loading && rows === null ? (
          // Skeletons run through the SAME grid as the real rows (and a min-height
          // rather than a fixed one), so the column count and card height don't
          // change under the user when the data lands.
          <div className={AREA_GRID}>
            {[0, 1, 2].map((i) => (
              <div key={i} className="min-h-24 w-full animate-pulse rounded-2xl bg-white" />
            ))}
          </div>
        ) : display.length === 0 ? (
          <EmptyState
            icon={<BarChart3 className="size-10" />}
            title="No market data yet"
            body="Once gigs are posted across a few areas, you'll see demand, pay, and worker density here."
          />
        ) : (
          <div className={AREA_GRID}>
            {display.map((r, i) => (
              // One elevation mechanism: the shadow. No ring stacked on top.
              <div key={r.area} className="rounded-2xl bg-white p-4 shadow-[var(--shadow-card)]">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 flex-1 items-center gap-1.5">
                    {/* Rank is neutral — a brand-tinted counter competes with the
                        row's actual signal (demand and pay). */}
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-canvas text-xs font-bold text-ink-soft">
                      {i + 1}
                    </span>
                    <MapPin className="size-4 shrink-0 text-ink-muted" />
                    <h2 className="truncate text-[15px] font-semibold text-ink">{r.area}</h2>
                  </div>
                  <span className="shrink-0 rounded-full bg-canvas px-2.5 py-1 text-xs font-semibold text-ink">
                    {r.jobCount} gig{r.jobCount !== 1 ? "s" : ""}
                  </span>
                </div>

                {/* Hierarchy: every stat is quiet except the money one, which is
                    the number people came for. Four equally loud stats is no
                    hierarchy at all. */}
                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-sm">
                  {r.avgPay != null && (
                    <span className="flex min-w-0 items-center gap-1.5 font-semibold text-ink">
                      <TrendingUp className="size-4 shrink-0 text-accent-deep" />
                      <span className="truncate">avg {money(r.avgPay)}</span>
                    </span>
                  )}
                  {r.topCategory && (
                    <span className="flex min-w-0 items-center gap-1.5 font-medium text-ink-soft">
                      <Tag className="size-4 shrink-0 text-ink-muted" />
                      <span className="truncate">mostly {r.topCategory}</span>
                    </span>
                  )}
                  {r.avgTip != null && (
                    <span className="flex min-w-0 items-center gap-1.5 font-medium text-ink-soft">
                      <Coins className="size-4 shrink-0 text-ink-muted" />
                      <span className="truncate">avg tip {money(r.avgTip)}</span>
                    </span>
                  )}
                  {r.workerCount != null && (
                    <span className="flex min-w-0 items-center gap-1.5 font-medium text-ink-soft">
                      <Users className="size-4 shrink-0 text-ink-muted" />
                      <span className="truncate">
                        {r.workerCount} worker{r.workerCount !== 1 ? "s" : ""}
                      </span>
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </PageContainer>
    </div>
  );
}
