#!/bin/sh
set -eu
psql -X -v ON_ERROR_STOP=1 -c 'create schema if not exists idel_local_migrations' \
  -c 'create table if not exists idel_local_migrations.applied (name text primary key)'

for migration in /migrations/*.sql; do
  name=${migration##*/}
  case "$name" in *[!a-zA-Z0-9_.-]*) exit 1 ;; esac
  if [ "$(psql -XAt -v ON_ERROR_STOP=1 -c "select 1 from idel_local_migrations.applied where name = '$name'")" = 1 ]; then
    continue
  fi
  printf 'Applying %s\n' "$name"
  # Record it inside its own explicit transaction.
  test "$(sed -n 's/\r$//; /^commit;$/p' "$migration")" = 'commit;'
  sed "s/\r\$//; /^commit;\$/i insert into idel_local_migrations.applied values ('$name');" "$migration" |
    psql -X -v ON_ERROR_STOP=1
done
psql -X -v ON_ERROR_STOP=1 \
  -c "select vault.create_secret('mailpit','idel_email_transport') where not exists (select 1 from vault.secrets where name = 'idel_email_transport')" \
  -c "select vault.create_secret('planning@example.test','idel_email_sender') where not exists (select 1 from vault.secrets where name = 'idel_email_sender')" \
  -c "notify pgrst, 'reload schema'"
