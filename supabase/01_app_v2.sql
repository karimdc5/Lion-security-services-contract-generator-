-- =====================================================================
-- Lion Security app v2 — database update
-- Safe to run more than once. Run in Supabase → SQL Editor.
-- =====================================================================
begin;

-- 1) Owner allowlist ---------------------------------------------------
--    Only accounts listed here can read records, employee files and settings.
--    Seeded with the accounts that already exist (owners only).
create table if not exists public.app_admins (
  user_id  uuid primary key references auth.users(id) on delete cascade,
  email    text,
  added_at timestamptz not null default now()
);
alter table public.app_admins enable row level security;
insert into public.app_admins (user_id, email)
  select id, email from auth.users
  on conflict (user_id) do nothing;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.app_admins where user_id = auth.uid());
$$;
revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to anon, authenticated;

-- 2) Company settings shared across phones -------------------------------
create table if not exists public.app_settings (
  key        text primary key,
  value      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.app_settings enable row level security;
drop policy if exists "owners manage settings" on public.app_settings;
create policy "owners manage settings" on public.app_settings
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
grant select, insert, update on public.app_settings to authenticated;

-- 3) Private onboarding answers (SSN, bank, W-4, I-9) ----------------------
--    Written once through submit_employee_onboarding(); readable by owners only.
--    Nothing here is ever readable through the employee's link.
create table if not exists public.onboarding_submissions (
  link_id      text primary key references public.share_links(id) on delete cascade,
  sensitive    jsonb not null,
  submitted_at timestamptz not null default now()
);
alter table public.onboarding_submissions enable row level security;
revoke all on public.onboarding_submissions from anon;
grant select on public.onboarding_submissions to authenticated;
drop policy if exists "owners read submissions" on public.onboarding_submissions;
create policy "owners read submissions" on public.onboarding_submissions
  for select to authenticated using (public.is_admin());

create or replace function public.submit_employee_onboarding(p_link_id text, p_public jsonb, p_sensitive jsonb)
returns boolean language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  select data into v from public.share_links
   where id = p_link_id and kind = 'employee_onboarding' for update;
  if not found then raise exception 'onboarding link not found'; end if;
  if coalesce(v->>'signedAt', '') <> '' then raise exception 'already submitted'; end if;
  if octet_length(p_sensitive::text) > 200000 or octet_length(p_public::text) > 100000 then
    raise exception 'submission too large';
  end if;
  insert into public.onboarding_submissions (link_id, sensitive) values (p_link_id, p_sensitive);
  update public.share_links
     set data = coalesce(v, '{}'::jsonb) || (p_public - 'checklist' - 'label' - 'uniformCost' - 'payRate' - 'position')
   where id = p_link_id;
  return true;
end $$;
revoke all on function public.submit_employee_onboarding(text, jsonb, jsonb) from public;
grant execute on function public.submit_employee_onboarding(text, jsonb, jsonb) to anon, authenticated;

-- 4) Private storage for ID photos and bank forms ---------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('employee-docs', 'employee-docs', false, 26214400,
        array['image/jpeg','image/png','image/heic','image/heif','image/webp','application/pdf'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- A new hire can upload only into their own link's folder, and only until they submit.
create or replace function public.employee_upload_allowed(p_link_id text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.share_links
                  where id = p_link_id and kind = 'employee_onboarding' and coalesce(data->>'signedAt', '') = '');
$$;
revoke all on function public.employee_upload_allowed(text) from public;
grant execute on function public.employee_upload_allowed(text) to anon, authenticated;

drop policy if exists "new hire uploads own docs" on storage.objects;
create policy "new hire uploads own docs" on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'employee-docs' and public.employee_upload_allowed((storage.foldername(name))[1]));
drop policy if exists "owners read employee docs" on storage.objects;
create policy "owners read employee docs" on storage.objects
  for select to authenticated using (bucket_id = 'employee-docs' and public.is_admin());
drop policy if exists "owners delete employee docs" on storage.objects;
create policy "owners delete employee docs" on storage.objects
  for delete to authenticated using (bucket_id = 'employee-docs' and public.is_admin());

-- 5) Owner lock on existing tables ------------------------------------------
--    Before: any signed-in account could read everything, and anyone holding a link id
--    could delete or rewrite records. After: owners only, and links can't touch signed records.
drop policy if exists "authenticated select" on public.share_links;
drop policy if exists "authenticated update" on public.share_links;
drop policy if exists "anon insert" on public.share_links;
drop policy if exists "owners read share_links" on public.share_links;
drop policy if exists "owners create share_links" on public.share_links;
drop policy if exists "owners update share_links" on public.share_links;
create policy "owners read share_links" on public.share_links
  for select to authenticated using (public.is_admin());
create policy "owners create share_links" on public.share_links
  for insert to authenticated with check (public.is_admin());
create policy "owners update share_links" on public.share_links
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "authenticated select" on public.signed_agreements;
drop policy if exists "owners read signed_agreements" on public.signed_agreements;
create policy "owners read signed_agreements" on public.signed_agreements
  for select to authenticated using (public.is_admin());
-- (clients still record their own signature: the existing "anon can insert" policy stays)

create or replace function public.delete_share_link(link_id text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  delete from public.share_links where id = link_id;
end $$;
revoke all on function public.delete_share_link(text) from public, anon;
grant execute on function public.delete_share_link(text) to authenticated;

create or replace function public.update_share_link(link_id text, new_data jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare r record;
begin
  select kind, data into r from public.share_links where id = link_id for update;
  if not found then return; end if;
  if not public.is_admin() then
    if r.kind = 'employee_onboarding' then raise exception 'not allowed'; end if;
    if coalesce(r.data->>'sigName', '') <> '' or coalesce(r.data->>'signedName', '') <> '' then
      raise exception 'already signed';
    end if;
  end if;
  update public.share_links set data = new_data where id = link_id;
end $$;


commit;

-- Check: who is on the owner list now
select email, added_at from public.app_admins order by added_at;
