begin;

-- Retain existing private data; the retired address book is not an Auth directory.
drop function public.read_colleague_contacts();
drop function public.save_colleague_contacts(text,text,text);
drop function idel_private.require_fanny();
revoke all on table idel_private.colleague_contacts from public, anon, authenticated, service_role;

-- No client needs direct table or sequence access in the internal schema.
revoke all on all tables in schema idel_private from public, anon, authenticated, service_role;
revoke all on all sequences in schema idel_private from public, anon, authenticated, service_role;

notify pgrst, 'reload schema';
commit;
