-- "Market Insights" (Pro area heat-map): a safe, read-only aggregate RPC that
-- returns per-area market stats — job density, average pay, the most common job
-- type, average tip, and worker density. It exposes ONLY non-PII aggregates and
-- applies privacy thresholds (>= 3 rows) so no single user's data can be inferred.
--
-- security definer + stable + a pinned search_path so it can read across tables
-- (jobs/bookings/profiles) regardless of the caller's RLS while never leaking a
-- row-level value. Idempotent via create or replace. Do NOT run db push from here
-- — this file is the source of truth for a manual/security-reviewed apply.
create or replace function public.area_market_stats()
returns table (
  area         text,
  job_count    bigint,
  avg_pay      numeric,
  top_category text,
  avg_tip      numeric,
  worker_count bigint
)
language sql
security definer
set search_path = public
stable
as $$
  with j as (
    select location as area, pay, category
    from public.jobs
    where status = 'open'
      and coalesce(location, '') <> ''
  ),
  agg as (
    select
      area,
      count(*)                                  as job_count,
      round(avg(pay), 2)                        as avg_pay,
      mode() within group (order by category)   as top_category
    from j
    group by area
  ),
  tips as (
    select jb.location as area, round(avg(b.tip_amount), 2) as avg_tip
    from public.bookings b
    join public.jobs jb on jb.id = b.job_id
    where b.tip_amount > 0
      and coalesce(jb.location, '') <> ''
    group by jb.location
    having count(*) >= 3
  ),
  workers as (
    select city as area, count(*) as worker_count
    from public.profiles
    where coalesce(city, '') <> ''
    group by city
  )
  select
    a.area,
    a.job_count,
    a.avg_pay,
    a.top_category,
    t.avg_tip,
    w.worker_count
  from agg a
  left join tips t    on t.area = a.area
  left join workers w on w.area = a.area
  where a.job_count >= 3
  order by a.job_count desc;
$$;

grant execute on function public.area_market_stats() to anon, authenticated;
