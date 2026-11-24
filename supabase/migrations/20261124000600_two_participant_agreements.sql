begin;

-- Acquire the existing day locks before touching messages (a refusal also locks days first).
select idel_private.lock_days(array(select date '2027-01-01' + i from generate_series(0,180) as g(i)));

-- A proposal changes at most one tour per day. Link to an actual affected day.
alter table public.proposal_lines add unique (proposal_id,day);
alter table public.messages
  add column proposal_id uuid,
  add column proposal_day date,
  add foreign key (proposal_id,proposal_day) references public.proposal_lines(proposal_id,day) match full;

-- Historical refusals posted the message in the same transaction as the rejection audit.
-- Require that evidence, the exact old header, author, and a unique match in both directions.
-- Restored or otherwise unverifiable rows may deliberately remain unlinked.
with rejected as (
  select a.id, a.proposal_id, a.actor_id, a.created_at, a.xmin::text as origin,
    min(l.day) as day,
    string_agg(to_char(l.day,'DD/MM/YYYY') || ' (Tournée ' || l.tour || ')', ', ' order by l.day,l.tour) as current_label,
    string_agg(to_char(l.day,'DD/MM/YYYY') || ' (T' || l.tour || ')', ', ' order by l.day,l.tour) as old_label
  from public.audit a
  join public.proposals p on p.id = a.proposal_id and p.status = 'rejected'
  join public.proposal_lines l on l.proposal_id = p.id
  where a.kind = 'rejected' and a.xmin::text::bigint > 2
  group by a.id, a.xmin::text
), candidates as (
  select m.id, r.proposal_id, r.day,
    count(*) over (partition by m.id) as message_matches,
    count(*) over (partition by r.proposal_id) as proposal_matches
  from rejected r
  join public.messages m on m.member_id = r.actor_id and m.xmin::text = r.origin
    and m.created_at >= r.created_at
  cross join lateral (values ('Demande refusée · ' || r.current_label || E'\nMotif : '),
                             ('Demande refusée · ' || r.old_label || E'\nMotif : ')) h(prefix)
  where starts_with(m.body,h.prefix)
    and substring(m.body from char_length(h.prefix) + 1) ~ '[^[:space:]]'
    and char_length(m.body) <= char_length(h.prefix) + 500
)
update public.messages m set proposal_id = c.proposal_id, proposal_day = c.day
from candidates c where m.id = c.id and c.message_matches = 1 and c.proposal_matches = 1;

create or replace function public.create_proposal(p_tour integer,p_day date,p_after_id uuid default null,p_other_day date default null) returns uuid
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
    if not found or (first_slot.member_id = any(pair) and second_slot.member_id = any(pair)) is not true then
      raise exception using errcode = '22023', message = 'Un echange exige deux affectations de leur binome.';
    end if;
    target := second_slot.member_id;
  end if;
  if target = first_slot.member_id or (target = any(pair)) is not true then
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
  return id_new;
end;
$$;

create function idel_private.proposal_participants(p_id uuid) returns uuid[]
language sql stable set search_path = '' as $$
  select array_agg(distinct person.id order by person.id)
  from public.proposal_lines l cross join lateral (values (l.before_id),(l.after_id)) person(id)
  where l.proposal_id = p_id;
$$;

-- Both callers hold the day locks and the proposal row lock. A null actor denotes migration.
create function idel_private.resolve_approvals(p_id uuid, p_actor uuid) returns text
language plpgsql set search_path = '' as $$
declare
  touched date[] := idel_private.proposal_days(p_id);
  participants uuid[] := idel_private.proposal_participants(p_id);
  outcome text;
begin
  if not exists (select 1 from public.proposals where id = p_id and status = 'pending'
      and expires_on > idel_private.paris_today() and touched[1] > idel_private.paris_today())
    or cardinality(participants) is distinct from 2
    or exists (select 1 from unnest(participants) person(id) where not exists (
      select 1 from public.votes v where v.proposal_id = p_id and v.member_id = person.id and v.approve)) then
    return 'pending';
  end if;
  if exists (
    select 1 from public.proposal_lines l
    left join public.assignments a on (a.day,a.tour) = (l.day,l.tour)
    where l.proposal_id = p_id and (
      a.version is distinct from l.before_version or a.member_id is distinct from l.before_id
      or exists (select 1 from public.assignments other where other.day = l.day
        and other.tour <> l.tour and other.member_id = l.after_id))
  ) then
    outcome := 'obsolete';
  else
    update public.assignments a set member_id = l.after_id, version = a.version + 1
      from public.proposal_lines l where l.proposal_id = p_id and (a.day,a.tour) = (l.day,l.tour);
    outcome := 'accepted';
  end if;
  update public.proposals set status = outcome where id = p_id;
  insert into public.audit(kind,actor_id,proposal_id,days,details)
    values (outcome,p_actor,p_id,touched,idel_private.lines_detail(p_id)
      || case when p_actor is null then jsonb_build_object('source','migration') else '{}'::jsonb end);
  return outcome;
