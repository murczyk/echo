#!/usr/bin/env python3
"""Rebuild a stopped file registry as UTF8, retaining the original database."""
import argparse
import json
import os
import re
from pathlib import Path
import shutil
import signal
import subprocess
import time


def identifier(value):
    return '"' + value.replace('"', '""') + '"'


def literal(value):
    return "'" + value.replace("'", "''") + "'"


def sql(database, query):
    return subprocess.check_output(
        ['psql', '-X', '-v', 'ON_ERROR_STOP=1', '-At', '-d', database, '-c', query],
        text=True,
    ).strip()


def metadata(database):
    result = sql('postgres', f"""
        select json_build_object('owner',pg_get_userbyid(datdba),
          'encoding',pg_encoding_to_char(encoding),'ctype',datctype,
          'size',pg_database_size(oid),'oid',oid,
          'acl',(select json_agg(json_build_object('grantee',case when grantee=0 then 'PUBLIC' else pg_get_userbyid(grantee) end,'privilege',privilege_type,'grantable',is_grantable)) from aclexplode(coalesce(datacl,acldefault('d',datdba)))),
          'settings',(select json_agg(json_build_object('role',case when setrole=0 then null else pg_get_userbyid(setrole) end,'settings',setconfig)) from pg_db_role_setting where setdatabase=d.oid))
        from pg_database d where datname={literal(database)}
    """)
    if not result:
        raise RuntimeError(f'Database {database} does not exist')
    return json.loads(result)


def save(path, state, phase):
    state['phase'] = phase
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(state, indent=2) + '\n')
    temporary.replace(path)
    print(phase, flush=True)


def run(command, directory, reserve):
    process = subprocess.Popen(command, start_new_session=True)
    try:
        while process.poll() is None:
            if shutil.disk_usage(directory).free < reserve:
                raise RuntimeError('Free space fell below the migration reserve')
            time.sleep(2)
        if process.returncode:
            raise RuntimeError(f'{command[0]} failed with exit code {process.returncode}')
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            process.wait()


def table_counts(database):
    tables = json.loads(sql(database, """
        select coalesce(json_agg(format('%I.%I',schemaname,tablename) order by schemaname,tablename),'[]')
        from pg_tables where schemaname not in ('pg_catalog','information_schema')
    """))
    return {table: int(sql(database, f'select count(*) from {table}')) for table in tables}


def restore_settings(database, settings):
    sql('postgres', f'alter database {identifier(database)} reset default_transaction_read_only')
    for item in settings or []:
        prefix = (f'alter role {identifier(item["role"])} in database' if item['role'] else 'alter database')
        for setting in item['settings']:
            key, value = setting.split('=', 1)
            sql('postgres', f'{prefix} {identifier(database)} set {identifier(key)} to {literal(value)}')


def restore_acl(database, metadata):
    sql('postgres', f'revoke all on database {identifier(database)} from public')
    for entry in metadata['acl']:
        grantee = 'public' if entry['grantee'] == 'PUBLIC' else identifier(entry['grantee'])
        grant = ' with grant option' if entry['grantable'] else ''
        sql('postgres', f'grant {entry["privilege"]} on database {identifier(database)} to {grantee}{grant}')


def ensure_stopped(database):
    connections = int(sql('postgres', f"select count(*) from pg_stat_activity where datname={literal(database)} and backend_type<>'autovacuum worker'"))
    if connections:
        raise RuntimeError(f'{connections} connections remain; stop Echo and all file-registry writers first')
    prepared = int(sql('postgres', f"select count(*) from pg_prepared_xacts where database={literal(database)}"))
    if prepared:
        raise RuntimeError('Prepared transactions must be resolved before migration')


def restore_archive(args, target, archive):
    listing = subprocess.check_output(['pg_restore', '--list', archive], text=True)
    triggers, regular = [], []
    for line in listing.splitlines():
        deferred = re.match(r'^\d+; \d+ \d+ (TRIGGER |COMMENT .* TRIGGER )', line)
        (triggers if deferred else regular).append(line)
    restore_list = args.directory / 'restore.list'
    restore_list.write_text('\n'.join(regular) + '\n')
    run(['pg_restore', '--exit-on-error', '--jobs', str(args.jobs), '--use-list', str(restore_list), '--dbname', target, archive], args.directory, args.reserve)
    trigger_list = args.directory / 'triggers.list'
    trigger_list.write_text('\n'.join(triggers) + '\n')
    trigger_sql = subprocess.check_output(['pg_restore', '--use-list', str(trigger_list), '--file', '-', archive], text=True)
    # pg_dump emits IS DISTINCT FROM for ltree without qualifying its equality operator.
    trigger_sql = trigger_sql.replace("SELECT pg_catalog.set_config('search_path', '', false);", "SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);")
    trigger_file = args.directory / 'triggers.sql'
    trigger_file.write_text(trigger_sql)
    run(['psql', '-X', '-v', 'ON_ERROR_STOP=1', '-d', target, '-f', str(trigger_file)], args.directory, args.reserve)


