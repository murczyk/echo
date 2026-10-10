# File registry UTF-8 migration

`migrate_utf8.py` replaces a SQL_ASCII `wd_files` database with a UTF8 database
using `C.UTF-8`. PostgreSQL cannot change database encoding in place. This is
an offline database migration, separate from the transactional schema migrations
in `echo-migration`; it does not change the main database or analytics schema.

SQL_ASCII with the C locale produces no Cyrillic trigrams and does not fold
Cyrillic case. A logical restore validates text, recomputes generated search
vectors, and rebuilds indexes under the new encoding and locale. New registries
are provisioned with these settings explicitly. Trigger definitions are restored
separately with `public` on the search path: `pg_dump` otherwise emits an
unresolvable `IS DISTINCT FROM` expression for the registry’s `ltree` columns.
Autovacuum may run during the rebuild; its workers are stopped only for the
final database rename. Application connections still block migration.

## Rollout

Rehearse on staging first. Check the PostgreSQL version, existing encoding,
database owner, storage quota, and physical database size. Reserve space for the
original database, logical archive, replacement, temporary index-build files,
and at least 10 GiB free. Logical database sizes can differ substantially from
physical usage on compressed storage. The script stops dump/restore/analyze if
the filesystem containing its working directory falls below the reserve; keep
the working directory on the database filesystem and monitor other tablespaces.

1. Enable deployment maintenance using
   `bash deploy/deployment-maintenance.sh start <host>`.
2. Stop all registry writers and connection pools, including
   `wdintel-rs.socket`, `wdintel-rs.service`, `wdintel-rs-bgworker.service`, and
   `wdintel-rs-report-worker.service`. Verify there are no active user requests.
3. Copy the script to a private directory owned by `postgres`, for example
   `/var/backups/echo-file-registry-utf8-YYYYMMDD`. Run it as `postgres` without
   `--execute` to inspect the preflight report:
   `python3 migrate_utf8.py --directory /var/backups/echo-file-registry-utf8-YYYYMMDD`.
4. Run the same command with `--execute` in a persistent systemd unit. The default
   is two restore workers. Monitor its journal and filesystem free space.
5. Require `migration.json` phase `complete`. Every user table must have the
   same exact row count; database permissions/settings are preserved; the
   encoding, Cyrillic case folding, and trigram checks must pass. The final
   database rename is transactional. The old database remains under the
   journal's `backup` name with connections disabled.
6. Install Echo and matching AI harness `2026.10.10.5` using the
   [AI control panel](../../echo-ai-agent/README.md), then start the stopped
   services. Check authenticated filename searches, preview/download, and
   device URLs that expand and highlight the selected file. Measure query plans
   on the migrated data with the application's five-second timeout.
7. End deployment maintenance. Keep the archive and original database through
   acceptance; deleting either is a separate retention decision.

## Recovery

Before cutover, a failure leaves the original database name in place and
restores its prior read-only setting. Inspect `migration.json` and the error,
then restart the stopped services. A failed replacement and dump are retained
for inspection. Do not rerun against an existing journal or drop databases
without checking their recorded OIDs and names. An interrupted process may
leave `default_transaction_read_only=on`; restore the journal's original
database settings before restarting writers.

After cutover, stop writers again before considering rollback. Once new writes
have occurred, the retained original is stale: recover/reconcile those writes
before switching back. With no intervening writes, connect to `postgres`,
verify the database OIDs against the journal, disable connections to the active
replacement, rename it aside, rename the retained original to `wd_files`,
restore its original database settings, and enable connections. Never delete
the replacement as part of rollback.

The integration check uses only uniquely named test databases and verifies
data, generated vectors, settings, permissions, retained originals, and failure
on invalid UTF-8. Copy both Python files to a directory readable by PostgreSQL,
then run `sudo -u postgres python3 test_migrate_utf8.py` on a local test cluster.
