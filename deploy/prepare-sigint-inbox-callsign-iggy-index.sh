#!/usr/bin/env bash
set -euo pipefail

server=${1:?server is required}

echo "Preparing the Iggy callsign index online on ${server}..."
ssh "$server" "sudo -n -u postgres env PGAPPNAME=echo-online-index-prepare psql -X -d wd -v ON_ERROR_STOP=1" <<'SQL'
select to_regclass('public.sigint_inbox_item_callsign') is not null as table_exists
\gset

\if :table_exists
do $$
declare
    migration_lock bigint := hashtextextended(
        current_database() || ':echo:migrations', 0
    );
begin
    if not pg_try_advisory_lock(migration_lock) then
        raise exception 'database migrations are already running';
    end if;
    perform pg_advisory_unlock(migration_lock);
    if exists (
        select 1
        from pg_stat_progress_create_index
        where relid = 'public.sigint_inbox_item_callsign'::regclass
    ) then
        raise exception 'an index build on sigint_inbox_item_callsign is already running';
    end if;
end
$$;

select format('drop index concurrently %I.%I', index_namespace.nspname, index_class.relname)
from pg_index index_state
join pg_class index_class on index_class.oid = index_state.indexrelid
join pg_namespace index_namespace on index_namespace.oid = index_class.relnamespace
where index_namespace.nspname = 'public'
  and index_class.relname = 'sigint_inbox_item_callsign_active_iggy_match_key_idx'
  and (not index_state.indisvalid or not index_state.indisready)
\gexec

create index concurrently if not exists sigint_inbox_item_callsign_active_iggy_match_key_idx
    on sigint_inbox_item_callsign (
        (btrim(regexp_replace(translate(lower(callsign), U&'\002D\0020\2010\2011\2012\2013\2014\2015\0009\000A\000B\000C\000D\0085\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000', repeat('-', 32)), '-+', '-', 'g'), '-')),
        sigint_inbox_item_id
    )
    where not deleted;

do $$
begin
    if not exists (
        select 1
        from pg_index index_state
        join pg_class index_class on index_class.oid = index_state.indexrelid
        join pg_namespace index_namespace on index_namespace.oid = index_class.relnamespace
        where index_namespace.nspname = 'public'
          and index_class.relname = 'sigint_inbox_item_callsign_active_iggy_match_key_idx'
          and index_state.indisvalid
          and index_state.indisready
    ) then
        raise exception 'Iggy callsign index is not valid';
    end if;
end
$$;
\else
\echo 'sigint_inbox_item_callsign does not exist; skipping online index preparation'
\endif
SQL
