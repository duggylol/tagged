-- ===========================================================================
-- Row Level Security
--
-- Turned on before the first row is written, not after. Retrofitting RLS onto
-- a live schema is miserable, and this app holds other people's revenue data.
--
-- The rule everywhere except `comps` is the same: you can see and change your
-- own rows and nobody else's. `comps` is the deliberate exception — it is
-- aggregate, carries no user_id, and is readable by every authenticated user
-- because that shared pricing data is the whole point of collecting it.
-- ===========================================================================

alter table profiles                enable row level security;
alter table items                   enable row level security;
alter table listings                enable row level security;
alter table marketplace_accounts    enable row level security;
alter table sync_events             enable row level security;
alter table sales                   enable row level security;
alter table comps                   enable row level security;
alter table capture_sessions        enable row level security;
alter table capture_photos          enable row level security;
alter table extension_commands      enable row level security;
alter table extension_sold_reports  enable row level security;
alter table extension_heartbeats    enable row level security;
alter table ai_usage                enable row level security;

-- ---------------------------------------------------------------------------
-- Profiles
-- ---------------------------------------------------------------------------

create policy "own profile: read" on profiles
  for select using (auth.uid() = id);

create policy "own profile: update" on profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

-- ---------------------------------------------------------------------------
-- Owner-only tables
-- ---------------------------------------------------------------------------

create policy "own items" on items
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own listings" on listings
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own marketplace accounts" on marketplace_accounts
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own sales" on sales
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own capture sessions" on capture_sessions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own capture photos" on capture_photos
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own extension commands" on extension_commands
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own extension sold reports" on extension_sold_reports
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own extension heartbeats" on extension_heartbeats
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Append-only tables
--
-- Insert and read your own; no update, no delete, for anyone. The audit trail
-- is worthless if it can be rewritten.
-- ---------------------------------------------------------------------------

create policy "own sync events: read" on sync_events
  for select using (auth.uid() = user_id);

create policy "own sync events: insert" on sync_events
  for insert with check (auth.uid() = user_id);

create policy "own ai usage: read" on ai_usage
  for select using (auth.uid() = user_id);

create policy "own ai usage: insert" on ai_usage
  for insert with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Comps — shared, anonymous
-- ---------------------------------------------------------------------------

-- Every authenticated user reads the pooled pricing data. Nobody writes to it
-- directly; rows are inserted server-side by the service role when a sale is
-- confirmed, stripped of anything identifying.
create policy "comps: read for authenticated" on comps
  for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- Storage
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'item-photos',
  'item-photos',
  false,
  10485760, -- 10 MB; photos are compressed to WebP on-device long before this
  array['image/webp', 'image/jpeg', 'image/png']
)
on conflict (id) do nothing;

-- Photos live under {user_id}/… so the first path segment is the owner check.
create policy "own photos: read" on storage.objects
  for select using (
    bucket_id = 'item-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "own photos: insert" on storage.objects
  for insert with check (
    bucket_id = 'item-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "own photos: update" on storage.objects
  for update using (
    bucket_id = 'item-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "own photos: delete" on storage.objects
  for delete using (
    bucket_id = 'item-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ---------------------------------------------------------------------------
-- Helper: month-to-date AI spend, for budget enforcement
-- ---------------------------------------------------------------------------

create or replace function ai_spend_this_month(p_user_id uuid)
returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(sum(cost_usd), 0)
  from ai_usage
  where user_id = p_user_id
    and created_at >= date_trunc('month', now());
$$;

-- ---------------------------------------------------------------------------
-- Helper: claim the next extension command atomically
--
-- FOR UPDATE SKIP LOCKED means two browser tabs polling at once cannot both
-- pick up the same command and publish the listing twice.
-- ---------------------------------------------------------------------------

create or replace function claim_extension_commands(
  p_user_id uuid,
  p_platforms platform_id[],
  p_limit integer default 5
)
returns setof extension_commands
language plpgsql security definer set search_path = public as $$
begin
  return query
  with claimed as (
    select id from extension_commands
    where user_id = p_user_id
      and platform = any(p_platforms)
      and status = 'queued'
    order by created_at
    limit p_limit
    for update skip locked
  )
  update extension_commands c
  set status = 'running', started_at = now(), attempts = c.attempts + 1
  from claimed
  where c.id = claimed.id
  returning c.*;
end;
$$;
