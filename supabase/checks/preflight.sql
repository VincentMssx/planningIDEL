-- Run in the hosted SQL Editor as the project owner, after migrations.
-- Read-only. No secret values, addresses or identifiers appear in the output.
select * from (values
  ('API tables enforce RLS', not exists (
    select 1 from unnest(array['members','assignments','proposals','proposal_lines','votes','messages','audit']) t(name)
    where not exists (select 1 from pg_class c where c.oid = to_regclass('public.' || t.name) and c.relrowsecurity))),
  ('No client DML on business tables', not exists (
    select 1 from unnest(array['anon','authenticated']) r(name)
    cross join unnest(array['members','assignments','proposals','proposal_lines','votes','messages','audit']) t(name)
    where has_any_column_privilege(r.name,'public.' || t.name,'INSERT,UPDATE')
       or has_table_privilege(r.name,'public.' || t.name,'DELETE,TRUNCATE'))),
  ('Grouped history respects invoker RLS', exists (select 1 from pg_class where oid = to_regclass('public.grouped_history')
    and reloptions @> array['security_invoker=true'])),
  ('Retired contacts RPCs absent', to_regprocedure('public.read_colleague_contacts()') is null
    and to_regprocedure('public.save_colleague_contacts(text,text,text)') is null),
  ('Operator provisioning not granted to clients', not has_function_privilege('authenticated','public.provision_operator(uuid)','EXECUTE')
    and not has_function_privilege('anon','public.provision_operator(uuid)','EXECUTE')),
  ('TOTP pairing restricted to the project owner or service role',
    not has_function_privilege('authenticated','public.approve_operator_totp(uuid,uuid)','EXECUTE')
    and not has_function_privilege('anon','public.approve_operator_totp(uuid,uuid)','EXECUTE')),
  ('Chat requires authenticated team access', has_function_privilege('authenticated','public.post_message(text)','EXECUTE')
    and not has_function_privilege('anon','public.post_message(text)','EXECUTE')
    and has_table_privilege('authenticated','public.messages','SELECT')
    and not has_table_privilege('anon','public.messages','SELECT')
    and exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'messages' and policyname = 'active_team_chat')),
  ('Refusal history has no free-text reason', not exists (select 1 from public.audit where details ? 'reason')
    and not has_table_privilege('authenticated','idel_private.retired_audit_reasons','SELECT')),
  ('HTTP and pgcrypto installed in extensions', (select count(*) = 2 from pg_extension
    where extname in ('http','pgcrypto') and extnamespace = 'extensions'::regnamespace)),
  ('Email challenge RPCs retired', to_regprocedure('public.request_email_code()') is null
    and to_regprocedure('public.verify_email_code(text)') is null),
  ('Four confirmed IDEL accounts linked', (select count(*) = 4 from public.members m join auth.users u on u.id = m.id
    join idel_private.credentials c on c.member_id = u.id and c.verified_email = u.email where u.email_confirmed_at is not null)),
  ('Active separate operator provisioned', exists (select 1 from idel_private.operators o join auth.users u on u.id = o.id
    join idel_private.credentials c on c.member_id = u.id and c.verified_email = u.email
    where o.active and u.email_confirmed_at is not null and not exists (select 1 from public.members m where m.id = o.id))),
  ('Active operators have a verified TOTP factor approved', exists (select 1 from idel_private.operators where active)
    and not exists (select 1 from idel_private.operators o where o.active and not exists (
      select 1 from auth.mfa_factors f where f.id = o.totp_factor_id and f.user_id = o.id
        and f.factor_type = 'totp' and f.status = 'verified'))),
  ('Semester imported', (select count(*) = 362 from public.assignments) and exists (select 1 from public.audit where kind = 'import'))
) as checks(check_name, passed);
