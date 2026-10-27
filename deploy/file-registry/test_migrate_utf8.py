#!/usr/bin/env python3
"""Run as a PostgreSQL superuser against a disposable local cluster."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
import uuid

from migrate_utf8 import identifier, literal, metadata, sql


class EncodingMigration(unittest.TestCase):
    def setUp(self):
        self.database = 'echo_utf8_test_' + uuid.uuid4().hex[:12]
        self.directory = tempfile.TemporaryDirectory()
        sql('postgres', f"create database {identifier(self.database)} template template0 encoding 'SQL_ASCII' lc_collate 'C' lc_ctype 'C'")
        sql(self.database, """
            create extension pg_trgm;
            create extension ltree;
            create table files(id int primary key, name text, payload jsonb,
              hierarchy_path ltree not null default 'root',
              search tsvector generated always as (to_tsvector('russian',name)) stored);
            create index on files using gin(name gin_trgm_ops);
            create function immutable_path() returns trigger language plpgsql as $$
              begin raise exception 'immutable path'; end $$;
            create trigger files_immutable_update before update on files for each row
              when (new.hierarchy_path is distinct from old.hierarchy_path)
              execute function immutable_path();
            insert into files(id,name,payload) values
              (1,'ЗВІТ ПОТЕРИ.txt','{"title":"Документи"}'),
              (2,'100%_literal.txt','{}');
        """)
        sql('postgres', f'revoke connect on database {identifier(self.database)} from public')
        sql('postgres', f"alter database {identifier(self.database)} set statement_timeout='7s'")

    def tearDown(self):
        names = sql('postgres', f"select datname from pg_database where starts_with(datname,{literal(self.database)})").splitlines()
        for name in names:
            sql('postgres', f'drop database {identifier(name)} with (force)')
        self.directory.cleanup()

    def migrate(self):
        return subprocess.run([
            'python3', str(Path(__file__).with_name('migrate_utf8.py')),
            '--database', self.database, '--directory', self.directory.name, '--execute',
        ], text=True, capture_output=True)

    def test_3757_preserves_data_permissions_settings_and_original(self):
        result = self.migrate()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        journal = json.loads((Path(self.directory.name) / 'migration.json').read_text())
        self.assertEqual(journal['phase'], 'complete')
        self.assertEqual(metadata(self.database)['encoding'], 'UTF8')
        self.assertEqual(sql(self.database, "select name from files where name ilike '%потери%'"), 'ЗВІТ ПОТЕРИ.txt')
        self.assertEqual(sql(self.database, "select payload->>'title' from files where id=1"), 'Документи')
        self.assertEqual(sql(self.database, "select count(*) from files where search @@ to_tsquery('russian','потери')"), '1')
        self.assertEqual(sql(self.database, 'show statement_timeout'), '7s')
        self.assertNotIn({'grantee': 'PUBLIC', 'privilege': 'CONNECT', 'grantable': False}, metadata(self.database)['acl'])
        self.assertEqual(sql('postgres', f"select datallowconn from pg_database where datname={literal(journal['backup'])}"), 'f')
        self.assertEqual(metadata(journal['backup'])['oid'], journal['metadata']['oid'])
        with self.assertRaises(subprocess.CalledProcessError):
            sql(self.database, "update files set hierarchy_path='changed' where id=1")

    def test_3757_invalid_utf8_keeps_original_writable(self):
        sql(self.database, "insert into files(id,name) values(3,convert_from(decode('ff','hex'),'SQL_ASCII'))")
        original = metadata(self.database)['oid']
        result = self.migrate()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(metadata(self.database)['oid'], original)
        self.assertEqual(sql(self.database, 'show default_transaction_read_only'), 'off')
        self.assertEqual(sql(self.database, 'select count(*) from files'), '3')


if __name__ == '__main__':
    unittest.main()
