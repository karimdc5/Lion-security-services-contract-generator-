-- =====================================================================
-- Lion Security app — saved proposals
-- Safe to run more than once. Run in Supabase → SQL Editor after 01_app_v2.sql
-- (needs public.is_admin() and public.share_links).
-- Owners only: no anon/public access to proposals.
-- =====================================================================
begin;

create table if not exists public.proposals (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid default auth.uid() references auth.users(id) on delete set null,
  status        text not null default 'draft' check (status in ('draft','sent','accepted','converted')),
  client        text,
  contact       text,
  site          text,
  property_type text,
  heard         text,
  services      text[] not null default '{}',
  days          text,
  hours         text,
  frequency     text,
  start_date    date,
  rate          numeric,
  monthly_hours numeric,
  term          text,
  billing       text,
  proposal_date date,
  valid_until   date,
  agreement_id  text references public.share_links(id) on delete set null,
  converted_at  timestamptz
);

create index if not exists proposals_updated_at_idx on public.proposals (updated_at desc);

-- Keep updated_at current on every edit
create or replace function public.proposals_touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists proposals_touch_updated_at on public.proposals;
create trigger proposals_touch_updated_at
  before update on public.proposals
  for each row execute function public.proposals_touch_updated_at();

-- Owners only
alter table public.proposals enable row level security;
revoke all on public.proposals from anon;
grant select, insert, update, delete on public.proposals to authenticated;

drop policy if exists "owners manage proposals" on public.proposals;
create policy "owners manage proposals" on public.proposals
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

commit;

-- Check: policies on proposals
select policyname, cmd, roles from pg_policies where schemaname = 'public' and tablename = 'proposals';
