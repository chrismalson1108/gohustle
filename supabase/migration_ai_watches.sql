-- ─────────────────────────────────────────────────────────────────────────────
-- Hustlr AI — proactive gig watches (idempotent). Run in the SQL editor.
--
-- Upgrades the saved-search notifier so a "watch" can match on keyword, location,
-- and minimum pay (not just category). The AI bot creates these as saved_searches
-- (name = the human label, filters = { selectedCat, keyword, location, minPay }),
-- and this trigger drops an in-app notification when a matching gig is posted.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.notify_saved_searches()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  s    record;
  cat  text;
  kw   text;
  loc  text;
  minp numeric;
begin
  for s in select * from public.saved_searches where notify loop
    -- never notify a poster about their own gig
    if s.user_id = new.poster_id then continue; end if;

    -- category (or 'all')
    cat := coalesce(s.filters->>'selectedCat', 'all');
    if cat <> 'all' and cat <> new.category then continue; end if;

    -- minimum pay
    minp := nullif(s.filters->>'minPay', '')::numeric;
    if minp is not null and new.pay < minp then continue; end if;

    -- location substring
    loc := s.filters->>'location';
    if loc is not null and loc <> '' and new.location not ilike '%' || loc || '%' then continue; end if;

    -- keyword across title / description / category
    kw := s.filters->>'keyword';
    if kw is not null and kw <> ''
       and new.title       not ilike '%' || kw || '%'
       and new.description not ilike '%' || kw || '%'
       and new.category    not ilike '%' || kw || '%' then
      continue;
    end if;

    insert into public.notifications (user_id, type, title, body, job_id)
    values (
      s.user_id,
      'saved_search',
      coalesce(nullif(s.name, ''), 'New gig matches your watch'),
      new.title || ' · $' || new.pay::text,
      new.id
    );
  end loop;
  return new;
end;
$$;

drop trigger if exists trg_notify_saved_searches on public.jobs;
create trigger trg_notify_saved_searches
  after insert on public.jobs
  for each row execute function public.notify_saved_searches();
