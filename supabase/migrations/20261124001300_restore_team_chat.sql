begin;

-- Keep the old conversation archived; reopening chat starts a new conversation.
alter table public.messages add column chat_visible boolean not null default false;
alter table public.messages alter column chat_visible set default true;
drop policy active_aal2 on public.messages;
create policy active_team_chat on public.messages for select to authenticated
  using (chat_visible and (select idel_private.live_member(true)) is not null);
grant select on public.messages to authenticated;

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
revoke execute on function public.post_message(text) from public, anon, authenticated, service_role;
grant execute on function public.post_message(text) to authenticated;

create function idel_private.chat_refusal_notice() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  refusal_label text := case new.details->>'reason_code'
    when 'unavailable' then 'Indisponible'
    when 'schedule_conflict' then 'Conflit de planning'
    when 'keep_schedule' then 'Conserver le planning actuel'
  end;
  summary text;
begin
  if refusal_label is null then return new; end if;
  select format(E'Demande refusée · %s\nProposition de %s\n%s\nMotif : %s',
      case when count(*) = 1 then 'Remplacement' else 'Échange' end, author.name,
      string_agg(format('%s (Tournée %s) : %s → %s', to_char(l.day,'DD/MM/YYYY'), l.tour, before_member.name, after_member.name), E'\n' order by l.day,l.tour),
      refusal_label) into summary
    from public.proposals p join public.members author on author.id = p.author_id
    join public.proposal_lines l on l.proposal_id = p.id
    join public.members before_member on before_member.id = l.before_id
    join public.members after_member on after_member.id = l.after_id
    where p.id = new.proposal_id group by author.name;
  if summary is not null then
    insert into public.messages(member_id,body,proposal_id,proposal_day)
      values (new.actor_id,summary,new.proposal_id,new.days[1]);
  end if;
  return new;
end;
$$;
revoke execute on function idel_private.chat_refusal_notice() from public, anon, authenticated, service_role;
create trigger chat_refusal_notice after insert on public.audit for each row
  when (new.kind = 'rejected') execute function idel_private.chat_refusal_notice();

notify pgrst, 'reload schema';
commit;
