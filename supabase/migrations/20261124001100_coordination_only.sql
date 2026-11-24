begin;

-- Serialize with existing votes before changing the message and audit access.
select idel_private.lock_days(array(select date '2027-01-01' + i from generate_series(0,180) as g(i)));

-- Keep historical text available to the database owner only, not the planning API.
create table idel_private.retired_audit_reasons (
  audit_id uuid primary key,
  reason jsonb not null
);
alter table idel_private.retired_audit_reasons enable row level security;
revoke all on idel_private.retired_audit_reasons from public, anon, authenticated, service_role;
revoke all on public.messages from public, anon, authenticated, service_role;
drop function public.post_message(text);

with retired as (
  insert into idel_private.retired_audit_reasons (audit_id,reason)
  select id,details->'reason' from public.audit where details ? 'reason'
  returning audit_id
)
update public.audit a set details = a.details - 'reason' from retired r where a.id = r.audit_id;

alter table public.audit add constraint audit_no_free_text_reason check (not (details ? 'reason'));

create or replace function public.cast_vote(p_proposal_id uuid, p_approve boolean, p_reason text default null) returns text
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := idel_private.business_actor();
  touched date[] := idel_private.proposal_days(p_proposal_id);
  p public.proposals;
  participants uuid[];
  previous boolean;
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
  if (not p_approve and (p_reason in ('unavailable','schedule_conflict','keep_schedule')) is not true)
     or (p_approve and p_reason is not null) then
    raise exception using errcode = '22023', message = 'Choisissez un motif de refus dans la liste.';
  end if;
  select approve into previous from public.votes where proposal_id = p_proposal_id and member_id = actor;
  if found then
    if previous = p_approve then return p.status; end if;
    raise exception using errcode = '22023', message = 'Un vote ne peut pas etre modifie.';
  end if;
  if p.status <> 'pending' then raise exception using errcode = '22023', message = 'Demande deja fermee.'; end if;

  vote_details := jsonb_build_object('approve',p_approve);
  if not p_approve then vote_details := vote_details || jsonb_build_object('reason_code',p_reason); end if;
  insert into public.votes(proposal_id,member_id,approve) values (p_proposal_id,actor,p_approve);
  insert into public.audit(kind,actor_id,proposal_id,days,details)
    values ('vote',actor,p_proposal_id,touched,vote_details);
  if p_approve then return idel_private.resolve_approvals(p_proposal_id,actor); end if;

  update public.proposals set status = 'rejected' where id = p_proposal_id;
  insert into public.audit(kind,actor_id,proposal_id,days,details)
    values ('rejected',actor,p_proposal_id,touched,idel_private.lines_detail(p_proposal_id) || jsonb_build_object('reason_code',p_reason));
  return 'rejected';
end;
$$;

notify pgrst, 'reload schema';
commit;
