begin;

create or replace function public.cast_vote(p_proposal_id uuid, p_approve boolean, p_reason text default null) returns text
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := idel_private.business_actor();
  touched date[] := idel_private.proposal_days(p_proposal_id);
  reason text := regexp_replace(p_reason, '^[[:space:]]+|[[:space:]]+$', '', 'g');
  already_voted boolean;
  outcome text;
  context text;
begin
  if p_approve is distinct from false then
    return idel_private.cast_vote(p_proposal_id,p_approve);
  end if;
  if reason is null or reason = '' or char_length(reason) > 500 then
    raise exception using errcode = '22023', message = 'Le motif du refus doit contenir de 1 a 500 caracteres.';
  end if;
  -- Use the same day locks as the vote so a retry cannot post a second message.
  if touched is not null then perform idel_private.lock_days(touched); end if;
  select exists (select 1 from public.votes where proposal_id = p_proposal_id and member_id = actor) into already_voted;
  outcome := idel_private.cast_vote(p_proposal_id,false);
  if not already_voted then
    select string_agg(to_char(day,'DD/MM/YYYY') || ' (Tournée ' || tour || ')', ', ' order by day,tour)
      into context from public.proposal_lines where proposal_id = p_proposal_id;
    insert into public.messages(member_id,body)
      values (actor, 'Demande refusée · ' || context || E'\nMotif : ' || reason);
  end if;
  return outcome;
end;
$$;

commit;
