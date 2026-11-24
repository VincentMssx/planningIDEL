begin;

create extension if not exists http with schema extensions;
create extension if not exists pgcrypto with schema extensions;

alter table idel_private.credentials add column verified_email text;
update idel_private.credentials c set verified_email = u.email
from auth.users u where c.member_id = u.id and u.email_confirmed_at is not null;

create or replace function idel_private.record_initial_password() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into idel_private.credentials(member_id,password_fingerprint,revoked_before,verified_email)
  select new.id, idel_private.password_fingerprint(new.id), clock_timestamp(), u.email
  from auth.users u where u.id = new.id and u.email_confirmed_at is not null and u.email <> '';
  if not found then raise exception 'A confirmed email address is required.'; end if;
  return new;
end;
$$;

create table idel_private.email_challenges (
  member_id uuid primary key references idel_private.credentials(member_id) on delete cascade,
  session_id uuid not null,
  nonce bytea not null,
  code_hash bytea not null,
  sent_at timestamptz not null,
  window_start timestamptz not null,
  sends integer not null,
  attempts integer not null
);
create table idel_private.email_verified_sessions (
  session_id uuid primary key references auth.sessions(id) on delete cascade,
  valid_until timestamptz not null
);
alter table idel_private.email_challenges enable row level security;
alter table idel_private.email_verified_sessions enable row level security;

