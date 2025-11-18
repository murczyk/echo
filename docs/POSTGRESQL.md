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
