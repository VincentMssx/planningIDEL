begin;

create table idel_private.colleague_contacts (
  name text primary key check (name in ('Linda', 'Julie', 'Lucie')),
  email text not null check (char_length(email) <= 254 and email ~ '^[^[:space:],;@]+@[^[:space:],;@.]+(\.[^[:space:],;@.]+)+$')
);
alter table idel_private.colleague_contacts enable row level security;
revoke all on table idel_private.colleague_contacts from public, anon, authenticated, service_role;

create function idel_private.require_fanny() returns void
language plpgsql set search_path = '' as $$
declare actor uuid := idel_private.business_actor();
begin
  if not exists (select 1 from public.members where id = actor and name = 'Fanny') then
    raise exception using errcode = '42501', message = 'Accès réservé à Fanny.';
  end if;
end;
$$;

create function public.read_colleague_contacts() returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform idel_private.require_fanny();
  return coalesce((select jsonb_object_agg(name,email) from idel_private.colleague_contacts), '{}'::jsonb);
end;
$$;

create function public.save_colleague_contacts(p_linda text, p_julie text, p_lucie text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  addresses text[] := array[nullif(btrim(p_linda),''), nullif(btrim(p_julie),''), nullif(btrim(p_lucie),'')];
begin
  perform idel_private.require_fanny();
  if exists (select 1 from unnest(addresses) a(email)
    where char_length(email) > 254 or email !~ '^[^[:space:],;@]+@[^[:space:],;@.]+(\.[^[:space:],;@.]+)+$') then
    raise exception using errcode = '22023', message = 'Vérifiez le format des adresses e-mail.';
  end if;
  perform pg_advisory_xact_lock(202703, 1);
  delete from idel_private.colleague_contacts where name in ('Linda','Julie','Lucie');
  insert into idel_private.colleague_contacts(name,email)
  select name,email from unnest(array['Linda','Julie','Lucie'], addresses) a(name,email) where email is not null;
end;
$$;

revoke execute on function idel_private.require_fanny(), public.read_colleague_contacts(),
  public.save_colleague_contacts(text,text,text) from public, anon, authenticated, service_role;
grant execute on function public.read_colleague_contacts(), public.save_colleague_contacts(text,text,text) to authenticated;

commit;
