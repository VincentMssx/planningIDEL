begin;

alter table public.assignments alter column member_id drop not null;
alter table public.audit drop constraint audit_kind_check, add constraint audit_kind_check
  check (kind in ('import','proposal','vote','withdrawn','accepted','rejected','obsolete','claim'));

create or replace function public.import_schedule(p_rows jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare inserted integer;
begin
  perform pg_advisory_xact_lock(202701, 0);
  if exists (select 1 from public.assignments) or exists (select 1 from public.audit where kind = 'import') then
    raise exception using errcode = '22023', message = 'Planning deja importe.';
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' then raise exception using errcode = '22023', message = 'Tableau requis.'; end if;
  if jsonb_array_length(p_rows) <> 362 or (select count(*) from public.members) <> 4 then
    raise exception using errcode = '22023', message = '362 creneaux et quatre membres requis.';
  end if;
  if exists (select 1 from jsonb_array_elements(p_rows) r(item)
    where jsonb_typeof(item->'day') is distinct from 'string' or item->>'day' !~ '^2027-[0-9]{2}-[0-9]{2}$'
      or not (item ? 'name') or jsonb_typeof(item->'name') not in ('null','string')
      or jsonb_typeof(item->'tour') is distinct from 'number' or item->>'tour' not in ('1','2')) then
    raise exception using errcode = '22023', message = 'Format de creneau invalide.';
  end if;
  insert into public.assignments(day,tour,member_id)
  select r.day::date,r.tour,m.id from jsonb_to_recordset(p_rows) r(day text,tour integer,name text)
  left join public.members m on m.name = r.name where r.name is null or m.id is not null;
  get diagnostics inserted = row_count;
  if inserted <> 362 then raise exception using errcode = '22023', message = 'Membre inconnu.'; end if;
  insert into public.audit(kind,days,details)
  select 'import',array_agg(distinct day order by day),jsonb_build_object('slot_count',inserted,'unassigned',count(*) filter(where member_id is null)) from public.assignments;
  return inserted;
end;
$$;

create function public.claim_unassigned_slot(p_day date,p_tour integer) returns void
language plpgsql security definer set search_path = '' as $$
declare actor uuid := idel_private.business_actor();
begin
  perform idel_private.lock_days(array[p_day]);
  actor := idel_private.business_actor();
  if p_day <= idel_private.paris_today() or not exists (select 1 from public.members m where m.id = actor
    and ((p_tour = 1 and m.name in ('Linda','Julie')) or (p_tour = 2 and m.name in ('Lucie','Fanny')))) then
    raise exception using errcode = '22023', message = 'Date ou tournee incompatible.';
  end if;
  if exists (select 1 from public.assignments where day = p_day and tour <> p_tour and member_id = actor) then
    raise exception using errcode = '22023', message = 'Vous assurez deja une tournee ce jour.';
  end if;
  update public.assignments set member_id = actor, version = version + 1 where day = p_day and tour = p_tour and member_id is null;
  if not found then raise exception using errcode = '22023', message = 'Ce creneau n’est pas libre.'; end if;
  insert into public.audit(kind,actor_id,days,details) values ('claim',actor,array[p_day],jsonb_build_object('tour',p_tour));
end;
$$;
revoke execute on function public.claim_unassigned_slot(date,integer) from public, anon, authenticated, service_role;
grant execute on function public.claim_unassigned_slot(date,integer) to authenticated;
notify pgrst, 'reload schema';
commit;
