-- =====================================================================
-- 04 — Signing & storage hardening (applied via Supabase migration "04_hardening")
-- Safe to run more than once.
-- =====================================================================

-- 1) Audit-trail columns on the permanent signed record -------------------
alter table public.signed_agreements
  add column if not exists link_id      text,
  add column if not exists signer_title text,
  add column if not exists signer_ip    text,
  add column if not exists user_agent   text,
  add column if not exists data_sha256  text,
  add column if not exists signed_data  jsonb;
create unique index if not exists signed_agreements_link_id_key
  on public.signed_agreements(link_id) where link_id is not null;

-- 2) No more direct inserts from the browser ------------------------------
drop policy if exists "anon can insert" on public.signed_agreements;
revoke insert, update, truncate, references, trigger on public.signed_agreements from anon, authenticated;
revoke select, delete on public.signed_agreements from anon;

-- 3) The one way a client signs: terms come from the stored link, never the browser
create or replace function public.sign_agreement(
  p_link_id   text,
  p_signer_name  text,
  p_signer_title text default null,
  p_signature    text default null,   -- optional drawn-signature data URL
  p_page_url     text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_data jsonb; v_kind text; v_hdr jsonb; v_ip text; v_ua text; v_hash text;
  v_now timestamptz := now(); v_name text := btrim(coalesce(p_signer_name,''));
  v_title text := nullif(btrim(coalesce(p_signer_title,'')),''); v_link text;
begin
  select kind, data into v_kind, v_data from public.share_links where id = p_link_id for update;
  if not found or v_kind <> 'agreement' then raise exception 'agreement link not found'; end if;
  if coalesce(v_data->>'sigName','') <> '' or coalesce(v_data->>'signedName','') <> ''
     or exists (select 1 from public.signed_agreements where link_id = p_link_id) then
    raise exception 'already signed';
  end if;
  if length(v_name) < 2 or length(v_name) > 200 then raise exception 'invalid signer name'; end if;
  if v_title is not null and length(v_title) > 200 then raise exception 'invalid title'; end if;
  if p_signature is not null and (length(p_signature) > 300000 or p_signature !~ '^data:image/(png|jpeg|svg\+xml);base64,') then
    raise exception 'invalid signature image';
  end if;

  begin v_hdr := nullif(current_setting('request.headers', true), '')::jsonb; exception when others then v_hdr := null; end;
  v_ip := nullif(btrim(split_part(coalesce(v_hdr->>'x-forwarded-for', v_hdr->>'cf-connecting-ip', v_hdr->>'x-real-ip', ''), ',', 1)), '');
  v_ua := left(v_hdr->>'user-agent', 400);
  -- hash of the exact stored agreement JSON being signed (before signature fields are added)
  v_hash := encode(sha256(convert_to(v_data::text, 'UTF8')), 'hex');

  v_link := case when p_page_url ~ '^https://(karimdc5\.github\.io|lionofseattle\.com|www\.lionofseattle\.com|raw\.githack\.com)/[^ ]*$'
                   or p_page_url ~ '^http://127\.0\.0\.1:[0-9]+/[^ ]*$'
                 then split_part(p_page_url, '#', 1) || '#id=' || p_link_id
                 else '#id=' || p_link_id end;

  insert into public.signed_agreements
    (link_id, agreement_no, org, client_name, signer_name, signer_title, amount, signed_at, link,
     signer_ip, user_agent, data_sha256, signed_data)
  values
    (p_link_id, v_data->>'agrNo', v_data->>'org', v_data->>'clientName', v_name, v_title,
     coalesce(v_data->>'total', v_data->>'_total'), v_now, v_link, v_ip, v_ua, v_hash, v_data);

  update public.share_links
     set data = v_data || jsonb_strip_nulls(jsonb_build_object(
           'sigName', v_name, 'sigTitle', v_title, 'sigAt', to_jsonb(v_now),
           'sigImage', p_signature, 'sigIp', v_ip, 'sigUa', v_ua, 'sigHash', v_hash))
   where id = p_link_id;

  return jsonb_strip_nulls(jsonb_build_object('signed_at', v_now, 'signer_ip', v_ip, 'user_agent', v_ua, 'sha256', v_hash));
end $$;
revoke all on function public.sign_agreement(text, text, text, text, text) from public;
grant execute on function public.sign_agreement(text, text, text, text, text) to anon, authenticated;

-- 4) update_share_link: clients can no longer rewrite agreements -----------
create or replace function public.update_share_link(link_id text, new_data jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare r record;
begin
  select kind, data into r from public.share_links where id = link_id for update;
  if not found then return; end if;
  if not public.is_admin() then
    if r.kind in ('employee_onboarding', 'agreement') then raise exception 'not allowed'; end if;
    if coalesce(r.data->>'sigName', '') <> '' or coalesce(r.data->>'signedName', '') <> '' then
      raise exception 'already signed';
    end if;
  else
    -- even owners can't alter an agreement once it is signed
    if r.kind = 'agreement' and coalesce(r.data->>'sigName','') <> '' then raise exception 'already signed'; end if;
  end if;
  update public.share_links set data = new_data where id = link_id;
end $$;

-- 5) contractor-docs bucket: owners read; uploads only into a real contractor link's folder
create or replace function public.contractor_upload_allowed(p_link_id text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.share_links where id = p_link_id and kind = 'contractor_onboarding');
$$;
revoke all on function public.contractor_upload_allowed(text) from public;
grant execute on function public.contractor_upload_allowed(text) to anon, authenticated;

drop policy if exists "only logged-in staff can read contractor docs" on storage.objects;
drop policy if exists "owners read contractor docs" on storage.objects;
create policy "owners read contractor docs" on storage.objects
  for select to authenticated using (bucket_id = 'contractor-docs' and public.is_admin());
drop policy if exists "anon can upload contractor docs" on storage.objects;
drop policy if exists "contractor uploads own docs" on storage.objects;
create policy "contractor uploads own docs" on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'contractor-docs' and public.contractor_upload_allowed((storage.foldername(name))[1]));
drop policy if exists "owners delete contractor docs" on storage.objects;
create policy "owners delete contractor docs" on storage.objects
  for delete to authenticated using (bucket_id = 'contractor-docs' and public.is_admin());

-- 6) Agreement numbering is owner-side only --------------------------------
revoke execute on function public.advance_agreement_seq(text) from public, anon;
revoke execute on function public.peek_agreement_seq(text) from public, anon;
grant execute on function public.advance_agreement_seq(text) to authenticated;
grant execute on function public.peek_agreement_seq(text) to authenticated;
