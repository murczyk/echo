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

## БЕКАПИ pgBackRest

- [ ] backup to b2 https://gemini.google.com/app/88850bd30883101d

Install on 22.04:

```
sudo install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | sudo gpg --dearmor -o /etc/apt/keyrings/pgdg.gpg
sudo chmod 0644 /etc/apt/keyrings/pgbackrest.gpg
echo "deb [signed-by=/etc/apt/keyrings/pgdg.gpg] http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" | sudo tee /etc/apt/sources.list.d/pgdg.list

sudo mkdir -p /var/lib/pgbackrest
sudo chmod 750 /var/lib/pgbackrest
sudo chown postgres:postgres /var/lib/pgbackrest
```

Put /etc/pgbackrest/pgbackrest.conf like:

```
[wd-staging]
pg1-path=/var/lib/postgresql/14/main

[global]
repo1-path=/var/lib/pgbackrest
repo1-retention-full=30

repo1-cipher-pass=1C0OtJN79LKIGPQX8QeryctO5DBsauySY3Ly8utGTo33m5bVZfu680muSq5+WHfu
repo1-cipher-type=aes-256-cbc
repo1-path=/var/lib/pgbackrest
repo1-retention-full=2
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
