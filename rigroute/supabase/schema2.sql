-- RigRoute: saved sites (shared between testers) and ETA shares (private links).

-- ---------- saved sites ----------
create table if not exists public.sites (
  id text primary key check (char_length(id) between 4 and 40),
  name text not null check (char_length(name) between 1 and 80),
  kind text not null default 'customer' check (kind in ('depot','customer','fuel','parking','other')),
  lon double precision not null check (lon between 112 and 155),
  lat double precision not null check (lat between -45 and -9),
  notes text not null default '' check (char_length(notes) <= 600),
  device text not null check (char_length(device) between 8 and 64),
  created timestamptz not null default now(),
  updated timestamptz not null default now()
);
alter table public.sites enable row level security;
drop policy if exists "read sites" on public.sites;
create policy "read sites" on public.sites for select to anon, authenticated using (true);
revoke select on public.sites from anon, authenticated;
grant select (id, name, kind, lon, lat, notes, created, updated) on public.sites to anon, authenticated;
drop policy if exists "add sites" on public.sites;
create policy "add sites" on public.sites for insert to anon, authenticated with check (true);
grant insert on public.sites to anon, authenticated;

create or replace function public.limit_sites() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from sites where device = new.device and created > now() - interval '1 hour') >= 30 then
    raise exception 'Too many sites added from this device. Try again later.';
  end if;
  new.created := now(); new.updated := now();
  return new;
end $$;
drop trigger if exists sites_limit on public.sites;
create trigger sites_limit before insert on public.sites for each row execute function public.limit_sites();

-- only the device that added a site can change or remove it
create or replace function public.update_site(sid text, dev text, nm text, kd text, nt text) returns void language sql security definer set search_path = public as $$
  update sites set name = left(nm, 80), kind = kd, notes = left(nt, 600), updated = now() where id = sid and device = dev;
$$;
create or replace function public.delete_site(sid text, dev text) returns void language sql security definer set search_path = public as $$
  delete from sites where id = sid and device = dev;
$$;
revoke all on function public.update_site(text, text, text, text, text) from public;
revoke all on function public.delete_site(text, text) from public;
grant execute on function public.update_site(text, text, text, text, text) to anon, authenticated;
grant execute on function public.delete_site(text, text) to anon, authenticated;

-- ---------- ETA shares (readable only by someone who has the link's token) ----------
create table if not exists public.shares (
  token text primary key check (char_length(token) between 16 and 40),
  dest text not null default '' check (char_length(dest) <= 120),
  dest_lon double precision, dest_lat double precision,
  vehicle text not null default '' check (char_length(vehicle) <= 60),
  lon double precision, lat double precision,
  eta timestamptz,
  status text not null default 'driving' check (status in ('driving','arrived','ended')),
  created timestamptz not null default now(),
  updated timestamptz not null default now(),
  expires timestamptz not null check (expires <= now() + interval '13 hours')
);
alter table public.shares enable row level security;
-- no select policy: shares can't be listed; they're read through get_share() with the token
drop policy if exists "start share" on public.shares;
create policy "start share" on public.shares for insert to anon, authenticated with check (expires > now());
revoke all on public.shares from anon, authenticated;
grant insert on public.shares to anon, authenticated;

create or replace function public.update_share(tk text, lo double precision, la double precision, et timestamptz, st text) returns void language sql security definer set search_path = public as $$
  update shares set lon = coalesce(lo, lon), lat = coalesce(la, lat), eta = coalesce(et, eta), status = st, updated = now()
  where token = tk and expires > now();
$$;
create or replace function public.get_share(tk text) returns table (dest text, dest_lon double precision, dest_lat double precision, vehicle text, lon double precision, lat double precision, eta timestamptz, status text, updated timestamptz)
language sql security definer set search_path = public as $$
  select dest, dest_lon, dest_lat, vehicle, lon, lat, eta, case when expires < now() then 'ended' else status end, updated from shares where token = tk;
$$;
revoke all on function public.update_share(text, double precision, double precision, timestamptz, text) from public;
revoke all on function public.get_share(text) from public;
grant execute on function public.update_share(text, double precision, double precision, timestamptz, text) to anon, authenticated;
grant execute on function public.get_share(text) to anon, authenticated;