create function idel_private.current_session_id() returns uuid
language sql stable set search_path = '' as $$
  select case when (auth.jwt()->>'session_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then (auth.jwt()->>'session_id')::uuid end;
$$;

create or replace function idel_private.live_member(p_business boolean) returns uuid
language sql stable security definer set search_path = '' as $$
  select m.id from public.members m
  join idel_private.credentials c on c.member_id = m.id
  join auth.sessions s on s.user_id = m.id and s.id = idel_private.current_session_id()
  join auth.users u on u.id = m.id and u.email = c.verified_email and u.email_confirmed_at is not null
  where m.id = auth.uid() and m.active
    and s.created_at > c.revoked_before
    and (s.not_after is null or s.not_after > statement_timestamp())
    and auth.jwt()->>'aal' in ('aal1','aal2')
    and exists (select 1 from auth.mfa_amr_claims a where a.session_id = s.id and a.authentication_method = 'password')
    and (not p_business or (not m.must_change_password and exists (
      select 1 from idel_private.email_verified_sessions v where v.session_id = s.id and v.valid_until > statement_timestamp()
    )));
$$;

create or replace function public.require_password_change(p_member_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.members where id = p_member_id and not active for update;
  if not found then raise exception using errcode = '22023', message = 'Desactiver le membre avant la recuperation.'; end if;
  update idel_private.credentials c set password_fingerprint = idel_private.password_fingerprint(p_member_id),
    revoked_before = clock_timestamp(), verified_email = u.email
  from auth.users u where c.member_id = p_member_id and u.id = c.member_id and u.email_confirmed_at is not null and u.email <> '';
  if not found then raise exception 'A confirmed email address is required.'; end if;
  delete from idel_private.email_challenges where member_id = p_member_id;
  update public.members set must_change_password = true where id = p_member_id;
end;
$$;

-- Disable GoTrue magic links, recovery e-mails and address changes; only the operator handles recovery.
create function public.idel_block_auth_email(event jsonb) returns jsonb
language sql stable set search_path = '' as $$
  select '{"error":{"http_code":403,"message":"This authentication email flow is disabled."}}'::jsonb;
$$;

create function public.request_email_code() returns text
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := idel_private.live_member(false);
  session_key uuid := idel_private.current_session_id();
  previous idel_private.email_challenges;
  ts timestamptz;
  since timestamptz;
  total integer := 0;
  random_bytes bytea;
  nonce bytea;
  code text;
  recipient text;
  sender text;
  api_key text;
  transport text;
  url text;
  payload jsonb;
  headers extensions.http_header[];
  delivery_status integer;
  message_text text;
begin
  select verified_email into recipient from idel_private.credentials where member_id = actor for update;
  if actor is null or idel_private.live_member(false) is distinct from actor or
    (select must_change_password from public.members where id = actor) then return 'denied'; end if;
  if idel_private.live_member(true) = actor then return 'verified'; end if;

  ts := clock_timestamp();
  since := ts;
  select * into previous from idel_private.email_challenges where member_id = actor;
  if found then
    if previous.sent_at > ts - interval '1 minute' then return 'wait'; end if;
    if previous.window_start > ts - interval '1 hour' then
      if previous.sends >= 5 then return 'limit'; end if;
      total := previous.sends;
      since := previous.window_start;
    end if;
  end if;

  select decrypted_secret into sender from vault.decrypted_secrets where name = 'idel_email_sender';
  select decrypted_secret into transport from vault.decrypted_secrets where name = 'idel_email_transport';
  if sender is null then return 'unavailable'; end if;
  -- Rejection sampling produces a uniform six-digit code.
  loop
    random_bytes := extensions.gen_random_bytes(3);
    exit when get_byte(random_bytes,0) * 65536 + get_byte(random_bytes,1) * 256 + get_byte(random_bytes,2) < 16000000;
  end loop;
  code := lpad(((get_byte(random_bytes,0) * 65536 + get_byte(random_bytes,1) * 256 + get_byte(random_bytes,2)) % 1000000)::text, 6, '0');
  nonce := extensions.gen_random_bytes(32);
  message_text := 'Code de connexion Planning IDEL : ' || code || '. Valable 10 minutes. Ne le communiquez a personne.';
  if transport = 'mailpit' then
    url := 'http://mailpit:8025/api/v1/send';
    headers := array[]::extensions.http_header[];
    payload := jsonb_build_object('From',jsonb_build_object('Email',sender), 'To',jsonb_build_array(jsonb_build_object('Email',recipient)),
      'Subject','Code de connexion Planning IDEL','Text',message_text);
  else
    select decrypted_secret into api_key from vault.decrypted_secrets where name = 'idel_resend_api_key';
    if api_key is null then return 'unavailable'; end if;
    url := 'https://api.resend.com/emails';
    headers := array[extensions.http_header('Authorization','Bearer ' || api_key)];
    payload := jsonb_build_object('from',sender,'to',jsonb_build_array(recipient),'subject','Code de connexion Planning IDEL','text',message_text);
  end if;

  begin
    select status into delivery_status from extensions.http(row('POST',url,headers,'application/json',payload::text)::extensions.http_request);
  exception when others then
    delivery_status := null;
  end;
  if delivery_status is null or delivery_status not between 200 and 299 then return 'unavailable'; end if;
  insert into idel_private.email_challenges values (actor,session_key,nonce,sha256(nonce || convert_to(code,'UTF8')),ts,since,total + 1,0)
  on conflict (member_id) do update set session_id = excluded.session_id, nonce = excluded.nonce, code_hash = excluded.code_hash,
    sent_at = excluded.sent_at, window_start = excluded.window_start, sends = excluded.sends, attempts = 0;
  return 'sent';
end;
$$;

create function public.verify_email_code(p_code text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := idel_private.live_member(false);
  session_key uuid := idel_private.current_session_id();
  challenge idel_private.email_challenges;
begin
  perform 1 from idel_private.credentials where member_id = actor for update;
  if actor is null or idel_private.live_member(false) is distinct from actor or
    (select must_change_password from public.members where id = actor) then return 'denied'; end if;
  if idel_private.live_member(true) = actor then return 'verified'; end if;
  select * into challenge from idel_private.email_challenges where member_id = actor and session_id = session_key;
  if not found or challenge.sent_at <= clock_timestamp() - interval '10 minutes' then return 'expired'; end if;
  if challenge.attempts >= 5 then return 'limit'; end if;
  if p_code is null or p_code !~ '^[0-9]{6}$' or sha256(challenge.nonce || convert_to(p_code,'UTF8')) <> challenge.code_hash then
    update idel_private.email_challenges set attempts = attempts + 1 where member_id = actor;
    return case when challenge.attempts >= 4 then 'limit' else 'invalid' end;
  end if;
  update idel_private.email_challenges set attempts = 5 where member_id = actor;
  insert into idel_private.email_verified_sessions values (session_key,clock_timestamp() + interval '12 hours')
    on conflict (session_id) do update set valid_until = excluded.valid_until;
  return 'verified';
end;
$$;

revoke execute on function idel_private.current_session_id(), public.request_email_code(), public.verify_email_code(text),
  public.idel_block_auth_email(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.request_email_code(), public.verify_email_code(text) to authenticated;
grant execute on function public.idel_block_auth_email(jsonb) to supabase_auth_admin;

commit;
