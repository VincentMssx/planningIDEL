\set ON_ERROR_STOP on
\getenv local_password POSTGRES_PASSWORD
alter role authenticator with password :'local_password';
alter role supabase_auth_admin with password :'local_password';
