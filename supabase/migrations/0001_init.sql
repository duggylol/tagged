-- ===========================================================================
-- Tagged — initial schema
--
-- Two decisions shape everything below:
--
--  1. An ITEM and its LISTINGS are separate rows. One physical garment has
--     many platform listings, each with its own external id, price and
--     lifecycle. Nearly every hard requirement in this product falls out of
--     getting that split right.
--
--  2. Nothing is hard-deleted. An item that sells moves to `sold`; a listing
--     that comes down keeps its payload snapshot so a cancelled sale is one
--     tap to relist rather than a re-entry chore.
-- ===========================================================================

create extension if not exists "uuid-ossp";
create extension if not exists vector;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

create type item_status as enum (
  'draft', 'active', 'sale_detected', 'delist_pending',
  'awaiting_confirm', 'sold', 'relisting', 'archived'
);

create type analysis_status as enum (
  'pending', 'extracting', 'resolving', 'pricing', 'writing', 'complete', 'failed'
);

create type listing_state as enum (
  'not_listed', 'publishing', 'active', 'ending', 'ended', 'sold', 'error'
);

create type platform_id as enum (
  'ebay', 'etsy', 'poshmark', 'mercari', 'depop', 'grailed', 'shopify'
);

create type connection_kind as enum ('api', 'extension');

create type capture_session_status as enum ('waiting', 'paired', 'closed', 'expired');

create type photo_role as enum ('front', 'back', 'tag', 'detail', 'defect', 'unspecified');

create type detection_source as enum ('webhook', 'poll', 'extension', 'email', 'manual');

create type command_status as enum ('queued', 'running', 'done', 'failed');

-- ---------------------------------------------------------------------------
-- Profiles
-- ---------------------------------------------------------------------------

