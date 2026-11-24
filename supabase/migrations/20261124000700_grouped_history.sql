begin;

create index audit_proposal_history on public.audit (proposal_id) where proposal_id is not null;

create view public.grouped_history with (security_invoker = true) as
with proposal_events as (
  -- A decision supersedes the opening event, which supersedes individual votes.
  select distinct on (a.proposal_id) a.*
  from public.audit a
  where a.proposal_id is not null
  order by a.proposal_id,
    case a.kind when 'vote' then 2 when 'proposal' then 1 else 0 end,
    a.created_at desc, a.id desc
)
select e.id, e.kind, coalesce(p.author_id, e.actor_id) as actor_id, e.proposal_id,
  array(
    select unnest(a.days) as day from public.audit a where a.proposal_id = e.proposal_id
    union select unnest(l.days)
    order by day
  ) as days,
  e.details || jsonb_build_object(
    'lines', coalesce(l.items, e.details -> 'lines', '[]'::jsonb),
    'event_actor_id', e.actor_id,
    'proposal_created_at', p.created_at
  ) as details,
  e.created_at
from proposal_events e
left join public.proposals p on p.id = e.proposal_id
left join lateral (
  select jsonb_agg(to_jsonb(pl) order by pl.day, pl.tour) as items, array_agg(pl.day) as days
  from public.proposal_lines pl
  where pl.proposal_id = e.proposal_id
) l on true
union all
select a.id, a.kind, a.actor_id, a.proposal_id, a.days, a.details, a.created_at
from public.audit a
where a.proposal_id is null;

revoke all on public.grouped_history from public, anon, authenticated, service_role;
grant select on public.grouped_history to authenticated;

commit;