def rebuild(args, state, journal):
    database, target = args.database, state['target']
    ensure_stopped(database)
    sql('postgres', f'alter database {identifier(database)} set default_transaction_read_only=on')
    save(journal, state, 'source-read-only')
    archive = str(args.directory / 'source.dump')
    run(['pg_dump', '-Fc', '--encoding=UTF8', '--file', archive, database], args.directory, args.reserve)
    save(journal, state, 'dump-complete')
    sql('postgres', f"create database {identifier(target)} owner {identifier(state['metadata']['owner'])} template template0 encoding 'UTF8' lc_collate 'C.UTF-8' lc_ctype 'C.UTF-8'")
    restore_archive(args, target, archive)
    validate_and_cutover(args, state, journal)


def validate_and_cutover(args, state, journal):
    database, target, backup = args.database, state['target'], state['backup']
    save(journal, state, 'restore-complete')
    run(['vacuumdb', '--analyze-in-stages', '--jobs', str(args.jobs), target], args.directory, args.reserve)
    source_counts, target_counts = table_counts(database), table_counts(target)
    if source_counts != target_counts:
        raise RuntimeError('Source and target table counts differ; original remains active')
    state['counts'] = target_counts
    if sql(target, "select current_setting('server_encoding')='UTF8' and cardinality(show_trgm('втрати'))>0 and lower('ПОТЕРИ')='потери'") != 't':
        raise RuntimeError('UTF8 Cyrillic search verification failed')
    restore_settings(target, state['metadata']['settings'])
    restore_acl(target, state['metadata'])
    save(journal, state, 'validated')
    ensure_stopped(database)
    ensure_stopped(target)
    stopped = sql('postgres', f"select coalesce(bool_and(pg_terminate_backend(pid,5000)),true) from pg_stat_activity where datname in ({literal(database)},{literal(target)}) and backend_type='autovacuum worker'")
    if stopped != 't':
        raise RuntimeError('Could not stop database autovacuum before the final rename')
    sql('postgres', f'''begin;
      alter database {identifier(database)} allow_connections false;
      alter database {identifier(database)} rename to {identifier(backup)};
      alter database {identifier(target)} rename to {identifier(database)};
      commit;''')
    save(journal, state, 'complete')
    print(f'UTF8 database active: {database}; original retained: {backup}', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database', default='wd_files')
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--jobs', type=int, default=2, choices=range(1, 5))
    parser.add_argument('--reserve-gib', type=int, default=10)
    parser.add_argument('--execute', action='store_true')
    args = parser.parse_args()
    if args.reserve_gib < 1:
        raise RuntimeError('The migration reserve must be at least 1 GiB')
    args.reserve = args.reserve_gib * 1024**3
    info = metadata(args.database)
    if info['encoding'] == 'UTF8':
        print('Database already uses UTF8; no migration performed')
        return
    if info['encoding'] != 'SQL_ASCII':
        raise RuntimeError('Only SQL_ASCII to UTF8 is supported')
    args.directory.mkdir(parents=True, mode=0o700, exist_ok=True)
    free = shutil.disk_usage(args.directory).free
    print(json.dumps({'database': args.database, 'metadata': info, 'freeBytes': free}, indent=2), flush=True)
    if not args.execute:
        return
    journal = args.directory / 'migration.json'
    if journal.exists():
        raise RuntimeError('Migration journal exists; inspect recovery state before another attempt')
    if free < args.reserve:
        raise RuntimeError('Insufficient migration reserve')
    suffix = time.strftime('%Y%m%d%H%M%S', time.gmtime())
    state = {'database': args.database, 'target': f'{args.database}_utf8_{suffix}',
             'backup': f'{args.database}_ascii_{suffix}', 'metadata': info}
    if any(len(name.encode()) > 63 for name in [state['target'], state['backup']]):
        raise RuntimeError('Migration database name exceeds PostgreSQL identifier limit')
    save(journal, state, 'prepared')
    try:
        rebuild(args, state, journal)
    except BaseException:
        # The original name can already refer to the validated target after a lost commit reply.
        active = metadata(args.database)
        if active['oid'] == info['oid']:
            restore_settings(args.database, info['settings'])
        raise


if __name__ == '__main__':
    def interrupted(signum, frame):
        raise KeyboardInterrupt(f'Interrupted by signal {signum}')

    signal.signal(signal.SIGTERM, interrupted)
    main()