create table profiles (
  id            uuid primary key references auth.users on delete cascade,
  display_name  text,
  -- Default target margin for the sourcing scanner, 0..1.
  target_margin numeric(4,3) not null default 0.400,
  -- Free / seller / pro. Gates listing volume and premium AI copy.
  plan          text not null default 'free',
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Items
-- ---------------------------------------------------------------------------

create table items (
  id                uuid primary key default uuid_generate_v4(),
  user_id           uuid not null references auth.users on delete cascade,
  status            item_status not null default 'draft',
  analysis_status   analysis_status not null default 'pending',
  title             text,

  -- Stage 1 model output, normalized. See packages/core ExtractedAttributes.
  attributes        jsonb,
  -- Stage 4 model output, platform-neutral. See ListingCore.
  listing_core      jsonb,
  -- Stage 3 statistics. See PriceSuggestion.
  price_suggestion  jsonb,

  cost_basis_cents  integer check (cost_basis_cents is null or cost_basis_cents >= 0),
  source_note       text,
  seller_notes      text,

  photo_paths       text[] not null default '{}',
  -- Perceptual hash of the primary photo. Catches a seller about to relist
  -- something they already sold.
  phash             text,
  -- Image embedding for internal comp lookup. Grows into the only real moat
  -- in this product, so it is populated from day one even though it is
  -- worthless in month one.
  embedding         vector(512),

  analysis_error    text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  listed_at         timestamptz,
  sold_at           timestamptz
);

create index items_user_status_idx on items (user_id, status);
create index items_user_created_idx on items (user_id, created_at desc);
create index items_phash_idx on items (user_id, phash) where phash is not null;
create index items_analysis_idx on items (analysis_status) where analysis_status not in ('complete', 'failed');

-- ---------------------------------------------------------------------------
-- Listings — one row per item per platform
-- ---------------------------------------------------------------------------

create table listings (
  id                uuid primary key default uuid_generate_v4(),
  item_id           uuid not null references items on delete cascade,
  user_id           uuid not null references auth.users on delete cascade,
  platform          platform_id not null,
  state             listing_state not null default 'not_listed',

  external_id       text,
  external_url      text,
  price_cents       integer check (price_cents is null or price_cents >= 0),

  -- The exact payload last sent to the marketplace. This is what makes
  -- one-tap relist possible after a cancelled sale.
  payload_snapshot  jsonb,

  last_error        text,
  published_at      timestamptz,
  ended_at          timestamptz,
  updated_at        timestamptz not null default now(),

  unique (item_id, platform)
);

create index listings_user_state_idx on listings (user_id, state);
create index listings_external_idx on listings (platform, external_id) where external_id is not null;

-- ---------------------------------------------------------------------------
-- Marketplace accounts
-- ---------------------------------------------------------------------------

create table marketplace_accounts (
  id                 uuid primary key default uuid_generate_v4(),
  user_id            uuid not null references auth.users on delete cascade,
  platform           platform_id not null,
  connection_kind    connection_kind not null,
  external_username  text,
  connected          boolean not null default false,

  -- Only ever populated for `api` connections. Extension platforms store no
  -- credentials at all — the extension borrows the browser's own session.
  access_token       text,
  refresh_token      text,
  token_expires_at   timestamptz,

  -- Platform-specific ids: eBay policy ids, Etsy shop id, and so on.
  meta               jsonb not null default '{}'::jsonb,
  scopes             text[] not null default '{}',
  last_seen_at       timestamptz,
  created_at         timestamptz not null default now(),

  unique (user_id, platform)
);

-- ---------------------------------------------------------------------------
-- Sync events — append-only
-- ---------------------------------------------------------------------------

-- The only way to debug "my item disappeared" three days later is to replay
-- exactly what happened. Never update or delete rows in this table.
create table sync_events (
  id               uuid primary key default uuid_generate_v4(),
  user_id          uuid not null references auth.users on delete cascade,
  item_id          uuid references items on delete cascade,
  platform         platform_id,
  kind             text not null,
  payload          jsonb not null default '{}'::jsonb,
  idempotency_key  text,
  created_at       timestamptz not null default now()
);

create index sync_events_item_idx on sync_events (item_id, created_at desc);
create index sync_events_user_idx on sync_events (user_id, created_at desc);
-- Partial unique index: the same intended effect is applied exactly once,
-- however many times a flaky network makes us retry.
create unique index sync_events_idempotency_idx
  on sync_events (idempotency_key) where idempotency_key is not null;

-- ---------------------------------------------------------------------------
-- Sales
-- ---------------------------------------------------------------------------

create table sales (
  id                uuid primary key default uuid_generate_v4(),
  item_id           uuid not null references items on delete cascade,
  user_id           uuid not null references auth.users on delete cascade,
  platform          platform_id not null,

  sale_price_cents  integer not null check (sale_price_cents >= 0),
  fees_cents        integer not null default 0,
  shipping_cents    integer not null default 0,
  cost_basis_cents  integer not null default 0,
  profit_cents      integer not null default 0,

  external_order_id text,
  detection_source  detection_source not null,
  detected_at       timestamptz not null default now(),
  -- Stays null until the seller taps confirm. Nothing is booked before that.
  confirmed_at      timestamptz,
  cancelled_at      timestamptz
);

create index sales_user_confirmed_idx on sales (user_id, confirmed_at desc nulls last);
create index sales_item_idx on sales (item_id);

-- ---------------------------------------------------------------------------
-- Comps — the long-term asset
-- ---------------------------------------------------------------------------

-- Every sale every user makes, anonymized. eBay's sold-comp API is closed to
-- new developers, so this is the substitute — and within a year it is a
-- cross-platform sold dataset for secondhand goods that nobody else has.
create table comps (
  id              uuid primary key default uuid_generate_v4(),
  -- Deliberately no user_id: this table is aggregate and readable by all
  -- authenticated users. Nothing here identifies who sold what.
  platform        platform_id not null,
  brand           text,
  category        text,
  subcategory     text,
  size_normalized text,
  condition       text,
  price_cents     integer not null check (price_cents >= 0),
  days_to_sale    integer,
  title           text,
  embedding       vector(512),
  observed_at     timestamptz not null default now()
);

create index comps_brand_idx on comps (lower(brand), lower(category));
create index comps_observed_idx on comps (observed_at desc);
-- Approximate nearest neighbour over image embeddings. Lists tuned for a
-- small table; raise as the row count grows.
create index comps_embedding_idx on comps
  using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- ---------------------------------------------------------------------------
-- Phone ↔ PC capture pairing
-- ---------------------------------------------------------------------------

create table capture_sessions (
  id               uuid primary key default uuid_generate_v4(),
  user_id          uuid not null references auth.users on delete cascade,
  -- Six characters from an unambiguous alphabet. Typed off a screen across
  -- the room, so no 0/O or 1/I/L.
  code             text not null unique check (char_length(code) = 6),
  status           capture_session_status not null default 'waiting',
  host_label       text,
  guest_label      text,
  current_item_id  uuid references items on delete set null,
  created_at       timestamptz not null default now(),
  -- A stale QR left on a monitor is a real risk. Short TTL.
  expires_at       timestamptz not null default (now() + interval '30 minutes')
);

create index capture_sessions_user_idx on capture_sessions (user_id, created_at desc);
create index capture_sessions_code_idx on capture_sessions (code) where status in ('waiting', 'paired');

create table capture_photos (
  id           uuid primary key default uuid_generate_v4(),
  session_id   uuid not null references capture_sessions on delete cascade,
  user_id      uuid not null references auth.users on delete cascade,
  item_id      uuid references items on delete set null,
  storage_path text not null,
  phash        text,
  width        integer,
  height       integer,
  sequence     integer not null default 0,
  role         photo_role not null default 'unspecified',
  created_at   timestamptz not null default now()
);

create index capture_photos_session_idx on capture_photos (session_id, sequence);

-- ---------------------------------------------------------------------------
-- Extension command queue
-- ---------------------------------------------------------------------------

create table extension_commands (
  id               uuid primary key default uuid_generate_v4(),
  user_id          uuid not null references auth.users on delete cascade,
  platform         platform_id not null,
  kind             text not null,
  payload          jsonb not null default '{}'::jsonb,
  idempotency_key  text not null,
  status           command_status not null default 'queued',
  attempts         integer not null default 0,
  result           jsonb,
  last_error       text,
  created_at       timestamptz not null default now(),
  started_at       timestamptz,
  finished_at      timestamptz,

  unique (idempotency_key)
);

create index extension_commands_pending_idx
  on extension_commands (user_id, platform, created_at)
  where status = 'queued';

-- Sold items the extension has scraped from the seller's own sold page but
-- that the server has not yet turned into a `sales` row.
create table extension_sold_reports (
  id                uuid primary key default uuid_generate_v4(),
  user_id           uuid not null references auth.users on delete cascade,
  platform          platform_id not null,
  external_id       text not null,
  external_order_id text,
  sale_price_cents  integer not null default 0,
  fees_cents        integer,
  sold_at           timestamptz not null,
  consumed_at       timestamptz,
  created_at        timestamptz not null default now(),

  unique (user_id, platform, external_id, external_order_id)
);

create index extension_sold_unconsumed_idx
  on extension_sold_reports (user_id, platform, sold_at)
  where consumed_at is null;

-- Heartbeat. The adapter refuses to queue a publish when this goes stale,
-- because a listing that silently never happens is worse than an error.
create table extension_heartbeats (
  user_id     uuid not null references auth.users on delete cascade,
  platform    platform_id not null,
  session_present boolean not null default false,
  last_seen_at timestamptz not null default now(),
  primary key (user_id, platform)
);

-- ---------------------------------------------------------------------------
-- AI usage — budget enforcement
-- ---------------------------------------------------------------------------

create table ai_usage (
  id             uuid primary key default uuid_generate_v4(),
  user_id        uuid not null references auth.users on delete cascade,
  item_id        uuid references items on delete set null,
  provider       text not null,
  model          text not null,
  operation      text not null,
  input_tokens   integer not null default 0,
  output_tokens  integer not null default 0,
  cost_usd       numeric(10,6) not null default 0,
  created_at     timestamptz not null default now()
);

create index ai_usage_user_month_idx on ai_usage (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

create or replace function touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger items_touch before update on items
  for each row execute function touch_updated_at();

create trigger listings_touch before update on listings
  for each row execute function touch_updated_at();

-- Give every new auth user a profile row so the app never has to special-case
-- "profile missing".
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ---------------------------------------------------------------------------
-- Realtime
--
-- The phone→PC flow is entirely built on this: the phone inserts a
-- capture_photos row, and the desktop sees it without polling.
-- ---------------------------------------------------------------------------

alter publication supabase_realtime add table capture_photos;
alter publication supabase_realtime add table capture_sessions;
alter publication supabase_realtime add table items;
alter publication supabase_realtime add table listings;
