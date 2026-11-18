-- RigRoute shared data: driver reports and tester feedback.
-- The app uses the public (publishable/anon) key, so everything below is locked down with row level security.

create table if not exists public.reports (
  id text primary key check (char_length(id) between 4 and 40),
  type text not null check (type in ('crash','hazard','animal','closure','flood','roadworks','police','weighbridge','clearance','surface','fire')),
  lon double precision not null check (lon between 112 and 155),
  lat double precision not null check (lat between -45 and -9),
  note text not null default '' check (char_length(note) <= 80),
  side text not null default '' check (side in ('','mine','other')),
  created timestamptz not null default now(),
  expires timestamptz not null,
  up int not null default 0,
  down int not null default 0,
  device text not null check (char_length(device) between 8 and 64)
);
create index if not exists reports_active on public.reports (expires);
alter table public.reports enable row level security;

-- anyone with the app can read live reports (but not which device made them)
drop policy if exists "read live reports" on public.reports;
create policy "read live reports" on public.reports for select to anon, authenticated using (expires > now() and down < 3);
revoke select on public.reports from anon, authenticated;
grant select (id, type, lon, lat, note, side, created, expires, up, down) on public.reports to anon, authenticated;

-- anyone with the app can add a report, within sensible limits
drop policy if exists "add reports" on public.reports;
create policy "add reports" on public.reports for insert to anon, authenticated
  with check (up = 0 and down = 0 and expires > now() and expires <= now() + interval '31 days' and created <= now() + interval '5 minutes');
grant insert on public.reports to anon, authenticated;

-- at most 20 reports per device per hour
create or replace function public.limit_reports() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from reports where device = new.device and created > now() - interval '1 hour') >= 20 then
    raise exception 'Too many reports from this device. Try again later.';
  end if;
  new.created := now();
  return new;
end $$;
drop trigger if exists reports_limit on public.reports;
create trigger reports_limit before insert on public.reports for each row execute function public.limit_reports();

-- "Still there?" votes: yes extends the report, three "gone" votes hide it
create or replace function public.vote_report(rid text, still boolean) returns void language sql security definer set search_path = public as $$
  update reports set
    up = up + (case when still then 1 else 0 end),
    down = down + (case when still then 0 else 1 end),
    expires = case when still then greatest(expires, now() + interval '1 hour') else expires end
  where id = rid and expires > now();
$$;
-- delete your own report (matched on the device that made it)
create or replace function public.delete_report(rid text, dev text) returns void language sql security definer set search_path = public as $$
  delete from reports where id = rid and device = dev;
$$;
revoke all on function public.vote_report(text, boolean) from public;
revoke all on function public.delete_report(text, text) from public;
grant execute on function public.vote_report(text, boolean) to anon, authenticated;
grant execute on function public.delete_report(text, text) to anon, authenticated;

-- tester feedback: the app can only add; only you can read it (Table Editor in the dashboard)
create table if not exists public.feedback (
  id bigint generated always as identity primary key,
  created timestamptz not null default now(),
  kind text not null default 'other' check (kind in ('route','turn','stop','alert','app','other')),
  message text not null check (char_length(message) between 1 and 1000),
  lon double precision, lat double precision,
  context jsonb not null default '{}'::jsonb check (pg_column_size(context) < 20000),
  device text check (char_length(device) <= 64)
);
alter table public.feedback enable row level security;
drop policy if exists "send feedback" on public.feedback;
create policy "send feedback" on public.feedback for insert to anon, authenticated with check (true);
revoke all on public.feedback from anon, authenticated;
grant insert on public.feedback to anon, authenticated;
