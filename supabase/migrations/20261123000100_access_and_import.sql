begin;

create schema idel_private;
revoke all on schema idel_private from public, anon, authenticated;
grant usage on schema idel_private to authenticated;

create table public.members (
  id uuid primary key references auth.users(id),
  name text not null unique check (name in ('Linda','Julie','Lucie','Fanny')),
  active boolean not null default true,
  must_change_password boolean not null default true
);
create table idel_private.credentials (
  member_id uuid primary key references public.members(id) on delete cascade,
  password_fingerprint bytea not null,
  revoked_before timestamptz not null
);
create table public.assignments (
  day date not null check (day between date '2027-01-01' and date '2027-06-30'),
  tour integer not null check (tour in (1,2)),
  member_id uuid not null references public.members(id),
  version integer not null default 1 check (version > 0),
  primary key (day,tour), unique (day,member_id)
);
create table public.proposals (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references public.members(id),
  status text not null default 'pending' check (status in ('pending','accepted','rejected','withdrawn','obsolete')),
  created_at timestamptz not null default clock_timestamp(),
  expires_on date not null
);
create table public.proposal_lines (
  proposal_id uuid not null references public.proposals(id),
  day date not null,
  tour integer not null,
  before_id uuid not null references public.members(id),
  after_id uuid not null references public.members(id),
  before_version integer not null check (before_version > 0),
  primary key (proposal_id,day,tour),
  foreign key (day,tour) references public.assignments(day,tour),
  check (before_id <> after_id)
);
create table public.votes (
  proposal_id uuid not null references public.proposals(id),
  member_id uuid not null references public.members(id),
  approve boolean not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (proposal_id,member_id)
);
create table public.audit (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('import','proposal','vote','withdrawn','accepted','rejected','obsolete')),
  actor_id uuid references public.members(id),
  proposal_id uuid references public.proposals(id),
  days date[] not null,
  details jsonb not null,
  created_at timestamptz not null default clock_timestamp()
);
create unique index one_schedule_import on public.audit (kind) where kind = 'import';
create index proposal_line_slot on public.proposal_lines (day,tour,proposal_id);
create index audit_cursor on public.audit (created_at desc,id desc);
create index audit_days on public.audit using gin (days);
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.members(id),
  body text not null check (char_length(body) <= 2000 and body ~ '[^[:space:]]'),
  created_at timestamptz not null default clock_timestamp()
);
create index message_cursor on public.messages (created_at desc,id desc);
alter table idel_private.credentials enable row level security;

create function idel_private.password_fingerprint(p_member uuid) returns bytea
language sql stable set search_path = '' as $$
  select pg_catalog.sha256(pg_catalog.convert_to(nullif(u.encrypted_password,''), 'UTF8'))
  from auth.users u where u.id = p_member;
$$;

create function idel_private.initialize_member() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.must_change_password := true;
  return new;
end;
$$;
create trigger member_password_required before insert on public.members
for each row execute function idel_private.initialize_member();

create function idel_private.record_initial_password() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into idel_private.credentials values
    (new.id, idel_private.password_fingerprint(new.id), clock_timestamp());
  return new;
end;
$$;
create trigger member_initial_password after insert on public.members
for each row execute function idel_private.record_initial_password();

create function idel_private.live_member(p_business boolean) returns uuid
language sql stable security definer set search_path = '' as $$
  select m.id from public.members m
  join idel_private.credentials c on c.member_id = m.id
  join auth.sessions s on s.user_id = m.id
    and s.id = case when (auth.jwt()->>'session_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                    then (auth.jwt()->>'session_id')::uuid end
  where m.id = auth.uid() and m.active
    and s.created_at > c.revoked_before
    and (s.not_after is null or s.not_after > statement_timestamp())
    and case when p_business then not m.must_change_password
      and auth.jwt()->>'aal' = 'aal2' and s.aal::text = 'aal2'
    else auth.jwt()->>'aal' in ('aal1','aal2')
      and (coalesce(s.aal::text,'aal1') = auth.jwt()->>'aal'
           or (s.aal::text = 'aal2' and auth.jwt()->>'aal' = 'aal1')) end;
$$;

do $$
declare t text;
begin
  foreach t in array array['members','assignments','proposals','proposal_lines','votes','audit','messages'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated, service_role', t);
    execute format('grant select on table public.%I to authenticated, service_role', t);
    execute format('create policy active_aal2 on public.%I for select to authenticated using ((select idel_private.live_member(true)) is not null)', t);
  end loop;
end;
$$;
grant insert (id,name), update (active) on public.members to service_role;

create function public.account_state() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce((select jsonb_build_object('active',true,'must_change_password',m.must_change_password)
    from public.members m where m.id = idel_private.live_member(false)),
    jsonb_build_object('active',false,'must_change_password',false));
$$;

create function public.complete_password_change() returns void
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := idel_private.live_member(false);
  fingerprint bytea;
  required boolean;
begin
  select m.must_change_password into required from public.members m where id = actor for update;
  if actor is null or idel_private.live_member(false) is distinct from actor then
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

create function public.require_password_change(p_member_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.members where id = p_member_id and not active for update;
  if not found then raise exception using errcode = '22023', message = 'Desactiver le membre avant la recuperation.'; end if;
  update idel_private.credentials set password_fingerprint = idel_private.password_fingerprint(p_member_id),
    revoked_before = clock_timestamp() where member_id = p_member_id;
  update public.members set must_change_password = true where id = p_member_id;
end;
$$;

create function public.import_schedule(p_rows jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare inserted integer;
begin
  perform pg_advisory_xact_lock(202701, 0);
  if exists (select 1 from public.assignments) or exists (select 1 from public.audit where kind = 'import') then
    raise exception using errcode = '22023', message = 'Planning deja importe.';
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'Tableau de 362 creneaux requis.';
  end if;
  if jsonb_array_length(p_rows) <> 362 or (select count(*) from public.members) <> 4 then
    raise exception using errcode = '22023', message = '362 creneaux et quatre membres requis.';
  end if;
  if exists (select 1 from jsonb_array_elements(p_rows) r(item)
    where jsonb_typeof(item->'day') is distinct from 'string'
      or item->>'day' !~ '^2027-[0-9]{2}-[0-9]{2}$'
      or jsonb_typeof(item->'name') is distinct from 'string'
      or jsonb_typeof(item->'tour') is distinct from 'number'
      or item->>'tour' not in ('1','2')) then
    raise exception using errcode = '22023', message = 'Format de creneau invalide.';
  end if;
  -- The constraints enforce coverage: 362 distinct valid keys exhaust all slots.
  insert into public.assignments(day,tour,member_id)
  select r.day::date, r.tour, m.id from jsonb_to_recordset(p_rows) r(day text,tour integer,name text)
  join public.members m on m.name = r.name;
  get diagnostics inserted = row_count;
  if inserted <> 362 then raise exception using errcode = '22023', message = 'Membre inconnu.'; end if;
  insert into public.audit(kind,days,details)
  select 'import', array_agg(days.day order by days.day), jsonb_build_object('slot_count',inserted)
  from (select distinct day from public.assignments) days;
  return inserted;
end;
$$;

revoke execute on all functions in schema idel_private from public, anon, authenticated, service_role;
grant execute on function idel_private.live_member(boolean) to authenticated;
revoke execute on function public.account_state(), public.complete_password_change(),
  public.require_password_change(uuid), public.import_schedule(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.account_state(), public.complete_password_change() to authenticated;
grant execute on function public.require_password_change(uuid), public.import_schedule(jsonb) to service_role;

commit;
