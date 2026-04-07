-- ============================================================
-- FamilyApp — Supabase Schema
-- Ejecutar 1 vez en Supabase Dashboard → SQL Editor
-- ============================================================

-- ─── TRIPS ───────────────────────────────────────────────────
create table trips (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  destination text,
  start_date  date,
  end_date    date,
  created_by  uuid references auth.users(id) on delete cascade,
  created_at  timestamptz default now()
);

-- ─── TRIP MEMBERS ────────────────────────────────────────────
create table trip_members (
  trip_id    uuid references trips(id) on delete cascade,
  user_id    uuid references auth.users(id) on delete cascade,
  role       text not null default 'member',   -- 'owner' | 'member'
  display_name text,
  joined_at  timestamptz default now(),
  primary key (trip_id, user_id)
);

-- ─── TRIP ITEMS ──────────────────────────────────────────────
create table trip_items (
  id           uuid primary key default gen_random_uuid(),
  trip_id      uuid references trips(id) on delete cascade,
  type         text not null check (type in ('flight','hotel','restaurant','activity','ticket','note')),
  title        text not null,
  date         date,
  start_time   time,
  end_time     time,
  location     text,
  notes        text,
  url          text,
  -- flight fields
  airline      text,
  flight_num   text,
  origin       text,
  destination  text,
  -- hotel fields
  check_in     date,
  check_out    date,
  -- metadata
  added_by     uuid references auth.users(id),
  created_at   timestamptz default now(),
  updated_at   timestamptz default now()
);

-- ─── CHAT MESSAGES ───────────────────────────────────────────
create table chat_messages (
  id         uuid primary key default gen_random_uuid(),
  trip_id    uuid references trips(id) on delete cascade,
  role       text not null check (role in ('user','assistant')),
  content    text not null,
  created_at timestamptz default now()
);

-- ─── INDEXES ─────────────────────────────────────────────────
create index on trip_items (trip_id, date);
create index on chat_messages (trip_id, created_at);
create index on trip_members (user_id);

-- ─── UPDATED_AT TRIGGER ──────────────────────────────────────
create or replace function update_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger trip_items_updated_at
  before update on trip_items
  for each row execute function update_updated_at();

-- ─── RLS ─────────────────────────────────────────────────────
alter table trips         enable row level security;
alter table trip_members  enable row level security;
alter table trip_items    enable row level security;
alter table chat_messages enable row level security;

-- Helper function (evita recursión infinita en políticas)
create or replace function is_trip_member(tid uuid)
returns boolean language sql security definer stable as $$
  select exists (
    select 1 from trip_members
    where trip_id = tid and user_id = auth.uid()
  );
$$;

create or replace function is_trip_owner(tid uuid)
returns boolean language sql security definer stable as $$
  select exists (
    select 1 from trips
    where id = tid and created_by = auth.uid()
  );
$$;

-- TRIPS policies
create policy "members see trips"
  on trips for select using (is_trip_member(id));

create policy "auth users create trips"
  on trips for insert with check (auth.uid() = created_by);

create policy "owner updates trip"
  on trips for update using (created_by = auth.uid());

create policy "owner deletes trip"
  on trips for delete using (created_by = auth.uid());

-- TRIP_MEMBERS policies
create policy "members see membership"
  on trip_members for select using (is_trip_member(trip_id));

create policy "owner adds members or self-join"
  on trip_members for insert with check (
    auth.uid() = user_id or is_trip_owner(trip_id)
  );

create policy "owner removes members"
  on trip_members for delete using (is_trip_owner(trip_id));

-- TRIP_ITEMS policies
create policy "members see items"
  on trip_items for select using (is_trip_member(trip_id));

create policy "members create items"
  on trip_items for insert with check (is_trip_member(trip_id));

create policy "members update items"
  on trip_items for update using (is_trip_member(trip_id));

create policy "members delete items"
  on trip_items for delete using (is_trip_member(trip_id));

-- CHAT_MESSAGES policies
create policy "members see chat"
  on chat_messages for select using (is_trip_member(trip_id));

create policy "members send chat"
  on chat_messages for insert with check (is_trip_member(trip_id));

-- ─── REALTIME ────────────────────────────────────────────────
-- En Supabase Dashboard: Realtime → Tables
-- Activar "trip_items" y "chat_messages"
-- (no se puede hacer via SQL en todos los planes)
