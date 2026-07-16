# Local services

## PostgreSQL 18

PostgreSQL 18 cannot start the `local_pgdata` volume created by PostgreSQL 14.
If the local database is disposable, recreate only its volume before starting
the PostgreSQL 18 container:

```bash
docker compose -f local/docker-compose.yaml down
docker volume inspect local_pgdata
docker volume rm local_pgdata
docker compose -f local/docker-compose.yaml up -d postgres
```

This permanently deletes the local PostgreSQL data but leaves the Grafana
volume intact. If the database must be preserved, dump it with the PostgreSQL
14 image before removing the volume, then restore the dump into PostgreSQL 18.
