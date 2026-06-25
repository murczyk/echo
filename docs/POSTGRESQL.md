# POSTGRESQL

- В цьому документі описані налаштування PostgreSQL, що стосуються ЕХО

## Реплікація

- Реплікація налаштована не всюди, лише на серверах ВОЛИНЬ, ПІВНІЧ, та СХІД
- Для інструкцій як вона робиться дивись echo-sergeant/docs документ "POSTGRESQL REPLICA SETUP"
- Тюнінг:
    - `max_standby_streaming_delay = 1200s` - control how long a recovery conflict waits before canceling the query
        - див. [gh-1680](https://github.com/echoua/echo/issues/1680) для прикладу помилки яка виникає при низькому значенні
    - `max_standby_archive_delay = 1200s` - same
    - `hot_standby_feedback = on` - It tells the primary not to vacuum away tuple versions still needed by the standby, 
      which prevents most of these cancellations without forcing the replica to lag. The downside is bloat on primary 
      tables because vacuum can’t reclaim those tuples while the long read is running, so keep an eye on bloating 
      tables and autovacuum logs
- Моніторинг:
  - monitor `pg_last_xact_replay_timestamp`, `pg_stat_wal_receiver`. if the standby lags too much for failover purposes, shorten the delay or move those jobs elsewhere

## Systemd OOM policy

PostgreSQL cluster units must not use systemd's default `OOMPolicy=stop` for
the whole service. If one backend is killed by OOM, stopping the whole cluster
also takes the database down.

Fresh installs get the fix from:

```
sudo echo-install-utils setup-postgresql ...
```

Existing installs can repair only the drop-in:

```
sudo echo-install-utils setup-postgresql-oom-policy --pg-version 14
systemctl show postgresql@14-main.service -p OOMPolicy -p Restart -p RestartUSec -p DropInPaths
```

Requires `echo-install-utils >= 0.1.1-rc.202606250929` (`ee9dea2`).

Expected values:

```
OOMPolicy=continue
Restart=on-failure
RestartUSec=5s
```

## БЕКАПИ pgBackRest

- [ ] backup to b2 https://gemini.google.com/app/88850bd30883101d

Install on 22.04:

```
sudo install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | sudo gpg --dearmor -o /etc/apt/keyrings/pgdg.gpg
sudo chmod 0644 /etc/apt/keyrings/pgdg.gpg
echo "deb [signed-by=/etc/apt/keyrings/pgdg.gpg] http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" | sudo tee /etc/apt/sources.list.d/pgdg.list
sudo apt-get update
sudo apt-get install -y pgbackrest
sudo mkdir -p /var/lib/pgbackrest
sudo chmod 750 /var/lib/pgbackrest
sudo chown postgres:postgres /var/lib/pgbackrest
```

pgBackRest config layout:

- Base config: `/etc/pgbackrest/pgbackrest.conf` (can be empty)
- Stanza config(s): `/etc/pgbackrest/conf.d/pgbackrest-<STANZA>.conf`

Put stanza config (for example, `/etc/pgbackrest/conf.d/pgbackrest-wd-staging.conf`) like:

```
[wd-staging]
pg1-path=/var/lib/postgresql/14/main

[global]
repo1-retention-full=10

repo1-type=s3
repo1-s3-bucket=backup
repo1-s3-endpoint=s3.eu-central-003.backblazeb2.com
repo1-s3-region=eu-central-003
repo1-s3-key=<ACCESS_KEY_ID>
repo1-s3-key-secret=<SECRET_ACCESS_KEY>
repo1-path=/backup/echo-pgbackrest/wd-staging

# Optional encryption (recommended if backups leave the node, e.g. B2/S3).
# Keep cipher pass out of git, deploy via your secrets system.
repo1-cipher-type=aes-256-cbc
repo1-cipher-pass=<SECRET>

# Performance tuning:
# Note: these options can make the repository unreadable for older pgBackRest versions.
# zst supported since v2.27, bundle since v2.39, block since v2.46 (recommended >= v2.52.1).
compress-type=zst
repo1-bundle=y
repo1-block=y

# Parallelism (default 1 is almost never right). Tune per host CPU/IO.
process-max=4

# Faster WAL archiving (batching). Requires spool dir.
archive-async=y
spool-path=/var/spool/pgbackrest
```

For archive-async spool dir:

```
sudo mkdir -p /var/spool/pgbackrest
sudo chmod 750 /var/spool/pgbackrest
sudo chown postgres:postgres /var/spool/pgbackrest
```

In a file like /etc/postgresql/14/main/conf.d/90-pgbackrest.conf drop:

```
# pgBackRest WAL archiving
archive_mode = on
archive_command = '/usr/bin/pgbackrest --stanza=wd-staging archive-push %p'
# Optional, helps ensure regular WAL archive traffic
archive_timeout = 60
```

Then:

```
sudo pg_ctlcluster 14 main restart
```

Stanza:

```
sudo -u postgres pgbackrest --stanza=wd-staging --log-level-console=info stanza-create
sudo -u postgres pgbackrest --stanza=wd-staging --log-level-console=info check
```

## RESTORE pgbackrest

- stop postgresql

```
STANZA=wd-staging
sudo systemctl stop postgresql

sudo -u postgres pgbackrest \
  --config=/etc/pgbackrest/pgbackrest.conf \
  --config-include-path=/etc/pgbackrest/conf.d \
  --stanza="$STANZA" \
  --delta \
  --log-level-console=info \
  restore

sudo systemctl start postgresql
```


### Clean restore

```
STANZA=wd-staging
sudo systemctl stop postgresql

PGDATA=/var/lib/postgresql/14/main
sudo mv "$PGDATA" "${PGDATA}.bak.$(date +%Y%m%d_%H%M%S)"
sudo mkdir -p "$PGDATA"
sudo chown -R postgres:postgres "$PGDATA"
sudo chmod 700 "$PGDATA"

sudo -u postgres pgbackrest \
  --config=/etc/pgbackrest/pgbackrest.conf \
  --config-include-path=/etc/pgbackrest/conf.d \
  --stanza="$STANZA" \
  restore

sudo systemctl start postgresql
```
