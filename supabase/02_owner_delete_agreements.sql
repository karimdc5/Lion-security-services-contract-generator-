-- Lets the two owners delete a signed-agreement record from the app (for test or mistaken records).
drop policy if exists "owners delete signed_agreements" on public.signed_agreements;
create policy "owners delete signed_agreements" on public.signed_agreements
  for delete to authenticated using (public.is_admin());
grant delete on public.signed_agreements to authenticated;
