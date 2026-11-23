begin;

create function idel_private.business_actor() returns uuid
language plpgsql set search_path = '' as $$
declare actor uuid := idel_private.live_member(true);
begin
  perform 1 from public.members where id = actor for share;
  if actor is null or idel_private.live_member(true) is distinct from actor then
    raise exception using errcode = '42501', message = 'Acces au planning refuse.';
  end if;
  return actor;
end;
$$;

create function idel_private.paris_today() returns date
language sql volatile set search_path = '' as $$
  select (clock_timestamp() at time zone 'Europe/Paris')::date;
$$;

create function idel_private.lock_days(p_days date[]) returns void
language plpgsql set search_path = '' as $$
declare d date;
begin
  for d in select distinct unnest(p_days) order by 1 loop
    perform pg_advisory_xact_lock(202702, d - date '2027-01-01');
  end loop;
end;
$$;

create function idel_private.proposal_days(p_id uuid) returns date[]
language sql stable set search_path = '' as $$
  select array_agg(distinct day order by day) from public.proposal_lines where proposal_id = p_id;
$$;

create function idel_private.lines_detail(p_id uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('lines',jsonb_agg(to_jsonb(l) - 'proposal_id' order by l.day,l.tour))
  from public.proposal_lines l where l.proposal_id = p_id;
$$;

create function public.create_proposal(p_tour integer,p_day date,p_after_id uuid default null,p_other_day date default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := idel_private.business_actor();
  touched date[];
  today date;
  id_new uuid;
  first_slot public.assignments;
  second_slot public.assignments;
  target uuid;
  pair uuid[];
begin
  if p_tour is null or p_tour not in (1,2) or p_day is null or p_day not between date '2027-01-01' and date '2027-06-30'
    or (p_after_id is null) = (p_other_day is null)
    or (p_other_day is not null and (p_other_day = p_day or p_other_day not between date '2027-01-01' and date '2027-06-30')) then
    raise exception using errcode = '22023', message = 'Dates ou type de demande invalides.';
  end if;
  touched := case when p_other_day is null then array[p_day] else array[least(p_day,p_other_day),greatest(p_day,p_other_day)] end;
  perform idel_private.lock_days(touched);
  actor := idel_private.business_actor();
  today := idel_private.paris_today();
  if touched[1] <= today then raise exception using errcode = '22023', message = 'Seules les dates futures sont modifiables.'; end if;
  if exists (select 1 from public.proposal_lines l join public.proposals p on p.id = l.proposal_id
      where l.day = any(touched) and l.tour = p_tour and p.status = 'pending' and p.expires_on > today) then
    raise exception using errcode = '22023', message = 'Une demande ouverte vise deja ce creneau.';
  end if;
  select * into first_slot from public.assignments where day = p_day and tour = p_tour;
  if not found then raise exception using errcode = '22023', message = 'Creneau officiel introuvable.'; end if;
  select array_agg(m.id) into pair from public.members m
    where case when p_tour = 1 then m.name in ('Linda','Julie') else m.name in ('Lucie','Fanny') end;
  target := p_after_id;
  if p_other_day is not null then
    select * into second_slot from public.assignments where day = p_other_day and tour = p_tour;
    if not found or not (first_slot.member_id = any(pair) and second_slot.member_id = any(pair)) then
      raise exception using errcode = '22023', message = 'Un echange exige deux affectations de leur binome.';
    end if;
    target := second_slot.member_id;
  end if;
  if target = first_slot.member_id or not (target = any(pair)) then
    raise exception using errcode = '22023', message = 'Choisir une personne differente du binome.';
  end if;
  if exists (select 1 from public.assignments a where a.tour <> p_tour and
      ((a.day = p_day and a.member_id = target) or (a.day = p_other_day and a.member_id = first_slot.member_id))) then
    raise exception using errcode = '22023', message = 'Une personne ne peut pas assurer les deux tournees du jour.';
  end if;
  insert into public.proposals(author_id,expires_on) values (actor,touched[1]) returning id into id_new;
  insert into public.proposal_lines values (id_new,p_day,p_tour,first_slot.member_id,target,first_slot.version);
  if p_other_day is not null then
    insert into public.proposal_lines values (id_new,p_other_day,p_tour,second_slot.member_id,first_slot.member_id,second_slot.version);
  end if;
  insert into public.audit(kind,actor_id,proposal_id,days,details)
    values ('proposal',actor,id_new,touched,idel_private.lines_detail(id_new));
  insert into public.votes(proposal_id,member_id,approve) values (id_new,actor,true);
  insert into public.audit(kind,actor_id,proposal_id,days,details)
    values ('vote',actor,id_new,touched,jsonb_build_object('approve',true));
  return id_new;
end;
$$;

create function public.cast_vote(p_proposal_id uuid,p_approve boolean) returns text
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := idel_private.business_actor();
  touched date[] := idel_private.proposal_days(p_proposal_id);
  p public.proposals;
  previous boolean;
  outcome text;
begin
  if touched is null or p_approve is null then raise exception using errcode = '22023', message = 'Demande ou vote invalide.'; end if;
  perform idel_private.lock_days(touched);
  actor := idel_private.business_actor();
  select * into p from public.proposals where id = p_proposal_id for update;
  if p.status = 'pending' and p.expires_on <= idel_private.paris_today() then
    raise exception using errcode = '22023', message = 'Demande expiree.';
  end if;
  select approve into previous from public.votes where proposal_id = p_proposal_id and member_id = actor;
  if found then
    if previous = p_approve then return p.status; end if;
    raise exception using errcode = '22023', message = 'Un vote ne peut pas etre modifie.';
  end if;
  if p.status <> 'pending' then raise exception using errcode = '22023', message = 'Demande deja fermee.'; end if;
  insert into public.votes(proposal_id,member_id,approve) values (p_proposal_id,actor,p_approve);
  insert into public.audit(kind,actor_id,proposal_id,days,details)
    values ('vote',actor,p_proposal_id,touched,jsonb_build_object('approve',p_approve));
  if not p_approve then
    outcome := 'rejected';
  elsif (select count(*) from public.votes where proposal_id = p_proposal_id and approve) < 4 then
    return 'pending';
  elsif exists (
    select 1 from public.proposal_lines l
    join public.assignments a on (a.day,a.tour) = (l.day,l.tour)
    join public.assignments other on other.day = l.day and other.tour <> l.tour
    where l.proposal_id = p_proposal_id
      and (a.version <> l.before_version or a.member_id <> l.before_id or other.member_id = l.after_id)
  ) then
    outcome := 'obsolete';
  else
    update public.assignments a set member_id = l.after_id, version = a.version + 1
      from public.proposal_lines l where l.proposal_id = p_proposal_id and (a.day,a.tour) = (l.day,l.tour);
    outcome := 'accepted';
  end if;
  update public.proposals set status = outcome where id = p_proposal_id;
  insert into public.audit(kind,actor_id,proposal_id,days,details)
    values (outcome,actor,p_proposal_id,touched,idel_private.lines_detail(p_proposal_id));
  return outcome;
end;
$$;

create function public.withdraw_proposal(p_proposal_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := idel_private.business_actor();
  touched date[] := idel_private.proposal_days(p_proposal_id);
  p public.proposals;
begin
  if touched is null then raise exception using errcode = '22023', message = 'Demande inconnue.'; end if;
  perform idel_private.lock_days(touched);
  actor := idel_private.business_actor();
  select * into p from public.proposals where id = p_proposal_id for update;
  if p.author_id <> actor then raise exception using errcode = '42501', message = 'Seul l''auteur peut retirer la demande.'; end if;
  if p.status <> 'pending' or p.expires_on <= idel_private.paris_today() then
    raise exception using errcode = '22023', message = 'Demande fermee ou expiree.';
  end if;
  update public.proposals set status = 'withdrawn' where id = p_proposal_id;
  insert into public.audit(kind,actor_id,proposal_id,days,details)
    values ('withdrawn',actor,p_proposal_id,touched,idel_private.lines_detail(p_proposal_id));
  return 'withdrawn';
end;
$$;

create function public.post_message(p_body text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := idel_private.business_actor();
  body_clean text := regexp_replace(p_body, '^[[:space:]]+|[[:space:]]+$', '', 'g');
  id_new uuid;
begin
  if body_clean is null or body_clean = '' or char_length(body_clean) > 2000 then
    raise exception using errcode = '22023', message = 'Le message doit contenir de 1 a 2000 caracteres.';
  end if;
  insert into public.messages(member_id,body) values (actor,body_clean) returning id into id_new;
  return id_new;
end;
$$;

revoke execute on function idel_private.business_actor(), idel_private.paris_today(), idel_private.lock_days(date[]),
  idel_private.proposal_days(uuid), idel_private.lines_detail(uuid) from public, anon, authenticated, service_role;
revoke execute on function public.create_proposal(integer,date,uuid,date), public.cast_vote(uuid,boolean),
  public.withdraw_proposal(uuid), public.post_message(text) from public, anon, authenticated, service_role;
grant execute on function public.create_proposal(integer,date,uuid,date), public.cast_vote(uuid,boolean),
  public.withdraw_proposal(uuid), public.post_message(text) to authenticated;

commit;
