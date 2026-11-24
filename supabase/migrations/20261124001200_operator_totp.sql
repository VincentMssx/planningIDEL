begin;

alter table idel_private.operators add column totp_factor_id uuid;

create function idel_private.operator_session_fresh() returns boolean
language sql stable set search_path = '' as $$
  select exists (select 1 from auth.sessions s where s.id = idel_private.current_session_id()
    and s.user_id = idel_private.live_member(false)
    and s.created_at > statement_timestamp() - interval '30 minutes');
$$;

create or replace function idel_private.operator_verified() returns boolean
language sql stable set search_path = '' as $$
  select idel_private.operator_session_fresh() and coalesce(auth.jwt()->>'aal' = 'aal2',false)
    and exists (select 1 from idel_private.operators o
      join auth.sessions s on s.user_id = o.id and s.id = idel_private.current_session_id()
      join auth.mfa_factors f on f.id = o.totp_factor_id and f.user_id = o.id and f.id = s.factor_id
      where o.id = idel_private.live_member(false) and s.aal = 'aal2'
        and f.factor_type = 'totp' and f.status = 'verified');
$$;

create or replace function public.account_state() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select jsonb_build_object('active',true,'must_change_password',m.must_change_password)
      from public.members m where m.id = idel_private.live_member(false)),
    (select jsonb_build_object('active',true,'must_change_password',false,'operator',true,
      'verified',idel_private.operator_verified(),'operator_session_fresh',idel_private.operator_session_fresh(),
      'operator_factor_id',o.totp_factor_id)
      from idel_private.operators o where o.id = idel_private.live_member(false)),
    jsonb_build_object('active',false,'must_change_password',false));
$$;

-- The operator cannot approve their own pairing using only a password. The project
-- owner matches the factor ID to the operator out of band before granting access.
create function public.approve_operator_totp(p_operator_id uuid,p_factor_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare previous uuid;
begin
  select totp_factor_id into previous from idel_private.operators where id = p_operator_id and active for update;
  if not found then raise exception using errcode = '22023', message = 'Operateur actif introuvable.'; end if;
  if p_factor_id is not null and not exists (select 1 from auth.mfa_factors where id = p_factor_id
    and user_id = p_operator_id and factor_type = 'totp' and status = 'verified') then
    raise exception using errcode = '22023', message = 'Facteur TOTP verifie requis.';
  end if;
  if previous is not distinct from p_factor_id then return; end if;
  update idel_private.operators set totp_factor_id = p_factor_id where id = p_operator_id;
  update idel_private.credentials set revoked_before = clock_timestamp() where member_id = p_operator_id;
  delete from auth.sessions where user_id = p_operator_id;
end;
$$;

revoke execute on function idel_private.operator_session_fresh(), public.approve_operator_totp(uuid,uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.approve_operator_totp(uuid,uuid) to service_role;

notify pgrst, 'reload schema';
commit;
