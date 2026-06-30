"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { BarChart3, MapPin, TrendingUp, Sparkles, Users, Coins } from "lucide-react";
import { CATEGORY_COLORS, computeAreaInsights } from "@gohustlr/shared";
import { useJobs } from "@/lib/jobs";
import { supabase } from "@/lib/supabaseClient";
import PageHeader, { PageContainer, EmptyState } from "@/components/PageHeader";
import { money } from "@/lib/format";

const JobsMap = dynamic(() => import("@/components/JobsMap"), {
  ssr: false,
  loading: () => <div className="h-[70vh] w-full animate-pulse rounded-3xl bg-line/60" />,
});

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
        right={
          <span className="flex items-center gap-1 rounded-full bg-gold/90 px-3 py-1 text-[11px] font-black uppercase tracking-wide text-ink">
            <Sparkles className="size-3.5" />
            Pro
          </span>
        }
      />

      <PageContainer className="space-y-4">
        {/* Optional map of open gigs */}
        {jobs.some((j) => j.lat != null && j.lng != null) && (
          <div>
            <JobsMap jobs={jobs} />
          </div>
        )}

        {loading && rows === null ? (
          <div className="space-y-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-24 w-full animate-pulse rounded-2xl bg-line/60" />
            ))}
          </div>
        ) : display.length === 0 ? (
          <EmptyState
            icon={<BarChart3 className="size-10" />}
            title="No market data yet"
            body="Once gigs are posted across a few areas, you'll see demand, pay, and worker density here."
          />
        ) : (
          <div className="space-y-3">
            {display.map((r, i) => {
              const color = (r.topCategory && CATEGORY_COLORS[r.topCategory]) || "#3F25FE";
              return (
                <div
                  key={r.area}
                  className="rounded-2xl bg-white p-4 shadow-[var(--shadow-card)] ring-1 ring-line/70"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary-light text-xs font-black text-primary">
                        {i + 1}
                      </span>
                      <div className="flex items-center gap-1.5">
                        <MapPin className="size-4 text-ink-muted" />
                        <h2 className="text-base font-bold text-ink">{r.area}</h2>
                      </div>
                    </div>
                    <span className="rounded-full bg-primary-light px-2.5 py-1 text-xs font-black text-primary">
                      {r.jobCount} gig{r.jobCount !== 1 ? "s" : ""}
                    </span>
                  </div>

                  <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm">
                    {r.avgPay != null && (
                      <span className="flex items-center gap-1.5 font-bold text-ink-soft">
                        <TrendingUp className="size-4 text-accent" />
                        avg {money(r.avgPay)}
                      </span>
                    )}
                    {r.topCategory && (
                      <span className="flex items-center gap-1.5 font-bold text-ink-soft">
                        <span className="size-2.5 rounded-full" style={{ backgroundColor: color }} />
                        mostly {r.topCategory}
                      </span>
                    )}
                    {r.avgTip != null && (
                      <span className="flex items-center gap-1.5 font-bold text-ink-soft">
                        <Coins className="size-4 text-gold" />
                        avg tip {money(r.avgTip)}
                      </span>
                    )}
                    {r.workerCount != null && (
                      <span className="flex items-center gap-1.5 font-bold text-ink-soft">
                        <Users className="size-4 text-ink-muted" />
                        {r.workerCount} worker{r.workerCount !== 1 ? "s" : ""}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </PageContainer>
    </div>
  );
}
