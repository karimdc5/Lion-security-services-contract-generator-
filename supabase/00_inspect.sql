-- Read-only look at the current setup. Changes nothing.
select 'table' as kind, table_name as name, '' as detail
  from information_schema.tables where table_schema = 'public'
union all
select 'column', table_name || '.' || column_name, data_type
  from information_schema.columns where table_schema = 'public' and table_name in ('share_links','signed_agreements')
union all
select 'policy', schemaname || '.' || tablename || ' :: ' || policyname,
       cmd || ' | roles=' || array_to_string(roles, ',') || ' | using=' || coalesce(qual, '-') || ' | check=' || coalesce(with_check, '-')
  from pg_policies where schemaname in ('public', 'storage')
union all
select 'rls', relname, relrowsecurity::text
  from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r'
union all
select 'function', p.proname, pg_get_function_identity_arguments(p.oid) || ' | secdef=' || p.prosecdef
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
union all
select 'bucket', id, 'public=' || public || ' | limit=' || coalesce(file_size_limit::text, '-') || ' | mime=' || coalesce(array_to_string(allowed_mime_types, ','), '-')
  from storage.buckets
union all
select 'user', email, 'confirmed=' || (email_confirmed_at is not null) || ' | last_sign_in=' || coalesce(last_sign_in_at::text, 'never')
  from auth.users
order by 1, 2;
