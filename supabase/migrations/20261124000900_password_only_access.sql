begin;

create or replace function idel_private.live_member(p_business boolean) returns uuid
language sql stable security definer set search_path = '' as $$
  select c.member_id from idel_private.credentials c
  join auth.sessions s on s.user_id = c.member_id and s.id = idel_private.current_session_id()
  join auth.users u on u.id = c.member_id and u.email = c.verified_email and u.email_confirmed_at is not null
  left join public.members m on m.id = c.member_id
  left join idel_private.operators o on o.id = c.member_id
  where c.member_id = auth.uid() and s.created_at > c.revoked_before
    and (s.not_after is null or s.not_after > statement_timestamp())
    and auth.jwt()->>'aal' in ('aal1','aal2')
    and exists (select 1 from auth.mfa_amr_claims a where a.session_id = s.id and a.authentication_method = 'password')
    and case when p_business then m.active and o.id is null and not m.must_change_password
      else (m.active and o.id is null) or (o.active and m.id is null) end;
$$;

create or replace function idel_private.operator_verified() returns boolean
language sql stable set search_path = '' as $$
  select exists (select 1 from idel_private.operators o
    join auth.sessions s on s.user_id = o.id and s.id = idel_private.current_session_id()
    where o.id = idel_private.live_member(false) and s.created_at > statement_timestamp() - interval '30 minutes');
$$;

drop function public.request_email_code();
drop function public.verify_email_code(text);
notify pgrst, 'reload schema';
commit;
