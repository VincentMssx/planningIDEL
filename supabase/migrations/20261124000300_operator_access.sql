begin;

create table idel_private.operators (
  id uuid primary key references auth.users(id) on delete cascade,
  active boolean not null default true
);
create table idel_private.operator_audit (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null,
  member_id uuid not null references public.members(id),
  active boolean not null,
  created_at timestamptz not null default clock_timestamp()
);
alter table idel_private.operators enable row level security;
alter table idel_private.operator_audit enable row level security;
revoke all on table idel_private.operators, idel_private.operator_audit from public, anon, authenticated, service_role;

-- The mail challenge store is shared, but an operator is never a planning member.
alter table idel_private.credentials drop constraint credentials_member_id_fkey,
  add constraint credentials_auth_user_fkey foreign key (member_id) references auth.users(id) on delete cascade;

create or replace function idel_private.live_member(p_business boolean) returns uuid
language sql stable security definer set search_path = '' as $$
  select c.member_id from idel_private.credentials c
  join auth.sessions s on s.user_id = c.member_id and s.id = idel_private.current_session_id()
  join auth.users u on u.id = c.member_id and u.email = c.verified_email and u.email_confirmed_at is not null
  left join public.members m on m.id = c.member_id
  left join idel_private.operators o on o.id = c.member_id
  where c.member_id = auth.uid()
    and s.created_at > c.revoked_before
    and (s.not_after is null or s.not_after > statement_timestamp())
    and auth.jwt()->>'aal' in ('aal1','aal2')
    and exists (select 1 from auth.mfa_amr_claims a where a.session_id = s.id and a.authentication_method = 'password')
    and case when p_business then m.active and o.id is null and not m.must_change_password and exists (
      select 1 from idel_private.email_verified_sessions v where v.session_id = s.id and v.valid_until > statement_timestamp()
    ) else (m.active and o.id is null) or (o.active and m.id is null) end;
$$;

create function idel_private.operator_verified() returns boolean
language sql stable set search_path = '' as $$
  select exists (select 1 from idel_private.operators o
    join idel_private.email_verified_sessions v on v.session_id = idel_private.current_session_id()
    where o.id = idel_private.live_member(false)
      -- Mail verification has a 12-hour member lifetime; operators use only the first 30 minutes.
      and v.valid_until > statement_timestamp() + interval '11 hours 30 minutes');
$$;

create or replace function public.account_state() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select jsonb_build_object('active',true,'must_change_password',m.must_change_password)
      from public.members m where m.id = idel_private.live_member(false)),
    (select jsonb_build_object('active',true,'must_change_password',false,'operator',true,'verified',idel_private.operator_verified())
      from idel_private.operators o where o.id = idel_private.live_member(false)),
    jsonb_build_object('active',false,'must_change_password',false));
$$;

create or replace function public.complete_password_change() returns void
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := idel_private.live_member(false);
  fingerprint bytea;
  required boolean;
begin
  select m.must_change_password into required from public.members m where id = actor for update;
  if not found or idel_private.live_member(false) is distinct from actor then
    raise exception using errcode = '42501', message = 'Compte inaccessible.';
  end if;
  if not required then return; end if;
  fingerprint := idel_private.password_fingerprint(actor);
  if fingerprint is null or fingerprint = (select c.password_fingerprint from idel_private.credentials c where c.member_id = actor) then
    raise exception using errcode = '22023', message = 'Le changement de mot de passe n''est pas confirme.';
  end if;
  update idel_private.credentials set password_fingerprint = fingerprint where member_id = actor;
  update public.members set must_change_password = false where id = actor;
end;
$$;

create function public.provision_operator(p_user_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.members where id = p_user_id) then
    raise exception using errcode = '22023', message = 'Un compte IDEL ne peut pas devenir operateur.';
  end if;
  insert into idel_private.credentials(member_id,password_fingerprint,revoked_before,verified_email)
  select u.id, idel_private.password_fingerprint(u.id), clock_timestamp(), u.email
  from auth.users u where u.id = p_user_id and u.email_confirmed_at is not null and u.email <> ''
    and u.encrypted_password <> '' and not u.is_anonymous;
  if not found then raise exception using errcode = '22023', message = 'Compte Auth nominatif confirme requis.'; end if;
  insert into idel_private.operators(id) values (p_user_id);
end;
$$;

create function idel_private.require_operator() returns uuid
language plpgsql set search_path = '' as $$
declare actor uuid := idel_private.live_member(false);
begin
  perform 1 from idel_private.operators where id = actor and active for share;
  if not found or not idel_private.operator_verified() then
    raise exception using errcode = '42501', message = 'Acces operateur refuse.';
  end if;
  return actor;
end;
$$;

create function public.admin_overview() returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform idel_private.require_operator();
  return jsonb_build_object(
    'members', (select coalesce(jsonb_agg(jsonb_build_object('id',m.id,'name',m.name,'active',m.active,
      'must_change_password',m.must_change_password) order by m.name), '[]'::jsonb) from public.members m),
    'history', (select coalesce(jsonb_agg(jsonb_build_object('id',a.id,'name',m.name,'active',a.active,
      'created_at',a.created_at) order by a.created_at desc,a.id desc), '[]'::jsonb)
      from (select * from idel_private.operator_audit order by created_at desc,id desc limit 20) a
      join public.members m on m.id = a.member_id)
  );
end;
$$;

create function public.admin_set_member_active(p_member_id uuid, p_active boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := idel_private.require_operator();
  previous boolean;
begin
  if p_active is null then raise exception using errcode = '22023', message = 'Etat requis.'; end if;
  select active into previous from public.members where id = p_member_id for update;
  if not found then raise exception using errcode = '22023', message = 'Compte IDEL introuvable.'; end if;
  actor := idel_private.require_operator();
  if p_active = previous then return; end if;
  update idel_private.credentials set revoked_before = clock_timestamp() where member_id = p_member_id;
  delete from idel_private.email_challenges where member_id = p_member_id;
  update public.members set active = p_active where id = p_member_id;
  insert into idel_private.operator_audit(operator_id,member_id,active) values (actor,p_member_id,p_active);
end;
$$;

revoke execute on function idel_private.operator_verified(), idel_private.require_operator(), public.provision_operator(uuid),
  public.admin_overview(), public.admin_set_member_active(uuid,boolean) from public, anon, authenticated, service_role;
grant execute on function public.provision_operator(uuid) to service_role;
grant execute on function public.admin_overview(), public.admin_set_member_active(uuid,boolean) to authenticated;

commit;