end;
$$;

create or replace function public.cast_vote(p_proposal_id uuid, p_approve boolean, p_reason text default null) returns text
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := idel_private.business_actor();
  touched date[] := idel_private.proposal_days(p_proposal_id);
  reason text := regexp_replace(p_reason, '^[[:space:]]+|[[:space:]]+$', '', 'g');
  p public.proposals;
  participants uuid[];
  previous boolean;
  author_name text;
  context text;
  vote_details jsonb;
begin
  if touched is null or p_approve is null then raise exception using errcode = '22023', message = 'Demande ou vote invalide.'; end if;
  perform idel_private.lock_days(touched);
  actor := idel_private.business_actor();
  select * into p from public.proposals where id = p_proposal_id for update;
  participants := idel_private.proposal_participants(p_proposal_id);
  if (actor = any(participants)) is not true then
    raise exception using errcode = '42501', message = 'Seuls les deux participants peuvent voter.';
  end if;
  if cardinality(participants) is distinct from 2 then
    raise exception using errcode = '22023', message = 'La demande doit concerner exactement deux participants.';
  end if;
  if p.status = 'pending' and (p.expires_on <= idel_private.paris_today() or touched[1] <= idel_private.paris_today()) then
    raise exception using errcode = '22023', message = 'Demande expiree.';
  end if;
  if not p_approve and (reason is null or reason = '' or char_length(reason) > 500) then
    raise exception using errcode = '22023', message = 'Le motif du refus doit contenir de 1 a 500 caracteres.';
  end if;
  select approve into previous from public.votes where proposal_id = p_proposal_id and member_id = actor;
  if found then
    if previous = p_approve then return p.status; end if;
    raise exception using errcode = '22023', message = 'Un vote ne peut pas etre modifie.';
  end if;
  if p.status <> 'pending' then raise exception using errcode = '22023', message = 'Demande deja fermee.'; end if;

  vote_details := jsonb_build_object('approve',p_approve);
  if not p_approve then vote_details := vote_details || jsonb_build_object('reason',reason); end if;
  insert into public.votes(proposal_id,member_id,approve) values (p_proposal_id,actor,p_approve);
  insert into public.audit(kind,actor_id,proposal_id,days,details)
    values ('vote',actor,p_proposal_id,touched,vote_details);
  if p_approve then return idel_private.resolve_approvals(p_proposal_id,actor); end if;

  select string_agg(to_char(l.day,'DD/MM/YYYY') || ' (Tournée ' || l.tour || ') : '
    || before_member.name || ' → ' || after_member.name, E'\n' order by l.day,l.tour)
    into context from public.proposal_lines l
    join public.members before_member on before_member.id = l.before_id
  join public.members after_member on after_member.id = l.after_id
    where l.proposal_id = p_proposal_id;
  select name into author_name from public.members where id = p.author_id;
  update public.proposals set status = 'rejected' where id = p_proposal_id;
  insert into public.audit(kind,actor_id,proposal_id,days,details)
    values ('rejected',actor,p_proposal_id,touched,idel_private.lines_detail(p_proposal_id) || jsonb_build_object('reason',reason));
  insert into public.messages(member_id,body,proposal_id,proposal_day)
    values (actor,'Demande refusée · ' || case when cardinality(touched) = 1 then 'Remplacement' else 'Échange' end
      || E'\nProposition de ' || author_name || E'\n' || context || E'\nMotif : ' || reason,p_proposal_id,touched[1]);
  return 'rejected';
end;
$$;

drop function idel_private.cast_vote(uuid,boolean);
revoke execute on function idel_private.proposal_participants(uuid), idel_private.resolve_approvals(uuid,uuid)
  from public, anon, authenticated, service_role;

-- Grandfather the existing decisions of the two participants. Votes from others remain
-- historical evidence and do not count; expired proposals remain untouched.
do $$
declare proposal uuid;
begin
  for proposal in select id from public.proposals
    where status = 'pending' and expires_on > idel_private.paris_today()
      and (idel_private.proposal_days(id))[1] > idel_private.paris_today()
    order by created_at,id for update
  loop
    perform idel_private.resolve_approvals(proposal,null);
  end loop;
end;
$$;

notify pgrst, 'reload schema';
commit;
